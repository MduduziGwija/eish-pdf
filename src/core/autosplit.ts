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

const KEY = /^(student|account|acc|id|identity|number|no|nr|ref|reference|invoice|policy|employee|staff|customer|client|member|case|reg|registration|patient|claim|order|file|name|surname|holder|candidate|learner|date|time|page|total|balance|amount|period|due|tel|phone|email|statement|transactions?|up|to)$/i;

/** The label in front of a colon, without other text that happens to sit before it ("TOWN   Student" -> "student"). */
function labelOf(raw: string): string {
  const words = raw.trim().toLowerCase().split(/\s+/);
  const last = words[words.length - 1];
  const prev = words[words.length - 2];
  if (words.length === 1) return last;
  if (KEY.test(last)) return prev && KEY.test(prev) ? `${prev} ${last}` : last;
  return words.slice(-2).join(" ");
}

/** "Label: value" pairs on a page (first of each label). */
export function labelledValues(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z][A-Za-z.#/ ]{0,28}?)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-._/]{1,30}(?:\s[A-Za-z0-9\-._/]{1,20})?)/g)) {
      const label = labelOf(m[1]);
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

// --- Naming each document ------------------------------------------------------------

export interface DocInfo {
  /** A person's name (titles removed), e.g. "KP HLAHLA". */
  name?: string;
  /** An identifier that differs from document to document (student, account, ID number...). */
  id?: string;
  /** What kind of document it is, e.g. "Statement". */
  type?: string;
}

const TITLES = "MR|MRS|MS|MISS|MNR|MEV|MEJ|DR|PROF|ADV|HON|REV|SIR|MX";
// Words that end a name when a line reads "MR KP HLAHLA   PAGE: 1".
const STOP = /\b(PAGE|STUDENT|DATE|TEL|PHONE|CELL|NO|NR|NUMBER|ID|REF|REFERENCE|ACCOUNT|ACC|STATEMENT|INVOICE|COPY|FAX|EMAIL|ADDRESS|DOB|BORN|TRANSACTIONS|OF)\b.*$/i;
const TYPES = /^(statement|invoice|tax invoice|receipt|payslip|pay slip|certificate|letter|report|quotation|quote|contract|agreement|application|results?|academic record|transcript|form|policy|notice|summary|schedule|account|fee account|credit note|debit note|order|delivery note|certificate of|offer|reference|affidavit|permit|licen[cs]e|booking|ticket|bill|payment advice|remittance)\b/i;

const SMALL = new Set(["of", "and", "for", "the", "to", "in", "on", "a", "an", "van", "de", "der"]);
const titleCase = (text: string) =>
  text
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");

const properCase = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");

function findName(lines: string[]): string | undefined {
  const top = lines.slice(0, 14);
  // "Name: Thandi Dlamini", "Account holder: ...", "Surname: ..."
  for (const line of top) {
    const m = /\b(?:full name|student name|employee name|customer name|account holder|holder|candidate|learner|patient|surname|name)\s*[:：]\s*([A-Za-z][A-Za-z'’.\- ]{2,40})/i.exec(line);
    if (m) {
      const v = m[1].replace(STOP, "").trim();
      if (v.split(/\s+/).length >= 1 && v.length > 2) return v;
    }
  }
  // "MR KP HLAHLA   PAGE: 1", "Dr J Smith"
  const titled = new RegExp(`(?:^|\\s)(?:${TITLES})\\.?\\s+([A-Za-z][A-Za-z'’.\\-]*(?:\\s+[A-Za-z][A-Za-z'’.\\-]*){0,3})`, "i");
  for (const line of top) {
    const m = titled.exec(line);
    if (!m) continue;
    const v = m[1].replace(STOP, "").trim();
    if (v.length > 2) return v;
  }
  // A line that is just a name: two to four capitalised words, no digits.
  for (const line of top.slice(0, 8)) {
    if (/\d|[:@/]/.test(line)) continue;
    const w = line.split(/\s+/);
    if (w.length < 2 || w.length > 4 || TYPES.test(line)) continue;
    if (w.every((x) => /^[A-Z][A-Za-z'’.\-]+$/.test(x) && x.length > 1) && (line === line.toUpperCase() || w.every((x) => /^[A-Z][a-z'’.\-]+$/.test(x)))) return line;
  }
  return undefined;
}

function findType(lines: string[]): string | undefined {
  for (const line of lines.slice(0, 4)) {
    const t = line.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 40 || /\d{3,}/.test(t)) continue;
    if (TYPES.test(t)) return titleCase(t.replace(/[:.]+$/, ""));
  }
  const first = lines[0]?.trim();
  if (first && /^[A-Za-z][A-Za-z &/-]{2,28}$/.test(first) && first.split(/\s+/).length <= 3) return titleCase(first);
  return undefined;
}

/** Names, identifiers and types read from the first page of each document. `starts` and `drop` are as in groupsFor. */
export function describeDocs(rawPages: string[][], starts: number[], drop: number[] = []): DocInfo[] {
  const pages = rawPages.map(clean);
  const groups = groupsFor(starts, pages.length, drop);
  const firsts = groups.map((g) => pages[g[0]]);
  const infos: DocInfo[] = firsts.map((lines) => ({ name: findName(lines), type: findType(lines) }));

  // An identifier that is different in every document: a labelled value first, then a long number.
  const perDoc = firsts.map(labelledValues);
  const labels = new Set(perDoc.flatMap((m) => [...m.keys()]));
  let best: { label: string; values: string[]; rank: number } | undefined;
  for (const label of labels) {
    const values = perDoc.map((m) => m.get(label));
    if (groups.length > 1 && (values.some((v) => !v) || new Set(values).size !== values.length)) continue;
    if (groups.length === 1 && !values[0]) continue;
    const digits = values.filter((v) => /\d{4,}/.test(v ?? "")).length / values.length;
    if (digits < 0.8 && !ID_WORDS.test(label)) continue;
    const rank = (ID_WORDS.test(label) ? 2 : 0) + digits;
    if (!best || rank > best.rank) best = { label, values: values as string[], rank };
  }
  if (best) best.values.forEach((v, i) => (infos[i].id = v));
  else {
    const numbers = firsts.map((l) => /\b\d{6,}\b/.exec(l.join(" "))?.[0]);
    if (groups.length > 1 && numbers.every(Boolean) && new Set(numbers).size === numbers.length) numbers.forEach((n, i) => (infos[i].id = n));
  }
  return infos;
}

export type NameScheme = "auto" | "id" | "name" | "name-id" | "type-id" | "type-name" | "part";

export const SCHEMES: { id: NameScheme; label: string }[] = [
  { id: "auto", label: "Automatic (best available)" },
  { id: "id", label: "ID / account number" },
  { id: "name", label: "Person's name" },
  { id: "name-id", label: "Name and ID" },
  { id: "type-id", label: "Document type and ID" },
  { id: "type-name", label: "Document type and name" },
  { id: "part", label: "Numbered (part 1, 2, 3…)" },
];

/** The file name (without .pdf) for document `k` (0-based). `prefix` is used only for numbered parts and as a last resort. */
export function buildName(scheme: NameScheme, info: DocInfo, k: number, prefix: string): string {
  const nm = info.name ? properCase(info.name) : undefined;
  const bits = (...parts: (string | undefined)[]) => parts.filter(Boolean).map((p) => fileSafe(p!)).filter(Boolean).join("_");
  const part = `${prefix}_part${k + 1}`;
  switch (scheme) {
    case "id":
      return bits(info.id) || part;
    case "name":
      return bits(nm) || part;
    case "name-id":
      return bits(nm, info.id) || part;
    case "type-id":
      return bits(info.type, info.id) || part;
    case "type-name":
      return bits(info.type, nm) || part;
    case "part":
      return part;
    default:
      return bits(nm, info.id) || bits(info.id) || bits(nm) || (info.type ? bits(info.type, String(k + 1)) : "") || part;
  }
}
