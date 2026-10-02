import * as mupdf from "mupdf";
import { createWorker } from "tesseract.js";
import { beforeAll, describe, expect, it } from "vitest";
import { linesFromBlocks, type OcrLine, type TesseractBlock } from "../src/core/ocrwords";
import { edit, openPdf, renderPage } from "../src/core/pdf";
import { makeEmbeddedPdf, makeScannedPdf, pageTexts } from "./fixtures";

const LANG_PATH = new URL("../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url).pathname;
const scan = makeScannedPdf(
  makeEmbeddedPdf([
    { text: "Bursary Award Letter", size: 22, color: [0, 0, 0], y: 100 },
    { text: "Amount awarded: R45 000", size: 14, color: [0, 0, 0], y: 150 },
    { text: "Signed by the bursary office", size: 12, color: [0, 0, 0], y: 190 },
  ]),
);
let lines: OcrLine[];

beforeAll(async () => {
  const doc = openPdf({ bytes: scan });
  const scale = 300 / 72;
  const png = renderPage(doc, 0, scale);
  doc.destroy();
  const worker = await createWorker("eng", 1, { langPath: LANG_PATH, gzip: true, cachePath: "/tmp/eish-tess-cache" });
  try {
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
    lines = linesFromBlocks(data.blocks as TesseractBlock[], scale);
  } finally {
    await worker.terminate();
  }
}, 60_000);

describe("editing scanned pages", () => {
  it("reads lines with positions and sensible font sizes", () => {
    expect(lines.map((l) => l.text)).toEqual(["Bursary Award Letter", "Amount awarded: R45 000", "Signed by the bursary office"]);
    expect(lines[0].size).toBeGreaterThan(18);
    expect(lines[0].size).toBeLessThan(26);
    expect(lines[1].size).toBeGreaterThan(11);
    expect(lines[1].size).toBeLessThan(17);
    // Baseline of the 14pt line drawn at y=150.
    expect(Math.abs(lines[1].origin[1] - 150)).toBeLessThan(3);
    expect(Math.abs(lines[1].origin[0] - 72)).toBeLessThan(3);
  });

  it("replaces a line on the scan and keeps the rest searchable", () => {
    const line = lines[1];
    const paper: [number, number, number] = [0.96, 0.94, 0.86];
    const out = edit({ bytes: scan }, [
      {
        source: 0,
        rotate: 0,
        ocr: lines.flatMap((l) => l.words),
        annotations: [
          {
            type: "replace",
            rect: line.bbox,
            text: "Amount awarded: R50 000",
            origin: line.origin,
            size: line.size,
            color: [0, 0, 0],
            font: { name: "", family: "sans", bold: false, italic: false },
            background: paper,
          },
        ],
      },
    ]);
    const text = pageTexts(out)[0].replace(/\s+/g, " ");
    expect(text).toContain("Amount awarded: R50 000");
    expect(text).not.toContain("R45");
    expect(text).toContain("Bursary Award Letter");
    expect(text).toContain("Signed by the bursary office");

    // The patch is painted in the paper colour (just right of the new, shorter-or-equal text).
    const doc = mupdf.Document.openDocument(out, "application/pdf");
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    const at = (x: number, y: number) => {
      const i = (Math.round(y) * pix.getWidth() + Math.round(x)) * 3;
      return [...pix.getPixels().slice(i, i + 3)];
    };
    const [r, g, b] = at(line.bbox[2] - 1, line.bbox[1] + 1);
    doc.destroy();
    expect(Math.abs(r - 245)).toBeLessThan(6);
    expect(Math.abs(g - 240)).toBeLessThan(6);
    expect(Math.abs(b - 219)).toBeLessThan(6);
  });
});
