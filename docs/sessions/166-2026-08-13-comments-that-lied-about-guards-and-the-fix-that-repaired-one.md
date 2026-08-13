# Session 166 — worker: comments that lied about guards, and a fix that made one true

**Date:** 2026-08-13 · **Track:** `main` · **Role:** worker-implementer · **Predecessor:** `163` · **Successor:** _(none yet)_

## Why this session existed

Two comment-truth slices in the `### 24.62` / `### 24.26` family. Both are the same underlying object: **an artifact asserting a safety property that the code beneath it does not have.** Neither was an incident; both were caught before anything could rely on them.

## Shipped

| task | commit | what |
|---|---|---|
| `#50` / `### 24.62` | `7ad1bd26` | the denial-audit notices carry only what their comments claim; the unscanned second channel leaves the log sink |
| `#56` / `### 24.26` residual | `ad0224f1` | four comments called a now-load-bearing rule-4 guard "inert"; two dangling citations retired |

Suite at close: **worker 2099 passed / 0 failed**; full workspace **7638 passed / 0 failing tests**, one failed *file* = known-red `apps/desktop/test/bundle/main-bundle-resolution.test.ts` (`### 24.25`, unowned). `turbo typecheck lint --force` **31/31, 0 cached**.

## ⛔ I committed the slice's own defect while fixing it

Justifying why `event` may stay on the append-failure line, I wrote *"the gate PASSED, so all six scanned fields are clean."* `packages/policy` had **already retracted exactly that inference** at `### 24.45`: `isRedactionSafe` is a **credential-shape heuristic, not a shape allowlist** — an employer codename or a person's name passes it. Gate-passed means only *"did not look like a leaked secret."*

⭐ **I wrote that eleven lines below my own sentence warning that "the next producer inherits the reasoning, not the audit."** The security reviewer caught it. Fixed by scoping the claim to the checkable fact — `event` is a string literal at all three reachable producers — and marking that a **call-path property, not a type one**.

⇒ **Convention adopted: cite what a gate TESTS, never that it PASSED.** It is the actionable form of `contracts L147`: a passing heuristic is not a validated shape, and the citation reads stronger than the guarantee.

## ⭐ The counter-example: a fix that made a previously-false comment TRUE

`packages/knowledge`'s `projection.ts` cited `boot.ts` as **the precedent its parameterless `onRefused` matches** — and that precedent **actually leaked `event`**, so the two disagreed. After `7ad1bd26` they genuinely agree.

**Every other finding this round was an artifact decaying into falsehood. This is one decaying into truth**, and nothing reported it either — the asymmetry is the point, not the direction.

Same slice also **falsified** two knowledge comments (`gcl-projection.test.ts`, which cites the old "event name only" refusal log as its unsafe contrast). Knowledge territory; routed, untouched.

## Findings that outlived their slices

- ⛔ **Cross-package comment falsification has ZERO local signal.** All four `#56` comments were **true when written** and were falsified by a change in **another package**, with no edit to the files carrying them and **nothing going red**. No test could catch it; no reviewer of the knowledge-side change had reason to re-read a worker comment. `contracts L134`'s shape in comments rather than switch statements.
- ⛔ **A comment asserting a guard is INERT is safety-relevant in the FAIL-OPEN direction.** Rot that *overstates* a guard makes the next reader cautious; rot that *understates* one invites deletion. All four understated a live rule-4 / WS-8 guard. **The lead extended this beyond comments: any artifact asserting inertness — tracker dormancy gradings, "latent not live" qualifiers, fences — carries the same invitation, so an inertness claim must also state what makes it load-bearing, or when.**
- ⭐ **Two citation failure modes, one slice, and they are not equally bad.** `workspace-path-guard.ts:183` is **past end of file** (163 lines) ⇒ resolves to nothing ⇒ **gets investigated**. `writer.ts:225` **still resolves**, onto unrelated doc prose ⇒ **reads plausibly** ⇒ **gets believed.** The second is worse.
- ⛔ **A stale-citation cluster, measured not estimated: 11 citations across 8 artifacts** use `boot.ts:588` / `boot.ts:578-592`; several name `egressStatus`/`isZeroEgressOnlyWorkspace`, which live at `:641`/`:678` — a **different function**. Carriers include `packages/contracts/CLAUDE.md`'s `L106` index row and `LESSONS.md`. **Pre-existing, not caused by my slices**, though `7ad1bd26`'s +76 lines shift them again. ⚠ **I verified TWO and deliberately did NOT classify all 11 — a partial list must not be read as a census.**
- **The brief's premise was wrong in my favour and I corrected it before review.** Brief 278 said `workspaceId` is "registry-validated at both call sites." Backward-tracing rather than trusting it: call site 2 (`copilotAgentSynthesis.ts`) resolves **nothing** — its guarantee is **inherited** from having exactly one production caller, which nothing type-checks. Stated in-code as a call-path property.
- **A fourth `#56` site nobody scoped** — `legacy-workspace.ts`'s `⛔ LIFECYCLE` block, a future-tense forecast of a completed step 3. ⚠ It is **the block whose job is to stop deletion of the exempt-id const**, so a reader taking it as pending may take the const as transitional: the fail-open direction pointed at the guard's own guard.

## Decisions made

- **`24.62` Q1 — drop `workspaceId` from the log line; do NOT validate-or-omit.** A shape check could only catch a *credential-shaped* id, and the residual class (employer codename, person's name) is not shape-distinguishable — shipping one would read as coverage of a class it cannot cover. The durable record keeps the raw id: attribution is its purpose and it is the WS-8 query key. **Not a split concept — it tracks safety rule 7's own boundary, which names log sinks.**
- **The refusal notice becomes a pure counter, knowingly.** Mirrors `24.53`'s `onRefused`, which discharges by signature. The useful form (naming *which* of the six fields was unsafe — field names are a closed literal set, not content) needs a `packages/policy` predicate: **filed, not built.**
- **`#56` citations replaced by symbol + commit hash, zero line numbers** (`### 24.71`). **The erratum describes the two dead citations without reproducing them** — quoting a dead line number leaves exactly the string a future dangling-citation sweep hunts for (`contracts L104`: a checker cannot distinguish a use from a mention).
- **Fixed three comment blocks in `24.62` where the brief scoped two**, and **four sites in `#56` where the dispatch named three.** In both cases the unscoped site was the authoritative one.

## Decisions explicitly NOT made

- **No severity escalation on `24.62`,** and none was sought. Neither line is caller-reachable; I have no backward call-path trace from either to a caller-controlled input, and neither did the security reviewer. Two people had already retracted "LIVE" on this task.
- **The `workspace_config` write-path question** (who may insert a row) — untraced, filed, not answered here. It is what bounds the provenance guarantee's strength.
- **The 11-citation cluster** — measured and routed, **not** swept. Tracker + contracts ledger are not worker territory, and a partial classification would have become a census by citation.
- **`#56`'s one instruction-shaped comment** (`legacy-workspace.ts`'s *"do NOT delete it"*) was fixed in place, not routed: it is a **prohibition whose imperative strengthened** — the opposite of the desktop case, where a comment instructed an action the new rule forbids. Judgment flagged for override rather than taken silently.

## TDD compliance

- **`#50` — CLEAN.** Three tests written first (Step 2), RED confirmed for the right reasons at Step 3 (assertion mismatches, not import/syntax), implementation at Step 4. **Four mutations run, each observed RED then reverted**, incl. one proving the reviewer-found `String(obj)` → `"[object Object]"` vacuity hole is genuinely closed by `JSON.stringify`.
- **`#56` — TDD-EXEMPT, declared not skipped.** Comment truth has no runtime surface. **No test was fabricated to satisfy the ceremony**; the load-bearing claim was bought with evidence instead — omitting the `workspacePathCheck` line yields `TS2741: Property 'workspacePathCheck' is missing … but required`, reverted. Exemption was flagged to the orchestrator and the lead before commit; both acknowledged.
- **No TDD violations.**

## Cross-doc invariant audit

**Clean.** No model in `packages/contracts/CLAUDE.md`'s cross-doc table had a field added/removed/renamed this session. `AuditPersistPort` is a port, not a frozen model, and **its signature was deliberately untouched** — the COMMENTS-ONLY ruling scoped `24.62` so that no contract surface moved. Nothing owed to `ARCHITECTURE.md`.

## Reachability

- **`createAuditPersistPort`** — LIVE. `bootWorker` → `createAuditPersistPort` → `copilotAuditPersist` → `runGovernedCopilotSynthesis` (egress-veto DENY) and the agentic `synthesize` (ING-7 DENY). Confirmed at Step 7.5; both call sites re-read at source.
- **`#56`** — no new code; the annotated lines are the two existing worker `KnowledgeWriterDeps` composition sites, both reachable and both now the sole enforcement of the workspace-path guard on their paths.
- **No tested-but-unwired gaps introduced.**

## Open follow-ups

- **`#59`** — a refusal notice naming WHICH of the six scanned fields was unsafe. Reviewer measured the predicate at **~5 lines** in `packages/policy`; the deferral should not read as larger than it is.
- **`#63`** — nothing pins that the SUPPLIED exempt workspace id is the RIGHT string. A required parameter type-checks **presence, never the value** (`worker L28`; on the sibling literal a wrong-id change left 2095 tests green). ⚠ Scope deliberately unasserted — `24.26` step 2 closed `buildActivities.ts` with a mutation-verified source pin, and which *other* sites are unpinned has not been measured.
- **The 11-citation `boot.ts` cluster** — routed to the orchestrator + lead; `packages/contracts` ledger and the tracker are the carriers.
- **Two `packages/knowledge` comments falsified by `7ad1bd26`** (`gcl-projection.test.ts`) — knowledge territory, routed.
- **`docs/briefs/275`** lines 27/63 still say *"mirror `:588-591`"*; its line 19 already carries an erratum, those two do not. Orchestrator territory.
- **Minor:** both `[copilot.denial-audit]` notices share a prefix while now having *opposite* content policies, and nothing in the emitted text distinguishes them.

## Traps re-confirmed this session

- ⛔ **`rg` is intercepted here** — it is rewritten to BSD `grep` (errors on `--type`) and on a miss can return memory-search results that look like file hits. **Every search this session carried a non-vacuity control.** Also: zsh globs an unquoted `--include=*.ts`.
- ⛔ **`turbo` cache** — `--force` used throughout; **task count checked, not just error count** (`8/9` during a deliberate mutation is the tell that dependents halted).
- **`git commit` receipts** — every commit verified with `git log --oneline -- <path>` per path plus `git show --stat`, never from the receipt.
