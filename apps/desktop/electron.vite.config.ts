import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const r = (p: string): string => resolve(__dirname, p);

// Flat layout (main / preload / renderer at the package root) matching the
// Phase-9 file plan, rather than electron-vite's default `src/` convention.
// main/preload build to CJS (no package "type":"module") — the robust default
// for a sandboxed preload; the renderer is ESM via Vite. @sow/* + native deps
// are externalized so the worker's TS/native modules load from the workspace.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
