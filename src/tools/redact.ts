import { pdf } from "../core/client";
import type { RedactMark } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName, plural } from "../ui/files";
import { renderUrl } from "../ui/thumbs";
import { singleFileTool } from "./shell";

const SCALE = 1.3;

export function redactTool(): HTMLElement {
  return singleFileTool({
    id: "redact",
    title: "Redact a PDF",
    intro: "Black out names, numbers and areas for good. The text underneath is removed from the file, not just hidden.",
    drop: "Drop a PDF to redact",
    mount(host) {
      const { doc } = host;
      const marks: RedactMark[] = [];
      let page = 0;
      const stage = h("div.redact-stage");
      const label = h("span.chip");
      const count = h("span.chip");
      const terms = h("textarea.input", { rows: "4", placeholder: "Words to black out everywhere, one per line", "aria-label": "Words to black out", spellcheck: false }) as HTMLTextAreaElement;
      const exact = h("input", { type: "checkbox" });
      const go = h("button.btn.primary.big", { type: "button", disabled: true }, icon("redact"), h("span", {}, "Black out for good"));

      const wordList = () => terms.value.split("\n").map((t) => t.trim()).filter(Boolean);
      const refresh = () => {
        count.textContent = `${plural(marks.length, "area")} drawn · ${plural(wordList().length, "word")}`;
        go.disabled = marks.length === 0 && wordList().length === 0;
      };
      terms.addEventListener("input", refresh);

      async function paint() {
        const size = doc.pages[page];
        label.textContent = `Page ${page + 1} of ${doc.pages.length}`;
        const img = h("img.page-img", { alt: `Page ${page + 1}`, draggable: "false" }) as HTMLImageElement;
        const layer = h("div.mark-layer");
        const box = h("div.page-box", {}, img, layer);
        box.style.width = `${size.width * SCALE}px`;
        box.style.height = `${size.height * SCALE}px`;
        stage.replaceChildren(box);
        void renderUrl(doc.session, page, SCALE).then((u) => (img.src = u));

        const drawMarks = () => {
          layer.querySelectorAll(".mark").forEach((n) => n.remove());
          marks.forEach((m, k) => {
            if (m.page !== page) return;
            const [x0, y0, x1, y1] = m.rect;
            const el = h("button.mark", { type: "button", title: "Remove this area", "aria-label": "Remove this area" });
            Object.assign(el.style, { left: `${x0 * SCALE}px`, top: `${y0 * SCALE}px`, width: `${(x1 - x0) * SCALE}px`, height: `${(y1 - y0) * SCALE}px` });
            el.addEventListener("pointerdown", (e) => e.stopPropagation());
            el.addEventListener("click", () => (marks.splice(k, 1), drawMarks(), refresh()));
            layer.append(el);
          });
        };
        drawMarks();

        let start: [number, number] | undefined;
        let ghost: HTMLElement | undefined;
        const at = (e: PointerEvent): [number, number] => {
          const r = layer.getBoundingClientRect();
          return [Math.min(size.width, Math.max(0, (e.clientX - r.left) / SCALE)), Math.min(size.height, Math.max(0, (e.clientY - r.top) / SCALE))];
        };
        layer.addEventListener("pointerdown", (e) => {
          layer.setPointerCapture(e.pointerId);
          start = at(e);
          ghost = h("div.mark.ghost");
          layer.append(ghost);
        });
        layer.addEventListener("pointermove", (e) => {
          if (!start || !ghost) return;
          const [x, y] = at(e);
          Object.assign(ghost.style, { left: `${Math.min(x, start[0]) * SCALE}px`, top: `${Math.min(y, start[1]) * SCALE}px`, width: `${Math.abs(x - start[0]) * SCALE}px`, height: `${Math.abs(y - start[1]) * SCALE}px` });
        });
        layer.addEventListener("pointerup", (e) => {
          if (!start) return;
          const [x, y] = at(e);
          ghost?.remove();
          if (Math.abs(x - start[0]) > 3 && Math.abs(y - start[1]) > 3) marks.push({ page, rect: [Math.min(x, start[0]), Math.min(y, start[1]), Math.max(x, start[0]), Math.max(y, start[1])] });
          start = undefined;
          drawMarks();
          refresh();
        });
      }

      const step = (by: number) => h("button.btn.small", { type: "button", "aria-label": by < 0 ? "Previous page" : "Next page", onclick: () => ((page = Math.min(doc.pages.length - 1, Math.max(0, page + by))), void paint()) }, icon(by < 0 ? "left" : "right"));

      go.addEventListener("click", async () => {
        const out = await host.work(pdf.redact(doc.input, { marks, terms: wordList(), caseSensitive: exact.checked }), "Couldn't redact this file.");
        if (!out) return;
        const hits = Object.values(out.found).reduce((a, b) => a + b, 0);
        host.result(out.bytes, `${baseName(doc.file.name)}-redacted.pdf`, `${plural(out.areas, "area")} blacked out${hits ? ` (${`${hits} word ${hits === 1 ? "match" : "matches"}`})` : ""}`);
      });

      void paint();
      refresh();
      return [
        h("p.fine-print", {}, icon("shield"), "Drag on the page to draw a box. Click a box to take it off. Scanned pages: the picture under the box is blacked out too."),
        h("div.toolbar", {}, h("div.summary", {}, step(-1), label, step(1)), count),
        stage,
        h("div.panel-card", {}, h("h3", {}, "Black out words everywhere"), terms, h("label.check", {}, exact, h("span", {}, "Match capital letters exactly"))),
        h("div.toolbar", {}, h("span.fine-print", {}, "This can't be undone in the saved file. Keep your original."), h("div.actions", {}, go)),
      ];
    },
  });
}
