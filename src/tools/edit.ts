import { pdf, PdfError } from "../core/client";
import type { Annotation, PageEdit, PageSize, Rgb, Rotation } from "../core/pdf";
import { h, icon, reducedMotion, sleep, svg } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile } from "../ui/files";
import { celebrate, mascot, oops, reveal } from "../ui/fun";
import { closeSession, lazyThumb, renderUrl } from "../ui/thumbs";

type Tool = "text" | "draw" | "highlight" | "erase" | "select";
type Point = [number, number];

interface Doc {
  file: File;
  bytes: Uint8Array;
  password?: string;
  session: number;
  sizes: PageSize[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

const COLOURS: { name: string; rgb: Rgb }[] = [
  { name: "Black", rgb: [0.07, 0.07, 0.09] },
  { name: "Blue", rgb: [0, 0.137, 0.584] },
  { name: "Red", rgb: [0.871, 0.22, 0.192] },
  { name: "Green", rgb: [0, 0.478, 0.302] },
];
const HIGHLIGHT: Rgb = [1, 0.84, 0.1];

const TOOLS: { id: Tool; label: string; hint: string; glyph: string }[] = [
  { id: "text", label: "Text", hint: "Click the page to type", glyph: "T" },
  { id: "draw", label: "Draw / sign", hint: "Drag to draw or sign", glyph: "✎" },
  { id: "highlight", label: "Highlight", hint: "Drag over what matters", glyph: "▰" },
  { id: "erase", label: "Erase", hint: "Drag over content to remove it for real", glyph: "⌫" },
  { id: "select", label: "Select", hint: "Click an edit, then Delete", glyph: "➚" },
];

const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

export function editTool(): HTMLElement {
  let doc: Doc | undefined;
  let pages: PageEdit[] = [];
  let history: string[] = [];
  let view: { kind: "grid" } | { kind: "page"; index: number } = { kind: "grid" };
  let tool: Tool = "text";
  let colour: Rgb = COLOURS[0].rgb;
  let textSize = 14;
  let penWidth = 2;
  let selected: number | undefined;
  let draggedCard: number | undefined;

  const workspace = h("div.edit-workspace", { hidden: true });
  const result = h("div.result-slot");
  const undoBtn = h("button.btn.ghost", { type: "button", title: "Undo (Ctrl+Z)" }, "↶ Undo");
  const saveBtn = h("button.btn.primary.big", { type: "button" }, icon("download"), h("span", {}, "Save PDF"));

  const zone = dropzone({ multiple: false, title: "Drop a PDF to edit", onFiles: ([f]) => void load(f) });

  // --- Loading -------------------------------------------------------------

  async function load(file: File, password?: string, bytes?: Uint8Array) {
    bytes ??= await readBytes(file);
    try {
      if (doc) closeSession(doc.session);
      const { session, pages: sizes } = await pdf.open({ bytes, password });
      doc = { file, bytes, password, session, sizes };
      zone.hidden = true;
      pages = sizes.map((_, source) => ({ source, rotate: 0, annotations: [] }));
      history = [];
      view = { kind: "grid" };
      result.replaceChildren();
      render();
      mascot.flash("happy", `Ready to edit ${plural(sizes.length, "page")}.`);
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
    input.focus();
  }

  // --- History -------------------------------------------------------------

  function commit(change: () => void) {
    history.push(JSON.stringify(pages));
    if (history.length > 100) history.shift();
    change();
    result.replaceChildren();
    render();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    pages = JSON.parse(prev);
    selected = undefined;
    if (view.kind === "page") view.index = Math.min(view.index, pages.length - 1);
    render();
  }
  undoBtn.addEventListener("click", undo);

  // --- Geometry ------------------------------------------------------------

  /** Page size as displayed, i.e. after the edit's rotation. */
  function shown(p: PageEdit): PageSize {
    const s = doc!.sizes[p.source];
    return p.rotate % 180 ? { width: s.height, height: s.width } : s;
  }

  /** Turns a page 90° and carries its edits along so they stay put on the content. */
  function rotatePage(p: PageEdit, clockwise: boolean) {
    const { width: W, height: H } = shown(p);
    const map = ([u, v]: Point): Point => (clockwise ? [H - v, u] : [v, W - u]);
    const box = (r: [number, number, number, number]): [number, number, number, number] => {
      const [a, b] = [map([r[0], r[1]]), map([r[2], r[3]])];
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    };
    p.annotations = p.annotations.map((a): Annotation => {
      switch (a.type) {
        case "ink":
          return { ...a, strokes: a.strokes.map((s) => s.map(map)) };
        case "text": {
          // Text stays upright: move its box by the centre, keep its size.
          const [w, hgt] = [a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]];
          const [cx, cy] = map([(a.rect[0] + a.rect[2]) / 2, (a.rect[1] + a.rect[3]) / 2]);
          return { ...a, rect: [cx - w / 2, cy - hgt / 2, cx + w / 2, cy + hgt / 2] };
        }
        default:
          return { ...a, rect: box(a.rect) };
      }
    });
    p.rotate = (((p.rotate + (clockwise ? 90 : 270)) % 360) as Rotation);
  }

  // --- Overlay drawing -----------------------------------------------------

  function drawAnnotations(layer: SVGElement, annotations: Annotation[], highlightIndex?: number) {
    layer.replaceChildren();
    annotations.forEach((a, i) => {
      const g = document.createElementNS(SVG_NS, "g");
      g.dataset.index = String(i);
      g.classList.add("ann", `ann-${a.type}`);
      if (i === highlightIndex) g.classList.add("selected");
      if (a.type === "ink") {
        for (const stroke of a.strokes) {
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", strokePath(stroke));
          path.setAttribute("stroke", css(a.color));
          path.setAttribute("stroke-width", String(a.width));
          g.append(path);
        }
      } else if (a.type === "text") {
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("fill", css(a.color));
        t.setAttribute("font-size", String(a.size));
        a.text.split("\n").forEach((line, k) => {
          const span = document.createElementNS(SVG_NS, "tspan");
          span.setAttribute("x", String(a.rect[0] + 2));
          span.setAttribute("y", String(a.rect[1] + 2 + a.size * (0.9 + k * 1.16)));
          span.textContent = line || " ";
          t.append(span);
        });
        g.append(t);
      } else {
        const r = document.createElementNS(SVG_NS, "rect");
        const [x0, y0, x1, y1] = a.rect;
        r.setAttribute("x", String(x0));
        r.setAttribute("y", String(y0));
        r.setAttribute("width", String(x1 - x0));
        r.setAttribute("height", String(y1 - y0));
        if (a.type === "highlight") r.setAttribute("fill", css(a.color));
        g.append(r);
      }
      const box = bounds(a);
      const hit = document.createElementNS(SVG_NS, "rect");
      hit.classList.add("ann-hit");
      hit.setAttribute("x", String(box[0] - 3));
      hit.setAttribute("y", String(box[1] - 3));
      hit.setAttribute("width", String(box[2] - box[0] + 6));
      hit.setAttribute("height", String(box[3] - box[1] + 6));
      g.append(hit);
      layer.append(g);
    });
  }

  // --- Rendering -----------------------------------------------------------

  function render() {
    if (!doc) return;
    undoBtn.disabled = history.length === 0;
    workspace.hidden = false;
    const header = h(
      "div.doc-card",
      {},
      h("div.result-icon", {}, icon("file")),
      h(
        "div.file-main",
        {},
        h("div.file-name", {}, doc.file.name),
        h("div.file-meta", {}, `${plural(pages.length, "page")} · ${formatSize(doc.file.size)}`),
      ),
      h("button.btn.ghost", { type: "button", onclick: reset }, "Change file"),
    );
    const tabs = h(
      "div.segments.compact",
      { role: "group", "aria-label": "Editor view" },
      h("button.segment", { type: "button", "aria-pressed": String(view.kind === "grid"), onclick: () => ((view = { kind: "grid" }), render()) }, h("strong", {}, "Pages"), h("span", {}, "Rotate, delete, reorder")),
      h(
        "button.segment",
        { type: "button", "aria-pressed": String(view.kind === "page"), onclick: () => ((view = { kind: "page", index: view.kind === "page" ? view.index : 0 }), render()) },
        h("strong", {}, "Edit page"),
        h("span", {}, "Text, draw, highlight, erase"),
      ),
    );
    const bar = h("div.toolbar", {}, h("span.chip", {}, edits() ? `${plural(edits(), "change")} so far` : "No changes yet"), h("div.actions", {}, undoBtn, saveBtn));
    workspace.replaceChildren(header, tabs, bar, view.kind === "grid" ? gridView() : pageView(view.index));
  }

  function edits(): number {
    const moved = pages.some((p, i) => p.source !== i) || pages.length !== doc!.sizes.length;
    return pages.reduce((n, p) => n + p.annotations.length + (p.rotate ? 1 : 0), 0) + (moved ? 1 : 0);
  }

  function gridView(): HTMLElement {
    const grid = h("div.thumb-grid.organiser", { "aria-label": "Pages. Drag to reorder." });
    pages.forEach((p, i) => {
      const { width, height } = shown(p);
      const overlay = svg(`<svg class="thumb-overlay" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"></svg>`);
      drawAnnotations(overlay, p.annotations);
      const card = h(
        "div.thumb.organise",
        { draggable: "true", "data-index": String(i) },
        h(
          "button.thumb-open",
          { type: "button", title: `Edit page ${i + 1}`, "aria-label": `Edit page ${i + 1}`, onclick: () => ((view = { kind: "page", index: i }), render()) },
          h("div.thumb-paper", { style: `aspect-ratio:${width}/${height}` }, lazyThumb(doc!.session, p.source, `Page ${i + 1}`, p.rotate), overlay),
        ),
        h("span.thumb-num", {}, String(i + 1)),
        p.annotations.length > 0 && h("span.thumb-badge", { title: "Edits on this page" }, `✎ ${p.annotations.length}`),
        h(
          "div.thumb-tools",
          {},
          h("button.icon-btn.small", { type: "button", title: "Rotate left", "aria-label": `Rotate page ${i + 1} left`, onclick: () => turn(i, false, card) }, "⟲"),
          h("button.icon-btn.small", { type: "button", title: "Rotate right", "aria-label": `Rotate page ${i + 1} right`, onclick: () => turn(i, true, card) }, "⟳"),
          h("button.icon-btn.small.danger", { type: "button", title: "Delete page", "aria-label": `Delete page ${i + 1}`, onclick: () => del(i, card) }, icon("x")),
        ),
      );
      card.style.setProperty("--i", String(i % 24));
      card.addEventListener("dragstart", (e) => {
        draggedCard = i;
        card.classList.add("dragging");
        e.dataTransfer?.setData("text/plain", String(i));
      });
      card.addEventListener("dragend", () => {
        draggedCard = undefined;
        card.classList.remove("dragging");
      });
      card.addEventListener("dragover", (e) => {
        if (draggedCard === undefined) return;
        e.preventDefault();
        card.classList.add("drop-target");
      });
      card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drop-target");
        const from = draggedCard;
        if (from === undefined || from === i) return;
        commit(() => {
          const [moved] = pages.splice(from, 1);
          pages.splice(i, 0, moved);
        });
      });
      grid.append(card);
    });
    return h("div", {}, h("p.hint", {}, "Drag pages to reorder · use the buttons to rotate or delete · click a page to edit it"), grid);
  }

  async function turn(i: number, clockwise: boolean, card: HTMLElement) {
    const paper = card.querySelector(".thumb-paper");
    if (paper && !reducedMotion()) {
      await paper.animate([{ transform: "none" }, { transform: `rotate(${clockwise ? 90 : -90}deg) scale(.8)` }], { duration: 260, easing: "cubic-bezier(.3,1.4,.5,1)" }).finished;
    }
    commit(() => rotatePage(pages[i], clockwise));
  }

  async function del(i: number, card: HTMLElement) {
    if (pages.length === 1) return oops("A PDF needs at least one page.");
    if (!reducedMotion()) {
      // Crumple it up and toss it.
      await card.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: "scale(.7) rotate(-8deg)", borderRadius: "40%", offset: 0.4 },
          { transform: "translate(40px, 120px) scale(.15) rotate(200deg)", opacity: 0 },
        ],
        { duration: 520, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" },
      ).finished;
    }
    commit(() => pages.splice(i, 1));
    mascot.flash("happy", pick(["Yeet! Page gone.", "Into the bin you go.", "Bye-bye page!"]), 1800);
  }

  function pageView(index: number): HTMLElement {
    const p = pages[index];
    const { width: W, height: H } = shown(p);

    const palette = h("div.palette", { role: "toolbar", "aria-label": "Editing tools" });
    for (const t of TOOLS) {
      palette.append(
        h(
          "button.tool-btn",
          { type: "button", "aria-pressed": String(tool === t.id), title: t.hint, onclick: () => ((tool = t.id), (selected = undefined), render()) },
          h("span.glyph", { "aria-hidden": "true" }, t.glyph),
          h("span", {}, t.label),
        ),
      );
    }
    const swatches = h("div.swatches", { role: "group", "aria-label": "Colour" });
    for (const c of COLOURS) {
      swatches.append(
        h("button.swatch", {
          type: "button",
          title: c.name,
          "aria-label": c.name,
          "aria-pressed": String(colour === c.rgb),
          style: `--swatch:${css(c.rgb)}`,
          onclick: () => ((colour = c.rgb), render()),
        }),
      );
    }
    const sizeInput = h("input", {
      type: "range",
      min: tool === "draw" ? 1 : 8,
      max: tool === "draw" ? 8 : 48,
      value: tool === "draw" ? penWidth : textSize,
      "aria-label": tool === "draw" ? "Pen thickness" : "Text size",
    });
    sizeInput.addEventListener("input", () => {
      if (tool === "draw") penWidth = Number(sizeInput.value);
      else textSize = Number(sizeInput.value);
    });
    const deleteSel = h("button.btn.small.danger", { type: "button", disabled: selected === undefined, onclick: () => deleteSelected() }, "Delete selected");

    const options = h(
      "div.tool-options",
      {},
      (tool === "text" || tool === "draw") && swatches,
      (tool === "text" || tool === "draw") && h("label.slider", {}, h("span", {}, tool === "draw" ? "Thickness" : "Size"), sizeInput),
      tool === "select" && deleteSel,
      h("span.tool-hint", {}, TOOLS.find((t) => t.id === tool)!.hint),
    );

    const img = h("img.page-img", { alt: `Page ${index + 1}`, draggable: "false" });
    const scale = Math.min(2.5, 1800 / Math.max(W, H));
    renderUrl(doc!.session, p.source, scale, p.rotate).then((url) => (img.src = url)).catch(() => oops("Couldn't draw this page."));

    const layer = svg(`<svg class="page-layer" viewBox="0 0 ${W} ${H}" data-tool="${tool}"></svg>`);
    drawAnnotations(layer, p.annotations, selected);
    // Fit the whole page in the window so you can sign the bottom without scrolling.
    const stage = h("div.stage", { style: `aspect-ratio:${W}/${H};width:min(100%, 820px, calc((100vh - 190px) * ${W / H}))` }, img, layer);
    wireStage(stage, layer, p, W, H);

    const nav = h(
      "div.page-nav",
      {},
      h("button.icon-btn", { type: "button", "aria-label": "Previous page", disabled: index === 0, onclick: () => go(index - 1) }, icon("up")),
      h("span", {}, `Page ${index + 1} of ${pages.length}`),
      h("button.icon-btn", { type: "button", "aria-label": "Next page", disabled: index === pages.length - 1, onclick: () => go(index + 1) }, icon("down")),
    );

    return h("div.page-editor", {}, h("div.editor-bar", {}, palette, options), h("div.stage-wrap", {}, stage), nav);
  }

  function go(index: number) {
    selected = undefined;
    view = { kind: "page", index };
    render();
  }

  function deleteSelected() {
    if (view.kind !== "page" || selected === undefined) return;
    const p = pages[view.index];
    const i = selected;
    selected = undefined;
    commit(() => p.annotations.splice(i, 1));
  }

  // --- Stage interactions --------------------------------------------------

  function wireStage(stage: HTMLElement, layer: SVGSVGElement, p: PageEdit, W: number, H: number) {
    const toPoint = (e: PointerEvent | MouseEvent): Point => {
      const r = layer.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const y = ((e.clientY - r.top) / r.height) * H;
      return [clamp(x, 0, W), clamp(y, 0, H)];
    };
    const annotationAt = (e: Event): number | undefined => {
      const g = (e.target as Element).closest?.("g.ann") as SVGGElement | null;
      return g ? Number(g.dataset.index) : undefined;
    };

    layer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = toPoint(e);

      if (tool === "select") {
        selected = annotationAt(e);
        render();
        return;
      }
      if (tool === "text") {
        // A click outside an open text box just finishes that box.
        const open = stage.querySelector<HTMLTextAreaElement>(".text-box");
        if (open) {
          e.preventDefault();
          open.blur();
          return;
        }
        const hit = annotationAt(e);
        const existing = hit !== undefined && p.annotations[hit].type === "text" ? hit : undefined;
        e.preventDefault();
        openTextBox(stage, p, W, H, start, existing);
        return;
      }

      layer.setPointerCapture(e.pointerId);
      const preview = document.createElementNS(SVG_NS, tool === "draw" ? "path" : "rect");
      preview.classList.add("preview", `preview-${tool}`);
      if (tool === "draw") {
        preview.setAttribute("stroke", css(colour));
        preview.setAttribute("stroke-width", String(penWidth));
      }
      layer.append(preview);
      const stroke: Point[] = [start];
      let end = start;

      const move = (ev: PointerEvent) => {
        end = toPoint(ev);
        if (tool === "draw") {
          stroke.push(end);
          preview.setAttribute("d", strokePath(stroke));
        } else {
          const [x0, y0, x1, y1] = box(start, end);
          preview.setAttribute("x", String(x0));
          preview.setAttribute("y", String(y0));
          preview.setAttribute("width", String(x1 - x0));
          preview.setAttribute("height", String(y1 - y0));
        }
      };
      const up = () => {
        layer.removeEventListener("pointermove", move);
        layer.removeEventListener("pointerup", up);
        layer.removeEventListener("pointercancel", up);
        preview.remove();
        if (tool === "draw") {
          if (stroke.length < 2) stroke.push([start[0] + 0.5, start[1] + 0.5]);
          commit(() => p.annotations.push({ type: "ink", strokes: [simplify(stroke)], width: penWidth, color: colour }));
          return;
        }
        const rect = box(start, end);
        if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return;
        if (tool === "highlight") commit(() => p.annotations.push({ type: "highlight", rect, color: HIGHLIGHT }));
        else {
          commit(() => p.annotations.push({ type: "erase", rect }));
          mascot.flash("happy", pick(["Poof! Gone.", "Eish, what text?", "Vanished like load-shedding schedules."]), 1800);
        }
      };
      layer.addEventListener("pointermove", move);
      layer.addEventListener("pointerup", up);
      layer.addEventListener("pointercancel", up);
    });
  }

  function openTextBox(stage: HTMLElement, p: PageEdit, W: number, H: number, at: Point, existing?: number) {
    const prev = existing !== undefined ? (p.annotations[existing] as Extract<Annotation, { type: "text" }>) : undefined;
    const size = prev?.size ?? textSize;
    const color = prev?.color ?? colour;
    const origin: Point = prev ? [prev.rect[0], prev.rect[1]] : [at[0], at[1] - size * 0.7];

    const box = h("textarea.text-box", { rows: 1, "aria-label": "Text to add", spellcheck: true }) as HTMLTextAreaElement;
    box.value = prev?.text ?? "";
    const pxPerPt = () => stage.getBoundingClientRect().width / W;
    const place = () => {
      const k = pxPerPt();
      box.style.left = `${(origin[0] / W) * 100}%`;
      box.style.top = `${(origin[1] / H) * 100}%`;
      box.style.fontSize = `${size * k}px`;
      box.style.color = css(color);
      const lines = box.value.split("\n");
      box.style.width = `${Math.max(4, ...lines.map((l) => l.length + 1)) * size * 0.6 * k}px`;
      box.style.height = `${lines.length * size * 1.16 * k + 8}px`;
    };
    box.addEventListener("input", place);
    place();
    stage.append(box);
    box.focus();

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      box.remove();
      const text = box.value.replace(/\s+$/, "");
      if (!save || text === (prev?.text ?? "")) return;
      const lines = text.split("\n");
      const width = Math.max(...lines.map((l) => measure(l, size))) + 8;
      const rect: [number, number, number, number] = [origin[0], origin[1], Math.min(W, origin[0] + width), Math.min(H, origin[1] + lines.length * size * 1.16 + 6)];
      commit(() => {
        if (existing !== undefined) p.annotations.splice(existing, 1);
        if (text) p.annotations.push({ type: "text", rect, text, size, color });
      });
    };
    box.addEventListener("blur", () => finish(true));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(true);
    });
  }

  // --- Saving --------------------------------------------------------------

  saveBtn.addEventListener("click", async () => {
    if (!doc) return;
    saveBtn.disabled = true;
    try {
      const [bytes] = await mascot.busy(Promise.all([pdf.edit({ bytes: doc.bytes, password: doc.password }, pages), sleep(700)]));
      const name = `${baseName(doc.file.name)}-edited.pdf`;
      const stamp = h("div.stamp", { "aria-hidden": "true" }, "LEKKER!");
      workspace.append(stamp);
      setTimeout(() => stamp.remove(), 1600);
      result.replaceChildren(
        h(
          "div.result-card",
          {},
          h("div.result-icon", {}, icon("file")),
          h("div.file-main", {}, h("div.file-name", {}, name), h("div.file-meta", {}, `${plural(pages.length, "page")} · ${formatSize(bytes.byteLength)}`)),
          h("button.btn.primary", { type: "button", onclick: () => saveFile(bytes, name) }, icon("download"), "Download"),
        ),
      );
      saveFile(bytes, name);
      reveal(result);
      celebrate("Saved! Lekker edits, boss.", result);
    } catch (err) {
      oops(err instanceof PdfError ? err.message : "Saving failed.");
    } finally {
      saveBtn.disabled = false;
    }
  });

  function reset() {
    if (doc) closeSession(doc.session);
    doc = undefined;
    pages = [];
    zone.hidden = false;
    workspace.hidden = true;
    workspace.replaceChildren();
    result.replaceChildren();
  }

  const section = h(
    "section.tool",
    { id: "tool-edit" },
    h("div.tool-head", {}, h("h2", {}, "Edit a PDF"), h("p", {}, "Add text, sign, highlight, erase, and rotate, delete or reorder pages.")),
    zone,
    workspace,
    result,
  );

  section.addEventListener("keydown", (e) => {
    if ((e.target as Element).matches("input, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== undefined) {
      e.preventDefault();
      deleteSelected();
    }
  });
  section.tabIndex = -1;
  section.addEventListener("pointerdown", () => {
    if (!(document.activeElement instanceof HTMLTextAreaElement)) section.focus({ preventScroll: true });
  });
  return section;
}

// --- Helpers ---------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

function box(a: Point, b: Point): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function bounds(a: Annotation): [number, number, number, number] {
  if (a.type !== "ink") return a.rect;
  const pts = a.strokes.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = a.width / 2;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

function strokePath(points: Point[]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
}

/** Drops points closer than half a point to keep strokes light. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [points[0]];
  for (const p of points.slice(1)) {
    const last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.5) out.push(p);
  }
  if (out.length === 1) out.push(points[points.length - 1]);
  return out;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Width of `text` in points when set in Helvetica at `size`. */
function measure(text: string, size: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}
