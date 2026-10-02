import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the site works from any sub-path (e.g. GitHub Pages /eish-pdf/).
  base: "./",
  build: { target: "esnext" },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
