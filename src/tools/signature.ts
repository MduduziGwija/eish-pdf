// "Sign" dialog: draw, type or upload a signature. Produces a trimmed PNG with
// a transparent background. Recent signatures are remembered on this device.
import "@fontsource/great-vibes/latin-400.css";
import "@fontsource/dancing-script/latin-400.css";
import "@fontsource/caveat/latin-400.css";
import { h } from "../ui/dom";

export interface Picture {
  png: Uint8Array;
  width: number;
  height: number;
}

const STORE = "eish-signatures";
const INKS = [
  { name: "Black", css: "#15151a" },
  { name: "Blue", css: "#123e9c" },
];
// Free (OFL) handwriting fonts shipped with the app, so signatures look the same everywhere.
const SCRIPT_FONTS = [
  { name: "Elegant", family: "Great Vibes", css: "'Great Vibes', cursive" },
  { name: "Flowing", family: "Dancing Script", css: "'Dancing Script', cursive" },
  { name: "Casual", family: "Caveat", css: "'Caveat', cursive" },
];

function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]");
  } catch {
    return [];
  }
}

function remember(dataUrl: string) {
  try {
    const list = [dataUrl, ...loadSaved().filter((s) => s !== dataUrl)].slice(0, 4);
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    /* storage blocked or full: just don't remember */
  }
}

function forget(dataUrl: string) {
  try {
    localStorage.setItem(STORE, JSON.stringify(loadSaved().filter((s) => s !== dataUrl)));
  } catch {
    /* ignore */
  }
}

/** Crops a canvas to its non-transparent pixels (plus a little padding). */
function trim(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function toPicture(canvas: HTMLCanvasElement): Promise<Picture> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("Couldn't make the signature picture.");
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

async function canvasFromUrl(url: string, removeWhite: boolean): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (removeWhite) {
    // Paper becomes transparent; ink stays, with soft edges.
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const light = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
      if (light > 225) d.data[i + 3] = 0;
      else if (light > 160) d.data[i + 3] = Math.round(((225 - light) / 65) * d.data[i + 3]);
    }
    ctx.putImageData(d, 0, 0);
  }
  return c;
}

export function openSignatureDialog(): Promise<Picture | null> {
  return new Promise((resolve) => {
    let tab: "draw" | "type" | "upload" = "draw";
    let ink = INKS[0].css;
    let font = SCRIPT_FONTS[0].css;
    let uploaded: string | undefined;
    const previous = document.activeElement as HTMLElement | null;

    // Draw pad.
    const pad = h("canvas.sig-pad", { width: 900, height: 300, "aria-label": "Draw your signature here" }) as HTMLCanvasElement;
    const pctx = pad.getContext("2d")!;
    let drawing = false;
    let last: [number, number] | undefined;
    let drew = false;
    const pos = (e: PointerEvent): [number, number] => {
      const r = pad.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height];
    };
    pad.addEventListener("pointerdown", (e) => {
      drawing = true;
      drew = true;
      last = pos(e);
      pad.setPointerCapture(e.pointerId);
      pctx.beginPath();
      pctx.arc(last[0], last[1], 2.2, 0, Math.PI * 2);
      pctx.fillStyle = ink;
      pctx.fill();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!drawing || !last) return;
      const p = pos(e);
      pctx.strokeStyle = ink;
      pctx.lineCap = "round";
      pctx.lineJoin = "round";
      // Faster strokes come out a little thinner, like a real pen.
      const speed = Math.hypot(p[0] - last[0], p[1] - last[1]);
      pctx.lineWidth = Math.max(2.4, 5.2 - speed / 18);
      pctx.beginPath();
      pctx.moveTo(last[0], last[1]);
      pctx.lineTo(p[0], p[1]);
      pctx.stroke();
      last = p;
    });
    const stop = () => {
      drawing = false;
      last = undefined;
    };
    pad.addEventListener("pointerup", stop);
    pad.addEventListener("pointercancel", stop);
    const clearPad = () => {
      pctx.clearRect(0, 0, pad.width, pad.height);
      drew = false;
    };

    // Type.
    const nameInput = h("input.input.sig-name", { type: "text", placeholder: "Type your name", "aria-label": "Your name", maxlength: 60 });
    const typed = h("div.sig-typed", { "aria-hidden": "true" });
    const paintTyped = () => {
      typed.textContent = nameInput.value || "Your name";
      typed.style.fontFamily = font;
      typed.style.color = ink;
    };
    nameInput.addEventListener("input", paintTyped);

    // Upload.
    const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });
    const removeWhite = h("input", { type: "checkbox", checked: true });
    const uploadPreview = h("div.sig-upload-preview", {}, "No picture yet");
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      uploaded = URL.createObjectURL(f);
      uploadPreview.replaceChildren(h("img", { src: uploaded, alt: "Your signature picture" }));
    });

    const body = h("div.sig-body");
    const tabs = h("div.segments.compact.sig-tabs", { role: "tablist" });
    const inks = h("div.swatches", { role: "group", "aria-label": "Ink colour" });
    const saved = h("div.sig-saved");
    const error = h("p.sig-error", { role: "alert" });
    const useBtn = h("button.btn.primary", { type: "button" }, "Place signature");
    const cancelBtn = h("button.btn.ghost", { type: "button" }, "Cancel");

    const renderTabs = () => {
      tabs.replaceChildren(
        ...(["draw", "type", "upload"] as const).map((t) =>
          h(
            "button.segment",
            { type: "button", role: "tab", "aria-selected": String(tab === t), "aria-pressed": String(tab === t), onclick: () => ((tab = t), renderTabs()) },
            h("strong", {}, t === "draw" ? "✍ Draw" : t === "type" ? "Aa Type" : "⇪ Upload"),
          ),
        ),
      );
      inks.replaceChildren(
        ...INKS.map((c) =>
          h("button.swatch", { type: "button", title: c.name, "aria-label": `${c.name} ink`, "aria-pressed": String(ink === c.css), style: `--swatch:${c.css}`, onclick: () => ((ink = c.css), renderTabs()) }),
        ),
      );
      if (tab === "draw") {
        body.replaceChildren(h("div.sig-pad-wrap", {}, pad, h("span.sig-line", { "aria-hidden": "true" }), h("span.sig-x", { "aria-hidden": "true" }, "✕")), h("div.sig-row", {}, inks, h("button.btn.small.ghost", { type: "button", onclick: clearPad }, "Clear")));
      } else if (tab === "type") {
        paintTyped();
        body.replaceChildren(
          nameInput,
          typed,
          h(
            "div.sig-row",
            {},
            inks,
            h(
              "div.sig-fonts",
              {},
              ...SCRIPT_FONTS.map((f) =>
                h("button.btn.small", { type: "button", "aria-pressed": String(font === f.css), style: `font-family:${f.css}`, onclick: () => ((font = f.css), renderTabs()) }, f.name),
              ),
            ),
          ),
        );
        nameInput.focus();
      } else {
        body.replaceChildren(
          h("div.sig-row", {}, h("button.btn", { type: "button", onclick: () => fileInput.click() }, "Choose a picture of your signature"), fileInput),
          uploadPreview,
          h("label.check", {}, removeWhite, h("span", {}, "Make the white paper see-through")),
        );
      }
      error.textContent = "";
    };

    const renderSaved = () => {
      const list = loadSaved();
      saved.replaceChildren(
        ...(list.length
          ? [
              h("span.sig-saved-label", {}, "Your saved signatures:"),
              ...list.map((url) => {
                const chip = h(
                  "div.sig-chip",
                  {},
                  h("button.sig-use", { type: "button", title: "Use this signature", onclick: () => void finishWith(url) }, h("img", { src: url, alt: "Saved signature" })),
                  h("button.sig-forget", { type: "button", title: "Forget this signature", "aria-label": "Forget this signature", onclick: () => (forget(url), renderSaved()) }, "×"),
                );
                return chip;
              }),
            ]
          : []),
      );
    };

    const overlay = h(
      "div.modal-backdrop",
      {},
      h(
        "div.modal.sig-modal",
        { role: "dialog", "aria-modal": "true", "aria-label": "Add your signature" },
        h("h3", {}, "Add your signature"),
        saved,
        tabs,
        body,
        error,
        h("p.fine-print", {}, "This places a picture of your signature (an electronic signature). Saved signatures stay on this device only."),
        h("div.sig-actions", {}, cancelBtn, useBtn),
      ),
    );

    const close = (result: Picture | null) => {
      overlay.classList.add("leaving");
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener("keydown", onKey);
      if (uploaded) URL.revokeObjectURL(uploaded);
      previous?.focus?.();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };

    async function finishWith(url: string) {
      try {
        const c = await canvasFromUrl(url, false);
        close(await toPicture(c));
      } catch {
        error.textContent = "Eish, that saved signature couldn't be loaded.";
      }
    }

    useBtn.addEventListener("click", async () => {
      try {
        let canvas: HTMLCanvasElement | null = null;
        if (tab === "draw") {
          if (!drew) throw new Error("Draw your signature in the box first.");
          canvas = trim(pad);
        } else if (tab === "type") {
          const name = nameInput.value.trim();
          if (!name) throw new Error("Type your name first.");
          // Make sure the handwriting font has loaded before drawing with it.
          await document.fonts.load(`150px ${font}`).catch(() => undefined);
          const c = document.createElement("canvas");
          c.width = 1400;
          c.height = 320;
          const ctx = c.getContext("2d")!;
          ctx.font = `150px ${font}`;
          ctx.fillStyle = ink;
          ctx.textBaseline = "middle";
          ctx.fillText(name, 30, 170, 1340);
          canvas = trim(c);
        } else {
          if (!uploaded) throw new Error("Choose a picture first.");
          canvas = trim(await canvasFromUrl(uploaded, removeWhite.checked));
        }
        if (!canvas) throw new Error("The signature is empty.");
        remember(canvas.toDataURL("image/png"));
        close(await toPicture(canvas));
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : "Something went wrong.";
      }
    });
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);

    renderSaved();
    renderTabs();
    document.body.append(overlay);
    useBtn.focus();
  });
}
