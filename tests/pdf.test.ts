import { describe, expect, it } from "vitest";
import { edit, inspect, merge, NotPdfError, openPdf, pageSizes, parsePageRanges, PasswordError, renderPage, split, unlock } from "../src/core/pdf";
import { makePdf, pageTexts, PASSWORD, RESTRICTED, rotations } from "./fixtures";

describe("inspect", () => {
  it("reports a plain PDF as unrestricted", () => {
    const info = inspect({ bytes: makePdf(2) });
    expect(info).toMatchObject({ status: "unrestricted", pages: 2, restrictions: [], encryption: "None" });
  });

  it("lists the blocked actions of a restricted PDF", () => {
    const info = inspect({ bytes: makePdf(1, "Page", RESTRICTED) });
    expect(info.status).toBe("restricted");
    expect(info.pages).toBe(1);
    expect(info.restrictions).toEqual(expect.arrayContaining(["Printing", "Copying text", "Editing"]));
  });

  it("flags files that need an opening password, and wrong passwords", () => {
    const bytes = makePdf(1, "Page", PASSWORD);
    expect(inspect({ bytes })).toMatchObject({ status: "password", pages: 0, wrongPassword: false });
    expect(inspect({ bytes, password: "nope" })).toMatchObject({ status: "password", wrongPassword: true });
    expect(inspect({ bytes, password: "open-sesame" })).toMatchObject({ status: "restricted", pages: 1 });
  });

  it("rejects files that aren't PDFs", () => {
    expect(() => inspect({ bytes: new TextEncoder().encode("hello, not a pdf") })).toThrow(NotPdfError);
  });
});

describe("unlock", () => {
  it("removes restrictions and keeps the content", () => {
    const out = unlock({ bytes: makePdf(3, "Page", RESTRICTED) });
    expect(inspect({ bytes: out })).toMatchObject({ status: "unrestricted", restrictions: [] });
    expect(pageTexts(out)).toEqual(["Page 1", "Page 2", "Page 3"]);
  });

  it("needs the opening password, and never guesses it", () => {
    const bytes = makePdf(1, "Secret", PASSWORD);
    expect(() => unlock({ bytes })).toThrow(PasswordError);
    expect(() => unlock({ bytes, password: "wrong" })).toThrow(/didn't work/);
    const out = unlock({ bytes, password: "open-sesame" });
    expect(inspect({ bytes: out }).status).toBe("unrestricted");
    expect(pageTexts(out)).toEqual(["Secret 1"]);
  });
});

describe("merge", () => {
  it("joins files in order, including restricted ones", () => {
    const out = merge([
      { bytes: makePdf(2, "A") },
      { bytes: makePdf(1, "B", RESTRICTED) },
      { bytes: makePdf(1, "C", PASSWORD), password: "open-sesame" },
    ]);
    expect(pageTexts(out)).toEqual(["A 1", "A 2", "B 1", "C 1"]);
    expect(inspect({ bytes: out }).status).toBe("unrestricted");
  });

  it("fails clearly when a file's password is missing", () => {
    expect(() => merge([{ bytes: makePdf(1) }, { bytes: makePdf(1, "C", PASSWORD) }])).toThrow(PasswordError);
  });
});

describe("split", () => {
  it("creates one file per page group", () => {
    const outs = split({ bytes: makePdf(5) }, [[0, 1], [4], [2]]);
    expect(outs.map(pageTexts)).toEqual([["Page 1", "Page 2"], ["Page 5"], ["Page 3"]]);
  });

  it("rejects pages that don't exist", () => {
    expect(() => split({ bytes: makePdf(2) }, [[5]])).toThrow(/doesn't exist/);
  });
});

describe("parsePageRanges", () => {
  it("understands single pages, ranges and open ends", () => {
    expect(parsePageRanges("1-3, 5, 8-", 9)).toEqual([[0, 1, 2], [4], [7, 8]]);
    expect(parsePageRanges("-2", 5)).toEqual([[0, 1]]);
    expect(parsePageRanges(" 4 - 4 ; 2", 5)).toEqual([[3], [1]]);
  });

  it("explains bad input", () => {
    expect(() => parsePageRanges("", 5)).toThrow(/Type some pages/);
    expect(() => parsePageRanges("abc", 5)).toThrow(/isn't a page range/);
    expect(() => parsePageRanges("3-9", 5)).toThrow(/past the last page/);
    expect(() => parsePageRanges("4-2", 5)).toThrow(/backwards/);
    expect(() => parsePageRanges("0", 5)).toThrow(/start at 1/);
    expect(() => parsePageRanges("-", 5)).toThrow(/isn't a page range/);
  });
});

describe("edit", () => {
  const pages = (n: number) => Array.from({ length: n }, (_, source) => ({ source, rotate: 0 as const, annotations: [] }));

  it("reorders and deletes pages", () => {
    const out = edit({ bytes: makePdf(4) }, [pages(4)[3], pages(4)[0]]);
    expect(pageTexts(out)).toEqual(["Page 4", "Page 1"]);
  });

  it("rotates pages on top of their existing rotation", () => {
    const once = edit({ bytes: makePdf(1) }, [{ source: 0, rotate: 90, annotations: [] }]);
    const twice = edit({ bytes: once }, [{ source: 0, rotate: 270, annotations: [] }]);
    expect(rotations(once)).toEqual([90]);
    expect(rotations(twice)).toEqual([0]);
  });

  it("really erases text and adds new text", () => {
    // "Page 1" sits at x≈72, baseline y≈142 (top-left origin).
    const out = edit({ bytes: makePdf(1) }, [
      {
        source: 0,
        rotate: 0,
        annotations: [
          { type: "erase", rect: [60, 110, 200, 150] },
          { type: "text", rect: [72, 300, 300, 330], text: "Howzit", size: 18, color: [0, 0, 0] },
          { type: "ink", strokes: [[[100, 400], [150, 450]]], width: 2, color: [0, 0, 1] },
          { type: "highlight", rect: [72, 300, 200, 330], color: [1, 0.85, 0] },
        ],
      },
    ]);
    expect(pageTexts(out)).toEqual(["Howzit"]);
  });

  it("places edits on the page as rotated", () => {
    // After a 90° turn the page is 842 wide and 595 tall.
    const out = edit({ bytes: makePdf(1) }, [
      {
        source: 0,
        rotate: 90,
        annotations: [{ type: "text", rect: [500, 400, 800, 440], text: "Sideways? Nope", size: 20, color: [0, 0, 0] }],
      },
    ]);
    expect(rotations(out)).toEqual([90]);
    expect(pageTexts(out)).toEqual(["Page 1\n\nSideways? Nope"]);
  });

  it("unlocks restricted files while editing", () => {
    const out = edit({ bytes: makePdf(2, "Page", RESTRICTED) }, pages(2));
    expect(inspect({ bytes: out }).status).toBe("unrestricted");
  });

  it("refuses to delete every page or repeat one", () => {
    expect(() => edit({ bytes: makePdf(2) }, [])).toThrow(/at least one page/);
    expect(() => edit({ bytes: makePdf(2) }, [pages(2)[0], pages(2)[0]])).toThrow(/only appear once/);
  });
});

describe("rendering", () => {
  it("reports page sizes and renders rotated PNGs", () => {
    const doc = openPdf({ bytes: makePdf(1) });
    try {
      expect(pageSizes(doc)).toEqual([{ width: 595, height: 842 }]);
      const png = renderPage(doc, 0, 0.2, 90);
      expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
      // Rotated 90°, so the image is landscape: width at byte 16, height at 20.
      const view = new DataView(png.buffer, png.byteOffset);
      expect(view.getUint32(16)).toBeGreaterThan(view.getUint32(20));
    } finally {
      doc.destroy();
    }
  });
});
