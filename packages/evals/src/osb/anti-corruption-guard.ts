// @sow/evals — OSB anti-corruption write-path conformance guard (Phase-13 §13.1 gate a).
//
// The deterministic, non-HITL structural enforcer of the OSB inheritance's one governing
// rule: source extractors emit CANDIDATE DATA and NEVER write (safety rule 1 — one writer,
// KN-4/KN-9; §6 KnowledgeWriter is the provably-sole autonomous Markdown writer; §8 the
// SourceIngestionPort `registerSource` is the ONLY sanctioned durable boundary an extractor
// touches). `scanForWriteSurfaces` statically scans the OSB source-extractor family (and a
// future `vendor/osb/**` tree) for FORBIDDEN write-surface tokens — any `@sow/knowledge`
// sole-writer import, a `node:fs` write op, `createFsVault`, an atomic-vault-commit, or a
// Tool-Gateway external-write. A clean emit-only adapter has ZERO violations; the caller
// (the conformance test) pins the scan non-vacuous via `scannedCount` + a hardcoded count.
//
// PURE + TOTAL (§16): no I/O of its own — the caller supplies file contents (the test reads
// the real repo source). Deterministic; never throws.
//
// INTENT (the rule the breadth enforces): a `*-source.ts` adapter does ZERO local fs I/O and
// makes ZERO write-surface reference — it is a pure emit-only MAPPER. Any real fetch /
// transcription / temp-file staging lives in the INJECTED transport (the deferred, separately
// reviewed "REAL-EXTRACTOR INJECTION POINT"), which is NOT a `*-source.ts` file and is not this
// layer. So forbidding all fs writes in the adapter is correct, not over-broad. SCOPE: this guard
// models the Markdown / fs-vault / Tool-Gateway write surface only; out-of-model vectors
// (`child_process`, a `@sow/db` DB-only fact) are other guards' concern + the runtime one-writer
// invariant is the real backstop — this is a defense-in-depth static tripwire. SCAN SURFACE: the
// guard's live conformance test scans the ENTIRE Connector Gateway read edge — every
// `connectors/adapters/*.ts` except the `index.ts` barrel (see `isConnectorAdapterScanFile`),
// covering the extractors + the vault read surface + the connector adapters + `base.ts` — all
// write-free by architecture (the external-WRITE Tool-Gateway adapters live in the SEPARATE
// `tools/adapters/` tree, correctly out of scope). Count-pinned so a moved/renamed/new adapter
// forces a deliberate bump. Further refinements (a code-derived registry from `adapters/index.ts`
// exports rather than a directory glob; folding the connector-CORE `port`/`gateway`/`transport`
// files — which write operational cursors via a repo port, NOT Markdown, so they're outside the
// write-surface threat model) are named follow-ups.

/**
 * One forbidden write-surface entry: a human-readable `token` label + the `pattern` that
 * detects it. Path/symbol tokens use a plain substring; the short/generic fs-op identifiers
 * use a WORD-BOUNDARY pattern so prose ("transform", "renamed", "filename") never
 * false-positives. Every entry's `token` string is itself a match for its `pattern` (the
 * data-driven detection test relies on this).
 */
export interface WriteSurfaceToken {
  readonly token: string;
  readonly pattern: RegExp;
}

/**
 * The denylist — the write surfaces an OSB extractor must NEVER reach. Empirically verified
 * 0-false-positive against the shipped `*-source.ts` adapters, and it does NOT match the
 * sanctioned emit-only tokens (`registerSource`/`RegisterSourceInput`/`payloadHash`/
 * `@sow/contracts` type imports/read-only `readFile`/`readdir`). NOTE: the sole-writer token
 * is the IMPORT PATH `@sow/knowledge`, never the bare word `KnowledgeWriter` — the clean
 * adapters mention "KnowledgeWriter (the sole writer)" in prose, which must not trip the guard.
 */
export const WRITE_SURFACE_TOKENS: ReadonlyArray<WriteSurfaceToken> = [
  // sole-writer package + its atomic vault-commit primitives (§6, safety rule 1). The
  // `knowledge-writer` path token also catches a deep RELATIVE import of the writer module that
  // would evade the `@sow/knowledge` package specifier.
  { token: "@sow/knowledge", pattern: /@sow\/knowledge/ },
  { token: "knowledge-writer", pattern: /knowledge-writer/ },
  { token: "markdown-vault", pattern: /markdown-vault/ },
  { token: "atomic-write", pattern: /atomic-write/ },
  { token: "commitAtomically", pattern: /\bcommitAtomically\b/ },
  // the fs vault write factory (the worker's canonical-Markdown write surface).
  { token: "createFsVault", pattern: /\bcreateFsVault\b/ },
  // node:fs / fs/promises write + copy + truncate + link ops — word-boundary so prose can't
  // false-positive (verified 0-FP against the live adapters, incl. their standalone prose "link").
  { token: "writeFile", pattern: /\bwriteFile(Sync)?\b/ },
  { token: "appendFile", pattern: /\bappendFile(Sync)?\b/ },
  { token: "copyFile", pattern: /\bcopyFile(Sync)?\b/ },
  { token: "cp(", pattern: /\bcp(Sync)?\(/ },
  { token: "createWriteStream", pattern: /\bcreateWriteStream\b/ },
  { token: "writev", pattern: /\bwritev(Sync)?\b/ },
  { token: "truncate", pattern: /\b(f)?truncate(Sync)?\b/ },
  { token: "mkdir", pattern: /\bmkdir(Sync)?\b/ },
  { token: "rename", pattern: /\brename(Sync)?\b/ },
  { token: "rm", pattern: /\brm(dir|Sync)?\b/ },
  { token: "unlink", pattern: /\bunlink(Sync)?\b/ },
  { token: "symlink", pattern: /\bsymlink(Sync)?\b/ },
  // hard-link + generic write-handle call — call-form (`(`) so prose "link"/"write" can't fire.
  { token: "link(", pattern: /\blink(Sync)?\(/ },
  { token: ".write(", pattern: /\.write(Sync)?\(/ },
  // Tool-Gateway external-write surface (§8) — extractors are read/emit-only, not writers.
  { token: "ExternalWriteEnvelope", pattern: /\bExternalWriteEnvelope\b/ },
  { token: "tools/adapters", pattern: /tools\/adapters/ },
];

/** One detected write-surface reference: which forbidden `token`, in which `path`, on which 1-based `line`. */
export interface WriteSurfaceViolation {
  readonly path: string;
  readonly token: string;
  readonly line: number;
}

/** The scan outcome — the violations found + how many files were scanned (the non-vacuity guard). */
export interface WriteSurfaceScanResult {
  readonly violations: ReadonlyArray<WriteSurfaceViolation>;
  readonly scannedCount: number;
}

/**
 * Scan file contents for forbidden write-surface tokens. Deterministic, no I/O — the caller
 * supplies `{ path, content }` (the conformance test reads the real `*-source.ts` sources).
 * Reports every `{ path, token, line }` hit; `scannedCount` is the file count so the caller
 * can assert the scan is non-vacuous (an empty / mis-globbed surface never masquerades as
 * "no violations"). Never throws.
 */
export function scanForWriteSurfaces(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): WriteSurfaceScanResult {
  const violations: WriteSurfaceViolation[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const entry of WRITE_SURFACE_TOKENS) {
        if (entry.pattern.test(line)) {
          violations.push({ path: file.path, token: entry.token, line: i + 1 });
        }
      }
    }
  }
  return { violations, scannedCount: files.length };
}

/**
 * The live scan-surface predicate: a file in `packages/integrations/src/connectors/adapters/` is part
 * of the guard's scan surface IFF it is a `.ts` adapter and NOT the `index.ts` re-export barrel. This
 * selects the ENTIRE Connector Gateway read edge (extractors + the vault read surface + the connector
 * adapters + `base.ts`) — all write-free by architecture. PURE (a filename predicate — no I/O; the
 * conformance test owns the `readdirSync`). The count-pin backstops its edges: a stray `.d.ts` /
 * `.test.ts` landing in the dir would bump the scanned count → a deliberate review.
 */
export function isConnectorAdapterScanFile(filename: string): boolean {
  return filename.endsWith(".ts") && filename !== "index.ts";
}
