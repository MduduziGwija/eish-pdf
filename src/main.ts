import "./style.css";
import { warmUp } from "./core/client";
import { h, icon } from "./ui/dom";
import { lines, mascot, pick } from "./ui/fun";
import { compareTool } from "./tools/compare";
import { convertTool } from "./tools/convert";
import { editTool } from "./tools/edit";
import { mergeTool } from "./tools/merge";
import { ocrTool } from "./tools/ocr";
import { splitTool } from "./tools/split";
import { unlockTool } from "./tools/unlock";

const SOURCE_URL = "https://github.com/MduduziGwija/eish-pdf";

const TOOLS = [
  { id: "unlock", label: "Unlock", icon: icon("lock"), build: unlockTool },
  { id: "merge", label: "Merge", icon: icon("merge"), build: mergeTool },
  { id: "split", label: "Split", icon: icon("scissors"), build: splitTool },
  { id: "edit", label: "Edit", icon: h("span.glyph-icon", { "aria-hidden": "true" }, "✎"), build: editTool },
  { id: "convert", label: "Convert", icon: h("span.glyph-icon", { "aria-hidden": "true" }, "⇄"), build: convertTool },
  { id: "compare", label: "Compare", icon: h("span.glyph-icon", { "aria-hidden": "true" }, "⚖"), build: compareTool },
  { id: "ocr", label: "OCR", icon: h("span.glyph-icon", { "aria-hidden": "true" }, "🔍"), build: ocrTool },
] as const;
type ToolId = (typeof TOOLS)[number]["id"];

// --- Theme -----------------------------------------------------------------

function storedTheme(): string | null {
  try {
    return localStorage.getItem("eish-theme");
  } catch {
    return null;
  }
}

function applyTheme(theme: string | null) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

applyTheme(storedTheme());

const themeBtn = h("button.icon-btn.theme", { type: "button" });
function paintThemeBtn() {
  themeBtn.replaceChildren(icon(isDark() ? "sun" : "moon"));
  themeBtn.setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
}
themeBtn.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("eish-theme", next);
  } catch {
    /* storage blocked: theme still applies for this visit */
  }
  paintThemeBtn();
  mascot.flash("happy", next === "dark" ? "Lights off. Very mysterious." : "Ahh, sunshine!", 1800);
});
paintThemeBtn();

// --- Layout ----------------------------------------------------------------

const panels = new Map<ToolId, HTMLElement>();
const tabButtons = new Map<ToolId, HTMLButtonElement>();
const stage = h("main.panels", { id: "main" });
const tabBar = h("nav.tabs", { role: "tablist", "aria-label": "Tools" });
const indicator = h("span.tab-indicator", { "aria-hidden": "true" });
tabBar.append(indicator);

for (const t of TOOLS) {
  const btn = h("button.tab", { type: "button", role: "tab", id: `tab-${t.id}`, "aria-controls": `panel-${t.id}` }, t.icon, h("span", {}, t.label));
  btn.addEventListener("click", () => (location.hash = t.id));
  tabButtons.set(t.id, btn);
  tabBar.append(btn);
}

function show(id: ToolId) {
  let panel = panels.get(id);
  if (!panel) {
    panel = h("div.panel", { role: "tabpanel", id: `panel-${id}`, "aria-labelledby": `tab-${id}` }, TOOLS.find((t) => t.id === id)!.build());
    panels.set(id, panel);
    stage.append(panel);
  }
  for (const [key, p] of panels) p.hidden = key !== id;
  for (const [key, b] of tabButtons) {
    b.setAttribute("aria-selected", String(key === id));
    b.tabIndex = key === id ? 0 : -1;
  }
  const active = tabButtons.get(id)!;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  panel.classList.remove("enter");
  void panel.offsetWidth;
  panel.classList.add("enter");
}

function route() {
  const id = location.hash.slice(1) as ToolId;
  show(TOOLS.some((t) => t.id === id) ? id : "unlock");
}

tabBar.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const ids = TOOLS.map((t) => t.id);
  const current = ids.indexOf((location.hash.slice(1) as ToolId) || "unlock");
  const next = ids[(current + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
  location.hash = next;
  tabButtons.get(next)!.focus();
});

const header = h(
  "header.hero",
  {},
  h("div.hero-text", {}, h("h1", {}, "Eish", h("span", {}, "PDF")), h("p.tagline", {}, "For when your PDF says eish."), h("p.privacy", {}, icon("shield"), "Everything happens in your browser. Your files never leave your device.")),
  h("div.mascot-wrap", {}, mascot.bubbleEl, mascot.el),
);

const footer = h(
  "footer.footer",
  {},
  h("p", {}, "Made in Mzansi 🇿🇦 by ", h("strong", {}, "Mduduzi Gwija"), " · Free & open source (AGPL-3.0) · ", h("a", { href: SOURCE_URL, target: "_blank", rel: "noopener" }, "Source code"), " · PDF engine: MuPDF by Artifex"),
);

document.body.append(
  h("a.skip", { href: "#main" }, "Skip to tools"),
  h("div.backdrop", { "aria-hidden": "true" }, h("span.blob.b1"), h("span.blob.b2"), h("span.blob.b3")),
  h("div.shell", {}, h("div.topbar", {}, h("span.brand-mini", {}, "eish", h("b", {}, ".pdf")), themeBtn), header, tabBar, stage, footer),
);

addEventListener("hashchange", route);
addEventListener("resize", route);
route();
mascot.say(pick(lines.idle));
setInterval(() => {
  if (mascot.el.dataset.mood === "idle" && !document.hidden) mascot.say(pick(lines.idle));
}, 12000);

warmUp().catch(() => mascot.flash("eish", "Eish! The PDF engine didn't load. Try refreshing.", 8000));
