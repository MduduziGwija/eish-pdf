import { unzipSync, strFromU8 } from "fflate";
import mammoth from "mammoth";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { documentToPdf, fontFamilyName, htmlToPdf, imagesToPdf, pdfToDocx, pdfToHtml, pdfToImages, pdfToText } from "../src/core/convert";
import { makeEmbeddedPdf, makePdf, makeScannedPdf, pageTexts } from "./fixtures";

const enc = (s: string) => new TextEncoder().encode(s);
const sizes = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const out = [...Array(doc.countPages()).keys()].map((i) => doc.loadPage(i).getBounds().map(Math.round));
  doc.destroy();
  return out;
};
const png = (w: number, h: number) => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(200);
  const bytes = pix.asPNG().slice();
  pix.destroy();
  return bytes;
};

describe("to PDF", () => {
  it("lays out text, Markdown and HTML on A4", () => {
    for (const [name, body] of [
      ["notes.txt", "Hello from a text file.\nSecond line."],
      ["readme.md", "# Hello\n\nFrom *Markdown*."],
      ["page.html", "<h1>Hello</h1><p>From <b>HTML</b>.</p>"],
    ]) {
      const out = documentToPdf(enc(body), name);
      expect(sizes(out)[0]).toEqual([0, 0, 595, 842]);
      expect(pageTexts(out)[0]).toMatch(/Hello/);
    }
    expect(pageTexts(htmlToPdf("<table><tr><td>Name</td><td>Thandi</td></tr></table>"))[0]).toMatch(/Name\s+Thandi/);
  });

  it("refuses files it can't read", () => {
    expect(() => documentToPdf(enc("not really"), "mystery.xyz")).toThrow(/can't read/);
  });

  it("puts pictures on pages that fit them, or centred on A4", () => {
    const pics = [png(400, 300), png(300, 400)];
    expect(sizes(imagesToPdf(pics, { pageSize: "fit" }))).toEqual([
      [0, 0, 300, 225],
      [0, 0, 225, 300],
    ]);
    // Landscape picture -> landscape A4.
    expect(sizes(imagesToPdf(pics, { pageSize: "a4" }))).toEqual([
      [0, 0, 842, 595],
      [0, 0, 595, 842],
    ]);
  });
});

describe("from PDF", () => {
  const letter = makeEmbeddedPdf([
    { text: "Bursary Award Letter", size: 22, color: [0, 0.14, 0.58], y: 90 },
    { text: "Amount awarded: R45 000", size: 12, color: [0, 0, 0], y: 130 },
  ]);

  it("extracts plain text and an HTML page", () => {
    expect(pdfToText({ bytes: makePdf(2) })).toBe("Page 1\n\n\fPage 2");
    const html = pdfToHtml({ bytes: letter });
    expect(html).toMatch(/<html/);
    expect(html).toContain("Bursary Award Letter");
  });

  it("renders each page to PNG or JPEG", () => {
    const pngs = pdfToImages({ bytes: makePdf(2) }, "png", 72);
    expect(pngs).toHaveLength(2);
    expect(String.fromCharCode(...pngs[0].slice(1, 4))).toBe("PNG");
    const jpgs = pdfToImages({ bytes: makePdf(1) }, "jpg", 72);
    expect([...jpgs[0].slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("makes a valid Word file with fonts, sizes and colours", async () => {
    const docx = pdfToDocx({ bytes: letter }, "Award");
    const files = unzipSync(docx);
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).toContain("Bursary Award Letter");
    expect(xml).toContain('<w:sz w:val="44"/>'); // 22pt
    expect(xml).toContain('<w:color w:val="002494"/>');
    expect(xml).toContain('w:ascii="Deja Vu Sans"');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(docx) });
    expect(value).toContain("Bursary Award Letter");
    expect(value).toContain("Amount awarded: R45 000");
  });

  it("carries pictures into the Word file", () => {
    const docx = pdfToDocx({ bytes: makeScannedPdf(makePdf(1)) }, "Scan");
    const files = unzipSync(docx);
    expect(Object.keys(files)).toContain("word/media/image1.png");
    expect(strFromU8(files["word/document.xml"])).toContain('r:embed="rIdImg1"');
  });

  it("tidies PDF font names for Word", () => {
    expect(fontFamilyName("ABCDEF+TimesNewRomanPS-BoldMT")).toBe("Times New Roman");
    expect(fontFamilyName("ArialMT")).toBe("Arial");
    expect(fontFamilyName("Helvetica-Bold")).toBe("Arial");
    expect(fontFamilyName("Calibri,Bold")).toBe("Calibri");
  });
});
