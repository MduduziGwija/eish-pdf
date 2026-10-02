// Copies Tesseract's worker, WebAssembly core and language data into public/ocr
// so OCR runs from this site alone, with no third-party downloads.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const out = join(root, "public", "ocr");

const files = [
  [nm("tesseract.js", "dist", "worker.min.js"), "worker.min.js"],
  [nm("tesseract.js", "LICENSE.md"), "LICENSE-tesseract.js.md"],
  [nm("tesseract.js-core", "LICENSE"), "LICENSE-tesseract-core.txt"],
  ...["", "simd-", "relaxedsimd-"].map((v) => [nm("tesseract.js-core", `tesseract-core-${v}lstm.wasm.js`), `core/tesseract-core-${v}lstm.wasm.js`]),
  ...["eng", "afr"].map((l) => [nm("@tesseract.js-data", l, "4.0.0_best_int", `${l}.traineddata.gz`), `lang/${l}.traineddata.gz`]),
];

for (const [from, to] of files) {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(from, join(out, to));
}
console.log(`Copied ${files.length} OCR files to public/ocr`);
