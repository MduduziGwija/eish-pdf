// Word-style formatting bar for text boxes in the editor.
import type { Rgb } from "../core/pdf";
import type { FontStyle } from "../core/text";
import { h, svg } from "../ui/dom";

export type Family = FontStyle["family"];
export type Align = "left" | "center" | "right";

export interface Fmt {
  family: Family;
  size: number;
  color: Rgb;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  align: Align;
}

export const DEFAULT_FMT: Fmt = { family: "sans", size: 14, color: [0.07, 0.07, 0.09], bold: false, italic: false, underline: false, strike: false, align: "left" };

export const FAMILIES: { id: Family; label: string; css: string }[] = [
  { id: "sans", label: "Sans (Arial / Helvetica)", css: "Helvetica, Arial, 'Liberation Sans', sans-serif" },
  { id: "serif", label: "Serif (Times New Roman)", css: "'Times New Roman', Times, 'Liberation Serif', serif" },
  { id: "mono", label: "Mono (Courier)", css: "'Courier New', Courier, 'Liberation Mono', monospace" },
];

const rgb255 = (r: number, g: number, b: number): Rgb => [r / 255, g / 255, b / 255];

export const SWATCHES: { name: string; rgb: Rgb }[] = [
  { name: "Black", rgb: [0.07, 0.07, 0.09] },
  { name: "Charcoal", rgb: rgb255(64, 64, 70) },
  { name: "Grey", rgb: [0.45, 0.45, 0.48] },
  { name: "Navy", rgb: rgb255(10, 30, 100) },
  { name: "Blue", rgb: [0, 0.137, 0.584] },
  { name: "Sky blue", rgb: rgb255(40, 130, 220) },
  { name: "Teal", rgb: rgb255(0, 128, 128) },
  { name: "Green", rgb: [0, 0.478, 0.302] },
  { name: "Olive", rgb: rgb255(110, 120, 20) },
  { name: "Gold", rgb: rgb255(200, 150, 0) },
  { name: "Orange", rgb: rgb255(230, 110, 0) },
  { name: "Red", rgb: [0.871, 0.22, 0.192] },
  { name: "Maroon", rgb: rgb255(128, 20, 40) },
  { name: "Pink", rgb: rgb255(220, 60, 140) },
  { name: "Purple", rgb: rgb255(110, 50, 160) },
  { name: "Brown", rgb: rgb255(110, 70, 40) },
  { name: "White", rgb: [1, 1, 1] },
];

const RECENT_KEY = "eish-recent-colours";
function recentColours(): Rgb[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Rgb[];
    return list.filter((c) => Array.isArray(c) && c.length === 3).slice(0, 6);
  } catch {
    return [];
  }
}
function rememberColour(c: Rgb) {
  try {
    const list = [c, ...recentColours().filter((x) => !x.every((v, i) => Math.abs(v - c[i]) < 0.01))].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Not remembered, that's fine.
  }
}

export const rgbCss = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
const toHex = (c: Rgb) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const sameRgb = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);

export const familyCss = (f: Family) => FAMILIES.find((x) => x.id === f)!.css;

/** Applies a format to an HTML element (the live text box or a preview). */
export function styleElement(el: HTMLElement, fmt: Fmt, pxPerPt: number): void {
  el.style.fontFamily = familyCss(fmt.family);
  el.style.fontSize = `${fmt.size * pxPerPt}px`;
  el.style.fontWeight = fmt.bold ? "700" : "400";
  el.style.fontStyle = fmt.italic ? "italic" : "normal";
  el.style.textDecoration = [fmt.underline && "underline", fmt.strike && "line-through"].filter(Boolean).join(" ") || "none";
  el.style.textAlign = fmt.align;
  el.style.color = rgbCss(fmt.color);
}

const ALIGN_ICON: Record<Align, string> = {
  left: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  center: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 10h10M4 14h16M7 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 10h10M4 14h16M10 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

export interface FormatBar {
  el: HTMLElement;
  /** Re-reads the current format into the controls. */
  sync(): void;
}

/**
 * Builds the bar. `get` returns the format being edited (the open text box's,
 * or the defaults for the next one); `changed` is called after every change.
 */
export function formatBar(get: () => Fmt, changed: () => void, opts: { align: boolean; /** The ink colour of the document text being edited, when there is one. */ ink?: () => Rgb | undefined }): FormatBar {
  const family = h("select.input.small.fmt-family", { "aria-label": "Font" });
  for (const f of FAMILIES) family.append(h("option", { value: f.id }, f.label));
  const size = h("input.input.small.fmt-size", { type: "number", min: 4, max: 144, step: 1, "aria-label": "Font size" });
  const toggle = (key: "bold" | "italic" | "underline" | "strike", label: string, glyph: string, cls: string) =>
    h(`button.fmt-btn.${cls}`, { type: "button", title: label, "aria-label": label, "data-key": key }, glyph);
  const toggles = [
    toggle("bold", "Bold (Ctrl+B)", "B", "b"),
    toggle("italic", "Italic (Ctrl+I)", "I", "i"),
    toggle("underline", "Underline (Ctrl+U)", "U", "u"),
    toggle("strike", "Strikethrough", "S", "s"),
  ];
  const swatches = SWATCHES.map((s) => h("button.swatch", { type: "button", title: s.name, "aria-label": s.name, style: `--swatch:${rgbCss(s.rgb)}`, "data-rgb": s.rgb.join(",") }));
  const picker = h("input.fmt-picker", { type: "color", title: "More colours", "aria-label": "Custom colour" });
  // The document's own ink, so a changed colour can always go back to it.
  const docInk = h("button.swatch.doc-ink", { type: "button", title: "The document's own ink colour", "aria-label": "Document's own ink", hidden: true });
  const recent = h("span.recent-colours");
  const dropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  const pipette = dropper ? h("button.fmt-btn", { type: "button", title: "Pick a colour from anywhere on screen (to copy the ink of a stamp or signature)", "aria-label": "Pick a colour from the screen", "data-pick": "1" }, "💧") : undefined;
  const aligns = (["left", "center", "right"] as Align[]).map((a) => {
    const b = h("button.fmt-btn", { type: "button", title: `Align ${a}`, "aria-label": `Align ${a}`, "data-align": a }, svg(ALIGN_ICON[a]));
    return b;
  });

  const el = h(
    "div.format-bar",
    { role: "toolbar", "aria-label": "Text formatting" },
    h("div.fmt-group", {}, family),
    h(
      "div.fmt-group",
      {},
      h("button.fmt-btn", { type: "button", title: "Smaller", "aria-label": "Smaller text", "data-step": "-1" }, "A−"),
      size,
      h("button.fmt-btn", { type: "button", title: "Bigger", "aria-label": "Bigger text", "data-step": "1" }, "A+"),
    ),
    h("div.fmt-group", {}, ...toggles),
    h("div.fmt-group.fmt-colours", {}, docInk, ...swatches, picker, pipette, recent),
    opts.align && h("div.fmt-group", {}, ...aligns),
  );

  // Buttons must not steal focus from the text box being typed in.
  el.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button")) e.preventDefault();
  });

  el.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest("button");
    if (!btn) return;
    const fmt = get();
    if (btn.dataset.key) {
      const key = btn.dataset.key as "bold" | "italic" | "underline" | "strike";
      fmt[key] = !fmt[key];
    } else if (btn.dataset.step) {
      fmt.size = clampSize(fmt.size + Number(btn.dataset.step) * (fmt.size >= 24 ? 2 : 1));
    } else if (btn.dataset.pick) {
      // The browser's eyedropper (Chrome, Edge): click anywhere on screen to copy that colour.
      void new dropper!().open().then(
        ({ sRGBHex }) => {
          get().color = fromHex(sRGBHex);
          rememberColour(get().color);
          sync();
          changed();
        },
        () => undefined,
      );
      return;
    } else if (btn.dataset.rgb) {
      fmt.color = btn.dataset.rgb.split(",").map(Number) as Rgb;
    } else if (btn.dataset.align) {
      fmt.align = btn.dataset.align as Align;
    } else return;
    sync();
    changed();
  });
  family.addEventListener("change", () => {
    get().family = family.value as Family;
    changed();
  });
  size.addEventListener("input", () => {
    const v = Number(size.value);
    if (v >= 4 && v <= 144) {
      get().size = v;
      changed();
    }
  });
  picker.addEventListener("input", () => {
    get().color = fromHex(picker.value);
    sync();
    changed();
  });
  picker.addEventListener("change", () => {
    rememberColour(fromHex(picker.value));
    sync();
  });

  function sync() {
    const fmt = get();
    family.value = fmt.family;
    if (document.activeElement !== size) size.value = String(Math.round(fmt.size * 10) / 10);
    for (const t of toggles) t.setAttribute("aria-pressed", String(fmt[t.dataset.key as "bold"]));
    for (const s of swatches) s.setAttribute("aria-pressed", String(sameRgb(s.dataset.rgb!.split(",").map(Number) as Rgb, fmt.color)));
    picker.value = toHex(fmt.color);
    const ink = opts.ink?.();
    docInk.hidden = !ink;
    if (ink) {
      docInk.style.setProperty("--swatch", rgbCss(ink));
      docInk.dataset.rgb = ink.join(",");
      docInk.setAttribute("aria-pressed", String(sameRgb(ink, fmt.color)));
    }
    recent.replaceChildren(
      ...recentColours().map((c) => {
        const b = h("button.swatch", { type: "button", title: `Recent: ${toHex(c)}`, "aria-label": `Recent colour ${toHex(c)}`, style: `--swatch:${rgbCss(c)}` });
        b.dataset.rgb = c.join(",");
        b.setAttribute("aria-pressed", String(sameRgb(c, fmt.color)));
        return b;
      }),
    );
    for (const a of aligns) a.setAttribute("aria-pressed", String(a.dataset.align === fmt.align));
  }
  sync();
  el.addEventListener("sync", sync);
  return { el, sync };
}

const clampSize = (n: number) => Math.max(4, Math.min(144, Math.round(n)));
