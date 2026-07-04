// EVAL-1 corpus stamper (tasks 12.2/12.3). Recomputes each corpus manifest's
// contentHash + entryCount from its entries.json, preserving the human-set
// corpusId/version/floor. Run after editing any corpus:
//
//   node packages/evals/scripts/stamp-corpora.mjs
//
// The canonical hash MUST match src/harness/corpus-loader.ts::corpusContentHash
// (the single source of truth). This script only replicates it for convenience;
// test/corpora/corpora-floors.test.ts re-verifies every corpus through the real
// `loadCorpus`, so any drift between this script and the loader fails there.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "corpora");

function canonicalize(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out = {};
  for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = canonicalize(v[k]);
  return out;
}
function corpusContentHash(corpusId, version, entries) {
  const pre = JSON.stringify(canonicalize({ corpusId, version, entries }));
  return `sha256:${createHash("sha256").update(pre, "utf8").digest("hex")}`;
}

let stamped = 0;
for (const kind of readdirSync(CORPORA, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = resolve(CORPORA, kind.name);
  const entriesPath = resolve(dir, "entries.json");
  const manifestPath = resolve(dir, "manifest.json");
  if (!existsSync(entriesPath) || !existsSync(manifestPath)) continue;
  const entries = JSON.parse(readFileSync(entriesPath, "utf8"));
  const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = {
    corpusId: prev.corpusId,
    version: prev.version,
    contentHash: corpusContentHash(prev.corpusId, prev.version, entries),
    entryCount: entries.length,
    floor: prev.floor,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`stamped ${kind.name}: ${manifest.entryCount} entries, ${manifest.contentHash}`);
  stamped += 1;
}
console.log(`\n${stamped} corpora stamped.`);
