# /tdd brief — install_doctor_check_engine (Phase 11.5 — deterministic core)

## Feature
The deterministic core of the install doctor/repair command (Phase 11.5): a pure `runDoctor(snapshot) → DoctorReport` engine + per-check diagnosers that map an injected per-check probe outcome to a typed `DoctorCheckResult` carrying an explicit failure variant + a **distinct** repair step, plus the safety-critical **write-through one-writer posture** checks (vault ACL / gbrain read-only-mount / stray-gbrain-process). The engine is PURE over an injected `ProbeSnapshot`; the REAL OS/boot probe collectors (which touch the unbuilt 11.1/11.3/11.4 boot, Keychain, gbrain) are the deferred follow-up (bucket B). This opens Phase 11 (the largest unstarted deliverable) with its non-gated logic core, mirroring the project's core-first / wire-later pattern (oracle-core, G1e-2 loader).

## Use case + traceability
- **Task ID:** 11.5 (Install doctor / repair command — typed prerequisite checks). Plan `IMPLEMENTATION_PLAN.md:1776-1785`.
- **Architecture sections it implements:** `ARCHITECTURE.md §13` (install/packaging — the doctor/repair command) + `§4` (FileVault at-rest control prerequisite; canonical-vault ACL) + `§16` (backup-and-recovery contract — the git-remote-OR-local-backup-acceptance rule) + safety rule **1 (One writer / no hidden brain)** + **REQ-S-NEW-008** (write-through one-writer posture: vault-ACL / read-only-mount / stray-process probe). Implementer confirms the exact §13 install-doctor anchor at Step 0 (`/check-arch install` or `doctor`).
- **Related context:** the existing typed-failure primitives `failure()`/`FailureVariant`/`FailureVariantKind` (`packages/contracts/src/primitives/failure.ts:72/:37`); `FailureClass` (`shared-enums.ts:118`); the Phase-10 System Health / `HealthItem` surface (the doctor's findings may later map onto health items — NOT this slice); `checkVersionPin` (`packages/knowledge/src/gbrain/version-pin.ts:137`) as the 11.3 pin-probe the doctor consumes as an outcome (not re-implemented here). Pattern refs: the Phase-7 pure-driver-over-injected-ports style + the G1e-2 injected-seam-⇒-degrade-if-unbound dormancy.

## Scope boundary (what's IN vs deferred)
- **IN (this slice, deterministic, non-gated):** the typed `DoctorReport`/`DoctorCheckResult` contract; `runDoctor(snapshot)`; per-check diagnosers for all named checks (node-pnpm, filevault, keychain, temporal-startable, gbrain-startable, loopback-ports, git-remotes, **vault-acl, gbrain-readonly-mount, stray-gbrain-process**); distinct repair messages; idempotency-as-purity; fail-closed defaults.
- **DEFERRED (bucket B, later slice — record, don't build):** the REAL probe collectors (OS calls: `diskutil apfs`/FileVault, Keychain reachability, port bind, `git remote`, gbrain `--version`/`doctor --json`, filesystem ACL stat, mount flags, `ps`/process scan) that PRODUCE the `ProbeSnapshot`; the CLI/boot **repair command** that calls `runDoctor` (11.1/11.6). The engine is unreachable-by-design until that command lands (documented waiver, as with the oracle-core / G1e-2 loader).

## Acceptance criteria (what "done" means)
- [ ] NEW `packages/contracts/src/install/doctor-result.ts` — a typed `DoctorReport` (ordered per-check `DoctorCheckResult[]` + an overall roll-up) and `DoctorCheckResult` = a discriminated `{ check, status: "ok" | "finding" | "degraded", failureVariant?, repair? }` where a non-`ok` result ALWAYS carries a distinct `repair` step. **Local `install/` operational result — additive, NOT an Appendix-A frozen seam** (like `UiSafe*` / prior `install/*`): no `__snapshots__`, no registry, no cross-doc round. (If the implementer finds it must be a frozen seam → Step-9 cross-doc flag, do not silently freeze.)
- [ ] `runDoctor(snapshot: ProbeSnapshot) → DoctorReport` is PURE (no I/O, no clock, no throw): same snapshot ⇒ same report. Every named check (node-pnpm, filevault, keychain, temporal-startable, gbrain-startable, loopback-ports, git-remotes, vault-acl, gbrain-readonly-mount, stray-gbrain-process) appears in the report.
- [ ] **Distinct repair per variant (no catch-all):** FileVault-off, Keychain-unreachable, an occupied loopback port, and a missing git remote each yield a DIFFERENT typed `repair` (assert pairwise-distinct messages; no shared generic fallback).
- [ ] **git-remote rule:** the git-remote check is `ok` if a remote is configured OR an explicit local-only-backup-acceptance flag is present in the snapshot; absent both ⇒ `finding` with the remote/accept-local repair (§16).
- [ ] **FileVault non-fatal finding:** FileVault-off ⇒ a reported `finding` (at-rest control prerequisite, §4), never a silent `ok`, and never a hard `degraded`-that-aborts — the doctor still reports every other check.
- [ ] **Idempotency-as-purity:** a snapshot where a previously-failing prereq is now green ⇒ that check reports `ok`; `runDoctor` performs no mutation (assert no side-effect seam is invoked — the engine takes only the snapshot). The real repair command's side-effect-freeness is the deferred bucket-B property (noted).
- [ ] **SAFETY — write-through one-writer posture (REQ-S-NEW-008; Step-8 review surface):** vault-ACL (worker = sole write principal), gbrain read-only-mount/immutable-snapshot, and stray-gbrain-process (any `stdio serve` / `sync --install-cron` / `autopilot` / `jobs work` bound to a canonical brain) are THREE DISTINCT `DoctorCheckResult`s. A writable/mispointed vault mount OR a detected stray writer ⇒ a DISTINCT `finding` (re-opens GO #1) — and **fail-closed**: an absent/unknown/malformed posture probe outcome defaults to `finding`, NEVER `ok`. The stray-process finding names the detected bound process **redaction-safe** (no secret/raw bytes).
- [ ] Unit tests pin: full-green snapshot ⇒ all-`ok` report; each failure variant ⇒ its distinct repair; the git-remote OR-acceptance branch; fail-closed default on absent posture probes; purity (same input → same output, no seam call). Engine never throws (§16).

## RED outline (write cases first; each maps to an acceptance bullet)
1. `all_green_snapshot_reports_all_ok` — every named check present + `ok`; roll-up healthy.
2. `each_failure_variant_has_distinct_repair` — filevault-off / keychain-unreachable / occupied-port / missing-remote ⇒ 4 pairwise-distinct repair strings, each a typed variant (no catch-all).
3. `git_remote_ok_on_remote_or_local_backup_acceptance` — remote present ⇒ ok; no remote + acceptance flag ⇒ ok; neither ⇒ finding w/ the §16 repair.
4. `filevault_off_is_nonfatal_finding` — filevault-off ⇒ finding (not ok, not aborting); the rest of the report still populated.
5. `idempotent_purity_no_side_effects` — a fixed-prereq snapshot ⇒ that check ok; two calls on the same snapshot ⇒ identical report; the engine takes only the snapshot (no mutation seam).
6. `posture_writable_mount_is_distinct_finding` (SAFETY) — a writable/mispointed vault-ACL OR readonly-mount-violation ⇒ a DISTINCT finding (re-opens GO#1), distinct from the stray-process finding.
7. `posture_stray_gbrain_process_is_finding_redaction_safe` (SAFETY) — a detected `serve`/`autopilot`/`sync --install-cron`/`jobs work` bound to a canonical brain ⇒ finding; the message names the process without leaking secret/raw bytes.
8. `posture_absent_probe_fails_closed_to_finding` (SAFETY) — an absent/unknown/malformed posture probe outcome ⇒ `finding`, NEVER `ok` (fail-closed default).
9. `engine_never_throws` — a malformed/partial snapshot ⇒ a report (with fail-closed findings), never a throw (§16).

## Cross-doc invariant impact (implementer flags Step 9; orchestrator writes docs)
- **Model field changes:** **none** (plan 11.5 `Cross-doc invariant: none`). `doctor-result.ts` is a local `install/` operational result — additive, no Appendix-A / Zod-seam / snapshot / registry change. **If** the implementer concludes it belongs on a frozen seam → Step-9 cross-doc flag (do not freeze silently).
- **Architecture-doc note candidate:** §13 install-doctor prose may tick from "PLANNED" → "doctor check-engine core built (deterministic; real probes + repair-command wiring deferred)". Orchestrator-write.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Probe seam shape.** Default vote: engine consumes an injected `ProbeSnapshot` (a record of per-check raw outcomes) → pure `runDoctor(snapshot)`; the real OS/boot probe collectors that PRODUCE the snapshot are the deferred bucket-B adapter (Phase-7 pure-driver pattern; G1e-2 injected-seam style). Confirm vs injecting probe FUNCTIONS the engine calls (would make the engine impure).
2. **`DoctorReport`/`DoctorCheckResult` shape + placement.** Default vote: `packages/contracts/src/install/doctor-result.ts`, Zod-as-source local result (not frozen seam); discriminated `status` with `repair` mandatory on non-`ok`. Confirm the check-id enum set (the 10 named checks) + that the overall roll-up is derived (worst-of), not independently settable.
3. **Idempotency representation.** Default vote: assert idempotency structurally as engine purity (same snapshot ⇒ same report, no mutation seam); the repair command's real no-side-effect-on-rerun is the deferred property. Confirm this satisfies the 11.5 idempotency bullet at the core level.
4. **One-writer posture fail-closed default.** Default vote: absent/unknown/malformed posture probe ⇒ `finding` (never `ok`); three distinct findings (vault-acl / readonly-mount / stray-process). Confirm the stray-process message is redaction-safe (names the op, not raw args/secrets).

## Wiring / entry point / blocks
- **Entry point (future):** the install-doctor/repair command (11.1 boot orchestrator / 11.6 packaging) calls `runDoctor`. NOT built this slice ⇒ the engine + checks are unit-reachable now, production-wired when the command lands (documented unreachable-by-design waiver, as with the oracle-core + G1e-2 loader). Note at Step 7.5.
- **Blocks:** 11.7 clean-install acceptance (doctor reports every prereq green) depends on this + the real probes. Does NOT block Phase-9 completion.
- **Depends on:** existing typed-failure primitives only. Plan lists 11.5 deps 11.1/11.3/11.4 — those are the REAL-PROBE deps (deferred); the deterministic core needs none of them (that's why it's buildable now).

## Estimated commit count
**2.** (1) `packages/contracts/src/install/doctor-result.ts` typed contract + `runDoctor` engine + the non-safety diagnosers + tests 1–5, 9. (2) the SAFETY-CRITICAL one-writer posture checks (vault-acl / readonly-mount / stray-process) + tests 6–8 (own commit per the safety-critical-own-commit discipline). Implementer may propose single-commit if the split isn't clean — orchestrator's call at Step 9.

## Lessons-logged candidates (implementer flags Step 9)
- Candidate: "the install doctor engine is PURE over an injected `ProbeSnapshot` (real OS probes are a separate collector) — so the check-engine is deterministically unit-testable and the one-writer posture checks fail CLOSED to `finding` on any absent/unknown probe (a writable/mispointed gbrain mount is never a silent `ok`; re-opens GO#1)."

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — confirm the §13 install-doctor anchor exists (`/check-arch install`) + the 11.5 acceptance bullets.
2. Step 1 — confirm the file list (contract + engine + `checks/*`).
3. Step 2.5 — ping Q1–Q4 (defaults above) BEFORE writing cases; do not proceed to green until the orchestrator signs off.
4. RED first (§16 never-throws + fail-closed posture defaults are the load-bearing pins).
5. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality prompts) — the one-writer posture checks are a safety surface (REQ-S-NEW-008 / safety rule 1): no writable/mispointed/stray-writer state may resolve to `ok`; fail-closed default + §16 no-throw must hold on every axis; stray-process message must be redaction-safe.
6. Step 9 — categorized flags (esp. any pull toward a frozen `doctor-result` seam → cross-doc) + ship-ask.
