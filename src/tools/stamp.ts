import { pdf } from "../core/client";
import type { StampOptions } from "../core/pageops";
import { parsePageRanges } from "../core/ranges";
import { h, icon } from "../ui/dom";
import { baseName } from "../ui/files";
import { oops } from "../ui/fun";
import { renderUrl } from "../ui/thumbs";
import { singleFileTool } from "./shell";

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
const POSITIONS: [NonNullable<StampOptions["numbering"]>["position"], string][] = [
  ["bottom-center", "Bottom centre"],
  ["bottom-right", "Bottom right"],
  ["bottom-left", "Bottom left"],
  ["top-center", "Top centre"],
  ["top-right", "Top right"],
  ["top-left", "Top left"],
];

export function stampTool(): HTMLElement {
  return singleFileTool({
    id: "stamp",
    title: "Watermark & page numbers",
    intro: "Put CONFIDENTIAL across every page, number the pages, or add a header or footer line.",
    drop: "Drop a PDF to stamp",
    mount(host) {
      const { doc } = host;
      const on = (label: string, checked: boolean) => {
        const input = h("input", { type: "checkbox", checked });
        return { input, el: h("label.check.strong", {}, input, h("span", {}, label)) };
      };
      const field = (label: string, el: HTMLElement) => h("label.option", {}, h("span", {}, label), el);
      const wm = on("Watermark", true);
      const wmText = h("input.input", { type: "text", value: "CONFIDENTIAL", "aria-label": "Watermark text" });
      const wmSize = h("input.input", { type: "number", value: "72", min: "10", max: "300", "aria-label": "Watermark size" });
      const wmAngle = h("input.input", { type: "number", value: "-40", min: "-90", max: "90", "aria-label": "Watermark angle" });
      const wmColor = h("input", { type: "color", value: "#c8c8c8", "aria-label": "Watermark colour" });
      const num = on("Page numbers, header or footer", true);
      const numFormat = h("input.input", { type: "text", value: "Page {n} of {total}", "aria-label": "Text on each page" });
      const numPos = h("select.input.select", { "aria-label": "Where on the page" });
      POSITIONS.forEach(([v, l]) => numPos.append(h("option", { value: v }, l)));
      const numSize = h("input.input", { type: "number", value: "10", min: "6", max: "48", "aria-label": "Text size" });
      const numStart = h("input.input", { type: "number", value: "1", min: "0", "aria-label": "First number" });
      const numColor = h("input", { type: "color", value: "#333333", "aria-label": "Text colour" });
      const which = h("input.input", { type: "text", placeholder: "All pages, or e.g. 1-3, 5", "aria-label": "Pages to stamp" });
      const preview = h("div.stamp-preview");

      function options(): StampOptions | undefined {
        const o: StampOptions = {};
        if (wm.input.checked) o.watermark = { text: wmText.value, size: Number(wmSize.value) || 72, angle: Number(wmAngle.value) || 0, color: hex(wmColor.value) };
        if (num.input.checked) o.numbering = { format: numFormat.value, position: numPos.value as never, size: Number(numSize.value) || 10, color: hex(numColor.value), start: Number(numStart.value) || 0 };
        if (which.value.trim()) {
          try {
            o.pages = parsePageRanges(which.value, doc.pages.length).flat();
          } catch (err) {
            oops(err instanceof Error ? err.message : "Those pages don't look right.");
            return undefined;
          }
        }
        if (!o.watermark && !o.numbering) {
          oops("Switch on a watermark or page numbers first.");
          return undefined;
        }
        return o;
      }

      const look = h("button.btn", { type: "button" }, icon("eye"), "Preview");
      look.addEventListener("click", async () => {
        const o = options();
        if (!o) return;
        const bytes = await host.work(pdf.stamp(doc.input, { ...o, pages: [o.pages?.[0] ?? 0] }));
        if (!bytes) return;
        const { session } = await pdf.open({ bytes });
        const url = await renderUrl(session, o.pages?.[0] ?? 0, 0.8);
        preview.replaceChildren(h("img", { src: url, alt: "Preview of the stamped page" }));
        void pdf.close(session);
      });
      const go = h("button.btn.primary.big", { type: "button" }, icon("stamp"), h("span", {}, "Stamp it"));
      go.addEventListener("click", async () => {
        const o = options();
        if (!o) return;
        const bytes = await host.work(pdf.stamp(doc.input, o), "Couldn't stamp this file.");
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-stamped.pdf`);
      });

      return [
        h("div.panel-card", {}, wm.el, h("div.form-grid", {}, field("Text", wmText), field("Size", wmSize), field("Angle", wmAngle), field("Colour", wmColor))),
        h("div.panel-card", {}, num.el, h("p.fine-print", {}, "Use {n} for the page number and {total} for the page count."), h("div.form-grid", {}, field("Text", numFormat), field("Where", numPos), field("Size", numSize), field("Start at", numStart), field("Colour", numColor))),
        h("div.panel-card", {}, field("Pages", which)),
        h("div.toolbar", {}, h("span"), h("div.actions", {}, look, go)),
        preview,
      ];
    },
  });
}
