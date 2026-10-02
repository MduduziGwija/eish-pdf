import type { PageEdit, PdfInput, Rotation } from "./pdf";

export type Request =
  | { id: number; op: "inspect"; input: PdfInput }
  | { id: number; op: "unlock"; input: PdfInput }
  | { id: number; op: "merge"; inputs: PdfInput[] }
  | { id: number; op: "split"; input: PdfInput; groups: number[][] }
  | { id: number; op: "edit"; input: PdfInput; pages: PageEdit[] }
  // Sessions keep a document open in the worker for fast page rendering.
  | { id: number; op: "open"; input: PdfInput }
  | { id: number; op: "render"; session: number; page: number; scale: number; rotate: Rotation }
  | { id: number; op: "close"; session: number };

export type ErrorKind = "password" | "not-pdf" | "error";

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; kind: ErrorKind; message: string };
