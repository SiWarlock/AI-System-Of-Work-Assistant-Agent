// Node module-resolution hook for the `sow-doctor` BIN.
//
// The @sow/* packages are authored bundler-style (extensionless relative imports) and built
// structure-preserving via tsc (so their `import.meta.url`-relative data files — JSON Schemas,
// SQL — still resolve). The emitted ESM therefore carries extensionless specifiers that Node's
// ESM resolver rejects on its own. This hook appends the missing `.js` (or `/index.js`).
//
// ⛔ WHY THIS EXISTS SEPARATELY FROM THE WORKER-HOST ONE, and it is a real defect it fixes:
// `apps/desktop/worker-host/resolve-loader.mjs` is byte-identical in behaviour, but it is passed
// ONLY to the FORKED worker child (`execArgv: ["--conditions=sow-built", "--import", loaderPath]`,
// `worker-supervisor.ts`). The `sow-doctor` bin is a PLAIN `node dist/install/bin/doctor.js` with
// NEITHER the condition NOR the loader — so it died at module load with
// `ERR_MODULE_NOT_FOUND: .../dist/install/probe-adapters` and had NEVER been runnable.
//
// ⚠ DUPLICATION IS ACKNOWLEDGED, NOT OVERLOOKED. Two copies of a 20-line resolver is a drift
// risk (`contracts L39` — one definition per rule). It is duplicated rather than shared because
// the desktop copy's own header scopes it "for the SPAWNED worker child only", and importing
// across the package boundary at RUNTIME is exactly the fragility this hook exists to work
// around. Single-sourcing it is filed as its own task; behaviour is identical today and the two
// must be changed together until then.
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExt = /\.[cm]?js$|\.json$|\.node$/i.test(specifier);
  if (isRelative && !hasExt) {
    try {
      return await nextResolve(specifier + ".js", context);
    } catch {
      return await nextResolve(specifier + "/index.js", context);
    }
  }
  return nextResolve(specifier, context);
}
