// Comparing the text of PDFs. Plain TypeScript (no MuPDF), so it runs in the
// worker and in tests. Lines are compared first, then the words inside
// changed lines, which keeps it fast on long documents.

/** A document's text: lines per page. */
export interface DocText {
  name: string;
  pages: string[][];
}

export type PieceKind = "same" | "added" | "removed";
export interface Piece {
  kind: PieceKind;
  text: string;
}

/** One place where the other document differs from the base. */
export interface Change {
  /** 1-based page numbers (null when the text only exists on one side). */
  basePage: number | null;
  otherPage: number | null;
  /** Index of the first base line this change touches (for lining up several documents). */
  baseLine: number;
  removed: string;
  added: string;
  /** Word-level detail of this change. */
  pieces: Piece[];
}

/** The whole document, as runs of unchanged lines and changes, for the inline view. */
export type Block = { kind: "same"; lines: string[]; basePage: number } | { kind: "change"; change: Change };

export interface Comparison {
  base: string;
  other: string;
  /** 0–1: share of words that are the same. */
  similarity: number;
  wordsAdded: number;
  wordsRemoved: number;
  changes: Change[];
  blocks: Block[];
  basePages: number;
  otherPages: number;
}

export interface CompareOptions {
  ignoreCase?: boolean;
}

type Op = { type: "equal" | "delete" | "insert"; a: number; b: number; n: number };

/**
 * Myers' diff: the shortest edit script turning `a` into `b`. Above `maxD`
 * edits it gives up on the middle and reports it as a plain replacement,
 * so wildly different inputs stay quick.
 */
export function diff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y, maxD = 1500): Op[] {
  // Trim the common start and end first: usually most of the document.
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  const push = (type: Op["type"], ai: number, bi: number, n: number) => {
    if (n <= 0) return;
    const last = ops[ops.length - 1];
    if (last && last.type === type && last.a + (type === "insert" ? 0 : last.n) === ai && last.b + (type === "delete" ? 0 : last.n) === bi) last.n += n;
    else ops.push({ type, a: ai, b: bi, n });
  };
  push("equal", 0, 0, start);
  middle(a, b, start, endA, start, endB, eq, maxD, push);
  push("equal", endA, endB, a.length - endA);
  return ops;
}

function middle<T>(
  a: T[],
  b: T[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  eq: (x: T, y: T) => boolean,
  maxD: number,
  push: (type: Op["type"], ai: number, bi: number, n: number) => void,
) {
  const N = a1 - a0;
  const M = b1 - b0;
  if (N === 0 || M === 0) {
    push("delete", a0, b0, N);
    push("insert", a1, b0, M);
    return;
  }
  const max = Math.min(N + M, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && eq(a[a0 + x], b[b0 + y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    // Too different to align cheaply: call the whole middle a replacement.
    push("delete", a0, b0, N);
    push("insert", a1, b0, M);
    return;
  }
  // Walk the trace backwards to recover the script (trace[d] is V before step d).
  const steps: Op[] = [];
  let x = N;
  let y = M;
  for (let d = found; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1]) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : vv[offset + prevK];
    const py = d === 0 ? 0 : px - prevK;
    // Diagonal (matching) run back to where this step's move ended.
    const endX = d === 0 ? 0 : prevK === k + 1 ? px : px + 1;
    const run = x - endX;
    if (run > 0) steps.push({ type: "equal", a: a0 + endX, b: b0 + y - run, n: run });
    if (d > 0) {
      if (prevK === k + 1) steps.push({ type: "insert", a: a0 + px, b: b0 + py, n: 1 });
      else steps.push({ type: "delete", a: a0 + px, b: b0 + py, n: 1 });
    }
    x = px;
    y = py;
  }
  for (let i = steps.length - 1; i >= 0; i--) push(steps[i].type, steps[i].a, steps[i].b, steps[i].n);
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);
export const normalise = (line: string) => line.replace(/\s+/g, " ").trim();

/** Word-by-word differences between two pieces of text. */
export function wordDiff(before: string, after: string, opts: CompareOptions = {}): Piece[] {
  const a = words(before);
  const b = words(after);
  const key = (w: string) => (opts.ignoreCase ? w.toLowerCase() : w);
  const pieces: Piece[] = [];
  const add = (kind: PieceKind, list: string[]) => {
    if (!list.length) return;
    const last = pieces[pieces.length - 1];
    if (last?.kind === kind) last.text += " " + list.join(" ");
    else pieces.push({ kind, text: list.join(" ") });
  };
  for (const op of diff(a, b, (x, y) => key(x) === key(y), 2000)) {
    if (op.type === "equal") add("same", b.slice(op.b, op.b + op.n));
    else if (op.type === "delete") add("removed", a.slice(op.a, op.a + op.n));
    else add("added", b.slice(op.b, op.b + op.n));
  }
  return pieces;
}

interface Line {
  text: string;
  page: number;
}

const flatten = (doc: DocText): Line[] =>
  doc.pages.flatMap((lines, p) => lines.map(normalise).filter(Boolean).map((text) => ({ text, page: p + 1 })));

export function compareDocs(base: DocText, other: DocText, opts: CompareOptions = {}): Comparison {
  const a = flatten(base);
  const b = flatten(other);
  const key = (l: Line) => (opts.ignoreCase ? l.text.toLowerCase() : l.text);
  const ops = diff(a, b, (x, y) => key(x) === key(y), 3000);

  const changes: Change[] = [];
  const blocks: Block[] = [];
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let wordsSame = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "equal") {
      const lines = a.slice(op.a, op.a + op.n);
      wordsSame += lines.reduce((n, l) => n + words(l.text).length, 0);
      blocks.push({ kind: "same", lines: lines.map((l) => l.text), basePage: lines[0].page });
      continue;
    }
    // A delete followed by an insert (or the reverse) is one change.
    let removedLines: Line[] = [];
    let addedLines: Line[] = [];
    let baseLine = op.a;
    while (i < ops.length && ops[i].type !== "equal") {
      const o = ops[i];
      if (o.type === "delete") removedLines = removedLines.concat(a.slice(o.a, o.a + o.n));
      else addedLines = addedLines.concat(b.slice(o.b, o.b + o.n));
      baseLine = Math.min(baseLine, o.a);
      i++;
    }
    i--;
    const removed = removedLines.map((l) => l.text).join(" ");
    const added = addedLines.map((l) => l.text).join(" ");
    const pieces = wordDiff(removed, added, opts);
    // Line breaks can move without the words changing: not a real difference.
    if (pieces.every((p) => p.kind === "same")) {
      wordsSame += words(added).length;
      blocks.push({ kind: "same", lines: addedLines.map((l) => l.text), basePage: removedLines[0]?.page ?? addedLines[0]?.page ?? 1 });
      continue;
    }
    for (const p of pieces) {
      const n = words(p.text).length;
      if (p.kind === "same") wordsSame += n;
      else if (p.kind === "added") wordsAdded += n;
      else wordsRemoved += n;
    }
    const change: Change = {
      basePage: removedLines[0]?.page ?? a[baseLine]?.page ?? a[a.length - 1]?.page ?? null,
      otherPage: addedLines[0]?.page ?? null,
      baseLine,
      removed,
      added,
      pieces,
    };
    if (!removedLines.length) change.basePage = a[baseLine - 1]?.page ?? a[baseLine]?.page ?? null;
    changes.push(change);
    blocks.push({ kind: "change", change });
  }

  const total = wordsSame + Math.max(wordsAdded, wordsRemoved);
  return {
    base: base.name,
    other: other.name,
    similarity: total === 0 ? 1 : wordsSame / total,
    wordsAdded,
    wordsRemoved,
    changes,
    blocks,
    basePages: base.pages.length,
    otherPages: other.pages.length,
  };
}

/** One row of the "where they differ" table: a spot in the base and each document's version. */
export interface Spot {
  baseLine: number;
  basePage: number | null;
  baseText: string;
  /** Per compared document: its change at this spot, or null if it matches the base here. */
  versions: (Change | null)[];
}

/** Lines up the changes of several comparisons (all against the same base) by position. */
export function spotsAcross(comparisons: Comparison[]): Spot[] {
  const byLine = new Map<number, Spot>();
  comparisons.forEach((c, idx) => {
    for (const change of c.changes) {
      let spot = byLine.get(change.baseLine);
      if (!spot) {
        spot = { baseLine: change.baseLine, basePage: change.basePage, baseText: change.removed, versions: comparisons.map(() => null) };
        byLine.set(change.baseLine, spot);
      }
      // Keep the longest base text when documents touch overlapping lines.
      if (change.removed.length > spot.baseText.length) spot.baseText = change.removed;
      spot.versions[idx] = change;
    }
  });
  return [...byLine.values()].sort((x, y) => x.baseLine - y.baseLine);
}
