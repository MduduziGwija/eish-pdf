import { pdf } from "../core/client";
import type { Rotation } from "../core/pdf";
import { h } from "./dom";

// Rendered pages, cached per session so re-drawing the UI doesn't re-render.
const cache = new Map<string, Promise<string>>();

/** Renders a page to an object URL (cached). */
export function renderUrl(session: number, page: number, scale: number, rotate: Rotation = 0): Promise<string> {
  const key = `${session}:${page}:${scale}:${rotate}`;
  let url = cache.get(key);
  if (!url) {
    url = pdf.render(session, page, scale, rotate).then((png) => URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })));
    url.catch(() => cache.delete(key));
    cache.set(key, url);
  }
  return url;
}

/** Closes a worker session and frees its rendered images. */
export function closeSession(session: number): void {
  for (const [key, url] of cache) {
    if (key.startsWith(`${session}:`)) {
      cache.delete(key);
      void url.then(URL.revokeObjectURL, () => {});
    }
  }
  void pdf.close(session);
}

const observer =
  typeof IntersectionObserver === "undefined"
    ? undefined
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer!.unobserve(e.target);
            (e.target as HTMLImageElement & { load?: () => void }).load?.();
          }
        },
        { rootMargin: "300px" },
      );

/** An <img> that renders its page only when scrolled near the viewport. */
export function lazyThumb(session: number, page: number, alt: string, rotate: Rotation = 0, scale = 0.3): HTMLImageElement {
  const img = h("img.thumb-img", { alt, draggable: "false" }) as HTMLImageElement & { load?: () => void };
  img.load = () => {
    renderUrl(session, page, scale, rotate)
      .then((url) => {
        img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
        img.src = url;
      })
      .catch(() => img.classList.add("failed"));
  };
  if (observer) observer.observe(img);
  else img.load();
  return img;
}
