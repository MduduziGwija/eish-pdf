/// <reference lib="webworker" />
// Runs MuPDF off the main thread so animations stay smooth while PDFs are processed.
import type * as mupdf from "mupdf";
import { edit, inspect, merge, NotPdfError, openPdf, pageSizes, PasswordError, renderPage, split, unlock } from "./pdf";
import type { Request, Response } from "./protocol";
import { addOcrLayer, pageHasText, textLines } from "./text";
import { scanImage } from "./scanimage";
import { slidesToPdf } from "./slides";
import { documentToPdf, htmlToPdf, imagesToPdf, pdfLines, pdfToDocx, pdfToHtml, pdfToImages, pdfToText } from "./convert";
import { compareDocs } from "./compare";
import { prepareForSigning } from "./signing";

declare const self: DedicatedWorkerGlobalScope;

const sessions = new Map<number, mupdf.PDFDocument>();
let nextSession = 1;

function session(id: number): mupdf.PDFDocument {
  const doc = sessions.get(id);
  if (!doc) throw new Error("That document is no longer open.");
  return doc;
}

const bytesResult = (bytes: Uint8Array) => ({ result: bytes, transfer: [bytes.buffer] });

function handle(req: Request): { result: unknown; transfer?: Transferable[] } {
  switch (req.op) {
    case "inspect":
      return { result: inspect(req.input) };
    case "unlock": {
      const bytes = unlock(req.input);
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case "merge": {
      const bytes = merge(req.inputs);
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case "split": {
      const files = split(req.input, req.groups);
      return { result: files, transfer: files.map((f) => f.buffer) };
    }
    case "edit": {
      const bytes = edit(req.input, req.pages, req.images);
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case "open": {
      const doc = openPdf(req.input);
      const session = nextSession++;
      sessions.set(session, doc);
      return { result: { session, pages: pageSizes(doc) } };
    }
    case "render": {
      const png = renderPage(session(req.session), req.page, req.scale, req.rotate);
      return { result: png, transfer: [png.buffer] };
    }
    case "lines":
      return { result: textLines(session(req.session), req.page) };
    case "scanImage": {
      const found = scanImage(session(req.session), req.page);
      return { result: found, transfer: found ? [found.png.buffer] : [] };
    }
    case "hasText":
      return { result: pageHasText(session(req.session), req.page) };
    case "ocrLayer":
      addOcrLayer(session(req.session), req.page, req.words);
      return { result: null };
    case "save": {
      const bytes = session(req.session).saveToBuffer("garbage,compress,encrypt=none").asUint8Array().slice();
      return { result: bytes, transfer: [bytes.buffer] };
    }
    case "toPdf":
      return bytesResult(documentToPdf(req.bytes, req.name));
    case "htmlToPdf":
      return bytesResult(htmlToPdf(req.html, req.landscape));
    case "slidesToPdf":
      return bytesResult(slidesToPdf(req.slides));
    case "imagesToPdf":
      return bytesResult(imagesToPdf(req.images, req.options));
    case "pdfToText":
      return { result: pdfToText(req.input) };
    case "pdfToHtml":
      return { result: pdfToHtml(req.input) };
    case "pdfToImages": {
      const images = pdfToImages(req.input, req.format, req.dpi);
      return { result: images, transfer: images.map((i) => i.buffer) };
    }
    case "pdfToDocx":
      return bytesResult(pdfToDocx(req.input, req.title));
    case "prepareSign": {
      const prepared = prepareForSigning(req.bytes, req.info);
      return { result: prepared, transfer: [prepared.bytes.buffer] };
    }
    case "pdfLines":
      return { result: pdfLines(req.input) };
    case "compare":
      return { result: req.others.map((o) => compareDocs(req.base, o, req.options)) };
    case "close":
      sessions.get(req.session)?.destroy();
      sessions.delete(req.session);
      return { result: null };
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    const { result, transfer = [] } = handle(req);
    self.postMessage({ id: req.id, ok: true, result } satisfies Response, transfer);
  } catch (err) {
    const kind = err instanceof PasswordError ? "password" : err instanceof NotPdfError ? "not-pdf" : "error";
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ id: req.id, ok: false, kind, message } satisfies Response);
  }
};

self.postMessage({ ready: true });
