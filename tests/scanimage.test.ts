import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { edit, openPdf } from "../src/core/pdf";
import { scanImage } from "../src/core/scanimage";
import { makeEmbeddedPdf, makeScannedPdf, pageTexts } from "./fixtures";

const source = makeEmbeddedPdf([{ text: "Amount awarded: R45 000", size: 14, color: [0, 0, 0], y: 150 }]);

/** A 40×20 PNG: an opaque red square on the left half, transparent on the right. */
function redPatch(): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], true);
  pix.getPixels().fill(0);
  const px = pix.getPixels();
  const stride = pix.getStride();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) px.set([255, 0, 0, 255], y * stride + x * 4);
  const png = pix.asPNG().slice();
  pix.destroy();
  return png;
}

function imageInfo(bytes: Uint8Array) {
  const doc = openPdf({ bytes });
  const xobjects = doc.findPage(0).getInheritable("Resources").get("XObject");
  let filter = "";
  xobjects.forEach((ref) => (filter = ref.resolve().get("Filter").toString()));
  const found = scanImage(doc, 0)!;
  const img = new mupdf.Image(found.png);
  const pix = img.toPixmap();
  const at = (x: number, y: number) => Array.from(pix.getPixels().slice(y * pix.getStride() + x * pix.getNumberOfComponents(), y * pix.getStride() + x * pix.getNumberOfComponents() + pix.getNumberOfComponents()));
  return { filter, found, at, done: () => (pix.destroy(), img.destroy(), doc.destroy()) };
}

describe("scan pictures", () => {
  it("finds the page's scan and where its pixels sit", () => {
    const scan = makeScannedPdf(source, 144);
    const doc = openPdf({ bytes: scan });
    const found = scanImage(doc, 0)!;
    expect(found).not.toBeNull();
    expect(found.width).toBe(Math.round((595 * 144) / 72));
    // Pixel (u, v) → page: two pixels per point, top-left at the page's corner.
    const [a, b, c, d, e, f] = found.matrix;
    expect(a).toBeCloseTo(0.5, 2);
    expect(d).toBeCloseTo(0.5, 2);
    expect([b, c, e, f]).toEqual([0, 0, 0, 0]);
    doc.destroy();
  });

  it("returns null for pages that aren't scans", () => {
    const doc = openPdf({ bytes: source });
    expect(scanImage(doc, 0)).toBeNull();
    doc.destroy();
  });

  for (const jpeg of [false, true]) {
    it(`paints edits into the scan itself (${jpeg ? "JPEG" : "lossless"})`, () => {
      const scan = makeScannedPdf(source, 144, jpeg);
      const before = imageInfo(scan);
      const size: [number, number] = [before.found.width, before.found.height];
      const untouched = before.at(300, 30);
      before.done();
      const out = edit(
        { bytes: scan },
        [
          {
            source: 0,
            rotate: 0,
            annotations: [
              {
                type: "replace",
                rect: [100, 100, 140, 110],
                text: "Sho",
                origin: [100, 108],
                size: 10,
                color: [0, 0, 0],
                font: { name: "", family: "sans", bold: false, italic: false },
                scan: { patch: "p1", box: [100, 100, 120, 110], at: [200, 200], scanSize: size, words: [{ text: "Sho", bbox: [100, 100, 110, 110], baseline: 108 }] },
              },
            ],
          },
        ],
        { p1: redPatch() },
      );
      const after = imageInfo(out);
      // Still one picture, the same kind, and no text drawn over it except the invisible words.
      expect(after.filter).toBe(jpeg ? "/DCTDecode" : "/FlateDecode");
      const red = after.at(205, 205);
      // The scan is grey, so red becomes its grey value (~76).
      expect(red[0]).toBeGreaterThan(60);
      expect(red[0]).toBeLessThan(95);
      // The transparent half and the rest of the scan are unchanged.
      expect(Math.abs(after.at(230, 205)[0] - 255)).toBeLessThan(jpeg ? 12 : 1);
      expect(Math.abs(after.at(300, 30)[0] - untouched[0])).toBeLessThan(jpeg ? 12 : 1);
      after.done();
      expect(pageTexts(out)[0]).toContain("Sho");
    });
  }

  it("falls back to drawing the patch on top when the page changed", () => {
    const scan = makeScannedPdf(source, 144);
    const out = edit({ bytes: scan }, [
      {
        source: 0,
        rotate: 0,
        annotations: [
          {
            type: "replace",
            rect: [100, 100, 140, 110],
            text: "Sho",
            origin: [100, 108],
            size: 10,
            color: [0, 0, 0],
            font: { name: "", family: "sans", bold: false, italic: false },
            scan: { patch: "p1", box: [100, 100, 120, 110], at: [200, 200], scanSize: [10, 10], words: [] },
          },
        ],
      },
    ], { p1: redPatch() });
    const doc = openPdf({ bytes: out });
    let images = 0;
    doc.loadPage(0).run(new mupdf.Device({ fillImage: () => void images++ }), mupdf.Matrix.identity);
    expect(images).toBe(2);
    doc.destroy();
  });
});
