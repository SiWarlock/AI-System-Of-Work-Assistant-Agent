# Session 059 — C3b make-it-real capstone + the Phase-11 install-doctor collector arc (11.5-a/b/c/d)

- **Date:** 2026-07-12
- **Phase:** 11 (Deployment / Install · §13) — plus the tail of the make-it-real Option-C arc (§9, task 11.8)
- **Implementer:** `impl8` (single-track, `main`); team `session-f2673cd5`; orchestrators `orch7` → `orch9` (cycled mid-session), lead-driven close-out
- **Predecessor:** [`058-2026-07-11-make-it-real-c1-c3a.md`](058-2026-07-11-make-it-real-c1-c3a.md)
- **Successor session:** _(next implementer — impl10; bin-path hardening / 11.3 pin-verify)_

## Why this session existed

Finish the make-it-real Option-C arc (its last slice, C3b — the live-vault file-watcher trigger), then build out Phase-11's install-doctor from the pure `runDoctor` engine (`fc1960d`) into a runnable, reachable command: the four real-collector slices (11.5-a/b/c/d) that fill the `ProbeSnapshot` the engine consumes and finally CALL the chain.

## What was built

Five slices, each RED→Step-2.5→GREEN→Step-8 dual-adversarial-review→commit; every one repo-wide `turbo typecheck test` green (31/31) at commit.

**Files created**
- `apps/worker/src/watch/vaultWatcher.ts` — C3b: a `node:fs` file-watcher on the vault root; a `.md` add/change → C2 ROOT-confined capture → `extractFileSource` → C3a `dispatchSourceIngestion(trigger:"connector_event")`. WS-2 bound by config, never-throws (incl. `fs.watch`'s synchronous start-throw), debounced.
- `apps/worker/src/install/probe-collectors.ts` — 11.5-a: `collectPrerequisiteProbes` (node/pnpm · Temporal-CLI · gbrain-CLI · git-remotes · loopback-ports) over injected `RunCommand`/`ProbeLoopbackBind` ports + `runPrerequisiteDoctor` composition.
- `apps/worker/src/install/probe-adapters.ts` — 11.5-a: real `createLocalCommandRunner` (`execFile`, `shell:false`, fixed argv, timeout+cap, errno-only redaction) + `createLoopbackBindProbe` (127.0.0.1 exclusive bind).
- `apps/worker/src/install/probe-run.ts` — 11.5-c: the shared `safeRun` never-throw guard (extracted to break a value-import cycle).
- `apps/worker/src/install/posture-collectors.ts` — 11.5-c: `collectPostureProbes` — vault-ACL sole-write (`ls -lde`, read-only allowlist), gbrain read-only/canonical mount (`mount`), stray write-capable gbrain scan (`ps` → closed `STRAY_GBRAIN_OPS` labels, redaction-safe).
- `apps/worker/src/install/doctor-cli.ts` — 11.5-d: `renderDoctorReport` + `doctorExitCode` + `runInstallDoctor` (composition root; multi-vault worst-of fold).
- `apps/worker/src/install/bin/doctor.ts` — 11.5-d: the `sow-doctor` process entry (env → runInstallDoctor → stdout + exit).
- Test files: `apps/worker/test/integration/vaultWatcher-live.test.ts`, `apps/worker/test/install/probe-collectors.test.ts`, `.../posture-collectors.test.ts`, `.../doctor-cli.test.ts` — fast-unit + `SOW_DOCTOR_REAL`/`SOW_TEMPORAL`-gated real-adapter tiers.

**Files modified**
- `apps/worker/src/boot.ts` — C3b: a `vaultWatch` config field (OFF by default) wiring a lazy loopback Temporal Client (degraded-safe) + `startVaultWatcher` + clean `close()`.
- `packages/integrations/.../file-read-transport.ts` — C3b: additive `export isContainedUnder` (one authoritative containment predicate, reused not duplicated).
- `packages/workflows` / `apps/worker` — (earlier this arc, C1/C2/C3a/§16, already committed before session start).
- `apps/worker/src/install/checks/environment.ts` — 11.5-b: realigned the `keychain_unreachable` repair text to subsystem-availability (dropped the runtime "unlock" framing that mismatched the reachability probe).
- `apps/worker/package.json` — 11.5-d: a `bin` entry `sow-doctor`.
- `apps/worker/src/install/probe-collectors.ts` + `posture-collectors.ts` — 11.5-d: additive `export probeGitRemotes` / `export probeVaultAcl` for the multi-vault per-field fold.

**Commits:** C3b `571ab33` · 11.5-a `5171f2a` · 11.5-b `76cf02f` · 11.5-c `0646df7` · 11.5-d `8d71c64` (all on local `main`, unpushed — round close-out is the orchestrator's `/orchestrate-end`).

## Decisions made

- **C3b degraded-safe Temporal Client via lazy connect** (`Connection.lazy()`) — boot never stalls on a down Temporal; each capture fails closed per-event and auto-recovers. `fs.watch`'s synchronous start-throw is caught (else it crashes boot + leaks the Connection).
- **Probe collectors = pure mapper over an injected exec/net port + a thin real adapter** (the C2/C3a shape): every collector never-throws + fail-closes to the assume-worst "unknown" the pure engine maps to a `finding` (Lesson 8). Absolute system bins for the security-sensitive probes (`/bin/ls`, `/sbin/mount`, `/bin/ps`, `/usr/bin/…` conceptually).
- **Keychain probe = `security list-keychains` reachability** (not unlock-state) — least-privilege, no secret read / no prompt (safety rule 7); a locked keychain is the §16 runtime concern, not an install prerequisite. Repair text realigned to match (orch9 ruling).
- **One-writer posture fail-closes conservatively:** vault-ACL uses a read-only *allowlist* (unknown/empty perm ⇒ assume write); the stray-gbrain classifier keys on the executable token (launcher-wrapped writers surface as bare `gbrain` lines) with exact-path canonical-brain binding + fail-closed on an unresolvable brain; a non-10-char mode string ⇒ assume-worst (a fail-open caught by review).
- **Multi-vault completeness (11.5-d):** the two vault-scoped checks (`vault_acl`, `git_remotes`, `repoDir`=the vault) AND-folded worst-of over EVERY configured vault; vault-independent probes hoisted to run ONCE (loopback bound exactly once — self-collision structurally impossible). Empty vault map ⇒ explicit fail-closed findings.
- **Doctor exit code:** `ok`/`degraded`→0 (degraded is a tolerated first-class state), `finding`→1 (an install script must gate on it). Report-only — prints repair guidance, never auto-applies.
- **`workerPrincipal` resolved in the ENTRY** (`os.userInfo()`), injected — the pure collector never reads the OS.

## Decisions explicitly NOT made (deferred)

- **No `AppConfig`/config-schema expansion** — `canonicalBrainPath`/`repoDir`/`localBackupAccepted` resolved in the entry via env/defaults, not added to the frozen-ish config (orch9 steer).
- **No `--json` doctor output** — deferred to the 11.7 clean-install acceptance (human-readable only now).
- **No auto-repair mode** — report-only; a genuine auto-repair would be a separate owner-gated slice.
- **Collector `--` argv separator + absolute-bin hardening for the prereq/security probes** — a LOW defense-in-depth residual; the collectors are already-shipped/dual-reviewed (do-not-re-touch) → routed as a follow-up.

## TDD compliance

**Clean.** Every slice was RED-first: a stub + failing tests, Step-2.5 orchestrator review, confirmed RED (assertion failures, not import/syntax), then GREEN. Two safety-critical slices (C3b real-I/O, 11.5-c one-writer posture) + the two review-touching slices (11.5-b/d) took the mandatory dual adversarial review. Review-driven test additions (e.g. the 11.5-c other-write fixture that caught a real fail-open; the 11.5-d loopback-bound-once pin) were added as failing pins before their fold.

## Reachability

- **C3b vault-watcher** — reachable from `bootWorker` via `startVaultWatcher` (config.vaultWatch-gated, OFF by default); the `SOW_TEMPORAL`-gated e2e drives the identical seam.
- **11.5-a/b/c collectors + engine** — were dormant behind a documented reachability waiver until 11.5-d.
- **11.5-d `runInstallDoctor`** — the FIRST real caller of the collector chain → **the 11.5-a/b/c reachability waiver is CLOSED**; the production entry is the `sow-doctor` bin (`apps/worker/package.json`). The `SOW_DOCTOR_REAL`-gated e2e exercises the real adapters end-to-end.
- No tested-but-unwired gaps remain in the install-doctor arc.

## Open follow-ups (Step-9 categorized — orchestrator routes at `/orchestrate-end`)

- **Architecture-doc notes (orchestrator writes):** §9 source-ingestion now has a REAL local-vault file-watcher trigger (C3b); §13 install-doctor is now a runnable `sow-doctor` command (report-only, exit-code gateable, 10-check report incl. one-writer posture, multi-vault worst-of fold).
- **Convention candidates (Lessons):** the make-it-real real-I/O safety shape (Lesson 17 already banked); a safety-posture probe fail-closes an absence-of-confirmation to a finding + classify-into-a-closed-label-set is the redaction primitive; the reachability-waiver-holder pattern (pure engine + real collectors dormant behind a waiver → one composition-root entry makes the chain reachable) + the additive per-field-probe export for a multi-vault fold.
- **Future TODO (belongs-to-a-phase):** `/phase-exit 11` (once 11.6 packaging + 11.7 clean-install acceptance land) · 11.7 consuming a doctor `--json` mode · the collector `--` argv-separator + absolute-bin hardening (LOW) · 11.3 pin-verify deterministic core (next candidate).
- **Cross-doc invariant change:** NONE this session (no seam-model field add/remove/rename; `ProbeSnapshot`/`doctor-result.ts` are local non-Appendix-A contracts; `ARCHITECTURE.md` working-tree diff empty).

## How to use what was built

`sow-doctor` (after a worker build) runs the prerequisite doctor: reads env (`SOW_VAULT_ROOT_PATHS`, `SOW_API_PORT`, `SOW_TEMPORAL_ADDRESS`, `SOW_CANONICAL_BRAIN_PATH`, `SOW_LOCAL_BACKUP_ACCEPTED`), prints a `[status] check … / overall:` report to stdout, exits 0 (ok/degraded) or 1 (finding) — gateable by an install script. Report-only; re-run after an external fix reports green.
