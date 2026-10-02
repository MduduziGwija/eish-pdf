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
  key: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11.3 11.7 20 3m-3.5 3.5 2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

export function icon(name: keyof typeof icons): SVGSVGElement {
  const el = svg(icons[name]);
  el.classList.add("icon");
  return el;
}
