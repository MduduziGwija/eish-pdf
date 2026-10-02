// Loads Tesseract (on first use only) from files hosted with the site.
import type { Worker as TesseractWorker } from "tesseract.js";

export type OcrLanguage = "eng" | "afr" | "eng+afr";

export const LANGUAGES: { id: OcrLanguage; label: string }[] = [
  { id: "eng", label: "English" },
  { id: "afr", label: "Afrikaans" },
  { id: "eng+afr", label: "English + Afrikaans" },
];

export interface OcrEngine {
  /** Reads a page image; `onProgress` gets 0–1 while it works. */
  read(png: Uint8Array, onProgress?: (p: number) => void): Promise<unknown[]>;
  stop(): Promise<void>;
}

export async function startOcr(language: OcrLanguage): Promise<OcrEngine> {
  const { createWorker } = await import("tesseract.js");
  const base = new URL("ocr/", document.baseURI).href;
  let progress: ((p: number) => void) | undefined;
  const worker: TesseractWorker = await createWorker(language.split("+"), 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core`,
    langPath: `${base}lang`,
    gzip: true,
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") progress?.(m.progress);
    },
  });
  return {
    async read(png, onProgress) {
      progress = onProgress;
      try {
        const { data } = await worker.recognize(new Blob([png as BlobPart], { type: "image/png" }), {}, { blocks: true });
        return (data.blocks ?? []) as unknown[];
      } finally {
        progress = undefined;
      }
    },
    stop: () => worker.terminate().then(() => undefined),
  };
}
