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
export * from "./knowledge-writer/revision";
export * from "./knowledge-writer/ownership";
export * from "./knowledge-writer/secret-scan";
export * from "./knowledge-writer/provenance-stamp";
export * from "./knowledge-writer/writer";
export * from "./knowledge-writer/gbrain-sync-trigger";
export * from "./knowledge-writer/sync-outbox";
export * from "./knowledge-writer/tombstone";

// ── fs-watch: out-of-band writer detection + reconciliation ─────────────────────
export * from "./fs-watch/vault-watcher";
export * from "./fs-watch/reconcile";

// ── gbrain: read/query-only adapter + index sync/rebuild/version-pin/write-fence ─
export * from "./gbrain/mcp-read-adapter";
export * from "./gbrain/index-sync";
export * from "./gbrain/rebuild";
export * from "./gbrain/version-pin";
export * from "./gbrain/write-fence";

// ── gbrain derive: the gbrain-independent CanonicalFactDeriver (parity reference) ─
export * from "./gbrain/derive/canonical-fact-deriver";

// ── gbrain parity: divergence classification + reconciliation ───────────────────
export * from "./gbrain/parity";
export * from "./gbrain/parity/divergence-classifier";
export * from "./gbrain/parity/reconciler";

// ── gbrain serving: quarantine ledger + Markdown-rehydration serving gate ───────
export * from "./gbrain/serving/quarantine-ledger";
export * from "./gbrain/serving/rehydration-gate";

// ── gbrain remediation: generative proposal intake + terminal-directive router ──
export * from "./gbrain/remediation/generative-proposal-intake";
export * from "./gbrain/remediation/router";

// ── gbrain enablement: write-through flag + crash-recovery reconciler ───────────
export * from "./gbrain/enablement/write-through-flag";
export * from "./gbrain/enablement/crash-recovery-reconciler";

// ── gcl: Visibility Gate + projection + cross-workspace links + global reconcile ─
export * from "./gcl/visibility-gate";
export * from "./gcl/projection";
export * from "./gcl/cross-workspace-links";
export * from "./gcl/global-markdown-reconcile";
