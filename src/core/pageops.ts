// Whole-document operations: rearrange pages, shrink, redact, protect, stamp,
// fill forms and edit properties. Pure functions over bytes, like pdf.ts.
import * as mupdf from "mupdf";
import { openPdf, type PdfInput, type Rotation, type Rgb } from "./pdf";
import { appendContent, writeRuns } from "./text";

function withPdf<T>(input: PdfInput, fn: (pdf: mupdf.PDFDocument) => T): T {
  const pdf = openPdf(input);
  try {
    return fn(pdf);
  } finally {
    pdf.destroy();
  }
}

function toBytes(buf: mupdf.Buffer): Uint8Array {
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

// --- Organize ---------------------------------------------------------------

export interface PagePlan {
  /** 0-based page of the source. The same page may appear more than once. */
  from: number;
  /** Extra clockwise turn on top of the page's own. */
  rotate: Rotation;
}

/** Builds a new PDF from the plan: reordered, rotated, duplicated; pages left out are dropped. */
export function organize(input: PdfInput, plan: PagePlan[]): Uint8Array {
  if (plan.length === 0) throw new Error("Keep at least one page.");
  return withPdf(input, (src) => {
    const total = src.countPages();
    for (const p of plan) if (!Number.isInteger(p.from) || p.from < 0 || p.from >= total) throw new RangeError(`Page ${p.from + 1} doesn't exist.`);
    const out = new mupdf.PDFDocument();
    try {
      const map = out.newGraftMap();
      try {
        for (const p of plan) map.graftPage(-1, src, p.from);
      } finally {
        map.destroy();
      }
      plan.forEach((p, i) => {
        if (!p.rotate) return;
        const obj = out.findPage(i);
        const current = obj.getInheritable("Rotate");
        const base = current.isNumber() ? current.asNumber() : 0;
        obj.put("Rotate", out.newInteger((((base + p.rotate) % 360) + 360) % 360));
      });
      return toBytes(out.saveToBuffer("garbage,compress"));
    } finally {
      out.destroy();
    }
  });
}

// --- Rebuild scanned pages --------------------------------------------------

export interface PageImage {
  /** PNG or JPEG bytes. */
  image: Uint8Array;
  /** The page's size in points; the picture fills it. */
  width: number;
  height: number;
}

/** A copy of the PDF where some pages are replaced by a full-page picture (null keeps the original page). */
export function rebuildPages(input: PdfInput, images: (PageImage | null)[]): Uint8Array {
  return withPdf(input, (src) => {
    if (images.length !== src.countPages()) throw new RangeError("One entry per page, please.");
    const out = new mupdf.PDFDocument();
    try {
      const map = out.newGraftMap();
      try {
        images.forEach((img, i) => {
          if (!img) return map.graftPage(-1, src, i);
          const image = new mupdf.Image(img.image);
          const ref = out.addImage(image);
          const res = out.addObject({ XObject: { Im0: ref } });
          out.insertPage(-1, out.addPage([0, 0, img.width, img.height], 0, res, `q ${img.width} 0 0 ${img.height} 0 0 cm /Im0 Do Q`));
          image.destroy();
        });
      } finally {
        map.destroy();
      }
      return toBytes(out.saveToBuffer("garbage,compress"));
    } finally {
      out.destroy();
    }
  });
}

// --- Compress ---------------------------------------------------------------

export type Squeeze = "light" | "balanced" | "strong";

const SQUEEZE: Record<Squeeze, { dpi: number; quality: number }> = {
  light: { dpi: 220, quality: 85 },
  balanced: { dpi: 150, quality: 70 },
  strong: { dpi: 100, quality: 50 },
};

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  images: number;
}

/** Image streams that are plain pictures (not masks) and safe to re-encode as JPEG. */
function plainImage(obj: mupdf.PDFObject): boolean {
  if (!obj.isStream()) return false;
  const sub = obj.get("Subtype");
  if (!sub.isName() || sub.asName() !== "Image") return false;
  if (obj.get("ImageMask").isBoolean() && obj.get("ImageMask").asBoolean()) return false;
  if (!obj.get("Mask").isNull() || !obj.get("Decode").isNull()) return false;
  const bpc = obj.get("BitsPerComponent");
  return !bpc.isNumber() || bpc.asNumber() === 8;
}

/**
 * Cleans the file, drops unused objects and duplicates, and re-compresses big
 * pictures so each is no sharper than `dpi` on the page. Pictures that don't get
 * smaller are left untouched.
 */
export function compress(input: PdfInput, level: Squeeze): CompressResult {
  const { dpi, quality } = SQUEEZE[level];
  return withPdf(input, (pdf) => {
    let images = 0;
    // How big (in points) each image is drawn, from the page content.
    const drawn = new Map<number, number>();
    for (let p = 0; p < pdf.countPages(); p++) {
      const page = pdf.loadPage(p);
      const dev = new mupdf.Device({
        fillImage(image: mupdf.Image, ctm: mupdf.Matrix) {
          // Matches the PDF object by size; a rough "inches wide" is enough to pick a target.
          const wide = Math.hypot(ctm[0], ctm[1]);
          const key = image.getWidth() * 100000 + image.getHeight();
          drawn.set(key, Math.max(drawn.get(key) ?? 0, wide));
        },
      });
      try {
        page.run(dev, mupdf.Matrix.identity);
      } finally {
        dev.close();
        dev.destroy();
        page.destroy();
      }
    }
    const count = pdf.countObjects();
    for (let n = 1; n < count; n++) {
      const ref = pdf.newIndirect(n);
      const obj = ref;
      if (!plainImage(obj)) continue;
      try {
        const w = obj.get("Width").asNumber();
        const h = obj.get("Height").asNumber();
        const points = drawn.get(w * 100000 + h);
        if (!points || w * h < 40000) continue;
        const targetW = Math.min(w, Math.max(16, Math.round((points / 72) * dpi)));
        const scale = targetW / w;
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const image = pdf.loadImage(ref);
        const gray = image.getNumberOfComponents() === 1;
        const pm = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, tw, th], false);
        pm.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pm);
        dev.fillImage(image, [tw, 0, 0, -th, 0, th], 1);
        dev.close();
        dev.destroy();
        const jpeg = pm.asJPEG(quality);
        const was = obj.readRawStream().getLength();
        pm.destroy();
        image.destroy();
        if (jpeg.byteLength >= was * 0.9) continue;
        obj.writeRawStream(jpeg);
        obj.put("Filter", pdf.newName("DCTDecode"));
        obj.delete("DecodeParms");
        obj.put("Width", pdf.newInteger(tw));
        obj.put("Height", pdf.newInteger(th));
        obj.put("BitsPerComponent", pdf.newInteger(8));
        obj.put("ColorSpace", pdf.newName(gray ? "DeviceGray" : "DeviceRGB"));
        images++;
      } catch {
        // An odd picture is left as it was.
      }
    }
    const bytes = toBytes(pdf.saveToBuffer("garbage=deduplicate,compress,compress-fonts,clean"));
    return { bytes, before: input.bytes.byteLength, after: bytes.byteLength, images };
  });
}

// --- Redact -----------------------------------------------------------------

export interface RedactMark {
  page: number;
  /** x0, y0, x1, y1 in points, top-left origin, as the page looks. */
  rect: [number, number, number, number];
}

export interface RedactOptions {
  marks: RedactMark[];
  /** Words or phrases to black out wherever they appear. */
  terms: string[];
  caseSensitive?: boolean;
}

export interface RedactResult {
  bytes: Uint8Array;
  /** How many areas were removed. */
  areas: number;
  /** Matches for each term. */
  found: Record<string, number>;
}

const boundsOf = (quads: number[][]): [number, number, number, number] => {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** Permanently removes text, pictures and drawings under each area, and paints a black box there. */
export function redact(input: PdfInput, opts: RedactOptions): RedactResult {
  return withPdf(input, (pdf) => {
    const total = pdf.countPages();
    const found: Record<string, number> = Object.fromEntries(opts.terms.map((t) => [t, 0]));
    let areas = 0;
    for (let p = 0; p < total; p++) {
      const rects: [number, number, number, number][] = opts.marks.filter((m) => m.page === p).map((m) => m.rect);
      const page = pdf.loadPage(p);
      try {
        for (const term of opts.terms) {
          if (!term.trim()) continue;
          // MuPDF searches case-insensitively; keep exact-case hits only when asked.
          const hits = page.search(term, undefined) as unknown as number[][][];
          const text = opts.caseSensitive ? page.toStructuredText("").asText() : "";
          if (opts.caseSensitive && !text.includes(term)) continue;
          for (const quads of hits) {
            rects.push(boundsOf(quads));
            found[term]++;
          }
        }
        if (rects.length === 0) continue;
        for (const [x0, y0, x1, y1] of rects) {
          page.createAnnotation("Redact").setRect([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
          areas++;
        }
        page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      } finally {
        page.destroy();
      }
    }
    // Strip what can carry the removed words: bookmarks aside, the document info goes too.
    return { bytes: toBytes(pdf.saveToBuffer("garbage=deduplicate,compress,clean,sanitize")), areas, found };
  });
}

// --- Protect ----------------------------------------------------------------

export interface Protection {
  /** Needed to open the file; empty means anyone can open it (but permissions still apply). */
  openPassword: string;
  /** Needed to change the permissions; defaults to the open password plus a random tail. */
  ownerPassword?: string;
  allow: { print: boolean; copy: boolean; edit: boolean; annotate: boolean };
}

// PDF permission bits (see the spec, table 22).
const BITS = { print: 1 << 2, edit: 1 << 3, copy: 1 << 4, annotate: 1 << 5 };

/** The permission value for the options, with the always-needed high bits set. */
export function permissionBits(allow: Protection["allow"]): number {
  let value = -3904 | 0; // reserved bits set, everything optional cleared
  value &= ~(BITS.print | BITS.edit | BITS.copy | BITS.annotate);
  for (const key of Object.keys(BITS) as (keyof typeof BITS)[]) if (allow[key]) value |= BITS[key];
  return value;
}

function randomPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("");
}

/** Encrypts with AES-256. */
export function protect(input: PdfInput, p: Protection): Uint8Array {
  const clean = (s: string) => s.replace(/[,\s]/g, "");
  return withPdf(input, (pdf) => {
    const owner = clean(p.ownerPassword || "") || randomPassword();
    const options = `encrypt=aes-256,user-password=${clean(p.openPassword)},owner-password=${owner},permissions=${permissionBits(p.allow)},garbage,compress`;
    return toBytes(pdf.saveToBuffer(options));
  });
}

// --- Stamp: watermark, page numbers, header and footer -----------------------

export interface StampOptions {
  /** Diagonal text across each page, e.g. "CONFIDENTIAL". */
  watermark?: { text: string; size: number; color: Rgb; angle: number };
  /** Text printed on every page; {n} is the page number, {total} the page count. */
  numbering?: { format: string; position: "bottom-center" | "bottom-right" | "bottom-left" | "top-center" | "top-right" | "top-left"; size: number; color: Rgb; start: number };
  /** Which pages (0-based); empty means all. */
  pages?: number[];
}

/** Width of text in Helvetica (bold), in points. */
export function textWidth(text: string, size: number, bold = false): number {
  const font = new mupdf.Font(bold ? "Helvetica-Bold" : "Helvetica");
  try {
    let units = 0;
    for (const ch of text) units += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!));
    return units * size;
  } finally {
    font.destroy();
  }
}

export function stamp(input: PdfInput, opts: StampOptions): Uint8Array {
  return withPdf(input, (pdf) => {
    const total = pdf.countPages();
    const only = opts.pages?.length ? new Set(opts.pages) : undefined;
    for (let i = 0; i < total; i++) {
      if (only && !only.has(i)) continue;
      const page = pdf.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const w = x1 - x0;
        const h = y1 - y0;
        if (opts.watermark?.text.trim()) {
          const { text, size, color, angle } = opts.watermark;
          const width = textWidth(text, size, true);
          const phi = (angle * Math.PI) / 180; // clockwise on screen
          const cx = w / 2;
          const cy = h / 2;
          // The baseline starts half the text back along its direction from the centre, and a third of the letter height below it.
          const origin: [number, number] = [cx - (Math.cos(phi) * width) / 2 + Math.sin(phi) * size * 0.35, cy - (Math.sin(phi) * width) / 2 - Math.cos(phi) * size * 0.35];
          writeRuns(pdf, i, [{ text, origin, size, color, angle: phi, font: { name: "Helvetica-Bold", family: "sans", bold: true, italic: false } }]);
        }
        if (opts.numbering?.format.trim()) {
          const n = opts.numbering;
          const label = n.format.replace(/\{n\}/g, String(i + n.start)).replace(/\{total\}/g, String(total));
          const width = textWidth(label, n.size);
          const margin = 28;
          const left = n.position.endsWith("left") ? margin : n.position.endsWith("right") ? w - margin - width : (w - width) / 2;
          const y = n.position.startsWith("top") ? margin + n.size : h - margin;
          writeRuns(pdf, i, [{ text: label, origin: [left, y], size: n.size, color: n.color }]);
        }
      } finally {
        page.destroy();
      }
    }
    return toBytes(pdf.saveToBuffer("garbage,compress"));
  });
}

// --- Forms ------------------------------------------------------------------

export interface FormField {
  /** Unique key: page and field order. */
  id: string;
  page: number;
  name: string;
  label: string;
  kind: "text" | "checkbox" | "radio" | "choice" | "other";
  value: string;
  options: string[];
  multiline: boolean;
  readOnly: boolean;
  rect: [number, number, number, number];
}

function kindOf(w: mupdf.PDFWidget): FormField["kind"] {
  if (w.isText()) return "text";
  if (w.isCheckbox()) return "checkbox";
  if (w.isRadioButton()) return "radio";
  if (w.isChoice()) return "choice";
  return "other";
}

export function formFields(input: PdfInput): FormField[] {
  return withPdf(input, (pdf) => {
    const out: FormField[] = [];
    for (let p = 0; p < pdf.countPages(); p++) {
      const page = pdf.loadPage(p);
      try {
        page.getWidgets().forEach((w, k) => {
          const kind = kindOf(w);
          if (kind === "other" || w.isPushButton()) return;
          out.push({
            id: `${p}:${k}`,
            page: p,
            name: w.getName(),
            label: w.getLabel() || w.getName(),
            kind,
            value: w.getValue(),
            options: kind === "choice" ? w.getOptions() : [],
            multiline: kind === "text" && w.isMultiline(),
            readOnly: w.isReadOnly(),
            rect: w.getBounds() as [number, number, number, number],
          });
        });
      } finally {
        page.destroy();
      }
    }
    return out;
  });
}

/** Sets values by field id (checkboxes: "on"/"off"). With `flatten`, the answers are baked into the page and the fields go. */
export function fillForm(input: PdfInput, values: Record<string, string>, flatten: boolean): Uint8Array {
  return withPdf(input, (pdf) => {
    for (let p = 0; p < pdf.countPages(); p++) {
      const page = pdf.loadPage(p);
      try {
        page.getWidgets().forEach((w, k) => {
          const want = values[`${p}:${k}`];
          if (want === undefined || w.isReadOnly()) return;
          if (w.isText()) w.setTextValue(want);
          else if (w.isChoice()) w.setChoiceValue(want);
          else if ((w.isCheckbox() || w.isRadioButton()) && (want === "on") !== (w.getValue() !== "Off" && w.getValue() !== "")) w.toggle();
        });
        page.update();
      } finally {
        page.destroy();
      }
    }
    if (flatten) pdf.bake(true, true);
    return toBytes(pdf.saveToBuffer("garbage,compress"));
  });
}

// --- Properties -------------------------------------------------------------

export interface Properties {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

const KEYS: [keyof Properties, string][] = [
  ["title", "info:Title"],
  ["author", "info:Author"],
  ["subject", "info:Subject"],
  ["keywords", "info:Keywords"],
];

export function readProperties(input: PdfInput): Properties {
  return withPdf(input, (pdf) => Object.fromEntries(KEYS.map(([k, key]) => [k, pdf.getMetaData(key) ?? ""])) as unknown as Properties);
}

export function writeProperties(input: PdfInput, props: Properties): Uint8Array {
  return withPdf(input, (pdf) => {
    for (const [k, key] of KEYS) pdf.setMetaData(key, props[k]);
    return toBytes(pdf.saveToBuffer("garbage,compress"));
  });
}

// --- Search -----------------------------------------------------------------

export interface SearchHit {
  page: number;
  /** x0, y0, x1, y1 in points, top-left origin. */
  rect: [number, number, number, number];
}

export function searchDocument(pdf: mupdf.PDFDocument, needle: string, limit = 500): SearchHit[] {
  const hits: SearchHit[] = [];
  if (!needle.trim()) return hits;
  for (let p = 0; p < pdf.countPages() && hits.length < limit; p++) {
    const page = pdf.loadPage(p);
    try {
      for (const quads of page.search(needle, undefined) as unknown as number[][][]) hits.push({ page: p, rect: boundsOf(quads) });
    } finally {
      page.destroy();
    }
  }
  return hits;
}

export { appendContent };
