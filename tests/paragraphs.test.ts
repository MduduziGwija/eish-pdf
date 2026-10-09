import { describe, expect, it } from "vitest";
import { fromFrame, groupParagraphs, layoutParagraph, paragraphText, wrapText, type ParaLine } from "../src/core/paragraphs";

const line = (text: string, x: number, y: number, length: number, size = 12, angle = 0): ParaLine => ({ text, origin: [x, y], size, angle, length });
const width = (s: string) => s.length * 6;

describe("paragraphs", () => {
  it("groups the lines of a paragraph and leaves headings, columns and other blocks apart", () => {
    const lines = [
      line("Heading", 72, 90, 60, 18),
      line("This paragraph runs across", 72, 120, 400),
      line("several lines of the page and", 72, 134.4, 398),
      line("ends here.", 72, 148.8, 70),
      line("A different block below it", 72, 190, 380),
      line("right column text", 340, 120, 200),
    ];
    const paras = groupParagraphs(lines);
    expect(paras.map((p) => p.lines.map((l) => l.text))).toEqual([
      ["Heading"],
      ["This paragraph runs across", "several lines of the page and", "ends here."],
      ["right column text"],
      ["A different block below it"],
    ].sort(() => 0) as string[][]);
    const main = paras.find((p) => p.lines.length === 3)!;
    expect(main.leading).toBeCloseTo(14.4, 6);
    expect(main.align).toBe("left");
  });

  it("does not join a short label to the line below it", () => {
    const paras = groupParagraphs([line("Name:", 72, 100, 30), line("A long line that follows the label here", 72, 114.4, 300)]);
    expect(paras).toHaveLength(2);
  });

  it("groups text that reads upward, and tilted lines", () => {
    // Turned a quarter turn: baselines run up the page.
    const up = (text: string, x: number, length: number) => line(text, x, 700, length, 12, -Math.PI / 2);
    const sideways = groupParagraphs([up("first line of the", 100, 300), up("second line goes on", 114.4, 298), up("end.", 128.8, 50)]);
    expect(sideways).toHaveLength(1);
    expect(sideways[0].lines.map((l) => l.text)).toEqual(["first line of the", "second line goes on", "end."]);
    // Tilted 3° and 4° lines on one page still belong together.
    const a = 0.052;
    const [x2, y2] = fromFrame([0, 14.4], a);
    const tilted = groupParagraphs([line("tilted paragraph first", 72, 200, 300, 12, a), line("tilted paragraph second", 72 + x2, 200 + y2, 295, 12, a + 0.01)]);
    expect(tilted).toHaveLength(1);
  });

  it("groups centred lines", () => {
    const paras = groupParagraphs([line("A centred title", 200, 100, 150, 14), line("and its second", 225, 116.8, 100, 14)]);
    expect(paras).toHaveLength(1);
    expect(paras[0].align).toBe("center");
  });

  it("mends hyphenated line ends and wraps new text", () => {
    expect(paragraphText([{ text: "an exam-" }, { text: "ple of text" }, { text: "that goes on" }])).toBe("an example of text that goes on");
    expect(wrapText("one two three four five", 70, width)).toEqual(["one two", "three four", "five"]);
    expect(wrapText("a\nb", 100, width)).toEqual(["a", "b"]);
  });

  it("lays new lines out at the paragraph's spacing, keeping an indent", () => {
    const paras = groupParagraphs([line("Indented first line of it", 90, 100, 380), line("second line of the text here", 72, 114.4, 398), line("end", 72, 128.8, 20)]);
    const laid = layoutParagraph(paras[0], ["new one", "new two", "new three", "new four"], width);
    expect(laid[0].origin).toEqual([90, 100]);
    expect(laid[1].origin[0]).toBeCloseTo(72, 6);
    expect(laid.map((l) => l.origin[1])).toEqual([100, 114.4, 128.8, 143.2].map((y) => expect.closeTo(y, 6)));
  });
});
