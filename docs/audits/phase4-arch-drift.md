# Phase 4 — Arch-Drift Audit

- **Gate:** `/phase-exit 4` · **Date:** 2026-07-01 · **Auditor:** `arch-drift-auditor`
- **Subject:** `packages/knowledge` (`@sow/knowledge`) @ HEAD `84c3c7e`.
- **Verdict: CLEAR** — 13 anchor groups audited (§6 KN-4/9/7/8, §6 fs-watch+reconcile, the §6 seven-invariant write-through layer, §6 GCL Visibility Gate, §3 candidate-data gate + no-inference, §16, Appendix A) · **0 DRIFT · 0 STALE-DOC · 0 AMBIGUOUS**.
- **Gates:** 346/346 knowledge tests green; 18/18 gcl-projection contract tests green (field-set snapshot UNCHANGED — the refine tightening is refine-layer only, not emitted to JSON Schema); `tsc --noEmit` clean.

## Anchor verdicts — all CLEAR

- **§6 KN-4/KN-9 sole writer** — `writer.ts` exposes only `applyPlan`, no raw-write export.
- **§6 KN-7/KN-8** — human-owned sections preserved (`ownership.ts` — 4 rejection conditions; untargeted assistant regions byte-stable); blocking secret scan rejects (never redacts).
- **§6 out-of-band reconciliation** — `reconcile.ts` classifies every mutation via positive KW attribution; unattributed change / new assistant-domain file → conflict-review, never a silent lost update.
- **§6 write-through 7 invariants** — (i) bytes-from-Markdown serving (`rehydration-gate.ts` — DB is pointer/ranking only, never a byte source); (ii) gbrain-INDEPENDENT `CanonicalFactDeriver` (gbrain out of its own checker's trust base); (iii) HMAC `SignedProvenanceStamp` via SecretsPort + serve-time content rebinding; (iv) revision-scoped allow-set, quarantine=absence (VERIFIED-BY-TEST: parity-reconciler 12/12, quarantine-ledger 11/11); (v) default-deny ServingGate (served only if rehydrated AND sig-valid AND in-allow-set AND not-quarantined); (vi) propose-only generative path (dream/autopilot hard-disabled, requiresApproval forced true); (vii) enablement gate (writeThroughEnabled default OFF, flips ON only on the 4 GO conditions).
- **§6 GBrain read/query-only** — `mcp-read-adapter.ts` read-only grant verified at construction; only `GbrainAllowedOp` invocable.
- **§6 GCL Visibility Gate** — the single cross-workspace read path; direct cross-brain raw retrieval denied.
- **§3** — composed candidate-data gate (ajv → Zod → `ruleScopedMutation`) on every boundary; no-inference (`validateNoInference`) on the generative path.
- **§16** — every cross-subsystem op returns a typed Result; secret-scan rejection carries only path + fixed kind (matched value never in the error).
- **Appendix A** — all 9 new knowledge models + the amended KnowledgeMutationPlan (`+provenanceOrigin`/`gbrainProposalRef?`/`signedProvenanceStamp?`) + GbrainPin.writeThroughEnabled default false — frozen + exercised (346 tests).

## The 4 adversarial-verify fixes — all CONFIRMED in code

- **fs-watch rollback** (`reconcile.ts:224-249`) — `matchesKwWrite` attributes only a pending or HEAD-committed hit as clean; a stale (superseded) committed hit → `class:"conflict", reason:"rollback_to_prior_kw_state"`.
- **GCL Level-3 link expiry** (`cross-workspace-links.ts`) — `linkActiveAt()` fails closed without `at`; record-time expiry check; `authorize` calls `linkActiveAt(link, req.at)`.
- **GclProjection KEY-NAME-INDEPENDENT refine** (`gcl-projection.ts:22-48,95`) — `carriesRawContent` recursive scan, `MAX_SUMMARY_VALUE_LEN=1024`; 18/18 contract tests green; JSON-schema + field-set snapshot UNCHANGED.
- **KnowledgeWriter secure-by-default** (`writer.ts:158-171`) — ownership/secret-scan default to the real `enforceHumanOwnership`/`scanForSecrets`, not pass-through.

## Findings

- **DRIFT / STALE-DOC / AMBIGUOUS: none.**
- **Implementation note (not a finding):** `secret-scan.ts` maps a secret-scan rejection to the `schema_rejection` `HealthItem.failureClass` (in the Appendix-A closed set); the in-code `arch_gap` comment about a possible dedicated `secret_scan_rejected` member is a developer note, not a spec violation. No action.
- **§6 OS-level one-writer lockdown (REQ-S-NEW-008, task 4.19)** — the `write-fence.ts` pure decision logic is present; the apps/worker filesystem-ACL / mount / continuous-scan wiring is the **owner-approved Phase-7 deferment** (not drift).

## Verdict

**CLEAR.** No §3/§6/§16/Appendix-A drift; all four adversarial-verify fixes confirmed; the write-through safety invariants hold.
