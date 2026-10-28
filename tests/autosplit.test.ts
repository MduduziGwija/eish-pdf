import { describe, expect, it } from "vitest";
import { analyseSplit, fileSafe, groupsFor, pageCounter } from "../src/core/autosplit";

const statement = (student: string, n: number, name = "MR A PERSON") => [
  "Statement",
  `${name}   PAGE: ${n}`,
  `Street 1   Student: ${student}`,
  "Statement Date: 07-OCT-2026 14H16",
  "Date Reference Description Debit Credit Balance",
  "13-JAN-2026 REGISTRATION FEE 785.00",
];

describe("page counters", () => {
  it("reads the usual forms", () => {
    expect(pageCounter(["Report", "Page 3 of 7"])).toEqual({ n: 3, total: 7 });
    expect(pageCounter(["NAME   PAGE: 1"])).toEqual({ n: 1, total: undefined });
    expect(pageCounter(["Invoice", "2 of 5"])).toEqual({ n: 2, total: 5 });
    expect(pageCounter(["Printed 07/10/2026"])).toBeUndefined();
  });
});

describe("auto split", () => {
  const pages = [statement("1001", 1), statement("1002", 1), statement("1003", 1), statement("1003", 2), statement("1004", 1), statement("1005", 1), statement("1005", 2), statement("1005", 3)];

  it("finds where each statement begins, from the page numbers and the student number", () => {
    const a = analyseSplit(pages);
    expect(a.scanned).toBe(false);
    const counter = a.signals.find((s) => s.kind === "counter")!;
    expect(counter.starts).toEqual([0, 1, 2, 4, 5]);
    const student = a.signals.find((s) => s.id === "field:student")!;
    expect(student.starts).toEqual([0, 1, 2, 4, 5]);
    expect(student.names).toEqual(["1001", "1002", "1003", "1004", "1005"]);
    // The identifier that agrees with the page counter is the top suggestion.
    expect(a.signals[0].kind).toBe("field");
    expect(groupsFor(student.starts, pages.length)).toEqual([[0], [1], [2, 3], [4], [5, 6, 7]]);
  });

  it("ignores things that change but aren't people (dates, per-page numbers)", () => {
    const a = analyseSplit(pages);
    expect(a.signals.some((s) => /date/.test(s.id))).toBe(false);
  });

  it("uses an opening heading when there are no numbers", () => {
    const docs = ["COVER SHEET", "Body of a letter", "More of it", "COVER SHEET", "Another letter", "COVER SHEET", "Third letter", "end"];
    const a = analyseSplit(docs.map((d) => [d, "some words on the page here"]));
    const h = a.signals.find((s) => s.kind === "header")!;
    expect(h.starts).toEqual([0, 3, 5]);
  });

  it("uses blank pages as separators and leaves them out", () => {
    const text = (t: string) => [t, "plenty of words appear on this page"];
    const a = analyseSplit([text("one"), text("two"), [], text("three"), [""], text("four")]);
    const b = a.signals.find((s) => s.kind === "blank")!;
    expect(b.starts).toEqual([0, 3, 5]);
    expect(groupsFor(b.starts, 6, b.drop)).toEqual([[0, 1], [3], [5]]);
  });

  it("says when the pages are scans with no text", () => {
    const a = analyseSplit([[], [], [""], []]);
    expect(a.scanned).toBe(true);
    expect(a.signals).toEqual([]);
  });

  it("makes safe file names", () => {
    expect(fileSafe("22 30/74")).toBe("22_30_74");
  });
});
