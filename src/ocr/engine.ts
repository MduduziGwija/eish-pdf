// Loads Tesseract (on first use only) from files hosted with the site.
import type { Worker as TesseractWorker } from "tesseract.js";

export type OcrLanguage = "eng" | "afr" | "zul" | "xho" | "eng+afr";

export const LANGUAGES: { id: OcrLanguage; label: string }[] = [
  { id: "eng", label: "English" },
  { id: "afr", label: "Afrikaans" },
  { id: "zul", label: "isiZulu" },
  { id: "xho", label: "isiXhosa" },
  { id: "eng+afr", label: "English + Afrikaans" },
];

/**
 * Tesseract has no isiZulu or isiXhosa models. Both are written in the plain Latin
 * alphabet, so they're read with the English letter model and its English word
 * lists switched off, so Zulu and Xhosa words aren't "corrected" into English.
 */
function modelFor(language: OcrLanguage): { langs: string[]; config: Record<string, string> } {
  if (language === "zul" || language === "xho") return { langs: ["eng"], config: { load_system_dawg: "0", load_freq_dawg: "0" } };
  return { langs: language.split("+"), config: {} };
}

export interface OcrEngine {
  /** Reads a page image; `onProgress` gets 0–1 while it works. */
  read(png: Uint8Array, onProgress?: (p: number) => void): Promise<unknown[]>;
  stop(): Promise<void>;
}

export async function startOcr(language: OcrLanguage): Promise<OcrEngine> {
  const { createWorker } = await import("tesseract.js");
  const base = new URL("ocr/", document.baseURI).href;
  let progress: ((p: number) => void) | undefined;
  const { langs, config } = modelFor(language);
  const worker: TesseractWorker = await createWorker(langs, 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core`,
    langPath: `${base}lang`,
    gzip: true,
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") progress?.(m.progress);
    },
  }, config);
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
