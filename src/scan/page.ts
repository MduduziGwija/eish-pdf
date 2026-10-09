// Finding out which way up a scanned page is, and turning it. Pages are often
// scanned sideways or upside down; OCR only reads text that's upright.
import { wordsFromBlocks, type TesseractBlock } from "../core/ocrwords";
import type { OcrEngine } from "../ocr/engine";
import { readQuality, turnedSize, type Turn } from "./orient";
import { findRules, plane } from "./pixels";

/** Canvas maps for turning an image `k` quarter turns clockwise (w×h is the size before turning). */
const turnMap = (k: Turn, w: number, h: number): [number, number, number, number, number, number] => {
  switch (k) {
    case 1:
      return [0, 1, -1, 0, h, 0];
    case 2:
      return [-1, 0, 0, -1, w, h];
    case 3:
      return [0, -1, 1, 0, 0, w];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
};

/** A PNG turned `k` quarter turns clockwise, optionally shrunk so its long side is at most `maxSide`. */
export async function turnPng(png: Uint8Array, k: Turn, maxSide = Infinity): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  const shrink = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const [w, h] = [Math.max(1, Math.round(bitmap.width * shrink)), Math.max(1, Math.round(bitmap.height * shrink))];
  const [tw, th] = turnedSize(k, w, h);
  const c = document.createElement("canvas");
  c.width = tw;
  c.height = th;
  const ctx = c.getContext("2d")!;
  const [a, b, cc, d, e, f] = turnMap(k, w, h);
  ctx.setTransform(a, b, cc, d, e, f);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't turn the page.");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Which way to turn the page so its text reads upright. A quick small read tells:
 * if the page reads well as it is, it stays; otherwise the other three ways are
 * tried and the one that reads best wins (only if clearly better).
 */
export async function findTurn(engine: OcrEngine, png: Uint8Array, onProgress?: (done: number) => void): Promise<Turn> {
  const quality = async (k: Turn) => {
    const small = await turnPng(png, k, 1400);
    const blocks = await engine.read(small);
    return readQuality(wordsFromBlocks(blocks as TesseractBlock[], 1).map((w) => ({ text: w.text, confidence: w.confidence ?? 0 })));
  };
  const upright = await quality(0);
  onProgress?.(0.25);
  // Plenty of confident text as it is: nothing to turn.
  if (upright >= 100) return 0;
  let best: { k: Turn; q: number } = { k: 0, q: upright };
  let done = 1;
  for (const k of [1, 3, 2] as Turn[]) {
    const q = await quality(k);
    onProgress?.(0.25 + (0.75 * ++done) / 4);
    if (q > best.q) best = { k, q };
  }
  return best.q >= Math.max(40, upright * 1.6) ? best.k : 0;
}

/**
 * A copy of the page for OCR with table rules and form boxes painted out. Tesseract
 * takes a ruled grid for a table picture and skips the writing inside it; without
 * the rules it reads each cell as text. (The scan itself isn't touched.)
 */
export async function withoutRules(png: Uint8Array, scale: number): Promise<{ clean: Uint8Array; rules: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  const { width: w, height: h } = bitmap;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, w, h);
  const { data } = img;
  // Paper and ink brightness, from a sample of the pixels.
  const sample: number[] = [];
  for (let i = 0; i < w * h; i += 37) sample.push(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  sample.sort((a, b) => a - b);
  const paperLum = sample[Math.floor(sample.length * 0.85)];
  const inkLum = sample[Math.floor(sample.length * 0.02)];
  const range = Math.max(40, paperLum - inkLum);
  const ink = plane(w, h);
  for (let i = 0; i < w * h; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    ink.data[i] = Math.min(1, Math.max(0, (paperLum - lum) / range));
  }
  // Runs longer than any letter: about 28pt of ink in a straight line.
  const rules = findRules(ink, Math.round(28 * scale), 1);
  let count = 0;
  for (let i = 0; i < rules.length; i++) count += rules[i];
  if (count < w * h * 0.0004) return { clean: png, rules, width: w, height: h };
  // Paint them out with the paper's colour.
  const paper = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < w * h && n < 4000; i += 53) {
    if (ink.data[i] < 0.05) {
      for (let k = 0; k < 3; k++) paper[k] += data[i * 4 + k];
      n++;
    }
  }
  const fill = paper.map((v) => (n ? v / n : 255));
  for (let i = 0; i < rules.length; i++) {
    if (!rules[i]) continue;
    for (let k = 0; k < 3; k++) data[i * 4 + k] = fill[k];
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) return { clean: png, rules, width: w, height: h };
  return { clean: new Uint8Array(await blob.arrayBuffer()), rules, width: w, height: h };
}
