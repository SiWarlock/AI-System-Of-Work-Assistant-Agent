# Phase 9 (Electron Desktop UI) — spec-vs-code drift audit

**AUDIT ONLY — NOT a `/phase-exit 9` gate run. No CLEAR/BLOCKED verdict is emitted; see "Why no verdict" below.**

Repo: `SoW-build`, branch `main`, HEAD `86477bbf7710cb008878d4eb15600a63ab43b708` (verified via `git rev-parse HEAD`), tree clean (`git status --short` empty) at time of audit. No mutating commands were run during this audit.

## Why no verdict

Phase 9 is structurally un-exitable for reasons that are independent of code quality: task 9.5's `§4.5` managed doc-pack leg cannot tick at all — it is blocked on a Google Drive connector that does not exist in this codebase — and the owner ruled on 2026-07-26 that nothing is deferred out of Phase 9 to make it exitable anyway. Emitting a CLEAR/BLOCKED verdict here would therefore be predetermined by that dependency, not derived from this audit's own analysis, and a BLOCKED verdict quoted out of context reads as "Phase 9: BLOCKED" — a false characterization of what this document actually found (which is: very little drift, and a codebase that is unusually careful about tracking its own gaps). This report gives findings only; the gate call belongs to a real `/phase-exit 9` run, whenever the doc-pack dependency is resolved or the owner revisits the "nothing deferred" ruling.

## Review-surface honesty

Phase 9 is a later phase on the desktop track and its own tasks reference commits, fixes, and follow-ups threaded across many prior sessions (9.1 through 9.35, plus a long tail of rule-5 egress fixes numbered 9.22–9.33 and bare `#N` findings folded in as 9.34/9.35). A true isolated "Phase 9 diff" is not separable from the desktop track's accumulated history. **This audit's review surface over-approximates to the accumulated desktop-track diff** (everything under `apps/desktop/`, plus the worker-side egress/policy machinery Phase 9's tasks depend on in `apps/worker/src/boot.ts`, `apps/worker/src/composition/egressRevoke.ts`, and `packages/policy/src/processors.ts`) rather than a narrow per-slice diff. Policy explicitly permits this over-approximation at phase-boundary review; it is disclosed here rather than left silent, per the standing instruction that a broad-shallow read must not be allowed to look like a narrow-deep one.

**What was verified deeply vs. sampled:** I did line-level, file-cited verification of the security-invariant core (9.1–9.3 Electron/session-token/auth), the entire 9.22/9.29/9.30/9.32/9.33 zero-egress predicate family (the highest rule-5 risk surface in the phase), 9.10-C's rendered egress copy, 9.34/9.35 (Copilot answer brand, ErrorBoundary), 9.16's ingestion-inbox binding, 9.10-D's audit-link absence, and the Appendix-A model shapes for `Workspace`/`EgressPolicy`. I did **not** re-derive or re-run the remaining `[~]` PARTIAL tasks' full test suites, did not execute any test run (per instructions — this audit reads code + targeted test files, it does not re-run `/preflight`), and did not deep-verify every one of the ~35 tasks' individual commits line-by-line — the plan's own prose for those tasks is unusually detailed and internally cross-checked already (see "Method" note below), so I spot-checked rather than exhaustively re-derived every `[x]` tick.

## Anchors read (targeted ranges only, not the whole document)

| Anchor | `ARCHITECTURE.md` lines | Verdict on the anchor's own resolution |
|---|---|---|
| §11 — Electron Desktop UI | 364–371 | Resolves correctly; primary anchor |
| §10 — Local App API | 358–363 | Resolves correctly |
| §5 — Policy, Security & Egress | 171–207 | Resolves correctly |
| §16 — Cross-cutting concerns | 424–435 | Resolves correctly |
| §4 — Operational Storage | 151–170 | Resolves correctly |
| §6 — Knowledge: Markdown, Obsidian, GBrain & GCL | 208–284 | Resolves correctly |
| §7 — Provider & Runtime Broker | 285–309 | Resolves correctly |
| §12 — Eval & Test Harness | 372–388 | Resolves correctly |
| §2.5 — Subsystem DAG | 80–126 | Resolves correctly |
| Appendix A | 764–802 | Resolves correctly; rows for `Workspace`/`ProviderMatrix`/`EgressPolicy`/`SourceEnvelope`/`GclProjection`/`Approval` read |
| `docs/planning/THREAT_MODEL.md` | whole (67 lines) | Exists; self-labeled `Status: rough-draft planning artifact for /arch-finalize` |
| `docs/planning/USER_FLOWS.md` Flows 3/5/6 | 45–108 | Resolve correctly (Cross-Calendar Scheduling / Project Sync and Progress / Approval Flow) |
| `docs/planning/USER_FLOWS.md` Flow 13 | — | **Does not exist** — see Notation-hazard finding below |

## Known-dangling citations — confirmed / contradicted

All four categories the dispatcher pre-flagged are **confirmed dangling as ARCHITECTURE.md sections**, and I traced each to what it actually denotes rather than leaving it unresolved:

1. **`§4.5`** — 0 occurrences in `ARCHITECTURE.md` (confirmed via full-doc grep). **What it actually denotes:** `docs/design/ui-ux/ui-ux-spec.md:206` `### 4.5 Projects` — the UI/UX design doc's OWN section numbering (a completely different document, with its own independent `##`/`###` numbering starting at "1. What we are building"). That section is literally the managed-doc-pack UI spec ("00 Brief, 01 Decisions, 02 Meeting Digest, 03 Research, 04 Open Questions" — `ui-ux-spec.md:210`), which matches exactly what task 9.5 calls "the §4.5 managed doc-pack." **ARCHITECTURE.md's own real `§4` is "Operational Storage"** (`ARCHITECTURE.md:151`) — an unrelated subsystem. So the phase's own blocker anchor is not merely dangling, it collides in the worst possible way: `§4.5` under the "architecture section" reading points at storage internals; under its actual (UI-spec) reading it points at exactly the right thing. Do not "fix" this by inventing an ARCHITECTURE.md §4.5 — the correct fix is citing `ui-ux-spec.md §4.5` explicitly by document name.
2. **`§14.1` / `§14.3` / `§14.5`** — 0 occurrences in `ARCHITECTURE.md`; `ARCHITECTURE.md:405` `## §14 — Alternatives considered` has no numbered subsections at all. **What they denote:** `IMPLEMENTATION_PLAN.md` Phase 14 task numbers — `### 14.1 — Workspace onboarding & provisioning` (`IMPLEMENTATION_PLAN.md:1878`), `### 14.3 — System Health / observability panel` (`:1890`), `### 14.5 — Preset → provisioning-profile mapping` (`:1902`). Confirmed by cross-reading task 9.10's/9.11's own text, which describes exactly that content ("System Health panel (§14.3 `7d141528`)", "built under Phase 14 (§14.1+§14.5"). Correct citations, wrong glyph.
3. **`§13.5`** — appears in `ARCHITECTURE.md` only inside the Appendix-A `Project` row (`ARCHITECTURE.md:785`), never as a heading. **What it denotes:** `IMPLEMENTATION_PLAN.md:1663` `### 13.5 — Typed Project model + state machine (FROZEN-CONTRACT round)`. Confirmed.
4. **`§9.4` / `§9.5` / `§9.32`** — confirmed to be Phase-9 task numbers (Global Today Dashboard, Workspace tabs, `providerMatrix` writer arc) written with a `§` glyph rather than plan task numbers, exactly as the dispatcher suspected.

**Additional dangling citation found (not on the dispatcher's pre-flagged list): `USER_FLOWS 3/5/6/13`.** `docs/planning/USER_FLOWS.md` has exactly 8 flows (`Flow 1` through `Flow 8`, confirmed by heading grep). Flow 3 = Cross-Calendar Scheduling, Flow 5 = Project Sync and Progress, Flow 6 = Approval Flow — all three resolve correctly and match their citing tasks (9.9, 9.5, 9.8 respectively). **There is no Flow 13.** The "13" instead resolves under a *different* document's *different* numbering scheme: `ARCHITECTURE.md:354`, `§9 — Temporal Workflows & Automation`'s own internal workflow list, item **13. Copilot Q&A** (`§9 workflow 13`, also cited that way at `ARCHITECTURE.md:368` inside §11's own Copilot paragraph). So the phase-header citation `USER_FLOWS 3/5/6/13` silently mixes two numbering schemes under one label: the first three digits are `USER_FLOWS.md`'s own flow numbers, the fourth is `ARCHITECTURE.md §9`'s workflow number for a workflow (Copilot Q&A, a Phase-C addition) that postdates `USER_FLOWS.md` and was never added there.

## Notation hazard — systemic, not confined to Phase 9's citation line

The `§N.M` collision is not a one-off authoring slip in `IMPLEMENTATION_PLAN.md` — it is baked into `ARCHITECTURE.md`'s own prose. A full-document heading grep confirms `ARCHITECTURE.md` has real numbered subsections **only** under `§19` (`§19.1` through `§19.13`, `ARCHITECTURE.md:492–...`). Every other `§N.M`-shaped token appearing in `ARCHITECTURE.md`'s body text for N ∈ {6, 9, 13} — e.g. `§13.10`, `§13.10a`, `§13.10c`, `§13.10d`, `§13.15`, `§13.16`, `§13.17`, `§13.19`, `§9.6-real`, all appearing throughout §6's prose (`ARCHITECTURE.md:227–284`) and §13's Copilot-enablement-ladder paragraph (`ARCHITECTURE.md:397`) — is **also** `IMPLEMENTATION_PLAN.md` Phase-13/9 task-number shorthand reusing the section glyph, not an `ARCHITECTURE.md` subsection. This is an internally-consistent authoring convention once you know it, but it is indistinguishable from a real dangling `ARCHITECTURE.md` cross-reference on first read, and it is exactly the ambiguity that made `§4.5` look like a phantom storage-layer reference instead of the (correct) UI-spec citation it is. This is a documentation-hygiene/process finding, not a code drift — recorded as an Architecture-doc note below.

## Per-anchor verification — checkable statements → verdict → evidence

### §5 / §11 — Electron security baseline (9.1, 9.2, 9.14)

| Statement | Verdict | Evidence |
|---|---|---|
| `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`, no remote module | Verified | `apps/desktop/main/window.ts:33-41` |
| `will-navigate` / `setWindowOpenHandler` deny non-app navigation + new-window creation by default | Verified | `apps/desktop/main/window.ts:46-49` |
| Preload exposes ONLY an enumerated privileged channel set, no db/fs/secrets/connector access | Verified | `apps/desktop/preload/bridge.ts:29-74,101-109` — 7 channels (`app.getVersion`, `session.getToken`, `worker.getConnection`, `vault.open/reveal`, `lifecycle.firstRunStatus/markOnboarded`); none touches db/fs/secrets/connectors directly |
| Per-launch session token minted fresh, memory-only, never persisted/logged, reaches renderer only via preload | Verified | `apps/desktop/main/session-token.ts:16-28` (crypto-random, in-memory `token` variable, no disk/log write) |
| Worker auth interceptor: token check before Origin/Host allowlist, both pre-handler, never throws | Verified | `apps/worker/src/api/auth/interceptor.ts:60-74` — token (`verifySessionToken`) checked first, origin second, returns typed `Result` on every path |

No drift found in this cluster; matches §5/§11's stated contract precisely.

### §5 — the `zeroEgressOnly` two-axis derivation (9.22 / 9.29 / 9.30 / 9.32 / 9.33)

This is the highest-risk rule-5 surface in the phase and received the deepest verification.

| Statement (from §5, `ARCHITECTURE.md:191-204`) | Verdict | Evidence |
|---|---|---|
| `zeroEgressOnly` true only when BOTH axes hold: routing pins local (non-vacuous matrix, all-local providers, all-loopback routes, `rawCloudEgressEnabled===false`) AND both egress allowlists empty | Verified | `packages/policy/src/processors.ts:160-243` (`isLocalOnlyProviderMatrix`, `hasNoApprovedEgressDestination`, composed in `isZeroEgressOnlyWorkspace`) |
| Both live producers (`boot.ts` egress-status query, `egressRevoke.ts`) derive from the SAME predicate, not `!acknowledged` | Verified | `apps/worker/src/boot.ts:588` `isZeroEgressOnlyWorkspace(got.value)`; `apps/worker/src/composition/egressRevoke.ts:92` `isZeroEgressOnlyWorkspace(revoked)` |
| Fault path returns `false` (NOT ESTABLISHED), not `true` (the pre-9.22 inverted-direction bug) | Verified | `apps/worker/src/boot.ts:542-544` `failClosedEgress` returns `zeroEgressOnly: false`, with an in-code comment explicitly walking through why `true` would be the false-assurance direction |
| An empty allowlist is the strongest zero-egress state (not the weakest); a sparse-array hole must not vacuously satisfy the predicate | Verified | `packages/policy/src/processors.ts:236` `isEmptyProcessorList` — `Array.isArray && length===0 && countOwnIndexKeys===0`; `everyProviderIsLocal` (`:126-138`) explicitly rejects sparse holes via `Object.prototype.hasOwnProperty.call` — this closes the "model-independent defect (i)" the plan flagged as deliberately deferred; it is in fact fixed |
| `providerMatrix` is currently unsatisfiable in production (no writer populates it non-empty) | Verified as still true | `packages/policy/src/processors.ts:170-180` doc comment states it explicitly and matches the plan's 9.32 finding; no contradicting writer found |
| Desktop renders the claim epistemically ("established"/"not established"), never "safe"/"local", and states the model-provider-only scope | Verified | `apps/desktop/renderer/surfaces/workspace-settings/egress.tsx:57-60,235-244` — `PROVIDER_ROUTING_ESTABLISHED`/`_NOT_ESTABLISHED` constants, `EGRESS_SCOPE_NOTE` rendered alongside every reading |
| `processorOfRoute` is total (a blank identity denies rather than throws) | Verified (by doc-comment + call-site guard); not independently re-derived from `egress.ts`'s exact veto ordering | `packages/policy/src/processors.ts:100-111` documents `MALFORMED_ROUTE_PROCESSOR` as the exported deny sentinel; not re-traced line-by-line through `egress.ts`'s step ordering — **not independently re-verified, taken on the strength of the in-code documentation and the surrounding predicate code being otherwise accurate** |

No drift found. Task 9.22/9.29/9.30/9.32/9.33's plan-text claims about this surface are unusually precise and match the shipped code closely, including subtle claims (the sparse-array-hole fix, the epistemic renderer copy, the fault-direction inversion fix).

### §11 — Copilot notice / brand (9.24, 9.26, 9.28, 9.34) and ErrorBoundary (9.35)

| Statement | Verdict | Evidence |
|---|---|---|
| `egressProcessor` stays `.optional()`, never `.catch()` (so it can't be silently stripped) | Verified | `packages/contracts/src/api/ui-safe.ts:495` `uiSafeSummaryLine.optional()` |
| `AdmittedCopilotAnswer` nominal brand, mintable only via `admitReply()`, required at both chokepoints (live ask + seed prop) | Verified | `apps/desktop/renderer/surfaces/copilot/Copilot.tsx:153-160` (`admitReply` definition + `FAILED_REPLY` cast), `:294`, `:338` (both call sites) |
| No ErrorBoundary existed anywhere in `apps/desktop`; now two sites (root + AppShell), neither alone sufficient | Verified | `apps/desktop/renderer/main.tsx:9-18` wraps `<App/>` at the root; `ErrorBoundary.tsx` comment (`:30-35`) documents the second site at `AppShell.tsx` |
| `fallback` is typed with no error parameter (rule-7 discharged by type, not convention) | Verified | `apps/desktop/renderer/chrome/ErrorBoundary.tsx:38-46` — `fallback: (reset: () => void) => ReactNode`, no error arg |
| 9.10-D: no `audit.` procedure exists in `queries.ts` yet; `auditRef` dropped from every UI-safe type | Verified | `grep "^  audit\."` on `apps/worker/src/api/procedures/queries.ts` → 0 matches; `packages/contracts/src/api/ui-safe.ts:181,310` both document the `auditRef`/`parityReportRef`/`factIdentity` drop |

No drift found.

### §16 — System Health / redaction

Spot-checked via the `failClosedEgress` / `egressStatus` port above (§16's "each item is a typed `HealthItem`... a distinct, persistent, audit-linked record per failure class" — not independently re-derived against the full `HealthItem` producer set across Phase 9; the egress-status query port specifically was verified never-throws and typed-Result-returning, matching §16's error-handling convention). **Not covered:** a full re-audit of every `HealthItem` producer wired in Phase 9 against the OBS-2 `failureClass` enum in Appendix A.

### §4 / §6 / §7 / §12 — the four anchors added at the seal

These were read in full per the dispatcher's corrected anchor set. Cross-checking Phase 9's actual citations against them:

- **§4** (`updateProvisioningFields`/`insertIfAbsent`, dual-dialect coverage, cited by 9.30): task 9.30's own text names these exact functions and describes narrowing the same-type provisioning branch to name/vaultRoot/brainId fields. I did not re-open `packages/db`'s adapter code to re-derive this independently (out of the desktop-track over-approximation boundary, and 9.30 is worker-side plumbing the desktop track depends on rather than owns) — **not independently re-verified**, taken on the 9.29/9.30 plan text's internal consistency (both landed at the same commit `615394a8`, and 9.29's writer-census tripwire mechanism described is a distinctive, checkable design that reads as genuine engineering rather than a retrofit narrative).
- **§6** (vault binding, cited by 9.31): 9.31's claim that `Workspace.markdownRepoPath` has zero production consumers (the runtime vault comes from `config.vaultRoot`) was **not independently re-verified** against `apps/worker/src/composition/backends.ts` — flagged as uncovered rather than silently assumed true.
- **§7** (provider matrix, cited by 9.32): fully covered above under the zero-egress-derivation cluster.
- **§12** (pin/eval-gate, cited by 9.13 benchmark + 9.14): 9.13's benchmark file (`packages/evals/src/benchmarks/dashboard-warmload.bench.ts`) and 9.14's security-suite file paths were confirmed to exist by directory listing during the codegraph orientation pass; their pass/fail status was **not re-run** (out of scope per the dispatch — `/preflight` is a separate row, and the "known transient" `main-bundle-resolution.test.ts` failure is recorded as a project fact I was told not to chase, so I did not).

### §2.5 — import-direction / desktop track boundary

`packages/contracts/CLAUDE.md`'s forbidden-pattern #2 boundary-test claim (now mechanically pinned per the 2026-07-29 impl note at `ARCHITECTURE.md:125`) was read but not independently re-run against `apps/desktop`'s actual import graph — **not covered**; this is a cross-track contracts-package concern more than a Phase-9-desktop one.

## DRIFT (code≠spec, spec is right) — Findings

**None found.** Every checkable statement I verified against code (the security baseline, the entire zero-egress derivation family, the Copilot brand/notice handling, the ErrorBoundary, the 9.10-D audit-link absence, and the Appendix-A `Workspace`/`EgressPolicy` field shapes) matched its cited anchor. This is a genuinely unusual result for a phase this large and I want to name why, rather than let a clean sweep read as under-scrutiny: `IMPLEMENTATION_PLAN.md`'s own Phase 9 section is written as a live, self-correcting audit trail — it repeatedly catches and corrects its own stale claims in-place (e.g. the 2026-07-29 reconciliation walking back a prior "sole remaining blocker" overstatement at `IMPLEMENTATION_PLAN.md:1310`), and several of the code sites I checked carry in-file comments that pre-empt exactly the drift questions this audit would otherwise raise (the `zeroEgressOnly` fault-direction inversion, the sparse-array-hole guard, the epistemic renderer copy). That is a property of this specific codebase's process discipline, not a property of drift audits in general, and it should not be read as "nothing to find here" for future phases with a thinner paper trail.

## Architecture-doc notes (STALE-DOC — code is right, doc lags)

1. **`docs/planning/THREAT_MODEL.md:51`** states as a `[locked decision]`: *"Employer Work raw cloud egress off by default."* This no longer matches the shipped, owner-authorized posture: `ARCHITECTURE.md:185` documents the 2026-07-25 flip (commit `bcde3d61`) — *"Employer cloud egress is now OPEN-by-default-seed for `[claude]` ONLY"* — and the code (`provisionWorkspace.ts`'s seeding path, referenced throughout 9.10/9.23/9.29's plan text) implements exactly that. `THREAT_MODEL.md` self-labels as `Status: rough-draft planning artifact for /arch-finalize` (`:3`) and was not updated when the owner made this call. This is not a Finding under the classification rules here (the code matches an explicit, later owner ruling; the planning doc is what lags) — but it is worth flagging above the routine STALE-DOC tier, because a threat model that asserts a security default the shipped code deliberately no longer has is a more consequential kind of staleness than most doc drift, even though the current code is correct per the owner's own decision.
2. **The systemic `§N.M` notation collision** described above (`§4.5`, `§9.4/9.5/9.32`, `§13.5`, `§13.10*`, `§13.15-19`, `§14.1/3/5` all denoting `IMPLEMENTATION_PLAN.md` task numbers or a different document's section numbers, not `ARCHITECTURE.md` subsections outside `§19`) is a documentation-authoring-convention risk, not a code defect. Recommend reserving the `§` glyph strictly for `ARCHITECTURE.md`'s own headings and citing plan tasks as `task N.M` (or similar) instead — the convention already works once known, but it is indistinguishable from a real dangling cross-reference on a cold read, which is exactly what triggered this audit's dispatch-time pre-check.

## Ambiguous (can't tell which side is right)

None identified beyond the notation-hazard items above, which are resolved (both sides are "right" once the correct referent is identified — the ambiguity is in the citation glyph, not in a substantive disagreement between doc and code).

## What this audit did NOT cover

- No test suite was re-run (per instructions); `pnpm lint` in this project **is** `tsc --noEmit` (confirmed via `apps/worker/package.json`, `packages/contracts/package.json`, `apps/desktop/package.json` — no ESLint config anywhere in the repo), so no lint-tool coverage exists to begin with.
- The remaining `[~]` PARTIAL tasks' (9.5, 9.6, 9.7, 9.8, 9.10) *unshipped* halves were not audited as drift — per the dispatcher's framing, an unshipped leg of a `[~]` task is not drift by definition; only a contradiction between *shipped* behavior and its anchor would be.
- Every one of the ~35 Phase 9 task commits was not independently re-diffed line-by-line; I sampled the highest rule-5/security-risk cluster (zero-egress derivation, Electron security baseline, Copilot disclosure) plus a few representative `[x]` DONE tasks (9.16, 9.34, 9.35) and one Appendix-A field-shape spot check, rather than exhaustively re-deriving all ~35.
- §4's `packages/db` adapter internals (9.30's `updateProvisioningFields`/`insertIfAbsent`) and §6's `markdownRepoPath` zero-consumer claim (9.31) were read from the plan's own text and cross-checked for internal consistency, not independently re-derived from `packages/db`/`apps/worker/src/composition/backends.ts` source.
- `packages/evals`' actual pass/fail state (9.13 benchmark, 9.14 security suites, the C-suite of §12-required suites) was not re-run; file existence was confirmed, execution status was not.
- The recorded transient `apps/desktop/test/bundle/main-bundle-resolution.test.ts` repo-wide-run failure was not re-chased, per the standing project fact that it is attributed and known.
- `§2.5`'s new mechanical boundary-test pin (`0a6d6629`) was read about but not independently re-run against the desktop track's actual import graph.
