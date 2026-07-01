# Phase 4 — §6 Knowledge — Security Review (phase-exit)

- **Subsystem:** `packages/knowledge` (`@sow/knowledge`) — 31 src modules + 31 test files
- **Reviewed at:** HEAD `84c3c7e` (fix commit for the 4 adversarial-verify findings)
- **Owns:** safety rule 1 (one writer / no hidden brain) — highest-stakes invariant
- **Reviewer:** security-reviewer subagent (phase-boundary dispatch, whole-subsystem surface)
- **Gates:** `pnpm --filter @sow/knowledge exec vitest run` → **PASS (346) FAIL (0)** · `tsc --noEmit` → **clean (exit 0)**

## Verdict: **CLEAR** (phase certifiable) — 1 MEDIUM auditability finding to track (non-blocking; runtime correct + fully tested)

All four prior adversarial-verify findings independently RE-DERIVED as genuinely closed. The
safety-critical serving/quarantine lens re-confirmed. General security pass surfaced ONE net-new
finding — an auditability/review-surface defect (embedded NUL → git-binary source files), not a
runtime vulnerability. No NEW critical/high. Nothing blocks certification.

---

## Invariant pass (safety rules 1 / 2 / 4 / 7 + write-through/divergence invariants)

| Invariant | Verdict | Basis |
|---|---|---|
| **Rule 1** — KnowledgeWriter sole autonomous Markdown writer; every semantic mutation via validated `KnowledgeMutationPlan`; DB-only fact quarantined | **PASS** | `writer.ts applyPlan` exposes no raw-write export; composed gate precedes any fs touch. `write-fence.ts` makes it PREVENTIVE (OS ACL + PGLite lock + write-capable-gbrain probe, default-deny/`unknown`→write_capable). `mcp-read-adapter.ts` structurally has no put/mutate op. `divergence-classifier.ts` db_only(non-edge)→hard floor→quarantine. |
| **Rule 2** — candidate-data gate = ajv ∘ Zod ∘ §3 (never ajv alone); no-inference | **PASS** | `writer.runGate` + `visibility-gate.admitProjection` + `generative-proposal-intake` + `remediation/router.materialize` all compose ajv+Zod+§3/§5; `validateNoInference` in intake. No side effect before the gate. |
| **Rule 4** — GCL Visibility Gate is the single cross-workspace read path; no raw cross-workspace retrieval absent an approved Level-3 link | **PASS** | `guardCrossWorkspaceRawRead` wraps §5 `denyDirectCrossWorkspaceRaw` (default-deny). `cross-workspace-links` requires recorded `approved` Approval, now honours expiry (finding #2). `serveProjection` re-gates on read (post-write tamper refused). Quarantine + serving keyed per-`workspaceId`. |
| **Rule 7** — HMAC signing key via SecretsPort only; blocking secret scan rejects (not redacts) | **PASS** | `provenance-stamp` resolves key by opaque ref, held only in local frame for one HMAC call, never in stamp/error/log; port-throw→typed `secret_unresolved`. `secret-scan` returns `secret_found` (reject, never sanitized bytes); typed error carries only path+fixed kind, path elided if credential-shaped. |
| **Write-through (i)** — bytes-from-Markdown serving, default-deny | **PASS** | `rehydration-gate.admitForServing` serves only re-hydrated committed-Markdown bytes; DB `dbBody` carried only to be provably ignored; 4-way AND (hash==canonical ∧ sig-valid ∧ in-allow-set ∧ not-quarantined) or withhold. |
| **Signed-provenance rebinding (iii)** — forged/borrowed/re-pointed stamp rejected | **PASS** | verify recomputes HMAC over the tuple INDEPENDENTLY re-derived from the allow-set (never the stamp's self-reported fields), length-prefixed + domain-separated preimage, constant-time compare. Borrowed stamp fails on mdContentSha; re-pointed fails on identity/originPath/workspaceId; forged fails on key. |
| **Quarantine = absence (content-independent, no resurrection)** | **PASS** | `quarantine-ledger` keyed on (`workspaceId`, content-independent `factIdentity`); `purged` stays serving-blocked so a 1-byte re-introduction hits the same key and cannot resurrect. |
| **Degraded coverage fail-closed (v)** | **PASS** | any non-green coverage leg OR unresolved signing key → `degraded_direct_markdown`, admits NOTHING through the DB path, discards partial admissions; `synthesisContext` empty in degraded mode. |

## Re-derivation of the 4 adversarial-verify fixes — all CLOSED

1. **fs-watch rollback lost-update** (`reconcile.ts`) — **CLOSED.** `matchesKwWrite` attributes a fresh `kw_write` ONLY to a matching pending entry OR the HEAD committed entry; a match to any SUPERSEDED (`committed.slice(0,-1)`) entry returns `stale:true` → `classify` emits `conflict / rollback_to_prior_kw_state` → base advance withheld + one `conflict_review` HealthItem. A rollback to ANY prior KW state (not just the immediate one) is a conflict, never a clean advance. Regression: `reconcile.test.ts:109`.
2. **GCL Level-3 link ignored `Approval.expiresAt`** (`cross-workspace-links.ts`) — **CLOSED.** `recordLink` rejects an already-expired approval (`approval_expired`, `expiresAt <= recordedAt`) and carries `expiresAt` onto the link. `linkActiveAt`: no-expiry→active; time-boxed with no `req.at`→INACTIVE (fail-closed); else `at < expiresAt`. `authorizeCrossWorkspaceRawRead` treats an expired/unverifiable link as no link → guard default-denies. An expired grant cannot cross raw content. Regression: `cross-workspace-links.test.ts:38`.
3. **GclProjection raw-content denylist** (`packages/contracts/.../gcl-projection.ts`) — **CLOSED.** `isRawContentShaped` is KEY-NAME-INDEPENDENT and RECURSIVE: rejects a denylisted key OR any string value that is multi-line (`/[\r\n]/`) or > 1024 chars, descending through nested objects + arrays. Raw content cannot ride an arbitrary/nested key. Regression: `contracts .../gcl-projection.test.ts:180` (nested-under-non-denylist-key). *Accepted design boundary (documented arch_gap): a single-line ≤1024-char value under an innocuous key is the intended sanitized-summary shape; full per-projectionType field-map enforcement is deferred to §5/§6 — informational, not a finding.*
4. **KnowledgeWriter fail-open defaults** (`writer.ts`) — **CLOSED.** `deps.ownershipCheck ?? enforceHumanOwnership` and `deps.secretScan ?? scanForSecrets` — the former no-op pass-throughs are gone. An uninjected caller now gets real KN-7 ownership enforcement + reject-not-redact secret scan (secure-by-default, still overridable). Regression: `writer.test.ts:61` ("secure-by-default gates").

## Serving / quarantine safety lens — CONFIRMED

A fact is admitted only under the full 4-way AND at the current revision — (A) rehydrated hash ==
CanonicalFactDeriver `mdContentSha`, (B) SignedProvenanceStamp verifies over the independently
re-derived tuple, (C) `factIdentity` ∈ the revision-scoped allow-set, (D) not quarantined — plus
workspace/revision-match wiring guards and fail-closed degrade. A forged, borrowed, or re-pointed
stamp is rejected (verify uses the allow-set tuple, never self-reported fields); a DB-only fact has
no committed bytes (withheld `not_in_allow_set`); a quarantined identity is withheld content-
independently. `mcp-read-adapter.containedSynthesis` refuses to run without caller-supplied,
already-gated context (no raw-store generative fallback).

---

## Findings by severity

### MEDIUM — 1 (track as Finding; non-blocking for certification)

- **[medium] Three safety-critical source files embed a literal NUL byte → git treats them as binary → their diffs are unreviewable.**
  - `packages/knowledge/src/knowledge-writer/revision.ts:32` (`` `${path}\x00${sha256(content)}` `` — the compare-revision precondition currency)
  - `packages/knowledge/src/gbrain/derive/canonical-fact-deriver.ts:111` (`const NUL = "\x00"` — the trust-root deriver / signed-mdContentSha source)
  - `packages/knowledge/src/gcl/cross-workspace-links.ts:107` (`` `${from}\x00${to}` `` — the rule-4 cross-workspace raw-crossing gate)
  - **Impact:** confirmed binary by `git diff --numstat` vs the empty tree (all three `- -`). `git diff`/`git show`/PR review/`git blame` produce NO line-level diff. Demonstrated concretely: the finding-#2 fix (a rule-4 Level-3 expiry gate) landed in `84c3c7e` as `Bin 8594 -> 10718 bytes` with ZERO reviewable diff — a safety-critical change merged without diff-based review. Additional risk: NUL-hostile editors/formatters/merge tools can silently corrupt these files, and binary files get all-or-nothing (no 3-way) merges in the multi-track worktree model.
  - **Not a runtime defect:** the NUL separators are functionally correct and collision-resistant (NUL cannot appear in Markdown/slug text); no hash-preimage or key-collision weakness. All 346 tests pass.
  - **Inconsistent with the codebase's own convention:** `quarantine-ledger.ts:61` and `provenance-stamp.ts:133` deliberately build the separator via `String.fromCharCode(0)` "so no control byte lands in source." Three files violate that established pattern.
  - **Action:** `fix-in-slice` — replace the three literal-NUL separators with `String.fromCharCode(0)` (behaviour-preserving; restores text + diff-reviewability). Surfaced to the orchestrator as a Finding to track; does not block Phase-4 certification.

### General security pass — CLEAN on all other axes

- **Input validation:** every boundary composes ajv + Zod `.parse` + §3/§5 predicates (Lesson §3); no ajv-alone gate; no side effect pre-validation. PASS.
- **Authorization:** cross-workspace default-deny; `GbrainReadGrant` re-verified read-only at construction (transport/scope/generativeCycle/federation/allowedOps ⊆ read surface) + per-call op gating. PASS.
- **Injection:** marker parser rejects unclosed/orphan/nested/mismatched/duplicate; region ids exclude whitespace + `>` (terminator cannot be absorbed); HMAC preimage is length-prefixed + domain-separated. No string-concat-to-system. PASS.
- **Reentrancy / races:** `atomicCommit` stage-then-rename with prior-byte rollback (all-or-nothing); compare-revision precondition; reconcile treats concurrent pending writes + rollbacks as conflict. PASS.
- **Info disclosure:** secret scan reject-not-redact, typed errors carry path+kind only (path elided if credential-shaped); audit records carry before/after SUMMARIES only, never raw content; signing key never logged. PASS.
- **Resource exhaustion (informational):** `isRawContentShaped` recurses over `sanitizedPayload` with no explicit depth cap; input is SoW-internally constructed and already ajv/JSON-parsed (practical depth bounded upstream), so DoS risk is marginal — noted, not a finding.

## Notes / limitations

- Phase-boundary dispatch: review surface is the whole `packages/knowledge` subsystem at `84c3c7e` (over-approximates the Phase-4 accumulated diff), plus the trust boundaries it crosses (KW write path, GCL cross-workspace read path, serving gate, gbrain runtime seam). Pre-existing surfaces in untouched packages are out of scope.
- `write-fence.ts` OS enforcement + `provenance-stamp` SecretsPort/Keychain wiring are explicitly DEFERRED to Phase 7 (apps/worker) by design — the in-package decision logic is fail-closed and fully fixture-tested; the real OS/Keychain facts must be wired at Phase 7 (noted, not a Phase-4 finding).
