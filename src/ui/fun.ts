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

const MASCOT_SVG = `
<svg class="mascot-svg" viewBox="0 -30 120 170" aria-hidden="true">
  <ellipse class="m-shadow" cx="60" cy="134" rx="34" ry="5"/>
  <g class="m-body">
    <path class="m-page" d="M22 8h54l26 26v86a12 12 0 0 1-12 12H22a12 12 0 0 1-12-12V20A12 12 0 0 1 22 8z"/>
    <path class="m-fold" d="M76 8v18a8 8 0 0 0 8 8h18z"/>
    <rect class="m-band" x="10" y="98" width="92" height="9"/>
    <g class="m-eyes">
      <ellipse class="m-eye" cx="42" cy="62" rx="7" ry="9"/>
      <ellipse class="m-eye" cx="74" cy="62" rx="7" ry="9"/>
      <circle class="m-glint" cx="44.5" cy="58.5" r="2.4"/>
      <circle class="m-glint" cx="76.5" cy="58.5" r="2.4"/>
    </g>
    <path class="m-brow" d="M33 47l15 5M83 47l-15 5"/>
    <circle class="m-cheek" cx="30" cy="78" r="5.5"/>
    <circle class="m-cheek" cx="86" cy="78" r="5.5"/>
    <path class="m-mouth m-smile" d="M48 80q10 9 20 0"/>
    <ellipse class="m-mouth m-o" cx="58" cy="83" rx="7" ry="8"/>
    <path class="m-mouth m-flat" d="M47 85q11-6 22 0"/>
    <path class="m-mouth m-grin" d="M44 78h28q-2 14-14 14t-14-14z"/>
    <path class="m-sweat" d="M95 40q5 8 0 12q-5-4 0-12z"/>
    <g class="m-glasses">
      <circle cx="42" cy="62" r="12"/>
      <circle cx="74" cy="62" r="12"/>
      <path d="M54 61q4-4 8 0M30 60l-12-4M86 60l12-4"/>
    </g>
    <g class="m-hat">
      <path class="m-hat-brim" d="M21 14Q60 25 99 14L114 34Q60 54 6 34Z"/>
      <path class="m-hat-stitch" d="M13 31Q60 48 107 31M17 25Q60 40 103 25"/>
      <path class="m-hat-crown" d="M23 17C22-9 38-25 60-25S98-9 97 17Q60 27 23 17Z"/>
      <path class="m-hat-stitch" d="M33 9C33-9 45-19 60-19S87-9 87 9M43 4C43-6 50-13 60-13S77-6 77 4"/>
      <path class="m-hat-band" d="M24 8Q60 18 96 8L97 17Q60 27 23 17Z"/>
    </g>
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
    this.el.addEventListener("click", () => {
      if (this.busyTimer) return;
      replay(this.el, "poked");
      this.flash("eish", pick(lines.poke), 1400);
    });
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
