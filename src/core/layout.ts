// Text-box layout shared by the engine and the editor preview (no MuPDF here,
// so the UI can import it without loading the engine).

/** Line height as a multiple of font size. */
export const LINE_HEIGHT = 1.16;

/** Baseline of line `i` in a text box whose top edge is `top`. */
export const baselineOf = (top: number, size: number, i: number) => top + 2 + size * (0.9 + i * LINE_HEIGHT);
