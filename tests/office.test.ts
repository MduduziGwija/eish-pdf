// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { htmlToPdf } from "../src/core/convert";
import { slidesToPdf } from "../src/core/slides";
import { excelToHtml, pptxToSlides, wordToHtml } from "../src/convert/office";
import { pageTexts } from "./fixtures";

const file = (name: string) => new Uint8Array(fs.readFileSync(path.resolve("tests/files", name)));
const bounds = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const b = doc.loadPage(0).getBounds().map(Math.round);
  doc.destroy();
  return b;
};
const flat = (bytes: Uint8Array) => pageTexts(bytes).join("\n").replace(/\s+/g, " ");

describe("Word", () => {
  it("keeps headings, bold, lists, tables and pictures", async () => {
    const html = await wordToHtml(file("policy.docx"));
    expect(html).toContain("<h1");
    expect(html).toMatch(/<strong>semester<\/strong>/);
    expect(html).toContain("<li>Proof of registration</li>");
    expect(html).toContain("<table>");
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    const pdf = htmlToPdf(html);
    expect(flat(pdf)).toMatch(/Bursary Policy 2026.*Students must submit results every semester.*Proof of registration.*Thandi.*R45 000/);
  });
});

describe("Excel", () => {
  it("turns each sheet into a table with text, numbers, dates and merged cells", () => {
    const { html, landscape } = excelToHtml(file("bursars.xlsx"));
    expect(landscape).toBe(false);
    expect(html).toContain("<h2>Bursars</h2>");
    expect(html).toContain("<h2>Notes</h2>");
    expect(html).toContain("<td><b>Name</b></td>");
    expect(html).toContain('<td class="n">45000</td>');
    expect(html).toContain('<td class="n">38500.5</td>');
    expect(html).toContain("2026-02-15");
    expect(html).toContain('colspan="3"');
    expect(flat(htmlToPdf(html))).toMatch(/Bursars Name Amount Paid on Thandi Nkosi 45000 2026-02-15.*Total budget approved Notes Reviewed by the bursar office/);
  });

  it("rejects files that aren't spreadsheets", () => {
    expect(() => excelToHtml(file("policy.docx"))).toThrow(/Excel/);
  });
});

describe("PowerPoint", () => {
  it("places titles, bullets, text boxes and pictures on landscape pages", () => {
    const slides = pptxToSlides(file("deck.pptx"));
    expect(slides).toHaveLength(3);
    expect(Math.round(slides[0].width)).toBe(960);
    expect(Math.round(slides[0].height)).toBe(540);
    const bullets = slides[1].items.find((i) => i.type === "text" && i.paragraphs.some((p) => p.bullet));
    expect(bullets).toBeTruthy();
    expect(slides[2].items.some((i) => i.type === "image")).toBe(true);

    const pdf = slidesToPdf(slides);
    expect(bounds(pdf)).toEqual([0, 0, 960, 540]);
    const texts = pageTexts(pdf).map((t) => t.replace(/\s+/g, " "));
    expect(texts[0]).toMatch(/Eish PDF.*Free PDF tools, made in Mzansi/);
    expect(texts[1]).toMatch(/What it does.*• ?Unlock and merge PDFs.*• ?Split and edit.*• ?Make scans searchable/);
    expect(texts[2]).toMatch(/Our colours.*Sho mfowethu!/);
  });
});
