// Transpiles the thin worker-host ENTRY to runnable ESM for main to spawn (9.4b).
//
// The entry is a single file that imports @sow/worker. `--packages=external`
// externalizes @sow/* AND all node_modules — they are resolved at RUNTIME: the
// child runs with `--conditions=sow-built` (so @sow/* resolve to their built `dist/`
// JS) plus the resolve-loader (so those packages' extensionless ESM imports get a
// `.js`). So this build only transpiles the entry's own TS; nothing is inlined.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, "worker-host/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  outfile: resolve(here, "out/worker/desktop-host.mjs"),
  logLevel: "warning",
});
