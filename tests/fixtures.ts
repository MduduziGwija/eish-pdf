import * as mupdf from "mupdf";

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
