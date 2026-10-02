import * as mupdf from "mupdf";
import fs from "node:fs";

/** Builds a PDF whose pages read "<label> <n>", optionally encrypted. */
export function makePdf(pageCount: number, label = "Page", saveOptions = ""): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = doc.addObject({ Font: { F1: font } });
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([0, 0, 595, 842], 0, resources, `BT /F1 24 Tf 72 700 Td (${label} ${i}) Tj ET`);
    doc.insertPage(-1, page);
  }
  const bytes = doc.saveToBuffer(saveOptions).asUint8Array().slice();
  doc.destroy();
  return bytes;
}

/** Print/copy/edit blocked, opens without a password. */
export const RESTRICTED = "encrypt=aes-256,owner-password=owner,user-password=,permissions=-3904";
/** Needs "open-sesame" to open. */
export const PASSWORD = "encrypt=aes-256,owner-password=owner,user-password=open-sesame";

export function pageTexts(bytes: Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const texts: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    texts.push(doc.loadPage(i).toStructuredText("").asText().trim());
  }
  doc.destroy();
  return texts;
}

export function rotations(bytes: Uint8Array): number[] {
  const doc = new mupdf.PDFDocument(bytes);
  const out: number[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const rotate = doc.findPage(i).getInheritable("Rotate");
    out.push(rotate.isNumber() ? rotate.asNumber() : 0);
  }
  doc.destroy();
  return out;
}

/** A PDF whose text uses an embedded TrueType font (like a Word export). */
export function makeEmbeddedPdf(
  lines: { text: string; size: number; color: [number, number, number]; y: number }[],
  { subset = false } = {},
): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const ttf = new mupdf.Font("DejaVuSans", fs.readFileSync(DEJAVU));
  const res = doc.addObject({ Font: { F1: doc.addFont(ttf) } });
  const gids = (s: string) => [...s].map((c) => ttf.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("");
  const content = lines.map((l) => `BT /F1 ${l.size} Tf ${l.color.join(" ")} rg 72 ${842 - l.y} Td <${gids(l.text)}> Tj ET`).join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
  if (subset) doc.subsetFonts();
  const bytes = doc.saveToBuffer("compress").asUint8Array().slice();
  doc.destroy();
  return bytes;
}

export const DEJAVU = new URL("./fonts/DejaVuSans.ttf", import.meta.url);

/** Text of each line on page 0 with the font, size and colour of its first character. */
export function styledLines(bytes: Uint8Array) {
  const doc = new mupdf.PDFDocument(bytes);
  const out: { text: string; font: string; size: number; color: number[] }[] = [];
  const st = doc.loadPage(0).toStructuredText("preserve-whitespace");
  let cur: (typeof out)[number] | undefined;
  st.walk({
    beginLine() {
      cur = { text: "", font: "", size: 0, color: [] };
    },
    onChar(c, _o, font, size, _q, color) {
      if (!cur!.text) Object.assign(cur!, { font: font.getName(), size: Math.round(size * 10) / 10, color: color.map((v) => Math.round(v * 100) / 100) });
      cur!.text += c;
    },
    endLine() {
      if (cur!.text.trim()) out.push({ ...cur!, text: cur!.text.trim() });
    },
  });
  doc.destroy();
  return out;
}

/** A "scanned" PDF: each page is just a picture of the original page, no text. */
export function makeScannedPdf(source: Uint8Array, dpi = 200, jpeg = false): Uint8Array {
  const src = new mupdf.PDFDocument(source);
  const out = new mupdf.PDFDocument();
  for (let i = 0; i < src.countPages(); i++) {
    const page = src.loadPage(i);
    const [, , w, h] = page.getBounds();
    const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceGray, false, true);
    const image = out.addImage(jpeg ? new mupdf.Image(pix.asJPEG(80)) : new mupdf.Image(pix));
    const res = out.addObject({ XObject: { Im0: image } });
    out.insertPage(-1, out.addPage([0, 0, w, h], 0, res, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
  }
  const bytes = out.saveToBuffer("compress").asUint8Array().slice();
  src.destroy();
  out.destroy();
  return bytes;
}
