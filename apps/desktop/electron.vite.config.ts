import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const r = (p: string): string => resolve(__dirname, p);

// Flat layout (main / preload / renderer at the package root) matching the
// Phase-9 file plan, rather than electron-vite's default `src/` convention.
// main/preload build to CJS (no package "type":"module") — the robust default
// for a sandboxed preload; the renderer is ESM via Vite. Native deps + @sow/worker
// (spawned as the worker-host child, never imported at runtime here) stay
// externalized so their TS/native modules load from the workspace.
//
// BUT the pure `@sow/*` packages that main imports AT RUNTIME (today: `@sow/contracts`,
// via main/open-in-vault.ts's `ok/err/isOk`) must be BUNDLED, not externalized: Electron
// main's Node runtime does NOT activate the `sow-built` export condition (only the
// worker-host child sets `--conditions=sow-built`), so an externalized `@sow/contracts`
// resolves via `default` → raw `src/index.ts` → `require()` of TS → "Unexpected token
// 'export'" at load (the 9.18 regression; 9.12 introduced the first such runtime import).
// Excluding it from externalization makes Vite transpile + inline the pure TS at build
// time — no runtime `.ts` require. Keep native/`@sow/worker` external. See §5/§2.5.
const MAIN_BUNDLED_SOW = ["@sow/contracts"];
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: MAIN_BUNDLED_SOW })],
    build: {
      outDir: "out/main",
      lib: { entry: r("main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: r("preload/index.ts") },
    },
  },
  renderer: {
    root: r("."),
    resolve: {
      alias: { "@renderer": r("renderer") },
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: r("index.html") },
    },
    plugins: [react()],
  },
});
