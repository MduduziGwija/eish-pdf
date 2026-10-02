import { pdf, PdfError } from "../core/client";
import { wordsFromBlocks, type TesseractBlock } from "../core/ocrwords";
import type { PdfInfo } from "../core/pdf";
import { LANGUAGES, startOcr, type OcrEngine, type OcrLanguage } from "../ocr/engine";
import { fill, h, icon, replay } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile, saveZip } from "../ui/files";
import { celebrate, mascot, oops, pick, toast } from "../ui/fun";

type State = "checking" | "ready" | "working" | "done" | "free" | "error" | "password";

interface Item {
  file: File;
  bytes: Uint8Array;
  info?: PdfInfo;
  password?: string;
  state: State;
  note?: string;
  progress: number;
  result?: Uint8Array;
  row: HTMLElement;
}

/** Long side of the page image Tesseract reads, in pixels (~300 dpi for A4). */
const MAX_SIDE = 3600;

const READING = [
  "Putting on my reading glasses…",
  "Squinting at the pixels, mfowethu…",
  "Reading it out loud. Quietly.",
  "Sho, who wrote this so small?",
  "Letter by letter, word by word…",
  "Ayoba, I can read this!",
];

export function ocrTool(): HTMLElement {
  let items: Item[] = [];
  let busy = false;

  const list = h("ul.file-list", { "aria-label": "Files to make searchable" });
  const language = h("select.input.select", { "aria-label": "Language of the documents" });
  for (const l of LANGUAGES) language.append(h("option", { value: l.id }, l.label));
  const skip = h("input", { type: "checkbox", checked: true });
  const runBtn = h("button.btn.primary.big", { type: "button" }, icon("ocr"), h("span", {}, "Make searchable"));
  const zipBtn = h("button.btn", { type: "button", hidden: true }, icon("download"), "Download all (.zip)");
  const clearBtn = h("button.btn.ghost", { type: "button" }, "Clear");
  const summary = h("div.summary");
  const options = h(
    "div.ocr-options",
    {},
    h("label.option", {}, h("span", {}, "Language"), language),
    h("label.check", {}, skip, h("span", {}, "Skip pages that already have text")),
  );
  const toolbar = h("div.toolbar", { hidden: true }, summary, h("div.actions", {}, clearBtn, zipBtn, runBtn));

  const zone = dropzone({ multiple: true, folder: true, title: "Drop scanned PDFs here", onFiles: (f) => void add(f) });

  async function add(files: File[]) {
    for (const file of files) {
      const item: Item = { file, bytes: await readBytes(file), state: "checking", progress: 0, row: h("li.file") };
      item.row.style.setProperty("--i", String(items.length % 12));
      items.push(item);
      render(item);
      list.append(item.row);
      void check(item);
    }
    refresh();
  }

  async function check(item: Item) {
    try {
      item.info = await pdf.inspect({ bytes: item.bytes, password: item.password });
      if (item.info.status === "password") {
        item.state = "password";
        item.note = item.info.wrongPassword ? "Wrong password, try again" : "Needs a password to open";
      } else {
        item.state = "ready";
        item.note = undefined;
      }
    } catch (err) {
      item.state = "error";
      item.note = err instanceof Error ? err.message : String(err);
    }
    render(item);
    refresh();
  }

  function render(item: Item) {
    let pwField: HTMLFormElement | false = false;
    if (item.state === "password") {
      const input = h("input.input.small", { type: "password", placeholder: "Opening password", "aria-label": `Password for ${item.file.name}` });
      pwField = h("form.row-password", {}, input, h("button.btn.small", { type: "submit" }, "Open"));
      pwField.addEventListener("submit", (e) => {
        e.preventDefault();
        item.password = input.value;
        item.state = "checking";
        render(item);
        void check(item);
      });
    }
    const meta = item.note ?? [item.info?.pages ? plural(item.info.pages, "page") : "Checking…", formatSize(item.file.size)].join(" · ");
    item.row.dataset.state = item.state;
    fill(
      item.row,
      h("div.file-icon.scan", {}, icon("ocr")),
      h(
        "div.file-main",
        {},
        h("div.file-name", { title: item.file.name }, item.file.name),
        h("div.file-meta", {}, meta),
        item.state === "working" && h("div.progress", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(item.progress * 100)) }, h("span", { style: `width:${item.progress * 100}%` })),
        pwField,
      ),
      h("span.badge", {}, { checking: "Checking…", ready: "Scanned", working: "Reading…", done: "Searchable!", free: "Already searchable", error: "Eish", password: "Needs password" }[item.state]),
      item.result && h("button.icon-btn", { type: "button", title: "Download", "aria-label": `Download ${item.file.name}`, onclick: () => saveFile(item.result!, outName(item)) }, icon("download")),
      h("button.icon-btn.subtle", { type: "button", title: "Remove", "aria-label": `Remove ${item.file.name}`, disabled: busy && item.state === "working", onclick: () => remove(item) }, icon("x")),
    );
  }

  /** Updates just the progress bar and note, without rebuilding the row. */
  function tick(item: Item) {
    const bar = item.row.querySelector<HTMLElement>(".progress span");
    if (bar) bar.style.width = `${item.progress * 100}%`;
    item.row.querySelector(".progress")?.setAttribute("aria-valuenow", String(Math.round(item.progress * 100)));
    const meta = item.row.querySelector(".file-meta");
    if (meta && item.note) meta.textContent = item.note;
  }

  const outName = (item: Item) => `${baseName(item.file.name)}-searchable.pdf`;

  function remove(item: Item) {
    items = items.filter((i) => i !== item);
    item.row.classList.add("leaving");
    setTimeout(() => item.row.remove(), 300);
    refresh();
  }

  function refresh() {
    const count = (s: State) => items.filter((i) => i.state === s).length;
    toolbar.hidden = items.length === 0;
    options.hidden = items.length === 0;
    zone.classList.toggle("compact", items.length > 0);
    zipBtn.hidden = count("done") < 2;
    runBtn.disabled = busy || count("ready") === 0;
    fill(
      summary,
      h("span.chip", {}, plural(items.length, "file")),
      count("ready") > 0 && h("span.chip.warn", {}, `${count("ready")} to read`),
      count("password") > 0 && h("span.chip.bad", {}, `${count("password")} need a password`),
      count("done") > 0 && h("span.chip.good", {}, `${count("done")} searchable`),
    );
  }

  async function process(engine: OcrEngine, item: Item): Promise<boolean> {
    const { session, pages } = await pdf.open({ bytes: item.bytes, password: item.password });
    let read = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        const label = `Reading page ${i + 1} of ${pages.length}…`;
        item.note = label;
        item.progress = i / pages.length;
        tick(item);
        if (skip.checked && (await pdf.hasText(session, i))) {
          skipped++;
          continue;
        }
        const { width, height } = pages[i];
        const scale = Math.min(300 / 72, MAX_SIDE / Math.max(width, height));
        const png = await pdf.render(session, i, scale);
        const blocks = await engine.read(png, (p) => {
          item.progress = (i + p) / pages.length;
          tick(item);
        });
        await pdf.ocrLayer(session, i, wordsFromBlocks(blocks as TesseractBlock[], scale));
        read++;
      }
      if (read === 0) {
        item.state = "free";
        item.note = "Every page already has text, so there was nothing to read.";
        return false;
      }
      item.result = await pdf.save(session);
      item.state = "done";
      item.note = `${plural(read, "page")} read${skipped ? ` · ${skipped} already had text` : ""} · ${formatSize(item.result.byteLength)}`;
      return true;
    } finally {
      void pdf.close(session);
    }
  }

  runBtn.addEventListener("click", async () => {
    const queue = items.filter((i) => i.state === "ready");
    if (queue.length === 0) return;
    busy = true;
    refresh();
    let ok = 0;
    let engine: OcrEngine | undefined;
    const chatter = window.setInterval(() => mascot.say(pick(READING)), 2600);
    try {
      await mascot.busy(
        (async () => {
          mascot.mood("read");
          mascot.say("Putting on my reading glasses…");
          engine = await startOcr(language.value as OcrLanguage);
          for (const item of queue) {
            item.state = "working";
            item.progress = 0;
            render(item);
            mascot.mood("read");
            try {
              if (await process(engine, item)) ok++;
              render(item);
              replay(item.row, "unlocked");
            } catch (err) {
              item.state = "error";
              item.note = err instanceof PdfError ? err.message : "Couldn't read this file.";
              render(item);
              replay(item.row, "shake");
            }
            refresh();
          }
        })(),
      );
    } catch {
      oops("The OCR engine didn't load. Check your connection and try again.");
    } finally {
      clearInterval(chatter);
      await engine?.stop();
      busy = false;
      refresh();
    }
    if (ok > 0) celebrate(ok === 1 ? "Sho mfowethu! Now you can search it." : `Sho mfowethu! ${ok} files are searchable.`, runBtn);
  });

  zipBtn.addEventListener("click", () => {
    const done = items.filter((i) => i.result);
    saveZip(done.map((i) => ({ name: outName(i), bytes: i.result! })), "eish-pdf-searchable.zip");
    toast(`Zipped ${plural(done.length, "file")}. Shap!`, "ok");
  });

  clearBtn.addEventListener("click", () => {
    if (busy) return;
    items = [];
    list.replaceChildren();
    refresh();
  });

  refresh();
  return h(
    "section.tool",
    { id: "tool-ocr" },
    h(
      "div.tool-head",
      {},
      h("h2", {}, "Make scans searchable (OCR)"),
      h("p", {}, "Turns scanned pages into text you can search, select and copy. The page looks exactly the same."),
    ),
    zone,
    h("p.fine-print", {}, icon("shield"), "Reading happens on your device. The first run downloads the reading engine (about 7 MB) from this site, then it's quick."),
    options,
    toolbar,
    list,
  );
}
