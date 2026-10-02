import { pdf, PdfError } from "../core/client";
import { browserImageToPng, ENGINE_IMAGES } from "../convert/images";
import { fill, h, icon, replay } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile, saveZip } from "../ui/files";
import { celebrate, mascot, oops, pick, reveal, toast } from "../ui/fun";

type Mode = "to" | "from";
type Target = "docx" | "png" | "jpg" | "txt" | "html";
type State = "ready" | "working" | "done" | "error" | "password";

interface Output {
  name: string;
  bytes: Uint8Array;
}

interface Item {
  file: File;
  kind: string;
  state: State;
  note?: string;
  password?: string;
  outputs: Output[];
  row: HTMLElement;
}

// What "To PDF" accepts, grouped for the help text.
const TO_PDF = /\.(docx|xlsx|pptx|png|jpe?g|gif|bmp|tiff?|webp|avif|svg|txt|text|md|markdown|html?|xhtml|epub|xps|oxps|cbz|fb2|mobi|pdf|doc|xls|ppt)$/i;
const OLD_OFFICE = /\.(doc|xls|ppt)$/i;
const PICTURE = /\.(png|jpe?g|gif|bmp|tiff?|webp|avif|svg)$/i;

const TARGETS: { id: Target; label: string; hint: string }[] = [
  { id: "docx", label: "Word", hint: ".docx you can edit" },
  { id: "png", label: "Pictures (PNG)", hint: "Sharp, one per page" },
  { id: "jpg", label: "Pictures (JPG)", hint: "Smaller files" },
  { id: "txt", label: "Text", hint: "Plain .txt" },
  { id: "html", label: "Web page", hint: ".html" },
];

const BUSY = ["Changing outfits…", "Abracadabra, sho!", "Pantsula moves: shuffling formats…", "Hold my bucket hat…", "Translating to PDF-ish…", "Mfowethu, this one's a big file…"];

const kindOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "?").toUpperCase().replace("JPEG", "JPG").replace("MARKDOWN", "MD");

export function convertTool(): HTMLElement {
  let mode: Mode = "to";
  let target: Target = "docx";
  let items: Item[] = [];
  let busy = false;

  const list = h("ul.file-list", { "aria-label": "Files to convert" });
  const summary = h("div.summary");
  const runBtn = h("button.btn.primary.big", { type: "button" }, h("span.glyph-icon", { "aria-hidden": "true" }, "⇄"), h("span", {}, "Convert"));
  const zipBtn = h("button.btn", { type: "button", hidden: true }, icon("download"), "Download all (.zip)");
  const clearBtn = h("button.btn.ghost", { type: "button" }, "Clear");
  const combine = h("input", { type: "checkbox", checked: true });
  const fitPage = h("select.input.small.select", { "aria-label": "Page size for pictures" }, h("option", { value: "a4" }, "A4 pages"), h("option", { value: "fit" }, "Page fits the picture"));
  const dpi = h("select.input.small.select", { "aria-label": "Picture quality" }, h("option", { value: "96" }, "Screen (96 dpi)"), h("option", { value: "150", selected: true }, "Good (150 dpi)"), h("option", { value: "300" }, "Print (300 dpi)"));
  const options = h("div.ocr-options");
  const toolbar = h("div.toolbar", { hidden: true }, summary, h("div.actions", {}, clearBtn, zipBtn, runBtn));
  const result = h("div.result-slot");
  const modeBar = h("div.segments", { role: "group", "aria-label": "Conversion direction" });
  const targetBar = h("div.segments.compact.targets", { role: "group", "aria-label": "Convert PDFs to" });
  const zoneSlot = h("div");
  const help = h("p.fine-print");

  function buildZone() {
    const zone =
      mode === "to"
        ? dropzone({
            multiple: true,
            folder: true,
            title: "Drop Word, Excel, PowerPoint, pictures or other files",
            accept: { test: (f) => TO_PDF.test(f.name), picker: ".docx,.xlsx,.pptx,.doc,.xls,.ppt,image/*,.svg,.txt,.md,.html,.htm,.epub,.xps,.cbz,.fb2,.mobi,.pdf", what: "supported file" },
            onFiles: (f) => add(f),
          })
        : dropzone({ multiple: true, folder: true, title: "Drop PDFs to convert", onFiles: (f) => add(f) });
    zoneSlot.replaceChildren(zone);
    zone.classList.toggle("compact", items.length > 0);
  }

  function renderModes() {
    const seg = (m: Mode, label: string, hint: string) =>
      h("button.segment", { type: "button", "aria-pressed": String(mode === m), onclick: () => switchMode(m) }, h("strong", {}, label), h("span", {}, hint));
    fill(modeBar, seg("to", "To PDF", "Word, Excel, PowerPoint, pictures, text, web pages, e-books"), seg("from", "From PDF", "PDF to Word, pictures, text or a web page"));
    fill(
      targetBar,
      ...(mode === "from"
        ? TARGETS.map((t) =>
            h("button.segment", { type: "button", "aria-pressed": String(target === t.id), onclick: () => ((target = t.id), resetOutputs(), renderModes()) }, h("strong", {}, t.label), h("span", {}, t.hint)),
          )
        : []),
    );
    targetBar.hidden = mode !== "from";
    fill(
      options,
      mode === "to" && h("label.check", {}, combine, h("span", {}, "Combine everything into one PDF")),
      mode === "to" && h("label.option", {}, h("span", {}, "Pictures on"), fitPage),
      mode === "from" && (target === "png" || target === "jpg") && h("label.option", {}, h("span", {}, "Quality"), dpi),
    );
    help.replaceChildren(
      icon("shield"),
      mode === "to"
        ? "Word keeps headings, bold, lists, tables and pictures; Excel becomes neat tables; PowerPoint keeps text and pictures in place. Old .doc/.xls/.ppt files: open and Save As .docx/.xlsx/.pptx first."
        : target === "docx"
          ? "Makes an editable Word file with the text's fonts, sizes and colours, plus pictures. Complex layouts (columns, forms) come out simplified."
          : "Everything is converted on your device.",
    );
  }

  function switchMode(m: Mode) {
    if (busy || m === mode) return;
    mode = m;
    items = [];
    list.replaceChildren();
    result.replaceChildren();
    renderModes();
    buildZone();
    refresh();
  }

  function resetOutputs() {
    for (const i of items) {
      i.outputs = [];
      if (i.state === "done" || i.state === "error") {
        i.state = "ready";
        i.note = undefined;
      }
      render(i);
    }
    result.replaceChildren();
    refresh();
  }

  function add(files: File[]) {
    result.replaceChildren();
    for (const file of files) {
      const item: Item = { file, kind: kindOf(file.name), state: "ready", outputs: [], row: h("li.file") };
      if (mode === "to" && OLD_OFFICE.test(file.name)) {
        item.state = "error";
        item.note = `Old ${item.kind} format. Open it and "Save As" .${item.kind.toLowerCase()}x, then try again.`;
      }
      item.row.style.setProperty("--i", String(items.length % 12));
      items.push(item);
      render(item);
      list.append(item.row);
    }
    refresh();
  }

  function render(item: Item) {
    let pwField: HTMLFormElement | false = false;
    if (item.state === "password") {
      const input = h("input.input.small", { type: "password", placeholder: "Opening password", "aria-label": `Password for ${item.file.name}` });
      pwField = h("form.row-password", {}, input, h("button.btn.small", { type: "submit" }, "Use"));
      pwField.addEventListener("submit", (e) => {
        e.preventDefault();
        item.password = input.value;
        item.state = "ready";
        item.note = undefined;
        render(item);
        refresh();
      });
    }
    const outKind = mode === "to" ? "PDF" : target === "jpg" ? "JPG" : target.toUpperCase();
    item.row.dataset.state = item.state === "password" ? "password" : item.state === "ready" ? "ready-convert" : item.state;
    fill(
      item.row,
      h("div.kind-flip", { "aria-hidden": "true" }, h("span.kind.front", {}, item.kind), h("span.kind.back", {}, outKind)),
      h(
        "div.file-main",
        {},
        h("div.file-name", { title: item.file.name }, item.file.name),
        h("div.file-meta", {}, item.note ?? formatSize(item.file.size)),
        pwField,
      ),
      item.outputs.length > 0 &&
        h(
          "button.icon-btn",
          { type: "button", title: "Download", "aria-label": `Download ${item.file.name} converted`, onclick: () => downloadItem(item) },
          icon("download"),
        ),
      h("button.icon-btn.subtle", { type: "button", title: "Remove", "aria-label": `Remove ${item.file.name}`, disabled: busy, onclick: () => remove(item) }, icon("x")),
    );
  }

  function downloadItem(item: Item) {
    if (item.outputs.length === 1) saveFile(item.outputs[0].bytes, item.outputs[0].name);
    else saveZip(item.outputs, `${baseName(item.file.name)}-${target}.zip`);
  }

  function remove(item: Item) {
    items = items.filter((i) => i !== item);
    item.row.classList.add("leaving");
    setTimeout(() => item.row.remove(), 300);
    refresh();
  }

  function refresh() {
    const ready = items.filter((i) => i.state === "ready").length;
    const done = items.filter((i) => i.state === "done").length;
    toolbar.hidden = items.length === 0;
    options.hidden = items.length === 0;
    zoneSlot.firstElementChild?.classList.toggle("compact", items.length > 0);
    runBtn.disabled = busy || ready === 0;
    zipBtn.hidden = done < 2 || (mode === "to" && combine.checked);
    fill(
      summary,
      h("span.chip", {}, plural(items.length, "file")),
      ready > 0 && h("span.chip.warn", {}, `${ready} to convert`),
      done > 0 && h("span.chip.good", {}, `${done} converted`),
    );
  }

  /** Converts one file to PDF bytes. */
  async function toPdf(item: Item): Promise<Uint8Array> {
    const name = item.file.name;
    const bytes = await readBytes(item.file);
    if (/\.pdf$/i.test(name)) return bytes;
    if (/\.docx$/i.test(name)) {
      const { wordToHtml } = await import("../convert/office");
      return pdf.htmlToPdf(await wordToHtml(bytes));
    }
    if (/\.xlsx$/i.test(name)) {
      const { excelToHtml } = await import("../convert/office");
      const { html, landscape } = excelToHtml(bytes);
      return pdf.htmlToPdf(html, landscape);
    }
    if (/\.pptx$/i.test(name)) {
      const { pptxToSlides } = await import("../convert/office");
      return pdf.slidesToPdf(pptxToSlides(bytes));
    }
    if (PICTURE.test(name)) {
      const image = ENGINE_IMAGES.test(name) ? bytes : await browserImageToPng(item.file);
      return pdf.imagesToPdf([image], { pageSize: fitPage.value as "a4" | "fit" });
    }
    return pdf.toPdf(bytes, name);
  }

  /** Converts one PDF to the chosen format. */
  async function fromPdf(item: Item): Promise<Output[]> {
    const input = { bytes: await readBytes(item.file), password: item.password };
    const base = baseName(item.file.name);
    switch (target) {
      case "docx":
        return [{ name: `${base}.docx`, bytes: await pdf.pdfToDocx(input, base) }];
      case "txt":
        return [{ name: `${base}.txt`, bytes: new TextEncoder().encode(await pdf.pdfToText(input)) }];
      case "html":
        return [{ name: `${base}.html`, bytes: new TextEncoder().encode(await pdf.pdfToHtml(input)) }];
      default: {
        const images = await pdf.pdfToImages(input, target, Number(dpi.value));
        return images.map((bytes, i) => ({ name: images.length === 1 ? `${base}.${target}` : `${base}-page-${String(i + 1).padStart(3, "0")}.${target}`, bytes }));
      }
    }
  }

  runBtn.addEventListener("click", async () => {
    const queue = items.filter((i) => i.state === "ready");
    if (queue.length === 0) return;
    busy = true;
    result.replaceChildren();
    refresh();
    const chatter = window.setInterval(() => mascot.say(pick(BUSY)), 2200);
    const pdfs: Output[] = [];
    let ok = 0;
    try {
      await mascot.busy(
        (async () => {
          for (const item of queue) {
            item.state = "working";
            item.note = "Converting…";
            render(item);
            try {
              if (mode === "to") {
                const bytes = await toPdf(item);
                item.outputs = [{ name: `${baseName(item.file.name.replace(/\.[^.]+$/, ""))}.pdf`, bytes }];
                pdfs.push(item.outputs[0]);
              } else {
                item.outputs = await fromPdf(item);
              }
              const size = item.outputs.reduce((n, o) => n + o.bytes.byteLength, 0);
              item.state = "done";
              item.note = `${item.outputs.length > 1 ? `${item.outputs.length} files · ` : ""}${formatSize(size)}`;
              ok++;
              render(item);
              replay(item.row, "converted");
            } catch (err) {
              if (err instanceof PdfError && err.kind === "password") {
                item.state = "password";
                item.note = item.password ? "Wrong password, try again" : "Needs a password to open";
              } else {
                item.state = "error";
                item.note = err instanceof Error ? err.message : "Couldn't convert this file.";
              }
              render(item);
              replay(item.row, "shake");
            }
            refresh();
          }
          if (mode === "to" && combine.checked && pdfs.length > 1) {
            const merged = await pdf.merge(pdfs.map((p) => ({ bytes: p.bytes })));
            showCombined(merged, pdfs.length);
          }
        })(),
      );
    } finally {
      clearInterval(chatter);
      busy = false;
      items.forEach(render);
      refresh();
    }
    if (ok > 0) celebrate(ok === 1 ? "Sho! Converted." : `Sho mfowethu! ${ok} files converted.`, runBtn);
    else oops("Nothing could be converted.");
  });

  function showCombined(bytes: Uint8Array, count: number) {
    const name = "converted.pdf";
    const card = h(
      "div.result-card",
      {},
      h("div.result-icon", {}, icon("file")),
      h("div.file-main", {}, h("div.file-name", {}, name), h("div.file-meta", {}, `${plural(count, "file")} combined · ${formatSize(bytes.byteLength)}`)),
      h("button.btn.primary", { type: "button", onclick: () => saveFile(bytes, name) }, icon("download"), "Download"),
    );
    result.replaceChildren(card);
    reveal(card);
  }

  zipBtn.addEventListener("click", () => {
    const outputs = items.flatMap((i) => i.outputs);
    saveZip(outputs, mode === "to" ? "eish-pdf-converted.zip" : `eish-pdf-${target}.zip`);
    toast(`Zipped ${plural(outputs.length, "file")}. Shap!`, "ok");
  });

  clearBtn.addEventListener("click", () => {
    if (busy) return;
    items = [];
    list.replaceChildren();
    result.replaceChildren();
    refresh();
  });

  combine.addEventListener("change", refresh);
  dpi.addEventListener("change", resetOutputs);
  fitPage.addEventListener("change", resetOutputs);

  renderModes();
  buildZone();
  refresh();
  return h(
    "section.tool",
    { id: "tool-convert" },
    h("div.tool-head", {}, h("h2", {}, "Convert"), h("p", {}, "Turn almost anything into a PDF, or a PDF into Word, pictures, text or a web page.")),
    modeBar,
    targetBar,
    zoneSlot,
    help,
    options,
    toolbar,
    list,
    result,
  );
}
