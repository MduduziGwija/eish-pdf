// Promise-based wrapper around the PDF worker.
import type { ImageStore, PageEdit, PageSize, PdfInfo, PdfInput, Rotation } from "./pdf";
import type { ErrorKind, Request, Response } from "./protocol";
import type { OcrWord, TextLine } from "./text";
import type { ImageOptions } from "./convert";
import type { Slide } from "./slides";
import type { Comparison, CompareOptions, DocText } from "./compare";
import type { PreparedPdf, SignatureInfo } from "./signing";

export class PdfError extends Error {
  constructor(public readonly kind: ErrorKind, message: string) {
    super(message);
    this.name = "PdfError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

let worker: Worker | undefined;
let ready: Promise<void> | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function start(): Promise<void> {
  if (ready) return ready;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  ready = new Promise((resolve, reject) => {
    worker!.onerror = (e) => reject(new PdfError("error", e.message || "The PDF engine failed to load."));
    worker!.onmessage = (event: MessageEvent<Response | { ready: true }>) => {
      const msg = event.data;
      if ("ready" in msg) return resolve();
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new PdfError(msg.kind, msg.message));
    };
  });
  return ready;
}

async function call<T>(req: DistributiveOmit<Request, "id">): Promise<T> {
  await start();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...req, id });
  });
}

/** Starts loading the PDF engine early so the first action feels instant. */
export function warmUp(): Promise<void> {
  return start();
}

// Inputs are copied (not transferred) so the UI keeps the original bytes for retries.
export const pdf = {
  inspect: (input: PdfInput) => call<PdfInfo>({ op: "inspect", input }),
  unlock: (input: PdfInput) => call<Uint8Array>({ op: "unlock", input }),
  merge: (inputs: PdfInput[]) => call<Uint8Array>({ op: "merge", inputs }),
  split: (input: PdfInput, groups: number[][]) => call<Uint8Array[]>({ op: "split", input, groups }),
  edit: (input: PdfInput, pages: PageEdit[], images: ImageStore = {}) => call<Uint8Array>({ op: "edit", input, pages, images }),
  open: (input: PdfInput) => call<{ session: number; pages: PageSize[] }>({ op: "open", input }),
  render: (session: number, page: number, scale: number, rotate: Rotation = 0) =>
    call<Uint8Array>({ op: "render", session, page, scale, rotate }),
  close: (session: number) => call<null>({ op: "close", session }),
  lines: (session: number, page: number) => call<TextLine[]>({ op: "lines", session, page }),
  hasText: (session: number, page: number) => call<boolean>({ op: "hasText", session, page }),
  ocrLayer: (session: number, page: number, words: OcrWord[]) => call<null>({ op: "ocrLayer", session, page, words }),
  save: (session: number) => call<Uint8Array>({ op: "save", session }),
  toPdf: (bytes: Uint8Array, name: string) => call<Uint8Array>({ op: "toPdf", bytes, name }),
  htmlToPdf: (html: string, landscape = false) => call<Uint8Array>({ op: "htmlToPdf", html, landscape }),
  slidesToPdf: (slides: Slide[]) => call<Uint8Array>({ op: "slidesToPdf", slides }),
  imagesToPdf: (images: Uint8Array[], options: ImageOptions) => call<Uint8Array>({ op: "imagesToPdf", images, options }),
  pdfToText: (input: PdfInput) => call<string>({ op: "pdfToText", input }),
  pdfToHtml: (input: PdfInput) => call<string>({ op: "pdfToHtml", input }),
  pdfToImages: (input: PdfInput, format: "png" | "jpg", dpi: number) => call<Uint8Array[]>({ op: "pdfToImages", input, format, dpi }),
  pdfToDocx: (input: PdfInput, title: string) => call<Uint8Array>({ op: "pdfToDocx", input, title }),
  pdfLines: (input: PdfInput) => call<string[][]>({ op: "pdfLines", input }),
  prepareSign: (bytes: Uint8Array, info: SignatureInfo) => call<PreparedPdf>({ op: "prepareSign", bytes, info }),
  compare: (base: DocText, others: DocText[], options: CompareOptions) => call<Comparison[]>({ op: "compare", base, others, options }),
};
