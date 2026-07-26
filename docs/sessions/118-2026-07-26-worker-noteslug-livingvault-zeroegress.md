# 118 — worker: #54 noteSlug re-point · 13.8d living-vault binding · 9.22 held on an inverted premise

**Date:** 2026-07-26
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/117-2026-07-26-arc4-keystone-completion-13.8fgjk-knowledge.md`
_(back-link owed: 117 is another implementer's UNCOMMITTED file and they may still be live in it, so I did not edit it — see Open follow-ups.)_

---

## What landed

| Task | Commit | Summary |
|---|---|---|
| **#54** noteSlug re-point | `f67d3720` | The duplicated `neutralizeRegionMarkers` in `packages/workflows` retired to a re-export of the canonical `@sow/knowledge` definition. |
| **13.8d** living-vault worker-binding | `172f9aed` | `rewriteVaultForSource` bound into `runSourceIngestion` behind a default-OFF flag, AUTO tier only, realpath-contained, dormant. |
| **9.22** zeroEgressOnly truthful pin | **— HELD, nothing committed** | Implemented + green, then escalated: the brief's premise is inverted. See below. |

---

## #54 — the neutralizer lives once (`f67d3720`)

`packages/workflows/src/activities/projections/noteSlug.ts` carried a second definition of
`neutralizeRegionMarkers` plus its own `REGION_MARKER_RE`, duplicating the canonical pair that #51 made
authoritative in `packages/knowledge/src/markdown-vault/sections.ts`. Retired to an import + re-export via
the **deep subpath** `@sow/knowledge/markdown-vault/sections` — deliberately not the barrel, which would
drag KnowledgeWriter + the fs vault watcher + `@sow/db` into the projection activities and the worker
composition root for one pure string function. That rationale is now in-code so a future "tidy the import"
doesn't undo it.

**Not a pure no-op, in the safe direction.** The two matcher literals are byte-identical including flags
(security-reviewed — no forge vector opens), but the canonical implementation escapes *every* `<!--` in a
matched span (`replaceAll`) where the retired copy escaped only the first (`replace`). Same fixpoint
post-condition; strictly more escaping on nested marker-shaped input. Recorded rather than left to be
rediscovered as a mystery diff later.

Pinned three ways, because a name-grep pins the NAME and not the DEFENSE: referential identity to the
knowledge symbol, a DEFINITION census covering `function` **and** `const` forms, and a MATCHER-LITERAL
census. The narrow `export function <name>` census the brief proposed would have missed both an
`export const` re-fork and the very `export { … }` re-export shape this slice introduced.

## 13.8d — living-vault binding, AUTO tier only, dormant (`172f9aed`)

Optional `SourceLivingVaultPort` on `SourceIngestionDeps`; step-6b consults it, step-7b commits the
resulting plans through the existing KnowledgeWriter path. Chosen over the brief's default of swapping a
rewriting `SourceBuildOutputsPort` implementation, because `MeetingBuiltOutputs` carries a **single**
`plan` and is shared with meeting-closeout + hermes — routing a ≤2-plan set through it would have meant
widening a shared contract seam. Orchestrator accepted the pushback.

**⚠ The safety defect this slice nearly shipped.** My first implementation committed every plan the
rewrite returned. The planner emits up to two, one carrying `requiresApproval: true` (human-relevant
frontmatter/status edits), and **nothing downstream re-reads that flag** — `createCommitActivity` and
`applyPlan` both ignore it. So "commit the plans the producer returned" would have silently auto-applied
the human-gated tier, bypassing §9.8 Approvals by an *absent* check rather than a wrong one. Fixed to
AUTO-tier-only with strict `!== false ⇒ withhold` (a malformed or older plan shape must not read as
pre-approved), withheld plans surfaced rather than dropped. The brief's acceptance bullet — "the
multi-entity plan set reaches the step-7 commit path" — specified the bypass; following it literally would
have shipped it. Now banked as **L57**.

Four more defects caught by the reviewers and fixed in-slice: `provenanceOrigin: "source_ingestion" as never`
was not a `ProvenanceOrigin` member (the cast was the only reason it compiled; since `rewriteVaultForSource`
is TOTAL it would have failed the plan schema *inside* the planner and surfaced as "armed, spends, produces
nothing" — the L64 class); `vaultRoot: ""` armed the gate and made containment `resolve("")` to the worker
CWD, reporting every path contained; the containment ancestor-walk climbed past `EACCES`/`ELOOP`, reporting
"contained" for a path it never resolved; and two genuine coverage gaps — non-`creates` mutation kinds were
unpoliced by any test, and the symlink test used an *existing* file so the real CREATE-case ancestor walk
never ran.

Ships **dormant and inert by absence as well as by flag**: `gateLivingVaultRewrite` has no `bootWorker`
call site and nothing constructs `IngestRewriteDeps`. Both are named arming prerequisites in-code, not
implied wiring — my first draft's comments read as though the wiring were live, and I corrected them after
the reviewers flagged it.

---

## 9.22 — HELD: the brief's premise is inverted (⚠ rule-5)

**Nothing committed, nothing staged.** Implemented as briefed, went green (worker 1981/1981, policy
431/431, `turbo typecheck` 20/20), and the Step-8 reviewers independently found the model was wrong. I
verified it in source before escalating rather than relaying the subagents.

### The evidence

- `packages/policy/src/egress.ts:138-144` — an EGRESSING route (`proc !== null`) with an **empty**
  `allowedProcessors` ⇒ `PROCESSOR_NOT_ALLOWED` deny. **Empty allowlist = every egress route denied**,
  which is the strongest zero-egress state there is.
- `packages/policy/src/egress.ts:158` — a genuine loopback-local route (`proc === null`) hits the
  fall-through allow **without consulting the allowlist at all**.
- `packages/policy/src/processors.ts:437` — `processorOfRoute` returns `null` for a local provider on a
  loopback endpoint, so it never becomes a `ProcessorId`.
- `packages/contracts/src/models/egress-policy.ts:34-36` — the seam model says it outright: *"Local
  Ollama/LM Studio are non-egress and are **never required processors**."*

### Why that makes the shipped-as-briefed predicate wrong at both ends

- `[]` — the true zero-egress state — the brief maps to **false**. Every real workspace is in this state
  (`provisionWorkspace.ts:64/72` seeds `[claude]` or `[]`), so the field would be permanently false in
  production. Vacuous.
- `["ollama"]` — the brief maps to **true**. But a local id can only be in an allowlist because
  `processorOfRoute` classified that route as **egressing**, i.e. a *remote* ollama endpoint approved as a
  destination — the tunneled-local hole `processors.ts:7-9` exists to close. So it would claim "local-only"
  for precisely the config meaning remote-ollama receives content, raw included. **The same false-assurance
  class 9.22 exists to kill, re-created one layer down, laundering `LOCAL_PROVIDERS` in the way its own
  comment forbids.** Not reachable today, but `SOW_EGRESS_ALLOWED_PROCESSORS` is an operator-set free-string
  comma-split (`boot.ts:1206`), so `SOW_EGRESS_ALLOWED_PROCESSORS=ollama` is one env var away.

### Root cause (recorded because it's the reusable part)

The orchestrator's Q1 ruling — *"empty ⇒ false; unconfigured must never read as a guarantee"* — is sound
reasoning applied to the wrong state. **For this field, empty doesn't mean unconfigured; it means
deny-all.** My Step-2.5 accepted it and was correct to; the specification was the thing that was false. The
general form: when a brief tells you what a state *means*, verify that against the code that *acts* on the
state, not against the field's name.

### The three options, as framed for the re-brief

- **A — both allowlists empty ⇒ true.** Minimal; matches the veto exactly. Cost: "unprovisioned" and
  "deliberately local" become indistinguishable — the original Q1 worry — though under real semantics both
  genuinely deny all egress, so it is not a false claim.
- **B — derive from `providerMatrix`** (`allowedProviders` ⊆ `LOCAL_PROVIDERS`, `capabilityDefaults` routes
  loopback-local, `rawCloudEgressEnabled` false). This is the state that actually "pins the workspace to a
  local provider" — closest to the doc wording the task set out to honor.
- **C — B AND the allowlists empty (recommended by impl + orchestrator, escalated to lead).** The routing
  pins local, and nothing may egress even if a route were added. Fail-closed on both axes.

B and C widen scope into `providerMatrix`, which brief 203 never authorized — hence the hold rather than a
unilateral rebuild.

### Work completed but deliberately uncommitted

`packages/policy/src/processors.ts` (`isZeroEgressOnlyAllowlist`) · `apps/worker/src/boot.ts` (derivation +
`failClosedEgress` flipped to the non-claiming value) · `apps/worker/src/composition/egressRevoke.ts`
(second-producer de-duplication, per orchestrator ruling) · `apps/worker/src/api/procedures/systemHealth.ts`
(doc alignment) · 2 new test files + corrections in `egressCommands.test.ts`.

### Two findings from 9.22 that outlive it

1. **A second producer of the same false assurance.** `egressRevoke.ts:84` returned a hardcoded
   `zeroEgressOnly: true` after a revoke, kept in sync with the reader **by comment** — and that comment
   (`:81-83`, "keep this in sync if that reader's derivation ever grows") went stale the moment the
   derivation grew. A comment is not a mechanism. It fires immediately after an owner revokes, i.e. while
   they are reading the posture to confirm a safety action landed. Found by sweeping the CONCEPT ("who
   states a local-only posture"), not the identifier.
2. **Two pre-existing rule-5 test assertions were pinning the false assurance** (`egressCommands.test.ts`
   `:85` full-object `toEqual`, and `:184`). That is worse than an untested path: it makes the correct fix
   look like a regression, so the next person sees red and backs out. **Method note:** the second one was
   found by the *suite*, not the sweep — an assertion defending old behaviour only reveals itself once the
   behaviour actually changes. Grep finds the ones you can name; a full-suite run after each producer fix
   finds the ones you can't. Assertion sweep result: **2 existed, 2 flipped, 0 survivors**; 4 fake-returns
   triaged as legitimate under both old and proposed semantics; 1 stale desktop comment flagged, not touched.

---

## Decisions explicitly NOT made

- **9.22's corrected semantics (A/B/C)** — escalated to the lead; a rule-5 semantic that renders a safety
  claim to the owner should not be settled under seal pressure.
- **The four model-independent 9.22 defects** — deliberately left unfixed so they land with the corrected
  semantics rather than being churned twice.
- **Routing withheld PROPOSE plans into §9.8 Approvals** (13.8d) — surfaced only for now; the real
  completion of the tier split.
- **13.8d arming** — the boot call site and `IngestRewriteDeps` construction are named prerequisites, not
  attempted.

## TDD compliance

**Clean — no violations.** Every slice went RED-first with the failure verified for the right reason.

Two notes for honesty rather than as violations: (1) in the 9.22 policy suite one test initially failed for
the *wrong* reason — `processorId("")` throws at construction — so I corrected the test to build the junk
value the way a real boundary would (a deserialized row), per Step 3's "fix the test if it fails wrong".
(2) For 13.8d I verified RED per-test via the JSON reporter after a grep undercounted failures; my
strongest pin (`ack_and_zero_egress_are_independent`, and the 13.8d equivalents) was confirmed genuinely
failing rather than assumed.

## Cross-doc invariant audit

**No Appendix-A model field changes this session.** `SourceIngestionDeps` grew an optional field but is a
workflows-layer type, not a seam model (brief 199 states this explicitly). `UiSafeEgressStatus` keeps its
three fields — only the *meaning* of one was to change, which is why 9.22 needed no frozen-contract round.
Nothing required a Step-9 cross-doc flag that did not get one.

## Reachability

- **#54** — no new entry point (de-duplication). The re-export resolves for all existing production callers
  (`noteSlug.ts:36/94`, `meetingOutputs.ts:165/217`, `projectSyncOutputs.ts:159/160/204`, worker
  `buildActivities.ts:178`, `copilotProposeKnowledge.ts:42`, `semanticMutationDispatch.ts:60`); proven by
  both packages' typechecks.
- **13.8d** — reachable from `sourceIngestionWorkflow` (the only production entry into the driver) →
  `activities.sourceLivingVaultRewrite` → `createLivingVaultActivity(params.livingVault)`. **Reachable,
  arming-gated, dormant**, and inert by absence as well as by flag.
- **9.22** — not shipped.

## Open follow-ups

1. **9.22 re-brief against the corrected model** (A/B/C; C recommended) — lead decision pending.
2. **The four model-independent 9.22 defects**, to land with it:
   - ⚠ `isZeroEgressOnlyAllowlist(new Array(3))` returns **true** — `Array.prototype.every` skips holes,
     breaking its own documented "malformed ⇒ false" totality. A **sparse-array hole in an exported safety
     predicate**; generalizes past this slice.
   - `boot.ts:552` docstring still says fail-closed means "zero-egress ON", contradicting `failClosedEgress`
     10 lines below.
   - `egressRevoke.ts:39` header still states the removed `ack=false ⇒ zeroEgressOnly=true` formula.
   - `revoke_return_agrees_with_the_visibility_reader` is single-fixture and vacuous (both sides `false`);
     needs parametrizing across the predicate's range. The `err` fake uses `{kind}` where `DbError` is `{code}`.
3. **Desktop stale rationale** (`egress.tsx:15-21`, `egress-settings-page.test.tsx:221`) still describes the
   producer as `!employerRawEgressAcknowledged` and cites a dead line. ⚠ Both reviewers warned 9.10-C must
   **not** flip it to "now truthful" until 9.22's semantics are settled.
4. **13.8d:** route withheld PROPOSE plans into §9.8; `IngestRewriteReceipt.planIds` (the documented
   batch-undo unit) is currently dropped by the binding; the two arming prerequisites above.
5. **13.8d accepted residuals:** a mid-loop commit failure can leave AUTO-plan parity half-applied (bounded,
   converges on re-drive, each plan individually atomic); TOCTOU between containment and KnowledgeWriter's
   `join(root, path)`; one inert activity round-trip on the dormant Temporal path.
6. **Session-doc back-link** from 117 to this file is owed — not written because 117 is another
   implementer's uncommitted file and they may still be live in it.
7. **#54 doc guard:** `packages/contracts/CLAUDE.md` forbidden-pattern #6 — orchestrator has already
   broadened it to mirror the three-way census.

## Preflight

- **`turbo typecheck` — 20/20 GREEN** (repo-wide, including the packages my uncommitted 9.22 work touches).
- **`turbo test` — 17/20, one failure, NOT from this session and NOT in worker territory:**
  `@sow/evals` `suites/synthesis/synthesis-reason.test.ts` fails to load its corpus with
  `hash_mismatch` — `corpora/synthesis/manifest.json` pins
  `sha256:09f8491b…` while `entries.json` actually hashes to `sha256:03ff8fc3…`.
  **Both files are committed and unmodified in the working tree** (`git status packages/evals` is clean
  apart from untracked `graphify-out/`), so this is RED on committed HEAD for everyone, independent of any
  in-flight work — a corpus pin and its data drifted apart at or before `a34de8e1`. Eval-security
  territory; raised for routing, not touched.
- Worker 1981/1981 · workflows 580/580 · policy 431/431 · knowledge green.

## How this was built

Three `/tdd` cycles. The two that mattered both turned on the same move: **checking a specification against
the code that acts on it, rather than against its own wording.** 13.8d's brief named a destination ("the
plan set reaches the commit path") without noticing that `requiresApproval` was inert at every layer below
the driver; 9.22's brief named a meaning for `allowedProcessors` that the egress veto contradicts. In both
cases the tests were green against the wrong model before the check was run.
