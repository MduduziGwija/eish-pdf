// Fonts used to redraw scanned text: a few hundred open fonts bundled with the
// site (see fontlist.ts, made by scripts/gen-scan-fonts.mjs), plus any fonts the
// person lets us use from their own computer or uploads. Only the fonts worth
// trying for a scan are downloaded, and only when a scanned line is first redrawn.
import { FONT_ROWS, FONT_URLS, type Kind } from "./fontlist";

/** What kind of writing a font is. "mine" = from this computer or an uploaded file. */
export type Generic = Kind | "mine";

export interface Family {
  /** CSS family name used on the canvas. */
  css: string;
  /** What people would call it. */
  label: string;
  generic: Generic;
  /** Font files: regular, italic, bold, bold italic (missing ones are drawn without). Empty for fonts already on this computer. */
  files: { regular?: string; italic?: string; bold?: string; boldItalic?: string };
}

const url = (id: string, style: string) => FONT_URLS[`/node_modules/@fontsource/${id}/files/${id}-latin-${style}.woff2`];

const BUNDLED: Family[] = FONT_ROWS.map((r) => ({
  css: `EishScan ${r.id}`,
  label: r.label,
  generic: r.kind,
  files: { regular: url(r.id, "400-normal"), italic: url(r.id, "400-italic"), bold: url(r.id, "700-normal"), boldItalic: url(r.id, "700-italic") },
}));

/** Fonts from this computer or uploaded files (added while the app runs). */
const mine: Family[] = [];

/** Every font that can be tried: bundled ones first. */
export const allFamilies = (): Family[] => [...BUNDLED, ...mine];
export const bundledFamilies = (): Family[] => BUNDLED;
export const myFamilies = (): Family[] => mine;

/** One font per kind of writing, tried first to see which kinds are worth a closer look. */
const SCOUT_IDS = ["tinos", "arimo", "cousine", "patrick-hand", "caveat", "homemade-apple", "bebas-neue"];
export const SCOUTS: Family[] = SCOUT_IDS.map((id) => BUNDLED.find((f) => f.css === `EishScan ${id}`)).filter((f): f is Family => !!f);

export const GENERIC_LABELS: Record<Generic, string> = {
  serif: "Serif (like Times)",
  sans: "Sans (like Arial)",
  mono: "Typewriter",
  hand: "Handwriting",
  display: "Headline / decorative",
  mine: "From this computer",
};

export interface Face {
  family: Family;
  bold: boolean;
  italic: boolean;
}

export const cssFont = (face: Face, px: number) => `${face.italic ? "italic " : ""}${face.bold ? "700" : "400"} ${px}px "${face.family.css}"`;

/** The styles a family really has (handwriting usually has just one). */
export function facesOf(family: Family): Face[] {
  const { italic, bold, boldItalic } = family.files;
  if (family.generic === "mine") {
    return [
      { family, bold: false, italic: false },
      { family, bold: false, italic: true },
      { family, bold: true, italic: false },
      { family, bold: true, italic: true },
    ];
  }
  return [
    { family, bold: false, italic: false },
    ...(italic ? [{ family, bold: false, italic: true }] : []),
    ...(bold ? [{ family, bold: true, italic: false }] : []),
    ...(boldItalic ? [{ family, bold: true, italic: true }] : []),
  ];
}

const loaded = new Map<string, Promise<void>>();

/** Downloads one face (once) so the canvas can draw with it. Missing styles fall back to regular. */
export function loadFace(face: Face): Promise<void> {
  const { files } = face.family;
  const file = (face.bold && face.italic ? files.boldItalic : face.bold ? files.bold : face.italic ? files.italic : undefined) ?? files.regular;
  // Fonts already on this computer (or uploaded earlier) need no download.
  if (!file) return Promise.resolve();
  const key = `${face.family.css}/${face.bold}/${face.italic}`;
  let ready = loaded.get(key);
  if (!ready) {
    const font = new FontFace(face.family.css, `url(${file}) format("woff2")`, { weight: face.bold ? "700" : "400", style: face.italic ? "italic" : "normal" });
    ready = font.load().then((f) => void document.fonts.add(f));
    ready.catch(() => loaded.delete(key));
    loaded.set(key, ready);
  }
  return ready;
}

/** Downloads many faces, a few at a time, calling `onProgress` (0–1) as they arrive. Failures are skipped. */
export async function loadFaces(faces: Face[], onProgress?: (done: number) => void, parallel = 8): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < faces.length) {
      const face = faces[next++];
      await loadFace(face).catch(() => undefined);
      onProgress?.(++done / faces.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, faces.length) }, worker));
}

/** The family to use when someone picks a generic family in the format bar. */
export const familyFor = (generic: Generic): Family => BUNDLED.find((f) => f.generic === generic) ?? BUNDLED[0];

export const familyByCss = (css: string): Family | undefined => allFamilies().find((f) => f.css === css);

// --- Fonts from this computer --------------------------------------------------

interface LocalFontData {
  family: string;
}

/** Whether the browser can list the fonts installed on this computer (Chrome and Edge). */
export const canUseLocalFonts = () => typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === "function";

/**
 * Asks permission to list the fonts installed on this computer and adds them.
 * Nothing is uploaded: the page only uses the names, and draws with the installed fonts.
 * Returns how many families were added.
 */
export async function addLocalFonts(): Promise<number> {
  const query = (window as unknown as { queryLocalFonts: () => Promise<LocalFontData[]> }).queryLocalFonts;
  const fonts = await query.call(window);
  const have = new Set(mine.map((f) => f.css));
  let added = 0;
  for (const name of new Set(fonts.map((f) => f.family))) {
    if (have.has(name)) continue;
    mine.push({ css: name, label: name, generic: "mine", files: {} });
    added++;
  }
  return added;
}

let uploads = 0;

/** Adds a font file (.ttf, .otf, .woff, .woff2) the person chose. */
export async function addFontFile(file: File): Promise<Family> {
  const css = `EishScan upload ${++uploads}`;
  const font = new FontFace(css, await file.arrayBuffer());
  await font.load();
  document.fonts.add(font);
  const family: Family = { css, label: `${file.name.replace(/\.[^.]+$/, "")} (uploaded)`, generic: "mine", files: {} };
  mine.push(family);
  return family;
}
