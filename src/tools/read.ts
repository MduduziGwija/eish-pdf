import { pdf } from "../core/client";
import type { SearchHit } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { renderUrl } from "../ui/thumbs";
import { singleFileTool } from "./shell";

const STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export function readTool(): HTMLElement {
  return singleFileTool({
    id: "read",
    title: "Read a PDF",
    intro: "A quick reader: scroll, zoom, search, and a night mode. Open one from a link too.",
    drop: "Drop a PDF to read",
    wide: true,
    mount(host) {
      const { doc } = host;
      let zoom = 1;
      let hits: SearchHit[] = [];
      let current = -1;
      let night = false;
      const scroller = h("div.reader");
      const find = h("input.input", { type: "search", placeholder: "Search this PDF", "aria-label": "Search this PDF" });
      const found = h("span.chip", {}, "");
      const level = h("span.chip", {}, "100%");
      const jump = h("input.input.small.jump", { type: "number", min: "1", max: String(doc.pages.length), value: "1", "aria-label": "Go to page" });

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const p = Number(el.dataset.page);
            if (e.isIntersecting) {
              if (el.querySelector("img")) continue;
              void renderUrl(doc.session, p, Math.min(3, 1.3 * zoom * dpr)).then((u) => {
                if (!el.isConnected || el.querySelector("img")) return;
                el.prepend(h("img", { src: u, alt: `Page ${p + 1}`, draggable: "false" }));
              });
            } else el.querySelector("img")?.remove();
          }
        },
        { root: scroller, rootMargin: "600px 0px" },
      );

      function build() {
        observer.disconnect();
        scroller.replaceChildren(
          ...doc.pages.map((size, p) => {
            const w = size.width * 1.3 * zoom;
            const sheet = h("div.read-page", { "data-page": String(p) });
            sheet.style.width = `${w}px`;
            sheet.style.height = `${size.height * 1.3 * zoom}px`;
            for (const [k, hit] of hits.entries()) {
              if (hit.page !== p) continue;
              const [x0, y0, x1, y1] = hit.rect;
              const box = h("span.hit", { "data-hit": String(k) });
              Object.assign(box.style, { left: `${x0 * 1.3 * zoom}px`, top: `${y0 * 1.3 * zoom}px`, width: `${(x1 - x0) * 1.3 * zoom}px`, height: `${(y1 - y0) * 1.3 * zoom}px` });
              sheet.append(box);
            }
            observer.observe(sheet);
            return sheet;
          }),
        );
        level.textContent = `${Math.round(zoom * 100)}%`;
        mark();
      }

      function mark() {
        scroller.querySelectorAll(".hit.now").forEach((n) => n.classList.remove("now"));
        const now = scroller.querySelector<HTMLElement>(`.hit[data-hit="${current}"]`);
        now?.classList.add("now");
        now?.scrollIntoView({ block: "center", behavior: "smooth" });
        found.textContent = hits.length ? `${current + 1} of ${hits.length}` : find.value.trim() ? "No matches" : "";
      }

      const go = (by: number) => {
        if (!hits.length) return;
        current = (current + by + hits.length) % hits.length;
        mark();
      };
      let timer = 0;
      find.addEventListener("input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          hits = find.value.trim() ? await pdf.search(doc.session, find.value) : [];
          current = hits.length ? 0 : -1;
          build();
        }, 250);
      });
      find.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
      });

      const setZoom = (z: number) => {
        const keep = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
        zoom = Math.min(3, Math.max(0.5, z));
        build();
        scroller.scrollTop = keep * scroller.scrollHeight;
      };
      const fit = () => setZoom((scroller.clientWidth - 24) / (doc.pages[0].width * 1.3));
      const stepZoom = (dir: 1 | -1) => setZoom(dir > 0 ? (STEPS.find((s) => s > zoom + 0.01) ?? 3) : ([...STEPS].reverse().find((s) => s < zoom - 0.01) ?? 0.5));
      const btn = (label: string, name: Parameters<typeof icon>[0], run: () => void) => h("button.btn.small", { type: "button", title: label, "aria-label": label, onclick: run }, icon(name));

      jump.addEventListener("change", () => {
        const p = Math.min(doc.pages.length, Math.max(1, Number(jump.value) || 1)) - 1;
        scroller.querySelector(`.read-page[data-page="${p}"]`)?.scrollIntoView({ block: "start" });
      });
      scroller.addEventListener(
        "scroll",
        () => {
          const top = scroller.getBoundingClientRect().top;
          for (const el of scroller.querySelectorAll<HTMLElement>(".read-page")) {
            if (el.getBoundingClientRect().bottom - top > 80) {
              jump.value = String(Number(el.dataset.page) + 1);
              break;
            }
          }
        },
        { passive: true },
      );
      const moon = btn("Night mode", "moon", () => scroller.classList.toggle("night", (night = !night)));
      const share = h("button.btn.small", { type: "button", title: "Copy a link that opens this tool" }, "Copy tool link");
      share.addEventListener("click", () => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#read`));

      queueMicrotask(() => {
        fit();
      });
      return [
        h("div.toolbar.reader-bar", {}, h("div.summary", {}, h("label.search", {}, icon("search"), find), btn("Previous match", "up", () => go(-1)), btn("Next match", "down", () => go(1)), found), h("div.actions", {}, jump, h("span.chip", {}, `of ${doc.pages.length}`), btn("Zoom out", "minus", () => stepZoom(-1)), level, btn("Zoom in", "plus", () => stepZoom(1)), h("button.btn.small", { type: "button", onclick: fit }, "Fit"), moon, share)),
        scroller,
      ];
    },
  });
}
