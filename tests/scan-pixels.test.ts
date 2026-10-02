import { describe, expect, it } from "vitest";
import { blur, components, dilate, fillPaper, inkBox, ncc, plane, random, resize } from "../src/scan/pixels";

describe("scan pixel helpers", () => {
  it("blurs while keeping the total ink", () => {
    const p = plane(21, 21);
    p.data[10 * 21 + 10] = 1;
    const b = blur(p, 1.5);
    const total = b.data.reduce((a, v) => a + v, 0);
    expect(total).toBeCloseTo(1, 3);
    expect(b.data[10 * 21 + 10]).toBeLessThan(0.1);
    expect(b.data[10 * 21 + 11]).toBeCloseTo(b.data[10 * 21 + 9], 6);
  });

  it("scores matching shapes higher than different ones", () => {
    const a = [0, 1, 1, 0, 0, 1];
    expect(ncc(a, a)).toBeCloseTo(1, 6);
    expect(ncc(a, a.map((v) => v * 0.5 + 0.2))).toBeCloseTo(1, 6);
    expect(ncc(a, [1, 0, 0, 1, 1, 0])).toBeCloseTo(-1, 6);
  });

  it("finds ink boxes and resizes", () => {
    const p = plane(10, 8);
    p.data[2 * 10 + 3] = 1;
    p.data[5 * 10 + 7] = 1;
    expect(inkBox(p)).toEqual([3, 2, 8, 6]);
    expect(inkBox(plane(4, 4))).toBeNull();
    const r = resize(plane(2, 2, new Float32Array([0, 1, 0, 1])), 4, 4);
    expect(r.data[0]).toBe(0);
    expect(r.data[3]).toBe(1);
  });

  it("separates blobs and grows masks", () => {
    // Two blobs: an "i" (dot + stem) and a bar.
    const w = 8;
    const mask = new Uint8Array(w * 6);
    for (const [x, y] of [[1, 0], [1, 2], [1, 3], [1, 4], [4, 2], [5, 2], [6, 2]]) mask[y * w + x] = 1;
    const { list } = components(mask, w, 6);
    expect(list.map((c) => c.count).sort()).toEqual([1, 3, 3]);
    const grown = dilate(mask, w, 6, 1);
    expect(grown[0]).toBe(1);
    expect(grown[5 * w + 7]).toBe(0);
  });

  it("covers old ink with nearby paper", () => {
    const w = 10;
    const h = 9;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([240, 230, 200, 255], i * 4);
    const mask = new Uint8Array(w * h);
    for (let y = 3; y < 6; y++) for (let x = 2; x < 8; x++) {
      mask[y * w + x] = 1;
      rgba.set([20, 20, 20, 255], (y * w + x) * 4);
    }
    fillPaper(rgba, w, h, mask, mask, random(1), [240, 230, 200], 2);
    for (let i = 0; i < w * h; i++) expect(Array.from(rgba.slice(i * 4, i * 4 + 3))).toEqual([240, 230, 200]);
  });

  it("repeats the same noise for the same seed", () => {
    const a = random(42);
    const b = random(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
