// A minimal Node module-resolution hook for the SPAWNED worker child only.
//
// The @sow/* packages are authored bundler-style (extensionless relative imports)
// and built structure-preserving via tsc (so their `import.meta.url`-relative data
// files — JSON Schemas, SQL — still resolve). The emitted ESM therefore carries
// extensionless specifiers that Node's ESM resolver rejects on its own. This hook
// appends the missing `.js` (or `/index.js`). It is passed to the child via
// --import and NEVER touches the dev toolchain (Vite/vitest resolve extensionless
// themselves). Bare specifiers (node builtins, node_modules, @sow/* package roots)
// are untouched — those resolve normally, @sow/* via the `sow-built` condition.
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
