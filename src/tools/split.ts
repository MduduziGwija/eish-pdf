import { pdf, PdfError } from "../core/client";
import type { PageSize } from "../core/pdf";
import { parsePageRanges, range } from "../core/ranges";
import { h, icon, reducedMotion, sleep } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile, saveZip } from "../ui/files";
import { celebrate, mascot, oops, reveal, toast } from "../ui/fun";
import { closeSession, lazyThumb } from "../ui/thumbs";

type Mode = "every" | "ranges" | "pick";

interface Doc {
  file: File;
  bytes: Uint8Array;
  password?: string;
  session: number;
  pages: PageSize[];
}

export function splitTool(): HTMLElement {
  let doc: Doc | undefined;
  let mode: Mode = "every";
  const picked = new Set<number>();

  const workspace = h("div.split-workspace", { hidden: true });
  const results = h("div.result-slot");

  const zone = dropzone({ multiple: false, title: "Drop one PDF to cut up", onFiles: ([f]) => void load(f) });

  async function load(file: File, password?: string, bytes?: Uint8Array) {
    bytes ??= await readBytes(file);
    try {
      if (doc) closeSession(doc.session);
      const { session, pages } = await pdf.open({ bytes, password });
      doc = { file, bytes, password, session, pages };
      zone.hidden = true;
      picked.clear();
      results.replaceChildren();
      render();
    } catch (err) {
      if (err instanceof PdfError && err.kind === "password") askPassword(file, bytes, !!password);
      else oops(err instanceof Error ? err.message : "Couldn't open that file.");
    }
  }

  function askPassword(file: File, bytes: Uint8Array, wrong: boolean) {
    const input = h("input.input", { type: "password", placeholder: "Opening password", "aria-label": "Opening password" });
    const form = h(
      "form.password-gate",
      {},
      icon("key"),
      h("div", {}, h("strong", {}, file.name), h("p", {}, wrong ? "Eish, wrong password. Try again?" : "This one needs its opening password.")),
      input,
      h("button.btn.primary", { type: "submit" }, "Open"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void load(file, input.value, bytes);
    });
    workspace.hidden = false;
    workspace.replaceChildren(form);
    if (wrong) form.animate([{ transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "none" }], { duration: 300, iterations: 2 });
    input.focus();
  }

  function render() {
    if (!doc) return;
    const d = doc;
    const modeBtn = (m: Mode, label: string, hint: string) =>
      h(
        "button.segment",
        { type: "button", "aria-pressed": String(mode === m), onclick: () => ((mode = m), render()) },
        h("strong", {}, label),
        h("span", {}, hint),
      );

    const rangesInput = h("input.input", {
      type: "text",
      placeholder: `e.g. 1-3, 5, 8-${d.pages.length}`,
      "aria-label": "Page ranges",
      spellcheck: false,
    });

    const grid = h("div.thumb-grid", { role: mode === "pick" ? "group" : undefined, "aria-label": "Pages" });
    d.pages.forEach((_, i) => {
      const card = h(
        "button.thumb",
        { type: "button", "aria-pressed": String(picked.has(i)), disabled: mode !== "pick", "aria-label": `Page ${i + 1}` },
        lazyThumb(d.session, i, `Page ${i + 1}`),
        h("span.thumb-num", {}, String(i + 1)),
      );
      card.style.setProperty("--i", String(i % 24));
      card.addEventListener("click", () => {
        if (picked.has(i)) picked.delete(i);
        else picked.add(i);
        card.setAttribute("aria-pressed", String(picked.has(i)));
        go.disabled = picked.size === 0;
        counter.textContent = `${plural(picked.size, "page")} picked`;
      });
      grid.append(card);
    });

    const counter = h("span.chip", {}, `${plural(picked.size, "page")} picked`);
    const go = h("button.btn.primary.big", { type: "button", disabled: mode === "pick" && picked.size === 0 }, icon("scissors"), h("span", {}, "Split"));
    go.addEventListener("click", () => void run(rangesInput.value, grid));

    workspace.hidden = false;
    workspace.replaceChildren(
      h(
        "div.doc-card",
        {},
        h("div.result-icon", {}, icon("file")),
        h("div.file-main", {}, h("div.file-name", {}, d.file.name), h("div.file-meta", {}, `${plural(d.pages.length, "page")} · ${formatSize(d.file.size)}`)),
        h("button.btn.ghost", { type: "button", onclick: reset }, "Change file"),
      ),
      h(
        "div.segments",
        { role: "group", "aria-label": "How to split" },
        modeBtn("every", "Every page", "One file per page"),
        modeBtn("ranges", "By ranges", "e.g. 1-3, 5, 8-"),
        modeBtn("pick", "Pick pages", "Click pages → one file"),
      ),
      h(
        "div.toolbar",
        {},
        mode === "ranges" ? h("label.grow", {}, rangesInput) : mode === "pick" ? counter : h("span.chip", {}, `Makes ${plural(d.pages.length, "file")}`),
        h("div.actions", {}, go),
      ),
      grid,
    );
    if (mode === "ranges") rangesInput.focus();
  }

  async function run(rangesText: string, grid: HTMLElement) {
    if (!doc) return;
    let groups: number[][];
    try {
      groups =
        mode === "every"
          ? range(0, doc.pages.length - 1).map((p) => [p])
          : mode === "ranges"
            ? parsePageRanges(rangesText, doc.pages.length)
            : [[...picked].sort((a, b) => a - b)];
    } catch (err) {
      return oops(err instanceof Error ? err.message : "Those ranges don't look right.");
    }

    results.replaceChildren();
    const snip = h("div.snip", { "aria-hidden": "true" }, icon("scissors"));
    grid.append(snip);
    try {
      const [files] = await mascot.busy(Promise.all([pdf.split({ bytes: doc.bytes, password: doc.password }, groups), sleep(900)]));
      const base = baseName(doc.file.name);
      const named = files.map((bytes, k) => ({ name: `${base}_${label(groups[k])}.pdf`, bytes }));
      showResults(named, base);
      reveal(results);
      celebrate(files.length === 1 ? "Snip snip! Here's your file." : `Snip snip! ${files.length} files.`, results);
    } catch (err) {
      oops(err instanceof PdfError ? err.message : "Splitting failed.");
    } finally {
      snip.remove();
    }
  }

  function showResults(files: { name: string; bytes: Uint8Array }[], base: string) {
    const chips = files.map((f, k) => {
      const chip = h(
        "button.piece",
        { type: "button", title: `Download ${f.name}`, onclick: () => saveFile(f.bytes, f.name) },
        icon("file"),
        h("span", {}, f.name),
      );
      chip.style.setProperty("--i", String(k % 30));
      if (!reducedMotion()) chip.style.setProperty("--fly", `${(Math.random() - 0.5) * 160}px`);
      return chip;
    });
    results.replaceChildren(
      h(
        "div.result-card.column",
        {},
        h(
          "div.result-row",
          {},
          h("strong", {}, plural(files.length, "file") + " ready"),
          files.length > 1 &&
            h(
              "button.btn.primary",
              {
                type: "button",
                onclick: () => {
                  saveZip(files, `${base}_split.zip`);
                  toast("Zipped. Sharp sharp!", "ok");
                },
              },
              icon("download"),
              "Download all (.zip)",
            ),
        ),
        h("div.pieces", {}, ...chips),
      ),
    );
  }

  function reset() {
    if (doc) closeSession(doc.session);
    doc = undefined;
    zone.hidden = false;
    workspace.hidden = true;
    workspace.replaceChildren();
    results.replaceChildren();
  }

  return h(
    "section.tool",
    { id: "tool-split" },
    h("div.tool-head", {}, h("h2", {}, "Split a PDF"), h("p", {}, "Cut a PDF into pieces — every page, chosen ranges, or the pages you pick.")),
    zone,
    workspace,
    results,
  );
}

/** [0,1,2] -> "p1-3", [4] -> "p5", [0,2] -> "p1,3" */
function label(group: number[]): string {
  const contiguous = group.every((p, i) => i === 0 || p === group[i - 1] + 1);
  if (group.length === 1) return `p${group[0] + 1}`;
  if (contiguous) return `p${group[0] + 1}-${group[group.length - 1] + 1}`;
  return group.length <= 4 ? `p${group.map((p) => p + 1).join(",")}` : `${group.length}pages`;
}
