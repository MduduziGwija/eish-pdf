import { describe, expect, it } from "vitest";
import { splitLinesAtRules, type OcrLine } from "../src/core/ocrwords";
import { findRules, plane } from "../src/scan/pixels";
import { applyAff, composeAff, invertAff, lineQuad, readQuality, steadyAngles, turnBytes, turnPoint, turnRgba, unturnAngle, unturnPixelsAff, unturnPoint, type Turn } from "../src/scan/orient";

const turns: Turn[] = [0, 1, 2, 3];

describe("turning pages", () => {
  it("unturns what was turned, for points and for the direction of text", () => {
    for (const k of turns) {
      const [W, H] = [200, 300];
      const there = turnPoint(k, [30, 70], W, H);
      const back = unturnPoint(k, there, W, H);
      expect(back[0]).toBeCloseTo(30, 9);
      expect(back[1]).toBeCloseTo(70, 9);
    }
    // Text that reads upward on the page turns upright after one clockwise quarter turn.
    expect(unturnAngle(1, 0)).toBeCloseTo(-Math.PI / 2, 9);
    expect(unturnAngle(2, 0)).toBeCloseTo(Math.PI, 9);
    expect(unturnAngle(0, 0.1)).toBeCloseTo(0.1, 9);
  });

  it("turns pixels the same way as points, and the pixel map undoes it", () => {
    const [w, h] = [5, 3];
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([i, 0, 0, 255], i * 4);
    for (const k of turns) {
      const turned = turnRgba(rgba, w, h, k);
      const undo = unturnPixelsAff(k, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [u, v] = turnPoint(k, [x, y], w - 1, h - 1);
          expect(turned.data[(v * turned.w + u) * 4]).toBe(y * w + x);
          // A turned pixel's centre maps back to the original pixel's centre.
          const [bx, by] = applyAff(undo, [u + 0.5, v + 0.5]);
          expect([Math.floor(bx), Math.floor(by)]).toEqual([x, y]);
        }
      }
      const bytes = turnBytes(Uint8Array.from({ length: w * h }, (_, i) => i), w, h, k);
      expect(bytes.w).toBe(turned.w);
    }
  });

  it("composes and inverts maps", () => {
    const a: [number, number, number, number, number, number] = [0.9, 0.2, -0.2, 0.9, 5, -3];
    const b: [number, number, number, number, number, number] = [1, 0, 0, 1, 10, 20];
    const both = composeAff(a, b);
    const p = applyAff(both, [4, 7]);
    const q = applyAff(a, applyAff(b, [4, 7]));
    expect(p[0]).toBeCloseTo(q[0], 9);
    const back = applyAff(invertAff(both), p);
    expect(back[0]).toBeCloseTo(4, 9);
    expect(back[1]).toBeCloseTo(7, 9);
  });
});

describe("tilted lines", () => {
  it("follows long lines and gives short ones the page's usual tilt", () => {
    const lines = [
      { angle: 0.04, length: 300, size: 12 },
      { angle: 0.05, length: 320, size: 12 },
      { angle: 0.3, length: 30, size: 12 },
      { angle: 0.001, length: 400, size: 12 },
    ];
    const got = steadyAngles(lines);
    expect(got[0]).toBeCloseTo(0.04, 6);
    expect(got[2]).toBeCloseTo(0.04, 6); // short and odd: the page's usual
    expect(got[3]).toBe(0); // scanner noise snaps to level
  });

  it("boxes a tilted line by its words, not by their outline", () => {
    const quad = lineQuad([[0, 0, 100, 12], [110, 0, 200, 12]], 0);
    expect(quad).toEqual([[0, 0], [200, 0], [200, 12], [0, 12]]);
    // Tilted: still a true rectangle, turned the way the line runs.
    const tilted = lineQuad([[0, 0, 100, 20], [110, 4, 200, 24]], 0.05);
    const side = (i: number): [number, number] => [tilted[(i + 1) % 4][0] - tilted[i][0], tilted[(i + 1) % 4][1] - tilted[i][1]];
    expect(side(0)[0] * side(1)[0] + side(0)[1] * side(1)[1]).toBeCloseTo(0, 6);
    expect(Math.atan2(side(0)[1], side(0)[0])).toBeCloseTo(0.05, 6);
  });

  it("scores how well a page read", () => {
    expect(readQuality([{ text: "Hello,", confidence: 90 }, { text: "x", confidence: 30 }, { text: "42", confidence: 80 }])).toBe(7);
  });
});

describe("table rules", () => {
  it("finds long straight runs but not letters", () => {
    const p = plane(60, 30);
    for (let x = 0; x < 60; x++) p.data[10 * 60 + x] = 1; // a horizontal rule
    for (let y = 0; y < 30; y++) p.data[y * 60 + 40] = 1; // a vertical rule
    for (let y = 14; y < 22; y++) p.data[y * 60 + 5] = 1; // a letter stem
    const rules = findRules(p, 20, 0);
    expect(rules[10 * 60 + 25]).toBe(1);
    expect(rules[25 * 60 + 40]).toBe(1);
    expect(rules[18 * 60 + 5]).toBe(0);
  });

  it("follows a rule that drifts a little (a page scanned slightly crooked)", () => {
    const p = plane(300, 40);
    for (let x = 0; x < 300; x++) p.data[(10 + Math.floor(x / 40)) * 300 + x] = 1; // drops a pixel every 40
    const rules = findRules(p, 200, 0);
    expect(rules[10 * 300 + 5]).toBe(1);
    expect(rules[13 * 300 + 150]).toBe(1);
    expect(rules[16 * 300 + 290]).toBe(0); // (that pixel isn't on the line)
  });

  it("splits a table row into its cells", () => {
    const [w, h, scale] = [200, 40, 1];
    const rules = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) rules[y * w + 100] = 1; // a cell border
    const word = (text: string, x0: number, x1: number) => ({ text, bbox: [x0, 10, x1, 22] as [number, number, number, number], baseline: 20 });
    const line: OcrLine = { text: "Name: Sipho Total: 5", bbox: [10, 10, 190, 22], origin: [10, 20], size: 12, words: [word("Name:", 10, 40), word("Sipho", 46, 80), word("Total:", 120, 150), word("5", 156, 162)], letters: [], angle: 0 };
    const cells = splitLinesAtRules([line], rules, w, h, scale);
    expect(cells.map((c) => c.text)).toEqual(["Name: Sipho", "Total: 5"]);
    expect(cells[1].bbox[0]).toBe(120);
    // No rule between the words: stays one line.
    expect(splitLinesAtRules([line], new Uint8Array(w * h), w, h, scale)).toHaveLength(1);
  });
});
