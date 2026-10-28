import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { cleanPage, estimateSkew, rotate, whiten, type Raster } from "../src/scan/clean";
import { rebuildPages } from "../src/core/pageops";
import { makePdf, pageTexts } from "./fixtures";

/** A white page of "text lines": rows of short dark dashes. */
function page(w = 700, h = 900, shade?: (x: number, y: number) => number): Raster {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const paper = shade ? shade(x, y) : 255;
      data[i] = data[i + 1] = data[i + 2] = paper;
    }
  }
  for (let line = 0; line < 30; line++) {
    const y0 = 80 + line * 26;
    for (let x = 60; x < w - 60; x += 14) {
      if ((x / 14 + line) % 5 === 0) continue;
      for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 9; dx++) {
        const i = ((y0 + dy) * w + x + dx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 25;
      }
    }
  }
  return { w, h, data };
}

describe("scan clean-up", () => {
  it("finds a crooked page and straightens it", () => {
    const level = page();
    expect(Math.abs(estimateSkew(level))).toBeLessThan(0.3);
    const crooked = rotate(level, 3);
    const skew = estimateSkew(crooked);
    expect(skew).toBeGreaterThan(2.4);
    expect(skew).toBeLessThan(3.6);
    const { raster, turned } = cleanPage(crooked, "whiten");
    expect(turned).toBeLessThan(-2.4);
    expect(Math.abs(estimateSkew(raster))).toBeLessThan(0.6);
  });
  it("also handles the other direction and leaves level pages alone", () => {
    expect(estimateSkew(rotate(page(), -2))).toBeLessThan(-1.4);
    expect(cleanPage(page(), "whiten").turned).toBe(0);
  });
  it("evens out a shadow and whitens the paper", () => {
    const shaded = page(700, 900, (x) => 150 + (x / 700) * 100);
    const out = whiten(shaded, "whiten");
    const at = (x: number, y: number) => out.data[(y * out.w + x) * 4];
    // Paper (between lines) is white at both the dark and the bright side.
    expect(at(20, 20)).toBeGreaterThan(235);
    expect(at(680, 20)).toBeGreaterThan(235);
    // Ink stays dark.
    expect(at(64, 84)).toBeLessThan(80);
  });
  it("goes to pure black and white on request", () => {
    const out = whiten(page(700, 900, (x) => 170 + (x / 700) * 80), "bw");
    const values = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) values.add(out.data[i]);
    expect([...values].sort()).toEqual([0, 255]);
  });
});

describe("rebuildPages", () => {
  it("swaps chosen pages for pictures and keeps the rest", async () => {
    const src = makePdf(3);
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
    pm.clear(255);
    const png = pm.asPNG().slice();
    const out = rebuildPages({ bytes: src }, [null, { image: png, width: 300, height: 400 }, null]);
    const texts = pageTexts(out);
    expect(texts).toEqual(["Page 1", "", "Page 3"]);
  });
});
