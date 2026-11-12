import { pdf } from "../core/client";
import { analyseSplit, buildName, describeDocs, fileSafe, groupsFor, SCHEMES, type Analysis, type DocInfo, type NameScheme, type Signal } from "../core/autosplit";
import { h, icon } from "../ui/dom";
import { baseName, plural, saveFile, saveZip, uniqueNames } from "../ui/files";
import { celebrate, mascot, oops, reveal, toast } from "../ui/fun";
import { lazyThumb } from "../ui/thumbs";
import { singleFileTool } from "./shell";

const range = (g: number[]) => (g.length === 1 ? `page ${g[0] + 1}` : `pages ${g[0] + 1}-${g[g.length - 1] + 1}`);

export function autoSplitTool(): HTMLElement {
  return singleFileTool({
    id: "autosplit",
    title: "Auto split",
    intro: "Drop a PDF that holds many documents (a batch of statements, letters, payslips). Eish PDF finds where each one starts and names each file after the person, ID or document type on its first page.",
    drop: "Drop a PDF to split by itself",
    mount(host) {
      const { doc } = host;
      const body = h("div.tool-body");
      const results = h("div.result-slot");
      const wrap = h("div.tool-body", {}, h("p.fine-print", {}, icon("shield"), "Reading the text on each page…"), body, results);
      let lines: string[][] = [];
      let analysis: Analysis | undefined;
      let chosen: Signal | undefined;
      let starts = new Set<number>([0]);
      let drop: number[] = [];
      let prefix = fileSafe(baseName(doc.file.name)) || "document";
      let scheme: NameScheme = "auto";
      // Names the person typed in, by the page their document starts on.
      const typed = new Map<number, string>();

      void pdf
        .pdfLines(doc.input)
        .then((pages) => {
          lines = pages;
          analysis = analyseSplit(pages);
          wrap.firstElementChild?.remove();
          if (analysis.scanned) return paintScanned();
          pick(analysis.signals[0]);
        })
        .catch(() => oops("Couldn't read the text of this PDF."));

      function pick(signal: Signal | undefined) {
        chosen = signal;
        starts = new Set(signal?.starts ?? [0]);
        drop = signal?.drop ?? [];
        typed.clear();
        paint();
      }

      const groups = () => groupsFor([...starts], doc.pages.length, drop);

      /** What was found on the first page of each document (the pattern's own identifier wins). */
      function infos(): DocInfo[] {
        const list = describeDocs(lines, [...starts], drop);
        if (chosen?.kind === "field") {
          groups().forEach((g, k) => {
            const at = chosen!.starts.indexOf(g[0]);
            if (at >= 0 && chosen!.names[at]) list[k] = { ...list[k], id: chosen!.names[at] };
          });
        }
        return list;
      }

      function fileNames(): string[] {
        const found = infos();
        return uniqueNames(groups().map((g, k) => `${typed.get(g[0]) ?? buildName(scheme, found[k] ?? {}, k, prefix)}.pdf`));
      }

      function paintScanned() {
        body.replaceChildren(
          h("div.panel-card", {}, h("h3", {}, "This looks like a scan"), h("p.fine-print", {}, "There is no text to read yet. Make it searchable with OCR first, then bring the result back here."), h("div.actions", {}, h("button.btn.primary", { type: "button", onclick: () => (location.hash = "ocr") }, icon("ocr"), "Go to OCR"))),
        );
      }

      function paint() {
        if (!analysis) return;
        const sigs = analysis.signals;
        const prefixInput = h("input.input", { type: "text", value: prefix, "aria-label": "Start of numbered file names" });
        prefixInput.addEventListener("input", () => {
          prefix = fileSafe(prefixInput.value) || "document";
          paintList();
        });
        const schemeSelect = h("select.input.select", { "aria-label": "Name the files by" });
        for (const s of SCHEMES) schemeSelect.append(h("option", { value: s.id, selected: s.id === scheme }, s.label));
        schemeSelect.addEventListener("change", () => {
          scheme = schemeSelect.value as NameScheme;
          typed.clear();
          paintList();
        });

        const cards = sigs.length
          ? sigs.map((s, i) =>
              h(
                chosen === s ? "button.signal.on" : "button.signal",
                { type: "button", "aria-pressed": String(chosen === s), onclick: () => pick(s) },
                h("strong", {}, s.title),
                h("span", {}, `${plural(groupsFor(s.starts, doc.pages.length, s.drop).length, "document")} · ${s.detail}`),
                i === 0 && h("em.best", {}, "Best guess"),
              ),
            )
          : [h("p.fine-print", {}, "No obvious pattern found. Click a page below to say where a new document starts.")];

        const list = h("div.doc-list");
        const grid = h("div.cut-grid", { role: "list", "aria-label": "Pages: click to start a new document here" });
        const summary = h("span.chip");
        const go = h("button.btn.primary.big", { type: "button", title: "Cuts the PDF up and saves every file together in one ZIP" }, icon("download"), h("span", {}, "Download all as one ZIP"));
        go.addEventListener("click", () => {
          void download(groups(), fileNames(), "zip");
        });
        const separate = h("button.btn", { type: "button", title: "Saves each document as its own PDF (your browser may ask to allow several downloads)" }, icon("file"), "Download as separate files");
        separate.addEventListener("click", () => {
          void download(groups(), fileNames(), "each");
        });

        function paintList() {
          const current = groups();
          const found = infos();
          const names = fileNames();
          list.replaceChildren(
            ...current.map((g, k) => {
              const info = found[k] ?? {};
              const input = h("input.input.small.file-name", { type: "text", value: names[k].replace(/\.pdf$/i, ""), "aria-label": `File name for ${range(g)}`, spellcheck: false });
              input.addEventListener("change", () => {
                const v = fileSafe(input.value);
                if (v) typed.set(g[0], v);
                else typed.delete(g[0]);
                paintList();
              });
              const chips = [info.name && `Name: ${info.name}`, info.id && `ID: ${info.id}`, info.type && `Type: ${info.type}`].filter(Boolean) as string[];
              return h(
                "div.doc-row",
                {},
                h("div.result-icon", {}, icon("file")),
                h("div.file-main", {}, h("div.name-edit", {}, input, h("span.fine-print", {}, ".pdf")), h("div.file-meta", {}, [range(g), ...chips].join(" · "))),
                h("button.btn.small", { type: "button", onclick: () => void download([g], [names[k]]) }, icon("download"), "Download"),
              );
            }),
          );
          summary.textContent = `${plural(current.length, "document")} from ${plural(doc.pages.length, "page")}`;
          go.disabled = current.length < 1;
          separate.disabled = current.length < 2;
        }

        // One card per page: click to start (or stop) a document there.
        let band = -1;
        doc.pages.forEach((_, i) => {
          if (starts.has(i)) band++;
          const dropped = drop.includes(i);
          const card = h(
            `button.cut${starts.has(i) ? ".starts" : ""}${dropped ? ".dropped" : ""}` as "button.cut",
            { type: "button", role: "listitem", title: starts.has(i) ? "A new document starts here. Click to join it to the one before." : "Click to start a new document here", "aria-pressed": String(starts.has(i)), "data-band": String(Math.max(0, band) % 4), disabled: i === 0 },
            lazyThumb(doc.session, i, `Page ${i + 1}`),
            h("span.thumb-num", {}, String(i + 1)),
            starts.has(i) && h("span.cut-flag", {}, icon("scissors")),
          );
          card.addEventListener("click", () => {
            if (starts.has(i)) starts.delete(i);
            else starts.add(i);
            chosen = undefined;
            typed.clear();
            paint();
          });
          grid.append(card);
        });

        body.replaceChildren(
          h("div.toolbar", {}, summary, h("div.actions", {}, separate, go)),
          h("div.signals", {}, ...cards),
          h("div.form-grid", {}, h("label.option", {}, h("span", {}, "Name files by"), schemeSelect), h("label.option", {}, h("span", {}, "Numbered files start with"), prefixInput)),
          h("p.fine-print", {}, "The pages below are shaded per document. Click a page to start a new document there, or to join it to the one before. Edit any file name in the list."),
          grid,
          list,
        );
        paintList();
      }

      /** "zip": everything in one ZIP. "each": one PDF per document. */
      async function download(gs: number[][], names: string[], how: "zip" | "each" | "one" = "one") {
        const files = await host.work(pdf.split(doc.input, gs), "Couldn't cut the PDF up.");
        if (!files) return;
        const named = files.map((bytes, k) => ({ name: names[k], bytes }));
        if (how === "one") return saveFile(named[0].bytes, named[0].name);
        const zipName = `${prefix}_split.zip`;
        if (how === "zip") {
          saveZip(named, zipName);
          toast(`Zipped ${plural(named.length, "file")} into one ZIP. Sharp!`, "ok");
        } else {
          for (const f of named) {
            saveFile(f.bytes, f.name);
            await new Promise((r) => setTimeout(r, 250));
          }
          toast(`Saved ${plural(named.length, "file")}.`, "ok");
        }
        results.replaceChildren(
          h(
            "div.result-card",
            {},
            h("div.result-icon", {}, icon("file")),
            h("div.file-main", {}, h("div.file-name", {}, `${plural(named.length, "file")} ready`), h("div.file-meta", {}, how === "zip" ? `Saved as ${zipName}.` : "Saved as separate PDFs.")),
            h("button.btn.primary", { type: "button", onclick: () => saveZip(named, zipName) }, icon("download"), "Download all as one ZIP"),
          ),
        );
        reveal(results);
        celebrate(`Auto split done: ${plural(named.length, "file")}!`, results);
        mascot.mood("happy");
      }

      return wrap;
    },
  });
}
