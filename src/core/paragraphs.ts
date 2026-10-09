// Paragraphs: lines of a page that belong together, so they can be edited as one
// block that reflows (like Word or Acrobat), instead of one line at a time.
// Works for level text, sideways pages and tilted lines alike: each line is read
// in its own frame, along its baseline (u) and across it (v).

type Pt = [number, number];

/** What a line needs to say about itself to be grouped. */
export interface ParaLine {
  text: string;
  /** Where the baseline starts, on the page. */
  origin: Pt;
  /** Font size in points. */
  size: number;
  /** Direction the text runs (radians clockwise from right); 0 for level text. */
  angle: number;
  /** How far the text runs along its baseline. */
  length: number;
}

export type Align = "left" | "center" | "right";

export interface Paragraph<T extends ParaLine> {
  lines: T[];
  /** Distance between baselines (0 for a single line). */
  leading: number;
  align: Align;
  /** Left edge, right edge and baselines, in the paragraph's own frame. */
  left: number;
  right: number;
}

/** A point in a line's frame: u along the baseline, v across it (down). */
export const frameOf = ([x, y]: Pt, angle: number): Pt => [x * Math.cos(angle) + y * Math.sin(angle), -x * Math.sin(angle) + y * Math.cos(angle)];

/** The page point for a position in a frame. */
export const fromFrame = ([u, v]: Pt, angle: number): Pt => [u * Math.cos(angle) - v * Math.sin(angle), u * Math.sin(angle) + v * Math.cos(angle)];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

interface Placed<T extends ParaLine> {
  line: T;
  u0: number;
  u1: number;
  v: number;
}

/** Groups lines into paragraphs: same size, tilt and left edge (or centre), steady line spacing, and each line but the last running to the right margin. */
export function groupParagraphs<T extends ParaLine>(lines: T[], separated?: (above: T, below: T) => boolean): Paragraph<T>[] {
  // Lines of one page may run in different directions (a sideways stamp, say): each is placed in its own frame.
  const placed: Placed<T>[] = lines.map((line) => {
    const [u0, v] = frameOf(line.origin, line.angle);
    return { line, u0, u1: u0 + line.length, v };
  });
  placed.sort((a, b) => a.line.angle - b.line.angle || a.v - b.v || a.u0 - b.u0);

  interface Open {
    items: Placed<T>[];
    align: Align;
  }
  const open: Open[] = [];
  for (const cur of placed) {
    const size = cur.line.size;
    let best: { para: Open; gap: number } | undefined;
    for (const para of open) {
      const last = para.items.at(-1)!;
      const a = last.line;
      if (Math.abs(a.angle - cur.line.angle) > 0.06) continue;
      // A ruled line between them (the border between two table rows) keeps them apart.
      if (separated?.(a, cur.line)) continue;
      const ratio = cur.line.size / a.size;
      if (ratio < 0.85 || ratio > 1.18) continue;
      const gap = cur.v - last.v;
      const unit = (size + a.size) / 2;
      if (gap < 0.85 * unit || gap > 2.2 * unit) continue;
      if (para.items.length >= 2) {
        const leading = median(para.items.slice(1).map((it, i) => it.v - para.items[i].v));
        if (Math.abs(gap - leading) > 0.3 * leading) continue;
      }
      // They must sit in the same column.
      if (cur.u0 >= last.u1 || cur.u1 <= last.u0) continue;
      const right = Math.max(...para.items.map((it) => it.u1), cur.u1);
      const left = Math.min(...para.items.map((it) => it.u0));
      const centreA = (last.u0 + last.u1) / 2;
      const centreC = (cur.u0 + cur.u1) / 2;
      let align: Align | undefined;
      const leftEdge = para.items.length === 1 ? last.u0 : left;
      // Flush left (a first line may be indented a little), and the line above ran to the margin.
      if (Math.abs(cur.u0 - leftEdge) <= 0.9 * unit || (para.items.length === 1 && last.u0 - cur.u0 >= 0.5 * unit && last.u0 - cur.u0 <= 4 * unit)) {
        if (last.u1 >= right - 5 * unit && (para.align === "left" || para.items.length === 1)) align = "left";
      }
      // Centred: centres line up, left edges don't.
      if (!align && Math.abs(centreC - centreA) <= 0.8 * unit && Math.abs(cur.u0 - last.u0) > 0.9 * unit && (para.align === "center" || para.items.length === 1)) align = "center";
      // Flush right.
      if (!align && Math.abs(cur.u1 - last.u1) <= 0.9 * unit && Math.abs(cur.u0 - last.u0) > 0.9 * unit && (para.align === "right" || para.items.length === 1)) align = "right";
      if (!align) continue;
      if (!best || gap < best.gap) {
        best = { para, gap };
        para.align = align;
      }
    }
    if (best) best.para.items.push(cur);
    else open.push({ items: [cur], align: "left" });
  }

  return open
    .map((p): Paragraph<T> => {
      const items = p.items;
      const leading = items.length > 1 ? median(items.slice(1).map((it, i) => it.v - items[i].v)) : 0;
      return { lines: items.map((it) => it.line), leading, align: p.align, left: Math.min(...items.map((it) => it.u0)), right: Math.max(...items.map((it) => it.u1)) };
    })
    .sort((a, b) => a.lines[0].angle - b.lines[0].angle || frameOf(a.lines[0].origin, a.lines[0].angle)[1] - frameOf(b.lines[0].origin, b.lines[0].angle)[1] || a.left - b.left);
}

/** Joins a paragraph's lines into the text a person edits (line ends become spaces, hyphenated words are mended). */
export function paragraphText(lines: { text: string }[]): string {
  return lines
    .map((l) => l.text.trim())
    .reduce((acc, t) => (!acc ? t : /[A-Za-z]-$/.test(acc) && /^[a-z]/.test(t) ? acc.slice(0, -1) + t : `${acc} ${t}`), "");
}

/** Breaks text into lines no wider than `maxWidth` (greedy, at spaces; hard line breaks are kept). */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const hard of text.split("\n")) {
    let line = "";
    for (const word of hard.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next) > maxWidth) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export interface LaidOutLine {
  text: string;
  /** Where the baseline starts, on the page. */
  origin: Pt;
}

/**
 * Lays new lines out where a paragraph was: the first baseline stays, the
 * rest follow at the paragraph's own line spacing, aligned as it was.
 */
export function layoutParagraph<T extends ParaLine>(para: Paragraph<T>, lines: string[], width: (s: string) => number): LaidOutLine[] {
  const first = para.lines[0];
  const angle = first.angle;
  const [u0, v0] = frameOf(first.origin, angle);
  // A first line indented from the others keeps its indent.
  const rest = para.lines.slice(1).map((l) => frameOf(l.origin, angle)[0]);
  const body = rest.length ? median(rest) : u0;
  const leading = para.leading || first.size * 1.2;
  return lines.map((text, i) => {
    const w = width(text);
    let u = i === 0 ? u0 : body;
    if (para.align === "center") u = (para.left + para.right) / 2 - w / 2;
    else if (para.align === "right") u = para.right - w;
    return { text, origin: fromFrame([u, v0 + i * leading], angle) };
  });
}
