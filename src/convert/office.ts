// Reads Word, Excel and PowerPoint files in the browser and turns them into
// HTML (Word, Excel) or a slide description (PowerPoint) that the PDF engine
// lays out. Uses DOMParser, so it runs on the main thread.
import { strFromU8, unzipSync } from "fflate";
import type { Slide, SlideParagraph, SlideItem } from "../core/slides";

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
};

const BASE_CSS = `
@page { size: 595pt 842pt; margin: 54pt 54pt 60pt 54pt; }
body { font-family: sans-serif; font-size: 11pt; line-height: 1.35; color: #1b1b1f; }
h1 { font-size: 22pt; margin: 0 0 10pt; } h2 { font-size: 16pt; margin: 14pt 0 6pt; } h3 { font-size: 13pt; margin: 12pt 0 4pt; }
p { margin: 0 0 7pt; } img { max-width: 100%; }
table { border-collapse: collapse; margin: 6pt 0 10pt; }
td, th { border: 0.75pt solid #9a9aa2; padding: 3pt 5pt; vertical-align: top; }
th { background: #eeeef0; }
`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(body: string, extraCss = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

// --- Word ----------------------------------------------------------------------

export async function wordToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  // The browser build reads an ArrayBuffer; under Node (tests) it wants a Buffer.
  const inNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
  const input = inNode ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  const { value } = await mammoth.convertToHtml(
    input as { arrayBuffer: ArrayBuffer },
    { styleMap: ["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => h2.subtitle:fresh"] },
  );
  return page(value, "td p, th p { margin: 0; } table { width: 100%; }");
}

// --- Excel ---------------------------------------------------------------------

function xml(files: Record<string, Uint8Array>, path: string): Document | undefined {
  const f = files[path];
  return f ? new DOMParser().parseFromString(strFromU8(f), "application/xml") : undefined;
}

const children = (el: Element | Document | null | undefined, ns: string, name: string): Element[] =>
  el ? Array.from(el.getElementsByTagNameNS(ns, name)) : [];

function relsOf(files: Record<string, Uint8Array>, path: string): Map<string, string> {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const relPath = `${dir}_rels/${path.slice(dir.length)}.rels`;
  const map = new Map<string, string>();
  for (const r of children(xml(files, relPath), NS.rel, "Relationship")) {
    map.set(r.getAttribute("Id")!, resolvePath(dir, r.getAttribute("Target")!));
  }
  return map;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const rowIndex = (ref: string) => Number(/\d+/.exec(ref)?.[0] ?? 1) - 1;

const DATE_FORMATS = new Set([14, 15, 16, 17, 22]);
const excelDate = (serial: number) => {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return d.toISOString().slice(0, serial % 1 ? 16 : 10).replace("T", " ");
};

const MAX_ROWS = 3000;
const MAX_COLS = 60;

/** Each sheet becomes a heading and a table. Wide sheets go on landscape pages. */
export function excelToHtml(bytes: Uint8Array): { html: string; landscape: boolean } {
  const files = unzipSync(bytes);
  const wb = xml(files, "xl/workbook.xml");
  if (!wb) throw new Error("This doesn't look like an Excel (.xlsx) file.");
  const rels = relsOf(files, "xl/workbook.xml");

  const shared = children(xml(files, "xl/sharedStrings.xml"), NS.s, "si").map((si) =>
    children(si, NS.s, "t")
      .map((t) => t.textContent ?? "")
      .join(""),
  );

  // Styles: which cell formats are bold, and which are dates.
  const styles = xml(files, "xl/styles.xml");
  const boldFonts = children(styles?.getElementsByTagNameNS(NS.s, "fonts")[0], NS.s, "font").map((f) => f.getElementsByTagNameNS(NS.s, "b").length > 0);
  const customDates = new Set(
    children(styles, NS.s, "numFmt")
      .filter((f) => /[dmy]/i.test((f.getAttribute("formatCode") ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "")))
      .map((f) => Number(f.getAttribute("numFmtId"))),
  );
  const xfs = children(styles?.getElementsByTagNameNS(NS.s, "cellXfs")[0], NS.s, "xf").map((xf) => {
    const fmt = Number(xf.getAttribute("numFmtId") ?? 0);
    return { bold: boldFonts[Number(xf.getAttribute("fontId") ?? 0)] ?? false, date: DATE_FORMATS.has(fmt) || customDates.has(fmt) };
  });

  let maxCols = 0;
  let body = "";
  for (const sheet of children(wb, NS.s, "sheet")) {
    if (sheet.getAttribute("state") === "hidden") continue;
    const path = rels.get(sheet.getAttributeNS(NS.r, "id") ?? "");
    const doc = path ? xml(files, path) : undefined;
    if (!doc) continue;

    const grid: { text: string; bold: boolean; number: boolean }[][] = [];
    let cols = 0;
    for (const c of children(doc, NS.s, "c")) {
      const ref = c.getAttribute("r") ?? "A1";
      const r = rowIndex(ref);
      const col = colIndex(ref);
      if (r >= MAX_ROWS || col >= MAX_COLS) continue;
      const type = c.getAttribute("t");
      const v = c.getElementsByTagNameNS(NS.s, "v")[0]?.textContent ?? "";
      const style = xfs[Number(c.getAttribute("s") ?? 0)] ?? { bold: false, date: false };
      let text = v;
      let number = false;
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = children(c, NS.s, "t").map((t) => t.textContent ?? "").join("");
      else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (type !== "str" && type !== "e" && v !== "") {
        number = true;
        const n = Number(v);
        text = style.date ? excelDate(n) : Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
      }
      if (!text) continue;
      (grid[r] ??= [])[col] = { text, bold: style.bold, number };
      cols = Math.max(cols, col + 1);
    }

    // Merged cells span several columns/rows.
    const spans = new Map<string, { cs: number; rs: number }>();
    const hidden = new Set<string>();
    for (const m of children(doc, NS.s, "mergeCell")) {
      const [a, b] = (m.getAttribute("ref") ?? "").split(":");
      if (!a || !b) continue;
      const [r0, c0, r1, c1] = [rowIndex(a), colIndex(a), rowIndex(b), colIndex(b)];
      spans.set(`${r0},${c0}`, { cs: c1 - c0 + 1, rs: r1 - r0 + 1 });
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) hidden.add(`${r},${c}`);
    }

    // Drop empty leading/trailing rows.
    const firstRow = grid.findIndex((row) => row?.some(Boolean));
    if (firstRow === -1) continue;
    maxCols = Math.max(maxCols, cols);
    let rows = "";
    for (let r = firstRow; r < grid.length; r++) {
      let cells = "";
      for (let c = 0; c < cols; c++) {
        if (hidden.has(`${r},${c}`)) continue;
        const cell = grid[r]?.[c];
        const span = spans.get(`${r},${c}`);
        const attrs = (span ? ` colspan="${span.cs}" rowspan="${span.rs}"` : "") + (cell?.number ? ' class="n"' : "");
        const content = cell ? (cell.bold ? `<b>${escapeHtml(cell.text)}</b>` : escapeHtml(cell.text)) : "";
        cells += `<td${attrs}>${content}</td>`;
      }
      rows += `<tr>${cells}</tr>`;
    }
    body += `<h2>${escapeHtml(sheet.getAttribute("name") ?? "Sheet")}</h2><table>${rows}</table>`;
  }
  if (!body) throw new Error("This spreadsheet is empty.");
  const landscape = maxCols > 7;
  const css = `td { font-size: ${maxCols > 12 ? 7 : 9}pt; } td.n { text-align: right; }` + (landscape ? "@page { size: 842pt 595pt; margin: 36pt; }" : "");
  return { html: page(body, css), landscape };
}

// --- PowerPoint ----------------------------------------------------------------

const EMU = 12700; // per point

function srgb(el: Element | undefined | null): [number, number, number] | undefined {
  const c = el?.getElementsByTagNameNS(NS.a, "srgbClr")[0]?.getAttribute("val");
  if (!c) return undefined;
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
}

interface Placeholder {
  type: string;
  idx: string;
  box?: [number, number, number, number];
}

function boxOf(el: Element): [number, number, number, number] | undefined {
  const xfrm = el.getElementsByTagNameNS(NS.a, "xfrm")[0];
  const off = xfrm?.getElementsByTagNameNS(NS.a, "off")[0];
  const ext = xfrm?.getElementsByTagNameNS(NS.a, "ext")[0];
  if (!off || !ext) return undefined;
  return [Number(off.getAttribute("x")) / EMU, Number(off.getAttribute("y")) / EMU, Number(ext.getAttribute("cx")) / EMU, Number(ext.getAttribute("cy")) / EMU];
}

function placeholderOf(sp: Element): Placeholder | undefined {
  const ph = sp.getElementsByTagNameNS(NS.p, "ph")[0];
  if (!ph) return undefined;
  return { type: ph.getAttribute("type") ?? "body", idx: ph.getAttribute("idx") ?? "", box: boxOf(sp) };
}

function placeholders(doc: Document | undefined): Placeholder[] {
  return children(doc, NS.p, "sp")
    .map(placeholderOf)
    .filter((p): p is Placeholder => !!p);
}

const DEFAULT_SIZES: Record<string, number> = { title: 40, ctrTitle: 44, subTitle: 24, body: 22 };

/** Text boxes, titles and pictures at their real positions on each slide. */
export function pptxToSlides(bytes: Uint8Array): Slide[] {
  const files = unzipSync(bytes);
  const pres = xml(files, "ppt/presentation.xml");
  if (!pres) throw new Error("This doesn't look like a PowerPoint (.pptx) file.");
  const size = pres.getElementsByTagNameNS(NS.p, "sldSz")[0];
  const width = Number(size?.getAttribute("cx") ?? 9144000) / EMU;
  const height = Number(size?.getAttribute("cy") ?? 5143500) / EMU;
  const presRels = relsOf(files, "ppt/presentation.xml");

  const slides: Slide[] = [];
  for (const id of children(pres, NS.p, "sldId")) {
    const path = presRels.get(id.getAttributeNS(NS.r, "id") ?? "");
    const doc = path ? xml(files, path) : undefined;
    if (!path || !doc) continue;
    const rels = relsOf(files, path);
    const layoutPath = [...rels.values()].find((t) => t.includes("slideLayouts/"));
    const layoutPh = placeholders(layoutPath ? xml(files, layoutPath) : undefined);
    const masterPath = layoutPath ? [...relsOf(files, layoutPath).values()].find((t) => t.includes("slideMasters/")) : undefined;
    const masterPh = placeholders(masterPath ? xml(files, masterPath) : undefined);
    const inherited = (ph: Placeholder) => {
      const match = (list: Placeholder[]) =>
        list.find((p) => p.box && ph.idx && p.idx === ph.idx) ?? list.find((p) => p.box && p.type === ph.type) ?? list.find((p) => p.box && ph.type === "ctrTitle" && p.type === "title");
      return match(layoutPh)?.box ?? match(masterPh)?.box;
    };

    const items: SlideItem[] = [];
    const tree = doc.getElementsByTagNameNS(NS.p, "spTree")[0];
    for (const el of tree ? Array.from(tree.getElementsByTagNameNS("*", "*")) : []) {
      if (el.namespaceURI !== NS.p) continue;
      if (el.localName === "sp") {
        const ph = placeholderOf(el);
        const box = boxOf(el) ?? (ph ? inherited(ph) : undefined);
        const body = el.getElementsByTagNameNS(NS.p, "txBody")[0];
        if (!box || !body) continue;
        const isTitle = ph?.type === "title" || ph?.type === "ctrTitle";
        const bulleted = ph ? ph.type === "body" || (ph.type !== "subTitle" && !isTitle && ph.idx !== "") : false;
        const defaultSize = DEFAULT_SIZES[ph?.type ?? ""] ?? 18;
        const paragraphs: SlideParagraph[] = [];
        for (const p of children(body, NS.a, "p")) {
          const pPr = p.getElementsByTagNameNS(NS.a, "pPr")[0];
          const level = Number(pPr?.getAttribute("lvl") ?? 0);
          const runs = children(p, NS.a, "r").map((r) => {
            const rPr = r.getElementsByTagNameNS(NS.a, "rPr")[0];
            const sz = rPr?.getAttribute("sz");
            return {
              text: r.getElementsByTagNameNS(NS.a, "t")[0]?.textContent ?? "",
              size: sz ? Number(sz) / 100 : Math.max(10, defaultSize - level * 2),
              bold: rPr?.getAttribute("b") === "1" || isTitle,
              italic: rPr?.getAttribute("i") === "1",
              color: srgb(rPr),
            };
          });
          if (!runs.some((r) => r.text.trim())) {
            paragraphs.push({ runs: [], align: "left", bullet: false, level });
            continue;
          }
          const algn = pPr?.getAttribute("algn");
          const noBullet = pPr?.getElementsByTagNameNS(NS.a, "buNone").length;
          const hasBullet = pPr?.getElementsByTagNameNS(NS.a, "buChar").length || pPr?.getElementsByTagNameNS(NS.a, "buAutoNum").length;
          paragraphs.push({
            runs,
            align: algn === "ctr" ? "center" : algn === "r" ? "right" : ph?.type === "ctrTitle" || ph?.type === "subTitle" ? "center" : "left",
            bullet: !noBullet && (bulleted || !!hasBullet),
            level,
          });
        }
        if (paragraphs.some((p) => p.runs.length)) {
          const anchorAttr = body.getElementsByTagNameNS(NS.a, "bodyPr")[0]?.getAttribute("anchor");
          const anchor = anchorAttr === "ctr" ? "middle" : anchorAttr === "b" ? "bottom" : anchorAttr === "t" ? "top" : isTitle ? "middle" : "top";
          items.push({ type: "text", box, paragraphs, anchor, fill: srgb(el.getElementsByTagNameNS(NS.p, "spPr")[0]?.getElementsByTagNameNS(NS.a, "solidFill")[0]) });
        }
      } else if (el.localName === "pic") {
        const embed = el.getElementsByTagNameNS(NS.a, "blip")[0]?.getAttributeNS(NS.r, "embed");
        const media = embed ? rels.get(embed) : undefined;
        const box = boxOf(el);
        if (media && box && files[media]) items.push({ type: "image", box, bytes: files[media], name: media });
      }
    }
    const bg = srgb(doc.getElementsByTagNameNS(NS.p, "bg")[0]);
    slides.push({ width, height, background: bg, items });
  }
  if (slides.length === 0) throw new Error("This presentation has no slides.");
  return slides;
}
