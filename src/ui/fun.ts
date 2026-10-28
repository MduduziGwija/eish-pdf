// The personality layer: mascot, local slang, confetti and toasts.
import { h, reducedMotion, replay, svg } from "./dom";

export const lines = {
  busy: [
    "Busy, busy…",
    "Just now, just now…",
    "Now-now, promise…",
    "Asking the PDF nicely…",
    "Haggling with the padlock…",
    "Loading. Not load-shedding, loading.",
    "Hold on, the kettle's on…",
    "Sharpening the scissors…",
    "Squeezing pages together…",
    "Sho, give me a sec, mfowethu…",
    "Working like a taxi on month-end…",
    "Eish, this one's heavy. Lifting with my knees…",
  ],
  done: [
    "Lekker! All done.",
    "Sharp sharp! ✔",
    "Sho mfowethu, done!",
    "Ayoba!",
    "Yebo yes! Sorted.",
    "Kwaai, my bru!",
    "Shap shap!",
    "Laduma! ⚽",
    "Eish? No more eish.",
  ],
  idle: [
    "Sho mfowethu! Drop me a PDF.",
    "Howzit! Drop me a PDF.",
    "Eita! What are we fixing today?",
    "Heita, my bra! Got PDFs?",
    "Yebo yes, I'm ready.",
    "Rocking the bucket hat. Bring the PDFs.",
    "I eat stubborn PDFs for breakfast.",
    "Your files stay on your device. Promise.",
    "No uploads. No funny business.",
    "Locked PDF? Eish. Let's sort it.",
  ],
  poke: [
    "Hey! That tickles.",
    "Eish, careful!",
    "Ja, ja, I'm awake.",
    "Aweh!",
    "Haibo!",
    "Eita!",
    "Sho mfowethu, relax!",
    "Hayibo, not the bucket hat!",
    "Mind the hat, my bra.",
  ],
  nom: ["Ooh, PDFs! Drop them!", "Nom nom nom…", "Feed me!", "Yebo, more PDFs!"],
};

export const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export type Mood = "idle" | "nom" | "work" | "happy" | "eish" | "read";

import bodyUrl from "../assets/mascot-body.webp";
import hatUrl from "../assets/mascot-hat.webp";

// The mascot is the Eish PDF icon, cut into layers (body and bucket hat) so the hat can move
// on its own, with pupils drawn on top of blank eyes so they can follow the pointer.
const K = 700 / 1254;
const EYE_OPENINGS = {
  left: [[420, 546], [470, 537], [520, 528], [558, 527], [563, 560], [548, 607], [520, 636], [482, 642], [442, 624], [418, 590], [408, 560]],
  right: [[722, 497], [760, 481], [800, 472], [850, 464], [860, 490], [863, 520], [850, 558], [812, 575], [772, 568], [738, 545], [724, 520]],
} as const;
const IRIS = { left: [508, 592], right: [797, 518] } as const;
const scaled = (pts: readonly (readonly number[])[]) => pts.map(([x, y]) => `${(x * K).toFixed(1)},${(y * K).toFixed(1)}`).join(" ");
const box = (pts: readonly (readonly number[])[]) => {
  const xs = pts.map((p) => p[0] * K);
  const ys = pts.map((p) => p[1] * K);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

const eyeMarkup = (side: "left" | "right") => {
  const [cx, cy] = IRIS[side].map((v) => v * K);
  const b = box(EYE_OPENINGS[side]);
  return `
    <clipPath id="m-clip-${side}"><polygon points="${scaled(EYE_OPENINGS[side])}"/></clipPath>
    <g clip-path="url(#m-clip-${side})">
      <g class="m-pupil" data-side="${side}">
        <ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="29" ry="35" fill="#3b2013"/>
        <ellipse cx="${cx.toFixed(1)}" cy="${(cy + 3).toFixed(1)}" rx="15" ry="21" fill="#050403"/>
        <circle cx="${(cx - 11).toFixed(1)}" cy="${(cy - 14).toFixed(1)}" r="8" fill="#fff"/>
        <circle cx="${(cx + 9).toFixed(1)}" cy="${(cy + 14).toFixed(1)}" r="3" fill="#fff" opacity=".7"/>
      </g>
      <rect class="m-lid" x="${(b.x - 4).toFixed(1)}" y="${(b.y - 4).toFixed(1)}" width="${(b.w + 8).toFixed(1)}" height="${(b.h + 8).toFixed(1)}"/>
    </g>`;
};

const MASCOT_SVG = `
<svg class="mascot-svg" viewBox="0 0 700 700" aria-hidden="true">
  <ellipse class="m-shadow" cx="350" cy="672" rx="200" ry="14"/>
  <g class="m-body">
    <image href="${bodyUrl}" width="700" height="700"/>
    <defs></defs>
    ${eyeMarkup("left")}
    ${eyeMarkup("right")}
    <g class="m-hat"><image href="${hatUrl}" width="700" height="700"/></g>
  </g>
</svg>`;

class Mascot {
  readonly el: HTMLElement;
  private bubble: HTMLElement;
  private moodTimer?: number;
  private busyTimer?: number;

  constructor() {
    this.bubble = h("div.bubble", { role: "status", "aria-live": "polite" });
    const figure = svg(MASCOT_SVG);
    this.el = h("button.mascot", { type: "button", "aria-label": "Eish, the mascot. Click to poke.", "data-mood": "idle" }, figure);
    this.watch(figure);
    this.el.addEventListener("click", () => {
      if (this.busyTimer) return;
      replay(this.el, "poked");
      this.flash("eish", pick(lines.poke), 1400);
    });
  }

  /** Pupils follow the pointer (or look down while reading, dart about while working); the mascot blinks now and then. */
  private watch(figure: SVGSVGElement): void {
    const pupils = [...figure.querySelectorAll<SVGGElement>(".m-pupil")];
    let pointer: { x: number; y: number } | undefined;
    const cur = { x: 0, y: 0 };
    const moves = reducedMotion() ? 0 : 1;
    addEventListener("pointermove", (e: PointerEvent) => (pointer = { x: e.clientX, y: e.clientY }), { passive: true });
    addEventListener("pointerleave", () => (pointer = undefined));
    document.addEventListener("mouseleave", () => (pointer = undefined));
    const frame = (t: number) => {
      requestAnimationFrame(frame);
      if (document.hidden || !moves) return;
      let tx = 0;
      let ty = 0;
      const mood = this.el.dataset.mood;
      if (mood === "read") (tx = Math.sin(t / 380) * 9), (ty = 8);
      else if (mood === "work") (tx = Math.sin(t / 170) * 10), (ty = Math.cos(t / 260) * 3);
      else if (pointer) {
        const r = this.el.getBoundingClientRect();
        const dx = pointer.x - (r.left + r.width * 0.5);
        const dy = pointer.y - (r.top + r.height * 0.42);
        const d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, d / 220);
        tx = (dx / d) * 12 * pull;
        ty = (dy / d) * 9 * pull;
      }
      cur.x += (tx - cur.x) * 0.18;
      cur.y += (ty - cur.y) * 0.18;
      for (const p of pupils) p.style.transform = `translate(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px)`;
    };
    requestAnimationFrame(frame);
    const blink = () => {
      if (!document.hidden && !reducedMotion()) {
        this.el.classList.add("blinking");
        setTimeout(() => this.el.classList.remove("blinking"), 140);
        // Now and then, a double blink.
        if (Math.random() < 0.2) setTimeout(() => (this.el.classList.add("blinking"), setTimeout(() => this.el.classList.remove("blinking"), 120)), 260);
      }
      setTimeout(blink, 2200 + Math.random() * 3800);
    };
    setTimeout(blink, 1800);
  }

  get bubbleEl(): HTMLElement {
    return this.bubble;
  }

  mood(mood: Mood): void {
    this.el.dataset.mood = mood;
  }

  say(text: string): void {
    this.bubble.textContent = text;
    replay(this.bubble, "pop");
  }

  /** Shows a mood + line, then returns to idle. */
  flash(mood: Mood, text: string, ms = 2600): void {
    clearTimeout(this.moodTimer);
    this.mood(mood);
    this.say(text);
    this.moodTimer = window.setTimeout(() => this.mood("idle"), ms);
  }

  /** Sweats and chats while `task` runs. */
  async busy<T>(task: Promise<T>): Promise<T> {
    clearTimeout(this.moodTimer);
    this.mood("work");
    this.say(pick(lines.busy));
    this.busyTimer = window.setInterval(() => this.say(pick(lines.busy)), 1700);
    try {
      return await task;
    } finally {
      clearInterval(this.busyTimer);
      this.busyTimer = undefined;
    }
  }
}

export const mascot = new Mascot();

// --- Toasts ---------------------------------------------------------------

const toastHost = h("div.toasts", { "aria-live": "polite" });

export function toast(text: string, kind: "ok" | "error" | "info" = "info"): void {
  if (!toastHost.isConnected) document.body.append(toastHost);
  const el = h(`div.toast.${kind}`, { role: kind === "error" ? "alert" : "status" }, text);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  }, kind === "error" ? 6000 : 3800);
}

export function celebrate(text = pick(lines.done), origin?: Element): void {
  mascot.flash("happy", text, 3000);
  confetti(origin);
}

/** Scrolls a freshly shown result into view. */
export function reveal(el: Element): void {
  requestAnimationFrame(() => el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" }));
}

export function oops(text: string): void {
  mascot.flash("eish", `Eish! ${text}`, 3600);
  toast(`Eish! ${text}`, "error");
}

// --- Confetti in flag colours ---------------------------------------------

const COLOURS = ["#007A4D", "#FFB612", "#DE3831", "#002395", "#ffffff", "#000000"];

export function confetti(origin?: Element): void {
  if (reducedMotion()) return;
  const canvas = h("canvas.confetti", { "aria-hidden": "true" });
  document.body.append(canvas);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const rect = origin?.getBoundingClientRect();
  const ox = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const oy = rect ? rect.top + rect.height / 2 : innerHeight / 3;
  const parts = Array.from({ length: 140 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 9;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 6,
      w: 6 + Math.random() * 7,
      h: 4 + Math.random() * 5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      c: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    };
  });

  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 2400);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < 2400) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
