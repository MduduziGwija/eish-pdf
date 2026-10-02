// Draws PowerPoint-style slides (text boxes and pictures at fixed positions)
// as PDF pages.
import * as mupdf from "mupdf";
import { writeRuns, type FontStyle, type TextRun } from "./text";

type Rgb = [number, number, number];
type Box = [number, number, number, number]; // x, y, width, height (points, top-left origin)

export interface SlideRun {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color?: Rgb;
}

export interface SlideParagraph {
  runs: SlideRun[];
  align: "left" | "center" | "right";
  bullet: boolean;
  level: number;
}

export type SlideItem =
  | { type: "text"; box: Box; paragraphs: SlideParagraph[]; fill?: Rgb; anchor?: "top" | "middle" | "bottom" }
  | { type: "image"; box: Box; bytes: Uint8Array; name: string };

export interface Slide {
  width: number;
  height: number;
  background?: Rgb;
  items: SlideItem[];
}

const INSET_X = 7.2;
const INSET_Y = 3.6;
const LINE = 1.2;

const fontCache = new Map<string, mupdf.Font>();
function fontFor(bold: boolean, italic: boolean): mupdf.Font {
  const name = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"][(bold ? 1 : 0) + (italic ? 2 : 0)];
  let f = fontCache.get(name);
  if (!f) fontCache.set(name, (f = new mupdf.Font(name)));
  return f;
}

const widthOf = (text: string, run: SlideRun, scale: number) => {
  const f = fontFor(run.bold, run.italic);
  let w = 0;
  for (const ch of text) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!));
  return w * run.size * scale;
};

interface Piece {
  text: string;
  run: SlideRun;
  width: number;
}

interface Line {
  pieces: Piece[];
  width: number;
  size: number;
  paragraph: SlideParagraph;
  first: boolean;
}

/** Breaks paragraphs into lines that fit the box width, at a given font scale. */
function layout(paragraphs: SlideParagraph[], width: number, scale: number): Line[] {
  const lines: Line[] = [];
  for (const para of paragraphs) {
    const indent = para.level * 18 + (para.bullet ? 18 : 0);
    const avail = Math.max(20, width - indent);
    let line: Line = { pieces: [], width: 0, size: 0, paragraph: para, first: true };
    const size = Math.max(...para.runs.map((r) => r.size), 12) * scale;
    if (para.runs.length === 0) {
      lines.push({ ...line, size });
      continue;
    }
    for (const run of para.runs) {
      for (const word of run.text.split(/(?<=\s)/)) {
        if (!word) continue;
        const w = widthOf(word, run, scale);
        if (line.pieces.length && line.width + widthOf(word.trimEnd(), run, scale) > avail) {
          lines.push(line);
          line = { pieces: [], width: 0, size: 0, paragraph: para, first: false };
        }
        line.pieces.push({ text: word, run, width: w });
        line.width += w;
        line.size = Math.max(line.size, run.size * scale);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function slidesToPdf(slides: Slide[]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    slides.forEach((slide, index) => {
      const { width: W, height: H } = slide;
      const xobjects: Record<string, mupdf.PDFObject> = {};
      let content = "";
      if (slide.background) content += `${slide.background.join(" ")} rg 0 0 ${W} ${H} re f\n`;
      const runs: TextRun[] = [];

      slide.items.forEach((item, k) => {
        const [x, y, w, h] = item.box;
        if (item.type === "image") {
          try {
            const image = new mupdf.Image(item.bytes);
            xobjects[`Im${k}`] = doc.addImage(image);
            content += `q ${w} 0 0 ${h} ${x} ${H - y - h} cm /Im${k} Do Q\n`;
            image.destroy();
          } catch {
            // Formats like EMF/WMF can't be drawn; skip them.
          }
          return;
        }
        if (item.fill) content += `${item.fill.join(" ")} rg ${x} ${H - y - h} ${w} ${h} re f\n`;

        // Shrink text to fit its box, like PowerPoint's autofit.
        let scale = 1;
        let lines = layout(item.paragraphs, w - 2 * INSET_X, scale);
        const heightOf = (ls: Line[]) => ls.reduce((s, l) => s + l.size * LINE, 0);
        while (heightOf(lines) > h - 2 * INSET_Y && scale > 0.5) {
          scale -= 0.05;
          lines = layout(item.paragraphs, w - 2 * INSET_X, scale);
        }
        const total = heightOf(lines);
        let top = y + INSET_Y;
        if (item.anchor === "middle") top = y + (h - total) / 2;
        else if (item.anchor === "bottom") top = y + h - INSET_Y - total;

        for (const line of lines) {
          const baseline = top + line.size * 0.95;
          top += line.size * LINE;
          if (!line.pieces.length) continue;
          const para = line.paragraph;
          const indent = para.level * 18 + (para.bullet ? 18 : 0);
          const visible = line.width - widthOf(line.pieces[line.pieces.length - 1].text.slice(line.pieces[line.pieces.length - 1].text.trimEnd().length), line.pieces[line.pieces.length - 1].run, scale);
          const inner = w - 2 * INSET_X - indent;
          let cx = x + INSET_X + indent + (para.align === "center" ? (inner - visible) / 2 : para.align === "right" ? inner - visible : 0);
          if (para.bullet && line.first) {
            const r = line.pieces[0].run;
            runs.push({ text: "•", origin: [x + INSET_X + para.level * 18 + 4, baseline], size: r.size * scale, color: r.color, font: style(false, false) });
          }
          for (const piece of line.pieces) {
            if (piece.text.trim()) {
              runs.push({ text: piece.text.trimEnd(), origin: [cx, baseline], size: piece.run.size * scale, color: piece.run.color, font: style(piece.run.bold, piece.run.italic) });
            }
            cx += piece.width;
          }
        }
      });

      const resources = doc.addObject({ XObject: xobjects });
      doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, resources, content));
      writeRuns(doc, index, runs, new Map());
    });
    const buf = doc.saveToBuffer("garbage,compress");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

const style = (bold: boolean, italic: boolean): FontStyle => ({ name: "", family: "sans", bold, italic });
