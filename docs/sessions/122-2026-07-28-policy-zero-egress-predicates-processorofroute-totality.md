# 120 — policy: the option-C zero-egress predicates · the third conjunct · `processorOfRoute` totality

**Date:** 2026-07-28
**Track / role:** main · provint-implementer (`packages/policy`, `packages/providers`, `packages/integrations`)
**Predecessor session:** `docs/sessions/119-2026-07-26-desktop-egress-surface-chrome-claim-copilot-omission.md`
_(back-link owed: 119 is another implementer's artifact. Following the precedent 118 and 119 both set, I did not edit it — see Open follow-ups.)_
**Successor session:** _(next `/session-end`)_

---

## What landed

| Commit | What |
|---|---|
| `5571af93` | 9.22 producer half — the option-C two-axis zero-egress predicates, exported from `@sow/policy` |
| `2356e9b4` | 9.22 — the owner-ruled THIRD conjunct (non-vacuity), which the first commit's semantic lacked |
| `ceb42987` | 9.33 — `processorOfRoute` made total; identity read once; `MALFORMED_ROUTE` sentinel never allowlist-satisfiable |

`@sow/policy` **477 pass / 0 fail** at close. `providers` + `integrations` + `contracts` typecheck clean.

### The three exported predicates (9.22)

`LOCAL_PROVIDERS` stays **module-private** — callers ask a question instead of re-deriving membership
(contracts forbidden-pattern #6), pinned structurally and mutation-verified.

- `isLocalOnlyProviderMatrix` — axis 1: matrix NON-VACUOUS **and** `allowedProviders ⊆ LOCAL_PROVIDERS`
  **and** every `capabilityDefaults` route is genuinely loopback-local (`processorOfRoute === null` — the
  routing PROOF, never the `egressClass` CLAIM) **and** `rawCloudEgressEnabled === false` strictly.
- `hasNoApprovedEgressDestination` — axis 2: both allowlists EMPTY.
- `isZeroEgressOnlyWorkspace` — the composed AND.

⛔ **Axis 2 is EMPTINESS, not local-membership.** `egressVeto`'s allowlist step denies an egressing route
absent from `allowedProcessors`, so an empty allowlist denies every egress route — the STRONGEST
zero-egress state. Its fall-through allows a genuine loopback-local route **without consulting the
allowlist at all**, so a local provider never needs to appear there; therefore an entry in an EGRESS
allowlist — `ollama` included — can only mean a REMOTE endpoint approved as a destination. The held
branch predicate (`wip/9.22-inverted-premise-DO-NOT-MERGE`) had this inverted on **both** inputs and was
REPLACED, not repaired. Its test file was struck from salvage (contracts L69 — a tested false assurance
makes the correct fix look like a regression).

---

## Decisions made

1. **The composed AND lives in POLICY, not in worker.** Brief 203 Q3's default put it caller-side; I
   argued that leaves `boot.ts` and `egressRevoke.ts` each combining two predicates — **two sites that
   must independently agree, which is exactly the arrangement 9.22 exists to kill**, relocated one level
   up. Orchestrator overrode their own default vote. "ONE shared derivation" now holds by construction,
   not by discipline.
2. **Non-vacuity requires BOTH halves** (`allowedProviders` non-empty AND `capabilityDefaults` non-empty).
   Either alone reproduces the vacuity one level down: route resolution is SOLELY `capabilityDefaults`,
   so a provider-listed-but-ROUTELESS matrix routes nothing; and a runtime-branch route carries no
   provider and is **exempt from the model's subset refine**, so a routed matrix with no allowed
   providers would otherwise claim local-only with nothing permitted at all. The runtime-branch argument
   is what settled it.
3. **9.33: the identity is read exactly once.** See "The bypass" below.
4. **`MALFORMED_ROUTE` hoisted to one exported sentinel**, with the veto denying on it at step 2b
   **before** the step-3 allowlist comparison. The ordering is the load-bearing part.

---

## ⭐ The bypass found while fixing something else (9.33)

Dispatched defect: `processorOfRoute` brands the route's raw identity, and the brand constructor **throws**
on a blank string — so `{provider: ""}` from a deserialized row escaped as an exception out of `egressVeto`,
which contractually owes a typed `PolicyDecision` (§16). A safety gate that throws where it should deny
hands its caller a crash instead of a denial.

**Underneath it was a live rule-5 bypass.** The identity was read through an untyped view **three times**, so
an accessor-bearing route can answer differently per read: a cloud id at the typeof check, a LOCAL id at the
`LOCAL_PROVIDERS` membership check. That resolves a **CLOUD provider to `null` (NON-EGRESS)**, walking
straight through the veto's loopback fall-through **carrying raw employer content**. Not reachable from a
`JSON.parse`d row (JSON has no accessors), so not exploited in the wild — but a bypass of rule 5's central
check, sitting directly under the function 9.22 had merely worked around at one call site.

**The consumer would never have looked there.** Recorded by the orchestrator as the strongest argument yet
for producer-first sequencing.

### The 13-whitespace-form finding (Step-2.5 Q1, established empirically)

`makeId` rejects `typeof raw !== "string" || raw.trim().length === 0`. `String.prototype.trim` strips **far**
more than the space character: **empty · space · tab · newline · VTAB · FORM FEED · CR · NBSP U+00A0 ·
BOM/ZWNBSP U+FEFF · EN QUAD U+2000 · IDEOGRAPHIC SPACE U+3000 · LINE SEP U+2028 · PARA SEP U+2029** all trim
to empty and therefore all throw.

**A guard written against `""` — which is how the defect reads at first glance — would have missed every one
of them.** So the guard **reuses the brand's OWN predicate** rather than enumerating blank forms: complete
**by construction**, not by a denylist (the unwinnable-denylist pattern this project has retired twice). The
complement (ZWSP U+200B, ZWJ U+200D, NUL U+0000, U+180E — **not** ECMA-262 whitespace) is pinned as ordinary
EGRESS so the set cannot later be read as "anything odd is blank."

### The one semantic flip

`{runtime: "", loopback, local}` previously returned **`null` (NON-EGRESS)** and was **ALLOWED** — it never
threw, because it returned early at the loopback check before ever reaching the brand. An unidentifiable
route was being treated as a genuine local engine. It now classifies EGRESS and denies.

**This is 9.33's ONLY behaviour change**, and it is pinned explicitly. Brief 210's **no-drift pin** — a 10-row
table asserting no *well-formed* route's classification moved, including the tunneled-local hole and a cloud
id claiming loopback — was added **after** the commit had already landed, because "the existing tests still
pass" is a weaker artifact than a pin stating what must not move.

---

## ⚠ Verification found four defects that review did not

Recorded because the pattern matters more than the instances: **three of the four were caught by a count, a
mutation, or a trace — never by reading.**

1. **Vacuous pin (mutation).** The laundering test's getter flipped on read 3, but capture-once performs
   exactly ONE read — so it passed identically with and without the fix. Corrected to flip on read **2**
   (the read a re-introduced re-read performs) plus a direct `reads === 1` assertion.
2. **Vacuous pin, unreachable branch (mutation).** A companion test for the non-string re-read: after
   capture-once no input can reach that branch. **Deleted rather than repaired**, with "deliberately
   unpinned, unreachable by construction" recorded in-code. A green test that proves nothing is worse than
   no test, because it is counted as protection.
3. ⭐ **Syntax-error → `PASS (0) FAIL (0)` (suite COUNT).** Literal control characters in a fixture made the
   test file a syntax error. A syntax-broken test file reports **`PASS (0) FAIL (0)`** — lint clean, run
   "green", nothing red anywhere. Caught **only** because the suite total dropped **466 → 334**. Fixed with
   escape sequences and the reason recorded in-file. **Generalization: a green suite is not evidence a file
   ran — check the count.** A zero-test file and a passing file are indistinguishable otherwise.
4. **Two of my own pins from the base slice silently re-pointed** when the third conjunct landed (see below).

### The conjunct de-fanged the suite

Adding the non-vacuity conjunct made **seven** single-fault tests pass on the NEW check rather than the
condition each was written to pin — every fixture was built on an EMPTY matrix — and would have made **two
totality pins short-circuit before reaching the route scan they exist to exercise**: vacuous while green.
Fixed with a configured `localMatrix()` builder and a re-base of every single-fault test onto it.

**Sharpened generalization:** the hazard is not "old tests go stale." A fixture can be re-based *correctly*
and still silently re-point at the new check — and **a pin written against a guard you just added is as
likely to be vacuous as one that predates it.** Mutate it before you trust it.

---

## Retractions

1. **My own relayed claim — #33 (`ProcessorId` newline injection): RETRACTED, premise not substantiated.**
   I passed a security reviewer's finding upward without tracing the sink. The trace disproved it:
   `refs` persists as a **JSON array in BOTH dialects** (`db/src/schema/audit.ts:37` `text({mode:"json"})`,
   `db/src/schema/pg/audit.ts:20` `json()`; contract `contracts/src/models/audit-record.ts:42`
   `z.array(z.string().min(1))`). A newline is escaped by the encoder and round-trips as ONE element —
   **there is no delimiter to inject into** (verified empirically, not reasoned). Second half also false:
   **nothing logs `AuditSignal.refs`** — zero production log-sink call sites, and
   `worker/src/observability/logger.ts:20` is a structured redacting `LogRecord` funnel, not a
   newline-joined formatter. What survives is LENGTH-unboundedness only: resource-flavoured, not rule-7,
   and applies to every open branded string rather than `ProcessorId`.
   **The lesson is my own framing: a diagnosis written from what the code looks like it does, not from what
   it does.** An overstated open task costs the next reader exactly the time it just cost me.
2. **The axis-independence finding corrected the ruling's stated basis, not just the code.** Option C was
   chosen because "two independent things must go wrong." Provisioning SEEDS both allowlists, so "both
   empty" IS the never-provisioned state — and that same absence leaves `providerMatrix` empty. **One
   missing event zeroed both axes**, and C degraded to A exactly where it was chosen to be stronger. Owner
   ruled: add the third conjunct.

---

## Decisions explicitly NOT made

- **Did NOT squash `5571af93`.** Instructed to amend so the two-conjunct semantic never sat in history. By
  then it was no longer HEAD and the shared tree held four implementers' in-flight slices; a rebase needed a
  clean tree, which meant stashing work that was not mine. Landed a follow-up instead. **Endorsed as correct
  by the lead, and explicitly closed — do not offer the squash later either.** The distinction that matters:
  amending `ceb42987` WAS fine, because HEAD was mine (no rebase, no teammate commit rewritten).
- **Did NOT fix #33.** Held on territory (contracts) + frozen-contract compatibility. Tightening an
  intentionally-open branded string rejects already-persisted `allowedProcessors` values ⇒ a new fail-closed
  crash on the egress path — **the exact shape 9.33 just removed.**
- **Did NOT strengthen the predicate unilaterally** when the axes turned out non-independent. Shipped as
  ruled, documented, pinned, escalated. Strengthening quietly would have been a second inversion in the
  same file.
- **Did NOT fix #32 or #36** — worker territory / needs a deliberate owner ruling respectively.

---

## TDD compliance

**Clean — no violations.** All three commits were RED-first:
- `5571af93`: 18 failing (`is not a function`) before any src change.
- `2356e9b4`: 2 failing (the unconfigured-matrix cases) before the conjunct.
- `ceb42987`: 11 failing across BOTH levels (unit + veto) before the guard.

Every new guard is **mutation-verified**: removing it reddens its own pin. Mutations run and confirmed
caught — length-consistency scan · `ownKeys` try · scan `ownKeys` vs `Object.keys` · blank-identity guard ·
sentinel deny · identity re-read (laundering) · `LOCAL_PROVIDERS` membership · private-set structural pin.

---

## Cross-doc invariant audit

**No Appendix-A model field was added, removed, or renamed this session.** The work added predicates and one
exported sentinel constant to `packages/policy` — not a contracts model. `UiSafeEgressStatus` is untouched
(9.22 changes how one field is *computed*, not the shape).

Doc rows were flagged at Step 9 and the orchestrator confirmed writing them hot:
- `ARCHITECTURE.md §5` — `zeroEgressOnly` is a two-axis derivation; why an empty allowlist is the STRONGEST
  rather than the weakest state; the model-provider SCOPE bound.
- `ARCHITECTURE.md §5` — `processorOfRoute` is total; an unclassifiable route yields the `MALFORMED_ROUTE`
  sentinel; **that sentinel is never allowlist-satisfiable** because the veto denies on it ahead of the
  allowlist step; the `{runtime:""}` flip recorded as the only behaviour change.

---

## Reachability

| Feature | Entry point | Status |
|---|---|---|
| `processorOfRoute` totality + capture-once | `egressVeto` → provider broker (`providers/src/broker/broker.ts:185`) + `worker/src/api/procedures/copilot.ts` | ✅ **REACHABLE — live path** |
| `MALFORMED_ROUTE_PROCESSOR` sentinel deny | `egressVeto` step 2b (`policy/src/egress.ts:144`), before the step-3 allowlist | ✅ **REACHABLE — live path** |
| The three zero-egress predicates | exported via the `@sow/policy` barrel | ⚠ **TESTED, NOT YET CONSUMED** |

⚠ **The predicates have ZERO consumers today** (verified: no non-test importer outside `packages/policy`).
This is **producer-first by design** — the orchestrator dispatched them ahead of worker 9.22 (task #6, still
pending) precisely so worker would not cross into policy a second time. Recorded rather than glossed: a green
suite over an unconsumed export is a silent gap until #6 lands.

⛔ **And even once consumed, `isLocalOnlyProviderMatrix` is currently UNSATISFIABLE in production.**
`defaultWorkspace()` seeds `{allowedProviders: [], capabilityDefaults: {}}` and **no code path writes a
non-empty `providerMatrix`** — the only workspace-config writers are `provisionWorkspace` (which rebuilds
from that default) and `egressRevoke` (which touches `egressPolicy` only). Independently confirmed by the
lead and, separately, by worker during 9.29's trace. So `false` today means **UNKNOWN**, not "cloud egress is
possible" — a surface rendering it as the latter would assert a posture it has not established (the L56
defect facing the other way). Tracked as task #26 / 9.32.

---

## Open follow-ups

| # | Item | Owner |
|---|---|---|
| #6 / 9.22 | **Consume the three predicates** — the producer half is done and waiting | worker |
| #26 / 9.32 | **Nothing writes a non-empty `providerMatrix`** — the predicate's positive branch is unreachable until something does. NOT the same as 9.29 (which stops the *wipe*; nothing does the *write*) | worker |
| #32 | `boot.ts:1186-1187` brands operator-supplied strings with no blank guard — safe ONLY because a desktop-side parser trims and drops empties **one package away**: *guarded by its caller, not by itself* (contracts L66) | worker |
| #33 | **CLOSED — premise not substantiated** (see Retractions). Length-only concern re-scoped; belongs to whoever owns the id-brand family, not `ProcessorId` specifically | — |
| #36 | `assertRedactionSafe` (`policy/src/audit-signal.ts:123`) has **zero production callers**; `isRedactionSafe` runs in production only from KW secret-scanning, **not** on the egress-veto audit path before persistence. Safe-by-construction with no boundary re-check. ⚠ **May well be fine — this needs a deliberate yes/no, NOT a reflexive guard**; an assert that can never fire is its own noise | policy (unassigned) |
| #8 | Desktop's zero-egress rendering must word its copy to the **model-provider scope bound** — these predicates say nothing about connector reads or Tool-Gateway writes, which never consult `egressPolicy` | desktop |
| — | **Back-link owed on 119** (predecessor is another implementer's artifact; not edited, per the precedent 118/119 set) | orchestrator |
| — | `graphify-out/` is untracked and un-gitignored across six directories, repo-wide and pre-existing; `.gitignore` is orchestrator territory | orchestrator |

---

## Process notes worth carrying

- **Shared-tree phantom reds.** Four `validateProjectionVisibility` failures appeared mid-run in my own
  package; they were evalsec's STATE-2 *simulation* (a deliberate constant-DENY to prove a guard was blind),
  reverted moments later. Symmetrically, evalsec saw a `17/20` transient from **my** mid-write state. In a
  shared tree a simulation mutation and a real regression in someone else's territory are indistinguishable
  from the outside. **The cheap converter from phantom to fact: run `git status` before believing a red in a
  package you did not touch** — the failing file was modified, and not by me. Lead's ruling went further:
  **revert-within-turn is the mechanism** (a simulation never survives a turn boundary; longer goes in a
  worktree); announcing is courtesy, not the mechanism, because a protocol resting on a channel that is
  actively compressing and crossing messages is worse than none.
- **Messages crossed dispatches four times** this session (two clearances, two task assignments arrived
  after the work they described was already committed). Each time the correct move was to re-read the brief
  against what had landed rather than declare it done — which is how brief 210's no-drift pin got added at
  all.
- **Corrected a stale test count (449→450) in an orchestrator-authored commit message** rather than
  committing it, flagging instead of applying silently.

---

## How this was built

Producer-first, single-track, on `main`. `/tdd` RED→GREEN per slice; `code-quality-reviewer` +
`security-reviewer=invariant` at Step 8 on every slice (rule-5 throughout); Step-9 routed to the LEAD, not
the orchestrator, per the safety-slice rule. Mutation-testing every invariant pin **inside** the slice was
the practice that caught what review passed — twice.
