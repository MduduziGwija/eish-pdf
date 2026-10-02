// Core PDF operations. Pure functions over bytes, so they run the same in the
// browser worker and in Node tests.
import * as mupdf from "mupdf";
import { range } from "./ranges";
import { baselineOf } from "./layout";

export { baselineOf, LINE_HEIGHT } from "./layout";
import { appendContent, collectFonts, toUserSpace, writeRuns, type FontStyle } from "./text";

export { parsePageRanges, range } from "./ranges";

export type FileStatus = "unrestricted" | "restricted" | "password";

export interface PdfInfo {
  status: FileStatus;
  /** 0 when the file is still password-locked. */
  pages: number;
  /** e.g. "Standard V5 R6 256-bit AES", or "None". */
  encryption: string;
  /** Human-readable names of the blocked actions. */
  restrictions: string[];
  /** True when a password was supplied but it was wrong. */
  wrongPassword: boolean;
}

export interface PdfInput {
  bytes: Uint8Array;
  password?: string;
}

/** The file needs an opening password, and none (or a wrong one) was given. */
export class PasswordError extends Error {
  constructor(public readonly wrongPassword: boolean) {
    super(wrongPassword ? "That password didn't work." : "This file needs a password to open.");
    this.name = "PasswordError";
  }
}

export class NotPdfError extends Error {
  constructor() {
    super("This doesn't look like a PDF file.");
    this.name = "NotPdfError";
  }
}

const PERMISSIONS: [mupdf.DocumentPermission, string][] = [
  ["print", "Printing"],
  ["copy", "Copying text"],
  ["edit", "Editing"],
  ["annotate", "Commenting"],
  ["form", "Filling forms"],
  ["assemble", "Page assembly"],
];

function load(bytes: Uint8Array): mupdf.PDFDocument {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch {
    throw new NotPdfError();
  }
  const pdf = doc.asPDF();
  if (!pdf) {
    doc.destroy();
    throw new NotPdfError();
  }
  return pdf;
}

/** Opens a PDF, authenticating with `password` when one is required. */
export function openPdf({ bytes, password }: PdfInput): mupdf.PDFDocument {
  const pdf = load(bytes);
  if (pdf.needsPassword() && (!password || pdf.authenticatePassword(password) === 0)) {
    pdf.destroy();
    throw new PasswordError(!!password);
  }
  return pdf;
}

function withPdf<T>(input: PdfInput, fn: (pdf: mupdf.PDFDocument) => T): T {
  const pdf = openPdf(input);
  try {
    return fn(pdf);
  } finally {
    pdf.destroy();
  }
}

/** Copies a mupdf buffer out of wasm memory before the buffer is freed. */
function toBytes(buf: mupdf.Buffer): Uint8Array {
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

export function inspect(input: PdfInput): PdfInfo {
  const pdf = load(input.bytes);
  try {
    const encryption = pdf.getMetaData("encryption") ?? "None";
    if (pdf.needsPassword()) {
      const ok = !!input.password && pdf.authenticatePassword(input.password) !== 0;
      if (!ok) {
        return { status: "password", pages: 0, encryption, restrictions: [], wrongPassword: !!input.password };
      }
    }
    const restrictions = PERMISSIONS.filter(([perm]) => !pdf.hasPermission(perm)).map(([, label]) => label);
    return {
      status: encryption === "None" ? "unrestricted" : "restricted",
      pages: pdf.countPages(),
      encryption,
      restrictions,
      wrongPassword: false,
    };
  } finally {
    pdf.destroy();
  }
}

/**
 * Removes encryption and permission restrictions. Files with an opening
 * password need that password; it is never guessed.
 */
export function unlock(input: PdfInput): Uint8Array {
  return withPdf(input, (pdf) => toBytes(pdf.saveToBuffer("encrypt=none")));
}

/** Pages are 0-based. */
function buildDocument(parts: { pdf: mupdf.PDFDocument; pages: number[] }[]): Uint8Array {
  const out = new mupdf.PDFDocument();
  try {
    for (const { pdf, pages } of parts) {
      // One graft map per source keeps shared fonts/images from being duplicated.
      const map = out.newGraftMap();
      try {
        for (const page of pages) map.graftPage(-1, pdf, page);
      } finally {
        map.destroy();
      }
    }
    return toBytes(out.saveToBuffer("garbage,compress"));
  } finally {
    out.destroy();
  }
}

export function merge(inputs: PdfInput[]): Uint8Array {
  if (inputs.length === 0) throw new Error("Add at least one PDF to merge.");
  const opened: mupdf.PDFDocument[] = [];
  try {
    for (const input of inputs) opened.push(openPdf(input));
    return buildDocument(opened.map((pdf) => ({ pdf, pages: range(0, pdf.countPages() - 1) })));
  } finally {
    for (const pdf of opened) pdf.destroy();
  }
}

/** Each group of 0-based page numbers becomes one output file. */
export function split(input: PdfInput, groups: number[][]): Uint8Array[] {
  return withPdf(input, (pdf) => {
    const total = pdf.countPages();
    for (const group of groups) {
      for (const p of group) {
        if (!Number.isInteger(p) || p < 0 || p >= total) throw new RangeError(`Page ${p + 1} doesn't exist.`);
      }
    }
    return groups.map((pages) => buildDocument([{ pdf, pages }]));
  });
}

// --- Editing ----------------------------------------------------------------
// Annotation coordinates are in points, origin top-left, on the page exactly as
// it looks *after* the edit's rotation, i.e. what the user saw while editing.
// The exception is "replace", which edits the page's own text and so always
// uses the page's original (unrotated) coordinates.

export type Rgb = [number, number, number];
export type Rotation = 0 | 90 | 180 | 270;
type Box = [number, number, number, number];

export type Annotation =
  | ({ type: "text"; rect: Box; text: string } & TextStyle)
  | { type: "ink"; strokes: [number, number][][]; width: number; color: Rgb }
  | { type: "highlight"; rect: Box; color: Rgb }
  | { type: "erase"; rect: Box }
  /** A picture (or signature) stretched to `rect`; `image` keys into the images passed to edit(). */
  | { type: "image"; rect: Box; image: string; signature?: boolean }
  /** Swaps an existing line of text for new text in the same style and place. */
  | { type: "replace"; rect: Box; text: string; origin: [number, number]; size: number; color: Rgb; font: FontStyle; underline?: boolean; strike?: boolean };

/** Word-style formatting for a whole text box. */
export interface TextStyle {
  size: number;
  color: Rgb;
  family?: FontStyle["family"];
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: "left" | "center" | "right";
}


export interface PageEdit {
  /** 0-based page in the original file. */
  source: number;
  /** Extra clockwise rotation. */
  rotate: Rotation;
  annotations: Annotation[];
}

export interface PageSize {
  width: number;
  height: number;
}

export function pageSizes(pdf: mupdf.PDFDocument): PageSize[] {
  return range(0, pdf.countPages() - 1).map((i) => {
    const page = pdf.loadPage(i);
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      return { width: x1 - x0, height: y1 - y0 };
    } finally {
      page.destroy();
    }
  });
}

/** Renders a page to PNG, optionally rotated clockwise. */
export function renderPage(pdf: mupdf.PDFDocument, index: number, scale: number, rotate: Rotation = 0): Uint8Array {
  const page = pdf.loadPage(index);
  try {
    const matrix = mupdf.Matrix.concat(mupdf.Matrix.scale(scale, scale), mupdf.Matrix.rotate(rotate));
    const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return pix.asPNG().slice();
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

const normalise = ([x0, y0, x1, y1]: Box): Box => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];

type Replace = Extract<Annotation, { type: "replace" }>;

function applyReplacements(pdf: mupdf.PDFDocument, index: number, replaces: Replace[]) {
  const page = pdf.loadPage(index);
  try {
    // Note the page's fonts before redaction removes the lines that use them.
    const fonts = collectFonts(page);
    for (const a of replaces) {
      // Inset a little so neighbouring lines' ascenders and descenders survive.
      const [x0, y0, x1, y1] = normalise(a.rect);
      const inset = (y1 - y0) * 0.12;
      page.createAnnotation("Redact").setRect([x0, y0 + inset, x1, y1 - inset]);
    }
    page.applyRedactions(false, 2, 1, 0);
    writeRuns(
      pdf,
      index,
      replaces.filter((a) => a.text.trim()).map((a) => ({ text: a.text, origin: a.origin, size: a.size, color: a.color, font: a.font, underline: a.underline, strike: a.strike })),
      fonts,
    );
  } finally {
    page.destroy();
  }
}

/** Pictures, by id, shared by all pages of one edit (a logo used on every page is stored once). */
export type ImageStore = Record<string, Uint8Array>;

function drawImages(pdf: mupdf.PDFDocument, index: number, page: mupdf.PDFPage, placed: Extract<Annotation, { type: "image" }>[], images: ImageStore, refs: Map<string, mupdf.PDFObject>) {
  const pageObj = pdf.findPage(index);
  let res = pageObj.getInheritable("Resources");
  if (res.isNull()) {
    res = pdf.newDictionary();
    pageObj.put("Resources", res);
  }
  let xobjects = res.get("XObject");
  if (xobjects.isNull()) {
    xobjects = pdf.newDictionary();
    res.put("XObject", xobjects);
  }
  const map = toUserSpace(page);
  let ops = "";
  let n = 0;
  for (const a of placed) {
    let ref = refs.get(a.image);
    if (!ref) {
      const bytes = images[a.image];
      if (!bytes) throw new Error("A picture is missing. Add it again.");
      let img: mupdf.Image;
      try {
        img = new mupdf.Image(bytes);
      } catch {
        throw new Error("One of the pictures couldn't be read.");
      }
      ref = pdf.addImage(img);
      img.destroy();
      refs.set(a.image, ref);
    }
    let name: string;
    do name = `EishIm${++n}`;
    while (!xobjects.get(name).isNull());
    xobjects.put(name, ref);
    // The image's unit square: origin at its bottom-left, x to the right, y up (as displayed).
    const [x0, y0, x1, y1] = normalise(a.rect);
    const [e, f] = map.point([x0, y1]);
    const [ia, ib] = map.vector([x1 - x0, 0]);
    const [ic, id] = map.vector([0, -(y1 - y0)]);
    ops += `q ${[ia, ib, ic, id, e, f].map((v) => Math.round(v * 1000) / 1000).join(" ")} cm /${name} Do Q\n`;
  }
  if (ops) appendContent(pdf, pageObj, ops);
}

function applyAnnotations(pdf: mupdf.PDFDocument, index: number, page: mupdf.PDFPage, annotations: Annotation[], images: ImageStore = {}, refs = new Map<string, mupdf.PDFObject>()) {
  const erases = annotations.filter((a) => a.type === "erase");
  if (erases.length) {
    for (const a of erases) page.createAnnotation("Redact").setRect(normalise(a.rect));
    // Really removes text, images (pixels) and covered line art under each box.
    page.applyRedactions(false, 2, 1, 0);
  }
  const placed = annotations.filter((a): a is Extract<Annotation, { type: "image" }> => a.type === "image");
  if (placed.length) drawImages(pdf, index, page, placed, images, refs);
  const texts = annotations.filter((a): a is Extract<Annotation, { type: "text" }> => a.type === "text" && !!a.text.trim());
  if (texts.length) {
    writeRuns(
      pdf,
      index,
      texts.flatMap((a) => {
        const [x0, y0, x1] = normalise(a.rect);
        const font: FontStyle = { name: "", family: a.family ?? "sans", bold: !!a.bold, italic: !!a.italic };
        return a.text.split("\n").map((line, i) => ({
          text: line,
          origin: [x0 + 2, baselineOf(y0, a.size, i)] as [number, number],
          size: a.size,
          color: a.color,
          font,
          underline: a.underline,
          strike: a.strike,
          align: a.align,
          boxWidth: x1 - x0 - 4,
        }));
      }),
    );
  }
  for (const a of annotations) {
    if (a.type === "ink") {
      if (a.strokes.length === 0) continue;
      const annot = page.createAnnotation("Ink");
      annot.setInkList(a.strokes);
      annot.setColor(a.color);
      annot.setBorderWidth(a.width);
      annot.update();
    } else if (a.type === "highlight") {
      const [x0, y0, x1, y1] = normalise(a.rect);
      const annot = page.createAnnotation("Highlight");
      annot.setColor(a.color);
      annot.setQuadPoints([[x0, y0, x1, y0, x0, y1, x1, y1]]);
      annot.update();
    }
  }
  page.update();
}

/**
 * Applies page edits and returns a new, unrestricted PDF. Pages missing from
 * `pages` are deleted; the array order is the new page order.
 */
export function edit(input: PdfInput, pages: PageEdit[], images: ImageStore = {}): Uint8Array {
  if (pages.length === 0) throw new Error("A PDF needs at least one page.");
  return withPdf(input, (pdf) => {
    const total = pdf.countPages();
    const seen = new Set<number>();
    for (const p of pages) {
      if (!Number.isInteger(p.source) || p.source < 0 || p.source >= total) throw new RangeError(`Page ${p.source + 1} doesn't exist.`);
      if (seen.has(p.source)) throw new Error("Each page can only appear once.");
      seen.add(p.source);
    }
    let changed = false;
    const refs = new Map<string, mupdf.PDFObject>();
    for (const p of pages) {
      // Text replacements use the original orientation, so they go first.
      const replaces = p.annotations.filter((a): a is Replace => a.type === "replace");
      const others = p.annotations.filter((a) => a.type !== "replace");
      if (replaces.length) applyReplacements(pdf, p.source, replaces);
      // Then rotate: other annotations are positioned on the rotated page, and
      // MuPDF keeps added text upright on rotated pages.
      if (p.rotate) {
        const obj = pdf.findPage(p.source);
        const current = obj.getInheritable("Rotate");
        const base = current.isNumber() ? current.asNumber() : 0;
        obj.put("Rotate", (((base + p.rotate) % 360) + 360) % 360);
      }
      if (others.length) {
        const page = pdf.loadPage(p.source);
        try {
          applyAnnotations(pdf, p.source, page, others, images, refs);
        } finally {
          page.destroy();
        }
        changed = true;
      }
    }
    // Bake annotations into the page so they print and can't be dragged off.
    if (changed) pdf.bake(true, false);
    pdf.rearrangePages(pages.map((p) => p.source));
    return toBytes(pdf.saveToBuffer("garbage,compress,encrypt=none"));
  });
}
