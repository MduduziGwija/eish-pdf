// Redraws a line of a scanned page so the new words look scanned (or
// handwritten) too.
//
// 1. Measures the scan: paper and ink colour, paper grain, and whether it's a
//    pure black-and-white scan.
// 2. Finds the closest font. A few "scout" fonts (serif, sans, typewriter and
//    three kinds of handwriting) show which kinds are worth a closer look; then
//    every font of those kinds draws the line's own words, which are compared
//    with the scan.
// 3. Fits size, width, slant, stroke weight, blur and ink strength, by drawing
//    the words each way and comparing them with the scan pixel by pixel.
// 4. Collects the scan's own letters and whole words (when OCR was sure of them
//    and they can be cut out cleanly), so new text reuses the real thing.
// 5. Paints: the old words are covered with paper borrowed from around them,
//    and the new words are drawn in the fitted look. Handwriting gets a little
//    natural wobble, so no two letters come out identical.
import type { OcrLetter } from "../core/ocrwords";
import type { PixelMatrix } from "../core/scanimage";
import type { OcrWord, Rgb } from "../core/text";
import { cssFont, facesOf, FAMILIES, familyByCss, familyFor, loadFace, SCOUTS, type Face, type Generic } from "./fonts";
import { blur, components, crop, dilate, fillPaper, gaussian, hash, inkBox, ncc, plane, random, resize, type Plane } from "./pixels";

type Box = [number, number, number, number];

/** A line of a scanned page, as OCR read it (page coordinates). */
export interface ScanLine {
  text: string;
  bbox: Box;
  origin: [number, number];
  size: number;
  words: OcrWord[];
  letters: OcrLetter[];
}

/** A letter or word cut out of the scan. */
interface Cutout {
  alpha: Plane;
  /** Top of `alpha` relative to the baseline, in pixels (negative = above). */
  top: number;
  /** Ink's left edge and width within `alpha`. */
  left: number;
  width: number;
  score: number;
}

/** How a scanned line looks, in the scan's pixels. */
export interface LineLook {
  face: Face;
  /** Font size, in scan pixels. */
  px: number;
  /** Horizontal scale of the letters. */
  stretch: number;
  /** Slant (positive leans right). */
  shear: number;
  /** Extra stroke width, in scan pixels (heavier print or a thicker pen). */
  weight: number;
  /** Blur, in scan pixels. */
  sigma: number;
  /** Ink strength. */
  gain: number;
  /** Grain (brightness sd, 0–255). */
  noise: number;
  /** Pure black-and-white scan (no greys). */
  bilevel: boolean;
  /** Handwritten (gets natural wobble). */
  hand: boolean;
  ink: Rgb;
  paper: Rgb;
  paperSd: number;
  /** The scan's own letters (a few of each, so repeats differ) and whole words. */
  letters: Map<string, Cutout[]>;
  words: Map<string, Cutout>;
  /** How well the font matches, 0–1. */
  match: number;
}

export interface PaintOptions {
  /** New size ÷ detected size. */
  sizeScale: number;
  /** Ink colour (0–1), if changed. */
  color?: Rgb;
  /** A different style, if the family, bold or italic was changed in the format bar. */
  style?: { generic: Generic; bold: boolean; italic: boolean };
  /** A specific font (its CSS name), instead of the matched one. */
  family?: string;
  underline?: boolean;
  strike?: boolean;
  /** Reuse the scan's own letters and words (default true). */
  letters?: boolean;
  /** Move the new text this far (page points) from where the old line was. */
  offset?: [number, number];
}

export interface Painted {
  png: Uint8Array;
  /** Top-left in scan pixels, and size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where it goes on the page. */
  box: Box;
  /** The new words, for the invisible text layer. */
  words: OcrWord[];
}

/** How text is drawn: font, size and shape adjustments. */
interface Pen {
  face: Face;
  px: number;
  stretch: number;
  shear: number;
  stroke: number;
}

/** Font size words are drawn at when comparing shapes. */
const PROBE = 64;
const SIGMAS = [0, 0.45, 0.75, 1.05, 1.45, 1.95, 2.6];
const SHEARS = [-0.24, -0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18, 0.24, 0.3];

let canvas: HTMLCanvasElement | undefined;
let context: CanvasRenderingContext2D;

/** Draws on a scratch canvas and returns what was drawn as coverage (0–1). */
function drawPlane(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Plane {
  if (!canvas) {
    canvas = document.createElement("canvas");
    context = canvas.getContext("2d", { willReadFrequently: true })!;
  }
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = context.strokeStyle = "#000";
  context.lineJoin = "round";
  draw(context);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
  return plane(canvas.width, canvas.height, out);
}

function measure(face: Face, px: number, text: string): TextMetrics {
  if (!canvas) drawPlane(1, 1, () => undefined);
  context.font = cssFont(face, px);
  return context.measureText(text);
}

/** Draws text with its baseline origin at (x, y). */
function drawText(ctx: CanvasRenderingContext2D, pen: Pen, text: string, x: number, y: number, rotate = 0, scale = 1) {
  ctx.font = cssFont(pen.face, pen.px);
  ctx.setTransform(1, 0, 0, 1, x, y);
  if (rotate) ctx.rotate(rotate);
  ctx.transform(pen.stretch * scale, 0, -pen.shear * scale, scale, 0, 0);
  ctx.fillText(text, 0, 0);
  if (pen.stroke > 0) {
    ctx.lineWidth = pen.stroke;
    ctx.strokeText(text, 0, 0);
  }
}

/** Room around drawn text, so slant, stroke and blur aren't cut off. */
const margin = (pen: Pen, sigma = 0) => pen.px * (0.6 + Math.abs(pen.shear) * 1.2) + pen.stroke + sigma * 3;

/** Draws text (optionally blurred) and crops it to its ink. */
function inkOf(pen: Pen, text: string, sigma = 0): Plane | null {
  const m = margin(pen, sigma);
  const drawn = drawPlane(measure(pen.face, pen.px, text).width * pen.stretch + m * 2, pen.px * 2.2 + sigma * 6, (ctx) => drawText(ctx, pen, text, m, pen.px * 1.5 + sigma * 3));
  const p = blur(drawn, sigma);
  const box = inkBox(p, 0.35);
  return box && crop(p, box[0], box[1], box[2] - box[0], box[3] - box[1]);
}

/** Centre of ink (blur doesn't move it). */
function centroid(p: Plane): [number, number] {
  let m = 0;
  let x = 0;
  let y = 0;
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const v = p.data[j * p.w + i];
      m += v;
      x += v * i;
      y += v * j;
    }
  }
  return m ? [x / m, y / m] : [p.w / 2, p.h / 2];
}

const offsets = new Map<string, [number, number]>();

/** Draws a word blurred, with its centre of ink at `centre`, on a w×h plane. */
function placeWord(pen: Pen, sigma: number, text: string, w: number, h: number, centre: [number, number]): Plane {
  // Where the ink's centre sits relative to the text's origin (cached).
  const key = `${cssFont(pen.face, pen.px)}|${pen.stretch}|${pen.shear}|${pen.stroke}|${text}`;
  let offset = offsets.get(key);
  if (!offset) {
    const m = margin(pen);
    const oy = pen.px * 1.5;
    const probe = drawPlane(measure(pen.face, pen.px, text).width * pen.stretch + m * 2, pen.px * 2.2, (ctx) => drawText(ctx, pen, text, m, oy));
    const [cx, cy] = centroid(probe);
    offset = [cx - m, cy - oy];
    if (offsets.size > 4000) offsets.clear();
    offsets.set(key, offset);
  }
  const [dx, dy] = offset;
  return blur(
    drawPlane(w, h, (ctx) => drawText(ctx, pen, text, centre[0] - dx, centre[1] - dy)),
    sigma,
  );
}

const threshold = (p: Plane) => plane(p.w, p.h, p.data.map((v) => (v >= 0.5 ? 1 : 0)));

/** Typical stroke thickness of black-and-white ink: twice its area over its outline. */
function strokeWidth(p: Plane): number {
  let area = 0;
  let edge = 0;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (!p.data[y * p.w + x]) continue;
      area++;
      const at = (i: number, j: number) => (i < 0 || j < 0 || i >= p.w || j >= p.h ? 0 : p.data[j * p.w + i]);
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) edge++;
    }
  }
  return edge ? (2 * area) / edge : NaN;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const lumOf = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** The scan's pixels, and where they sit on the page. */
export class ScanPicture {
  readonly inPlace: boolean;
  private readonly cache = new Map<string, Promise<LineLook>>();

  private constructor(
    readonly width: number,
    readonly height: number,
    private readonly rgba: Uint8ClampedArray,
    readonly matrix: PixelMatrix,
    inPlace: boolean,
  ) {
    this.inPlace = inPlace;
  }

  /**
   * `inPlace`: the pixels are the page's own scan picture, so edits can be written
   * back into it. Otherwise they're a rendering of the page, and edits go on top.
   */
  static async fromPng(png: Uint8Array, matrix: PixelMatrix, inPlace: boolean): Promise<ScanPicture> {
    const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
    const { width, height } = bitmap;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    c.width = c.height = 0;
    return new ScanPicture(width, height, data, matrix, inPlace);
  }

  toPx([x, y]: [number, number]): [number, number] {
    const [a, , , d, e, f] = this.matrix;
    return [(x - e) / a, (y - f) / d];
  }

  toPage([u, v]: [number, number]): [number, number] {
    const [a, , , d, e, f] = this.matrix;
    return [a * u + e, d * v + f];
  }

  private boxPx(b: Box, pad = 0): Box {
    const [x0, y0] = this.toPx([b[0], b[1]]);
    const [x1, y1] = this.toPx([b[2], b[3]]);
    return [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)), Math.min(this.width, Math.ceil(x1 + pad)), Math.min(this.height, Math.ceil(y1 + pad))];
  }

  private pixels(b: Box): Uint8ClampedArray {
    const [x0, y0, x1, y1] = b;
    const w = x1 - x0;
    const out = new Uint8ClampedArray(w * (y1 - y0) * 4);
    for (let y = y0; y < y1; y++) out.set(this.rgba.subarray((y * this.width + x0) * 4, (y * this.width + x1) * 4), (y - y0) * w * 4);
    return out;
  }

  /** Ink coverage (0–1) of a region, given the paper and ink brightness. */
  private coverage(b: Box, paperLum: number, inkLum: number): Plane {
    const px = this.pixels(b);
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const out = new Float32Array(w * h);
    const range = Math.max(20, paperLum - inkLum);
    for (let i = 0; i < out.length; i++) {
      const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      out[i] = Math.min(1, Math.max(0, (paperLum - lum) / range));
    }
    return plane(w, h, out);
  }

  /** Works out (once per line) how the line looks. `others`: nearby lines whose letters and words may be reused. */
  look(line: ScanLine, others: ScanLine[] = []): Promise<LineLook> {
    const key = line.bbox.join(",");
    let found = this.cache.get(key);
    if (!found) {
      found = this.analyse(line, others);
      found.catch(() => this.cache.delete(key));
      this.cache.set(key, found);
    }
    return found;
  }

  private async analyse(line: ScanLine, others: ScanLine[]): Promise<LineLook> {
    // 1. Paper, ink and grain, from the line's own pixels.
    const region = this.boxPx(line.bbox, 3);
    const px = this.pixels(region);
    const lums: number[] = [];
    for (let i = 0; i < px.length; i += 4) lums.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    const order = lums.map((_, i) => i).sort((a, b) => lums[a] - lums[b]);
    const avg = (from: number, to: number): Rgb => {
      const sum = [0, 0, 0];
      const part = order.slice(from, Math.max(from + 1, to));
      for (const i of part) for (let k = 0; k < 3; k++) sum[k] += px[i * 4 + k];
      return sum.map((v) => v / part.length) as Rgb;
    };
    const n = order.length;
    const ink = avg(0, Math.ceil(n * 0.06));
    const paper = avg(Math.floor(n * 0.6), n);
    const paperLum = lumOf(paper);
    const inkLum = lumOf(ink);
    const light = order.slice(Math.floor(n * 0.6)).map((i) => lums[i]);
    const paperMean = light.reduce((a, b) => a + b, 0) / light.length;
    const paperSd = Math.sqrt(light.reduce((a, b) => a + (b - paperMean) ** 2, 0) / light.length);
    const cover = this.coverage(region, paperLum, inkLum);
    let inked = 0;
    let grey = 0;
    for (const v of cover.data) {
      if (v > 0.2) inked++;
      if (v > 0.2 && v < 0.8) grey++;
    }
    const bilevel = inked > 0 && grey / inked < 0.06 && paperSd < 4;

    // 2. The closest font, from the line's words (the ones OCR was surest of).
    const sure = line.words.filter((w) => (w.confidence ?? 100) >= 60);
    const targets = (sure.length >= 2 ? sure : line.words)
      .map((w) => {
        const b = this.boxPx(w.bbox, 2);
        const local = crop(cover, b[0] - region[0], b[1] - region[1], b[2] - b[0], b[3] - b[1]);
        const box = inkBox(local, 0.35);
        if (!box || box[3] - box[1] < 6 || w.text.length < 2) return null;
        return { text: w.text, target: crop(local, box[0], box[1], box[2] - box[0], box[3] - box[1]), local, ink: box };
      })
      .filter((t): t is NonNullable<typeof t> => !!t)
      .sort((a, b) => b.target.w - a.target.w)
      .slice(0, 8);

    const fallbackPx = line.size / this.matrix[3];
    const score = (face: Face) => {
      let total = 0;
      let weights = 0;
      const sizes: number[] = [];
      const stretches: number[] = [];
      for (const t of targets) {
        const r = inkOf({ face, px: PROBE, stretch: 1, shear: 0, stroke: 0 }, t.text);
        if (!r) continue;
        const sy = t.target.h / r.h;
        const sx = t.target.w / r.w;
        total += ncc(blur(resize(r, t.target.w, t.target.h), 0.8).data, blur(t.target, 0.8).data) * t.target.w;
        weights += t.target.w;
        sizes.push(sy * PROBE);
        stretches.push(sx / sy);
      }
      const stretch = median(stretches);
      const s = weights ? total / weights : 0;
      // Fonts that need a lot of squeezing or stretching are probably the wrong font.
      return { face, score: s - Math.max(0, Math.abs(Math.log(stretch || 1)) - 0.08) * 0.8, px: median(sizes), stretch };
    };

    let candidates: ReturnType<typeof score>[];
    if (targets.length) {
      // Scouts first: which kinds of writing (serif, sans, typewriter, handwriting) look closest?
      const scouts = SCOUTS.map((family) => ({ family, bold: false, italic: false }));
      await Promise.all(scouts.map(loadFace));
      const scouted = scouts.map(score);
      const top = Math.max(...scouted.map((s) => s.score));
      const kinds = new Set(scouted.filter((s) => s.score >= top - 0.08).map((s) => s.face.family.generic));
      // Then every font of those kinds, then the styles (bold, italic) of the best two.
      const regular = FAMILIES.filter((f) => kinds.has(f.generic)).map((family) => ({ family, bold: false, italic: false }));
      await Promise.all(regular.map(loadFace));
      const ranked = regular.map(score).sort((a, b) => b.score - a.score);
      const styled = ranked.slice(0, 2).flatMap((r) => facesOf(r.face.family).slice(1));
      await Promise.all(styled.map(loadFace));
      candidates = [...ranked.slice(0, 3), ...styled.map(score)].sort((a, b) => b.score - a.score).slice(0, 3);
    } else {
      const face = { family: familyFor("sans"), bold: false, italic: false };
      await loadFace(face);
      candidates = [{ face, score: 0, px: fallbackPx, stretch: 1 }];
    }

    // 3. Blur and ink strength come from the scan alone: sharpen the scanned
    // words to pure black and white, and find the blur that turns them back
    // into the scan. (Fitting them along with a font that doesn't quite match,
    // like most fonts against handwriting, would just blur everything.)
    const sample = targets.slice(0, 5);
    const centres = sample.map((t) => centroid(t.local));
    const sharp = sample.map((t) => plane(t.local.w, t.local.h, t.local.data.map((v) => (v >= 0.5 ? 1 : 0))));
    let sigma = 0;
    let gain = 1;
    if (!bilevel && sample.length) {
      let bestErr = Infinity;
      for (const s of SIGMAS) {
        const blurred = sharp.map((b) => blur(b, s));
        let pt = 0;
        let pp = 0;
        blurred.forEach((b, i) => {
          for (let k = 0; k < b.data.length; k++) {
            pt += b.data[k] * sample[i].local.data[k];
            pp += b.data[k] * b.data[k];
          }
        });
        const g = Math.min(2, Math.max(0.6, pp ? pt / pp : 1));
        let e = 0;
        blurred.forEach((b, i) => {
          for (let k = 0; k < b.data.length; k++) e += (Math.min(1, g * b.data[k]) - sample[i].local.data[k]) ** 2;
        });
        if (e < bestErr) [bestErr, sigma, gain] = [e, s, g];
      }
    }
    // How thick the scan's strokes are (pen or print weight).
    const scanStroke = median(sharp.map(strokeWidth));

    // 4. Size, width, slant and weight for each of the best few fonts: draw the
    // words each way, line each up with the scanned word (by its centre of ink,
    // which blur doesn't move), and keep whatever matches the scan most closely.
    const error = (p: Pen) => {
      const placed = sample.map((t, i) => placeWord(p, sigma, t.text, t.local.w, t.local.h, centres[i]));
      let pt = 0;
      let pp = 0;
      placed.forEach((pl, i) => {
        const t = sample[i].local.data;
        for (let k = 0; k < pl.data.length; k++) {
          pt += pl.data[k] * t[k];
          pp += pl.data[k] * pl.data[k];
        }
      });
      const g = bilevel ? 1 : Math.min(2, Math.max(0.6, pp ? pt / pp : 1));
      let e = 0;
      placed.forEach((pl, i) => {
        const t = sample[i].local.data;
        for (let k = 0; k < pl.data.length; k++) {
          const v = Math.min(1, g * pl.data[k]);
          e += ((bilevel ? (v >= 0.5 ? 1 : 0) : v) - t[k]) ** 2;
        }
      });
      return e;
    };
    const tune = (values: number[], apply: (v: number) => Pen) => {
      let bestV = values[0];
      let bestE = Infinity;
      for (const v of values) {
        const e = error(apply(v));
        if (e < bestE) [bestV, bestE] = [v, e];
      }
      return bestV;
    };
    const fitFace = (cand: ReturnType<typeof score>) => {
      const pen: Pen = {
        face: cand.face,
        px: Number.isFinite(cand.px) ? cand.px : fallbackPx,
        stretch: Number.isFinite(cand.stretch) ? Math.min(1.3, Math.max(0.7, cand.stretch)) : 1,
        shear: 0,
        stroke: 0,
      };
      if (sample.length) {
        // Height, keeping the words' width (blur makes letters look taller than they are).
        const f = tune([0.86, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06, 1.08], (v) => ({ ...pen, px: pen.px * v, stretch: pen.stretch / v }));
        pen.px *= f;
        pen.stretch /= f;
        // Slant (handwriting, or text set at an angle), then width.
        pen.shear = tune(SHEARS, (v) => ({ ...pen, shear: v }));
        pen.stretch = Math.min(1.3, Math.max(0.7, pen.stretch * tune([0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06], (v) => ({ ...pen, stretch: pen.stretch * v }))));
        // A heavier pen or print: thicken the font's strokes to the scan's.
        const fontStroke = median(sample.map((t, i) => strokeWidth(threshold(placeWord(pen, sigma, t.text, t.local.w, t.local.h, centres[i])))));
        if (Number.isFinite(scanStroke) && Number.isFinite(fontStroke)) pen.stroke = Math.min(pen.px * 0.12, Math.max(0, scanStroke - fontStroke));
      }
      // Fonts that only fit when squeezed or stretched are less likely to be the one.
      const err = sample.length ? error(pen) * (1 + 3 * Math.abs(Math.log(pen.stretch))) : 0;
      return { pen, err, score: cand.score };
    };
    const best = candidates.map(fitFace).sort((a, b) => a.err - b.err)[0];
    const { pen } = best;
    // Last check, over the whole line: its overall height should match the scan's.
    // (A few short handwritten words can mislead the size.)
    const lineInk = inkBox(cover, 0.35);
    const drawnLine = inkOf(pen, line.text, sigma);
    if (lineInk && drawnLine && line.words.length >= 2) {
      const ratio = (lineInk[3] - lineInk[1]) / drawnLine.h;
      if (Math.abs(ratio - 1) > 0.1) {
        const f = Math.min(1.33, Math.max(0.75, ratio));
        pen.px *= f;
        pen.stroke *= f;
        pen.stretch /= f;
      }
    }
    const hand = pen.face.family.generic === "hand";

    // 5. The scan's own letters (a few of each) and whole words.
    const letters = new Map<string, Cutout[]>();
    const words = new Map<string, Cutout>();
    for (const source of [line, ...others]) {
      const baseline = this.toPx([0, source.origin[1]])[1];
      for (const letter of source.letters) {
        if (!/[\p{L}\p{N}]/u.test(letter.text)) continue;
        const g = this.cutLetter(letter, baseline, paperLum, inkLum);
        if (!g) continue;
        const checked = this.verify(g, letter.text, pen, sigma, hand);
        if (checked === null) continue;
        const list = letters.get(letter.text) ?? [];
        list.push({ ...g, score: checked });
        list.sort((a, b) => b.score - a.score);
        letters.set(letter.text, list.slice(0, 3));
      }
      for (const word of source.words) {
        if ([...word.text].length < 2 || (word.confidence ?? 0) < 75) continue;
        const cut = this.cutWord(word, paperLum, inkLum);
        const had = words.get(word.text);
        if (cut && (!had || cut.score > had.score)) words.set(word.text, cut);
      }
    }

    return {
      face: pen.face,
      px: pen.px,
      stretch: pen.stretch,
      shear: pen.shear,
      weight: pen.stroke,
      sigma,
      gain,
      // Ink gets the same grain as the paper (the scanner's noise).
      noise: bilevel ? 0 : paperSd,
      bilevel,
      hand,
      ink,
      paper,
      paperSd,
      letters,
      words,
      match: Math.max(0, Math.min(1, best.score)),
    };
  }

  /** Cuts blobs of ink out of `box` (scan pixels): those `keepBlob` accepts. */
  private cut(box: Box, padX: number, baseline: number, paperLum: number, inkLum: number, keepBlob: (c: { x0: number; y0: number; x1: number; y1: number; count: number }, inner: Box) => boolean | null): Omit<Cutout, "score"> | null {
    const region: Box = [Math.max(0, box[0] - padX), Math.max(0, box[1] - 4), Math.min(this.width, box[2] + padX), Math.min(this.height, box[3] + 4)];
    const cover = this.coverage(region, paperLum, inkLum);
    const { w, h } = cover;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = cover.data[i] > 0.45 ? 1 : 0;
    const { labels, list } = components(mask, w, h);
    const inner: Box = [box[0] - region[0], box[1] - region[1], box[2] - region[0], box[3] - region[1]];
    const own = new Set<number>();
    for (const c of list) {
      const keep = keepBlob(c, inner);
      if (keep === null) return null;
      if (keep) own.add(c.id);
    }
    if (own.size === 0) return null;
    let [x0, y0, x1, y1] = [w, h, 0, 0];
    for (const c of list) {
      if (!own.has(c.id)) continue;
      x0 = Math.min(x0, c.x0);
      y0 = Math.min(y0, c.y0);
      x1 = Math.max(x1, c.x1);
      y1 = Math.max(y1, c.y1);
    }
    const mine = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) mine[i] = own.has(labels[i]) ? 1 : 0;
    const keep = dilate(mine, w, h, 2);
    const pad = 2;
    const cx0 = Math.max(0, x0 - pad);
    const cy0 = Math.max(0, y0 - pad);
    const cw = Math.min(w, x1 + pad) - cx0;
    const ch = Math.min(h, y1 + pad) - cy0;
    const alpha = plane(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (cy0 + y) * w + cx0 + x;
        alpha.data[y * cw + x] = keep[i] ? cover.data[i] : 0;
      }
    }
    return { alpha, top: region[1] + cy0 - baseline, left: x0 - cx0, width: x1 - x0 };
  }

  /** Cuts one letter out of the scan, if it stands apart from its neighbours. */
  private cutLetter(letter: OcrLetter, baseline: number, paperLum: number, inkLum: number): Omit<Cutout, "score"> | null {
    const lb = this.boxPx(letter.bbox);
    let blobs = 0;
    const g = this.cut(lb, Math.ceil((lb[2] - lb[0]) * 0.5) + 3, baseline, paperLum, inkLum, (c, [lx0, ly0, lx1, ly1]) => {
      const overlapsX = c.x1 > lx0 + 1 && c.x0 < lx1 - 1;
      const overlapsY = c.y1 > ly0 && c.y0 < ly1;
      if (!overlapsX || !overlapsY || c.count < 3) return false;
      // A blob running into the next letter means the letters touch: can't cut it cleanly.
      if (c.x0 < lx0 - 2 || c.x1 > lx1 + 2) return null;
      blobs++;
      return true;
    });
    return g && blobs <= 3 ? g : null;
  }

  /** Cuts a whole word out of the scan (handwriting is often joined up, so words cut better than letters). */
  private cutWord(word: OcrWord, paperLum: number, inkLum: number): Cutout | null {
    const wb = this.boxPx(word.bbox);
    const baseline = this.toPx([0, word.baseline])[1];
    const cut = this.cut(wb, 6, baseline, paperLum, inkLum, (c, [wx0, wy0, wx1, wy1]) => {
      if (c.count < 3) return false;
      const ix = Math.max(0, Math.min(c.x1, wx1) - Math.max(c.x0, wx0));
      const iy = Math.max(0, Math.min(c.y1, wy1) - Math.max(c.y0, wy0));
      const inside = (ix * iy) / Math.max(1, (c.x1 - c.x0) * (c.y1 - c.y0));
      // Mostly inside: part of the word. A little: a neighbour's stroke poking in (left out).
      return inside >= 0.6;
    });
    return cut && { ...cut, score: word.confidence ?? 0 };
  }

  /** Checks a cut-out letter really looks like that letter in the fitted font. Returns a 0–1 score, or null. */
  private verify(g: Omit<Cutout, "score">, ch: string, pen: Pen, sigma: number, hand: boolean): number | null {
    const ink = inkBox(g.alpha, 0.45);
    const r = inkOf(pen, ch);
    if (!ink || !r) return null;
    const gw = ink[2] - ink[0];
    const gh = ink[3] - ink[1];
    // Handwriting varies more, so it gets more leeway.
    const [lo, hi, wide, minScore] = hand ? [0.7, 1.4, 0.6, 0.45] : [0.8, 1.25, 0.4, 0.6];
    if (gh < r.h * lo || gh > r.h * hi) return null;
    if (Math.abs(gw - r.w) > Math.max(3, r.w * wide)) return null;
    // Same height above the baseline as the font's letter.
    const fontTop = -measure(pen.face, pen.px, ch).actualBoundingBoxAscent;
    if (Math.abs(g.top + ink[1] - fontTop) > Math.max(2, pen.px * (hand ? 0.2 : 0.12))) return null;
    const target = crop(g.alpha, ink[0], ink[1], gw, gh);
    const s = ncc(blur(resize(r, gw, gh), Math.max(0.6, sigma)).data, blur(target, 0.6).data);
    return s >= minScore ? s : null;
  }

  /** Paints `text` over the line in the line's look. */
  async paint(line: ScanLine, look: LineLook, text: string, opts: PaintOptions): Promise<Painted> {
    const chosen = opts.family ? familyByCss(opts.family) : undefined;
    const family = chosen ?? (opts.style ? (opts.style.generic === look.face.family.generic ? look.face.family : familyFor(opts.style.generic)) : look.face.family);
    const face: Face = { family, bold: opts.style?.bold ?? look.face.bold, italic: opts.style?.italic ?? look.face.italic };
    await loadFace(face);
    const sameFace = face.family === look.face.family && face.bold === look.face.bold && face.italic === look.face.italic;
    const reuse = opts.letters !== false && sameFace && Math.abs(opts.sizeScale - 1) < 0.03;
    const hand = family.generic === "hand";
    const pen: Pen = { face, px: look.px * opts.sizeScale, stretch: look.stretch, shear: chosen && !sameFace ? 0 : look.shear, stroke: look.weight * opts.sizeScale };
    const { sigma } = look;
    const rand = random(hash(`${line.bbox.join()}|${text}`));
    const m = (s: string) => measure(face, pen.px, s);

    // Lay the text out: the scan's own words and letters where we have them,
    // the fitted font elsewhere. Handwriting wobbles a little.
    type Op = { kind: "font"; ch: string; x: number; dy: number; rotate: number; scale: number } | { kind: "cut"; cut: Cutout; left: number };
    const ops: Op[] = [];
    const placedWords: { text: string; x0: number; x1: number }[] = [];
    const used = new Map<string, number>();
    const phase = rand() * Math.PI * 2;
    let x = 0;
    let index = 0;
    for (const token of text.split(/(\s+)/)) {
      if (!token) continue;
      if (!token.trim()) {
        x += m(token).width * pen.stretch * (hand ? 1 + gaussian(rand) * 0.15 : 1);
        continue;
      }
      const start = x;
      const lead = m([...token][0]).actualBoundingBoxLeft * pen.stretch;
      const whole = reuse ? look.words.get(token) : undefined;
      if (whole) {
        const left = x - lead;
        ops.push({ kind: "cut", cut: whole, left });
        const last = [...token].at(-1)!;
        const lm = m(last);
        x = left + whole.width + Math.max(0, (lm.width - lm.actualBoundingBoxRight) * pen.stretch);
        placedWords.push({ text: token, x0: left, x1: left + whole.width });
        index += token.length;
        continue;
      }
      const chars = [...token];
      // Handwriting: mixing the writer's own letters with font letters inside one
      // word looks odd, so only do it when (nearly) the whole word is covered.
      const covered = chars.filter((c) => look.letters.has(c)).length / chars.length;
      const mix = !look.hand || covered >= 0.8;
      let prefix = "";
      for (const ch of chars) {
        const cx = start + m(prefix).width * pen.stretch;
        prefix += ch;
        const own = reuse && mix ? look.letters.get(ch) : undefined;
        if (own?.length) {
          const k = used.get(ch) ?? 0;
          used.set(ch, k + 1);
          const cut = own[k % own.length];
          const cm = m(ch);
          const centre = cx + ((cm.actualBoundingBoxRight - cm.actualBoundingBoxLeft) / 2) * pen.stretch;
          ops.push({ kind: "cut", cut, left: centre - cut.width / 2 });
        } else {
          const wobble = hand ? Math.sin(index * 0.7 + phase) * 0.02 * pen.px : 0;
          ops.push({
            kind: "font",
            ch,
            x: cx,
            dy: hand ? wobble + gaussian(rand) * 0.025 * pen.px : 0,
            rotate: hand ? gaussian(rand) * 0.035 : 0,
            scale: hand ? 1 + gaussian(rand) * 0.035 : 1,
          });
        }
        index++;
      }
      x = start + m(token).width * pen.stretch + (hand ? gaussian(rand) * 0.04 * pen.px : 0);
      placedWords.push({ text: token, x0: start - lead, x1: x });
    }
    const total = x;

    // Where the old line's ink is, and where the new text starts.
    const lineBox = this.boxPx(line.bbox, 2);
    const oldCover = this.coverage(lineBox, lumOf(look.paper), lumOf(look.ink));
    const oldInk = inkBox(oldCover, 0.3) ?? [0, 0, lineBox[2] - lineBox[0], lineBox[3] - lineBox[1]];
    let baseline = this.toPx([0, line.origin[1]])[1];
    // The new text's first ink lines up with the old line's first ink (unless moved).
    const [dx, dy] = opts.offset ? [opts.offset[0] / this.matrix[0], opts.offset[1] / this.matrix[3]] : [0, 0];
    const originX = lineBox[0] + oldInk[0] - (placedWords[0]?.x0 ?? 0) + dx;
    baseline += dy;

    // The piece of the scan that changes.
    const pad = Math.ceil(sigma * 3 + pen.stroke + 3 + Math.abs(pen.shear) * pen.px);
    const cuts = ops.filter((o): o is Extract<Op, { kind: "cut" }> => o.kind === "cut");
    const x0 = Math.max(0, Math.floor(Math.min(lineBox[0] + oldInk[0], originX, ...cuts.map((c) => originX + c.left - c.cut.left)) - pad));
    const y0 = Math.max(0, Math.floor(Math.min(lineBox[1] + oldInk[1], baseline - pen.px * 1.05, ...cuts.map((c) => baseline + c.cut.top)) - pad));
    // A little extra on the right, so unread old writing under the new text can be removed whole.
    const x1 = Math.min(this.width, Math.ceil(Math.max(lineBox[0] + oldInk[2], originX + total + pen.px * 1.5, ...cuts.map((c) => originX + c.left - c.cut.left + c.cut.alpha.w)) + pad));
    const y1 = Math.min(this.height, Math.ceil(Math.max(lineBox[1] + oldInk[3], baseline + pen.px * 0.35, ...cuts.map((c) => baseline + c.cut.top + c.cut.alpha.h)) + pad));
    const w = x1 - x0;
    const h = y1 - y0;
    const rgba = this.pixels([x0, y0, x1, y1]);
    const cover = this.coverage([x0, y0, x1, y1], lumOf(look.paper), lumOf(look.ink));

    // Cover the old words with paper.
    const old = new Uint8Array(w * h);
    const inkMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        const inked = cover.data[i] > 0.12;
        inkMask[i] = inked ? 1 : 0;
        const gx = xx + x0;
        const gy = y + y0;
        if (inked && gx >= lineBox[0] && gx < lineBox[2] && gy >= lineBox[1] && gy < lineBox[3]) old[i] = 1;
      }
    }
    // OCR sometimes skips words (messy handwriting especially). Old ink on this
    // line that the new text would land on goes too, whole blobs at a time, so
    // nothing old shows through or under the new words.
    {
      const solid = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) solid[i] = cover.data[i] > 0.45 ? 1 : 0;
      const { labels, list } = components(solid, w, h);
      const span0 = originX + (placedWords[0]?.x0 ?? 0) - x0;
      const span1 = originX + total - x0;
      const band0 = lineBox[1] - y0;
      const band1 = lineBox[3] - y0;
      const hit = new Set<number>();
      for (const c of list) {
        const inBand = Math.min(c.y1, band1) - Math.max(c.y0, band0);
        if (c.x1 > span0 && c.x0 < span1 && inBand >= (c.y1 - c.y0) * 0.5) hit.add(c.id);
      }
      // Finish words that were started: take neighbouring blobs on the line closer than a word gap.
      const gap = pen.px * 0.3;
      let grew = hit.size > 0;
      while (grew) {
        grew = false;
        for (const c of list) {
          if (hit.has(c.id)) continue;
          const inBand = Math.min(c.y1, band1) - Math.max(c.y0, band0);
          if (inBand < (c.y1 - c.y0) * 0.5) continue;
          if (list.some((d) => hit.has(d.id) && c.x0 - d.x1 < gap && d.x0 - c.x1 < gap)) {
            hit.add(c.id);
            grew = true;
          }
        }
      }
      if (hit.size) {
        const blobs = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) blobs[i] = hit.has(labels[i]) ? 1 : 0;
        const near = dilate(blobs, w, h, 2);
        for (let i = 0; i < w * h; i++) if (near[i] && inkMask[i]) old[i] = 1;
      }
    }
    const erase = dilate(old, w, h, Math.ceil(sigma + 1));
    fillPaper(rgba, w, h, erase, inkMask, rand, look.paper, look.paperSd);

    // Draw: font letters (blurred like the scan), then the scan's own cut-outs.
    const drawn = drawPlane(w, h, (ctx) => {
      for (const op of ops) if (op.kind === "font") drawText(ctx, pen, op.ch, originX - x0 + op.x, baseline - y0 + op.dy, op.rotate, op.scale);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const thick = Math.max(1, pen.px * 0.06);
      if (opts.underline) ctx.fillRect(originX - x0, baseline - y0 + pen.px * 0.12, total, thick);
      if (opts.strike) ctx.fillRect(originX - x0, baseline - y0 - pen.px * 0.3, total, thick);
    });
    const ink = blur(drawn, sigma);
    for (let i = 0; i < ink.data.length; i++) ink.data[i] = Math.min(1, ink.data[i] * look.gain);
    for (const op of cuts) {
      const { alpha, top, left } = op.cut;
      const gx = Math.round(originX + op.left - left - x0);
      const gy = Math.round(baseline + top - y0);
      for (let y = 0; y < alpha.h; y++) {
        for (let xx = 0; xx < alpha.w; xx++) {
          const tx = gx + xx;
          const ty = gy + y;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const k = ty * w + tx;
          ink.data[k] = Math.max(ink.data[k], alpha.data[y * alpha.w + xx]);
        }
      }
    }

    // Combine: ink over the (patched) paper.
    const colour: Rgb = opts.color ? (opts.color.map((v) => v * 255) as Rgb) : look.ink;
    for (let i = 0; i < w * h; i++) {
      let a = ink.data[i];
      if (look.bilevel) a = a >= 0.5 ? 1 : 0;
      // The paper underneath already has grain; give the new ink its share.
      const grain = a > 0.01 && look.noise > 0 ? a * look.noise * gaussian(rand) : 0;
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = rgba[i * 4 + k] * (1 - a) + colour[k] * a + grain;
      // Unchanged pixels stay see-through, so neighbouring edits don't overwrite each other.
      rgba[i * 4 + 3] = !this.inPlace || erase[i] || a > 0.003 ? 255 : 0;
    }

    const png = await toPng(rgba, w, h);
    const [bx0, by0] = this.toPage([x0, y0]);
    const [bx1, by1] = this.toPage([x1, y1]);
    // Word positions for the invisible text layer.
    const top = this.toPage([0, baseline - pen.px * 0.78])[1];
    const bottom = this.toPage([0, baseline + pen.px * 0.22])[1];
    const basePt = this.toPage([0, baseline])[1];
    const words = placedWords.map((pw) => ({ text: pw.text, bbox: [this.toPage([originX + pw.x0, 0])[0], top, this.toPage([originX + pw.x1, 0])[0], bottom] as Box, baseline: basePt }));
    return { png, x: x0, y: y0, width: w, height: h, box: [bx0, by0, bx1, by1], words };
  }
}

async function toPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't redraw the scan.");
  return new Uint8Array(await blob.arrayBuffer());
}
