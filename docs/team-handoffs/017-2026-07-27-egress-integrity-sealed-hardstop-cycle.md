# Team Handoff 017 — Egress-integrity round SEALED; team cycled at HARD-STOP

**Date:** 2026-07-27 · **Track:** single-track `main` (no worktree — root checkout)
**Predecessor handoff:** `016-2026-07-25-wave2-sealed-full-teardown-new-session.md`
**Successor handoff:** _(next `/team-end`)_
**Round-seal commit:** `8dc4ad56` (orchestrator terminal commit, docs-only, 19 files, 0 code)
**origin/main:** `d0886ea4` · **unpushed tail:** 2 commits (`31f53239` desktop doc 119 + `8dc4ad56` seal)

> **⭐ READ THIS FIRST, then `IMPLEMENTATION_PLAN.md` "Currently in progress"** (the orchestrator's seal snapshot — three-red triage, the 9.22 inversion, the ordered next-dispatch list) **+ `docs/team-protocol.md`** (lead playbook — NOT auto-loaded).

## Why this handoff exists

Mechanical auto-cycle. The orchestrator crossed HARD-STOP (83%) during close-out. It completed `/orchestrate-end` on the basis that its expensive authoring was already front-loaded to disk at 73–74%, leaving only staging and one commit. All teammates are `/session-end`/`/orchestrate-end`-closed. **This is a cycle, not a teardown** — teammates are idle-but-alive; the next `/team-start main` may re-spawn fresh or resume, lead's choice.

## Team composition at close

| Role | Name | Closed at |
|---|---|---|
| Lead | this session | — (writing this) |
| Orchestrator | `main-orchestrator` | `/orchestrate-end` → `8dc4ad56` (at 83%) |
| Implementer — worker | `worker-implementer` | `/session-end` → `083cfb61` (doc 118) |
| Implementer — knowledge | `knowledge-implementer` | `/session-end` → `6f5ad45a` (doc 117) |
| Implementer — desktop | `desktop-implementer` | `/session-end` → `31f53239` (doc 119) |

`provint` / `evalsec` / `contract` were never spawned this round.

## Active arc + where it landed

The **egress-integrity round**. ⭐ **ARC-4's keystone chain is COMPLETE** (13.8a→d + 13.8f-A + 13.8g-A + 13.8j + 13.8k). Phase-9's egress surface landed (9.10-C `7e251b0e`), the **live hardcoded "Egress: local-only" chrome claim was removed** (`5d56f00f`) and the **design authority that mandated it was retired** (`f7124f69`).

The round's substance was **six instances of one defect shape — a safety property asserted rather than derived from the state that governs it.** Full narrative in `docs/archive/IMPLEMENTATION_LOG.md` (2026-07-26 entry). Three of the fixes initially reintroduced the defect in a new form; the orchestrator's own brief specified one of the bypasses; and one fix (9.22) was caught mid-flight specifying a *seventh* instance.

## In-flight at close

**None.** Working tree clean apart from `.claude/.headroom_wrap_marker.json` (harness artifact, untracked, pre-existing).

⛔ **worker 9.22 did NOT ship** — its brief's premise was inverted. Held work is preserved on branch **`wip/9.22-inverted-premise-DO-NOT-MERGE`** (`cffbfc7f`), **not** in the tree. `main`'s worker/policy files verified 0 dirty. Salvage split is recorded in plan task 9.22.

## Carry-forward

Do **not** duplicate it here — `IMPLEMENTATION_PLAN.md` "Currently in progress" + "Carry-forward" carry the full detail, written by the orchestrator with the evidence inline. The three headline items:

1. **Three red packages, none created this round.** `@sow/evals` — ⚠ **CORRECTED 2026-07-27. The original claim was true of the DIRTY tree it was measured in, and false of the clean tree it was recorded about** (attribution across a revert — see the evalsec spawn prompt below for the full mechanism; nobody fabricated anything). At HEAD there is **no `hash_mismatch`** and the corpus does **not** fail at load: all five corpora verify against the loader's own canonicalizing computation, and `pnpm vitest run` gives **607 pass / 1 fail / 14 skipped**. The 14 skips are the API-key-gated real-Claude eval, unrelated. The single failure is the 13.8j namespacing consequence only (`entity-create-stub` + `stub-plus-newregion-auto`, invariants `create_paths` + `stubs_present`). **One issue, not two.** · `@sow/db` (pre-existing, gates nothing) · `@sow/desktop` (not a failure — another track's uncommitted file).
2. **9.22's corrected allowlist model** — empty `allowedProcessors` = deny-all = the *strongest* zero-egress state; a local id in an *egress* allowlist means a **remote** endpoint. Three options recorded, **C recommended**, flagged **owner-facing**.
3. **Push owed** — 2-commit tail. The earlier "hold until green" gate was **LIFTED** on corrected facts (origin was already red).

## Open decisions / blockers for the human

- ⛔ **9.22 semantic A/B/C** — defines what "zero-egress only" *means* on a surface the owner reads to confirm a revoke landed. Owner-facing; successor scopes first, then it goes up.
- ⛔ **§DEC-CANDGATE arc** — owner-approved for **next round**, contract-first (contracts → knowledge → worker). Real Zod gates on candidate-data types crossing REASON; `EntityRef` has no schema in contracts at all.
- ⛔ **Task 24.6 — pre-go-live safety-assertion audit.** Owner-approved. Four binding constraints recorded verbatim; the **tested-false-assurance** finding is its headline evidence (an audit reading only production code misses the class entirely).
- Standing owner gates, unchanged: employer login-switch residual · per-workspace subscription-split · §ARM-23 web-fetch · connector arming.

## Standing rules (enforce next session)

Producer-first · composition-root = worker (logic-in-package, wire-at-boot) · no cross-area single-implementer verticals · **safety/rule-5 commits route Step-9 → the LEAD** · push = owner-run at seals.

**Lead posture that earned its keep this round:** verify rule-5 claims against source rather than accepting them. It caught the `provisionWorkspace` fall-through, a second undisclosed test pin (`:83`), an overstated finding in a durable file, and the false premise under a push decision. **Verification flowing only downward leaves a blind spot the size of whoever sits at the top of it.**

---

## Spawn prompts for the next team session

> Spawn the orchestrator first, then implementers as their legs open. Each teammate's FIRST action is the `team-register.sh` line, then the start command.

### Orchestrator
```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track — repo root, NOT a worktree). Track label: main. All commits land on `main`. Confirm a teammate's name before any peer send.
Activated because: fresh team session resuming from handoff 017 (egress-integrity round sealed at 8dc4ad56; predecessor cycled at HARD-STOP 83%). Re-derive state from IMPLEMENTATION_PLAN.md "Currently in progress" — it carries the three-red triage, the 9.22 inverted-premise correction, and the ordered dispatch list. FIRST: evalsec corpus re-point (inherited defect, ⚠ stacked second issue), then worker 9.22 RE-BRIEF against the corrected model (brief 203 is WRONG — do not reuse), then 9.23 (brief 204 is clean, @62503539).
Standing rules: producer-first; composition-root=worker; no cross-area verticals; safety/rule-5 commits Step-9→LEAD; push=owner-run at seals. Employer-egress FLIP (bcde3d61) EXECUTED — do NOT re-open. Owner gates (9.22 A/B/C semantic, subscription-split, §ARM-23, connector arming) surface via lead, never decided locally.
⚠ Verify implementer claims against source before clearing a rule-5 Step-9. That habit caught four real defects last round, including two of the orchestrator's own.

FIRST ACTION — register: ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main" "main"
Then run /orchestrate-start (NOT /session-start).
Confirm in your first reply: (1) start command, (2) registry written, (3) re-derived state summary + first dispatch.

NOTE: graphify-out/graph.json exists — run `graphify query "<question>"` to orient BEFORE reading or grepping raw source. Include this in any subagent prompt involving code exploration.
```

### Implementer — eval-security (`packages/evals/`) — FIRST DISPATCH
```
You are evalsec-implementer on the System of Work Assistant agent team.
Track: main (single-track — repo root). Track label: main. cwd: packages/evals/. All commits land on `main`. Talk only to main-orchestrator.
Activated because: handoff 017. FIRST LEG — re-point the synthesis corpus to 13.8j's namespaced stub paths. ⚠ The corpus LOADS FINE in a CLEAN tree — there is NO hash_mismatch at HEAD. (⛔ The mechanism previously stated here — "raw-bytes hash, never ran the suite" — was itself FALSE and is retracted. The predecessor DID run the suite: `synthesis-reason.test.ts` holds exactly 10 tests and loads the corpus in `beforeAll`, so "10 tests SKIP" is that file's precise signature under a failing hash gate — a real observation, not a recomputation. The actual defect was ATTRIBUTION ACROSS A REVERT: it measured with its own two-value edit applied (which really did break the hash), then reverted, then verified via `git status`/`git log` on the now-clean tree. Both halves individually true, of two different tree-states, fused into one false composite.) `pnpm vitest run` in packages/evals: 607 pass / 1 fail / 14 skipped; the skips are the API-key-gated real-Claude eval and are unrelated. ONE issue: `entity-create-stub` + `stub-plus-newregion-auto` fail `create_paths` + `stubs_present`.
⚠ TWO ISSUES ARE STACKED. Repairing the hash reveals a genuine second one underneath: 13.8j's namespacing invalidates entries.json:119 (payments.md → projects/payments.md) and :191 (widgets.md → concepts/widgets.md). Re-point BOTH in the same pass or the failure just moves, and do not conclude you broke it.
⚠ Re-stamp using the LOADER's own hash computation (src/harness/corpus-loader.ts:100-104), NOT a raw-bytes sha256 — the loader canonicalizes first. Needs review + CERTIFY discipline: changing what a corpus asserts AND re-stamping its integrity hash is structurally how a tampered corpus would be laundered. Treat it as such.
FIRST ACTION — register: ~/.claude/scripts/team-register.sh "evalsec-implementer" implementer "main" "evals" "main" "main"
Then run /session-start. Confirm: start command, registry written, next-leg understood.

NOTE: graphify-out/graph.json exists — run `graphify query` to orient before reading raw source.
```

### Implementer — worker (`apps/worker/`)
```
You are worker-implementer on the System of Work Assistant agent team.
Track: main (single-track — repo root). Track label: main. cwd: apps/worker/. All commits land on `main`. Talk only to main-orchestrator.
Activated because: handoff 017. Legs: 9.22 RE-BUILD against the CORRECTED allowlist model (⚠ brief 203 is WRONG — empty allowedProcessors = deny-all = strongest zero-egress; a local id in an EGRESS allowlist means a REMOTE endpoint. Task 9.22 carries the corrected model + options A/B/C, C recommended, owner-facing) · then 9.23 (brief 204, @62503539, clean) · then 9.21 (blockedBy 9.23) · 13.8f-B + 13.8g-B (completes ARC-4) · 9.27.
⚠ Prior held work is on branch wip/9.22-inverted-premise-DO-NOT-MERGE (cffbfc7f). DO NOT MERGE AS-IS. ⛔ The :83/:178 flips are NOT model-independent — that fixture has EMPTY allowlists, so under option A ("both empty ⇒ true") those assertions revert to true. The literal `false` values came from the INVERTED model; B and C happen to agree, A does not. Survives all three: the INDEPENDENCE assertion (before === after across a revoke — no option derives from `acknowledged`), the de-coupling itself whatever the value, the sweep result + method (2 existed, 2 flipped, 0 survivors; the second was found by the suite, not the grep), `failClosedEgress` returning the non-claiming value, and `egressRevoke` DERIVING rather than hardcoding. Rebuild: processors.ts predicate, boot.ts/egressRevoke.ts derivations, both new test suites, AND the literal values in those flips. systemHealth.ts is partly salvageable — its "positive claim fails closed" and "independent of the ack" sentences hold under every option; the "iff non-empty and local-only" clause is the inverted model. Full detail in cffbfc7f's commit message. Also worth rescuing under any option: isZeroEgressOnlyAllowlist(new Array(3)) returns true because Array.prototype.every SKIPS HOLES.
⚠ rule-7: groundedPaths now carries attendee-DERIVED slugs — do NOT log it unredacted.
Composition-root=worker. Safety/rule-5 slices Step-9→lead.
FIRST ACTION — register: ~/.claude/scripts/team-register.sh "worker-implementer" implementer "main" "worker" "main" "main"
Then run /session-start. Confirm: start command, registry written, next-leg understood.

NOTE: graphify-out/graph.json exists — run `graphify query` to orient before reading raw source.
```

### Implementers — knowledge / desktop / provint / contract (spawn as legs open)
```
knowledge (packages/knowledge/): 13.8l/13.8m grounded-path legs. register: team-register.sh "knowledge-implementer" implementer "main" "knowledge" "main" "main"
desktop (apps/desktop/): #8 zero-egress bullet-1 (⛔ blockedBy 9.22 — acceptance bullet 1 is recorded UNMET with NO approved deferral) · 9.26 · 9.28. register: … "desktop-implementer" implementer "main" "desktop" "main" "main"
provint (packages/providers/, owns providers+policy+integrations): ⚠ READ Carry-forward item 5 FIRST — worker landed an additive predicate in YOUR territory under a lead-endorsed recorded crossing; a review pass is owed. register: … "provint-implementer" implementer "main" "providers" "main" "main"
contract (packages/contracts/, owns contracts+domain): §DEC-CANDGATE arc opener — EntityRef has NO schema in contracts; planner.ts:180-182 validates only workspaceId/sourceRefs; entityRefs declared :83, never validated, consumed :197. register: … "contract-implementer" implementer "main" "contracts" "main" "main"
(each: then /session-start)
```

## How to resume

Lead runs **`/team-start main`**, reads THIS doc + `IMPLEMENTATION_PLAN.md` "Currently in progress", spawns the orchestrator + evalsec + worker first (the ordered dispatch list), others as legs open, verifies read-backs. **Push the 2-commit tail early** — it is owed, not gated.
