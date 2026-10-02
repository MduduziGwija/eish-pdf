import { describe, expect, it } from "vitest";
import { compareDocs, diff, spotsAcross, wordDiff, type DocText } from "../src/core/compare";

/** Rebuilds b from a and the script, and counts the edits. */
function apply<T>(a: T[], b: T[], ops: ReturnType<typeof diff<T>>) {
  const out: T[] = [];
  let edits = 0;
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    expect(op.a).toBe(ai);
    expect(op.b).toBe(bi);
    if (op.type === "equal") {
      for (let i = 0; i < op.n; i++) expect(a[ai + i]).toBe(b[bi + i]);
      out.push(...a.slice(ai, ai + op.n));
      ai += op.n;
      bi += op.n;
    } else if (op.type === "delete") {
      ai += op.n;
      edits += op.n;
    } else {
      out.push(...b.slice(bi, bi + op.n));
      bi += op.n;
      edits += op.n;
    }
  }
  expect(ai).toBe(a.length);
  return { out, edits };
}

/** Minimum edits by dynamic programming (LCS), for checking. */
function minEdits<T>(a: T[], b: T[]) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return a.length + b.length - 2 * dp[a.length][b.length];
}

describe("diff", () => {
  it("finds the shortest edit script on random inputs", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 400; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 14) }, () => "abcd"[Math.floor(rnd() * 4)]);
      const b = Array.from({ length: Math.floor(rnd() * 14) }, () => "abcd"[Math.floor(rnd() * 4)]);
      const { out, edits } = apply(a, b, diff(a, b));
      expect(out).toEqual(b);
      expect(edits).toBe(minEdits(a, b));
    }
  });

  it("falls back to a replacement when inputs are too different", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const ops = diff(a, b, undefined, 10);
    expect(apply(a, b, ops).out).toEqual(b);
  });
});

describe("wordDiff", () => {
  it("marks added and removed words", () => {
    expect(wordDiff("The amount is R45 000 per year", "The amount is R50 000 per student per year")).toEqual([
      { kind: "same", text: "The amount is" },
      { kind: "removed", text: "R45" },
      { kind: "added", text: "R50" },
      { kind: "same", text: "000" },
      { kind: "added", text: "per student" },
      { kind: "same", text: "per year" },
    ]);
  });

  it("can ignore upper/lower case", () => {
    expect(wordDiff("Bursary OFFICE", "bursary office", { ignoreCase: true }).every((p) => p.kind === "same")).toBe(true);
  });
});

const doc = (name: string, ...pages: string[]): DocText => ({ name, pages: pages.map((p) => p.split("\n")) });

describe("compareDocs", () => {
  const base = doc("v1.pdf", "Bursary Agreement\nAmount: R45 000\nDuration: 3 years", "Signed in Pretoria\nWitness: S. Dlamini");

  it("reports identical text as 100% the same", () => {
    const c = compareDocs(base, doc("copy.pdf", "Bursary  Agreement\nAmount: R45 000\nDuration: 3 years", "Signed in Pretoria\nWitness: S. Dlamini"));
    expect(c.similarity).toBe(1);
    expect(c.changes).toEqual([]);
  });

  it("ignores lines that were only re-wrapped", () => {
    const c = compareDocs(base, doc("rewrapped.pdf", "Bursary Agreement Amount: R45 000\nDuration: 3 years", "Signed in Pretoria\nWitness: S. Dlamini"));
    expect(c.changes).toEqual([]);
  });

  it("finds changed, added and removed text with page numbers", () => {
    const other = doc("v2.pdf", "Bursary Agreement\nAmount: R50 000\nDuration: 3 years\nIncludes books", "Signed in Pretoria");
    const c = compareDocs(base, other);
    expect(c.changes.map((ch) => [ch.basePage, ch.otherPage, ch.removed, ch.added])).toEqual([
      [1, 1, "Amount: R45 000", "Amount: R50 000"],
      [1, 1, "", "Includes books"],
      [2, null, "Witness: S. Dlamini", ""],
    ]);
    expect(c.wordsAdded).toBe(3); // R50, Includes, books
    expect(c.wordsRemoved).toBe(4); // R45, Witness:, S., Dlamini
    expect(c.similarity).toBeGreaterThan(0.5);
    expect(c.similarity).toBeLessThan(1);
    // The inline view covers the whole document in order.
    expect(c.blocks.map((b) => b.kind)).toEqual(["same", "change", "same", "change", "same", "change"]);
  });

  it("lines up several documents at the same spots", () => {
    const docs = [
      doc("a.pdf", "Bursary Agreement\nAmount: R50 000\nDuration: 3 years", "Signed in Pretoria\nWitness: S. Dlamini"),
      doc("b.pdf", "Bursary Agreement\nAmount: R45 000\nDuration: 4 years", "Signed in Pretoria\nWitness: S. Dlamini"),
      doc("c.pdf", "Bursary Agreement\nAmount: R60 000\nDuration: 3 years", "Signed in Pretoria\nWitness: S. Dlamini"),
    ];
    const spots = spotsAcross(docs.map((d) => compareDocs(base, d)));
    expect(spots.map((s) => [s.basePage, s.baseText, s.versions.map((v) => v?.added ?? "same")])).toEqual([
      [1, "Amount: R45 000", ["Amount: R50 000", "same", "Amount: R60 000"]],
      [1, "Duration: 3 years", ["same", "Duration: 4 years", "same"]],
    ]);
  });
});
