import { pdf } from "../core/client";
import type { Comment, CommentKind } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName, plural } from "../ui/files";
import { renderUrl } from "../ui/thumbs";
import { singleFileTool } from "./shell";

const SCALE = 1.3;
const KINDS: [CommentKind, string][] = [
  ["note", "Note"],
  ["highlight", "Highlight"],
  ["underline", "Underline"],
  ["strike", "Strike out"],
  ["box", "Box"],
];
const COLORS: Record<CommentKind, [number, number, number]> = { note: [1, 0.8, 0.1], highlight: [1, 0.92, 0.2], underline: [0.1, 0.6, 0.3], strike: [0.9, 0.2, 0.2], box: [0.2, 0.4, 0.9] };
const css = ([r, g, b]: number[]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

export function commentsTool(): HTMLElement {
  return singleFileTool({
    id: "comments",
    title: "Comments",
    intro: "Add notes, highlights and boxes with a comment, edit or delete the ones already in the PDF, then save.",
    drop: "Drop a PDF to comment on",
    mount(host) {
      const { doc } = host;
      let comments: Comment[] = [];
      let kind: CommentKind = "highlight";
      let page = 0;
      let focus: Comment | undefined;
      const author = h("input.input.small", { type: "text", placeholder: "Your name", "aria-label": "Your name", value: "" });
      const stage = h("div.redact-stage");
      const list = h("div.comment-list");
      const label = h("span.chip");
      const save = h("button.btn.primary.big", { type: "button" }, icon("download"), h("span", {}, "Save with comments"));
      const kinds = h("div.segments.compact", { role: "group", "aria-label": "What to add" });

      const paintKinds = () =>
        kinds.replaceChildren(...KINDS.map(([k, l]) => h("button.segment", { type: "button", "aria-pressed": String(kind === k), onclick: () => ((kind = k), paintKinds()) }, h("strong", {}, l))));

      function paintList() {
        const mine = comments.filter((c) => c.page === page);
        save.disabled = false;
        list.replaceChildren(
          h("h3", {}, `${plural(comments.length, "comment")}`),
          ...(comments.length === 0 ? [h("p.fine-print", {}, "Click the page to drop a note, or drag across it for a highlight, underline, strike-out or box.")] : []),
          ...comments.map((c) => {
            const t = h("textarea.input", { rows: "2", "aria-label": `Comment on page ${c.page + 1}`, placeholder: "Write your comment" }) as HTMLTextAreaElement;
            t.value = c.text;
            t.addEventListener("input", () => (c.text = t.value));
            t.addEventListener("focus", () => ((focus = c), c.page !== page && ((page = c.page), void paintPage())));
            const card = h(
              c === focus ? "div.comment.on" : "div.comment",
              {},
              h("div.comment-head", {}, h("span.dot", { style: `background:${css(c.color)}` }), h("strong", {}, `${KINDS.find(([k]) => k === c.kind)![1]} · page ${c.page + 1}`), c.author && h("span.fine-print", {}, c.author), h("button.mini.danger", { type: "button", title: "Delete this comment", "aria-label": "Delete this comment", onclick: () => ((comments = comments.filter((x) => x !== c)), paintAll()) }, icon("trash"))),
              t,
            );
            if (mine.includes(c) && focus === c) queueMicrotask(() => t.focus({ preventScroll: true }));
            return card;
          }),
        );
      }

      async function paintPage() {
        const size = doc.pages[page];
        label.textContent = `Page ${page + 1} of ${doc.pages.length}`;
        const img = h("img.page-img", { alt: `Page ${page + 1}`, draggable: "false" }) as HTMLImageElement;
        const layer = h("div.mark-layer");
        const box = h("div.page-box", {}, img, layer);
        box.style.width = `${size.width * SCALE}px`;
        box.style.height = `${size.height * SCALE}px`;
        stage.replaceChildren(box);
        void renderUrl(doc.session, page, SCALE).then((u) => (img.src = u));
        const draw = () => {
          layer.querySelectorAll(".ann").forEach((n) => n.remove());
          for (const c of comments.filter((x) => x.page === page)) {
            const [x0, y0, x1, y1] = c.kind === "note" ? [c.rect[0], c.rect[1], c.rect[0] + 24, c.rect[1] + 24] : c.rect;
            const el = h("button.ann", { type: "button", "data-kind": c.kind, title: c.text || "Comment", "aria-label": `${c.kind} comment` });
            Object.assign(el.style, { left: `${x0 * SCALE}px`, top: `${y0 * SCALE}px`, width: `${(x1 - x0) * SCALE}px`, height: `${(y1 - y0) * SCALE}px`, "--c": css(c.color) });
            el.addEventListener("pointerdown", (e) => e.stopPropagation());
            el.addEventListener("click", () => ((focus = c), paintList()));
            layer.append(el);
          }
        };
        draw();
        let start: [number, number] | undefined;
        let ghost: HTMLElement | undefined;
        const at = (e: PointerEvent): [number, number] => {
          const r = layer.getBoundingClientRect();
          return [Math.min(size.width, Math.max(0, (e.clientX - r.left) / SCALE)), Math.min(size.height, Math.max(0, (e.clientY - r.top) / SCALE))];
        };
        layer.addEventListener("pointerdown", (e) => {
          layer.setPointerCapture(e.pointerId);
          start = at(e);
          ghost = h("div.ann.ghost");
          layer.append(ghost);
        });
        layer.addEventListener("pointermove", (e) => {
          if (!start || !ghost || kind === "note") return;
          const [x, y] = at(e);
          Object.assign(ghost.style, { left: `${Math.min(x, start[0]) * SCALE}px`, top: `${Math.min(y, start[1]) * SCALE}px`, width: `${Math.abs(x - start[0]) * SCALE}px`, height: `${Math.abs(y - start[1]) * SCALE}px` });
        });
        layer.addEventListener("pointerup", (e) => {
          if (!start) return;
          const [x, y] = at(e);
          ghost?.remove();
          const wide = Math.abs(x - start[0]) > 4 && Math.abs(y - start[1]) > 4;
          if (kind === "note" || !wide) {
            if (kind === "note") comments.push((focus = { id: "", page, kind, rect: [start[0], start[1], start[0] + 24, start[1] + 24], text: "", author: author.value.trim(), color: COLORS.note }));
          } else comments.push((focus = { id: "", page, kind, rect: [Math.min(x, start[0]), Math.min(y, start[1]), Math.max(x, start[0]), Math.max(y, start[1])], text: "", author: author.value.trim(), color: COLORS[kind] }));
          start = undefined;
          draw();
          paintList();
        });
      }

      const paintAll = () => {
        void paintPage();
        paintList();
      };
      const step = (by: number) => h("button.btn.small", { type: "button", "aria-label": by < 0 ? "Previous page" : "Next page", onclick: () => ((page = Math.min(doc.pages.length - 1, Math.max(0, page + by))), paintAll()) }, icon(by < 0 ? "left" : "right"));

      save.addEventListener("click", async () => {
        const bytes = await host.work(pdf.saveComments(doc.input, comments.map((c) => ({ ...c, author: c.author || author.value.trim() }))), "Couldn't save the comments.");
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-commented.pdf`, plural(comments.length, "comment"));
      });

      paintKinds();
      void pdf.listComments(doc.input).then((found) => {
        comments = found;
        paintAll();
      });
      paintAll();
      return [
        h("div.toolbar", {}, kinds, author),
        h("div.toolbar", {}, h("div.summary", {}, step(-1), label, step(1)), h("div.actions", {}, save)),
        h("div.comment-split", {}, stage, list),
      ];
    },
  });
}
