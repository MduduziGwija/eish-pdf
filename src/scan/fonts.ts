// Open fonts shaped like the ones most documents are printed in, used to redraw
// scanned text. Each is metric-compatible with (or close to) a common font.
// They're only downloaded when a scanned line is first redrawn.
import tinos400 from "@fontsource/tinos/files/tinos-latin-400-normal.woff2?url";
import tinos400i from "@fontsource/tinos/files/tinos-latin-400-italic.woff2?url";
import tinos700 from "@fontsource/tinos/files/tinos-latin-700-normal.woff2?url";
import tinos700i from "@fontsource/tinos/files/tinos-latin-700-italic.woff2?url";
import arimo400 from "@fontsource/arimo/files/arimo-latin-400-normal.woff2?url";
import arimo400i from "@fontsource/arimo/files/arimo-latin-400-italic.woff2?url";
import arimo700 from "@fontsource/arimo/files/arimo-latin-700-normal.woff2?url";
import arimo700i from "@fontsource/arimo/files/arimo-latin-700-italic.woff2?url";
import cousine400 from "@fontsource/cousine/files/cousine-latin-400-normal.woff2?url";
import cousine400i from "@fontsource/cousine/files/cousine-latin-400-italic.woff2?url";
import cousine700 from "@fontsource/cousine/files/cousine-latin-700-normal.woff2?url";
import cousine700i from "@fontsource/cousine/files/cousine-latin-700-italic.woff2?url";
import carlito400 from "@fontsource/carlito/files/carlito-latin-400-normal.woff2?url";
import carlito400i from "@fontsource/carlito/files/carlito-latin-400-italic.woff2?url";
import carlito700 from "@fontsource/carlito/files/carlito-latin-700-normal.woff2?url";
import carlito700i from "@fontsource/carlito/files/carlito-latin-700-italic.woff2?url";
import gelasio400 from "@fontsource/gelasio/files/gelasio-latin-400-normal.woff2?url";
import gelasio400i from "@fontsource/gelasio/files/gelasio-latin-400-italic.woff2?url";
import gelasio700 from "@fontsource/gelasio/files/gelasio-latin-700-normal.woff2?url";
import gelasio700i from "@fontsource/gelasio/files/gelasio-latin-700-italic.woff2?url";
import caladea400 from "@fontsource/caladea/files/caladea-latin-400-normal.woff2?url";
import caladea400i from "@fontsource/caladea/files/caladea-latin-400-italic.woff2?url";
import caladea700 from "@fontsource/caladea/files/caladea-latin-700-normal.woff2?url";
import caladea700i from "@fontsource/caladea/files/caladea-latin-700-italic.woff2?url";
import dejavu400 from "@fontsource/dejavu-sans/files/dejavu-sans-latin-400-normal.woff2?url";
import dejavu400i from "@fontsource/dejavu-sans/files/dejavu-sans-latin-400-italic.woff2?url";
import dejavu700 from "@fontsource/dejavu-sans/files/dejavu-sans-latin-700-normal.woff2?url";
import dejavu700i from "@fontsource/dejavu-sans/files/dejavu-sans-latin-700-italic.woff2?url";

export type Generic = "sans" | "serif" | "mono";

export interface Family {
  /** CSS family name used on the canvas. */
  css: string;
  /** What people would call it. */
  label: string;
  generic: Generic;
  /** [regular, italic, bold, bold italic] */
  files: [string, string, string, string];
}

export const FAMILIES: Family[] = [
  { css: "EishScan Tinos", label: "Times New Roman", generic: "serif", files: [tinos400, tinos400i, tinos700, tinos700i] },
  { css: "EishScan Arimo", label: "Arial / Helvetica", generic: "sans", files: [arimo400, arimo400i, arimo700, arimo700i] },
  { css: "EishScan Carlito", label: "Calibri", generic: "sans", files: [carlito400, carlito400i, carlito700, carlito700i] },
  { css: "EishScan Caladea", label: "Cambria", generic: "serif", files: [caladea400, caladea400i, caladea700, caladea700i] },
  { css: "EishScan Gelasio", label: "Georgia", generic: "serif", files: [gelasio400, gelasio400i, gelasio700, gelasio700i] },
  { css: "EishScan DejaVu", label: "Verdana / DejaVu Sans", generic: "sans", files: [dejavu400, dejavu400i, dejavu700, dejavu700i] },
  { css: "EishScan Cousine", label: "Courier (typewriter)", generic: "mono", files: [cousine400, cousine400i, cousine700, cousine700i] },
];

export interface Face {
  family: Family;
  bold: boolean;
  italic: boolean;
}

export const cssFont = (face: Face, px: number) => `${face.italic ? "italic " : ""}${face.bold ? "700" : "400"} ${px}px "${face.family.css}"`;

const loaded = new Map<string, Promise<void>>();

/** Downloads one face (once) so the canvas can draw with it. */
export function loadFace(face: Face): Promise<void> {
  const index = (face.bold ? 2 : 0) + (face.italic ? 1 : 0);
  const key = `${face.family.css}/${index}`;
  let ready = loaded.get(key);
  if (!ready) {
    const font = new FontFace(face.family.css, `url(${face.family.files[index]}) format("woff2")`, { weight: face.bold ? "700" : "400", style: face.italic ? "italic" : "normal" });
    ready = font.load().then((f) => void document.fonts.add(f));
    ready.catch(() => loaded.delete(key));
    loaded.set(key, ready);
  }
  return ready;
}

/** The family to use when someone picks a generic family in the format bar. */
export const familyFor = (generic: Generic): Family => FAMILIES.find((f) => f.generic === generic)!;
