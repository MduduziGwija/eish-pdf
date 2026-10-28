import { pdf } from "../core/client";
import { analyseSplit, fileSafe, groupsFor, type Analysis, type Signal } from "../core/autosplit";
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
    intro: "Drop a PDF that holds many documents (a batch of statements, letters, payslips) and Eish PDF finds where each one starts, from page numbers, IDs and headings.",
    drop: "Drop a PDF to split by itself",
    mount(host) {
      const { doc } = host;
      const body = h("div.tool-body");
      const results = h("div.result-slot");
      const wrap = h("div.tool-body", {}, h("p.fine-print", {}, icon("shield"), "Reading the text on each page…"), body, results);
      let analysis: Analysis | undefined;
      let chosen: Signal | undefined;
      let starts = new Set<number>([0]);
      let drop: number[] = [];
      let prefix = fileSafe(baseName(doc.file.name)) || "document";

      void pdf.pdfLines(doc.input).then((pages) => {
        analysis = analyseSplit(pages);
        wrap.firstElementChild?.remove();
        if (analysis.scanned) return paintScanned();
        pick(analysis.signals[0]);
      }).catch(() => oops("Couldn't read the text of this PDF."));

      function pick(signal: Signal | undefined) {
        chosen = signal;
        starts = new Set(signal?.starts ?? [0]);
        drop = signal?.drop ?? [];
        paint();
      }

      const groups = () => groupsFor([...starts], doc.pages.length, drop);
      const startOf = (g: number[]) => g[0];
      function nameFor(k: number, g: number[]): string {
        const idx = [...starts].sort((a, b) => a - b).indexOf(startOf(g));
        const label = chosen && chosen.starts.includes(startOf(g)) ? chosen.names[chosen.starts.indexOf(startOf(g))] : undefined;
        return label ? `${prefix}_${fileSafe(label)}` : `${prefix}_part${(idx >= 0 ? idx : k) + 1}`;
      }

      function paintScanned() {
        body.replaceChildren(
          h("div.panel-card", {}, h("h3", {}, "This looks like a scan"), h("p.fine-print", {}, "There is no text to read yet. Make it searchable with OCR first, then bring the result back here."), h("div.actions", {}, h("button.btn.primary", { type: "button", onclick: () => (location.hash = "ocr") }, icon("ocr"), "Go to OCR"))),
        );
      }

      function paint() {
        if (!analysis) return;
        const sigs = analysis.signals;
        const prefixInput = h("input.input", { type: "text", value: prefix, "aria-label": "Start of each file name" });
        prefixInput.addEventListener("input", () => {
          prefix = fileSafe(prefixInput.value) || "document";
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
        function paintList() {
          const current = groups();
          const names = uniqueNames(current.map((g, k) => `${nameFor(k, g)}.pdf`));
          list.replaceChildren(
            ...current.map((g, k) => h("div.doc-row", {}, h("div.result-icon", {}, icon("file")), h("div.file-main", {}, h("div.file-name", {}, names[k]), h("div.file-meta", {}, range(g))), h("button.btn.small", { type: "button", onclick: () => void download([g], [names[k]]) }, icon("download"), "Download"))),
          );
          summary.textContent = `${plural(current.length, "document")} from ${plural(doc.pages.length, "page")}`;
          go.disabled = current.length < 2;
        }
        const summary = h("span.chip");
        const go = h("button.btn.primary.big", { type: "button" }, icon("scissors"), h("span", {}, "Split into files"));
        go.addEventListener("click", () => {
          const current = groups();
          void download(current, uniqueNames(current.map((g, k) => `${nameFor(k, g)}.pdf`)), true);
        });

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
            paint();
          });
          grid.append(card);
        });

        body.replaceChildren(
          h("div.toolbar", {}, summary, h("div.actions", {}, go)),
          h("div.signals", {}, ...cards),
          h("label.option", {}, h("span", {}, "File names start with"), prefixInput),
          h("p.fine-print", {}, "The pages below are shaded per document. Click a page to start a new document there, or to join it to the one before."),
          grid,
          list,
        );
        paintList();
      }

      async function download(gs: number[][], names: string[], zip = false) {
        const files = await host.work(pdf.split(doc.input, gs), "Couldn't cut the PDF up.");
        if (!files) return;
        const named = files.map((bytes, k) => ({ name: names[k], bytes }));
        if (named.length === 1 && !zip) return saveFile(named[0].bytes, named[0].name);
        saveZip(named, `${prefix}_split.zip`);
        toast(`Zipped ${plural(named.length, "file")}. Sharp!`, "ok");
        results.replaceChildren(h("div.result-card", {}, h("div.result-icon", {}, icon("file")), h("div.file-main", {}, h("div.file-name", {}, `${plural(named.length, "file")} ready`), h("div.file-meta", {}, "The ZIP was saved. You can also download any one from the list.")), h("button.btn.primary", { type: "button", onclick: () => saveZip(named, `${prefix}_split.zip`) }, icon("download"), "Download again")));
        reveal(results);
        celebrate(`Auto split done: ${plural(named.length, "file")}!`, results);
        mascot.mood("happy");
      }

      return wrap;
    },
  });
}
