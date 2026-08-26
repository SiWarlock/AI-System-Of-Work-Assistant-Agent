// @sow/knowledge — the knowledge track of §6: KnowledgeWriter (the provably-sole
// autonomous semantic Markdown writer, safety rule 1), the markdown-vault atomic
// primitives, the fs-watch out-of-band reconciler, the GBrain read/query adapter +
// the 7-invariant write-through/divergence/serving/remediation/enablement layer,
// and the GCL Visibility Gate.
//
// FULL public barrel (Synthesis). Modules are otherwise imported by direct relative
// path, and tests import the module under test directly. Four generic names collided
// across modules and were renamed AT SOURCE so every symbol is barrel-reachable:
//   gbrain/parity.ts            RemediationRequest → ParityRemediationRequest
//   gbrain/parity/reconciler.ts DbProjection       → ReconcilerDbProjection
//   gbrain/parity/reconciler.ts ReconcileDeps      → ReconcilerDeps
//   gbrain/parity/reconciler.ts ReconcileOutcome   → ReconcilerOutcome

// ── markdown-vault: atomic all-or-nothing commit primitive + section model ──────
export * from "./markdown-vault/atomic-write";
export * from "./markdown-vault/sections";

// ── knowledge-writer: the provably-sole writer + its ordered commit gates ───────
// The frontmatter format codec (write-side serialize + its read-side inverse) — `readFrontmatterField`
// is the deterministic core of gate 1's `readNoteProjectId`. parseNote/composeNote stay writer-internal.
export {
  serializeScalar,
  deserializeScalar,
  readFrontmatterField,
  KW_STAMP_FRONTMATTER_KEY,
} from "./knowledge-writer/frontmatter";
export * from "./knowledge-writer/revision";
export * from "./knowledge-writer/ownership";
export * from "./knowledge-writer/secret-scan";
export * from "./knowledge-writer/provenance-stamp";
export * from "./knowledge-writer/writer";
export * from "./knowledge-writer/gbrain-sync-trigger";
export * from "./knowledge-writer/sync-outbox";
export * from "./knowledge-writer/tombstone";
// The workspace-path gate (24.12) — applyPlan's third ordered predicate, alongside `ownership` and
// `secret-scan` above — exported NARROWLY, by name, and still deliberately so after 24.26 completed:
//   • `makeEnforceWorkspacePathScope` is what a composition root needs; `KnowledgeWriterDeps
//     .workspacePathCheck` is REQUIRED (24.26 step 3), so without this line a consumer's only option
//     would be a hand-rolled predicate — a second implementation of the very fact 24.26 single-sourced.
//   • ⛔ STILL NOT `export *`. The original reason is now historical (it would have published
//     `LEGACY_UNPREFIXED_WORKSPACE_ID`, which step 3 deleted), but the rule survives its rationale:
//     `export *` would publish `SOURCE_NOTE_SUBTREE`, a value duplicated from `apps/worker` as DATA
//     and not a symbol any consumer should bind. Widen this line only for something a composition
//     root must actually construct.
export { makeEnforceWorkspacePathScope } from "./knowledge-writer/workspace-path-guard";

// ── fs-watch: out-of-band writer detection + reconciliation ─────────────────────
export * from "./fs-watch/vault-watcher";
export * from "./fs-watch/reconcile";

// ── gbrain: read/query-only adapter + index sync/rebuild/version-pin/write-fence ─
export * from "./gbrain/mcp-read-adapter";
export * from "./gbrain/index-sync";
export * from "./gbrain/rebuild";
export * from "./gbrain/version-pin";
export * from "./gbrain/startup-verify";
export * from "./gbrain/gbrain-version-probe";
export * from "./gbrain/write-fence";

// ── gbrain local-embed: local-zero-egress RRF retrieval primitive (13.3a) ───────
export * from "./gbrain/local-embed";

// ── gbrain rerank: deterministic local retrieval re-ranker (13.17) ──────────────
export * from "./gbrain/rerank";

// ── synthesis: living-vault synthesis primitives (ARC-4 §13.8) ──────────────────
// `faithfulKey`/`entitySlug` live in `./synthesis/match-keys` (internal — the ONE shared
// faithful-match discipline both primitives ground on; not re-exported, Lesson 17).
export * from "./synthesis/entity-resolver";
export * from "./synthesis/link-healer";
export * from "./synthesis/planner";
export * from "./synthesis/ingest-rewrite";
export * from "./synthesis/research-propagation";
export * from "./synthesis/meeting-rewrite";
export * from "./synthesis/attendee-refs";
export * from "./synthesis/grounded-path";
export * from "./markdown-vault/structural-files";

// ── gbrain derive: the gbrain-independent CanonicalFactDeriver (parity reference) ─
export * from "./gbrain/derive/canonical-fact-deriver";

// ── gbrain parity: divergence classification + reconciliation ───────────────────
export * from "./gbrain/parity";
export * from "./gbrain/parity/divergence-classifier";
export * from "./gbrain/parity/reconciler";

// ── gbrain serving: quarantine ledger + Markdown-rehydration serving gate ───────
export * from "./gbrain/serving/quarantine-ledger";
export * from "./gbrain/serving/rehydration-gate";
export * from "./gbrain/serving/vault-rehydrate";

// ── gbrain remediation: generative proposal intake + terminal-directive router ──
export * from "./gbrain/remediation/generative-proposal-intake";
export * from "./gbrain/remediation/router";

// ── gbrain enablement: write-through flag + crash-recovery reconciler ───────────
export * from "./gbrain/enablement/write-through-flag";
export * from "./gbrain/enablement/crash-recovery-reconciler";
export * from "./gbrain/enablement/decide-enablement";

// ── gcl: Visibility Gate + projection + cross-workspace links + global reconcile ─
// ⛔ `./gcl/visibility-gate` and `./gcl/cross-workspace-links` are NOT re-exported (24.78 Part 1),
// applying the bar this file already states at the workspace-path line above: *widen only for
// something a composition root must actually construct.* NOTHING here met it.
// EVIDENCE — measured by the providers-integrations track (24.65 → 24.78) and CITED, not re-derived,
// so a second measurement cannot disagree with the first for uninteresting reasons: ZERO importers of
// all 16 symbols outside `packages/knowledge`; every external hit was a comment, classified
// individually. `CrossWorkspaceLinkMap` is constructed ONLY in
// `packages/knowledge/test/cross-workspace-links.test.ts` (17 sites), never in production.
//
// ⛔⛔ THE REASON IS *NOT* THAT THIS MAKES THE GCL HAZARD UNREPRESENTABLE — that justification was
// asserted in the task text, in the brief, and in a ruling, and it is FALSE. `package.json` declares a
// `"./*"` WILDCARD SUBPATH EXPORT, so `@sow/knowledge/gcl/visibility-gate` stays importable after this
// edit.
// ⚠ COUNT CORRECTED WHILE SCOPING `### 24.78` (this comment first said "3 files deep-import today"):
// it is TWO — `packages/evals/test/gbrain-failclosed.test.ts` and
// `packages/workflows/src/activities/projections/noteSlug.ts`. The apparent third,
// `packages/evals/test/osb/anti-corruption.test.ts:77`, is a STRING LITERAL in a `realImports` array
// asserting the write-surface scanner trips on deep subpaths — a test that DEFENDS against this,
// counted as one committing it. Population-by-spelling: grouped by the text `@sow/knowledge/` rather
// than by *is it an import*.
// ⭐ AND THE SHARPER MEASUREMENT: **ZERO of them import `@sow/knowledge/gcl/*` at all.** The wildcard
// is CAPABLE of serving the GCL modules; nothing uses it to. So the surface this comment is about has
// no consumer — which is what makes a `./gcl/*`-only deny possible without breaking anyone (`### 24.78`).
// ⇒ THE ACTUAL REASON: this removes the path taken BY ACCIDENT (a barrel symbol in scope for anyone who
// imports the package at all) while leaving the path taken BY INTENT (a deliberate deep import).
// Different risk profiles, and only one of them happens by mistake.
// ⚠ The wildcard fence is `### 24.78`'s own Done-when and is deliberately NOT absorbed here: narrowing
// `./*` breaks 3 live deep-importers across two packages, which is its own scoped change.
export * from "./gcl/projection";
export * from "./gcl/global-markdown-reconcile";
