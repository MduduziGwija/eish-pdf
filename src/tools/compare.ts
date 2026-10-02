import { pdf, PdfError } from "../core/client";
import { spotsAcross, type Block, type Change, type Comparison, type DocText, type Piece } from "../core/compare";
import { fill, h, icon, replay } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile } from "../ui/files";
import { celebrate, mascot, oops, pick, reveal } from "../ui/fun";
import { closeSession, renderUrl } from "../ui/thumbs";

const MAX_FILES = 10;

interface Item {
  file: File;
  bytes: Uint8Array;
  password?: string;
  pages?: number;
  words?: number;
  text?: DocText;
  state: "ready" | "password" | "error" | "scan";
  note?: string;
  row: HTMLElement;
}

const BUSY = ["Spot the difference, mfowethu…", "Reading every word… twice", "Comparing like a strict teacher…", "Squinting at commas…", "Hold my bucket hat, checking…"];

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Renders word-level pieces as <ins>/<del> spans. */
function piecesEl(pieces: Piece[], only?: "added" | "removed"): HTMLElement {
  const el = h("span.diff-text");
  for (const p of pieces) {
    if (only && p.kind !== "same" && p.kind !== only) continue;
    const tag = p.kind === "added" ? "ins" : p.kind === "removed" ? "del" : "span";
    el.append(h(tag as "span", {}, p.text), " ");
  }
  return el;
}

const piecesHtml = (pieces: Piece[], only?: "added" | "removed") =>
  pieces
    .filter((p) => !only || p.kind === "same" || p.kind === only)
    .map((p) => (p.kind === "added" ? `<ins>${escapeHtml(p.text)}</ins>` : p.kind === "removed" ? `<del>${escapeHtml(p.text)}</del>` : escapeHtml(p.text)))
    .join(" ");

export function compareTool(): HTMLElement {
  let items: Item[] = [];
  let baseIndex = 0;
  let busy = false;
  let comparisons: Comparison[] = [];
  let others: Item[] = [];
  let selected = 0;
  let detailTab: "text" | "visual" = "text";

  const list = h("ul.file-list", { "aria-label": "PDFs to compare" });
  const summary = h("div.summary");
  const ignoreCase = h("input", { type: "checkbox" });
  const runBtn = h("button.btn.primary.big", { type: "button" }, h("span.glyph-icon", { "aria-hidden": "true" }, "⚖"), h("span", {}, "Compare"));
  const clearBtn = h("button.btn.ghost", { type: "button" }, "Clear");
  const options = h("div.ocr-options", { hidden: true }, h("label.check", {}, ignoreCase, h("span", {}, "Ignore upper/lower case")));
  const toolbar = h("div.toolbar", { hidden: true }, summary, h("div.actions", {}, clearBtn, runBtn));
  const results = h("div.compare-results");

  const zone = dropzone({ multiple: true, folder: true, title: "Drop 2 or more PDFs to compare", onFiles: (f) => void add(f) });

  async function add(files: File[]) {
    results.replaceChildren();
    for (const file of files) {
      if (items.length >= MAX_FILES) {
        oops(`Up to ${MAX_FILES} PDFs at a time.`);
        break;
      }
      const item: Item = { file, bytes: await readBytes(file), state: "ready", row: h("li.file") };
      item.row.style.setProperty("--i", String(items.length % 12));
      items.push(item);
      list.append(item.row);
      render(item);
    }
    items.forEach(render);
    refresh();
  }

  function render(item: Item) {
    const index = items.indexOf(item);
    const isBase = index === baseIndex;
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
    item.row.dataset.state = item.state === "ready" ? (isBase ? "done" : "free") : item.state === "scan" ? "ready" : item.state;
    const meta = item.note ?? [item.pages !== undefined && plural(item.pages, "page"), item.words !== undefined && plural(item.words, "word"), formatSize(item.file.size)].filter(Boolean).join(" · ");
    fill(
      item.row,
      h(
        "button.base-pick",
        { type: "button", "aria-pressed": String(isBase), title: isBase ? "This is the base (original)" : "Make this the base", "aria-label": isBase ? `${item.file.name} is the base` : `Make ${item.file.name} the base`, onclick: () => setBase(index) },
        isBase ? "★" : "☆",
      ),
      h(
        "div.file-main",
        {},
        h("div.file-name", { title: item.file.name }, item.file.name),
        h("div.file-meta", {}, meta),
        pwField,
      ),
      h("span.badge", {}, isBase ? "Base" : letterOf(item)),
      h("button.icon-btn.subtle", { type: "button", title: "Remove", "aria-label": `Remove ${item.file.name}`, disabled: busy, onclick: () => remove(item) }, icon("x")),
    );
  }

  /** A, B, C… for the non-base PDFs, in list order. */
  const letterOf = (item: Item) => String.fromCharCode(65 + items.filter((_, i) => i !== baseIndex).indexOf(item));

  function setBase(i: number) {
    if (busy || i === baseIndex) return;
    baseIndex = i;
    replay(items[i].row, "unlocked");
    items.forEach(render);
    if (comparisons.length) void run();
  }

  function remove(item: Item) {
    const i = items.indexOf(item);
    items.splice(i, 1);
    if (baseIndex >= items.length || i === baseIndex) baseIndex = 0;
    else if (i < baseIndex) baseIndex--;
    item.row.remove();
    results.replaceChildren();
    comparisons = [];
    items.forEach(render);
    refresh();
  }

  function refresh() {
    toolbar.hidden = items.length === 0;
    options.hidden = items.length === 0;
    zone.classList.toggle("compact", items.length > 0);
    runBtn.disabled = busy || items.length < 2 || items.some((i) => i.state === "password");
    fill(
      summary,
      h("span.chip", {}, plural(items.length, "PDF")),
      items.length === 1 && h("span.chip.warn", {}, "Add at least one more"),
      items.length >= 2 && h("span.chip", {}, `★ ${items[baseIndex]?.file.name ?? ""} is the base`),
    );
  }

  async function extract(item: Item): Promise<void> {
    if (item.text) return;
    const pages = await pdf.pdfLines({ bytes: item.bytes, password: item.password });
    item.text = { name: item.file.name, pages };
    item.pages = pages.length;
    item.words = pages.flat().join(" ").split(/\s+/).filter(Boolean).length;
    if (item.words === 0) {
      item.state = "scan";
      item.note = `${plural(pages.length, "page")} · no text (a scan?). Text compare will be empty; use Visual, or OCR it first.`;
    }
  }

  async function run() {
    if (items.length < 2) return;
    busy = true;
    refresh();
    const chatter = window.setInterval(() => mascot.say(pick(BUSY)), 2000);
    try {
      await mascot.busy(
        (async () => {
          for (const item of items) {
            try {
              await extract(item);
            } catch (err) {
              if (err instanceof PdfError && err.kind === "password") {
                item.state = "password";
                item.note = item.password ? "Wrong password, try again" : "Needs a password to open";
              } else {
                item.state = "error";
                item.note = err instanceof Error ? err.message : "Couldn't read this PDF.";
              }
            }
            render(item);
          }
          const usable = items.filter((i) => i.text && i.state !== "password" && i.state !== "error");
          const base = items[baseIndex];
          if (!base.text || usable.length < 2) throw new Error("Need at least two readable PDFs, including the base.");
          others = usable.filter((i) => i !== base);
          comparisons = await pdf.compare(base.text, others.map((o) => o.text!), { ignoreCase: ignoreCase.checked });
          selected = 0;
        })(),
      );
      items.forEach(render);
      showResults();
      const total = comparisons.reduce((n, c) => n + c.changes.length, 0);
      if (total === 0) celebrate(others.length === 1 ? "Identical twins! No differences." : "All the same! No differences.", runBtn);
      else celebrate(`Sho! Found ${plural(total, "difference")}.`, runBtn);
    } catch (err) {
      oops(err instanceof Error ? err.message : "Comparing failed.");
    } finally {
      clearInterval(chatter);
      busy = false;
      items.forEach(render);
      refresh();
    }
  }
  runBtn.addEventListener("click", () => void run());

  // --- Results -----------------------------------------------------------

  function showResults() {
    const base = items[baseIndex];
    const cards = h("div.compare-cards");
    comparisons.forEach((c, k) => {
      const same = c.changes.length === 0;
      const card = h(
        "button.compare-card",
        { type: "button", "aria-pressed": String(k === selected), onclick: () => ((selected = k), showResults()) },
        h("div.cc-head", {}, h("span.cc-letter", {}, String.fromCharCode(65 + k)), h("span.cc-name", { title: c.other }, c.other)),
        h("div.cc-ring", { style: `--p:${c.similarity}` }, h("strong", {}, same ? "Same" : pct(c.similarity)), h("span", {}, same ? "identical text" : "the same")),
        h(
          "div.cc-stats",
          {},
          h("span.added", {}, `+${c.wordsAdded}`),
          h("span.removed", {}, `−${c.wordsRemoved}`),
          h("span", {}, plural(c.changes.length, "change")),
        ),
        c.basePages !== c.otherPages && h("div.cc-note", {}, `${c.otherPages} pages vs ${c.basePages}`),
      );
      card.style.setProperty("--i", String(k));
      cards.append(card);
    });

    const spots = spotsAcross(comparisons);
    const reportBtn = h("button.btn", { type: "button", onclick: () => void downloadReport() }, icon("download"), "Download report (PDF)");

    fill(
      results,
      h("div.results-head", {}, h("h3", {}, `Compared with ★ ${base.file.name}`), reportBtn),
      cards,
      spots.length > 0 && overview(spots),
      comparisons[selected] && detail(comparisons[selected], others[selected]),
    );
    reveal(results);
  }

  function overview(spots: ReturnType<typeof spotsAcross>): HTMLElement {
    const head = h("tr", {}, h("th", {}, "Where"), h("th", {}, `★ Base`), ...comparisons.map((c, k) => h("th", { title: c.other }, `${String.fromCharCode(65 + k)} · ${shorten(c.other)}`)));
    const rows = spots.map((s) =>
      h(
        "tr",
        {},
        h("td.where", {}, s.basePage ? `p. ${s.basePage}` : "—"),
        h("td.base-cell", {}, s.baseText ? s.baseText : h("em", {}, "(nothing)")),
        ...s.versions.map((v) =>
          v
            ? h("td.diff-cell", {}, v.added ? piecesEl(v.pieces, "added") : h("em.gone", {}, "removed"))
            : h("td.same-cell", { title: "Same as the base" }, "✓"),
        ),
      ),
    );
    return h(
      "section.overview",
      {},
      h("h4", {}, `Where they differ · ${plural(spots.length, "spot")}`),
      h("p.hint", {}, "Each row is a place in the base document. ✓ means that PDF matches the base there."),
      h("div.table-scroll", {}, h("table.diff-table", {}, h("thead", {}, head), h("tbody", {}, ...rows))),
    );
  }

  function detail(c: Comparison, other: Item): HTMLElement {
    const tabs = h(
      "div.segments.compact",
      { role: "group", "aria-label": "Detail view" },
      h("button.segment", { type: "button", "aria-pressed": String(detailTab === "text"), onclick: () => ((detailTab = "text"), showResults()) }, h("strong", {}, "Text changes"), h("span", {}, "Word by word")),
      h("button.segment", { type: "button", "aria-pressed": String(detailTab === "visual"), onclick: () => ((detailTab = "visual"), showResults()) }, h("strong", {}, "Visual"), h("span", {}, "Highlight changed areas, works on scans")),
    );
    return h(
      "section.detail",
      {},
      h("h4", {}, `${String.fromCharCode(65 + selected)} · ${c.other} vs ★ base`),
      tabs,
      detailTab === "text" ? textView(c) : visualView(other),
    );
  }

  function textView(c: Comparison): HTMLElement {
    if (c.changes.length === 0) return h("p.identical", {}, "✓ The text is identical. Sho!");
    const body = h("div.inline-diff");
    const sameRun = (b: Extract<Block, { kind: "same" }>) => {
      if (b.lines.length <= 4) return h("div.same-lines", {}, ...b.lines.map((l) => h("p", {}, l)));
      const wrap = h("div.same-lines");
      const more = h("button.link.fold", { type: "button" }, `… ${b.lines.length - 2} unchanged lines …`);
      more.addEventListener("click", () => fill(wrap, ...b.lines.map((l) => h("p", {}, l))));
      fill(wrap, h("p", {}, b.lines[0]), more, h("p", {}, b.lines[b.lines.length - 1]));
      return wrap;
    };
    const changeEl = (ch: Change) =>
      h(
        "div.change",
        {},
        h("span.change-where", {}, [ch.basePage && `base p. ${ch.basePage}`, ch.otherPage && `this p. ${ch.otherPage}`].filter(Boolean).join(" → ")),
        h("p", {}, piecesEl(ch.pieces)),
      );
    for (const b of c.blocks) body.append(b.kind === "same" ? sameRun(b) : changeEl(b.change));
    return h("div", {}, h("p.hint", {}, h("ins", {}, "Green"), " = added in this PDF · ", h("del", {}, "red"), " = in the base but not here"), body);
  }

  // --- Visual compare -----------------------------------------------------

  function visualView(other: Item): HTMLElement {
    const base = items[baseIndex];
    const maxPages = Math.max(base.pages ?? 0, other.pages ?? 0);
    let page = 0;
    let mode: "diff" | "base" | "other" = "diff";
    const pageLabel = h("span", {}, "");
    const stat = h("span.chip", {}, "…");
    const img = h("img.visual-img", { alt: "Page comparison" });
    const modes = h("div.segments.compact.visual-modes", { role: "group" });
    const box = h("div.visual", {}, h("div.visual-bar", {}, h("button.icon-btn", { type: "button", "aria-label": "Previous page", onclick: () => go(-1) }, icon("up")), pageLabel, h("button.icon-btn", { type: "button", "aria-label": "Next page", onclick: () => go(1) }, icon("down")), stat, modes), h("div.visual-stage", {}, img));
    let sessions: [number, number] | undefined;

    const renderModes = () =>
      fill(
        modes,
        ...(["diff", "base", "other"] as const).map((m) =>
          h("button.segment", { type: "button", "aria-pressed": String(mode === m), onclick: () => ((mode = m), renderModes(), void draw()) }, h("strong", {}, m === "diff" ? "Highlighted" : m === "base" ? "★ Base" : "This PDF")),
        ),
      );

    const go = (d: number) => {
      page = Math.max(0, Math.min(maxPages - 1, page + d));
      void draw();
    };

    async function draw() {
      pageLabel.textContent = `Page ${page + 1} of ${maxPages}`;
      try {
        sessions ??= [(await pdf.open({ bytes: base.bytes, password: base.password })).session, (await pdf.open({ bytes: other.bytes, password: other.password })).session];
        const [bs, os] = sessions;
        const has = (it: Item) => page < (it.pages ?? 0);
        if (!has(base) || !has(other)) {
          stat.textContent = !has(base) ? "Page only in this PDF" : "Page missing in this PDF";
          stat.className = "chip warn";
          img.src = await renderUrl(has(base) ? bs : os, page, 1.2);
          return;
        }
        const [ua, ub] = await Promise.all([renderUrl(bs, page, 1.2), renderUrl(os, page, 1.2)]);
        if (mode === "base") img.src = ua;
        else if (mode === "other") img.src = ub;
        const result = await pixelDiff(ua, ub);
        stat.textContent = result.changed === 0 ? "No visible differences" : `${pct(result.changed)} of the page differs`;
        stat.className = result.changed === 0 ? "chip good" : "chip bad";
        if (mode === "diff") img.src = result.url;
      } catch {
        stat.textContent = "Couldn't draw this page";
      }
    }

    renderModes();
    void draw();
    // Free the rendered pages when this view goes away.
    const watcher = new MutationObserver(() => {
      if (!box.isConnected && sessions) {
        sessions.forEach(closeSession);
        sessions = undefined;
        watcher.disconnect();
      }
    });
    watcher.observe(results, { childList: true, subtree: true });
    return box;
  }

  // --- Report ---------------------------------------------------------------

  async function downloadReport() {
    const base = items[baseIndex];
    const spots = spotsAcross(comparisons);
    const rows = comparisons
      .map((c, k) => `<tr><td>${String.fromCharCode(65 + k)}</td><td>${escapeHtml(c.other)}</td><td class="n">${pct(c.similarity)}</td><td class="n">+${c.wordsAdded}</td><td class="n">−${c.wordsRemoved}</td><td class="n">${c.changes.length}</td></tr>`)
      .join("");
    const spotRows = spots
      .map(
        (s) =>
          `<tr><td>${s.basePage ? `p. ${s.basePage}` : "—"}</td><td>${escapeHtml(s.baseText) || "<em>(nothing)</em>"}</td>${s.versions
            .map((v) => (v ? `<td>${v.added ? piecesHtml(v.pieces, "added") : "<em>removed</em>"}</td>` : `<td class="same">✓</td>`))
            .join("")}</tr>`,
      )
      .join("");
    const details = comparisons
      .map(
        (c, k) =>
          `<h2>${String.fromCharCode(65 + k)} · ${escapeHtml(c.other)}</h2>` +
          (c.changes.length
            ? c.changes.map((ch) => `<p class="ch"><span class="where">${[ch.basePage && `base p. ${ch.basePage}`, ch.otherPage && `p. ${ch.otherPage}`].filter(Boolean).join(" → ")}</span><br>${piecesHtml(ch.pieces)}</p>`).join("")
            : "<p>Identical text.</p>"),
      )
      .join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${comparisons.length > 3 ? "842pt 595pt" : "595pt 842pt"}; margin: 40pt; }
      body { font-family: sans-serif; font-size: 9.5pt; color: #1b1b1f; }
      h1 { font-size: 18pt; margin: 0 0 4pt; } h2 { font-size: 12pt; margin: 14pt 0 4pt; }
      table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
      td, th { border: 0.6pt solid #aaa; padding: 3pt 5pt; vertical-align: top; text-align: left; }
      th { background: #eee; } td.n { text-align: right; } td.same { color: #007a4d; text-align: center; }
      ins { background: #d6f5e3; color: #00592f; text-decoration: none; } del { background: #fbdcda; color: #9d1d16; }
      .where { color: #777; font-size: 8pt; } .ch { margin: 0 0 6pt; } .muted { color: #666; }
    </style></head><body>
      <h1>PDF comparison</h1>
      <p class="muted">Base: <b>${escapeHtml(base.file.name)}</b> · ${new Date().toLocaleString("en-ZA")} · made with Eish PDF</p>
      <table><tr><th></th><th>Document</th><th>Same as base</th><th>Words added</th><th>Words removed</th><th>Changes</th></tr>${rows}</table>
      ${spots.length ? `<h2>Where they differ</h2><table><tr><th>Where</th><th>Base</th>${comparisons.map((_, k) => `<th>${String.fromCharCode(65 + k)}</th>`).join("")}</tr>${spotRows}</table>` : ""}
      ${details}
    </body></html>`;
    try {
      const bytes = await mascot.busy(pdf.htmlToPdf(html, comparisons.length > 3));
      saveFile(bytes, `comparison-${baseName(base.file.name)}.pdf`);
      mascot.flash("happy", "Report ready. Sho!", 2000);
    } catch {
      oops("Couldn't make the report.");
    }
  }

  clearBtn.addEventListener("click", () => {
    if (busy) return;
    items = [];
    comparisons = [];
    baseIndex = 0;
    list.replaceChildren();
    results.replaceChildren();
    refresh();
  });

  refresh();
  return h(
    "section.tool",
    { id: "tool-compare" },
    h("div.tool-head", {}, h("h2", {}, "Compare PDFs"), h("p", {}, "See what's different between 2 or more PDFs. Pick the original as the base (★); every other PDF is compared with it.")),
    zone,
    options,
    toolbar,
    list,
    results,
  );
}

const shorten = (name: string) => (name.length > 22 ? name.slice(0, 20) + "…" : name);

/** Highlights pixels that differ between two page images, in coarse blocks. */
async function pixelDiff(urlA: string, urlB: string): Promise<{ url: string; changed: number }> {
  const [a, b] = await Promise.all([loadImage(urlA), loadImage(urlB)]);
  const w = Math.max(a.naturalWidth, b.naturalWidth);
  const hgt = Math.max(a.naturalHeight, b.naturalHeight);
  const read = (img: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, hgt).data;
  };
  const da = read(a);
  const db = read(b);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = hgt;
  const ctx = out.getContext("2d")!;
  // Faded copy of the compared page underneath.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.globalAlpha = 0.45;
  ctx.drawImage(b, 0, 0);
  ctx.globalAlpha = 1;

  const BLOCK = 6;
  let changedPixels = 0;
  ctx.fillStyle = "rgba(222, 56, 49, 0.55)";
  for (let by = 0; by < hgt; by += BLOCK) {
    for (let bx = 0; bx < w; bx += BLOCK) {
      let hit = 0;
      for (let y = by; y < Math.min(by + BLOCK, hgt); y++) {
        for (let x = bx; x < Math.min(bx + BLOCK, w); x++) {
          const i = (y * w + x) * 4;
          if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 90) hit++;
        }
      }
      if (hit > 1) {
        changedPixels += hit;
        ctx.fillRect(bx, by, BLOCK, BLOCK);
      }
    }
  }
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  return { url: blob ? URL.createObjectURL(blob) : urlB, changed: changedPixels / (w * hgt) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

