# Eish PDF 🇿🇦

**For when your PDF says eish.**

Free PDF tools that run entirely in your browser — nothing is uploaded, ever.

| Tool | What it does |
|---|---|
| 🔓 **Unlock** | Removes print, copy and edit restrictions from many PDFs at once (drop a whole folder). Files that need an *opening* password ask you for it — passwords are never guessed. Download everything as a ZIP, plus a CSV log of what was changed. |
| 📎 **Merge** | Joins PDFs into one. Drag to reorder. |
| ✂️ **Split** | Every page, page ranges like `1-3, 5, 8-`, or pick pages from thumbnails. |
| ✏️ **Edit** | **Edit text**: click any line of the PDF's own text and retype it. It keeps the same size, colour and position, and reuses the document's embedded font when it has the letters you type (otherwise the closest standard font: Helvetica/Arial, Times or Courier, matching bold/italic). **Scanned pages** are read on the spot (OCR) the moment you pick Edit text, so their lines become clickable too; your new words match the scan's size, ink and paper colour, and the saved PDF is searchable. **Match the scan's look** (on by default): your words are redrawn to look scanned too. Eish PDF tries the line in 39 fonts and keeps the closest, with matching size, width, weight and slant: 23 printed look-alikes (Times, Cambria, Georgia, Garamond, Baskerville, Palatino, Century, Rockwell, Arial, Calibri, Verdana, Segoe UI, Roboto, Myriad, Century Gothic, Franklin Gothic, Arial Narrow, Courier New, typewriters and more) and 16 handwriting styles (printed, neat, block capitals, scrawled and joined-up cursive). Handwriting gets a natural wobble so no two letters are identical. It copies the scan's blur, grain, ink and paper, reuses the scan's own letters and whole words where it can (great for handwriting: a name written once can be reused as the writer wrote it), lets you pick a font yourself if you prefer, and paints the result into the scan picture itself, so nothing looks pasted on. Pick the scan's language (English, Afrikaans, isiZulu, isiXhosa) and it's remembered. **Add text** with a Word-style bar: font, size, bold, italic, underline, strikethrough, colour, alignment. **Add image**: place a picture or logo, drag to move, pull a corner to resize. **Sign**: draw, type (handwriting fonts) or upload your signature, then place and resize it; recent signatures are remembered on your device. **Digital signature (optional):** seal the saved PDF with your certificate (.p12/.pfx), or create a test certificate; PDF readers then show who signed and flag any later changes. Also draw freehand, highlight, and **erase** (content is truly removed, not just covered). Rotate, delete and reorder pages. Zoom, full-screen editing, undo with Ctrl+Z. |
| ⇄ **Convert** | **To PDF:** Word (.docx: headings, bold, lists, tables, pictures), Excel (.xlsx: every sheet as a table, dates, merged cells, wide sheets on landscape pages), PowerPoint (.pptx: titles, bullets, text boxes and pictures in place on widescreen pages), pictures (JPG, PNG, WebP, SVG, GIF, BMP, TIFF; A4 or fit-to-picture pages), text, Markdown, web pages, EPUB, XPS, CBZ. Combine everything into one PDF, or one PDF per file. **From PDF:** Word (.docx with fonts, sizes, colours and pictures), PNG/JPG per page, plain text, or a web page. |
| ⚖ **Compare** | See what's different between 2–10 PDFs. Pick the original as the base (★): each other PDF gets a similarity score, words added/removed, a "where they differ" table lining up every change across all files, a word-by-word view, and a visual mode that highlights changed areas (works on scans too). Download the comparison as a PDF report. |
| 🔍 **OCR** | Makes scanned PDFs searchable: an invisible text layer is added under each page, so you can search, select and copy, while the page looks exactly the same. English, Afrikaans, isiZulu and isiXhosa (Zulu and Xhosa are read with the Latin-letter model and no English dictionary, since Tesseract has no models for them yet). Handles many files at once and skips pages that already have text. |

Made by **Mduduzi Gwija**.

## Privacy

All processing happens on your device, in a background Web Worker running
[MuPDF](https://mupdf.com/) compiled to WebAssembly, plus
[Tesseract.js](https://tesseract.projectnaptha.com/) for OCR. Your files are never
sent anywhere. The OCR engine and language data are served from this site itself
(copied into `public/ocr` by `scripts/copy-ocr-assets.mjs`), not from a third party.

## Run it locally

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests
npm run build      # production build in dist/
```

## Deploying (free, GitHub Pages)

1. Push this repository to GitHub.
2. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` runs the tests and publishes the site to
   `https://<your-username>.github.io/eish-pdf/`.

## Project layout

```
src/core/pdf.ts      PDF engine: inspect, unlock, merge, split, edit, render (MuPDF)
src/core/ranges.ts   page-range parsing ("1-3, 5, 8-")
src/core/text.ts     reading text lines; writing text in matching or chosen fonts; OCR text layer
src/core/ocrwords.ts converts OCR results to page positions
src/core/scanimage.ts reads a scanned page's picture and writes edited pixels back into it
src/scan/            redraws scanned lines in the scan's own look (font matching, blur, grain, reused letters)
src/core/compare.ts  text comparison (Myers diff on lines, then words)
src/core/convert.ts  to-PDF and from-PDF conversions; src/core/docx.ts writes Word files
src/core/slides.ts   draws PowerPoint slides as PDF pages
src/convert/         reads Word (via Mammoth), Excel and PowerPoint files in the browser
src/core/worker.ts   runs the engine off the main thread
src/ocr/engine.ts    loads Tesseract on first use
src/core/client.ts   promise API the UI uses to talk to the worker
src/tools/           the Unlock, Merge, Split, Edit and OCR screens (+ the formatting bar)
src/ui/              mascot, confetti, drop zone, thumbnails, helpers
tests/               unit tests (Vitest)
```

## Responsible use

Only unlock files you are entitled to use. Eish PDF removes *permission*
restrictions; it does not crack opening passwords.

## Licence

Copyright © 2026 Mduduzi Gwija.

Eish PDF is free software under the **GNU Affero General Public License v3.0 or later**
(see [LICENSE](LICENSE)). It uses MuPDF © Artifex Software, Inc., also AGPL-3.0,
Tesseract.js (Apache-2.0), node-forge (BSD-3-Clause) for certificate signatures, Mammoth (BSD-2-Clause), and the Great Vibes, Dancing Script and Caveat fonts (SIL Open Font License) for typed signatures. Scanned text is redrawn with 39 open fonts from Fontsource: Homemade Apple, Just Another Hand, Roboto Slab, Satisfy and Special Elite (Apache-2.0), and the rest (Tinos, Arimo, Cousine, Carlito, Caladea, Gelasio, DejaVu Sans, EB Garamond, Caveat and others) under the SIL Open Font License, as packaged. The test suite includes the DejaVu Sans font (free licence,
see `tests/fonts/DejaVu-LICENSE.txt`).
If you host a modified version, you must share its source code too.
