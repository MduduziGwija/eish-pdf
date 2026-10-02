// Redraws a line of a scanned page so the new words look scanned too.
//
// 1. Measures the scan: paper and ink colour, paper grain, and whether it's a
//    pure black-and-white scan.
// 2. Finds the closest font: every candidate font draws the line's own words,
//    which are compared with the scan, also fitting size, width and slant.
// 3. Fits the look: stroke weight, blur and ink strength, by comparing the
//    redrawn words with the scanned ones pixel by pixel.
// 4. Collects the scan's own letters (when Tesseract was sure of them and they
//    stand apart), so new words reuse the real letters where it can.
// 5. Paints: the old words are covered with paper borrowed from around them,
//    and the new words are drawn with the fitted font, blur and grain.
import type { OcrLetter } from "../core/ocrwords";
import type { PixelMatrix } from "../core/scanimage";
import type { OcrWord, Rgb } from "../core/text";
import { cssFont, FAMILIES, familyFor, loadFace, type Face, type Generic } from "./fonts";
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

interface Glyph {
  alpha: Plane;
  /** Top of `alpha` relative to the baseline, in pixels (negative = above). */
  top: number;
  /** Horizontal centre of the ink within `alpha`. */
  centre: number;
  score: number;
}

/** How a scanned line looks, in the scan's pixels. */
export interface LineLook {
  face: Face;
  /** Font size, in scan pixels. */
  px: number;
  /** Horizontal scale of the letters. */
  stretch: number;
  /** Extra stroke width, in scan pixels (heavier print). */
  weight: number;
  /** Blur, in scan pixels. */
  sigma: number;
  /** Ink strength. */
  gain: number;
  /** Grain (brightness sd, 0–255). */
  noise: number;
  /** Pure black-and-white scan (no greys). */
  bilevel: boolean;
  ink: Rgb;
  paper: Rgb;
  paperSd: number;
  glyphs: Map<string, Glyph>;
  /** How well the font matches, 0–1. */
  match: number;
}

export interface PaintOptions {
  /** New size ÷ detected size. */
  sizeScale: number;
  /** Ink colour (0–1), if changed. */
  color?: Rgb;
  /** A different style, if the family, bold or italic was changed. */
  style?: { generic: Generic; bold: boolean; italic: boolean };
  underline?: boolean;
  strike?: boolean;
  /** Reuse the scan's own letters (default true). */
  letters?: boolean;
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

/** Font size words are drawn at when comparing shapes. */
const PROBE = 64;
const SIGMAS = [0, 0.45, 0.75, 1.05, 1.45, 1.95, 2.6];
const WEIGHTS = [0, 0.025, 0.05, 0.085];

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

/** Draws text and crops it to its ink. */
function inkOf(face: Face, px: number, stretch: number, stroke: number, text: string, sigma = 0): Plane | null {
  const width = measure(face, px, text).width * stretch + px * 1.5 + stroke * 2 + sigma * 6;
  const drawn = drawPlane(width, px * 2.2 + sigma * 6, (ctx) => {
    ctx.font = cssFont(face, px);
    ctx.setTransform(stretch, 0, 0, 1, px * 0.6 + sigma * 3, px * 1.5 + sigma * 3);
    ctx.fillText(text, 0, 0);
    if (stroke > 0) {
      ctx.lineWidth = stroke;
      ctx.strokeText(text, 0, 0);
    }
  });
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
function placeWord(face: Face, px: number, stretch: number, stroke: number, sigma: number, text: string, w: number, h: number, centre: [number, number]): Plane {
  // Where the ink's centre sits relative to the text's origin (cached).
  const key = `${cssFont(face, px)}|${stretch}|${stroke}|${text}`;
  let offset = offsets.get(key);
  if (!offset) {
    const ox = px * 0.6 + stroke;
    const oy = px * 1.5;
    const probe = drawPlane(measure(face, px, text).width * stretch + px * 1.5 + stroke * 2, px * 2.2, (ctx) => {
      ctx.font = cssFont(face, px);
      ctx.setTransform(stretch, 0, 0, 1, ox, oy);
      ctx.fillText(text, 0, 0);
      if (stroke > 0) {
        ctx.lineWidth = stroke;
        ctx.strokeText(text, 0, 0);
      }
    });
    const [cx, cy] = centroid(probe);
    offset = [cx - ox, cy - oy];
    if (offsets.size > 2000) offsets.clear();
    offsets.set(key, offset);
  }
  const [dx, dy] = offset;
  const drawn = drawPlane(w, h, (ctx) => {
    ctx.font = cssFont(face, px);
    ctx.setTransform(stretch, 0, 0, 1, centre[0] - dx, centre[1] - dy);
    ctx.fillText(text, 0, 0);
    if (stroke > 0) {
      ctx.lineWidth = stroke;
      ctx.strokeText(text, 0, 0);
    }
  });
  return blur(drawn, sigma);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

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

  /** Works out (once per line) how the line looks. `others`: nearby lines whose letters may be reused. */
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
    const lum = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const paperLum = lum(paper);
    const inkLum = lum(ink);
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

    // 2. The closest font, from the line's words.
    const targets = line.words
      .map((w) => {
        const b = this.boxPx(w.bbox, 2);
        const local = crop(cover, b[0] - region[0], b[1] - region[1], b[2] - b[0], b[3] - b[1]);
        const ink = inkBox(local, 0.35);
        if (!ink || ink[3] - ink[1] < 6 || w.text.length < 2) return null;
        return { text: w.text, target: crop(local, ink[0], ink[1], ink[2] - ink[0], ink[3] - ink[1]), local, ink };
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
        const r = inkOf(face, PROBE, 1, 0, t.text);
        if (!r) continue;
        const sy = t.target.h / r.h;
        const sx = t.target.w / r.w;
        const fitted = resize(r, t.target.w, t.target.h);
        total += ncc(blur(fitted, 0.8).data, blur(t.target, 0.8).data) * t.target.w;
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
      const regular = FAMILIES.map((family) => ({ family, bold: false, italic: false }));
      await Promise.all(regular.map(loadFace));
      const ranked = regular.map(score).sort((a, b) => b.score - a.score);
      const styled = ranked.slice(0, 2).flatMap((r) => [
        { family: r.face.family, bold: true, italic: false },
        { family: r.face.family, bold: false, italic: true },
        { family: r.face.family, bold: true, italic: true },
      ]);
      await Promise.all(styled.map(loadFace));
      candidates = [...ranked.slice(0, 2), ...styled.map(score)].sort((a, b) => b.score - a.score).slice(0, 3);
    } else {
      const face = { family: FAMILIES[1], bold: false, italic: false };
      await loadFace(face);
      candidates = [{ face, score: 0, px: fallbackPx, stretch: 1 }];
    }

    // 3. Size, width, stroke weight, blur and ink strength: draw the words each
    // way, line each up with the scanned word (by its centre of ink, which blur
    // doesn't move), and keep whatever matches the scan most closely. The best
    // few fonts are each fitted fully (bold vs. a heavier regular, say, only
    // separate once blur is accounted for).
    const sample = targets.slice(0, 5);
    const centres = sample.map((t) => centroid(t.local));
    const fitFace = (cand: ReturnType<typeof score>) => {
      const { face } = cand;
      let size = Number.isFinite(cand.px) ? cand.px : fallbackPx;
      let stretch = Number.isFinite(cand.stretch) ? Math.min(1.3, Math.max(0.75, cand.stretch)) : 1;
      const error = (px: number, st: number, stroke: number, sigma: number) => {
        const placed = sample.map((t, i) => placeWord(face, px, st, stroke, sigma, t.text, t.local.w, t.local.h, centres[i]));
        let pt = 0;
        let pp = 0;
        placed.forEach((p, i) => {
          const t = sample[i].local.data;
          for (let k = 0; k < p.data.length; k++) {
            pt += p.data[k] * t[k];
            pp += p.data[k] * p.data[k];
          }
        });
        const gain = bilevel ? 1 : Math.min(2, Math.max(0.6, pp ? pt / pp : 1));
        let err = 0;
        placed.forEach((p, i) => {
          const t = sample[i].local.data;
          for (let k = 0; k < p.data.length; k++) {
            const v = Math.min(1, gain * p.data[k]);
            err += ((bilevel ? (v >= 0.5 ? 1 : 0) : v) - t[k]) ** 2;
          }
        });
        return { gain, err };
      };
      let fit = { weight: 0, sigma: 0, gain: 1, err: Infinity };
      const fitLook = (weights: number[], sigmas: number[]) => {
        fit = { weight: 0, sigma: 0, gain: 1, err: Infinity };
        for (const weight of weights) {
          for (const sigma of bilevel ? [0] : sigmas) {
            const e = error(size, stretch, weight * size, sigma);
            if (e.err < fit.err) fit = { weight: weight * size, sigma, ...e };
          }
        }
      };
      if (sample.length) {
        fitLook(WEIGHTS, SIGMAS);
        // Fine-tune the height, keeping the words' width (blur makes letters
        // look taller than they are), then the width.
        let bestSize = { f: 1, err: fit.err };
        for (let f = 0.86; f <= 1.081; f += 0.02) {
          const e = error(size * f, stretch / f, fit.weight * f, fit.sigma);
          if (e.err < bestSize.err) bestSize = { f, err: e.err };
        }
        size *= bestSize.f;
        stretch /= bestSize.f;
        let bestStretch = { f: 1, err: Infinity };
        for (let f = 0.94; f <= 1.061; f += 0.02) {
          const e = error(size, stretch * f, fit.weight * bestSize.f, fit.sigma);
          if (e.err < bestStretch.err) bestStretch = { f, err: e.err };
        }
        stretch = Math.min(1.3, Math.max(0.75, stretch * bestStretch.f));
        // Then the look again, close to what was found.
        const w = WEIGHTS.indexOf(Math.round((fit.weight / size) * 1000) / 1000);
        const near = <T,>(xs: T[], i: number) => xs.slice(Math.max(0, i - 1), i + 2);
        fitLook(w >= 0 ? near(WEIGHTS, w) : WEIGHTS, near(SIGMAS, SIGMAS.indexOf(fit.sigma)));
      }
      return { face, size, stretch, fit, score: cand.score };
    };
    const best = candidates.map(fitFace).sort((a, b) => a.fit.err - b.fit.err)[0];
    const { face, size, stretch, fit } = best;

    // 4. The scan's own letters.
    const glyphs = new Map<string, Glyph>();
    for (const source of [line, ...others]) {
      const baseline = this.toPx([0, source.origin[1]])[1];
      for (const letter of source.letters) {
        if (!/[\p{L}\p{N}]/u.test(letter.text)) continue;
        const g = this.glyph(letter, baseline, paperLum, inkLum);
        if (!g) continue;
        const checked = this.verify(g, letter.text, face, size, stretch, fit.weight, fit.sigma);
        if (checked === null) continue;
        const had = glyphs.get(letter.text);
        if (!had || checked > had.score) glyphs.set(letter.text, { ...g, score: checked });
      }
    }

    return {
      face,
      px: size,
      stretch,
      weight: fit.weight,
      sigma: fit.sigma,
      gain: fit.gain,
      // Ink gets the same grain as the paper (the scanner's noise).
      noise: bilevel ? 0 : paperSd,
      bilevel,
      ink,
      paper,
      paperSd,
      glyphs,
      match: Math.max(0, Math.min(1, best.score)),
    };
  }

  /** Cuts one letter out of the scan, if it stands apart from its neighbours. */
  private glyph(letter: OcrLetter, baseline: number, paperLum: number, inkLum: number): Omit<Glyph, "score"> | null {
    const lb = this.boxPx(letter.bbox);
    const padX = Math.ceil((lb[2] - lb[0]) * 0.5) + 3;
    const region: Box = [Math.max(0, lb[0] - padX), Math.max(0, lb[1] - 4), Math.min(this.width, lb[2] + padX), Math.min(this.height, lb[3] + 4)];
    const cover = this.coverage(region, paperLum, inkLum);
    const { w, h } = cover;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = cover.data[i] > 0.45 ? 1 : 0;
    const { labels, list } = components(mask, w, h);
    const [lx0, ly0, lx1, ly1] = [lb[0] - region[0], lb[1] - region[1], lb[2] - region[0], lb[3] - region[1]];
    const own = new Set<number>();
    for (const c of list) {
      const overlapsX = c.x1 > lx0 + 1 && c.x0 < lx1 - 1;
      const overlapsY = c.y1 > ly0 && c.y0 < ly1;
      if (!overlapsX || !overlapsY || c.count < 3) continue;
      // A blob running into the next letter means the letters touch: can't cut it cleanly.
      if (c.x0 < lx0 - 2 || c.x1 > lx1 + 2) return null;
      own.add(c.id);
    }
    if (own.size === 0 || own.size > 3) return null;
    const mine = new Uint8Array(w * h);
    let [x0, y0, x1, y1] = [w, h, 0, 0];
    for (const c of list) {
      if (!own.has(c.id)) continue;
      x0 = Math.min(x0, c.x0);
      y0 = Math.min(y0, c.y0);
      x1 = Math.max(x1, c.x1);
      y1 = Math.max(y1, c.y1);
    }
    for (let i = 0; i < labels.length; i++) mine[i] = own.has(labels[i]) ? 1 : 0;
    const keep = dilate(mine, w, h, 2);
    const pad = 2;
    const cx0 = Math.max(0, x0 - pad);
    const cy0 = Math.max(0, y0 - pad);
    const cw = Math.min(w, x1 + pad) - cx0;
    const ch = Math.min(h, y1 + pad) - cy0;
    const alpha = plane(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (cy0 + y) * w + cx0 + x;
      alpha.data[y * cw + x] = keep[i] ? cover.data[i] : 0;
    }
    return { alpha, top: region[1] + cy0 - baseline, centre: (x0 + x1) / 2 - cx0 };
  }

  /** Checks a cut-out letter really looks like that letter in the fitted font. Returns a 0–1 score, or null. */
  private verify(g: Omit<Glyph, "score">, ch: string, face: Face, px: number, stretch: number, weight: number, sigma: number): number | null {
    const ink = inkBox(g.alpha, 0.45);
    const r = inkOf(face, px, stretch, weight, ch);
    if (!ink || !r) return null;
    const gw = ink[2] - ink[0];
    const gh = ink[3] - ink[1];
    if (gh < r.h * 0.8 || gh > r.h * 1.25) return null;
    if (Math.abs(gw - r.w) > Math.max(3, r.w * 0.4)) return null;
    // Same height above the baseline as the font's letter.
    const m = measure(face, px, ch);
    const fontTop = -m.actualBoundingBoxAscent;
    if (Math.abs(g.top + ink[1] - fontTop) > Math.max(2, px * 0.12)) return null;
    const target = crop(g.alpha, ink[0], ink[1], gw, gh);
    const s = ncc(blur(resize(r, gw, gh), Math.max(0.6, sigma)).data, blur(target, 0.6).data);
    return s >= 0.6 ? s : null;
  }

  /** Paints `text` over the line in the line's look. */
  async paint(line: ScanLine, look: LineLook, text: string, opts: PaintOptions): Promise<Painted> {
    const face: Face = opts.style
      ? { family: opts.style.generic === look.face.family.generic ? look.face.family : familyFor(opts.style.generic), bold: opts.style.bold, italic: opts.style.italic }
      : look.face;
    await loadFace(face);
    const px = look.px * opts.sizeScale;
    const sameFace = face.family === look.face.family && face.bold === look.face.bold && face.italic === look.face.italic;
    const reuse = opts.letters !== false && sameFace && Math.abs(opts.sizeScale - 1) < 0.03;
    const weight = look.weight * opts.sizeScale;
    const { stretch, sigma } = look;
    const chars = [...text];
    const advance: number[] = [];
    {
      let prefix = "";
      for (const ch of chars) {
        advance.push(measure(face, px, prefix).width * stretch);
        prefix += ch;
      }
      advance.push(measure(face, px, prefix).width * stretch);
    }

    // Where the old line's ink is.
    const lineBox = this.boxPx(line.bbox, 2);
    const oldCover = this.coverage(lineBox, lumOf(look.paper), lumOf(look.ink));
    const oldInk = inkBox(oldCover, 0.3) ?? [0, 0, lineBox[2] - lineBox[0], lineBox[3] - lineBox[1]];
    const inkLeft = lineBox[0] + oldInk[0];
    const baseline = this.toPx([0, line.origin[1]])[1];
    const first = chars.find((c) => c.trim()) ?? "x";
    const lead = measure(face, px, first).actualBoundingBoxLeft * stretch;
    const firstAt = advance[chars.indexOf(first)] ?? 0;
    const originX = inkLeft + lead - firstAt;

    // The piece of the scan that changes.
    const margin = Math.ceil(sigma * 3 + weight + 3);
    const x0 = Math.max(0, Math.floor(Math.min(lineBox[0] + oldInk[0], originX) - margin));
    const y0 = Math.max(0, Math.floor(Math.min(lineBox[1] + oldInk[1], baseline - px * 1.05) - margin));
    const x1 = Math.min(this.width, Math.ceil(Math.max(lineBox[0] + oldInk[2], originX + advance[chars.length] + px * 0.3) + margin));
    const y1 = Math.min(this.height, Math.ceil(Math.max(lineBox[1] + oldInk[3], baseline + px * 0.32) + margin));
    const w = x1 - x0;
    const h = y1 - y0;
    const window: Box = [x0, y0, x1, y1];
    const rgba = this.pixels(window);
    const cover = this.coverage(window, lumOf(look.paper), lumOf(look.ink));

    // Cover the old words with paper.
    const rand = random(hash(`${line.bbox.join()}|${text}`));
    const old = new Uint8Array(w * h);
    const inkMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const inked = cover.data[i] > 0.12;
        inkMask[i] = inked ? 1 : 0;
        const gx = x + x0;
        const gy = y + y0;
        if (inked && gx >= lineBox[0] && gx < lineBox[2] && gy >= lineBox[1] && gy < lineBox[3]) old[i] = 1;
      }
    }
    const erase = dilate(old, w, h, Math.ceil(sigma + 1));
    fillPaper(rgba, w, h, erase, inkMask, rand, look.paper, look.paperSd);

    // Draw the new words: the scan's own letters where we have them, the fitted font elsewhere.
    const reused = new Set<number>();
    if (reuse) chars.forEach((ch, i) => look.glyphs.has(ch) && reused.add(i));
    const drawn = drawPlane(w, h, (ctx) => {
      ctx.font = cssFont(face, px);
      chars.forEach((ch, i) => {
        if (!ch.trim() || reused.has(i)) return;
        ctx.setTransform(stretch, 0, 0, 1, originX - x0 + advance[i], baseline - y0);
        ctx.fillText(ch, 0, 0);
        if (weight > 0) {
          ctx.lineWidth = weight;
          ctx.strokeText(ch, 0, 0);
        }
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const thick = Math.max(1, px * 0.06);
      const width = advance[chars.length];
      if (opts.underline) ctx.fillRect(originX - x0, baseline - y0 + px * 0.12, width, thick);
      if (opts.strike) ctx.fillRect(originX - x0, baseline - y0 - px * 0.3, width, thick);
    });
    const ink = blur(drawn, sigma);
    for (let i = 0; i < ink.data.length; i++) ink.data[i] = Math.min(1, ink.data[i] * look.gain);
    for (const i of reused) {
      const g = look.glyphs.get(chars[i])!;
      const m = measure(face, px, chars[i]);
      const centre = originX + advance[i] + ((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2) * stretch;
      const gx = Math.round(centre - g.centre - x0);
      const gy = Math.round(baseline + g.top - y0);
      for (let y = 0; y < g.alpha.h; y++) {
        for (let x = 0; x < g.alpha.w; x++) {
          const tx = gx + x;
          const ty = gy + y;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const k = ty * w + tx;
          ink.data[k] = Math.max(ink.data[k], g.alpha.data[y * g.alpha.w + x]);
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
    const words: OcrWord[] = [];
    const top = this.toPage([0, baseline - px * 0.78])[1];
    const bottom = this.toPage([0, baseline + px * 0.22])[1];
    const basePt = this.toPage([0, baseline])[1];
    let i = 0;
    while (i < chars.length) {
      if (!chars[i].trim()) {
        i++;
        continue;
      }
      let j = i;
      while (j < chars.length && chars[j].trim()) j++;
      const [wx0] = this.toPage([originX + advance[i], 0]);
      const [wx1] = this.toPage([originX + advance[j], 0]);
      words.push({ text: chars.slice(i, j).join(""), bbox: [wx0, top, wx1, bottom], baseline: basePt });
      i = j;
    }
    return { png, x: x0, y: y0, width: w, height: h, box: [bx0, by0, bx1, by1], words };
  }
}

const lumOf = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

async function toPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't redraw the scan.");
  return new Uint8Array(await blob.arrayBuffer());
}
