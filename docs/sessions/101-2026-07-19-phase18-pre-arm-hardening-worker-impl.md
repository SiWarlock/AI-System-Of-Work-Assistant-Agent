# Session 101 — Phase-18 pre-ARM hardening (worker-impl): shadowing-env guard · multi-task frontmatter · auto-ingest verify-and-pin

- **Date:** 2026-07-19
- **Phase:** 18 (§19.5 real ModelProvider / subscription crossing) — post-GO-LIVE hardening round, all dormant / pre-ARM
- **Role:** worker-impl (implementer), team `session-4f4687dd`, single-track `main`
- **Predecessor:** [`100-2026-07-18-phase-exit-18-crossing-gate-orch.md`](100-2026-07-18-phase-exit-18-crossing-gate-orch.md) (the `/phase-exit 18` crossing gate → CLEAR + 3 Carry-forward findings)
- **Successor:** [`102-2026-07-20-phase18-autoingest-arm-worker.md`](102-2026-07-20-phase18-autoingest-arm-worker.md) (18.31 egress-allowlist seam + 18.33 committed L64 armed dry-run go/no-go)

## Why this session existed

The `/phase-exit 18` crossing gate came back CLEAR but routed **3 non-blocking findings** to Carry-forward, plus the GO-LIVE maiden run left a quality follow-up. The orchestrator scoped a focused hardening round (3 slices) to burn them down **before** the eventual owner-gated auto-ingest ARM (18.10) — all dormant, nothing armed/run/spent:

- **18.28** — resolve the crossing-gate **security-MEDIUM**: the armed-boot shadowing-env guard omitted several egress-redirect vars.
- **18.29** — the **note-projection alignment** Carry-forward: the maiden run's task-prefixed multi-task extraction degraded to blanket `TBD/TBD` in the source note frontmatter.
- **18.30** — a **pre-ARM verify-and-pin** assurance pass over the already-built-dormant auto-ingest trigger.

## What was built

### Files modified

- **`apps/worker/src/composition/subscription-auth-guard.ts`** (18.28) — extended `SUBSCRIPTION_SHADOWING_ENV_KEYS` from 8 → **13** vars: added `ANTHROPIC_CUSTOM_HEADERS`, lowercase `http_proxy`/`https_proxy`, and `ALL_PROXY`/`all_proxy`. The `some()` guard body is UNCHANGED (L61). Doc comment rewritten (now-enumerated wording, `NO_PROXY`-exclusion rationale, legacy fault-name note, `NODE_EXTRA_CA_CERTS` flip-verify note); kept the `apiKeyHelper` out-of-band caveat.
- **`apps/worker/test/composition/subscription-auth-guard.test.ts`** (18.28) — extended `FULL_SHADOWING_SET` to the 13-var exact-set pin + per-var fail-closed loop; fixed the "8 vars" count-drift comment.
- **`apps/worker/test/composition/subscription-extraction-arming.test.ts`** (18.28) — new `armed_boot_degrades_on_lowercase_proxy` boot-side degrade pin (proves a newly-added var flows the whole `resolveSubscriptionArming` degrade path, not just the guard unit).
- **`apps/worker/src/composition/buildActivities.ts`** (18.29) — generalized the source-note frontmatter projection (`sourceBuildOutputs.build`) from the fixed `["owner","dueDate"]` loop to a **strict pattern allow-list**: bare `owner`/`dueDate` (backward-compat) ∪ `^task\d+_(owner|dueDate)$`, ascending numeric-task-index order, defensive cap 50 with a visible unforgeable `tasksTruncated:true` sentinel. Injection-resistant by construction (anchored `^…$`, key reconstructed from the ASCII `\d+` capture, every value neutralized).
- **`apps/worker/test/composition/realSourceCommit.test.ts`** (18.29) — 8 tests (multi-task project, hostile/arbitrary-keys-never-land incl. a `fields`-supplied `tasksTruncated`, absent→TBD, bare byte-equivalent, marker-neutralized, path-unchanged, deterministic ascending order, cap+sentinel).
- **`apps/worker/test/composition/egress-veto-assembled.test.ts`** (18.30) — appended 3 `source.process` assurance pins at the assembled root (`assembleBackends(...).broker.runJob`): (1) untrusted+mutating ⇒ `admission`/`UNTRUSTED_CONTENT_MUTATING_TOOL`; (2) untrusted+read_only+employer-raw+ack-OFF+cloud`{runtime}` ⇒ `egress_veto`/`EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` (+healthClass parity); (3) ack-ON non-vacuity control ⇒ resolves past veto to the dormant stub. **No production change.**

### Commits

- **18.28** `6ebe07a8` — `fix(worker): shadowing-env guard full grounded set — close crossing-gate security-MEDIUM`
- **18.29** `31fc3383` — `feat(worker): multi-task source-note frontmatter projection (note-projection alignment)`
- **18.30** `9eb9dd99` — `test(worker): auto-ingest dormant trigger pre-ARM verify-and-pin (assembled-root safety ties)`

## Decisions made

- **18.28 — 13-var set, both proxy cases + `all_proxy`** (Q1 vote (b), orch-approved). Asymmetric risk: a watched var the SDK doesn't honor only spuriously DEGRADES the owner-gated armed path (re-verified at flip); a missed var/case is a silent fail-OPEN (redirected egress). Node/undici + `proxy-from-env` honor lowercase + `all_proxy`. `NO_PROXY`/`no_proxy` **deliberately EXCLUDED** (a bypass allowlist, not a redirect — watching it would false-positive-degrade a legit config; documented in-code so it isn't "helpfully" re-added). Legacy fault code `anthropic_key_set_on_armed_path` kept (rename = contract ripple).
- **18.29 — shape (A) flat task-keys + strict pattern allow-list; Q3 union (bare always emitted); Q2 cap 50 + VISIBLE `tasksTruncated` sentinel** (orch-approved). Kept the projection INLINE (no new helper/file). A pure multi-task source keeps the honest bare `owner:TBD/dueDate:TBD` pair (preserves the existing frontmatter key contract; no invention).
- **18.30 — confirm-vs-fill split** (orch-approved): CITE (not re-add) the solid pins — gateAutoIngest OFF/L28, L37 both-path, the ING-7 source **unit** pin; FILL the genuine gap by tying **both** gates (ING-7 admission + rule-5 veto) to the `source.process` capability at the **assembled root** (L50) with a hostile input. Added the assembled-ING-7 tie (orch's call) so both gates are assembled-root-pinned, not asymmetric (one assembled + one unit).

## Decisions explicitly NOT made (deferred)

- **18.28 — `NODE_EXTRA_CA_CERTS` not added to the watched set.** A TLS-interception ENABLER (redirects nothing on its own; only matters with an already-watched proxy var). Captured as a re-verify-at-flip note in-code, deferred per the security reviewer.
- **18.29 — leading-zero index variants each consume a cap slot** (`task1_`/`task01_`). Bounded + honestly deduped-by-digit-string; collapsing leading zeros would silently merge distinct keys (worse). Deferred as a Carry-forward LOW.
- **18.30 — desktop leg (`SOW_INGEST_WATCH` read in `apps/desktop`) SKIPPED** (lead+orch confirmed) — desktop territory; the worker `opts.autoIngest !== true` chokepoint (L28) re-gates its output regardless. Not touched.
- **The auto-ingest ARM (18.10) itself** — out of scope; owner-gated. This round only proves the seam safe.

## TDD compliance

**Clean.**
- 18.28 + 18.29: failing tests written FIRST (18.28 = 3 RED against the 8-var source; 18.29 = 6 RED against the fixed-key loop, + 2 safety pins green-throughout), then GREEN.
- 18.30: a **verify-and-pin / assurance** slice — the 3 pins characterize *existing-safe* behavior over the real assembled gates (pass-on-write, the correct pattern for a pin, not RED→GREEN). A failing pin would have been a **Finding** (a real dormant-safety hole), not a test-fix — none surfaced.

## Cross-doc invariants

**No change.** No Appendix-A / frozen seam-model field was added/removed/renamed this session: 18.28 = a worker-internal composition constant; 18.29 reads the existing OPEN `agent_extraction` / `ValidatedExtraction.fields` record (no field change); 18.30 = test-only. No `ARCHITECTURE.md` seam edit owed.

## Reachability

- **18.28** — `SUBSCRIPTION_SHADOWING_ENV_KEYS` → `assertSubscriptionAuthEnv` → `resolveSubscriptionArming` (armed-boot degrade path). Constant-only extension; the existing call site is unchanged (reachable e2e per `docs/audits/18-crossing-reachability-worker.md`). The armed path itself stays reachability-WAIVERED (L11) until the owner ENABLE — unchanged by this slice.
- **18.29** — the projection runs inside `sourceBuildOutputs.build`, already wired on the source-ingestion run leg → validated KMP → sole KnowledgeWriter `applyPlan`. Shape change only; call site unchanged.
- **18.30** — test-only; exercises the real assembled `broker.runJob` gates (admitJob + veto). No new production wiring.

No tested-but-unwired gaps introduced.

## Open follow-ups (Step-9 routed hot — orchestrator territory, ride `/orchestrate-end`)

- **LESSONS (orchestrator writes):** worker **L65** (18.28 — full grounded shadowing/redirect env set, both proxy cases, NO_PROXY-exclusion, over-inclusion-fail-safe; extends L61/L62), **L66** (18.29 — fixed-key → strict-pattern frontmatter allow-list still injection-resistant; extends L49), **L67** (18.30 — pre-ARM assurance convention: confirm OFF/guard/exclusion pins + tie the downstream safety gates to the trigger's dispatch path at the assembled root with a hostile input).
- **Carry-forward:** delete the "Note-projection ↔ extraction-schema field-name alignment" bullet (RESOLVED by 18.29); mark the runbook `phase-18-subscription-enable-decision.md` CHECKPOINT-1 shadowing-env enumeration **RESOLVED** (residual = live-docs re-verify at flip + reconsider TLS-interception enablers); log the 18.29 leading-zero cap-slot LOW as a small defer.
- **Plan/Log ticks (orchestrator):** 18.28 / 18.29 / 18.30 with their hashes; briefs 142/143/144 on disk.

## Notes

- Every slice: TDD (or assurance pin) → mandatory `security-reviewer` + every-slice `code-quality-reviewer` → per-file staging (never `-A`, never orchestrator territory) → graphify update. All review lows resolved or justified in-slice. **security 0 crit/high/med across all 3 slices; 18.30 NO Finding (dormant seam proven safe at the assembled root).**
- Nothing armed, run, or spent — all dormant / pre-ARM hardening. No push (owner-run at round close).
