// Scanned pages are usually one big picture. To edit them so the change looks
// scanned too, the editor reads that picture's own pixels, and saving writes the
// edited pixels back into it (instead of pasting crisp text on top).
import * as mupdf from "mupdf";

/** Maps a pixel (u, v) of an image to page space: [a*u + c*v + e, b*u + d*v + f]. */
export type PixelMatrix = [number, number, number, number, number, number];

export interface ScanImage {
  png: Uint8Array;
  width: number;
  height: number;
  matrix: PixelMatrix;
}

/** An edited piece of the scan: RGBA pixels (transparent = unchanged) at (x, y) in the scan's pixels. */
export interface ScanPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG with alpha. */
  png: Uint8Array;
}

interface Found {
  /** Where the picture sits in the page's resources. */
  xobjects: mupdf.PDFObject;
  name: string;
  ref: mupdf.PDFObject;
  width: number;
  height: number;
  matrix: PixelMatrix;
}

/**
 * Finds the picture that is the page's scan: the largest image, drawn upright
 * and straight from the page's own resources, covering most of the page.
 */
function findScanImage(pdf: mupdf.PDFDocument, index: number): Found | null {
  const page = pdf.loadPage(index);
  let best: { width: number; height: number; ctm: number[]; area: number } | undefined;
  let layered = false;
  let pageArea: number;
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    pageArea = (x1 - x0) * (y1 - y0);
    page.run(
      new mupdf.Device({
        fillImage(image, ctm) {
          const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
          // A second big picture is a layer too.
          if (best && area > pageArea * 0.05) layered = true;
          if (!best || area > best.area) best = { width: image.getWidth(), height: image.getHeight(), ctm: [...ctm], area };
        },
        // Copiers often save a scan in layers: a low-resolution colour picture with the
        // black text drawn on top as separate masks. Changing only the picture would
        // leave the old text showing, so such pages are edited on top instead.
        fillImageMask: () => void (layered = true),
        clipImageMask: () => void (layered = true),
      }),
      mupdf.Matrix.identity,
    );
  } finally {
    page.destroy();
  }
  if (!best || best.area < pageArea * 0.3 || layered) return null;
  const [a, b, c, d, e, f] = best.ctm;
  // Upright only: rows of pixels must run along the page's lines of text.
  if (Math.abs(b) > 1e-3 * Math.abs(a) || Math.abs(c) > 1e-3 * Math.abs(d) || a <= 0 || d <= 0) return null;
  const xobjects = pdf.findPage(index).getInheritable("Resources").get("XObject");
  if (!xobjects.isDictionary()) return null;
  const matches: { name: string; ref: mupdf.PDFObject }[] = [];
  xobjects.forEach((ref, key) => {
    const obj = ref.resolve();
    if (
      obj.get("Subtype").toString() === "/Image" &&
      obj.get("Width").asNumber() === best!.width &&
      obj.get("Height").asNumber() === best!.height &&
      obj.get("SMask").isNull() &&
      obj.get("Mask").isNull() &&
      !obj.get("ImageMask").asBoolean()
    ) {
      matches.push({ name: String(key), ref });
    }
  });
  // Two same-sized pictures would be ambiguous: leave it to the fallback.
  if (matches.length !== 1) return null;
  const { width, height } = best;
  return { xobjects, ...matches[0], width, height, matrix: [a / width, 0, 0, d / height, e, f] };
}

/** The page's scan picture as PNG, with where its pixels sit on the page; null if the page isn't a simple scan. */
export function scanImage(pdf: mupdf.PDFDocument, index: number): ScanImage | null {
  const found = findScanImage(pdf, index);
  // Huge scans would need too much memory in the browser: those use the page as read instead.
  if (!found || found.width * found.height > 40e6) return null;
  const image = pdf.loadImage(found.ref);
  try {
    const pix = image.toPixmap();
    try {
      // Only grey and RGB pictures are edited in place (not CMYK or odd colour spaces).
      const n = pix.getNumberOfComponents() - pix.getAlpha();
      if (n !== 1 && n !== 3) return null;
      if (pix.getWidth() !== found.width || pix.getHeight() !== found.height) return null;
      return { png: pix.asPNG().slice(), width: found.width, height: found.height, matrix: found.matrix };
    } finally {
      pix.destroy();
    }
  } finally {
    image.destroy();
  }
}

/** Decodes a patch PNG into straight (not premultiplied) RGBA. */
function patchPixels(patch: ScanPatch): Uint8ClampedArray {
  const img = new mupdf.Image(patch.png);
  const mask = img.getMask();
  const pix = img.toPixmap();
  const alphaPix = mask?.toPixmap();
  try {
    const [w, h] = [pix.getWidth(), pix.getHeight()];
    if (w !== patch.width || h !== patch.height) throw new Error("A scan edit has the wrong size.");
    const n = pix.getNumberOfComponents();
    const hasAlpha = pix.getAlpha() > 0;
    const colours = n - (hasAlpha ? 1 : 0);
    const src = pix.getPixels();
    const stride = pix.getStride();
    const m = alphaPix?.getPixels();
    const mStride = alphaPix?.getStride() ?? 0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * stride + x * n;
        const o = (y * w + x) * 4;
        // MuPDF keeps a PNG's transparency either in the pixmap (premultiplied) or as a separate mask.
        const a = m ? m[y * mStride + x] : hasAlpha ? src[s + n - 1] : 255;
        const un = hasAlpha && a > 0 ? 255 / a : 1;
        for (let k = 0; k < 3; k++) out[o + k] = src[s + (colours === 1 ? 0 : k)] * un;
        out[o + 3] = a;
      }
    }
    return out;
  } finally {
    pix.destroy();
    alphaPix?.destroy();
    mask?.destroy();
    img.destroy();
  }
}

/**
 * Paints edited pixels into the page's scan picture and swaps the picture in.
 * JPEG scans stay JPEG (so the file doesn't balloon). Returns false if the page
 * no longer looks like the scan the edits were made on.
 */
export function writeScanPatches(pdf: mupdf.PDFDocument, index: number, size: [number, number], patches: ScanPatch[]): boolean {
  const found = findScanImage(pdf, index);
  if (!found || found.width !== size[0] || found.height !== size[1]) return false;
  const original = found.ref.resolve();
  const filter = original.get("Filter");
  const jpeg = filter.toString().includes("DCTDecode");
  const image = pdf.loadImage(found.ref);
  let pix: mupdf.Pixmap;
  try {
    pix = image.toPixmap();
  } finally {
    image.destroy();
  }
  try {
    const n = pix.getNumberOfComponents();
    const alpha = pix.getAlpha();
    const colours = n - alpha;
    if (colours !== 1 && colours !== 3) return false;
    const stride = pix.getStride();
    const px = pix.getPixels();
    for (const patch of patches) {
      const rgba = patchPixels(patch);
      for (let y = 0; y < patch.height; y++) {
        const ty = patch.y + y;
        if (ty < 0 || ty >= found.height) continue;
        for (let x = 0; x < patch.width; x++) {
          const tx = patch.x + x;
          if (tx < 0 || tx >= found.width) continue;
          const s = (y * patch.width + x) * 4;
          const a = rgba[s + 3] / 255;
          if (a === 0) continue;
          const [r, g, b] = [rgba[s], rgba[s + 1], rgba[s + 2]];
          const t = ty * stride + tx * n;
          if (colours === 1) {
            const v = 0.299 * r + 0.587 * g + 0.114 * b;
            px[t] = px[t] * (1 - a) + v * a;
          } else {
            px[t] = px[t] * (1 - a) + r * a;
            px[t + 1] = px[t + 1] * (1 - a) + g * a;
            px[t + 2] = px[t + 2] * (1 - a) + b * a;
          }
        }
      }
    }
    const edited = jpeg ? new mupdf.Image(pix.asJPEG(92)) : new mupdf.Image(pix);
    try {
      const ref = pdf.addImage(edited);
      // Swap it in on this page only (other pages may share the resources).
      const pageObj = pdf.findPage(index);
      const resources = copyDictionary(pdf, pageObj.getInheritable("Resources"));
      const xobjects = copyDictionary(pdf, found.xobjects);
      xobjects.put(found.name, ref);
      resources.put("XObject", xobjects);
      pageObj.put("Resources", resources);
    } finally {
      edited.destroy();
    }
    return true;
  } finally {
    pix.destroy();
  }
}

function copyDictionary(pdf: mupdf.PDFDocument, dict: mupdf.PDFObject): mupdf.PDFObject {
  const out = pdf.newDictionary();
  dict.forEach((value, key) => out.put(String(key), value));
  return out;
}
