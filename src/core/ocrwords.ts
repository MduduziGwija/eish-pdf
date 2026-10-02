// Converts Tesseract's result (pixels of the rendered page image) into words in
// PDF page space (points). Kept free of Tesseract and MuPDF so it's easy to test.
import type { OcrWord } from "./text";

interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TesseractLine {
  bbox: Bbox;
  baseline: Bbox;
  words: { text: string; bbox: Bbox; confidence: number }[];
}

export interface TesseractBlock {
  paragraphs: { lines: TesseractLine[] }[];
}

/** Words below this confidence (0-100) are usually specks or noise. */
const MIN_CONFIDENCE = 20;

export function wordsFromBlocks(blocks: TesseractBlock[] | null | undefined, scale: number): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const { x0, y0, x1, y1 } = line.baseline;
        const slope = x1 !== x0 ? (y1 - y0) / (x1 - x0) : 0;
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text || w.confidence < MIN_CONFIDENCE) continue;
          // Baseline under the word's left edge, following any slight tilt.
          const base = y0 + slope * (w.bbox.x0 - x0);
          const baseline = Number.isFinite(base) && base > w.bbox.y0 ? base : w.bbox.y1;
          words.push({
            text,
            bbox: [w.bbox.x0 / scale, w.bbox.y0 / scale, w.bbox.x1 / scale, w.bbox.y1 / scale],
            baseline: baseline / scale,
          });
        }
      }
    }
  }
  return words;
}

/** A line of text read from a scanned page, in page space (points). */
export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  /** Baseline start of the line. */
  origin: [number, number];
  /** Estimated font size in points. */
  size: number;
  words: OcrWord[];
}

/** Groups OCR words into lines, with a font size estimated from the letter heights. */
export function linesFromBlocks(blocks: TesseractBlock[] | null | undefined, scale: number): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words = wordsFromBlocks([{ paragraphs: [{ lines: [line] }] }], scale);
        if (words.length === 0) continue;
        const x0 = Math.min(...words.map((w) => w.bbox[0]));
        const y0 = Math.min(...words.map((w) => w.bbox[1]));
        const x1 = Math.max(...words.map((w) => w.bbox[2]));
        const y1 = Math.max(...words.map((w) => w.bbox[3]));
        const baseline = words[0].baseline;
        // Capitals and tall letters rise about 0.72 of the font size above the baseline.
        const ascent = Math.max(...words.map((w) => w.baseline - w.bbox[1]));
        const size = Math.max(4, Math.round((ascent / 0.72) * 2) / 2);
        lines.push({ text: words.map((w) => w.text).join(" "), bbox: [x0, y0, x1, y1], origin: [x0, baseline], size, words });
      }
    }
  }
  return lines;
}
