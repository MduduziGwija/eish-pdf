// Reading existing text lines and writing new text straight into page content.
// Used by "Edit text" (replacement in a matching style) and OCR (an invisible
// text layer that makes scans searchable).
import * as mupdf from "mupdf";

export type Rgb = [number, number, number];
type Box = [number, number, number, number];

export interface FontStyle {
  /** Name of the font in the PDF, e.g. "ABCDEF+Arial-BoldMT". */
  name: string;
  family: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
}

export interface TextLine {
  text: string;
  /** Line box in page space (points, origin top-left). */
  bbox: Box;
  /** Baseline start of the first character. */
  origin: [number, number];
  size: number;
  color: Rgb;
  font: FontStyle;
}

export interface TextRun {
  text: string;
  /** Baseline start in page space. */
  origin: [number, number];
  size: number;
  color?: Rgb;
  font?: FontStyle;
  /** Squeeze or stretch the run to exactly this width (points). */
  width?: number;
  /** Invisible but selectable/searchable (OCR layer). */
  invisible?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Align within `boxWidth` points, measured from `origin`. */
  align?: "left" | "center" | "right";
  boxWidth?: number;
  /** Direction the text runs, in radians clockwise from "to the right" (page space, y down). */
  angle?: number;
}

// --- Reading -----------------------------------------------------------------

function styleOf(font: mupdf.Font): FontStyle {
  const name = font.getName();
  const plain = name.replace(/^[A-Z]{6}\+/, "");
  const mono = font.isMono() || /courier|mono|consol/i.test(plain);
  const serif = !mono && /times|serif|georgia|garamond|cambria|book|roman|minion|palatino/i.test(plain) && !/sans/i.test(plain);
  return {
    name,
    family: mono ? "mono" : serif ? "serif" : "sans",
    bold: font.isBold() || /bold|black|heavy|semibold|demi/i.test(plain),
    italic: font.isItalic() || /italic|oblique/i.test(plain),
  };
}

const toRgb = (c: mupdf.Color): Rgb => {
  if (c.length === 3) return [c[0], c[1], c[2]];
  if (c.length === 1) return [c[0], c[0], c[0]];
  // CMYK to RGB.
  const [C, M, Y, K] = c;
  return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
};

/** All horizontal text lines on a page, with the style of their first character. */
export function textLines(pdf: mupdf.PDFDocument, index: number): TextLine[] {
  const page = pdf.loadPage(index);
  try {
    const st = page.toStructuredText("preserve-whitespace");
    const lines: TextLine[] = [];
    let current: TextLine | undefined;
    let horizontal = true;
    st.walk({
      beginLine(bbox, _wmode, dir) {
        horizontal = Math.abs(dir[1]) < 0.01 && dir[0] > 0;
        current = undefined;
        if (horizontal) current = { text: "", bbox: [...bbox] as Box, origin: [0, 0], size: 0, color: [0, 0, 0], font: { name: "", family: "sans", bold: false, italic: false } };
      },
      onChar(c, origin, font, size, _quad, color) {
        if (!current) return;
        if (!current.text) {
          current.origin = [origin[0], origin[1]];
          current.size = Math.round(size * 100) / 100;
          current.color = toRgb(color);
          current.font = styleOf(font);
        }
        current.text += c;
      },
      endLine() {
        if (current && current.text.trim()) lines.push({ ...current, text: current.text.replace(/\s+$/, "") });
        current = undefined;
      },
    });
    st.destroy();
    return lines;
  } finally {
    page.destroy();
  }
}

export function pageHasText(pdf: mupdf.PDFDocument, index: number): boolean {
  return textLines(pdf, index).some((l) => l.text.trim().length > 1);
}

// --- Writing -----------------------------------------------------------------

const BASE14: Record<FontStyle["family"], [string, string, string, string]> = {
  // regular, bold, italic, bold-italic
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

const baseFontName = (s?: FontStyle) => BASE14[s?.family ?? "sans"][(s?.bold ? 1 : 0) + (s?.italic ? 2 : 0)];

// WinAnsiEncoding bytes 0x80–0x9F that differ from Latin-1.
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

function winAnsi(ch: string): number {
  const code = ch.codePointAt(0)!;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI[ch] ?? 0x3f; // "?"
}

const hex = (n: number, digits: number) => n.toString(16).padStart(digits, "0");
const num = (n: number) => (Math.abs(n) < 1e-6 ? "0" : String(Math.round(n * 1000) / 1000));

interface Encoded {
  resourceName: string;
  /** Text-showing operator with its operand, e.g. "<0041> Tj". */
  show: string;
  /** Natural width in points. */
  width: number;
}

/** Fonts often have no space glyph; spaces then become a gap of this many em. */
const SPACE_EM = 0.278;

/** Caches the fonts added to one page during one write. */
class FontBook {
  private names = new Map<string, string>();
  private fontDict: mupdf.PDFObject;

  constructor(
    private pdf: mupdf.PDFDocument,
    pageObj: mupdf.PDFObject,
    private originals: Map<string, PageFont>,
  ) {
    let res = pageObj.getInheritable("Resources");
    if (res.isNull()) {
      res = pdf.newDictionary();
      pageObj.put("Resources", res);
    }
    let fonts = res.get("Font");
    if (fonts.isNull()) {
      fonts = pdf.newDictionary();
      res.put("Font", fonts);
    }
    this.fontDict = fonts;
  }

  private register(key: string, make: () => mupdf.PDFObject): string {
    let name = this.names.get(key);
    if (!name) {
      let n = this.names.size + 1;
      while (!this.fontDict.get(`EishF${n}`).isNull()) n++;
      name = `EishF${n}`;
      this.fontDict.put(name, make());
      this.names.set(key, name);
    }
    return name;
  }

  encode(text: string, size: number, style?: FontStyle): Encoded {
    const chars = [...text];
    // 1. The document's own font, if it has a glyph for every character.
    const original = style ? this.originals.get(style.name) : undefined;
    if (original) {
      const { font, glyphs } = original;
      const gids = chars.map((c) => glyphs.get(c) ?? font.encodeCharacter(c.codePointAt(0)!));
      // A missing space is fine: it becomes a positioned gap.
      if (gids.every((g, i) => g > 0 || chars[i] === " ")) {
        try {
          const resourceName = this.register(`orig:${style!.name}`, () => {
            const ref = this.pdf.addFont(font);
            // The re-embedded font's own map may be empty for subsets; write ours.
            const known = new Map(glyphs);
            chars.forEach((c, i) => gids[i] > 0 && known.set(c, gids[i]));
            ref.put("ToUnicode", this.pdf.addStream(toUnicodeCMap(known), {}));
            return ref;
          });
          let width = 0;
          const parts: string[] = [];
          let glyphRun = "";
          for (const g of gids) {
            if (g > 0) {
              glyphRun += hex(g, 4);
              width += font.advanceGlyph(g) * size;
            } else {
              if (glyphRun) parts.push(`<${glyphRun}>`);
              glyphRun = "";
              parts.push(String(-SPACE_EM * 1000));
              width += SPACE_EM * size;
            }
          }
          if (glyphRun) parts.push(`<${glyphRun}>`);
          return { resourceName, show: `[${parts.join(" ")}] TJ`, width };
        } catch {
          // Some font formats can't be re-embedded; use a standard font instead.
        }
      }
    }
    // 2. The closest standard PDF font.
    const baseName = baseFontName(style);
    const font = new mupdf.Font(baseName);
    const resourceName = this.register(`base:${baseName}`, () => this.pdf.addSimpleFont(font, "Latin"));
    const codes = chars.map(winAnsi);
    const width = chars.reduce((w, c) => w + font.advanceGlyph(font.encodeCharacter(c.codePointAt(0)!)), 0) * size;
    return { resourceName, show: `<${codes.map((c) => hex(c, 2)).join("")}> Tj`, width };
  }
}

export interface PageFont {
  font: mupdf.Font;
  /** Character -> glyph id, as actually drawn on the page. */
  glyphs: Map<string, number>;
}

/**
 * The fonts used on a page, by name, with the glyph used for each character.
 * Subsetted fonts often have no character map, so the glyphs seen on the page
 * are the only reliable way to type with them again.
 */
export function collectFonts(page: mupdf.Page): Map<string, PageFont> {
  const fonts = new Map<string, PageFont>();
  const learn = (text: mupdf.Text) =>
    text.walk({
      showGlyph(font, _trm, glyph, unicode) {
        const name = font.getName();
        let entry = fonts.get(name);
        if (!entry) fonts.set(name, (entry = { font, glyphs: new Map() }));
        if (unicode > 0 && glyph > 0 && !entry.glyphs.has(String.fromCodePoint(unicode))) {
          entry.glyphs.set(String.fromCodePoint(unicode), glyph);
        }
      },
    });
  const device = new mupdf.Device({ fillText: learn, strokeText: learn, clipText: learn, clipStrokeText: learn, ignoreText: learn });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return fonts;
}

/** A ToUnicode CMap so text typed with a re-embedded font copies and searches correctly. */
function toUnicodeCMap(glyphs: Map<string, number>): string {
  const pairs = [...glyphs].map(([ch, gid]) => `<${hex(gid, 4)}> <${[...ch].map((c) => utf16(c)).join("")}>`);
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const part = pairs.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    ...chunks,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

function utf16(ch: string): string {
  let out = "";
  for (let i = 0; i < ch.length; i++) out += hex(ch.charCodeAt(i), 4);
  return out;
}

/**
 * Appends text runs to a page's content, keeping existing drawing state intact.
 * `fonts` are the page's original fonts (see collectFonts) to reuse when they
 * contain every character needed.
 */
export function writeRuns(pdf: mupdf.PDFDocument, index: number, runs: TextRun[], fonts?: Map<string, PageFont>): void {
  const usable = runs.filter((r) => r.text.length > 0 && r.size > 0);
  if (usable.length === 0) return;
  const page = pdf.loadPage(index);
  try {
    const pageObj = pdf.findPage(index);
    const book = new FontBook(pdf, pageObj, fonts ?? collectFonts(page));
    // Page space (top-left, y down) -> PDF user space.
    const inv = mupdf.Matrix.invert(page.getTransform());
    const vec = ([x, y]: [number, number]): [number, number] => [inv[0] * x + inv[2] * y, inv[1] * x + inv[3] * y];
    const pt = ([x, y]: [number, number]): [number, number] => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];

    let ops = "";
    for (const run of usable) {
      const enc = book.encode(run.text, run.size, run.font);
      const phi = run.angle ?? 0;
      const [a, b] = vec([Math.cos(phi), Math.sin(phi)]);
      const [c, d] = vec([Math.sin(phi), -Math.cos(phi)]);
      const shown = run.width && enc.width > 0 ? run.width : enc.width;
      const shift = run.boxWidth && run.align && run.align !== "left" ? (run.boxWidth - shown) * (run.align === "center" ? 0.5 : 1) : 0;
      const [e, f] = pt([run.origin[0] + Math.max(0, shift), run.origin[1]]);
      const [r, g, bl] = run.color ?? [0, 0, 0];
      const scale = run.width && enc.width > 0 ? (run.width / enc.width) * 100 : 100;
      const tm = `${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)}`;
      ops +=
        `BT /${enc.resourceName} ${num(run.size)} Tf ${run.invisible ? 3 : 0} Tr ${num(r)} ${num(g)} ${num(bl)} rg ` +
        `${num(scale)} Tz ${tm} Tm ${enc.show} ET\n`;
      // Underline and strikethrough as thin bars in text space (y up from the baseline).
      const bar = (y: number) => `q ${tm} cm ${num(r)} ${num(g)} ${num(bl)} rg 0 ${num(y)} ${num(shown)} ${num(run.size * 0.06)} re f Q\n`;
      if (run.underline && !run.invisible) ops += bar(-run.size * 0.16);
      if (run.strike && !run.invisible) ops += bar(run.size * 0.26);
    }

    appendContent(pdf, pageObj, ops);
  } finally {
    page.destroy();
  }
}

/** Adds drawing operators after a page's content, wrapping the old content in q/Q so its graphics state can't leak into ours. */
export function appendContent(pdf: mupdf.PDFDocument, pageObj: mupdf.PDFObject, ops: string): void {
  const contents = pageObj.get("Contents");
  const list = pdf.newArray();
  list.push(pdf.addStream("q\n", {}));
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
  else if (!contents.isNull()) list.push(contents);
  list.push(pdf.addStream(`\nQ\nq\n${ops}Q\n`, {}));
  pageObj.put("Contents", list);
}

/** Page space (points, top-left origin, as displayed) -> PDF user space, for a loaded page. */
export function toUserSpace(page: mupdf.PDFPage) {
  const inv = mupdf.Matrix.invert(page.getTransform());
  return {
    point: ([x, y]: [number, number]): [number, number] => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]],
    vector: ([x, y]: [number, number]): [number, number] => [inv[0] * x + inv[2] * y, inv[1] * x + inv[3] * y],
  };
}

// --- OCR layer -----------------------------------------------------------------

export interface OcrWord {
  text: string;
  /** Word box in page space (points). */
  bbox: Box;
  /** Baseline y in page space. */
  baseline: number;
  /** How sure OCR was (0–100), when known. */
  confidence?: number;
  /** For words that aren't level (tilted or turned lines): where the baseline starts, how long it is, the letter height and the direction (radians, clockwise from "right"). `bbox` is then just their outline. */
  tilt?: { origin: [number, number]; length: number; height: number; angle: number };
}

/** Adds OCR'd words as invisible, searchable text sized to cover each word. */
export function addOcrLayer(pdf: mupdf.PDFDocument, index: number, words: OcrWord[]): void {
  writeRuns(
    pdf,
    index,
    words
      .filter((w) => w.text.trim())
      .map((w) => {
        if (w.tilt) return { text: w.text.trim(), origin: w.tilt.origin, size: Math.max(1, w.tilt.height * 0.85), width: w.tilt.length, angle: w.tilt.angle, invisible: true };
        const height = w.bbox[3] - w.bbox[1];
        return {
          text: w.text.trim(),
          origin: [w.bbox[0], w.baseline] as [number, number],
          size: Math.max(1, height * 0.85),
          width: w.bbox[2] - w.bbox[0],
          invisible: true,
        };
      }),
  );
}
