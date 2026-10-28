import { pdf } from "../core/client";
import type { Squeeze } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName, formatSize, plural } from "../ui/files";
import { singleFileTool } from "./shell";

const LEVELS: [Squeeze, string, string][] = [
  ["light", "Light", "Sharp pictures (220 dpi)"],
  ["balanced", "Balanced", "Good for email (150 dpi)"],
  ["strong", "Strong", "Smallest file (100 dpi)"],
];

export function compressTool(): HTMLElement {
  return singleFileTool({
    id: "compress",
    title: "Make a PDF smaller",
    intro: "Squeezes big pictures, removes leftovers and duplicates. Text stays crisp and searchable.",
    drop: "Drop a PDF to shrink",
    mount(host) {
      const { doc } = host;
      let level: Squeeze = "balanced";
      const segments = h("div.segments", { role: "group", "aria-label": "How much to squeeze" });
      const paint = () =>
        segments.replaceChildren(
          ...LEVELS.map(([id, label, hint]) => h("button.segment", { type: "button", "aria-pressed": String(level === id), onclick: () => ((level = id), paint()) }, h("strong", {}, label), h("span", {}, hint))),
        );
      paint();
      const go = h("button.btn.primary.big", { type: "button" }, icon("squeeze"), h("span", {}, "Shrink it"));
      go.addEventListener("click", async () => {
        const out = await host.work(pdf.compress(doc.input, level), "Couldn't shrink this one.");
        if (!out) return;
        const saved = Math.max(0, 1 - out.after / out.before);
        const note =
          out.after >= out.before
            ? "Already about as small as it gets"
            : `${formatSize(out.before)} → ${formatSize(out.after)} (${Math.round(saved * 100)}% smaller)${out.images ? ` · ${plural(out.images, "picture")} squeezed` : ""}`;
        host.result(out.after >= out.before ? doc.bytes : out.bytes, `${baseName(doc.file.name)}-smaller.pdf`, note);
      });
      return [segments, h("div.toolbar", {}, h("span.chip", {}, `Now ${formatSize(doc.bytes.byteLength)}`), h("div.actions", {}, go))];
    },
  });
}
