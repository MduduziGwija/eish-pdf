import type { PageEdit, PdfInput, Rotation } from "./pdf";
import type { OcrWord } from "./text";
import type { ImageOptions } from "./convert";
import type { Slide } from "./slides";

export type Request =
  | { id: number; op: "inspect"; input: PdfInput }
  | { id: number; op: "unlock"; input: PdfInput }
  | { id: number; op: "merge"; inputs: PdfInput[] }
  | { id: number; op: "split"; input: PdfInput; groups: number[][] }
  | { id: number; op: "edit"; input: PdfInput; pages: PageEdit[] }
  // Sessions keep a document open in the worker for fast page rendering.
  | { id: number; op: "open"; input: PdfInput }
  | { id: number; op: "render"; session: number; page: number; scale: number; rotate: Rotation }
  | { id: number; op: "close"; session: number }
  | { id: number; op: "lines"; session: number; page: number }
  | { id: number; op: "hasText"; session: number; page: number }
  | { id: number; op: "ocrLayer"; session: number; page: number; words: OcrWord[] }
  | { id: number; op: "save"; session: number }
  | { id: number; op: "toPdf"; bytes: Uint8Array; name: string }
  | { id: number; op: "htmlToPdf"; html: string; landscape: boolean }
  | { id: number; op: "slidesToPdf"; slides: Slide[] }
  | { id: number; op: "imagesToPdf"; images: Uint8Array[]; options: ImageOptions }
  | { id: number; op: "pdfToText"; input: PdfInput }
  | { id: number; op: "pdfToHtml"; input: PdfInput }
  | { id: number; op: "pdfToImages"; input: PdfInput; format: "png" | "jpg"; dpi: number }
  | { id: number; op: "pdfToDocx"; input: PdfInput; title: string };

export type ErrorKind = "password" | "not-pdf" | "error";

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; kind: ErrorKind; message: string };
