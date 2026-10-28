// Scan tidy-up: find how crooked a page is, straighten it, and even out the
// paper so the text stands out. Plain arrays, no DOM, so it runs in tests too.

export interface Raster {
  w: number;
  h: number;
  /** RGBA, like canvas ImageData. */
  data: Uint8ClampedArray;
}

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Shrinks to at most `max` pixels on the long side by averaging; returns a grey plane. */
function greySmall(r: Raster, max: number): { w: number; h: number; g: Float32Array; f: number } {
  const f = Math.max(1, Math.ceil(Math.max(r.w, r.h) / max));
  const w = Math.max(1, Math.floor(r.w / f));
  const h = Math.max(1, Math.floor(r.h / f));
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += lum(r.data, ((y * f + dy) * r.w + x * f + dx) * 4);
      g[y * w + x] = s / (f * f);
    }
  }
  return { w, h, g, f };
}

/**
 * How far the text lines are from level, in degrees (positive: the text runs
 * downhill to the right, so turn it counter-clockwise to fix). Looks for the angle
 * where the ink piles into the sharpest rows.
 */
export function estimateSkew(r: Raster, range = 8): number {
  const { w, h, g } = greySmall(r, 900);
  // Ink = clearly darker than the paper around it.
  let mean = 0;
  for (const v of g) mean += v;
  mean /= g.length;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] < mean * 0.62) (xs.push(x), ys.push(y));
  if (xs.length < 200) return 0;
  const bins = new Float64Array(w + h + 8);
  const score = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    // Slide each point along the line it would sit on if the page were level.
    const off = Math.ceil(Math.abs(t) * w) + 2;
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] - xs[i] * t) + off]++;
    let s = 0;
    for (const c of bins) s += c * c;
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let a = -range; a <= range + 1e-9; a += 0.5) {
    const s = score(a);
    if (s > bestScore) (bestScore = s), (best = a);
  }
  for (let a = best - 0.5; a <= best + 0.5 + 1e-9; a += 0.1) {
    const s = score(a);
    if (s > bestScore) (bestScore = s), (best = a);
  }
  // A page with no clear lines (a photo) shouldn't be turned on a guess.
  const flat = score(0);
  return bestScore > flat * 1.02 || Math.abs(best) < 0.15 ? Math.round(best * 10) / 10 : 0;
}

/** Turns the image by `deg` degrees clockwise about its centre (bilinear), filling the corners with `fill`. Same size out. */
export function rotate(r: Raster, deg: number, fill: [number, number, number] = [255, 255, 255]): Raster {
  if (Math.abs(deg) < 0.05) return r;
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const out = new Uint8ClampedArray(r.data.length);
  const cx = r.w / 2;
  const cy = r.h / 2;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      // Where this output pixel came from.
      const dx = x - cx;
      const dy = y - cy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      const o = (y * r.w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= r.w - 1 || sy >= r.h - 1) {
        out[o] = fill[0];
        out[o + 1] = fill[1];
        out[o + 2] = fill[2];
        out[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * r.w + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + r.w * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) out[o + c] = (r.data[i00 + c] * (1 - fx) + r.data[i10 + c] * fx) * (1 - fy) + (r.data[i01 + c] * (1 - fx) + r.data[i11 + c] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { w: r.w, h: r.h, data: out };
}

/** The paper's brightness at every pixel (shadows, tinted paper, uneven lighting), as a small grid. */
function paperGrid(r: Raster): { gw: number; gh: number; cell: number; v: Float32Array } {
  const cell = Math.max(8, Math.round(Math.max(r.w, r.h) / 160));
  const gw = Math.ceil(r.w / cell);
  const gh = Math.ceil(r.h / cell);
  const raw = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      // The brighter end of each cell is the paper; ink only pulls the low end down.
      const vals: number[] = [];
      for (let y = gy * cell; y < Math.min(r.h, (gy + 1) * cell); y += 2) for (let x = gx * cell; x < Math.min(r.w, (gx + 1) * cell); x += 2) vals.push(lum(r.data, (y * r.w + x) * 4));
      vals.sort((a, b) => a - b);
      raw[gy * gw + gx] = vals[Math.floor(vals.length * 0.85)] ?? 255;
    }
  }
  // Spread the paper level over cells that are all ink (a solid logo), then smooth.
  const maxed = new Float32Array(raw.length);
  const reach = 2;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let m = 0;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) m = Math.max(m, raw[Math.min(gh - 1, Math.max(0, gy + dy)) * gw + Math.min(gw - 1, Math.max(0, gx + dx))]);
      maxed[gy * gw + gx] = m;
    }
  }
  const v = new Float32Array(raw.length);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) (s += maxed[Math.min(gh - 1, Math.max(0, gy + dy)) * gw + Math.min(gw - 1, Math.max(0, gx + dx))]), n++;
      v[gy * gw + gx] = Math.max(60, s / n);
    }
  }
  return { gw, gh, cell, v };
}

export type Tidy = "whiten" | "bw";

/**
 * Evens out the lighting and whitens the paper. "bw" goes on to pure black
 * and white, which makes the smallest files and the crispest text.
 */
export function whiten(r: Raster, mode: Tidy): Raster {
  const { gw, gh, cell, v } = paperGrid(r);
  const out = new Uint8ClampedArray(r.data.length);
  for (let y = 0; y < r.h; y++) {
    // Bilinear lookup of the paper level between grid cell centres.
    const gy = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < r.w; x++) {
      const gx = Math.min(gw - 1, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const fx = gx - x0;
      const paper = (v[y0 * gw + x0] * (1 - fx) + v[y0 * gw + x1] * fx) * (1 - fy) + (v[y1 * gw + x0] * (1 - fx) + v[y1 * gw + x1] * fx) * fy;
      const i = (y * r.w + x) * 4;
      if (mode === "bw") {
        const ratio = lum(r.data, i) / paper;
        const c = ratio < 0.74 ? 0 : 255;
        out[i] = out[i + 1] = out[i + 2] = c;
      } else {
        // Divide out the paper, then pull the near-white up to white and deepen the ink a little.
        for (let c = 0; c < 3; c++) {
          const ratio = r.data[i + c] / paper;
          out[i + c] = Math.min(255, Math.max(0, ((ratio - 0.12) / (0.93 - 0.12)) * 255));
        }
      }
      out[i + 3] = 255;
    }
  }
  return { w: r.w, h: r.h, data: out };
}

export interface CleanResult {
  raster: Raster;
  /** Degrees the page was turned to level it. */
  turned: number;
}

/** Straightens (when it's off by a clear amount) and whitens one page. */
export function cleanPage(r: Raster, mode: Tidy): CleanResult {
  const skew = estimateSkew(r);
  // A line that runs downhill to the right needs a counter-clockwise turn, which is a negative clockwise angle.
  const turned = Math.abs(skew) >= 0.3 ? -skew : 0;
  return { raster: whiten(rotate(r, turned), mode), turned };
}
