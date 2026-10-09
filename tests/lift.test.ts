import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { edit } from "../src/core/pdf";
import { pagePictures } from "../src/core/scanimage";
import { openPdf } from "../src/core/pdf";

/** A white A4 page with a solid red 100×50 picture near the top left. */
function pageWithPicture(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], false);
  for (let i = 0; i < 200; i++) pix.getPixels().set([220, 20, 20], i * 3);
  const image = doc.addImage(new mupdf.Image(pix));
  const res = doc.addObject({ XObject: { Logo: image } });
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "q 100 0 0 50 50 740 cm /Logo Do Q"));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** Colour of the page at a point (page space, y down), rendered at 1 pixel per point. */
function colourAt(bytes: Uint8Array, x: number, y: number): number[] {
  const doc = new mupdf.PDFDocument(bytes);
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const n = pix.getNumberOfComponents();
  const at = Math.floor(y) * pix.getStride() + Math.floor(x) * n;
  return Array.from(pix.getPixels().slice(at, at + 3));
}

const isRed = (c: number[]) => c[0] > 180 && c[1] < 80 && c[2] < 80;
const isWhite = (c: number[]) => c.every((v) => v > 240);

describe("moving a letterhead", () => {
  it("finds pictures on the page", () => {
    const doc = openPdf({ bytes: pageWithPicture() });
    const [box] = pagePictures(doc, 0);
    expect(box[0]).toBeCloseTo(50, 0);
    expect(box[1]).toBeCloseTo(52, 0); // 842 - 740 - 50
    expect(box[2] - box[0]).toBeCloseTo(100, 0);
    doc.destroy();
  });

  it("lifts it off, leaves clean paper, and puts it somewhere else", () => {
    const source = pageWithPicture();
    expect(isRed(colourAt(source, 100, 75))).toBe(true);
    // The lifted piece: a red picture, as the editor captures it.
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 30, 15], false);
    for (let i = 0; i < 450; i++) pix.getPixels().set([220, 20, 20], i * 3);
    const png = pix.asPNG().slice();
    const out = edit(
      { bytes: source },
      [
        {
          source: 0,
          rotate: 0,
          annotations: [
            { type: "cover", rect: [50, 52, 150, 102], color: [1, 1, 1], remove: true },
            { type: "image", rect: [300, 400, 400, 450], image: "lift-1" },
          ],
        },
      ],
      { "lift-1": png },
    );
    expect(isWhite(colourAt(out, 100, 75))).toBe(true); // old spot: clean paper
    expect(isRed(colourAt(out, 350, 425))).toBe(true); // new spot: the picture
    expect(isWhite(colourAt(out, 200, 425))).toBe(true);
  });
});
