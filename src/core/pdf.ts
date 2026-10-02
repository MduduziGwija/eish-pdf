// Core PDF operations. Pure functions over bytes, so they run the same in the
// browser worker and in Node tests.
import * as mupdf from "mupdf";
import { range } from "./ranges";

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

export type Rgb = [number, number, number];
export type Rotation = 0 | 90 | 180 | 270;
type Box = [number, number, number, number];

export type Annotation =
  | { type: "text"; rect: Box; text: string; size: number; color: Rgb }
  | { type: "ink"; strokes: [number, number][][]; width: number; color: Rgb }
  | { type: "highlight"; rect: Box; color: Rgb }
  | { type: "erase"; rect: Box };

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

function applyAnnotations(page: mupdf.PDFPage, annotations: Annotation[]) {
  const erases = annotations.filter((a) => a.type === "erase");
  if (erases.length) {
    for (const a of erases) page.createAnnotation("Redact").setRect(normalise(a.rect));
    // Really removes text, images (pixels) and covered line art under each box.
    page.applyRedactions(false, 2, 1, 0);
  }
  for (const a of annotations) {
    if (a.type === "text") {
      if (!a.text.trim()) continue;
      const annot = page.createAnnotation("FreeText");
      annot.setRect(normalise(a.rect));
      annot.setContents(a.text);
      annot.setDefaultAppearance("Helv", a.size, a.color);
      annot.setBorderWidth(0);
      annot.update();
    } else if (a.type === "ink") {
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
export function edit(input: PdfInput, pages: PageEdit[]): Uint8Array {
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
    for (const p of pages) {
      // Rotate first: annotations are positioned on the rotated page, and
      // MuPDF keeps added text upright on rotated pages.
      if (p.rotate) {
        const obj = pdf.findPage(p.source);
        const current = obj.getInheritable("Rotate");
        const base = current.isNumber() ? current.asNumber() : 0;
        obj.put("Rotate", (((base + p.rotate) % 360) + 360) % 360);
      }
      if (p.annotations.length) {
        const page = pdf.loadPage(p.source);
        try {
          applyAnnotations(page, p.annotations);
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
