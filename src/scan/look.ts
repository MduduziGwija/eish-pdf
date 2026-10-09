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
// 5. Paints: the old words are covered with paper borrowed from around them
//    (table rules and neighbouring cells are left alone), and the new words are
//    drawn in the fitted look. Handwriting gets a little natural wobble, so no
//    two letters come out identical.
//
// Pages turned on their side or upside down are turned upright first, and a
// tilted or warped line is straightened into its own little view, redrawn there,
// and the result is tilted back into the scan's own pixels.
import type { OcrLetter } from "../core/ocrwords";
import type { PixelMatrix } from "../core/scanimage";
import type { OcrWord, Rgb } from "../core/text";
import { bundledFamilies, cssFont, facesOf, familyByCss, familyFor, loadFace, loadFaces, myFamilies, SCOUTS, type Face, type Family, type Generic } from "./fonts";
import { applyAff, composeAff, corners, hull, IDENTITY, isExactAff, median, rotateAbout, turnPoint, turnRgba, unturnAngle, unturnPixelsAff, unturnPoint, type Aff, type Turn } from "./orient";
import { blur, components, crop, dilate, fillPaper, findRules, gaussian, hash, inkBox, ncc, plane, random, resize, type Plane } from "./pixels";

type Box = [number, number, number, number];

/** A line of a scanned page, as OCR read it, in the turned-upright page's coordinates (points). */
export interface ScanLine {
  text: string;
  bbox: Box;
  origin: [number, number];
  size: number;
  words: OcrWord[];
  letters: OcrLetter[];
  /** Tilt of the baseline, radians clockwise from level. */
  angle: number;
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
  /** The straightened view of the line this look was measured in. */
  view: View;
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
  /** Move the new text this far (page points, as seen on the page) from where the old line was. */
  offset?: [number, number];
  /** Boxes of other lines' words (the frame's points), which unread-ink clean-up must leave alone. */
  avoid?: Box[];
  /** Paint without wiping the old line: the text is a new line (below a paragraph) placed with `offset`. */
  noErase?: boolean;
}

/** A redrawn piece of scan: pixels in the scan picture's own frame, and where it sits on the page. */
export interface Painted {
  png: Uint8Array;
  /** Top-left in the scan picture's pixels, and size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where it goes on the page (points). */
  box: Box;
  /** The new words, for the invisible text layer (page points). */
  words: OcrWord[];
}

/** What a Frame paints: the same, in the frame's own pixels and points. */
type FramePainted = Painted;

/** Shared by every line of a scan: the fonts that fitted lately, so the next line starts there. */
export interface FontSearch {
  recent: Family[];
  bestScore: number;
  /** Told what's happening while a long search runs. */
  status?: (text: string) => void;
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

const lumOf = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/**
 * Upright, level pixels and where they sit in "points": the part that measures and
 * redraws one line. (The turning and straightening around it is in ScanPicture.)
 */
class Frame {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly rgba: Uint8ClampedArray,
    readonly matrix: PixelMatrix,
    readonly inPlace: boolean,
    private readonly search: FontSearch,
  ) {}

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

  private frameRules?: Uint8Array;

  /** Whether a ruled line (table border, underline) touches this box, or comes within a pixel or two of it. */
  touchesRule(box: Box): boolean {
    if (!this.frameRules) {
      const sample: number[] = [];
      for (let i = 0; i < this.width * this.height; i += 37) sample.push(0.299 * this.rgba[i * 4] + 0.587 * this.rgba[i * 4 + 1] + 0.114 * this.rgba[i * 4 + 2]);
      sample.sort((a, b) => a - b);
      const [paperLum, inkLum] = [sample[Math.floor(sample.length * 0.85)] ?? 255, sample[Math.floor(sample.length * 0.02)] ?? 0];
      this.frameRules = findRules(this.coverage([0, 0, this.width, this.height], paperLum, inkLum), Math.max(8, 28 / this.matrix[0]), 1, 0.18);
    }
    const [x0, y0, x1, y1] = [Math.max(0, box[0] - 2), Math.max(0, box[1] - 2), Math.min(this.width, box[2] + 2), Math.min(this.height, box[3] + 2)];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (this.frameRules[y * this.width + x]) return true;
    return false;
  }

  /** Ruled lines (table borders, underlines, form boxes) in a region: ink in long straight runs. */
  rulesIn(box: Box, sizePx: number, paperLum: number, inkLum: number): Uint8Array {
    const m = Math.ceil(sizePx * 2.4);
    const big: Box = [Math.max(0, box[0] - m), Math.max(0, box[1] - m), Math.min(this.width, box[2] + m), Math.min(this.height, box[3] + m)];
    const rules = findRules(this.coverage(big, paperLum, inkLum), Math.max(6, sizePx * 2.2), 1, 0.18);
    const [w, h, bw] = [box[2] - box[0], box[3] - box[1], big[2] - big[0]];
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = rules[(y + box[1] - big[1]) * bw + x + box[0] - big[0]];
    return out;
  }

  async analyse(line: ScanLine, others: ScanLine[], straightened = false): Promise<LineLook> {
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
    // Table borders and form boxes crossing the line aren't part of its writing.
    const sizePx = line.size / this.matrix[3];
    const ruled = this.rulesIn(region, sizePx, paperLum, inkLum);
    for (let i = 0; i < ruled.length; i++) if (ruled[i]) cover.data[i] = 0;
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
        // Only the ink that belongs to this word: blobs centred inside the word's own box (not a neighbour's edge).
        const own = this.boxPx(w.bbox);
        const inner: Box = [own[0] - b[0], own[1] - b[1], own[2] - b[0], own[3] - b[1]];
        const solid = new Uint8Array(local.w * local.h);
        for (let i = 0; i < solid.length; i++) solid[i] = local.data[i] > 0.35 ? 1 : 0;
        const { labels, list } = components(solid, local.w, local.h);
        const mine = new Set(list.filter((c) => c.count >= 3 && c.cx >= inner[0] && c.cx <= inner[2] && c.cy >= inner[1] && c.cy <= inner[3]).map((c) => c.id));
        if (mine.size && mine.size < list.length) for (let i = 0; i < labels.length; i++) if (labels[i] && !mine.has(labels[i])) local.data[i] = 0;
        const box = inkBox(local, 0.35);
        if (!box || box[3] - box[1] < 6 || w.text.length < 2) return null;
        return { text: w.text, target: crop(local, box[0], box[1], box[2] - box[0], box[3] - box[1]), local, ink: box };
      })
      .filter((t): t is NonNullable<typeof t> => !!t)
      .sort((a, b) => b.target.w - a.target.w)
      .slice(0, 8);

    const fallbackPx = sizePx;
    const score = (face: Face, use: typeof targets = targets) => {
      let total = 0;
      let weights = 0;
      const sizes: number[] = [];
      const stretches: number[] = [];
      for (const t of use) {
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
    type Scored = ReturnType<typeof score>;
    const byScore = (a: Scored, b: Scored) => b.score - a.score;
    const regularOf = (f: Family): Face => ({ family: f, bold: false, italic: false });

    let candidates: Scored[];
    if (targets.length) {
      const state = this.search;
      let ranked: Scored[] = [];
      let quick = false;
      // The next line of a scan is usually in the same font as the last one: try those first.
      // A line with little to measure (one short word) says too little about its font: stay with the page's fonts.
      const little = targets.length < 2 || targets.reduce((n, t) => n + t.text.length, 0) < 12;
      if (state.recent.length) {
        await loadFaces(state.recent.map(regularOf));
        ranked = state.recent.map((f) => score(regularOf(f))).sort(byScore);
        quick = little || ranked[0].score >= state.bestScore - 0.12;
      }
      if (!quick) {
        // Scouts first: which kinds of writing (serif, sans, typewriter, handwriting, headline) look closest?
        const scouts = SCOUTS.map(regularOf);
        await loadFaces(scouts);
        const scouted = scouts.map((f) => score(f));
        const byKind = new Map<Generic, number>();
        for (const sc of scouted) byKind.set(sc.face.family.generic, Math.max(byKind.get(sc.face.family.generic) ?? -1, sc.score));
        const top = Math.max(...byKind.values());
        // Headline and decorative fonts are only for big text.
        if (line.size < 20) byKind.delete("display");
        const kinds = new Set([...byKind].filter(([, v]) => v >= top - 0.08).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k));
        // Then every font of those kinds (and the ones from this computer), the widest words first.
        const families = [...bundledFamilies().filter((f) => kinds.has(f.generic)), ...myFamilies()];
        state.status?.(`Trying ${families.length} fonts…`);
        await loadFaces(families.map(regularOf), (p) => state.status?.(`Trying ${families.length} fonts… ${Math.round(p * 100)}%`));
        const widest = targets.slice(0, 3);
        const firstPass = families.map((f) => score(regularOf(f), widest)).sort(byScore).slice(0, 24);
        // A semi-bold scan fits a family's bold better than its regular: try both.
        const bolds = firstPass.flatMap((r) => facesOf(r.face.family).filter((f) => f.bold && !f.italic));
        await loadFaces(bolds);
        ranked = [...firstPass.map((r) => score(r.face)), ...bolds.map((f) => score(f))].sort(byScore);
      }
      // Then the styles (bold, italic) of the best few.
      const key = (f: Face) => `${f.family.css}/${f.bold}/${f.italic}`;
      const have = new Set(ranked.map((r) => key(r.face)));
      const styled = ranked.slice(0, 3).flatMap((r) => facesOf(r.face.family).slice(1)).filter((f) => !have.has(key(f)));
      await loadFaces(styled);
      candidates = [...ranked.slice(0, 3), ...styled.map((f) => score(f))].sort(byScore).slice(0, 3);
      if (!quick || candidates[0].score > state.bestScore) state.bestScore = candidates[0].score;
      state.recent = [...new Map([...candidates, ...ranked].slice(0, 8).map((r) => [r.face.family.css, r.face.family])).values()].slice(0, 6);
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
      const err = sample.length ? error(pen) * (1 + 10 * Math.abs(Math.log(pen.stretch))) : 0;
      return { pen, err, score: cand.score };
    };
    const best = candidates.map(fitFace).sort((a, b) => a.err - b.err)[0];
    const { pen } = best;
    // Last check, over the whole line: its overall height should match the scan's.
    // (A few short handwritten words can mislead the size.)
    const lineInk = inkBox(cover, 0.35);
    const drawnLine = inkOf(pen, line.text, sigma);
    if (lineInk && drawnLine && line.words.length >= 2 && !straightened) {
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
      view: undefined as unknown as View,
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
    // A letter touching a table border can't be cut out cleanly.
    if (this.touchesRule(lb)) return null;
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
    if (this.touchesRule(wb)) return null;
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
    const drawn = blur(resize(r, gw, gh), Math.max(0.6, sigma));
    const s = ncc(drawn.data, blur(target, 0.6).data);
    if (s < minScore) return null;
    // A bold letter in a regular line (or the other way round) would stick out: compare stroke thickness.
    if (!hand) {
      const [fromScan, fromFont] = [strokeWidth(threshold(target)), strokeWidth(threshold(drawn))];
      if (Number.isFinite(fromScan) && Number.isFinite(fromFont) && (fromScan > fromFont * 1.3 || fromScan < fromFont * 0.7)) return null;
    }
    return s;
  }

  /** Paints `text` over the line in the line's look. */
  async paint(line: ScanLine, look: LineLook, text: string, opts: PaintOptions): Promise<FramePainted> {
    const chosen = opts.family ? familyByCss(opts.family) : undefined;
    const family = chosen ?? (opts.style ? (opts.style.generic === look.face.family.generic ? look.face.family : familyFor(opts.style.generic)) : look.face.family);
    const face: Face = { family, bold: opts.style?.bold ?? look.face.bold, italic: opts.style?.italic ?? look.face.italic };
    await loadFace(face);
    const sameFace = face.family === look.face.family && face.bold === look.face.bold && face.italic === look.face.italic;
    // The scan's own letters sit next to drawn ones, so they only help when the font matches closely (or it's handwriting).
    const reuse = opts.letters !== false && sameFace && Math.abs(opts.sizeScale - 1) < 0.03 && (look.hand || look.match >= 0.7);
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

    // Where the old line's writing is (not table rules or neighbouring cells), and where the new text starts.
    const lineBox = this.boxPx(line.bbox, 2);
    const wordPad = Math.ceil(pen.px * 0.15 + sigma * 2);
    const wordBoxes = line.words.length
      ? line.words.map((wd) => {
          const b = this.boxPx(wd.bbox);
          return [b[0] - wordPad, b[1] - 1 - Math.ceil(sigma), b[2] + wordPad, b[3] + 1 + Math.ceil(sigma)] as Box;
        })
      : [lineBox];
    const inWords = (gx: number, gy: number) => wordBoxes.some((b) => gx >= b[0] && gx < b[2] && gy >= b[1] && gy < b[3]);
    const oldCover = this.coverage(lineBox, lumOf(look.paper), lumOf(look.ink));
    const lineRules = this.rulesIn(lineBox, pen.px, lumOf(look.paper), lumOf(look.ink));
    const lw = lineBox[2] - lineBox[0];
    const writing = plane(lw, lineBox[3] - lineBox[1]);
    for (let i = 0; i < writing.data.length; i++) {
      const [lx, ly] = [i % lw, Math.floor(i / lw)];
      writing.data[i] = !lineRules[i] && inWords(lineBox[0] + lx, lineBox[1] + ly) ? oldCover.data[i] : 0;
    }
    const oldInk = inkBox(writing, 0.3) ?? [0, 0, lineBox[2] - lineBox[0], lineBox[3] - lineBox[1]];
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
    const original = rgba.slice();
    const cover = this.coverage([x0, y0, x1, y1], lumOf(look.paper), lumOf(look.ink));
    const rules = this.rulesIn([x0, y0, x1, y1], pen.px, lumOf(look.paper), lumOf(look.ink));

    // Cover the old words with paper (only inside the words' own boxes).
    const old = new Uint8Array(w * h);
    const inkMask = new Uint8Array(w * h);
    const halo = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        const inked = cover.data[i] > 0.12;
        inkMask[i] = inked ? 1 : 0;
        // The old words' whole area goes (not just the ink: the faint halo a JPEG leaves around letters would show as a ghost).
        if (inWords(xx + x0, y + y0)) old[i] = 1;
        // Pixels not to learn the paper from: ink and its soft edge.
        halo[i] = cover.data[i] > 0.04 ? 1 : 0;
      }
    }
    // OCR sometimes skips words (messy handwriting especially). Old ink on this
    // line that the new text would land on goes too, whole blobs at a time, so
    // nothing old shows through or under the new words.
    if (!opts.noErase) {
      const solid = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) solid[i] = cover.data[i] > 0.45 ? 1 : 0;
      const { labels, list } = components(solid, w, h);
      const span0 = originX + (placedWords[0]?.x0 ?? 0) - x0;
      const span1 = originX + total - x0;
      const band0 = lineBox[1] - y0;
      const band1 = lineBox[3] - y0;
      // Blobs that are mostly table rules are never "writing".
      const ruleShare = new Map<number, number>();
      for (let i = 0; i < labels.length; i++) if (labels[i] && rules[i]) ruleShare.set(labels[i], (ruleShare.get(labels[i]) ?? 0) + 1);
      // Other lines' words (a neighbouring cell the new text runs into) are left as they are.
      const keepOut = (opts.avoid ?? []).map((b) => {
        const px = this.boxPx(b);
        return [px[0] - x0, px[1] - y0, px[2] - x0, px[3] - y0] as Box;
      });
      const inKeepOut = (c: { cx: number; cy: number }) => keepOut.some((b) => c.cx >= b[0] && c.cx <= b[2] && c.cy >= b[1] && c.cy <= b[3]);
      const writingBlob = (c: { id: number; count: number; cx: number; cy: number }) => (ruleShare.get(c.id) ?? 0) / c.count < 0.35 && !inKeepOut(c);
      const hit = new Set<number>();
      for (const c of list) {
        const inBand = Math.min(c.y1, band1) - Math.max(c.y0, band0);
        if (writingBlob(c) && c.x1 > span0 && c.x0 < span1 && inBand >= (c.y1 - c.y0) * 0.5) hit.add(c.id);
      }
      // Finish words that were started: take neighbouring blobs on the line closer than a word gap.
      const gap = pen.px * 0.3;
      let grew = hit.size > 0;
      while (grew) {
        grew = false;
        for (const c of list) {
          if (hit.has(c.id) || !writingBlob(c)) continue;
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
    // The soft edge of the old letters goes too, but not neighbouring ink.
    if (opts.noErase) old.fill(0);
    const erase = dilate(old, w, h, Math.ceil(sigma + 1));
    for (let i = 0; i < erase.length; i++) if (erase[i] && inkMask[i] && !old[i]) erase[i] = 0;
    fillPaper(rgba, w, h, erase, halo, rand, look.paper, look.paperSd);
    // Table rules that ran through the words stay as they were.
    for (let i = 0; i < rules.length; i++) if (rules[i] && erase[i]) rgba.set(original.subarray(i * 4, i * 4 + 4), i * 4);

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
      // Unchanged pixels stay see-through, so neighbouring patches (the lines of a paragraph) don't overwrite each other.
      rgba[i * 4 + 3] = erase[i] || a > 0.003 ? 255 : 0;
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

/** A straightened piece of the scan around one line. */
export interface View {
  frame: Frame;
  /** The line as it is in the straightened view. */
  line: ScanLine;
  /** How much the real line is tilted (radians), and the point (turned-page points) it was straightened about. */
  angle: number;
  centre: [number, number];
  /** View pixels → pixels of the upright picture. */
  toUpright: Aff;
  /** The line as it is in the upright picture, and how long (points) the text can be before the view must grow. */
  source: ScanLine;
  reach: number;
}

/** Biggest view we'll make, in pixels. */
const MAX_VIEW = 8e6;

/**
 * A page's scan, with edits made on it. The page may be turned on its side or
 * upside down (`turn`), and its lines may be tilted or warped: lines are read in
 * the turned-upright page, a tilted line is straightened in a small view of its
 * own, and the redrawn piece is carried back into the scan's own pixels.
 */
export class ScanPicture {
  /** The pixels are the page's own picture, so edits can be written back into it (otherwise edits go on top). */
  readonly inPlace: boolean;
  /** The scan picture's own size, in pixels. */
  readonly width: number;
  readonly height: number;
  private readonly upright: Frame;
  /** Upright-picture pixels → the scan's own pixels. */
  private readonly toOwn: Aff;
  private readonly looks = new Map<string, Promise<LineLook>>();
  private readonly search: FontSearch = { recent: [], bestScore: 0 };

  private constructor(
    own: { width: number; height: number; matrix: PixelMatrix },
    upright: { rgba: Uint8ClampedArray; width: number; height: number },
    readonly turn: Turn,
    readonly page: [number, number],
    inPlace: boolean,
  ) {
    this.width = own.width;
    this.height = own.height;
    this.inPlace = inPlace;
    this.ownMatrix = own.matrix;
    this.toOwn = unturnPixelsAff(turn, own.width, own.height);
    // Where the upright picture's pixels sit in the turned page's points.
    const toTurnedPage = ([u, v]: [number, number]) => {
      const [x, y] = applyAff(this.toOwn, [u, v]);
      const [a, , , d, e, f] = own.matrix;
      return turnPoint(turn, [a * x + e, d * y + f], page[0], page[1]);
    };
    const t0 = toTurnedPage([0, 0]);
    const t1 = toTurnedPage([1, 1]);
    this.upright = new Frame(upright.width, upright.height, upright.rgba, [t1[0] - t0[0], 0, 0, t1[1] - t0[1], t0[0], t0[1]], inPlace, this.search);
  }

  private readonly ownMatrix: PixelMatrix;

  /**
   * `matrix`: where the picture's pixels sit on the page (points). `inPlace`: the
   * pixels are the page's own scan picture. `turn`: quarter turns clockwise that
   * make its text upright. `page`: the page's size in points.
   */
  static async fromPng(png: Uint8Array, matrix: PixelMatrix, inPlace: boolean, turn: Turn, page: [number, number]): Promise<ScanPicture> {
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
    const turned = turnRgba(data, width, height, turn);
    return new ScanPicture({ width, height, matrix }, { rgba: turned.data, width: turned.w, height: turned.h }, turn, page, inPlace);
  }

  private allLines: ScanLine[] = [];

  /** Every line read on the page: words of other lines are kept out of clean-up when new text runs into them. */
  setLines(lines: ScanLine[]): void {
    this.allLines = lines;
  }

  /** Told what's going on during a long font search. */
  set onStatus(fn: ((text: string) => void) | undefined) {
    this.search.status = fn;
  }

  /** The straightened view of a line (the upright picture itself when the line is level), at least `reach` points long past the line's start. */
  private viewOf(line: ScanLine, reach = 0): View {
    const level: View = { frame: this.upright, line, angle: 0, centre: [0, 0], toUpright: IDENTITY, source: line, reach: Infinity };
    const [su, sv, e, f] = [this.upright.matrix[0], this.upright.matrix[3], this.upright.matrix[4], this.upright.matrix[5]];
    const theta = line.angle;
    if (Math.abs(theta) === 0 || Math.abs(su / sv - 1) > 0.02) return level;
    const bb = line.bbox;
    const centre: [number, number] = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    const length = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);
    // Room for new text that's longer than the old line: the view reaches as far past the line's start as the text does.
    const span = Math.max(length, 2 * reach - length);
    const w = Math.ceil((span + line.size * 6) / su);
    const h = Math.ceil((line.size * 5.6) / sv);
    if (w * h > MAX_VIEW) return level;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const [cu, cv] = [(centre[0] - e) / su, (centre[1] - f) / sv];
    const { rgba, width: uw, height: uh } = this.upright;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let vy = 0; vy < h; vy++) {
      for (let vx = 0; vx < w; vx++) {
        const dx = vx + 0.5 - w / 2;
        const dy = vy + 0.5 - h / 2;
        // Bilinear sample of the upright picture, edges repeated.
        const ux = Math.min(uw - 1, Math.max(0, cu + cos * dx - sin * dy - 0.5));
        const uy = Math.min(uh - 1, Math.max(0, cv + sin * dx + cos * dy - 0.5));
        const x0 = Math.floor(ux);
        const y0 = Math.floor(uy);
        const x1 = Math.min(uw - 1, x0 + 1);
        const y1 = Math.min(uh - 1, y0 + 1);
        const tx = ux - x0;
        const ty = uy - y0;
        const o = (vy * w + vx) * 4;
        for (let k = 0; k < 4; k++) {
          const top = rgba[(y0 * uw + x0) * 4 + k] * (1 - tx) + rgba[(y0 * uw + x1) * 4 + k] * tx;
          const bottom = rgba[(y1 * uw + x0) * 4 + k] * (1 - tx) + rgba[(y1 * uw + x1) * 4 + k] * tx;
          out[o + k] = top * (1 - ty) + bottom * ty;
        }
      }
    }
    // The view's own points are the turned page's points, with the line level.
    const matrix: PixelMatrix = [su, 0, 0, sv, centre[0] - (su * w) / 2, centre[1] - (sv * h) / 2];
    const level0 = (p: [number, number]) => rotateAbout(p, centre, -theta);
    // A tilted word's box is the outline of its tilted shape: undo that to get the word's own size.
    const c = Math.abs(cos);
    const sn = Math.abs(sin);
    const den = c * c - sn * sn;
    const box = (b: Box): Box => {
      const [bw, bh] = [b[2] - b[0], b[3] - b[1]];
      const [len, thick] = [Math.max(1, (bw * c - bh * sn) / den), Math.max(1, (bh * c - bw * sn) / den)];
      const mid = level0([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
      return [mid[0] - len / 2, mid[1] - thick / 2, mid[0] + len / 2, mid[1] + thick / 2];
    };
    const straightWords = line.words.map((wd) => ({ ...wd, bbox: box(wd.bbox), baseline: level0([wd.bbox[0], wd.baseline])[1] }));
    const straight: ScanLine = {
      ...line,
      angle: 0,
      bbox: straightWords.length ? hull(straightWords.flatMap((wd) => corners(wd.bbox))) : box(line.bbox),
      origin: level0(line.origin),
      words: straightWords,
      letters: line.letters.map((l) => ({ ...l, bbox: box(l.bbox) })),
    };
    const toUpright: Aff = [cos, sin, -sin, cos, cu - (cos * w) / 2 + (sin * h) / 2, cv - (sin * w) / 2 - (cos * h) / 2];
    return { frame: new Frame(w, h, out, matrix, this.inPlace, this.search), line: straight, angle: theta, centre, toUpright, source: line, reach: Math.max(length, reach) };
  }

  /** Works out (once per line) how the line looks. `others`: nearby lines whose letters and words may be reused (level lines only). */
  look(line: ScanLine, others: ScanLine[] = []): Promise<LineLook> {
    const key = line.bbox.join(",");
    let found = this.looks.get(key);
    if (!found) {
      found = (async () => {
        const view = this.viewOf(line);
        const look = await view.frame.analyse(view.line, view.angle === 0 ? others.filter((o) => o.angle === 0) : [], view.angle !== 0);
        look.view = view;
        return look;
      })();
      found.catch(() => this.looks.delete(key));
      this.looks.set(key, found);
    }
    return found;
  }

  /** Gets the font for a look ready (downloads it if needed), so `textWidth` can answer at once. */
  async prepare(look: LineLook, family?: string): Promise<void> {
    await loadFace(this.faceFor(look, family));
  }

  private faceFor(look: LineLook, family?: string): Face {
    const chosen = family ? familyByCss(family) : undefined;
    return chosen ? { family: chosen, bold: look.face.bold, italic: look.face.italic } : look.face;
  }

  /** How wide `text` comes out in the line's look, in points (for wrapping a paragraph). Call `prepare` first. */
  textWidth(look: LineLook, text: string, family?: string): number {
    return measure(this.faceFor(look, family), look.px, text).width * look.stretch * this.upright.matrix[0];
  }

  /** Paints `text` over the line in the line's look, and returns it in the scan picture's own pixels. */
  async paint(_line: ScanLine, look: LineLook, text: string, opts: PaintOptions): Promise<Painted> {
    const [W, H] = this.page;
    // A straightened view is sized for the old line: if the new text is longer, make the view bigger.
    let view = look.view;
    if (view.angle !== 0) {
      const lengthPt = measure(look.face, look.px, text).width * look.stretch * this.upright.matrix[0] * 1.15;
      if (lengthPt > view.reach) view = look.view = this.viewOf(view.source, lengthPt);
    }
    // A move, as seen on the page → in the turned page → along the straightened line.
    let offset: [number, number] | undefined;
    if (opts.offset) {
      const [dx, dy] = opts.offset;
      const turned: [number, number] = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][this.turn] as [number, number];
      offset = rotateAbout(turned, [0, 0], -view.angle);
    }
    // Other lines' words, in the straightened view's points.
    const avoid = this.allLines
      .filter((l) => l.bbox.some((v, i) => Math.abs(v - view.source.bbox[i]) > 0.01))
      .flatMap((l) => l.words.map((wd) => wd.bbox))
      .map((b): Box => (view.angle ? hull(corners(b).map((p) => rotateAbout(p, view.centre, -view.angle))) : b));
    const framed = await view.frame.paint(view.line, look, text, { ...opts, offset, avoid });

    // The painted piece's pixels → the scan's own pixels.
    const toOwn = composeAff(this.toOwn, composeAff(view.toUpright, [1, 0, 0, 1, framed.x, framed.y]));
    const patch = await warpPatch(framed.png, toOwn, [framed.width, framed.height], this.width, this.height);

    // Where it sits on the page.
    const [a, , , d, e, f] = this.ownMatrix;
    const onPage = ([x, y]: [number, number]): [number, number] => [a * x + e, d * y + f];
    const box = hull(corners([patch.x, patch.y, patch.x + patch.width, patch.y + patch.height]).map(onPage));

    // The new words, back on the page: from the straightened view, to the turned page, to the page.
    const pageAngle = unturnAngle(this.turn, view.angle);
    const level = Math.abs(pageAngle) < 1e-6;
    const toPage = (p: [number, number]): [number, number] => unturnPoint(this.turn, view.angle ? rotateAbout(p, view.centre, view.angle) : p, W, H);
    const words: OcrWord[] = framed.words.map((wd) => {
      const [x0, y0, x1, y1] = wd.bbox;
      const origin = toPage([x0, wd.baseline]);
      return {
        text: wd.text,
        bbox: hull(corners(wd.bbox).map(toPage)),
        baseline: origin[1],
        ...(level ? {} : { tilt: { origin, length: x1 - x0, height: y1 - y0, angle: pageAngle } }),
      };
    });
    return { png: patch.png, x: patch.x, y: patch.y, width: patch.width, height: patch.height, box, words };
  }
}

/** Carries a painted piece (a PNG with see-through parts) into the scan's own pixels with the map `aff`. */
async function warpPatch(png: Uint8Array, aff: Aff, size: [number, number], Wo: number, Ho: number): Promise<{ png: Uint8Array; x: number; y: number; width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  const [bx0, by0, bx1, by1] = hull(corners([0, 0, size[0], size[1]]).map((p) => applyAff(aff, p)));
  const x0 = Math.max(0, Math.floor(bx0 + 1e-6));
  const y0 = Math.max(0, Math.floor(by0 + 1e-6));
  const x1 = Math.min(Wo, Math.ceil(bx1 - 1e-6));
  const y1 = Math.min(Ho, Math.ceil(by1 - 1e-6));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  // Whole-pixel moves and quarter turns copy exactly; anything else is smoothed.
  ctx.imageSmoothingEnabled = !isExactAff(aff);
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(aff[0], aff[1], aff[2], aff[3], aff[4] - x0, aff[5] - y0);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't redraw the scan.");
  return { png: new Uint8Array(await blob.arrayBuffer()), x: x0, y: y0, width: w, height: h };
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
