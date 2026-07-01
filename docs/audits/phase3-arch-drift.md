# Phase 3 — Arch-Drift Audit

- **Gate:** `/phase-exit 3` · **Date:** 2026-07-01 · **Auditor:** `arch-drift-auditor`
- **Subject:** `packages/policy` (`@sow/policy`) @ HEAD `bc18914`.
- **Verdict: CLEAR** — 6 anchors audited, 30 statements checked · **0 DRIFT · 0 STALE-DOC · 1 AMBIGUOUS** (localConfig-optional; security gap effectively closed, routes to the Phase-7 broker contract, not a policy defect).
- **Gates:** 173/173 vitest green; `tsc --noEmit` clean.
- **Anchors:** §5 (PRIMARY) · §2.5 (DAG/import-direction) · §3 + Appendix A (frozen contracts consumed) · §7 (broker composition / egress-veto ordering) · §16 (error-handling/redaction).

## §5 — Policy, Security & Egress (PRIMARY) — VERIFIED

- **Four hard denials** exactly present (`denials.ts:21-26` HARD_DENIALS): EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED, DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL, UNTRUSTED_CONTENT_MUTATING_TOOL, WRITE_ADAPTER_OUTSIDE_GATEWAY.
- **Every decision (allow AND deny) carries an AuditSignal** (`decision.ts` — both variants declare `readonly audit`). Fail-closed default = MALFORMED_POLICY_INPUT.
- **Egress veto runs AFTER selection**, can only narrow/deny (`egress.ts` — `egressVeto(job, route, egress, workspace)` takes an already-selected route). Employer-Work + raw + ack=false ⇒ loopback-local only, **no cloud fallback**. Tunneled-'local' (egressClass=local but non-loopback endpoint) treated as egress — **VERIFIED-BY-TEST** (`adversarial-regressions.test.ts` #1, 21 tests). OpenRouter = its own processor, no aliasing.
- **Hard denial #2** (`visibility.ts` `denyDirectCrossWorkspaceRaw`) — all cross-workspace raw retrieval denied; sole exception a recorded Level-3 link.
- **Hard denial #3** (`admission.ts` `admitJob`) — ING-7 checks `!isTrusted && admitsMutating` before any downstream work. **`admitCandidateJob`** = composed gate: `validate()` (ajv) → `AgentJobSchema.safeParse` (Zod `.refine`) → `admitJob`. **Hard denial #4** (`denyWriteAdapterOutsideGateway`) typed DENY; structural enforcement via §2.5 import-direction.
- **Approval** fail-closed; auto-allow only private-personal `calendar` (`AUTO_ALLOW_ELIGIBLE_TARGETS = Set(["calendar"])`) — **VERIFIED-BY-TEST** (#3, 8 tests).
- **Session-auth** — CSPRNG per-launch mint (`randomBytes(32)`, not pid/port/time), constant-time verify (length guard + `timingSafeEqual`), strict Origin AND Host exact-match allowlist.
- **Redaction** — endpoint userinfo stripped to host-only `endpointHostRef` before audit refs — **VERIFIED-BY-TEST** (#2, 3 tests).
- **App-shell wiring (apps/worker guard, apps/desktop mint/inject)** — **DEFERRED (not drift)**, owner-approved → Phase 7/9, recorded in code (`session-auth.ts:22-24`) + plan + ADR-010.

## §2.5 · §3+Appendix A · §7 · §16 — VERIFIED

- **§2.5 import-direction:** `packages/policy` depends only on `@sow/contracts` + `@sow/domain` + `node:crypto` — no app/adapter/downstream imports. Policy sits `Sec[§5] → {§6,§7,§8}`.
- **§3 + Appendix A:** all 8 consumed models (EgressPolicy, ToolPolicy, AgentJob trust fields, AuditRecord, GclProjection, ProposedAction, ProviderMatrix, ProviderRoute) read by their frozen field names; **no redefinition, no field change**. `toAuditRecordInput` emits the frozen AuditRecord shape (`timestamps.occurredAt`).
- **§7:** egress veto composes AFTER provider selection over §3 contracts; §5 predicates are pure functions of the §3 trust fields.
- **§16:** every public function returns a typed `PolicyDecision` (never throws across a boundary); redaction layer (`looksUnsafe` = CREDENTIAL_PREFIX ∪ SENSITIVE_KEYWORD ∪ URL_USERINFO_CREDENTIAL) scans all content fields; prompts/raw payloads never enter an AuditSignal by construction.

## Recorded arch_gaps (not drift)

1. **`POLICY_DENIAL_HEALTH_CLASS`='policy_denial'** (`audit-signal.ts:19`) — the frozen `FailureClass` enum has no such member; a named constant is used instead of inventing an enum member (same pattern as Phase-2's `db_unavailable`). Carry-forward.
2. **`EGRESS_STATUS_HEALTH_CLASS`='egress_status'** (`egress.ts:46`) — REQ-S-002 wants the full allow/deny egress stream in System Health; a distinct class avoids mislabeling allows as denials. Carry-forward.

## Ambiguous (1)

- **§5 "local endpoints only through explicit local-provider config"** — `resolveRoute`'s `localConfig` is an OPTIONAL param; when omitted the explicit-config check is skipped. **No security regression** — `processorOfRoute`'s loopback proof still blocks arbitrary/remote URLs from being classified local (cloud provider ids never return null; non-loopback endpoints always return a processor). The spec's "only through explicit config" reading implies the configured set is always authoritative. **Routes to the Phase-7 broker contract:** the broker must always supply `localConfig` (or document why not). Not a policy-package defect — flag at the Phase-7 gate.

## Verdict

**CLEAR.** No unrecorded §5/§2.5/§3/§7/§16 drift; the two health-class constants are recorded carry-forwards, the app-wiring is an owner-approved deferment, and the single AMBIGUOUS item is a Phase-7 broker-contract decision with the security gap already closed in-code.
