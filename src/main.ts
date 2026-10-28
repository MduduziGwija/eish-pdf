import "./style.css";
import { warmUp } from "./core/client";
import { h, icon } from "./ui/dom";
import { lines, mascot, pick } from "./ui/fun";
import logoUrl from "./assets/logo.webp";
import { homeTool } from "./tools/home";
import { compareTool } from "./tools/compare";
import { autoSplitTool } from "./tools/autosplit";
import { commentsTool } from "./tools/comments";
import { pdfaTool } from "./tools/pdfa";
import { verifyTool } from "./tools/verify";
import { compressTool } from "./tools/compress";
import { formsTool } from "./tools/forms";
import { pagesTool } from "./tools/pages";
import { protectTool } from "./tools/protect";
import { readTool } from "./tools/read";
import { redactTool } from "./tools/redact";
import { stampTool } from "./tools/stamp";
import { convertTool } from "./tools/convert";
import { editTool } from "./tools/edit";
import { mergeTool } from "./tools/merge";
import { ocrTool } from "./tools/ocr";
import { splitTool } from "./tools/split";
import { unlockTool } from "./tools/unlock";

const SOURCE_URL = "https://github.com/MduduziGwija/eish-pdf";

const TOOLS = [
  { group: "", id: "home", label: "Home", icon: icon("home"), build: homeTool },
  { group: "Organize", id: "read", label: "Read", icon: icon("eye"), build: readTool },
  { group: "Organize", id: "pages", label: "Pages", icon: icon("pages"), build: pagesTool },
  { group: "Organize", id: "merge", label: "Merge", icon: icon("merge"), build: mergeTool },
  { group: "Organize", id: "split", label: "Split", icon: icon("scissors"), build: splitTool },
  { group: "Organize", id: "autosplit", label: "Auto split", icon: icon("wand"), build: autoSplitTool },
  { group: "Organize", id: "compress", label: "Compress", icon: icon("squeeze"), build: compressTool },
  { group: "Edit", id: "edit", label: "Edit", icon: icon("pen"), build: editTool },
  { group: "Edit", id: "comments", label: "Comments", icon: icon("comment"), build: commentsTool },
  { group: "Edit", id: "forms", label: "Forms", icon: icon("form"), build: formsTool },
  { group: "Edit", id: "stamp", label: "Stamp", icon: icon("stamp"), build: stampTool },
  { group: "Edit", id: "redact", label: "Redact", icon: icon("redact"), build: redactTool },
  { group: "Scans", id: "ocr", label: "OCR", icon: icon("ocr"), build: ocrTool },
  { group: "Secure", id: "unlock", label: "Unlock", icon: icon("lock"), build: unlockTool },
  { group: "Secure", id: "verify", label: "Signatures", icon: icon("seal"), build: verifyTool },
  { group: "Secure", id: "pdfa", label: "PDF/A", icon: icon("archive"), build: pdfaTool },
  { group: "Secure", id: "protect", label: "Protect", icon: icon("shield"), build: protectTool },
  { group: "Convert", id: "convert", label: "Convert", icon: icon("convert"), build: convertTool },
  { group: "Convert", id: "compare", label: "Compare", icon: icon("compare"), build: compareTool },
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

let lastGroup = "";
for (const t of TOOLS) {
  if (t.group && t.group !== lastGroup) {
    lastGroup = t.group;
    tabBar.append(h("span.tab-group", { "aria-hidden": "true" }, t.group));
  }
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
  // The tabs can wrap onto two rows on phones, so follow both axes.
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.height = `${active.offsetHeight}px`;
  indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  const home = id === "home";
  hero.hidden = !home;
  (home ? heroSlot : document.body).append(mascotWrap);
  mascotWrap.classList.toggle("docked", !home);
  panel.classList.remove("enter");
  void panel.offsetWidth;
  panel.classList.add("enter");
}

function route() {
  const id = location.hash.slice(1).split("?")[0] as ToolId;
  show(TOOLS.some((t) => t.id === id) ? id : "home");
}

tabBar.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const ids = TOOLS.map((t) => t.id);
  const current = ids.indexOf((location.hash.slice(1).split("?")[0] as ToolId) || "home");
  const next = ids[(current + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
  location.hash = next;
  tabButtons.get(next)!.focus();
});

const mascotWrap = h("div.mascot-wrap", {}, mascot.bubbleEl, mascot.el);
const heroSlot = h("div.hero-art");
const hero = h(
  "header.hero",
  {},
  h(
    "div.hero-text",
    {},
    h("p.hello", {}, "Yebo! ", h("span.wave", { "aria-hidden": "true" }, "👋")),
    h("h1", {}, "What would you like to do with your PDF today?"),
    h("p.tagline", {}, "Fast, simple and reliable tools, right at your fingertips."),
    h("p.privacy", {}, icon("shield"), "Everything happens in your browser. Your files never leave your device."),
  ),
  heroSlot,
);

const footer = h(
  "footer.footer",
  {},
  h("p", {}, "Made in Mzansi 🇿🇦 by ", h("strong", {}, "Mduduzi Gwija"), " · Free & open source (AGPL-3.0) · ", h("a", { href: SOURCE_URL, target: "_blank", rel: "noopener" }, "Source code"), " · PDF engine: MuPDF by Artifex"),
);

const side = h(
  "aside.side",
  {},
  h("a.brand", { href: "#home", "aria-label": "Eish PDF home" }, h("img", { src: logoUrl, alt: "", width: "44", height: "56" }), h("span", {}, "Eish ", h("b", {}, "PDF"))),
  tabBar,
  h("div.side-foot", {}, h("span.flag", { "aria-hidden": "true" }, "🇿🇦"), h("div", {}, h("strong", {}, "Made in SA"), h("small", {}, "For my people. Always."))),
);

document.body.append(
  h("a.skip", { href: "#main" }, "Skip to tools"),
  h("div.backdrop", { "aria-hidden": "true" }, h("span.blob.b1"), h("span.blob.b2"), h("span.blob.b3")),
  h("div.app", {}, side, h("div.content", {}, h("div.topbar", {}, h("span.brand-mini", {}, "eish", h("b", {}, ".pdf")), themeBtn), hero, stage, footer)),
);

addEventListener("hashchange", route);
addEventListener("resize", route);
route();
mascot.say(pick(lines.idle));
setInterval(() => {
  if (mascot.el.dataset.mood === "idle" && !document.hidden) mascot.say(pick(lines.idle));
}, 12000);

warmUp().catch(() => mascot.flash("eish", "Eish! The PDF engine didn't load. Try refreshing.", 8000));
