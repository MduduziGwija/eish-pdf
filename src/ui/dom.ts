type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Tiny element builder: h("button.primary", { onclick }, "Go"). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}`,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(" ");
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child);
  }
}

/** Like replaceChildren, but skips false/null/undefined children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

/** Parses trusted inline SVG markup into an element. */
export function svg(markup: string): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

/** Restarts a CSS animation class on an element. */
export function replay(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

export const icons = {
  lock: `<svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><path class="shackle" d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4.5" y="11" width="15" height="10" rx="3" fill="currentColor"/><circle cx="12" cy="16" r="1.6" fill="var(--surface)"/></svg>`,
  file: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1-1.5z" fill="currentColor" opacity=".18"/><path d="M14 2.5V7a.5.5 0 0 0 .5.5H19M6.5 2.5h7.5l5 5v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 1.5v3m0 15v3M1.5 12h3m15 0h3M4.6 4.6l2.1 2.1m10.6 10.6 2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.6 7.5 10 4.3-1.4 7.5-5.4 7.5-10v-6z" fill="currentColor" opacity=".2"/><path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.6 7.5 10 4.3-1.4 7.5-5.4 7.5-10v-6zM8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // Tool icons: 24px line style, 2px round strokes, like the others.
  ocr: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8m8 0h2.5A1.5 1.5 0 0 1 20 5.5V8m0 8v2.5a1.5 1.5 0 0 1-1.5 1.5H16m-8 0H5.5A1.5 1.5 0 0 1 4 18.5V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 9.5h8M8 12.5h8M8 15.5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  pen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h3.8L18.6 9.2a2.2 2.2 0 0 0-3.1-3.1L5.2 16.4l-.7 3.1zM13.8 7.8l3.1 3.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  convert: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h14m0 0-3.5-3.5M18 8l-3.5 3.5M20 16H6m0 0 3.5-3.5M6 16l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  compare: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16m-5 0h10M5 7h14M12 4.5 5 7m7-2.5L19 7M5 7l-2.8 6.2a2.9 2.9 0 0 0 5.6 0L5 7zm14 0-2.8 6.2a2.9 2.9 0 0 0 5.6 0L19 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  scissors: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6.5" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="17.5" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 8.2 20 18M8.5 15.8 20 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  merge: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="3" width="8" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 17.5h10M12 14.5v6.5m0 0-2.5-2.5M12 21l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.2 12 4l8 7.2V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9v5.5H5.5A1.5 1.5 0 0 1 4 19z" fill="currentColor"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m0 0-5-5m5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  comment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 10h8M8 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  seal: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m9.2 10 2 2 3.6-3.8M8.5 15.2 7 21l5-2.6 5 2.6-1.5-5.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9M10 13h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  wand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 9.5-9.5M13 6.5l4.5 4.5M17.5 3v3m-1.5-1.5h3M19.5 13v2.5M18.2 14.2h2.6M7 4v2.5M5.7 5.2h2.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rotate: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4v4.5H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  squeeze: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5m11-5h-5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor"/></svg>`,
  redact: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 17h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4" y="10.2" width="16" height="3.6" rx="1" fill="currentColor"/></svg>`,
  stamp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5h6v5l2.5 3.5H6.5L9 9.5zM5 16.5h14v3H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  form: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 9h3M8 15h3m2-6h3m-3 6h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`,
  pages: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="7" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="13.5" y="4" width="7" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="3.5" y="16" width="7" height="4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="13.5" y="16" width="7" height="4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>`,
  left: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  key: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11.3 11.7 20 3m-3.5 3.5 2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

export function icon(name: keyof typeof icons): SVGSVGElement {
  const el = svg(icons[name]);
  el.classList.add("icon");
  return el;
}
