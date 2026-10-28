import { pdf } from "../core/client";
import type { Rotation } from "../core/pdf";
import { h, icon } from "../ui/dom";
import { baseName, plural } from "../ui/files";
import { lazyThumb } from "../ui/thumbs";
import { singleFileTool } from "./shell";

interface Card {
  from: number;
  rotate: Rotation;
  key: number;
}

const turn = (r: Rotation, by: number): Rotation => ((((r + by) % 360) + 360) % 360) as Rotation;

export function pagesTool(): HTMLElement {
  return singleFileTool({
    id: "pages",
    title: "Organize pages",
    intro: "Drag pages into a new order, turn them, copy them or throw them out. Then save.",
    drop: "Drop a PDF to rearrange",
    mount(host) {
      const { doc } = host;
      let nextKey = 0;
      let cards: Card[] = doc.pages.map((_, i) => ({ from: i, rotate: 0, key: nextKey++ }));
      let dragging: number | undefined;
      const grid = h("div.thumb-grid.organise-grid", { role: "list", "aria-label": "Pages" });
      const summary = h("span.chip");
      const save = h("button.btn.primary.big", { type: "button" }, icon("download"), h("span", {}, "Save new PDF"));

      const move = (index: number, to: number) => {
        if (to < 0 || to >= cards.length || to === index) return;
        const [c] = cards.splice(index, 1);
        cards.splice(to, 0, c);
        paint();
      };

      function tool(label: string, name: Parameters<typeof icon>[0], run: () => void, danger = false) {
        return h(danger ? "button.mini.danger" : "button.mini", { type: "button", title: label, "aria-label": label, onclick: (e: Event) => { e.stopPropagation(); run(); } }, icon(name));
      }

      function paint() {
        grid.replaceChildren(
          ...cards.map((c, i) => {
            const img = lazyThumb(doc.session, c.from, `Page ${c.from + 1}`, 0, 0.35);
            img.style.transform = `rotate(${c.rotate}deg)`;
            const sheet = h("div.sheet", {}, img);
            const el = h(
              "div.page-card",
              { role: "listitem", draggable: "true", "data-key": String(c.key) },
              sheet,
              h("span.thumb-num", {}, String(i + 1)),
              h(
                "div.card-tools",
                {},
                tool("Move earlier", "left", () => move(i, i - 1)),
                tool("Turn left", "rotate", () => ((c.rotate = turn(c.rotate, -90)), paint())),
                tool("Turn right", "rotate", () => ((c.rotate = turn(c.rotate, 90)), paint())),
                tool("Copy page", "copy", () => (cards.splice(i + 1, 0, { ...c, key: nextKey++ }), paint())),
                tool("Remove page", "trash", () => (cards.splice(i, 1), paint()), true),
                tool("Move later", "right", () => move(i, i + 1)),
              ),
            );
            el.style.setProperty("--i", String(i % 24));
            el.addEventListener("dragstart", (e) => {
              dragging = i;
              e.dataTransfer?.setData("text/plain", String(i));
              el.classList.add("lifting");
            });
            el.addEventListener("dragend", () => {
              dragging = undefined;
              el.classList.remove("lifting");
              grid.querySelectorAll(".drop-here").forEach((n) => n.classList.remove("drop-here"));
            });
            el.addEventListener("dragover", (e) => {
              e.preventDefault();
              el.classList.add("drop-here");
            });
            el.addEventListener("dragleave", () => el.classList.remove("drop-here"));
            el.addEventListener("drop", (e) => {
              e.preventDefault();
              if (dragging !== undefined) move(dragging, i);
            });
            return el;
          }),
        );
        summary.textContent = `${plural(cards.length, "page")}${cards.length !== doc.pages.length ? ` (was ${doc.pages.length})` : ""}`;
        save.disabled = cards.length === 0;
      }

      const bulk = (label: string, fn: () => void) => h("button.btn.small", { type: "button", onclick: () => (fn(), paint()) }, label);
      save.addEventListener("click", async () => {
        const bytes = await host.work(pdf.organize(doc.input, cards.map((c) => ({ from: c.from, rotate: c.rotate }))), "Couldn't rebuild the PDF.");
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-organized.pdf`, plural(cards.length, "page"));
      });

      paint();
      return [
        h(
          "div.toolbar",
          {},
          h("div.summary", {}, summary, bulk("Reverse", () => cards.reverse()), bulk("Turn all right", () => cards.forEach((c) => (c.rotate = turn(c.rotate, 90)))), bulk("Remove odd pages", () => (cards = cards.filter((_, i) => i % 2 === 1))), bulk("Remove even pages", () => (cards = cards.filter((_, i) => i % 2 === 0))), bulk("Start over", () => (cards = doc.pages.map((_, i) => ({ from: i, rotate: 0 as Rotation, key: nextKey++ }))))),
          h("div.actions", {}, save),
        ),
        grid,
      ];
    },
  });
}
