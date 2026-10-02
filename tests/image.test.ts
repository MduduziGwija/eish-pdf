import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { edit } from "../src/core/pdf";
import { makePdf } from "./fixtures";

/** A solid-colour PNG. */
function png(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const samples = pix.getPixels();
  for (let i = 0; i < samples.length; i += 3) samples.set(rgb, i);
  const out = pix.asPNG().slice();
  pix.destroy();
  return out;
}

/** Colour of the pixel at page point (x, y), top-left origin as displayed, at 1 px per point. */
function colourAt(bytes: Uint8Array, pageIndex: number, x: number, y: number): number[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pix = doc.loadPage(pageIndex).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth();
  const i = (Math.round(y) * w + Math.round(x)) * 3;
  const px = [...pix.getPixels().slice(i, i + 3)];
  doc.destroy();
  return px;
}

const RED: [number, number, number] = [220, 30, 40];
const isRed = (c: number[]) => c[0] > 180 && c[1] < 80 && c[2] < 80;
const isWhite = (c: number[]) => c.every((v) => v > 230);

describe("placing pictures", () => {
  it("draws a picture exactly in its box", () => {
    const out = edit({ bytes: makePdf(1) }, [{ source: 0, rotate: 0, annotations: [{ type: "image", rect: [300, 400, 500, 500], image: "logo" }] }], { logo: png(40, 20, RED) });
    expect(isRed(colourAt(out, 0, 400, 450))).toBe(true);
    expect(isRed(colourAt(out, 0, 305, 405))).toBe(true);
    expect(isWhite(colourAt(out, 0, 295, 450))).toBe(true);
    expect(isWhite(colourAt(out, 0, 400, 505))).toBe(true);
  });

  it("places pictures on rotated pages as seen on screen", () => {
    // Rotated 90°: the page shows as 842 wide by 595 tall.
    const out = edit({ bytes: makePdf(1) }, [{ source: 0, rotate: 90, annotations: [{ type: "image", rect: [600, 50, 800, 150], image: "logo" }] }], { logo: png(40, 20, RED) });
    expect(isRed(colourAt(out, 0, 700, 100))).toBe(true);
    expect(isWhite(colourAt(out, 0, 500, 100))).toBe(true);
  });

  it("stores a picture used on several pages only once", () => {
    const out = edit(
      { bytes: makePdf(2) },
      [0, 1].map((source) => ({ source, rotate: 0 as const, annotations: [{ type: "image" as const, rect: [50, 50, 150, 100] as [number, number, number, number], image: "logo" }] })),
      { logo: png(40, 20, RED) },
    );
    const doc = new mupdf.PDFDocument(out);
    let images = 0;
    for (let i = 1; i < doc.countObjects(); i++) {
      const obj = doc.newIndirect(i).resolve();
      if (obj.isDictionary() && obj.get("Subtype").toString() === "/Image") images++;
    }
    doc.destroy();
    expect(images).toBe(1);
    expect(isRed(colourAt(out, 1, 100, 75))).toBe(true);
  });

  it("explains a missing picture", () => {
    expect(() => edit({ bytes: makePdf(1) }, [{ source: 0, rotate: 0, annotations: [{ type: "image", rect: [0, 0, 10, 10], image: "nope" }] }])).toThrow(/missing/);
  });
});
