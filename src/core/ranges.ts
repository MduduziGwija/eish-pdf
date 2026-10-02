// Page-range helpers. Kept free of MuPDF so the UI can use them without loading the engine.

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * Parses "1-3, 5, 8-" into 0-based page groups: [[0,1,2],[4],[7..last]].
 * "-3" means 1 to 3 and "8-" means 8 to the last page.
 */
export function parsePageRanges(spec: string, totalPages: number): number[][] {
  const parts = spec.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new RangeError("Type some pages, e.g. 1-3, 5, 8-");
  return parts.map((part) => {
    const m = /^(\d*)\s*(?:(-)\s*(\d*))?$/.exec(part);
    if (!m || (m[1] === "" && (m[3] ?? "") === "")) throw new RangeError(`"${part}" isn't a page range.`);
    const start = m[1] === "" ? 1 : Number(m[1]);
    const end = m[2] ? (m[3] === "" ? totalPages : Number(m[3])) : start;
    if (start < 1 || end < 1) throw new RangeError("Pages start at 1.");
    if (start > totalPages || end > totalPages) {
      throw new RangeError(`"${part}" goes past the last page (${totalPages}).`);
    }
    if (start > end) throw new RangeError(`"${part}" runs backwards.`);
    return range(start - 1, end - 1);
  });
}
