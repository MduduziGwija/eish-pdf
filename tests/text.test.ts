import { describe, expect, it } from "vitest";
import { edit, openPdf } from "../src/core/pdf";
import { addOcrLayer, pageHasText, textLines } from "../src/core/text";
import { makeEmbeddedPdf, makePdf, pageTexts, styledLines } from "./fixtures";

const BLUE: [number, number, number] = [0.1, 0.3, 0.7];
const sample = (subset = false) =>
  makeEmbeddedPdf(
    [
      { text: "Student: Thandi Nkosi", size: 20, color: BLUE, y: 80 },
      { text: "Bursary amount R45 000", size: 12, color: [0, 0, 0], y: 112 },
    ],
    { subset },
  );

function linesOf(bytes: Uint8Array) {
  const doc = openPdf({ bytes });
  try {
    return textLines(doc, 0);
  } finally {
    doc.destroy();
  }
}

describe("textLines", () => {
  it("reports each line's text, size, colour, font and baseline", () => {
    const [title, amount] = linesOf(sample());
    expect(title).toMatchObject({ text: "Student: Thandi Nkosi", size: 20, font: { family: "sans", bold: false } });
    expect(title.color.map((c) => Math.round(c * 10) / 10)).toEqual(BLUE);
    expect(title.origin).toEqual([72, 80]);
    expect(amount).toMatchObject({ text: "Bursary amount R45 000", size: 12 });
  });

  it("guesses families and weights from font names", () => {
    const doc = openPdf({ bytes: makePdf(1) });
    try {
      expect(textLines(doc, 0)[0].font).toMatchObject({ name: "Helvetica", family: "sans" });
      expect(pageHasText(doc, 0)).toBe(true);
    } finally {
      doc.destroy();
    }
  });
});

describe("replacing text", () => {
  const replace = (bytes: Uint8Array, lineIndex: number, text: string) => {
    const line = linesOf(bytes)[lineIndex];
    return edit({ bytes }, [
      { source: 0, rotate: 0, annotations: [{ type: "replace", rect: line.bbox, text, origin: line.origin, size: line.size, color: line.color, font: line.font }] },
    ]);
  };

  it("keeps the original embedded font, size and colour", () => {
    const out = replace(sample(), 0, "Student: Thandi Dlamini");
    const lines = styledLines(out);
    expect(lines.map((l) => l.text).sort()).toEqual(["Bursary amount R45 000", "Student: Thandi Dlamini"]);
    expect(lines.find((l) => l.text.startsWith("Student"))).toMatchObject({ font: "DejaVuSans", size: 20, color: BLUE });
  });

  it("falls back to a matching standard font when the embedded subset lacks letters", () => {
    // The subset only has the letters already used; "Q" and "z" aren't among them.
    const out = replace(sample(true), 1, "Quiz amount R50 000");
    const amount = styledLines(out).find((l) => l.text.startsWith("Quiz"));
    expect(amount).toMatchObject({ text: "Quiz amount R50 000", font: "Helvetica", size: 12, color: [0, 0, 0] });
  });

  it("uses the subset font when every letter is available", () => {
    // "4", "0", spaces and every letter already appear in the subset.
    const out = replace(sample(true), 1, "Bursary amount R40 000");
    const amount = styledLines(out).find((l) => l.text.startsWith("Bursary"));
    expect(amount).toMatchObject({ text: "Bursary amount R40 000", size: 12 });
    expect(amount!.font).toMatch(/DejaVuSans/);
  });

  it("handles accents and smart quotes in standard fonts", () => {
    const out = replace(makePdf(1), 0, "Café “lekker” – R€5");
    expect(pageTexts(out)[0]).toBe("Café “lekker” – R€5");
  });

  it("keeps replaced text with the page content when the page is also rotated", () => {
    const bytes = sample();
    const line = linesOf(bytes)[0];
    const out = edit({ bytes }, [
      { source: 0, rotate: 90, annotations: [{ type: "replace", rect: line.bbox, text: "Student: Sipho", origin: line.origin, size: line.size, color: line.color, font: line.font }] },
    ]);
    const text = pageTexts(out)[0];
    expect(text).toContain("Student: Sipho");
    expect(text).not.toContain("Thandi");
  });
});

describe("new text with formatting", () => {
  it("writes bold serif text, centred, over several lines", () => {
    const out = edit({ bytes: makePdf(1) }, [
      {
        source: 0,
        rotate: 0,
        annotations: [
          { type: "text", rect: [72, 300, 400, 340], text: "Approved\nby the Bursar", size: 16, color: [0.8, 0, 0], family: "serif", bold: true, underline: true, align: "center" },
        ],
      },
    ]);
    const lines = styledLines(out).filter((l) => l.text !== "Page 1");
    expect(lines).toEqual([
      { text: "Approved", font: "Times-Bold", size: 16, color: [0.8, 0, 0] },
      { text: "by the Bursar", font: "Times-Bold", size: 16, color: [0.8, 0, 0] },
    ]);
  });
});

describe("OCR layer", () => {
  it("adds invisible words that are searchable", () => {
    const doc = openPdf({ bytes: makePdf(1) });
    try {
      addOcrLayer(doc, 0, [
        { text: "Scanned", bbox: [72, 400, 160, 420], baseline: 416 },
        { text: "bursary", bbox: [168, 400, 250, 420], baseline: 416 },
      ]);
      const bytes = doc.saveToBuffer("").asUint8Array().slice();
      expect(pageTexts(bytes)[0]).toMatch(/Scanned bursary/);
    } finally {
      doc.destroy();
    }
  });
});
