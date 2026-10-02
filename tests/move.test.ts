import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { edit, openPdf } from "../src/core/pdf";
import { textLines } from "../src/core/text";
import { makeEmbeddedPdf } from "./fixtures";

/** Where each line of text starts on page 0. */
function origins(bytes: Uint8Array): Record<string, [number, number]> {
  const doc = new mupdf.PDFDocument(bytes);
  const out: Record<string, [number, number]> = {};
  let text = "";
  let first: [number, number] | undefined;
  doc.loadPage(0).toStructuredText("preserve-whitespace").walk({
    beginLine() {
      text = "";
      first = undefined;
    },
    onChar(c, origin) {
      first ??= [origin[0], origin[1]];
      text += c;
    },
    endLine() {
      if (text.trim()) out[text.trim()] = first!;
    },
  });
  doc.destroy();
  return out;
}

describe("moving edited text", () => {
  it("draws a replaced line at its new spot and keeps the old spot empty", () => {
    const source = makeEmbeddedPdf([
      { text: "Applicant: Thandeka Dlamini", size: 14, color: [0, 0, 0], y: 150 },
      { text: "Signed in Pretoria", size: 12, color: [0, 0, 0], y: 300 },
    ]);
    const doc = openPdf({ bytes: source });
    const line = textLines(doc, 0).find((l) => l.text.startsWith("Applicant"))!;
    doc.destroy();
    const out = edit({ bytes: source }, [
      {
        source: 0,
        rotate: 0,
        annotations: [{ type: "replace", rect: line.bbox, text: "Applicant: Sipho Ndlovu", origin: line.origin, size: line.size, color: line.color, font: line.font, shift: [30, 80] }],
      },
    ]);
    const after = origins(out);
    expect(after["Applicant: Thandeka Dlamini"]).toBeUndefined();
    const [x, y] = after["Applicant: Sipho Ndlovu"];
    expect(x).toBeCloseTo(line.origin[0] + 30, 0);
    expect(y).toBeCloseTo(line.origin[1] + 80, 0);
    expect(after["Signed in Pretoria"]).toBeDefined();
  });
});
