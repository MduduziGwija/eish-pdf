// Geometry for scans that aren't upright: pages turned on their side or upside
// down, and lines that are tilted or warped. Plain numbers and arrays, no DOM.

type Pt = [number, number];
type Box = [number, number, number, number];

/** How many quarter turns clockwise turn a page so its text reads upright (0–3). */
export type Turn = 0 | 1 | 2 | 3;

/** Size of a W×H page after turning it. */
export const turnedSize = (k: Turn, W: number, H: number): [number, number] => (k % 2 ? [H, W] : [W, H]);

/** Where a point of a W×H page lands when the page is turned `k` quarter turns clockwise. */
export function turnPoint(k: Turn, [x, y]: Pt, W: number, H: number): Pt {
  switch (k) {
    case 1:
      return [H - y, x];
    case 2:
      return [W - x, H - y];
    case 3:
      return [y, W - x];
    default:
      return [x, y];
  }
}

/** The opposite of turnPoint: from the turned page back to the original W×H page. */
export function unturnPoint(k: Turn, [x, y]: Pt, W: number, H: number): Pt {
  switch (k) {
    case 1:
      return [y, H - x];
    case 2:
      return [W - x, H - y];
    case 3:
      return [W - y, x];
    default:
      return [x, y];
  }
}

/** A direction (radians, clockwise from "right", y down) in the turned page, as seen on the original page. */
export function unturnAngle(k: Turn, angle: number): number {
  return wrapAngle(angle - (k * Math.PI) / 2);
}

export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Bounding box of points. */
export function hull(points: Pt[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const corners = ([x0, y0, x1, y1]: Box): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Rotates a point about a centre, clockwise by `angle` radians (y down). */
export function rotateAbout([x, y]: Pt, [cx, cy]: Pt, angle: number): Pt {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}

/** Turns an RGBA image `k` quarter turns clockwise. */
export function turnRgba(rgba: Uint8ClampedArray, w: number, h: number, k: Turn): { data: Uint8ClampedArray; w: number; h: number } {
  if (k === 0) return { data: rgba, w, h };
  const [tw, th] = turnedSize(k, w, h);
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = turnPoint(k, [x, y], w - 1, h - 1);
      const s = (y * w + x) * 4;
      const t = (v * tw + u) * 4;
      out[t] = rgba[s];
      out[t + 1] = rgba[s + 1];
      out[t + 2] = rgba[s + 2];
      out[t + 3] = rgba[s + 3];
    }
  }
  return { data: out, w: tw, h: th };
}

// --- Affine maps ------------------------------------------------------------------

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the canvas convention). */
export type Aff = [number, number, number, number, number, number];

export const IDENTITY: Aff = [1, 0, 0, 1, 0, 0];

export const applyAff = ([a, b, c, d, e, f]: Aff, [x, y]: Pt): Pt => [a * x + c * y + e, b * x + d * y + f];

/** The map that does `first`, then `then`. */
export function composeAff(then: Aff, first: Aff): Aff {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = then;
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1, a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2];
}

export function invertAff([a, b, c, d, e, f]: Aff): Aff {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Pixel positions: where a pixel (x, y) of an image turned `k` quarter turns came from, as a map from the turned image to the original (Wo×Ho). */
export function unturnPixelsAff(k: Turn, Wo: number, Ho: number): Aff {
  switch (k) {
    case 1:
      return [0, -1, 1, 0, 0, Ho];
    case 2:
      return [-1, 0, 0, -1, Wo, Ho];
    case 3:
      return [0, 1, -1, 0, Wo, 0];
    default:
      return IDENTITY;
  }
}

/** Whether a map only moves by whole pixels or quarter turns (so no smoothing is needed). */
export function isExactAff([a, b, c, d, e, f]: Aff): boolean {
  const whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
  return [a, b, c, d].every(whole) && whole(e) && whole(f);
}

// --- Text lines ---------------------------------------------------------------------

/**
 * The four corners of a line's box when its words are level in their own frame
 * and the line is tilted by `angle` about the centre of `box`.
 */
export function tiltedQuad(box: Box, angle: number): Pt[] {
  const centre: Pt = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  return corners(box).map((p) => rotateAbout(p, centre, angle));
}

/** Small tilts are scanner noise: snap them to level. */
export const SNAP = (0.25 * Math.PI) / 180;
export const snapAngle = (a: number) => (Math.abs(a) < SNAP ? 0 : a);

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/**
 * Tilts to use for lines: each line's own tilt when it's a long line (so a warped
 * page follows its curve), and the page's usual tilt for short ones, whose
 * baselines are too short to measure well.
 */
export function steadyAngles(lines: { angle: number; length: number; size: number }[]): number[] {
  const long = lines.filter((l) => l.length >= l.size * 12).map((l) => l.angle);
  const usual = long.length >= 2 ? median(long) : 0;
  return lines.map((l) => {
    if (l.length >= l.size * 12) return snapAngle(Math.max(-0.35, Math.min(0.35, l.angle)));
    // Short lines: the page's usual tilt, unless it's far from this line's own.
    return snapAngle(Math.abs(l.angle - usual) < 0.1 ? l.angle : usual);
  });
}

/** How much of a page's text OCR read with confidence: the number of letters in confident words. */
export function readQuality(words: { text: string; confidence: number }[]): number {
  return words.reduce((n, w) => n + (w.confidence >= 70 ? [...w.text.trim()].filter((c) => /[\p{L}\p{N}]/u.test(c)).length : 0), 0);
}

/** The box a tilted line's words sit in: their corners, level in the line's own frame, then tilted back. Padded a little. */
export function lineQuad(wordBoxes: Box[], angle: number, pad = 0): Pt[] {
  const all = hull(wordBoxes.flatMap(corners));
  const centre: Pt = [(all[0] + all[2]) / 2, (all[1] + all[3]) / 2];
  const level = hull(wordBoxes.flatMap((b) => corners(b).map((p) => rotateAbout(p, centre, -angle))));
  return corners([level[0] - pad, level[1] - pad, level[2] + pad, level[3] + pad]).map((p) => rotateAbout(p, centre, angle));
}

/** Turns a one-byte-per-pixel mask `k` quarter turns clockwise. */
export function turnBytes(data: Uint8Array, w: number, h: number, k: Turn): { data: Uint8Array; w: number; h: number } {
  if (k === 0) return { data, w, h };
  const [tw, th] = turnedSize(k, w, h);
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = turnPoint(k, [x, y], w - 1, h - 1);
      out[v * tw + u] = data[y * w + x];
    }
  }
  return { data: out, w: tw, h: th };
}
