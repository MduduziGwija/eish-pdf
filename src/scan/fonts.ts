// Open fonts shaped like the ones documents are printed (or written) in, used to
// redraw scanned text. Only downloaded when a scanned line is first redrawn, and
// then only the ones worth trying for that scan.
// Vite needs the list written out: these are the families listed in FAMILIES below.
const FILES = import.meta.glob("/node_modules/@fontsource/{tinos,caladea,gelasio,eb-garamond,libre-baskerville,pt-serif,crimson-text,old-standard-tt,roboto-slab,arimo,carlito,dejavu-sans,open-sans,roboto,lato,source-sans-3,montserrat,libre-franklin,archivo-narrow,pt-sans,cousine,courier-prime,special-elite,caveat,kalam,patrick-hand,architects-daughter,indie-flower,shadows-into-light,gochi-hand,just-another-hand,nanum-pen-script,reenie-beanie,nothing-you-could-do,homemade-apple,cedarville-cursive,dancing-script,satisfy,la-belle-aurore}/files/*-latin-{400,700}-{normal,italic}.woff2", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type Generic = "serif" | "sans" | "mono" | "hand";

export interface Family {
  /** CSS family name used on the canvas. */
  css: string;
  /** What people would call it. */
  label: string;
  generic: Generic;
  /** Font files: regular, italic, bold, bold italic (missing ones are drawn without). */
  files: { regular: string; italic?: string; bold?: string; boldItalic?: string };
}

function family(id: string, label: string, generic: Generic): Family {
  const file = (style: string) => FILES[`/node_modules/@fontsource/${id}/files/${id}-latin-${style}.woff2`];
  const regular = file("400-normal");
  if (!regular) throw new Error(`Font files for ${id} are missing.`);
  return { css: `EishScan ${id}`, label, generic, files: { regular, italic: file("400-italic"), bold: file("700-normal"), boldItalic: file("700-italic") } };
}

export const FAMILIES: Family[] = [
  family("tinos", "Times New Roman", "serif"),
  family("caladea", "Cambria", "serif"),
  family("gelasio", "Georgia", "serif"),
  family("eb-garamond", "Garamond", "serif"),
  family("libre-baskerville", "Baskerville / Book Antiqua", "serif"),
  family("pt-serif", "PT Serif / Palatino style", "serif"),
  family("crimson-text", "Minion / book serif", "serif"),
  family("old-standard-tt", "Century / old print", "serif"),
  family("roboto-slab", "Rockwell / slab serif", "serif"),
  family("arimo", "Arial / Helvetica", "sans"),
  family("carlito", "Calibri", "sans"),
  family("dejavu-sans", "Verdana / Tahoma", "sans"),
  family("open-sans", "Segoe UI / Open Sans", "sans"),
  family("roboto", "Roboto", "sans"),
  family("lato", "Lato", "sans"),
  family("source-sans-3", "Myriad / Source Sans", "sans"),
  family("montserrat", "Century Gothic / Montserrat", "sans"),
  family("libre-franklin", "Franklin Gothic", "sans"),
  family("archivo-narrow", "Arial Narrow", "sans"),
  family("pt-sans", "PT Sans / Trebuchet style", "sans"),
  family("cousine", "Courier New", "mono"),
  family("courier-prime", "Courier (typewriter)", "mono"),
  family("special-elite", "Worn typewriter", "mono"),
  family("caveat", "Casual handwriting (Caveat)", "hand"),
  family("kalam", "Neat handwriting (Kalam)", "hand"),
  family("patrick-hand", "Printed handwriting (Patrick Hand)", "hand"),
  family("architects-daughter", "Block capitals handwriting", "hand"),
  family("indie-flower", "Rounded handwriting (Indie Flower)", "hand"),
  family("shadows-into-light", "Light pen handwriting", "hand"),
  family("gochi-hand", "Marker handwriting (Gochi Hand)", "hand"),
  family("just-another-hand", "Narrow handwriting", "hand"),
  family("nanum-pen-script", "Quick pen handwriting", "hand"),
  family("reenie-beanie", "Scrawled handwriting", "hand"),
  family("nothing-you-could-do", "Scribbled handwriting", "hand"),
  family("homemade-apple", "Joined handwriting (Homemade Apple)", "hand"),
  family("cedarville-cursive", "School cursive", "hand"),
  family("dancing-script", "Flowing cursive (Dancing Script)", "hand"),
  family("satisfy", "Bold cursive (Satisfy)", "hand"),
  family("la-belle-aurore", "Elegant cursive (La Belle Aurore)", "hand"),
];

/** One font per kind of writing, tried first to see which kinds are worth a closer look. */
export const SCOUTS = ["tinos", "arimo", "cousine", "patrick-hand", "caveat", "homemade-apple"].map((id) => FAMILIES.find((f) => f.css === `EishScan ${id}`)!);

export const GENERIC_LABELS: Record<Generic, string> = { serif: "Serif (like Times)", sans: "Sans (like Arial)", mono: "Typewriter", hand: "Handwriting" };

export interface Face {
  family: Family;
  bold: boolean;
  italic: boolean;
}

export const cssFont = (face: Face, px: number) => `${face.italic ? "italic " : ""}${face.bold ? "700" : "400"} ${px}px "${face.family.css}"`;

/** The styles a family really has (handwriting usually has just one). */
export function facesOf(family: Family): Face[] {
  const { italic, bold, boldItalic } = family.files;
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
  const url = (face.bold && face.italic ? files.boldItalic : face.bold ? files.bold : face.italic ? files.italic : undefined) ?? files.regular;
  const key = `${face.family.css}/${face.bold}/${face.italic}`;
  let ready = loaded.get(key);
  if (!ready) {
    const font = new FontFace(face.family.css, `url(${url}) format("woff2")`, { weight: face.bold ? "700" : "400", style: face.italic ? "italic" : "normal" });
    ready = font.load().then((f) => void document.fonts.add(f));
    ready.catch(() => loaded.delete(key));
    loaded.set(key, ready);
  }
  return ready;
}

/** The family to use when someone picks a generic family in the format bar. */
export const familyFor = (generic: Generic): Family => FAMILIES.find((f) => f.generic === generic)!;

export const familyByCss = (css: string): Family | undefined => FAMILIES.find((f) => f.css === css);
