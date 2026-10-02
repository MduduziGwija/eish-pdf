# Eish PDF 🇿🇦

**For when your PDF says eish.**

Free PDF tools that run entirely in your browser — nothing is uploaded, ever.

| Tool | What it does |
|---|---|
| 🔓 **Unlock** | Removes print, copy and edit restrictions from many PDFs at once (drop a whole folder). Files that need an *opening* password ask you for it — passwords are never guessed. Download everything as a ZIP, plus a CSV log of what was changed. |
| 📎 **Merge** | Joins PDFs into one. Drag to reorder. |
| ✂️ **Split** | Every page, page ranges like `1-3, 5, 8-`, or pick pages from thumbnails. |
| ✏️ **Edit** | Add text, draw or sign, highlight, and **erase** (content is truly removed, not just covered). Rotate, delete and reorder pages. Undo with Ctrl+Z. |

Made by **Mduduzi Gwija**.

## Privacy

All processing happens on your device, in a background Web Worker running
[MuPDF](https://mupdf.com/) compiled to WebAssembly. Your files are never sent anywhere.

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
src/core/worker.ts   runs the engine off the main thread
src/core/client.ts   promise API the UI uses to talk to the worker
src/tools/           the Unlock, Merge, Split and Edit screens
src/ui/              mascot, confetti, drop zone, thumbnails, helpers
tests/               unit tests (Vitest)
```

## Responsible use

Only unlock files you are entitled to use. Eish PDF removes *permission*
restrictions; it does not crack opening passwords.

## Licence

Copyright © 2026 Mduduzi Gwija.

Eish PDF is free software under the **GNU Affero General Public License v3.0 or later**
(see [LICENSE](LICENSE)). It uses MuPDF © Artifex Software, Inc., also AGPL-3.0.
If you host a modified version, you must share its source code too.
