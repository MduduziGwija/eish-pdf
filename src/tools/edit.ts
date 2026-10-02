import { pdf, PdfError } from "../core/client";
import { baselineOf, LINE_HEIGHT } from "../core/layout";
import type { Annotation, PageEdit, PageSize, Rgb, Rotation } from "../core/pdf";
import type { TextLine } from "../core/text";
import { h, icon, reducedMotion, sleep, svg } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile } from "../ui/files";
import { celebrate, mascot, oops, pick, reveal } from "../ui/fun";
import { closeSession, lazyThumb, renderUrl } from "../ui/thumbs";
import { browserImageToPng, ENGINE_IMAGES } from "../convert/images";
import { DEFAULT_FMT, familyCss, formatBar, rgbCss, styleElement, SWATCHES, type Fmt } from "./format";
import { openSignatureDialog, type Picture } from "./signature";
import { openCertificateDialog, type CertSettings } from "../sign/dialog";

type Tool = "retext" | "text" | "draw" | "image" | "sign" | "highlight" | "erase" | "select";
type Point = [number, number];
type Box = [number, number, number, number];
type TextAnn = Extract<Annotation, { type: "text" }>;
type ReplaceAnn = Extract<Annotation, { type: "replace" }>;

interface Doc {
  file: File;
  bytes: Uint8Array;
  password?: string;
  session: number;
  sizes: PageSize[];
}

/** The text box currently open for typing. */
interface Active {
  fmt: Fmt;
  finish: (save: boolean) => void;
  place: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const HIGHLIGHT: Rgb = [1, 0.84, 0.1];
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const TOOLS: { id: Tool; label: string; hint: string; glyph: string }[] = [
  { id: "retext", label: "Edit text", hint: "Click a line of the PDF's own text to change it. Same font, size and colour.", glyph: "Aa" },
  { id: "text", label: "Add text", hint: "Click the page to type. Use the bar above to format.", glyph: "T" },
  { id: "draw", label: "Draw", hint: "Drag to draw freehand", glyph: "✎" },
  { id: "image", label: "Add image", hint: "Pick a picture or logo. Drag it to move; pull a corner to resize.", glyph: "🖼" },
  { id: "sign", label: "Sign", hint: "Draw, type or upload your signature, then place and resize it", glyph: "✍" },
  { id: "highlight", label: "Highlight", hint: "Drag over what matters", glyph: "▰" },
  { id: "erase", label: "Erase", hint: "Drag over content to remove it for real", glyph: "⌫" },
  { id: "select", label: "Select", hint: "Click an edit to select it. Drag pictures to move them, pull a corner to resize. Delete removes.", glyph: "➚" },
];

export function editTool(): HTMLElement {
  let doc: Doc | undefined;
  let pages: PageEdit[] = [];
  let history: string[] = [];
  let view: { kind: "grid" } | { kind: "page"; index: number } = { kind: "grid" };
  let tool: Tool = "retext";
  let fmt: Fmt = { ...DEFAULT_FMT };
  let penColour: Rgb = SWATCHES[1].rgb;
  let penWidth = 2;
  let selected: number | undefined;
  let draggedCard: number | undefined;
  let zoom = 1;
  let enlarged = false;
  let active: Active | undefined;
  const lineCache = new Map<number, Promise<TextLine[]>>();
  // Pictures placed in this edit, by id (annotations refer to them by id).
  const pictures = new Map<string, { png: Uint8Array; url: string }>();
  let pictureCount = 0;

  const workspace = h("div.edit-workspace", { hidden: true });
  const result = h("div.result-slot");
  const undoBtn = h("button.btn.ghost", { type: "button", title: "Undo (Ctrl+Z)" }, "↶ Undo");
  const saveBtn = h("button.btn.primary.big", { type: "button" }, icon("download"), h("span", {}, "Save PDF"));
  // Optional certificate signature applied when saving.
  let certSign: CertSettings | undefined;
  const certBtn = h("button.btn.cert-btn", { type: "button", title: "Optional: seal the PDF with a certificate (digital signature)" });
  const paintCertBtn = () => {
    certBtn.classList.toggle("on", !!certSign);
    certBtn.replaceChildren(h("span", { "aria-hidden": "true" }, "🔏"), h("span", {}, certSign ? `Signing as ${certSign.identity.name}` : "Digital signature"));
  };
  paintCertBtn();
  certBtn.addEventListener("click", async () => {
    closeActive();
    const hasPicture = pages.some((p) => p.annotations.some((a) => a.type === "image" && a.signature));
    const choice = await openCertificateDialog(certSign, hasPicture);
    if (choice === "off") certSign = undefined;
    else if (choice) {
      certSign = choice;
      mascot.flash("happy", `Sho! Saving will seal it as ${choice.identity.name}.`, 2400);
    }
    paintCertBtn();
  });

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
      for (const pic of pictures.values()) URL.revokeObjectURL(pic.url);
      pictures.clear();
      history = [];
      lineCache.clear();
      view = { kind: "grid" };
      result.replaceChildren();
      render();
      mascot.flash("happy", `Sho mfowethu! ${plural(sizes.length, "page")} ready to edit.`);
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

  const linesOf = (source: number) => {
    let lines = lineCache.get(source);
    if (!lines) {
      lines = pdf.lines(doc!.session, source);
      lineCache.set(source, lines);
    }
    return lines;
  };

  // --- History -------------------------------------------------------------

  function commit(change: () => void) {
    history.push(JSON.stringify(pages));
    if (history.length > 100) history.shift();
    change();
    result.replaceChildren();
    render();
  }

  function undo() {
    closeActive(false);
    const prev = history.pop();
    if (!prev) return;
    pages = JSON.parse(prev);
    selected = undefined;
    if (view.kind === "page") view.index = Math.min(view.index, pages.length - 1);
    render();
  }
  undoBtn.addEventListener("click", undo);

  /** Finishes any open text box (which re-renders if it saved). */
  function closeActive(save = true) {
    const a = active;
    active = undefined;
    a?.finish(save);
  }

  // --- Geometry ------------------------------------------------------------

  /** Page size as displayed, i.e. after the edit's rotation. */
  function shown(p: PageEdit): PageSize {
    const s = doc!.sizes[p.source];
    return p.rotate % 180 ? { width: s.height, height: s.width } : s;
  }

  /** SVG transform from the page's original coordinates to the rotated view. */
  function originalToShown(p: PageEdit): string {
    const { width: W, height: H } = doc!.sizes[p.source];
    switch (p.rotate) {
      case 90:
        return `matrix(0 1 -1 0 ${H} 0)`;
      case 180:
        return `matrix(-1 0 0 -1 ${W} ${H})`;
      case 270:
        return `matrix(0 -1 1 0 0 ${W})`;
      default:
        return "";
    }
  }

  /** Turns a page 90° and carries its edits along so they stay put on the content. */
  function rotatePage(p: PageEdit, clockwise: boolean) {
    const { width: W, height: H } = shown(p);
    const map = ([u, v]: Point): Point => (clockwise ? [H - v, u] : [v, W - u]);
    const box = (r: Box): Box => {
      const [a, b] = [map([r[0], r[1]]), map([r[2], r[3]])];
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    };
    p.annotations = p.annotations.map((a): Annotation => {
      switch (a.type) {
        case "replace":
          return a; // Stored in the page's original coordinates.
        case "ink":
          return { ...a, strokes: a.strokes.map((s) => s.map(map)) };
        case "image":
        case "text": {
          // Text and pictures stay upright: move the box by its centre, keep its size.
          const [w, hgt] = [a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]];
          const [cx, cy] = map([(a.rect[0] + a.rect[2]) / 2, (a.rect[1] + a.rect[3]) / 2]);
          return { ...a, rect: [cx - w / 2, cy - hgt / 2, cx + w / 2, cy + hgt / 2] };
        }
        default:
          return { ...a, rect: box(a.rect) };
      }
    });
    p.rotate = ((p.rotate + (clockwise ? 90 : 270)) % 360) as Rotation;
  }

  // --- Overlay drawing -----------------------------------------------------

  function svgText(lines: string[], f: Fmt, box: Box, baselines: number[], anchorX?: number): SVGTextElement {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("fill", rgbCss(f.color));
    t.setAttribute("font-size", String(f.size));
    t.style.fontFamily = familyCss(f.family);
    t.style.fontWeight = f.bold ? "700" : "400";
    t.style.fontStyle = f.italic ? "italic" : "normal";
    const deco = [f.underline && "underline", f.strike && "line-through"].filter(Boolean).join(" ");
    if (deco) t.setAttribute("text-decoration", deco);
    const x = anchorX ?? (f.align === "center" ? (box[0] + box[2]) / 2 : f.align === "right" ? box[2] - 2 : box[0] + 2);
    t.setAttribute("text-anchor", anchorX !== undefined || f.align === "left" ? "start" : f.align === "center" ? "middle" : "end");
    lines.forEach((line, k) => {
      const span = document.createElementNS(SVG_NS, "tspan");
      span.setAttribute("x", String(x));
      span.setAttribute("y", String(baselines[k]));
      span.textContent = line || " ";
      t.append(span);
    });
    return t;
  }

  function drawAnnotations(layer: SVGElement, p: PageEdit, highlightIndex?: number) {
    layer.replaceChildren();
    // Replacements live in original coordinates, so they get the rotation transform.
    const original = document.createElementNS(SVG_NS, "g");
    const transform = originalToShown(p);
    if (transform) original.setAttribute("transform", transform);
    layer.append(original);

    p.annotations.forEach((a, i) => {
      const g = document.createElementNS(SVG_NS, "g");
      g.dataset.index = String(i);
      g.classList.add("ann", `ann-${a.type}`);
      if (i === highlightIndex) g.classList.add("selected");
      if (a.type === "ink") {
        for (const stroke of a.strokes) {
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", strokePath(stroke));
          path.setAttribute("stroke", rgbCss(a.color));
          path.setAttribute("stroke-width", String(a.width));
          g.append(path);
        }
      } else if (a.type === "text") {
        const f = fmtOf(a);
        const lines = a.text.split("\n");
        g.append(svgText(lines, f, a.rect, lines.map((_, k) => baselineOf(a.rect[1], a.size, k))));
      } else if (a.type === "image") {
        const im = document.createElementNS(SVG_NS, "image");
        const [x0, y0, x1, y1] = a.rect;
        im.setAttribute("href", pictures.get(a.image)?.url ?? "");
        im.setAttribute("x", String(x0));
        im.setAttribute("y", String(y0));
        im.setAttribute("width", String(x1 - x0));
        im.setAttribute("height", String(y1 - y0));
        im.setAttribute("preserveAspectRatio", "none");
        g.append(im);
      } else if (a.type === "replace") {
        g.append(rect(a.rect, "cover"));
        const f: Fmt = { ...DEFAULT_FMT, family: a.font.family, bold: a.font.bold, italic: a.font.italic, size: a.size, color: a.color, underline: !!a.underline, strike: !!a.strike };
        g.append(svgText([a.text], f, a.rect, [a.origin[1]], a.origin[0]));
      } else {
        g.append(rect(a.rect));
      }
      const b = bounds(a);
      const hit = rect([b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 3], "ann-hit");
      g.append(hit);
      if (a.type === "image" && i === highlightIndex) {
        // Corner handles for resizing.
        const size = Math.max(6, Math.min(12, (a.rect[2] - a.rect[0]) / 5));
        for (const [cx, cy, corner] of [
          [a.rect[0], a.rect[1], "nw"],
          [a.rect[2], a.rect[1], "ne"],
          [a.rect[0], a.rect[3], "sw"],
          [a.rect[2], a.rect[3], "se"],
        ] as const) {
          const hnd = rect([cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2], "handle");
          hnd.dataset.corner = corner;
          g.append(hnd);
        }
      }
      (a.type === "replace" ? original : layer).append(g);
    });
  }

  // --- Rendering -----------------------------------------------------------

  function render() {
    if (!doc) return;
    active = undefined;
    undoBtn.disabled = history.length === 0;
    workspace.hidden = false;
    const header = h(
      "div.doc-card",
      {},
      h("div.result-icon", {}, icon("file")),
      h("div.file-main", {}, h("div.file-name", {}, doc.file.name), h("div.file-meta", {}, `${plural(pages.length, "page")} · ${formatSize(doc.file.size)}`)),
      h("button.btn.ghost", { type: "button", onclick: reset }, "Change file"),
    );
    const tabs = h(
      "div.segments.compact",
      { role: "group", "aria-label": "Editor view" },
      h("button.segment", { type: "button", "aria-pressed": String(view.kind === "grid"), onclick: () => switchView({ kind: "grid" }) }, h("strong", {}, "Pages"), h("span", {}, "Rotate, delete, reorder")),
      h(
        "button.segment",
        { type: "button", "aria-pressed": String(view.kind === "page"), onclick: () => switchView({ kind: "page", index: view.kind === "page" ? view.index : 0 }) },
        h("strong", {}, "Edit page"),
        h("span", {}, "Edit text, add text, sign, highlight, erase"),
      ),
    );
    const fullscreen = enlarged && view.kind === "page";
    // In full screen, Undo and Save move into the editor's own bar.
    const bar = h("div.toolbar", {}, h("span.chip", {}, edits() ? `${plural(edits(), "change")} so far` : "No changes yet"), !fullscreen && h("div.actions", {}, undoBtn, certBtn, saveBtn));
    workspace.replaceChildren(header, tabs, bar, view.kind === "grid" ? gridView() : pageView(view.index));
    document.body.classList.toggle("editor-enlarged", enlarged && view.kind === "page");
  }

  function switchView(next: typeof view) {
    closeActive();
    const opening = next.kind === "page" && view.kind !== "page";
    view = next;
    render();
    // Bring the tools and the page into view when opening the editor.
    if (opening) workspace.querySelector(".page-editor")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
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
      drawAnnotations(overlay, p);
      const card = h(
        "div.thumb.organise",
        { draggable: "true", "data-index": String(i) },
        h(
          "button.thumb-open",
          { type: "button", title: `Edit page ${i + 1}`, "aria-label": `Edit page ${i + 1}`, onclick: () => switchView({ kind: "page", index: i }) },
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
    mascot.flash("happy", pick(["Yeet! Page gone.", "Into the bin you go.", "Bye-bye page!", "Sho, that page is history."]), 1800);
  }

  // --- Page editor ---------------------------------------------------------

  function pageView(index: number): HTMLElement {
    const p = pages[index];
    const { width: W, height: H } = shown(p);

    const palette = h("div.palette", { role: "toolbar", "aria-label": "Editing tools" });
    for (const t of TOOLS) {
      palette.append(
        h(
          "button.tool-btn",
          {
            type: "button",
            "aria-pressed": String(tool === t.id),
            title: t.hint,
            onclick: () => {
              closeActive();
              if (t.id === "image") return void pickPicture();
              if (t.id === "sign") return void signNow();
              tool = t.id;
              selected = undefined;
              render();
            },
          },
          h("span.glyph", { "aria-hidden": "true" }, t.glyph),
          h("span", {}, t.label),
        ),
      );
    }

    // Zoom and enlarge.
    const zoomLabel = h("button.btn.small.ghost.zoom-label", { type: "button", title: "Fit to window" }, `${Math.round(zoom * 100)}%`);
    const zoomBox = h(
      "div.zoom",
      { role: "group", "aria-label": "Zoom" },
      h("button.icon-btn.small", { type: "button", title: "Zoom out (Ctrl −)", "aria-label": "Zoom out", onclick: () => setZoom(step(-1)) }, "−"),
      zoomLabel,
      h("button.icon-btn.small", { type: "button", title: "Zoom in (Ctrl +)", "aria-label": "Zoom in", onclick: () => setZoom(step(1)) }, "+"),
      h(
        "button.btn.small",
        { type: "button", title: enlarged ? "Back to normal (Esc)" : "Enlarge the editor to fill the screen", onclick: () => toggleEnlarge() },
        enlarged ? "⤡ Exit full screen" : "⤢ Enlarge",
      ),
    );
    zoomLabel.addEventListener("click", () => setZoom(1));

    // Tool options.
    const fbar =
      tool === "text" || tool === "retext"
        ? formatBar(
            () => active?.fmt ?? fmt,
            () => {
              if (active) {
                active.place();
              }
            },
            { align: tool === "text" },
          )
        : undefined;
    const penSwatches = h("div.swatches", { role: "group", "aria-label": "Pen colour" });
    for (const c of SWATCHES) {
      penSwatches.append(
        h("button.swatch", { type: "button", title: c.name, "aria-label": c.name, "aria-pressed": String(penColour === c.rgb), style: `--swatch:${rgbCss(c.rgb)}`, onclick: () => ((penColour = c.rgb), render()) }),
      );
    }
    const penInput = h("input", { type: "range", min: 1, max: 8, value: penWidth, "aria-label": "Pen thickness" });
    penInput.addEventListener("input", () => (penWidth = Number(penInput.value)));
    const rotatedRetext = tool === "retext" && p.rotate !== 0;
    const options = h(
      "div.tool-options",
      {},
      fbar?.el,
      tool === "draw" && penSwatches,
      tool === "draw" && h("label.slider", {}, h("span", {}, "Thickness"), penInput),
      tool === "select" && h("button.btn.small.danger", { type: "button", disabled: selected === undefined, onclick: () => deleteSelected() }, "Delete selected"),
      h("span.tool-hint", {}, rotatedRetext ? "Edit text works on upright pages. Rotate this page back to change its text." : TOOLS.find((t) => t.id === tool)!.hint),
    );

    // Stage.
    const img = h("img.page-img", { alt: `Page ${index + 1}`, draggable: "false" });
    const layer = svg(`<svg class="page-layer" viewBox="0 0 ${W} ${H}" data-tool="${tool}"></svg>`);
    const linesLayer = document.createElementNS(SVG_NS, "g");
    linesLayer.classList.add("lines-layer");
    const annLayer = document.createElementNS(SVG_NS, "g");
    annLayer.classList.add("ann-layer");
    layer.append(linesLayer, annLayer);
    drawAnnotations(annLayer, p, selected);
    const stage = h("div.stage", { style: `aspect-ratio:${W}/${H}` }, img, layer);
    const wrap = h("div.stage-wrap", {}, stage);

    let renderedScale = 0;
    const layout = () => {
      if (!stage.isConnected) return;
      const pad = 24;
      const availW = wrap.clientWidth - pad;
      const availH = enlarged ? wrap.clientHeight - pad : window.innerHeight - 190;
      const fit = Math.max(200, Math.min(availW, enlarged ? Infinity : 820, availH * (W / H)));
      const width = fit * zoom;
      stage.style.width = `${width}px`;
      // Sharp at any zoom: render at screen resolution, in coarse steps for caching.
      const want = Math.min(6, Math.ceil(((width * devicePixelRatio) / W) * 2) / 2);
      if (want !== renderedScale) {
        renderedScale = want;
        renderUrl(doc!.session, p.source, want, p.rotate)
          .then((url) => (img.src = url))
          .catch(() => oops("Couldn't draw this page."));
      }
      active?.place();
    };
    requestAnimationFrame(layout);
    const onResize = () => (stage.isConnected ? layout() : removeEventListener("resize", onResize));
    addEventListener("resize", onResize);
    wrap.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        setZoom(step(e.deltaY < 0 ? 1 : -1));
      },
      { passive: false },
    );

    function setZoom(z: number) {
      zoom = z;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      layout();
    }

    if (tool === "retext" && !rotatedRetext) {
      linesOf(p.source)
        .then((lines) => {
          if (!stage.isConnected) return;
          if (lines.length === 0) {
            options.querySelector(".tool-hint")!.textContent = "No selectable text on this page. If it's a scan, run it through OCR first.";
          }
          lines.forEach((line, k) => {
            const r = rect(line.bbox, "line-box");
            r.dataset.line = String(k);
            if (p.annotations.some((a) => a.type === "replace" && sameBox(a.rect, line.bbox))) r.classList.add("replaced");
            linesLayer.append(r);
          });
        })
        .catch(() => oops("Couldn't read the text on this page."));
    }

    wireStage(stage, layer, p, W, H);

    const nav = h(
      "div.page-nav",
      {},
      h("button.icon-btn", { type: "button", "aria-label": "Previous page", disabled: index === 0, onclick: () => go(index - 1) }, icon("up")),
      h("span", {}, `Page ${index + 1} of ${pages.length}`),
      h("button.icon-btn", { type: "button", "aria-label": "Next page", disabled: index === pages.length - 1, onclick: () => go(index + 1) }, icon("down")),
    );

    const editor = h(
      `div.page-editor${enlarged ? ".enlarged" : ""}`,
      {},
      h("div.editor-bar", {}, h("div.editor-row", {}, palette, zoomBox, enlarged && h("div.actions", {}, undoBtn, certBtn, saveBtn)), options),
      wrap,
      nav,
    );
    return editor;
  }

  const step = (dir: number) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const at = i === -1 ? ZOOMS.length - 1 : i;
    return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + dir))];
  };

  function toggleEnlarge() {
    closeActive();
    enlarged = !enlarged;
    render();
    if (enlarged) mascot.flash("happy", "Big screen energy, mfowethu!", 1800);
  }

  function go(index: number) {
    closeActive();
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
      // A click outside an open text box just finishes that box.
      if (active) {
        e.preventDefault();
        closeActive();
        return;
      }
      const start = toPoint(e);

      if (tool === "select") {
        const hitIndex = annotationAt(e);
        const ann = hitIndex !== undefined ? p.annotations[hitIndex] : undefined;
        if (ann?.type !== "image") {
          selected = hitIndex;
          render();
          return;
        }
        // Move or resize a picture.
        e.preventDefault();
        selected = hitIndex;
        const corner = (e.target as SVGElement).dataset?.corner;
        const original: Box = [...ann.rect];
        const aspect = (original[2] - original[0]) / Math.max(1, original[3] - original[1]);
        const annLayer = layer.querySelector<SVGGElement>(".ann-layer")!;
        layer.setPointerCapture(e.pointerId);
        let moved = false;
        const move = (ev: PointerEvent) => {
          const [px, py] = toPoint(ev);
          const dx = px - start[0];
          const dy = py - start[1];
          if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
          if (!corner) {
            // Keep the picture on the page.
            const w = original[2] - original[0];
            const hgt = original[3] - original[1];
            const x0 = clamp(original[0] + dx, -w * 0.8, W - w * 0.2);
            const y0 = clamp(original[1] + dy, -hgt * 0.8, H - hgt * 0.2);
            ann.rect = [x0, y0, x0 + w, y0 + hgt];
          } else {
            // The opposite corner stays put; the shape keeps its proportions.
            const fx = corner.includes("w") ? original[2] : original[0];
            const fy = corner.includes("n") ? original[3] : original[1];
            const w = Math.max(12, Math.abs(px - fx));
            const hgt = w / aspect;
            const x0 = corner.includes("w") ? fx - w : fx;
            const y0 = corner.includes("n") ? fy - hgt : fy;
            ann.rect = [x0, y0, x0 + w, y0 + hgt];
          }
          drawAnnotations(annLayer, p, selected);
        };
        const up = () => {
          layer.removeEventListener("pointermove", move);
          layer.removeEventListener("pointerup", up);
          layer.removeEventListener("pointercancel", up);
          const final: Box = [...ann.rect];
          ann.rect = original;
          if (moved) commit(() => (ann.rect = final));
          else render();
        };
        layer.addEventListener("pointermove", move);
        layer.addEventListener("pointerup", up);
        layer.addEventListener("pointercancel", up);
        return;
      }
      if (tool === "retext") {
        if (p.rotate !== 0) return;
        e.preventDefault();
        const hit = annotationAt(e);
        const existing = hit !== undefined && p.annotations[hit].type === "replace" ? hit : undefined;
        const lineEl = (e.target as Element).closest?.(".line-box") as SVGElement | null;
        void linesOf(p.source).then((lines) => {
          const line = existing !== undefined ? lines.find((l) => sameBox(l.bbox, (p.annotations[existing] as ReplaceAnn).rect)) : lineEl ? lines[Number(lineEl.dataset.line)] : undefined;
          if (line) openReplaceBox(stage, p, W, line, existing);
        });
        return;
      }
      if (tool === "text") {
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
        preview.setAttribute("stroke", rgbCss(penColour));
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
          const [x0, y0, x1, y1] = boxOf(start, end);
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
          commit(() => p.annotations.push({ type: "ink", strokes: [simplify(stroke)], width: penWidth, color: penColour }));
          return;
        }
        const r = boxOf(start, end);
        if (r[2] - r[0] < 3 || r[3] - r[1] < 3) return;
        if (tool === "highlight") commit(() => p.annotations.push({ type: "highlight", rect: r, color: HIGHLIGHT }));
        else {
          commit(() => p.annotations.push({ type: "erase", rect: r }));
          mascot.flash("happy", pick(["Poof! Gone.", "Eish, what text?", "Sho, it vanished!"]), 1800);
        }
      };
      layer.addEventListener("pointermove", move);
      layer.addEventListener("pointerup", up);
      layer.addEventListener("pointercancel", up);
    });
  }

  /**
   * Shared text-box behaviour: positions a textarea over the page, keeps it
   * styled while the format bar changes, and saves on blur, Ctrl+Enter or a
   * click elsewhere (Esc cancels).
   */
  function openBox(stage: HTMLElement, W: number, f: Fmt, initial: string, origin: () => Point, save: (text: string, f: Fmt) => void, singleLine: boolean) {
    const box = h("textarea.text-box", { rows: 1, "aria-label": "Text", spellcheck: true }) as HTMLTextAreaElement;
    box.value = initial;
    const pxPerPt = () => stage.getBoundingClientRect().width / W;
    const place = () => {
      const k = pxPerPt();
      const [x, y] = origin();
      styleElement(box, f, k);
      box.style.left = `${x * k}px`;
      box.style.top = `${y * k}px`;
      const lines = box.value.split("\n");
      const widest = Math.max(...lines.map((l) => measure(l || " ", f)));
      box.style.width = `${Math.max(40, (widest + 12) * k)}px`;
      box.style.height = `${(lines.length * f.size * LINE_HEIGHT + 6) * k}px`;
      box.style.textAlign = f.align;
    };
    box.addEventListener("input", place);
    place();
    stage.append(box);
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);

    // Show this box's own format in the bar (and the defaults again after).
    const syncBar = () => stage.closest(".page-editor")?.querySelector(".format-bar")?.dispatchEvent(new Event("sync"));
    let done = false;
    const finish = (doSave: boolean) => {
      if (done) return;
      done = true;
      if (active?.finish === finish) active = undefined;
      box.remove();
      syncBar();
      if (doSave) save(box.value.replace(/\s+$/, ""), f);
    };
    active = { fmt: f, finish, place };
    syncBar();
    box.addEventListener("blur", (e) => {
      // Focus moving into the format bar (font list, size, colour) keeps the box open.
      const to = e.relatedTarget as Element | null;
      if (to?.closest(".format-bar")) {
        to.addEventListener("blur", () => setTimeout(() => !box.contains(document.activeElement) && document.activeElement !== box && !document.activeElement?.closest(".format-bar") && finish(true)), { once: true });
        to.addEventListener("change", () => box.focus(), { once: true });
        return;
      }
      finish(true);
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // Only cancel the box, don't also leave full screen.
        finish(false);
      }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || singleLine)) {
        e.preventDefault();
        finish(true);
      } else if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const key = ({ b: "bold", i: "italic", u: "underline" } as const)[e.key.toLowerCase() as "b" | "i" | "u"];
        f[key] = !f[key];
        place();
        syncBar();
      }
    });
  }

  function openTextBox(stage: HTMLElement, p: PageEdit, W: number, H: number, at: Point, existing?: number) {
    const prev = existing !== undefined ? (p.annotations[existing] as TextAnn) : undefined;
    const f: Fmt = prev ? fmtOf(prev) : { ...fmt };
    const topLeft: Point = prev ? [prev.rect[0], prev.rect[1]] : [at[0], at[1] - f.size * 0.7];
    openBox(
      stage,
      W,
      f,
      prev?.text ?? "",
      () => topLeft,
      (text, f) => {
        if (!prev) fmt = { ...f }; // Next new text starts with the same look, like Word.
        const lines = text.split("\n");
        const width = Math.max(...lines.map((l) => measure(l, f))) + 8;
        const rectBox: Box = [topLeft[0], topLeft[1], Math.min(W, topLeft[0] + width), Math.min(H, topLeft[1] + lines.length * f.size * LINE_HEIGHT + 6)];
        if (prev && text === prev.text && JSON.stringify(fmtOf(prev)) === JSON.stringify(f)) return;
        if (!prev && !text) return;
        commit(() => {
          if (existing !== undefined) p.annotations.splice(existing, 1);
          if (text) p.annotations.push({ type: "text", rect: rectBox, text, ...f });
        });
      },
      false,
    );
  }

  function openReplaceBox(stage: HTMLElement, p: PageEdit, W: number, line: TextLine, existing?: number) {
    const prev = existing !== undefined ? (p.annotations[existing] as ReplaceAnn) : undefined;
    const detected: Fmt = { ...DEFAULT_FMT, family: line.font.family, bold: line.font.bold, italic: line.font.italic, size: line.size, color: line.color };
    const f: Fmt = prev ? { ...detected, family: prev.font.family, bold: prev.font.bold, italic: prev.font.italic, size: prev.size, color: prev.color, underline: !!prev.underline, strike: !!prev.strike } : detected;
    // The box sits where the line's text starts, at the line's top.
    openBox(
      stage,
      W,
      f,
      prev?.text ?? line.text,
      () => [line.origin[0] - 2, line.origin[1] - f.size * 0.9 - 2] as Point,
      (text, f) => {
        const unchanged = text === line.text && JSON.stringify(f) === JSON.stringify(detected);
        if (unchanged && existing === undefined) return;
        // Keep the document's own font unless the family or weight was changed.
        const sameFace = f.family === line.font.family && f.bold === line.font.bold && f.italic === line.font.italic;
        commit(() => {
          if (existing !== undefined) p.annotations.splice(existing, 1);
          if (!unchanged) {
            p.annotations.push({
              type: "replace",
              rect: line.bbox,
              text,
              origin: line.origin,
              size: f.size,
              color: f.color,
              font: { name: sameFace ? line.font.name : "", family: f.family, bold: f.bold, italic: f.italic },
              underline: f.underline,
              strike: f.strike,
            });
          }
        });
        if (!unchanged) mascot.flash("happy", pick(["Sho! Nobody will know.", "Smooth, mfowethu.", "Same font, new words. Kwaai!"]), 1800);
      },
      true,
    );
  }

  // --- Pictures and signatures -----------------------------------------------

  function usedPictures(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const p of pages) for (const a of p.annotations) if (a.type === "image") out[a.image] = pictures.get(a.image)!.png;
    return out;
  }

  /** Puts a picture in the middle of the page being edited, selected and ready to move. */
  function placePicture(pic: Picture, maxWidthShare: number, label: string, signature = false) {
    if (view.kind !== "page") return;
    const p = pages[view.index];
    const { width: W, height: H } = shown(p);
    const id = `pic-${++pictureCount}`;
    pictures.set(id, { png: pic.png, url: URL.createObjectURL(new Blob([pic.png as BlobPart], { type: "image/png" })) });
    // Natural size at 96 dpi, but no wider than a share of the page.
    let w = Math.min(pic.width * 0.75, W * maxWidthShare);
    let hgt = (w * pic.height) / pic.width;
    if (hgt > H * 0.6) {
      hgt = H * 0.6;
      w = (hgt * pic.width) / pic.height;
    }
    const x0 = (W - w) / 2;
    const y0 = (H - hgt) / 2;
    tool = "select";
    commit(() => {
      p.annotations.push({ type: "image", rect: [x0, y0, x0 + w, y0 + hgt], image: id, ...(signature ? { signature: true } : {}) });
      selected = p.annotations.length - 1;
    });
    mascot.flash("happy", label, 2200);
  }

  async function pickPicture() {
    const input = h("input", { type: "file", accept: "image/*,.svg" }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const png = ENGINE_IMAGES.test(file.name) && /\.(png|jpe?g)$/i.test(file.name) ? new Uint8Array(await file.arrayBuffer()) : await browserImageToPng(file);
        const url = URL.createObjectURL(new Blob([png as BlobPart]));
        const img = new Image();
        img.src = url;
        await img.decode();
        URL.revokeObjectURL(url);
        placePicture({ png, width: img.naturalWidth, height: img.naturalHeight }, 0.5, "Lekker picture! Drag it where you want it.");
      } catch {
        oops("That picture couldn't be opened. Try a JPG or PNG.");
      }
    });
    input.click();
  }

  async function signNow() {
    const sig = await openSignatureDialog();
    if (sig) placePicture(sig, 0.32, "Signed, sealed, delivered. Sho!", true);
  }

  // --- Saving --------------------------------------------------------------

  /** Applies the certificate signature, shown over the last placed signature picture if wanted. */
  async function sealWithCertificate(bytes: Uint8Array, cert: CertSettings): Promise<Uint8Array> {
    let page: number | undefined;
    let rect: Box | undefined;
    if (cert.visible) {
      pages.forEach((p, i) =>
        p.annotations.forEach((a) => {
          if (a.type === "image" && a.signature) {
            page = i;
            rect = a.rect;
          }
        }),
      );
    }
    const prepared = await pdf.prepareSign(bytes, {
      name: cert.identity.name,
      reason: cert.reason || undefined,
      location: cert.location || undefined,
      contact: cert.identity.email,
      page,
      rect,
    });
    const { signPrepared } = await import("../sign/certificate");
    return signPrepared(prepared, cert.identity);
  }

  saveBtn.addEventListener("click", async () => {
    if (!doc) return;
    closeActive();
    saveBtn.disabled = true;
    try {
      let [bytes] = await mascot.busy(Promise.all([pdf.edit({ bytes: doc.bytes, password: doc.password }, pages, usedPictures()), sleep(700)]));
      if (certSign) bytes = await mascot.busy(sealWithCertificate(bytes, certSign));
      const name = `${baseName(doc.file.name)}-${certSign ? "signed" : "edited"}.pdf`;
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
      if (enlarged) {
        enlarged = false;
        render();
      }
      reveal(result);
      celebrate(certSign ? `Signed and sealed 🔏 by ${certSign.identity.name}. Sho!` : "Saved! Sho mfowethu, lekker edits.", result);
    } catch (err) {
      oops(err instanceof PdfError ? err.message : "Saving failed.");
    } finally {
      saveBtn.disabled = false;
    }
  });

  function reset() {
    closeActive(false);
    if (doc) closeSession(doc.session);
    doc = undefined;
    pages = [];
    enlarged = false;
    document.body.classList.remove("editor-enlarged");
    zone.hidden = false;
    workspace.hidden = true;
    workspace.replaceChildren();
    result.replaceChildren();
  }

  const section = h(
    "section.tool",
    { id: "tool-edit" },
    h("div.tool-head", {}, h("h2", {}, "Edit a PDF"), h("p", {}, "Change existing text, add formatted text, sign, highlight, erase, and rotate, delete or reorder pages.")),
    zone,
    workspace,
    result,
  );

  // Shortcuts work whenever the editor is on screen, even if focus wandered
  // off (e.g. after a dialog closes), but never while typing or in a dialog.
  document.addEventListener("keydown", (e) => {
    if (!doc || !section.isConnected || section.closest("[hidden]") || document.querySelector(".modal-backdrop")) return;
    if ((e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    if (!section.contains(e.target as Node) && e.target !== document.body) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      section.querySelector<HTMLButtonElement>('.zoom [aria-label="Zoom in"]')?.click();
    } else if (mod && e.key === "-") {
      e.preventDefault();
      section.querySelector<HTMLButtonElement>('.zoom [aria-label="Zoom out"]')?.click();
    } else if (mod && e.key === "0") {
      e.preventDefault();
      section.querySelector<HTMLButtonElement>(".zoom-label")?.click();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== undefined) {
      e.preventDefault();
      deleteSelected();
    }
  });
  // Esc leaves full screen wherever focus is (the enlarged editor covers the page).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && enlarged && !active && section.isConnected) toggleEnlarge();
  });
  section.tabIndex = -1;
  section.addEventListener("pointerdown", (e) => {
    // Take focus for shortcuts (Delete, Ctrl+Z), but never from a text box that just opened.
    if (active || (e.target as Element).closest("input, textarea, select, button")) return;
    section.focus({ preventScroll: true });
  });
  return section;
}

// --- Helpers ---------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sameBox = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

function fmtOf(a: TextAnn): Fmt {
  return {
    family: a.family ?? "sans",
    size: a.size,
    color: a.color,
    bold: !!a.bold,
    italic: !!a.italic,
    underline: !!a.underline,
    strike: !!a.strike,
    align: a.align ?? "left",
  };
}

function rect(r: Box, cls?: string): SVGRectElement {
  const el = document.createElementNS(SVG_NS, "rect");
  el.setAttribute("x", String(Math.min(r[0], r[2])));
  el.setAttribute("y", String(Math.min(r[1], r[3])));
  el.setAttribute("width", String(Math.abs(r[2] - r[0])));
  el.setAttribute("height", String(Math.abs(r[3] - r[1])));
  if (cls) el.classList.add(cls);
  return el;
}

function boxOf(a: Point, b: Point): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function bounds(a: Annotation): Box {
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
/** Width of `text` in points in the given format. */
function measure(text: string, f: Fmt): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * f.size * 0.6;
  measureCtx.font = `${f.italic ? "italic " : ""}${f.bold ? "700 " : ""}${f.size}px ${familyCss(f.family)}`;
  return measureCtx.measureText(text).width;
}
