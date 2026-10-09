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
  /** Tilt of the baseline, radians clockwise from level (y down). */
  angle: number;
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
        const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = line.baseline;
        const angle = bx1 - bx0 > 8 ? Math.atan2(by1 - by0, bx1 - bx0) : 0;
        // Capitals and tall letters rise about 0.72 of the font size above the baseline.
        const ascent = Math.max(...words.map((w) => w.baseline - w.bbox[1]));
        const size = Math.max(4, Math.round((ascent / 0.72) * 2) / 2);
        const letters: OcrLetter[] = line.words
          .filter((w) => w.confidence >= MIN_CONFIDENCE)
          .flatMap((w) => w.symbols ?? [])
          .filter((l) => l.confidence >= MIN_LETTER_CONFIDENCE && l.text.trim().length === 1)
          .map((l) => ({ text: l.text, confidence: l.confidence, bbox: [l.bbox.x0 / scale, l.bbox.y0 / scale, l.bbox.x1 / scale, l.bbox.y1 / scale] }));
        lines.push({ text: words.map((w) => w.text).join(" "), bbox: [x0, y0, x1, y1], origin: [x0, baseline], size, words, letters, angle: Number.isFinite(angle) ? angle : 0 });
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
        if (overlap >= height * 0.5 && similar && gap > -size && gap <= size * 0.9 && Math.abs(a.origin[1] - b.origin[1]) <= size * 0.35) {
          const words = [...a.words, ...b.words].sort((p, q) => p.bbox[0] - q.bbox[0]);
          const main = a.words.length >= b.words.length ? a : b;
          out[i] = {
            text: words.map((w) => w.text).join(" "),
            bbox: [Math.min(a.bbox[0], b.bbox[0]), Math.min(a.bbox[1], b.bbox[1]), Math.max(a.bbox[2], b.bbox[2]), Math.max(a.bbox[3], b.bbox[3])],
            origin: [Math.min(a.origin[0], b.origin[0]), main.origin[1]],
            size: main.size,
            words,
            letters: [...a.letters, ...b.letters],
            angle: main.angle,
          };
          out.splice(j, 1);
          joined = true;
        }
      }
    }
  }
  return out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/**
 * Splits lines where a ruled line runs between two words (the border between two
 * table cells), so each cell is its own line. `rules` marks pixels that belong to
 * ruled lines, in the image the lines were read from (w×h pixels at `scale` pixels per point).
 */
export function splitLinesAtRules(lines: OcrLine[], rules: Uint8Array, w: number, h: number, scale: number): OcrLine[] {
  const out: OcrLine[] = [];
  for (const line of lines) {
    const words = [...line.words].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const y0 = Math.max(0, Math.floor(line.bbox[1] * scale));
    const y1 = Math.min(h, Math.ceil(line.bbox[3] * scale));
    const groups: OcrWord[][] = [[]];
    for (let i = 0; i < words.length; i++) {
      if (i > 0) {
        const from = Math.max(0, Math.floor(words[i - 1].bbox[2] * scale));
        const to = Math.min(w, Math.ceil(words[i].bbox[0] * scale));
        let cut = false;
        for (let x = from; x < to && !cut; x++) {
          let on = 0;
          for (let y = y0; y < y1; y++) on += rules[y * w + x];
          cut = y1 > y0 && on >= (y1 - y0) * 0.6;
        }
        if (cut) groups.push([]);
      }
      groups[groups.length - 1].push(words[i]);
    }
    if (groups.length === 1) {
      out.push(line);
      continue;
    }
    for (const group of groups) {
      const x0 = Math.min(...group.map((wd) => wd.bbox[0]));
      const x1 = Math.max(...group.map((wd) => wd.bbox[2]));
      out.push({
        ...line,
        text: group.map((wd) => wd.text).join(" "),
        bbox: [x0, Math.min(...group.map((wd) => wd.bbox[1])), x1, Math.max(...group.map((wd) => wd.bbox[3]))],
        origin: [x0, group[0].baseline],
        words: group,
        letters: line.letters.filter((l) => (l.bbox[0] + l.bbox[2]) / 2 >= x0 && (l.bbox[0] + l.bbox[2]) / 2 <= x1),
      });
    }
  }
  return out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
