import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { compress, fillForm, formFields, organize, permissionBits, protect, readProperties, redact, stamp, writeProperties } from "../src/core/pageops";
import { inspect } from "../src/core/pdf";
import { makePdf, pageTexts, rotations } from "./fixtures";

const input = (bytes: Uint8Array, password?: string) => ({ bytes, password });

describe("organize", () => {
  it("reorders, duplicates, rotates and drops pages", () => {
    const out = organize(input(makePdf(4)), [
      { from: 2, rotate: 0 },
      { from: 0, rotate: 90 },
      { from: 0, rotate: 0 },
    ]);
    expect(pageTexts(out)).toEqual(["Page 3", "Page 1", "Page 1"]);
    expect(rotations(out)).toEqual([0, 90, 0]);
  });
  it("adds turns to a page that is already rotated", () => {
    const once = organize(input(makePdf(1)), [{ from: 0, rotate: 270 }]);
    const twice = organize(input(once), [{ from: 0, rotate: 180 }]);
    expect(rotations(twice)).toEqual([90]);
  });
  it("refuses an empty plan or a missing page", () => {
    expect(() => organize(input(makePdf(2)), [])).toThrow();
    expect(() => organize(input(makePdf(2)), [{ from: 5, rotate: 0 }])).toThrow(/doesn't exist/);
  });
});

describe("redact", () => {
  it("removes the text for good, by term and by area", () => {
    const src = makePdf(2, "Secret");
    const res = redact(input(src), { marks: [], terms: ["Secret 1"] });
    expect(res.found["Secret 1"]).toBe(1);
    const texts = pageTexts(res.bytes);
    expect(texts[0]).not.toContain("Secret");
    expect(texts[1]).toBe("Secret 2");
    const byArea = redact(input(src), { marks: [{ page: 1, rect: [60, 120, 300, 160] }], terms: [] });
    expect(byArea.areas).toBe(1);
    expect(pageTexts(byArea.bytes)[1]).toBe("");
  });
});

describe("protect", () => {
  it("needs the password to open, and keeps permissions", () => {
    const locked = protect(input(makePdf(1)), { openPassword: "sesame", ownerPassword: "boss", allow: { print: true, copy: false, edit: false, annotate: true } });
    expect(inspect(input(locked)).status).toBe("password");
    const open = inspect(input(locked, "sesame"));
    expect(open.pages).toBe(1);
    expect(open.restrictions).toEqual(expect.arrayContaining(["Copying text", "Editing"]));
    expect(open.restrictions).not.toContain("Printing");
  });
  it("computes permission bits", () => {
    expect(permissionBits({ print: false, copy: false, edit: false, annotate: false }) & 0x3c).toBe(0);
    expect(permissionBits({ print: true, copy: true, edit: true, annotate: true }) & 0x3c).toBe(0x3c);
  });
});

describe("stamp", () => {
  it("adds numbering and a watermark to every page", () => {
    const out = stamp(input(makePdf(3)), {
      numbering: { format: "Page {n} of {total}", position: "bottom-center", size: 10, color: [0, 0, 0], start: 1 },
      watermark: { text: "DRAFT", size: 80, color: [0.8, 0.8, 0.8], angle: -45 },
    });
    const texts = pageTexts(out);
    expect(texts[2]).toContain("Page 3 of 3");
    expect(texts[0]).toContain("DRAFT");
  });
  it("can number only some pages", () => {
    const out = stamp(input(makePdf(3)), { numbering: { format: "#{n}", position: "top-right", size: 9, color: [0, 0, 0], start: 1 }, pages: [1] });
    const texts = pageTexts(out);
    expect(texts[0]).not.toContain("#");
    expect(texts[1]).toContain("#2");
  });
});

describe("properties", () => {
  it("round-trips the document info", () => {
    const out = writeProperties(input(makePdf(1)), { title: "Hello", author: "Mduduzi", subject: "S", keywords: "a, b" });
    expect(readProperties(input(out))).toEqual({ title: "Hello", author: "Mduduzi", subject: "S", keywords: "a, b" });
  });
});

describe("forms", () => {
  function formPdf(): Uint8Array {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, doc.addObject({}), ""));
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const w = page.createAnnotation("Widget");
    w.setRect([20, 20, 200, 50]);
    const obj = w.getObject();
    obj.put("FT", doc.newName("Tx"));
    obj.put("T", doc.newString("name"));
    const bytes = doc.saveToBuffer("").asUint8Array().slice();
    doc.destroy();
    return bytes;
  }
  it("lists and fills text fields", () => {
    const src = formPdf();
    const fields = formFields(input(src));
    expect(fields.length).toBe(1);
    expect(fields[0].kind).toBe("text");
    const filled = fillForm(input(src), { [fields[0].id]: "Mduduzi" }, false);
    expect(formFields(input(filled))[0].value).toBe("Mduduzi");
    const flat = fillForm(input(src), { [fields[0].id]: "Mduduzi" }, true);
    expect(formFields(input(flat)).length).toBe(0);
    expect(pageTexts(flat)[0]).toContain("Mduduzi");
  });
});

describe("compress", () => {
  it("shrinks a big photo and keeps the page", () => {
    const doc = new mupdf.PDFDocument();
    const w = 1600;
    const h = 1200;
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    const px = pm.getPixels();
    for (let i = 0; i < w * h; i++) px.set([(i * 7) % 256, (i >> 3) % 256, (i * 13) % 251], i * 3);
    const img = doc.addImage(new mupdf.Image(pm));
    const res = doc.addObject({ XObject: { Im: img } });
    doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, res, "q 400 0 0 300 0 0 cm /Im Do Q"));
    const src = doc.saveToBuffer("compress").asUint8Array().slice();
    doc.destroy();
    const out = compress(input(src), "balanced");
    expect(out.images).toBe(1);
    expect(out.after).toBeLessThan(out.before);
    const check = mupdf.Document.openDocument(out.bytes, "application/pdf");
    expect(check.countPages()).toBe(1);
    check.destroy();
  });
});

describe("comments", () => {
  it("adds, lists, edits and removes comments", async () => {
    const { listComments, saveComments } = await import("../src/core/pageops");
    const src = makePdf(2);
    const added = saveComments(input(src), [
      { id: "", page: 0, kind: "note", rect: [100, 100, 124, 124], text: "Check this figure", author: "Mduduzi", color: [1, 0.8, 0.1] },
      { id: "", page: 1, kind: "highlight", rect: [72, 90, 200, 110], text: "Important", author: "Mduduzi", color: [1, 0.9, 0.2] },
    ]);
    const list = listComments(input(added));
    expect(list.map((c) => [c.page, c.kind, c.text, c.author])).toEqual([
      [0, "note", "Check this figure", "Mduduzi"],
      [1, "highlight", "Important", "Mduduzi"],
    ]);
    // Edit one, drop the other.
    const edited = saveComments(input(added), [{ ...list[0], text: "Checked, thanks" }]);
    const after = listComments(input(edited));
    expect(after.map((c) => c.text)).toEqual(["Checked, thanks"]);
    expect(pageTexts(edited)).toEqual(["Page 1", "Page 2"]);
  });
});

describe("PDF/A", () => {
  it("flags what's missing, repairs it, and is honest about fonts", async () => {
    const { checkPdfa, preparePdfa } = await import("../src/core/pageops");
    const before = checkPdfa(input(makePdf(1)));
    expect(before.ready).toBe(false);
    expect(before.findings.find((f) => f.id === "metadata")?.state).toBe("fixable");
    expect(before.findings.find((f) => f.id === "intent")?.state).toBe("fixable");
    const fixed = preparePdfa(input(makePdf(1)));
    const after = checkPdfa(input(fixed));
    expect(after.findings.find((f) => f.id === "metadata")?.state).toBe("ok");
    expect(after.findings.find((f) => f.id === "intent")?.state).toBe("ok");
    expect(pageTexts(fixed)).toEqual(["Page 1"]);
    // The colour profile is a well-formed ICC profile.
    const doc = new mupdf.PDFDocument(fixed);
    const profile = doc.getTrailer().get("Root").get("OutputIntents", 0, "DestOutputProfile").readStream().asUint8Array();
    expect(new TextDecoder().decode(profile.subarray(36, 40))).toBe("acsp");
    expect(new DataView(profile.buffer, profile.byteOffset).getUint32(0)).toBe(profile.length);
    doc.destroy();
  });
  it("flattens to pictures", async () => {
    const { flattenToPictures } = await import("../src/core/pageops");
    const out = flattenToPictures(input(makePdf(2)), 72);
    const doc = mupdf.Document.openDocument(out, "application/pdf");
    expect(doc.countPages()).toBe(2);
    doc.destroy();
    expect(pageTexts(out)).toEqual(["", ""]);
  });
});
