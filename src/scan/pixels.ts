// Small image helpers for redrawing scanned text. Plain arrays, no DOM, so
// they're easy to test.

/** A single-channel image (ink coverage 0–1, or brightness). */
export interface Plane {
  w: number;
  h: number;
  data: Float32Array;
}

export const plane = (w: number, h: number, data = new Float32Array(w * h)): Plane => ({ w, h, data });

/** Gaussian blur (separable), clamped at the edges. */
export function blur(p: Plane, sigma: number): Plane {
  if (sigma < 0.2) return plane(p.w, p.h, p.data.slice());
  const r = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const { w, h } = p;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += kernel[k + r] * p.data[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += kernel[k + r] * tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = v;
    }
  }
  return plane(w, h, out);
}

/** Normalised cross-correlation of two same-sized arrays: 1 = same shape, 0 = unrelated. */
export function ncc(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Bounding box [x0, y0, x1, y1) of the values above `threshold`, or null if none. */
export function inkBox(p: Plane, threshold = 0.35): [number, number, number, number] | null {
  let x0 = p.w;
  let y0 = p.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (p.data[y * p.w + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

export function crop(p: Plane, x0: number, y0: number, w: number, h: number): Plane {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= p.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx >= 0 && sx < p.w) out[y * w + x] = p.data[sy * p.w + sx];
    }
  }
  return plane(w, h, out);
}

/** Resamples a plane to a new size (bilinear). */
export function resize(p: Plane, w: number, h: number): Plane {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(p.h - 1, Math.max(0, ((y + 0.5) * p.h) / h - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(p.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(p.w - 1, Math.max(0, ((x + 0.5) * p.w) / w - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(p.w - 1, x0 + 1);
      const tx = fx - x0;
      const top = p.data[y0 * p.w + x0] * (1 - tx) + p.data[y0 * p.w + x1] * tx;
      const bottom = p.data[y1 * p.w + x0] * (1 - tx) + p.data[y1 * p.w + x1] * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return plane(w, h, out);
}

export interface Component {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
  /** Mean x, y. */
  cx: number;
  cy: number;
}

/** Labels connected blobs (8-connected) of a 0/1 mask. Labels start at 1; 0 = background. */
export function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; list: Component[] } {
  const labels = new Int32Array(w * h);
  const list: Component[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const c: Component = { id: list.length + 1, x0: w, y0: h, x1: 0, y1: 0, count: 0, cx: 0, cy: 0 };
    labels[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j - x) / w;
      c.count++;
      c.cx += x;
      c.cy += y;
      if (x < c.x0) c.x0 = x;
      if (y < c.y0) c.y0 = y;
      if (x + 1 > c.x1) c.x1 = x + 1;
      if (y + 1 > c.y1) c.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (mask[k] && !labels[k]) {
            labels[k] = c.id;
            stack.push(k);
          }
        }
      }
    }
    c.cx /= c.count;
    c.cy /= c.count;
    list.push(c);
  }
  return { labels, list };
}

/** Grows a 0/1 mask by `r` pixels (square). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !on; k++) on = mask[y * w + k];
      rows[y * w + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !on; k++) on = rows[k * w + x];
      out[y * w + x] = on;
    }
  }
  return out;
}

/** A small, seeded random number generator, so a redrawn line looks the same every time. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normally distributed noise (mean 0, sd 1). */
export function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** A string's hash, to seed the noise. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Fills the masked pixels of an RGBA image with the paper around them: each gap is
 * filled inward from its clean edge (averaging the nearest clean pixels, so paper
 * shading carries across), never from `ink` (other writing and its soft edge), and
 * then the paper's own grain is added back so the patch doesn't look smooth.
 */
export function fillPaper(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, ink: Uint8Array, rand: () => number, fallback: [number, number, number], fallbackSd: number): void {
  const known = new Uint8Array(w * h);
  const todo: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) todo.push(i);
    else known[i] = ink[i] ? 0 : 1;
  }
  let remaining = todo;
  for (let pass = 0; pass < 400 && remaining.length; pass++) {
    const next: number[] = [];
    const assigned: number[] = [];
    const values: number[] = [];
    for (const i of remaining) {
      const x = i % w;
      const y = (i - x) / w;
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!known[j]) continue;
          n++;
          r += rgba[j * 4];
          g += rgba[j * 4 + 1];
          b += rgba[j * 4 + 2];
        }
      }
      if (n) {
        assigned.push(i);
        values.push(r / n, g / n, b / n);
      } else next.push(i);
    }
    if (!assigned.length) break;
    assigned.forEach((i, k) => {
      rgba[i * 4] = values[k * 3];
      rgba[i * 4 + 1] = values[k * 3 + 1];
      rgba[i * 4 + 2] = values[k * 3 + 2];
      known[i] = 1;
    });
    remaining = next;
  }
  // Nothing clean to start from: the plain paper colour.
  for (const i of remaining) rgba.set(fallback, i * 4);
  for (const i of todo) {
    const noise = gaussian(rand) * fallbackSd;
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] += noise;
  }
}

/**
 * Pixels that belong to ruled lines (table borders, underlines, form boxes):
 * ink in runs longer than `minRun` along a row or a column. Letters never have
 * runs that long, so text is left alone. Grown by `grow` pixels to catch the soft edge.
 */
export function findRules(ink: Plane, minRun: number, grow = 1, threshold = 0.45): Uint8Array {
  const { w, h, data } = ink;
  const mark = new Uint8Array(w * h);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] > threshold;
  // Follows a line that may drift by a pixel from one step to the next (a scan that isn't quite straight).
  const follow = (x0: number, y0: number, horizontal: boolean) => {
    const path: number[] = [];
    let [x, y] = [x0, y0];
    for (;;) {
      path.push(y * w + x);
      const [nx, ny] = horizontal ? [x + 1, y] : [x, y + 1];
      const options = horizontal ? [[nx, ny], [nx, ny - 1], [nx, ny + 1]] : [[nx, ny], [nx - 1, ny], [nx + 1, ny]];
      const next = options.find(([a, b]) => on(a, b));
      if (!next) break;
      [x, y] = next;
    }
    return path;
  };
  const seenH = new Uint8Array(w * h);
  const seenV = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i] <= threshold) continue;
      if (!seenH[i]) {
        const path = follow(x, y, true);
        for (const j of path) seenH[j] = 1;
        if (path.length >= minRun) for (const j of path) mark[j] = 1;
      }
      if (!seenV[i]) {
        const path = follow(x, y, false);
        for (const j of path) seenV[j] = 1;
        if (path.length >= minRun) for (const j of path) mark[j] = 1;
      }
    }
  }
  return dilate(mark, w, h, grow);
}
