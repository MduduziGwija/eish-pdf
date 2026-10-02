import { pdf, PdfError } from "../core/client";
import type { PdfInfo } from "../core/pdf";
import { fill, h, icon, reducedMotion, sleep } from "../ui/dom";
import { dropzone, formatSize, plural, readBytes, saveFile } from "../ui/files";
import { celebrate, mascot, oops, reveal } from "../ui/fun";

interface Item {
  id: number;
  file: File;
  bytes: Uint8Array;
  info?: PdfInfo;
  password?: string;
  error?: string;
  row: HTMLElement;
}

export function mergeTool(): HTMLElement {
  let items: Item[] = [];
  let nextId = 1;
  let dragged: Item | undefined;

  const list = h("ol.file-list.sortable", { "aria-label": "Files to merge, in order" });
  const nameInput = h("input.input", { type: "text", value: "merged", "aria-label": "Name of the merged file", spellcheck: false });
  const mergeBtn = h("button.btn.primary.big", { type: "button" }, icon("merge"), h("span", {}, "Merge"));
  const clearBtn = h("button.btn.ghost", { type: "button" }, "Clear");
  const summary = h("div.summary");
  const toolbar = h(
    "div.toolbar",
    { hidden: true },
    summary,
    h("div.actions", {}, h("label.name-field", {}, h("span", {}, "Save as"), nameInput, h("span.ext", {}, ".pdf")), clearBtn, mergeBtn),
  );
  const result = h("div.result-slot");

  const zone = dropzone({ multiple: true, folder: true, title: "Drop the PDFs you want to join", onFiles: (f) => void add(f) });

  async function add(files: File[]) {
    result.replaceChildren();
    for (const file of files) {
      const item: Item = { id: nextId++, file, bytes: await readBytes(file), row: h("li.file", { draggable: "true" }) };
      item.row.style.setProperty("--i", String(items.length % 12));
      items.push(item);
      wireDrag(item);
      render(item);
      list.append(item.row);
      void check(item);
    }
    refresh();
  }

  async function check(item: Item) {
    try {
      item.info = await pdf.inspect({ bytes: item.bytes, password: item.password });
      item.error = item.info.status === "password" ? (item.info.wrongPassword ? "Wrong password, try again" : "Needs a password to open") : undefined;
    } catch (err) {
      item.error = err instanceof Error ? err.message : String(err);
    }
    render(item);
    refresh();
  }

  function render(item: Item) {
    const index = items.indexOf(item);
    const needsPw = item.info?.status === "password";
    let pwField: HTMLFormElement | false = false;
    if (needsPw) {
      const input = h("input.input.small", { type: "password", placeholder: "Opening password", "aria-label": `Password for ${item.file.name}` });
      pwField = h("form.row-password", {}, input, h("button.btn.small", { type: "submit" }, "Open"));
      pwField.addEventListener("submit", (e) => {
        e.preventDefault();
        item.password = input.value;
        void check(item);
      });
    }
    item.row.dataset.state = item.error ? (needsPw ? "password" : "error") : item.info ? "free" : "checking";
    item.row.replaceChildren(
      h("span.order", { "aria-hidden": "true" }, String(index + 1)),
      h(
        "div.file-main",
        {},
        h("div.file-name", { title: item.file.name }, item.file.name),
        h("div.file-meta", {}, item.error ?? [item.info ? plural(item.info.pages, "page") : "Checking…", formatSize(item.file.size)].join(" · ")),
        pwField,
      ),
      h("button.icon-btn.subtle", { type: "button", title: "Move up", "aria-label": `Move ${item.file.name} up`, disabled: index === 0, onclick: () => move(item, -1) }, icon("up")),
      h("button.icon-btn.subtle", { type: "button", title: "Move down", "aria-label": `Move ${item.file.name} down`, disabled: index === items.length - 1, onclick: () => move(item, 1) }, icon("down")),
      h("button.icon-btn.subtle", { type: "button", title: "Remove", "aria-label": `Remove ${item.file.name}`, onclick: () => remove(item) }, icon("x")),
    );
  }

  /** Reorders with a FLIP animation so rows glide into place. */
  function reorder(next: Item[]) {
    const before = new Map(items.map((i) => [i, i.row.getBoundingClientRect().top]));
    items = next;
    list.append(...items.map((i) => i.row));
    items.forEach(render);
    if (reducedMotion()) return;
    for (const i of items) {
      const dy = (before.get(i) ?? 0) - i.row.getBoundingClientRect().top;
      if (dy) i.row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1.2)" });
    }
  }

  function move(item: Item, delta: number) {
    const from = items.indexOf(item);
    const to = from + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, item);
    reorder(next);
  }

  function wireDrag(item: Item) {
    item.row.addEventListener("dragstart", (e) => {
      dragged = item;
      item.row.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", item.file.name);
    });
    item.row.addEventListener("dragend", () => {
      dragged = undefined;
      item.row.classList.remove("dragging");
    });
    item.row.addEventListener("dragover", (e) => {
      if (!dragged || dragged === item) return;
      e.preventDefault();
      const next = items.filter((i) => i !== dragged);
      const rect = item.row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      next.splice(next.indexOf(item) + (after ? 1 : 0), 0, dragged);
      if (next.some((i, k) => i !== items[k])) reorder(next);
    });
  }

  function remove(item: Item) {
    items = items.filter((i) => i !== item);
    item.row.classList.add("leaving");
    setTimeout(() => {
      item.row.remove();
      items.forEach(render);
    }, 300);
    refresh();
  }

  function refresh() {
    const pages = items.reduce((n, i) => n + (i.info?.pages ?? 0), 0);
    toolbar.hidden = items.length === 0;
    zone.classList.toggle("compact", items.length > 0);
    mergeBtn.disabled = items.length < 2 || items.some((i) => !i.info || i.error);
    fill(summary, 
      h("span.chip", {}, plural(items.length, "file")),
      pages > 0 && h("span.chip", {}, `${plural(pages, "page")} total`),
      items.length === 1 && h("span.chip.warn", {}, "Add one more to merge"),
      items.some((i) => i.error) && h("span.chip.bad", {}, "Fix the files marked in red"),
    );
  }

  /** Rows fly into the first row like cards being stacked. */
  async function stackAnimation() {
    if (reducedMotion() || items.length === 0) return;
    const top = items[0].row.getBoundingClientRect().top;
    list.classList.add("stacking");
    items.forEach((i, k) => {
      const dy = top - i.row.getBoundingClientRect().top;
      i.row.animate(
        [
          { transform: "none" },
          { transform: `translateY(${dy}px) scale(${1 - Math.min(k, 6) * 0.02}) rotate(${(k % 2 ? 1 : -1) * k * 1.5}deg)`, offset: 0.75 },
          { transform: `translateY(${dy}px) scale(.94)` },
        ],
        { duration: 700, delay: k * 70, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" },
      );
    });
    await sleep(700 + Math.min(items.length, 10) * 70);
  }

  mergeBtn.addEventListener("click", async () => {
    mergeBtn.disabled = true;
    const name = (nameInput.value.trim() || "merged").replace(/\.pdf$/i, "") + ".pdf";
    try {
      const [bytes] = await mascot.busy(
        Promise.all([pdf.merge(items.map((i) => ({ bytes: i.bytes, password: i.password }))), stackAnimation()]),
      );
      const pages = items.reduce((n, i) => n + (i.info?.pages ?? 0), 0);
      const card = h(
        "div.result-card",
        {},
        h("div.result-icon", {}, icon("file")),
        h("div.file-main", {}, h("div.file-name", {}, name), h("div.file-meta", {}, `${plural(pages, "page")} · ${formatSize(bytes.byteLength)}`)),
        h("button.btn.primary", { type: "button", onclick: () => saveFile(bytes, name) }, icon("download"), "Download"),
      );
      result.replaceChildren(card);
      reveal(card);
      celebrate(`Lekker! ${plural(items.length, "file")} squeezed into one.`, card);
    } catch (err) {
      oops(err instanceof PdfError ? err.message : "Merging failed.");
    } finally {
      list.classList.remove("stacking");
      for (const i of items) i.row.getAnimations().forEach((a) => a.cancel());
      refresh();
    }
  });

  clearBtn.addEventListener("click", () => {
    items = [];
    list.replaceChildren();
    result.replaceChildren();
    refresh();
  });

  return h(
    "section.tool",
    { id: "tool-merge" },
    h("div.tool-head", {}, h("h2", {}, "Merge PDFs"), h("p", {}, "Join files into one. Drag the rows to change the order.")),
    zone,
    toolbar,
    list,
    result,
  );
}
