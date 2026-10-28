// Finds where one document ends and the next begins in a PDF that holds several
// (a batch of statements, a scan of many letters...), by looking for patterns:
//   - a page counter that starts over ("Page 1", "1 of 3"),
//   - an identifier that changes ("Student: 123", "Account no: 456", "Name: ..."),
//   - a heading that opens each document but is missing from the pages after it,
//   - blank separator pages.
// Pure functions over each page's text lines, so they run anywhere and are easy to test.

export type SignalKind = "counter" | "field" | "header" | "blank";

export interface Signal {
  id: string;
  kind: SignalKind;
  /** Short name for the pattern, e.g. "Student number changes". */
  title: string;
  /** What was seen, in plain words. */
  detail: string;
  /** Pages (0-based) that start a document; always includes 0. */
  starts: number[];
  /** Pages to leave out (blank separator pages). */
  drop: number[];
  /** A name for each document, when the pattern gives one (e.g. the identifier). */
  names: (string | undefined)[];
  /** How sure we are (0-1). */
  score: number;
}

export interface Analysis {
  pages: number;
  /** Most likely first. */
  signals: Signal[];
  /** Most pages have no text: a scan that needs OCR before it can be analysed. */
  scanned: boolean;
}

const clean = (lines: string[]) => lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
const words = (lines: string[]) => lines.join(" ").split(/\s+/).filter(Boolean).length;
const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const title = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

// --- Page counter ------------------------------------------------------------

interface Counter {
  n: number;
  total?: number;
}

/** "Page 3", "PAGE: 1", "3 of 7", "Page 2/5": the first page number found near the top or bottom of the page. */
export function pageCounter(lines: string[]): Counter | undefined {
  const near = [...lines.slice(0, 12), ...lines.slice(-8)];
  for (const line of near) {
    const word = /\bpage\s*(?:no\.?|number)?\s*[:#.]?\s*(\d{1,4})\b(?:\s*(?:of|\/)\s*(\d{1,4})\b)?/i.exec(line);
    if (word) return { n: Number(word[1]), total: word[2] ? Number(word[2]) : undefined };
  }
  for (const line of near) {
    if (/\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}/.test(line)) continue; // a date
    const of = /(?:^|\s)(\d{1,3})\s+of\s+(\d{1,3})(?:\s|$)/i.exec(line);
    if (of && Number(of[1]) <= Number(of[2])) return { n: Number(of[1]), total: Number(of[2]) };
  }
  return undefined;
}

function counterSignal(pages: string[][]): Signal | undefined {
  const counters = pages.map(pageCounter);
  const have = counters.filter(Boolean).length;
  if (pages.length < 2 || have < Math.max(2, pages.length * 0.6)) return undefined;
  const starts = [0];
  let prev: Counter | undefined;
  for (let i = 0; i < pages.length; i++) {
    const c = counters[i];
    if (!c) continue;
    if (i > 0 && prev && (c.n === 1 || c.n <= prev.n) && !(c.n === prev.n + 1)) starts.push(i);
    prev = c;
  }
  if (starts.length < 2) return undefined;
  return {
    id: "counter",
    kind: "counter",
    title: "Page numbers start over",
    detail: `The page counter goes back to 1 ${starts.length - 1} time${starts.length === 2 ? "" : "s"}.`,
    starts,
    drop: [],
    names: starts.map(() => undefined),
    score: 0.85,
  };
}

// --- Identifier that changes ---------------------------------------------------

const ID_WORDS = /student|account|acc\b|\bid\b|identity|number|\bno\b|ref|invoice|policy|employee|staff|customer|client|member|case|reg|patient|claim|order|file|name|surname|holder|candidate|learner/i;
const NOT_ID = /^(date|time|page|printed|statement date|transactions? up to|total|balance|amount|period|due|currency|tel|phone|fax|email)/i;
const DATEISH = /^\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{2,4}|^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|^\d{1,2}H\d{2}/i;

/** "Label: value" pairs on a page (first of each label). */
export function labelledValues(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z][A-Za-z.#/ ]{0,28}?)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-._/]{1,30}(?:\s[A-Za-z0-9\-._/]{1,20})?)/g)) {
      const label = m[1].trim().toLowerCase().replace(/\s+/g, " ");
      const value = m[2].trim();
      if (label.length < 2 || NOT_ID.test(label) || DATEISH.test(value)) continue;
      if (!out.has(label)) out.set(label, value);
    }
  }
  return out;
}

function fieldSignals(pages: string[][]): Signal[] {
  const perPage = pages.map(labelledValues);
  const labels = new Set(perPage.flatMap((m) => [...m.keys()]));
  const out: Signal[] = [];
  const counterStarts = counterSignal(pages)?.starts;
  for (const label of labels) {
    const have = perPage.filter((m) => m.has(label)).length;
    if (have < Math.max(2, pages.length * 0.7)) continue;
    // Carry the last value over pages that lack the label.
    const values: string[] = [];
    let last = "";
    for (const m of perPage) {
      last = m.get(label) ?? last;
      values.push(last);
    }
    const starts = [0];
    for (let i = 1; i < values.length; i++) if (values[i] && values[i] !== values[i - 1]) starts.push(i);
    if (starts.length < 2) continue;
    const distinct = new Set(values).size;
    const contiguous = distinct / starts.length; // 1 = every value sits in one block
    if (contiguous < 0.6) continue;
    const idLike = values.filter((v) => /\d{4,}/.test(v)).length / values.length;
    let score = 0.5 + (ID_WORDS.test(label) ? 0.15 : 0) + 0.1 * idLike + 0.1 * contiguous;
    if (counterStarts && sameList(counterStarts, starts)) score += 0.1;
    // A label that changes on every single page is usually a per-page number, not a person.
    if (starts.length === pages.length && pages.length > 3) score -= 0.25;
    out.push({
      id: `field:${label}`,
      kind: "field",
      title: `${title(label)} changes`,
      detail: `"${title(label)}" has ${starts.length} different value${starts.length === 1 ? "" : "s"} in a row of blocks.`,
      starts,
      drop: [],
      names: starts.map((s) => values[s]),
      score: Math.min(0.97, score),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

// --- Opening heading -----------------------------------------------------------

const shape = (line: string) => line.replace(/\d+/g, "#").toLowerCase();

function headerSignal(pages: string[][]): Signal | undefined {
  if (pages.length < 3) return undefined;
  const seen = new Map<string, Set<number>>();
  pages.forEach((p, i) => {
    for (const line of new Set(p.slice(0, 3).map(shape))) {
      if (line.length < 3 || line.length > 60) continue;
      (seen.get(line) ?? seen.set(line, new Set()).get(line)!).add(i);
    }
  });
  let best: { line: string; pagesWith: number[] } | undefined;
  for (const [line, set] of seen) {
    const list = [...set].sort((a, b) => a - b);
    // On some pages but not all, and including the first one: it opens each document.
    if (list.length < 2 || list.length > pages.length * 0.85 || list[0] !== 0) continue;
    if (!best || list.length > best.pagesWith.length) best = { line, pagesWith: list };
  }
  if (!best) return undefined;
  return {
    id: "header",
    kind: "header",
    title: "Opening heading repeats",
    detail: `"${best.line.replace(/#/g, "…").slice(0, 40)}" opens ${best.pagesWith.length} documents.`,
    starts: best.pagesWith,
    drop: [],
    names: best.pagesWith.map(() => undefined),
    score: 0.6,
  };
}

// --- Blank separators ------------------------------------------------------------

function blankSignal(pages: string[][]): Signal | undefined {
  const blanks = pages.map((p, i) => ({ i, blank: words(p) < 3 })).filter((x) => x.blank).map((x) => x.i);
  const inner = blanks.filter((i) => i > 0 && i < pages.length - 1);
  if (inner.length === 0 || inner.length > pages.length / 2) return undefined;
  const starts = [0, ...inner.map((i) => i + 1).filter((i) => i < pages.length && !inner.includes(i))];
  const unique = [...new Set(starts)].sort((a, b) => a - b);
  if (unique.length < 2) return undefined;
  return {
    id: "blank",
    kind: "blank",
    title: "Blank separator pages",
    detail: `${inner.length} blank page${inner.length === 1 ? "" : "s"} between documents (left out).`,
    starts: unique,
    drop: inner,
    names: unique.map(() => undefined),
    score: 0.7,
  };
}

/** Looks for the ways one document ends and the next begins. Page text is one array of lines per page. */
export function analyseSplit(rawPages: string[][]): Analysis {
  const pages = rawPages.map(clean);
  const empty = pages.filter((p) => words(p) < 3).length;
  const scanned = pages.length > 0 && empty / pages.length > 0.6;
  if (scanned) return { pages: pages.length, signals: [], scanned };
  const signals: Signal[] = [];
  const counter = counterSignal(pages);
  if (counter) signals.push(counter);
  signals.push(...fieldSignals(pages));
  const header = headerSignal(pages);
  if (header) signals.push(header);
  const blank = blankSignal(pages);
  if (blank) signals.push(blank);
  // An identifier that agrees with the page counter is the surest sign of all.
  signals.sort((a, b) => b.score - a.score);
  return { pages: pages.length, signals, scanned };
}

/** The documents a pattern makes: 0-based page lists (separator pages removed). */
export function groupsFor(starts: number[], pageCount: number, drop: number[] = []): number[][] {
  const cut = [...new Set([0, ...starts])].filter((s) => s >= 0 && s < pageCount).sort((a, b) => a - b);
  const skip = new Set(drop);
  return cut
    .map((s, k) => {
      const end = (cut[k + 1] ?? pageCount) - 1;
      const pagesOf: number[] = [];
      for (let p = s; p <= end; p++) if (!skip.has(p)) pagesOf.push(p);
      return pagesOf;
    })
    .filter((g) => g.length > 0);
}

/** A safe file name piece from a label ("2230 74" -> "2230_74"). */
export const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
