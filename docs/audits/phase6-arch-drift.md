# Phase 6 — Arch-Drift Audit

- **Gate:** `/phase-exit 6` · **Date:** 2026-07-01 · **Auditor:** `arch-drift-auditor`
- **Subject:** `packages/integrations` (`@sow/integrations`) @ working tree (uncommitted at audit time).
- **Verdict: CLEAR** — 9 anchor groups audited (§8, §3, §5, §16, §9, §15, Appendix A, + the 3 adversarial-verify fixes) · **0 DRIFT · 2 STALE-DOC · 1 AMBIGUOUS**.
- **Gates:** 150/150 integrations tests green (19 files); `tsc --noEmit` clean.

## Anchor verdicts — all VERIFIED

- **§8 Connector Gateway** — unreachable → bounded exponential backoff + degraded + OBS-2 signal, no silent drop (`connectors/gateway.ts` + `backoff.ts` + `health.ts`); cursor advances ONLY after the consumer handles the page (no lost update); `auth_locked` → held-retryable (no in-pass retry); reconnect drain deduped by `contentHash`; every diagnostic routed through `buildSafeConnectorLog`.
- **§8 Tool Gateway** — `dispatchExternalWrite` is the SOLE external-write entry (§5 fourth denial); mandatory pre-write existence check in fixed order (idempotencyKey replay → canonicalObjectKey prior-receipt → live vendor probe; a live-probe fault → hold, never create); approval-before-dispatch; precondition mismatch → typed conflict, never a blind overwrite; every dispatch records an AuditRecord (payloadHash + refs + summaries only) + a persisted receipt; logs never carry raw payload.
- **§8 adapters** — 9 connector read adapters + 7 tool write adapters present; MCP connectors (Linear/Asana/Granola) treat a network fault as `unreachable` (remote vendor branch); SourceEnvelope registered BEFORE extraction with a `contentHash` dedupe no-op; no workspaceId inference (blank → gate rejection, REQ-F-017).
- **§8 NotebookPort** — Drive-backed 00–04 managed-doc upsert through the gateway; missing/unlinked source → typed `reattach_required`; direct NotebookLM API out of scope (§15).
- **§3** — every external write carries non-empty `canonicalObjectKey` + `idempotencyKey`; the candidate-gate is the ajv + Zod + §3-rules composition (LESSONS §3, never ajv alone) + the `envelopeMatchesAction` linkage pin; `payloadHash` is replay-stable.
- **§5** — no write adapter reachable outside the gateway envelope; approval predicate injected (pure §5 verdict).
- **§16** — redaction strips credential shapes (incl. Google `AIza…` + URL/query-param secrets) and DROPS raw content/payload fields before any sink; OBS-2 signals on connector-unreachable + blocked write-through; every op returns a typed Result, never throws.
- **§9** — `drainOutbox(outbox, deps)` is a clean deps-injected §9/Temporal entry-point; re-drives via the SAME dispatch pipeline (existence check + replay gate → no duplicate create); crash mid-drain re-drives idempotently (terminals excluded by `listDue`).
- **Appendix A** — ExternalWriteEnvelope / ProposedAction / WriteReceipt / SourceEnvelope / NotebookMapping model shapes match the frozen Phase-1 contracts (imported unchanged).

## The 3 adversarial-verify fixes — all CONFIRMED in code

- **No-duplicate-write under concurrency** (`gateway.ts` step 3.5 + `ports/persistence.ts` `ReceiptStore.reserve`/`release`) — an atomic reservation on `(targetSystem, canonicalObjectKey)` sits BETWEEN the existence check and `adapter.create`; only the `reserved` winner creates (`committed` → reused, `in_progress` → held); a create fault calls `release`; the old post-create-only guard is gone. Regression: `test/tool-gateway-race.test.ts` (interleaved → exactly one create).
- **Redaction breadth** (`redaction/gateway-log-redaction.ts`) — Google `AIza…` + URL/query-credential-param detection & scrubbing (+ AWS/GCS SigV4 `X-Amz-*`/`X-Goog-Signature` from the security review's L-1). Regression: `test/gateway-redaction-credentials.test.ts`.
- **Hold-through-outage caller** (`notebook/notebooklm-sync.ts`) — a held (unreachable, non-reattach) Drive write is enqueued via `holdWrite` when an outbox is wired; `NotebookSyncResult.heldForRetry` surfaces it. Regression in `test/notebook-sync.test.ts`.

## Findings

- **DRIFT: none.**
- **STALE-DOC 1** — the auditor flagged `ExternalWriteEnvelope` missing `approvalId?`, but the canonical Appendix A row (`ARCHITECTURE.md:417`) ALREADY lists it (the auditor read the §2.5 model-name freeze list, not the field table). No canonical drift. The `contracts/CLAUDE.md` cross-doc NOTE column was tightened to name `approvalId?` for completeness.
- **STALE-DOC 2** — `GatewayHealthSignal.severity` is an open string (default `warn`); §8 names no closed severity for a gateway health *signal*. Documented arch_gap: the Phase-7/§9 HealthItem materializer owns the closed severity taxonomy. No code change (carry-forward).
- **AMBIGUOUS 1** — per-target `canonicalObjectKey` identity shapes are placeholder (`IdentityDeriver` injected per adapter); §8 does not pin per-target identity structure. Acknowledged arch_gap; pins at Phase-7 / adapter wiring (carry-forward).

## Verdict

**CLEAR.** No §8/§3/§5/§16/§9/Appendix-A drift; all three adversarial-verify fixes confirmed real; the no-duplicate-write + no-silent-drop + redaction invariants hold. 2 STALE-DOC (1 fixed, 1 documented arch_gap) + 1 AMBIGUOUS carry forward.
