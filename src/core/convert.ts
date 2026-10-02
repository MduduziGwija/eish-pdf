// Converting other formats to PDF, and PDFs to other formats.
import * as mupdf from "mupdf";
import { buildDocx, type DocBlock, type DocRun } from "./docx";
import { openPdf, type PdfInput } from "./pdf";

const A4: [number, number] = [595, 842];

/** File types MuPDF opens itself (everything else is prepared in the UI first). */
export const NATIVE_TYPES = /\.(pdf|xps|oxps|epub|fb2|mobi|cbz|txt|text|md|markdown|html?|xhtml|png|jpe?g|gif|bmp|tiff?|jpx|jp2|pnm|pbm|pgm|ppm|pam)$/i;
export const IMAGE_TYPES = /\.(png|jpe?g|gif|bmp|tiff?|jpx|jp2|pnm|pbm|pgm|ppm|pam|webp|avif|svg|heic|heif)$/i;

function toBytes(buf: mupdf.Buffer): Uint8Array {
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** Draws every page of any MuPDF document into a new PDF. */
function writePdf(doc: mupdf.Document): Uint8Array {
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, "pdf", "compress");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      const device = writer.beginPage(page.getBounds());
      page.run(device, mupdf.Matrix.identity);
      writer.endPage();
    } finally {
      page.destroy();
    }
  }
  writer.close();
  return toBytes(buf);
}

/**
 * Converts a document MuPDF understands (text, Markdown, HTML, EPUB, XPS,
 * comic books…) to PDF. Flowing formats are laid out on A4.
 */
export function documentToPdf(bytes: Uint8Array, fileName: string, landscape = false): Uint8Array {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, fileName);
  } catch {
    throw new Error("Eish PDF can't read this kind of file.");
  }
  try {
    if (!IMAGE_TYPES.test(fileName)) {
      try {
        if (landscape) doc.layout(A4[1], A4[0], 11);
        else doc.layout(A4[0], A4[1], 11);
      } catch {
        // Fixed-layout documents can't be laid out; that's fine.
      }
    }
    if (doc.countPages() === 0) throw new Error("That file has no pages.");
    return writePdf(doc);
  } finally {
    doc.destroy();
  }
}

/** Lays out an HTML page (UTF-8) on A4 pages. */
export function htmlToPdf(html: string, landscape = false): Uint8Array {
  return documentToPdf(new Uint8Array(new TextEncoder().encode(html)), "document.html", landscape);
}

export interface ImageOptions {
  /** "fit": each page is the image's size. "a4": the image is centred on an A4 page. */
  pageSize: "fit" | "a4";
}

/** Puts each image on its own page. Images must be in a format MuPDF reads (PNG, JPEG, …). */
export function imagesToPdf(images: Uint8Array[], options: ImageOptions): Uint8Array {
  if (images.length === 0) throw new Error("Add at least one picture.");
  const doc = new mupdf.PDFDocument();
  try {
    images.forEach((bytes, i) => {
      let image: mupdf.Image;
      try {
        image = new mupdf.Image(bytes);
      } catch {
        throw new Error(`Picture ${i + 1} couldn't be read.`);
      }
      const dpiX = image.getXResolution() || 96;
      const dpiY = image.getYResolution() || 96;
      const w = (image.getWidth() * 72) / dpiX;
      const h = (image.getHeight() * 72) / dpiY;
      let pageW = w;
      let pageH = h;
      let [x, y, dw, dh] = [0, 0, w, h];
      if (options.pageSize === "a4") {
        // Landscape pages for landscape pictures, 36pt margins, never upscaled past 100%.
        [pageW, pageH] = w > h ? [A4[1], A4[0]] : A4;
        const scale = Math.min(1, (pageW - 72) / w, (pageH - 72) / h);
        [dw, dh] = [w * scale, h * scale];
        [x, y] = [(pageW - dw) / 2, (pageH - dh) / 2];
      }
      const ref = doc.addImage(image);
      const resources = doc.addObject({ XObject: { Im0: ref } });
      doc.insertPage(-1, doc.addPage([0, 0, pageW, pageH], 0, resources, `q ${dw} 0 0 ${dh} ${x} ${y} cm /Im0 Do Q`));
      image.destroy();
    });
    return toBytes(doc.saveToBuffer("garbage,compress"));
  } finally {
    doc.destroy();
  }
}

// --- From PDF ----------------------------------------------------------------

/** Each page's text as lines (for comparing documents). */
export function pdfLines(input: PdfInput): string[][] {
  const doc = openPdf(input);
  try {
    const pages: string[][] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("");
      pages.push(st.asText().split("\n"));
      st.destroy();
      page.destroy();
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

export function pdfToText(input: PdfInput): string {
  const doc = openPdf(input);
  try {
    const pages: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("preserve-whitespace");
      pages.push(st.asText().replace(/\s+$/, ""));
      st.destroy();
      page.destroy();
    }
    return pages.join("\n\n\f");
  } finally {
    doc.destroy();
  }
}

/** A web page that reproduces each PDF page's text layout. */
export function pdfToHtml(input: PdfInput): string {
  const doc = openPdf(input);
  try {
    const buf = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buf, "html", "");
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const device = writer.beginPage(page.getBounds());
      page.run(device, mupdf.Matrix.identity);
      writer.endPage();
      page.destroy();
    }
    writer.close();
    return new TextDecoder().decode(toBytes(buf));
  } finally {
    doc.destroy();
  }
}

/** One picture per page. */
export function pdfToImages(input: PdfInput, format: "png" | "jpg", dpi: number): Uint8Array[] {
  const doc = openPdf(input);
  try {
    const out: Uint8Array[] = [];
    const scale = dpi / 72;
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      out.push((format === "png" ? pix.asPNG() : pix.asJPEG(88)).slice());
      pix.destroy();
      page.destroy();
    }
    return out;
  } finally {
    doc.destroy();
  }
}

const hexColor = (c: mupdf.Color): string => {
  let rgb: number[];
  if (c.length === 3) rgb = c;
  else if (c.length === 1) rgb = [c[0], c[0], c[0]];
  else rgb = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
};

/** "ABCDEF+TimesNewRomanPS-BoldMT" -> "Times New Roman" */
export function fontFamilyName(name: string): string {
  const base = name
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/[-,].*$/, "")
    .replace(/(PSMT|PS|MT)$/, "");
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  const known: Record<string, string> = { Helvetica: "Arial", Times: "Times New Roman", "Times Roman": "Times New Roman", Courier: "Courier New" };
  return known[spaced] ?? (spaced || "Arial");
}

/** An editable Word document: paragraphs with their fonts, sizes and colours, plus pictures. */
export function pdfToDocx(input: PdfInput, title: string): Uint8Array {
  const doc = openPdf(input);
  const blocks: DocBlock[] = [];
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      if (i > 0) blocks.push({ type: "pagebreak" });
      const page = doc.loadPage(i);
      const [px0, , px1] = page.getBounds();
      const st = page.toStructuredText("preserve-images");
      let runs: DocRun[] = [];
      let blockBox: mupdf.Rect = [0, 0, 0, 0];
      let lineCount = 0;
      st.walk({
        beginTextBlock(bbox) {
          runs = [];
          blockBox = bbox;
          lineCount = 0;
        },
        beginLine() {
          // Lines inside a block flow into one paragraph.
          const last = runs[runs.length - 1];
          if (lineCount++ > 0 && last && !/[\s-]$/.test(last.text)) last.text += " ";
        },
        onChar(c, _origin, font, size, _quad, color) {
          const style = { size: Math.round(size * 2) / 2, bold: font.isBold() || /bold|black|heavy/i.test(font.getName()), italic: font.isItalic() || /italic|oblique/i.test(font.getName()), color: hexColor(color), font: fontFamilyName(font.getName()) };
          const last = runs[runs.length - 1];
          if (last && last.size === style.size && !!last.bold === style.bold && !!last.italic === style.italic && last.color === style.color && last.font === style.font) last.text += c;
          else runs.push({ text: c, ...style });
        },
        endTextBlock() {
          const text = runs.map((r) => r.text).join("").trim();
          if (!text) return;
          const left = blockBox[0] - px0;
          const right = px1 - blockBox[2];
          const centred = lineCount === 1 && left > 72 && Math.abs(left - right) < 18;
          const rightAligned = lineCount === 1 && right < 80 && left > (px1 - px0) / 2;
          blocks.push({ type: "p", runs, align: centred ? "center" : rightAligned ? "right" : "left", indent: centred || rightAligned ? 0 : Math.max(0, left - 72) });
        },
        onImageBlock(bbox, _transform, image) {
          try {
            let pix = image.toPixmap();
            const cs = pix.getColorSpace();
            if (!cs || cs.getNumberOfComponents() > 3 || pix.getAlpha()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
            blocks.push({ type: "img", png: pix.asPNG().slice(), width: Math.max(8, bbox[2] - bbox[0]), height: Math.max(8, bbox[3] - bbox[1]) });
          } catch {
            // Skip pictures in formats that can't be re-encoded.
          }
        },
      });
      st.destroy();
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return buildDocx(blocks, title);
}
