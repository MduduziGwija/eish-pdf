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
  words: { text: string; bbox: Bbox; confidence: number; symbols?: { text: string; bbox: Bbox; confidence: number }[] }[];
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
            confidence: w.confidence,
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
  /** Single letters Tesseract was sure of, so they can be reused when redrawing the line. */
  letters: OcrLetter[];
}

export interface OcrLetter {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

/** Letters below this confidence aren't reused. */
const MIN_LETTER_CONFIDENCE = 80;

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
        const letters: OcrLetter[] = line.words
          .filter((w) => w.confidence >= MIN_CONFIDENCE)
          .flatMap((w) => w.symbols ?? [])
          .filter((l) => l.confidence >= MIN_LETTER_CONFIDENCE && l.text.trim().length === 1)
          .map((l) => ({ text: l.text, confidence: l.confidence, bbox: [l.bbox.x0 / scale, l.bbox.y0 / scale, l.bbox.x1 / scale, l.bbox.y1 / scale] }));
        lines.push({ text: words.map((w) => w.text).join(" "), bbox: [x0, y0, x1, y1], origin: [x0, baseline], size, words, letters });
      }
    }
  }
  return joinSplitLines(lines);
}

/**
 * OCR sometimes splits one line into pieces (handwriting especially, or a gap
 * after a label). Pieces on the same baseline, close together and of a similar
 * size, are joined back into one line, so editing it replaces all of it.
 */
export function joinSplitLines(lines: OcrLine[]): OcrLine[] {
  const out = [...lines].sort((a, b) => a.bbox[0] - b.bbox[0]);
  let joined = true;
  while (joined) {
    joined = false;
    for (let i = 0; i < out.length && !joined; i++) {
      for (let j = 0; j < out.length && !joined; j++) {
        if (i === j) continue;
        const [a, b] = [out[i], out[j]];
        const overlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
        const height = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
        const size = Math.max(a.size, b.size);
        const gap = b.bbox[0] - a.bbox[2];
        const similar = Math.min(a.size, b.size) / size >= 0.65;
        if (overlap >= height * 0.5 && similar && gap > -size && gap <= size * 2.5 && Math.abs(a.origin[1] - b.origin[1]) <= size * 0.35) {
          const words = [...a.words, ...b.words].sort((p, q) => p.bbox[0] - q.bbox[0]);
          const main = a.words.length >= b.words.length ? a : b;
          out[i] = {
            text: words.map((w) => w.text).join(" "),
            bbox: [Math.min(a.bbox[0], b.bbox[0]), Math.min(a.bbox[1], b.bbox[1]), Math.max(a.bbox[2], b.bbox[2]), Math.max(a.bbox[3], b.bbox[3])],
            origin: [Math.min(a.origin[0], b.origin[0]), main.origin[1]],
            size: main.size,
            words,
            letters: [...a.letters, ...b.letters],
          };
          out.splice(j, 1);
          joined = true;
        }
      }
    }
  }
  return out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
