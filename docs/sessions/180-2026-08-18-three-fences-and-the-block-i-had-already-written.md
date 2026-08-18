# Session 180 — three fences, and the block I had already written

**Date:** 2026-08-18 · **Phase:** 24 (hardening tail) · **Area:** `apps/worker` (`worker-implementer`, single-track `main`)
**Predecessor:** this area's prior session — `176-2026-08-18-two-slices-with-zero-production-delta-and-a-mutation-that-never-applied.md`
**Successor:** _(none yet)_
**Tasks:** `### 24.102` · `### 24.84` (worker leg) · `### 24.112` (fence only)
**Briefs:** `docs/briefs/296-24.102-egress-status-output-sink-redaction.md` · `docs/briefs/297-24.84-worker-leg-brand-at-create.md` · `### 24.112`'s `#### ⛔ FENCE TEXT` block (no brief file — the committed entry was the spec of record)
**Commits:** `92342035` (`### 24.102`) · `61d9e02c` (`### 24.84` worker leg, both halves) · `7cc3f22e` (`### 24.112` fence)
**Session-doc number `180` was ASSIGNED by the orchestrator** from committed history, not computed here — the TOCTOU rule from `178`'s banner.

---

## Why this session existed

Two tasks were gate-verified OPEN at HEAD in worker territory, both rule-7: `### 24.84`'s worker leg (`WorkspaceIdSchema` defined but never enforced at create) and `### 24.102` (a bare TS interface on a rule-7 output sink, erased at runtime). A third — `### 24.112` — was created *by* this session's first slice and fenced by its third.

---

## What was built

**Files created:** none. Three temporary measurement probes were created, used, and deleted within the session (see "Controls that existed and were deleted").

**Files modified:**
- `apps/worker/src/api/procedures/systemHealth.ts` — `toUiSafeEgressStatus` now redacts the renderer-bound `workspaceId` through `redactString` (`@sow/domain`) behind a `typeof` totality guard; two docblocks corrected; later gained one pointer line to `### 24.112`.
- `apps/worker/test/api/procedures/systemHealth.test.ts` — 18 pins added (7 pre-existing suites untouched).
- `apps/worker/src/api/procedures/onboarding.ts` — `parseCreateWorkspace` runs `WorkspaceIdSchema.safeParse` and provisions `parsedId.data`; new refusal code `CREATE_WORKSPACE_ID_SHAPE`; the discard of `parsedId.error` documented at the site.
- `apps/worker/test/api/procedures/onboarding.test.ts` — 5 pins added.
- `apps/worker/src/api/procedures/egressCommands.ts` — the `### 24.112` fence, as JSDoc, plus an orchestrator-authored precondition paragraph.
- `packages/policy/src/visibility.ts` — **not this author's work.** 35 lines authored verbatim by `main-orchestrator`, transcribed unmodified under a lead ruling, riding in `61d9e02c` because the code change in that commit is what expires the ground it replaces.

---

## Decisions made

1. **`redactString`, not `isRedactionSafe`, at the egress-status sink.** Established rather than assumed: `isRedactionSafe` is a *predicate* — its only dispositions are refuse or pass-through-unchanged, and refusal is the availability break the owner priced and rejected. `redactString` *substitutes*, so the response is still served. Both of the predicate's call sites were confirmed to gate an **audit write**, not an output; nothing on this path redacted output before `92342035`.
2. **Measure the redactor against real fixtures before writing any assertion.** All three live ids and both known legacy shapes pass byte-identical; credential shapes go to `[REDACTED:credential]` or `[REDACTED:field-dropped]`. This made the availability guarantee *measured* rather than predicted — and incidentally showed the remedy is invisible to the desktop's `foldStatus` equality check for the entire benign population.
3. **Gate, don't re-type, at `parseCreateWorkspace`.** Re-typing `CreateWorkspaceInput.id` to the branded `WorkspaceId` ripples into `provisionWorkspace` and the contracts seam; the brief scoped this leg to *enforcement*.
4. **A distinct refusal code (`CREATE_WORKSPACE_ID_SHAPE`).** "No id supplied" and "id supplied, wrong shape" are different audit facts. Verified no consumer switches on these codes, so a seventh member cannot be silently absorbed by a `default:`.
5. **JSDoc, not `//`, for the `### 24.112` fence** (orchestrator ruling on this session's measurement). `//` never appears in TypeScript quick info; only JSDoc does. Under `//`, hovering the function would have surfaced *only* the existing "mirrors `systemHealth.ts`'s `toUiSafeEgressStatus`" claim and suppressed the correction three lines below it.
6. **No third copy of the fence in `systemHealth.ts`** (orchestrator ruling). Its existing `### 24.102` JSDoc already carried every clause; it gained one pointer line instead.

---

## Decisions explicitly NOT made

- **The `### 24.112` design tension is unresolved and the box is OPEN.** The read path wants the value redacted; the write path needs the returned id to match for its own fail-closed compare. Deferred to the arming gate by lead ruling. This session shipped only the guard against resolving it wrongly.
- **`### 24.84` is NOT ticked, and must not be.** Its Done-when bullet 2 rests on an OPEN id set, and this session's own `scopeForType` finding made that premise contingent. The leg is landed at `61d9e02c`; do not re-dispatch it either.
- **The `egressCommands.ts` docblock's bare "mirrors" verb** was left untouched — out of scope for a fence-only dispatch, flagged instead.
- **Nothing in `apps/desktop`** — `### 24.108` owns `foldStatus`.
- **`packages/policy`'s two diverging heuristics** were not fixed; that is providers-integrations territory (`### 24.110` / `### 24.118`).

---

## TDD compliance

**Two deviations, both stated rather than smoothed.**

- **Slices 1 and 2 opened RED-first and correctly.** `### 24.102`: 3 of 6 pins RED-first, 3 green-on-arrival regression guards — reported as such at Step 2.5 and never counted as RED. `### 24.84`: 2 pins RED, failing at `expect(isErr).toBe(true)` receiving `false` (i.e. the create *succeeded* with a non-conforming id) — the defect reproduced, not a fixture error.
- ⚠ **DEVIATION 1 — review-driven additions were written alongside their implementation, not before it.** The `typeof` totality guard in `toUiSafeEgressStatus` and its 4 pins landed in one pass, as did the `max(64)` table row. Neither was test-first. **Mitigation, and it is not a substitute:** each was mutation-proven afterwards — removing only the totality guard reds exactly the 4 non-string pins; substituting a charset-only predicate reds exactly the table pin. That establishes the pins are not blind, which is what RED-first would have established, but it establishes it *after* the fact.
- ⚠ **DEVIATION 2 — `### 24.112` has no tests at all, by nature.** Comment-only, 0 non-comment lines changed, no behaviour delta. `/tdd`'s own "When TDD doesn't fit" covers it. ⛔ **But the security review measured something that belongs here rather than in a footnote: `egressCommands.test.ts` exercises the *port*, not the router projector, and its fixture id is benign — so no existing test would catch the edit the fence forbids. The fence is currently the only guard.** That is a coverage gap the fence documents rather than closes.

**No TDD violation on anything safety-critical in the RED-first sense** — every behaviour change in slices 1 and 2 had a failing test first.

---

## Reachability

- **`### 24.102`** — reachable from `apps/worker/src/api/server.ts:135`, which mounts `buildSystemHealthRouter` into the composed root router. **Every** `egressStatus` response passes through `projectEgressStatus → toUiSafeEgressStatus`; the changed line is unconditional, not flag-gated. Consumed live by `apps/desktop/renderer/lib/egress-status.ts`.
- **`### 24.84` worker leg** — `parseCreateWorkspace` is the input parser on the mounted `onboarding.createWorkspace` mutation; every create passes through it. Verified as reachability, not as "it has callers".
- **`### 24.112`** — no executable surface; the fence's reachability question is *legibility*, answered by the JSDoc ruling.

**No tested-but-unwired features this session.**

---

## Cross-doc invariants

**NONE changed — checked against the `packages/contracts/CLAUDE.md` table, not assumed.** `UiSafeEgressStatus` is explicitly not a frozen seam model (its own docblock says so); `CreateWorkspaceInput` is a worker-local interface. No model in the table had a field added, removed, or renamed. `NONE` was flagged at both Step 9s and the orchestrator confirmed.

---

## ⭐ The near-miss worth carrying: familiarity read as coverage

At `### 24.112` I reported that the new `systemHealth.ts` fence was **"largely a duplicate"** of the block already there. The orchestrator read the existing block and found it a **complete** one — it already carried every clause, including the one I had not matched up: its *"it covers ONE producer"* **is** the fence's *"a property of THIS PRODUCER, not of `UiSafeEgressStatus`"*, in different words.

⇒ **I compared the two texts by their SURFACE; the deciding comparison was by their CLAIMS.** Two sentences that share no phrasing can make the same assertion, and a diff cannot see that — only reading for meaning can.

⛔ **And the aggravating fact is that I wrote the existing block myself, one slice earlier.** That made me the reader *least* likely to notice it already said everything: I recognised it instead of reading it. **Familiarity presented itself as coverage** — I knew what was there, so I did not check what it said. A stranger to that block would have read it properly.

⚠ **Had it landed, `systemHealth.ts` would have carried three statements of one rule under three task numbers, and whoever eventually resolves the tension would have had to find and retire all three.** The one that would have rotted is the one I would have been asked to explain.

---

## ⚠ Instrument findings this session

1. ⛔ **`git commit` printed the literal `ok`** instead of `[main <hash>] <subject>` — admitted to `### 24.122` as anomaly 6, and it retires the narrow reading of anomaly 1 (`ok` is not a `status` quirk; the same token appeared on a second verb). **Discriminating checks run BEFORE claiming it** (`L202`): `ok` is not a valid git commit output format · earlier commits *in this same session* printed the normal form, so the behaviour changed between invocations · and the operation itself was verified correct independently via `git show --numstat`. ⇒ **the operation was right and only the report was wrong.** **Consequence: "did my commit land?" cannot be answered from `git commit`'s own output in this checkout.**
2. ⛔ **cwd persists across tool calls, and it bit three times** (`L217`). `rm -f` exited 0 **without deleting** a probe (relative path resolved against a drifted cwd; `-f` suppressed the complaint that would have surfaced it), and a `git commit` was refused for the same reason. ⭐ **The two opposite outcomes are the lesson: one root cause, LOUD on the pathspec commit and SILENT on `rm -f`.** The loud one cost nothing; the silent one was caught only because I verified the deletion with a second instrument.
3. **`grep` fabricated match-count headers twice** on single-file queries and dropped real matches; single-file `awk`/`sed` used throughout thereafter.
4. **A control that shared its subject's failure mode is not a control.** My first consumer-scan control returned the *same three files* as the subject, so it could not have disagreed and proved nothing. Re-ran with a string spanning 26 files across five packages — only then did the three-file result mean "narrow answer" rather than "broken search."

**Controls that existed and were deleted, declared per `029`:** three temporary vitest probes (redactor behaviour on real fixtures; zod error contents + the lowercase-credential question; `WorkspaceIdSchema` acceptance across live/legacy/oversized ids). Each was created, read, deleted, and the deletion verified with a different instrument than the one that reported success. A fourth control — a deliberate type error injected into `systemHealth.ts` — proved `tsc` reports red on that exact file and line before its green was believed, then was restored byte-identical.

---

## `/preflight` — NOT clean, and the two failures are pre-existing infrastructure

⛔ **Reported as measured rather than as "clean", because two of the five steps fail and neither is this session's doing.**

| Step | Result |
|---|---|
| 1 · `pnpm install` | returned the literal `ok` (see instrument findings); effects confirmed by the later steps running |
| 2 · `pnpm lint` | ⛔ **FAILS** — `Command "eslint" not found` |
| 3 · `pnpm format:check` | ⛔ **FAILS** — the script is **not defined anywhere in the repo** |
| 4 · typecheck (whole graph, `--force`) | ✅ **20 successful, 20 total, `0 cached, 20 total`** |
| 5 · test (whole graph, `--force`) | ✅ **20 successful, 20 total, `0 cached, 20 total`** |

**Step 2 is Carry-forward 6 `(0)`, reproduced with BOTH its faces corroborated:** `eslint` appears in **zero** manifests (measured across every non-`node_modules` `package.json`), and each package's `lint` script is literally `tsc --noEmit` — so *"lint passed"* anywhere in this repo means *"typecheck passed a second time"*, never that a linter ran. ⚠ **Any claim of lint coverage in this project is an overclaim.**

**Step 3 appears to be a NEW observation and is filed as a follow-up:** `/preflight`'s own Step 3 invokes a script the repo does not define. ⇒ **the quality gate has referenced a non-existent step for as long as it has existed, and every "preflight clean" ever reported skipped it silently** — a gate that cannot fail is not a gate (`L103` family).

⭐ **Both failures are independent of this session by construction: the only uncommitted change at preflight time was a markdown session doc**, which cannot affect script resolution. **The two steps that actually gate correctness — types and tests — are green across the entire graph, forced, uncached.**

## Open follow-ups

**Routed hot during the session; listed here for continuity, not for re-routing.**

- **`### 24.112`** — OPEN by design. The design tension is unresolved and deferred to the arming gate. Its Done-when additionally requires a pin that reds if a landed revoke reports failure; **nothing today would catch it**.
- **`### 24.108`** — `foldStatus`'s undocumented protection (`apps/desktop`, unstaffed).
- **`### 24.84`** — landed but **tick GATED**, not owed. Do not tick; do not re-dispatch.
- **`### 24.110` / `### 24.118`** — two diverging `isRedactionSafe` (domain's `/i`, policy's without) and **three** `redactString` implementations with divergent pattern sets. `packages/policy` territory. ⚠ Reachability of the uppercase-credential path **unmeasured** — recorded as an open question, not softened.
- **`### 24.111`** — answered by this session's `scopeForType` finding and no longer zero; it is what gates `### 24.84`'s tick.
- **The `egressCommands.ts` "mirrors" docblock** — filed against `### 24.112`; Decision 5 makes it matter more, not less.
- **The `visibility.ts` note's `L106` citation** was corrected to `L180` by the orchestrator at `894fac5a`; the gloss moved with the pointer.
- ⛔ **NEW: `/preflight` Step 3 (`pnpm format:check`) invokes a script that does not exist in this repo** — a gate step that has never been able to run. Sibling of Carry-forward 6 `(0)`; not filed by me.
- ⚠ **`packages/policy` is NOT vacant.** The lead's cross-area ruling for `61d9e02c` rested on that premise, and another session was writing in that package during this one. The Half-B edit was a different file, so no collision — but the premise should be re-checked before the next cross-area authorization.

---

## How to use what was built

- **The egress-status sink redacts, it does not refuse.** Benign ids pass byte-identical, so the desktop's `foldStatus` equality check is untouched for the entire live population. A credential-shaped id diverges, and that divergence is deliberate and pinned.
- ⛔ **Do not "make the two `toUiSafeEgressStatus` functions consistent."** Read `### 24.112` and the JSDoc fence at `egressCommands.ts` first. The asymmetry is load-bearing.
- ⛔ **Do not surface `parsedId.error` at `parseCreateWorkspace`** to make the refusal more helpful. The comment at the site states the consequence; the echo pin is the live control.
