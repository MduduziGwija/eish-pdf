import { createWorker } from "tesseract.js";
import { describe, expect, it } from "vitest";
import { wordsFromBlocks, type TesseractBlock } from "../src/core/ocrwords";
import { openPdf, renderPage } from "../src/core/pdf";
import { addOcrLayer, pageHasText } from "../src/core/text";
import { makeEmbeddedPdf, makeScannedPdf, pageTexts } from "./fixtures";

const LANG_PATH = new URL("../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url).pathname;

describe("wordsFromBlocks", () => {
  it("scales pixels to points and follows the baseline", () => {
    const blocks: TesseractBlock[] = [
      {
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 100, y0: 200, x1: 500, y1: 260 },
                baseline: { x0: 100, y0: 250, x1: 500, y1: 254 },
                words: [
                  { text: "Hello", bbox: { x0: 100, y0: 200, x1: 250, y1: 260 }, confidence: 95 },
                  { text: "  ", bbox: { x0: 260, y0: 200, x1: 270, y1: 260 }, confidence: 95 },
                  { text: "~", bbox: { x0: 280, y0: 200, x1: 290, y1: 260 }, confidence: 5 },
                  { text: "world", bbox: { x0: 300, y0: 200, x1: 500, y1: 260 }, confidence: 90 },
                ],
              },
            ],
          },
        ],
      },
    ];
    expect(wordsFromBlocks(blocks, 2)).toEqual([
      { text: "Hello", bbox: [50, 100, 125, 130], baseline: 125 },
      { text: "world", bbox: [150, 100, 250, 130], baseline: 126 },
    ]);
    expect(wordsFromBlocks(null, 2)).toEqual([]);
  });
});

describe("OCR end to end", () => {
  it("makes a scanned page searchable", { timeout: 60_000 }, async () => {
    const scanned = makeScannedPdf(
      makeEmbeddedPdf([
        { text: "Bursary Application Form", size: 22, color: [0, 0, 0], y: 100 },
        { text: "Student number 2026001", size: 14, color: [0, 0, 0], y: 140 },
      ]),
    );
    const doc = openPdf({ bytes: scanned });
    try {
      expect(pageHasText(doc, 0)).toBe(false);
      const scale = 300 / 72;
      const png = renderPage(doc, 0, scale);
      const worker = await createWorker("eng", 1, { langPath: LANG_PATH, gzip: true, cachePath: "/tmp/eish-tess-cache" });
      try {
        const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
        addOcrLayer(doc, 0, wordsFromBlocks(data.blocks as TesseractBlock[], scale));
      } finally {
        await worker.terminate();
      }
      expect(pageHasText(doc, 0)).toBe(true);
      const text = pageTexts(doc.saveToBuffer("").asUint8Array().slice())[0].replace(/\s+/g, " ");
      expect(text).toContain("Bursary Application Form");
      expect(text).toContain("Student number 2026001");
    } finally {
      doc.destroy();
    }
  });
});
