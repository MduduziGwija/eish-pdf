// A second look at lines the first reading wasn't sure about: each is cut out,
// enlarged and read again as a single line, which often fixes misread letters.
import type { OcrLine } from "../core/ocrwords";
import type { OcrEngine } from "../ocr/engine";

const meanConfidence = (l: OcrLine) => (l.words.length ? l.words.reduce((a, w) => a + (w.confidence ?? 100), 0) / l.words.length : 0);

/** Re-reads weakly read lines in place. `png` is the picture the lines were read from; `scale` is its pixels per point. Returns how many lines improved. */
export async function rereadWeakLines(engine: OcrEngine, png: Uint8Array, lines: OcrLine[], scale: number): Promise<number> {
  // Lines worth a second look: read, but not well; capped, and given a time budget so a busy page never stalls.
  const started = Date.now();
  const weak = lines.filter((l) => l.words.length > 0 && meanConfidence(l) < 80 && meanConfidence(l) >= 20).sort((a, b) => b.words.length - a.words.length);
  if (weak.length === 0) return 0;
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  let better = 0;
  try {
    for (const line of weak.slice(0, 16)) {
      if (Date.now() - started > 7000) break;
      const pad = Math.ceil(line.size * scale * 0.25);
      const x0 = Math.max(0, Math.floor(line.bbox[0] * scale) - pad);
      const y0 = Math.max(0, Math.floor(line.bbox[1] * scale) - pad);
      const x1 = Math.min(bitmap.width, Math.ceil(line.bbox[2] * scale) + pad);
      const y1 = Math.min(bitmap.height, Math.ceil(line.bbox[3] * scale) + pad);
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      // Letters read best when they are about 40 px tall.
      const grow = Math.min(3, Math.max(1, 40 / Math.max(1, line.size * scale * 0.72)));
      const c = document.createElement("canvas");
      c.width = Math.round((x1 - x0) * grow) + 24;
      c.height = Math.round((y1 - y0) * grow) + 24;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0, 12, 12, c.width - 24, c.height - 24);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) continue;
      const read = await engine.readLine(new Uint8Array(await blob.arrayBuffer()));
      const pieces = read.text.split(" ").filter(Boolean);
      // Only trust it when it found the same words, and is clearly surer.
      if (pieces.length !== line.words.length || read.confidence < meanConfidence(line) + 6) continue;
      const ordered = [...line.words].sort((a, b) => a.bbox[0] - b.bbox[0]);
      ordered.forEach((w, i) => {
        w.text = pieces[i];
        w.confidence = Math.max(w.confidence ?? 0, read.confidence);
      });
      line.text = ordered.map((w) => w.text).join(" ");
      better++;
    }
  } finally {
    bitmap.close();
  }
  return better;
}
