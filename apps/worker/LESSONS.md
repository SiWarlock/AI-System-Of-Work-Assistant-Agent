<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (control-plane worker (storage · Temporal · API))

> Full prose for every lesson logged during work in `apps/worker/`. The compact index lives in `apps/worker/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. On-request Copilot synthesis skills reuse a single-sourced governed core — never re-implement the gate

**Date:** 2026-07-12.
**Source slice:** C6 (b)-1 `b1048c3` (brief 040) + confirmed by (b)-2 `048d13e` (brief 041).

An on-request Copilot synthesis SKILL (Q&A, briefing, concept-synthesis, …) is a tRPC `.query()` procedure that **supplies its own retrieval** and then routes through the **one shared governed core** — never a re-implemented egress/gate. In `apps/worker/src/api/procedures/copilot.ts` that core is `runGovernedCopilotSynthesis(deps, workspaceId, question, scopedContext)` over `GovernedCopilotSynthesisDeps {synthesis, workspacePosture, routeSelector}`: WS-8 re-guard (`enforceRetrievalScope`) → authoritative server-side posture → route select → egress veto BEFORE synthesis → synthesize on the **veto-cleared route** (`decision.value.route`, never re-selected — the P1.2b binding) → `toUiSafeCopilotAnswer` candidate/UI-safe gate. `CopilotDeps` is just `GovernedCopilotSynthesisDeps` + `retrieval`.

What VARIES per skill is only the **retrieval source** and the **directive**; the safety machinery does not. Briefing (`copilotBriefing.ts`) supplies a `CopilotBriefingRetrievalPort` that assembles the §9.4 Today read-model into a `RetrievedContext` (already-UiSafe items + counts only — no-raw by construction) and a server-fixed `BRIEFING_DIRECTIVE`. Concept (`copilotConcept.ts`) reuses `CopilotRetrievalPort` (workspace knowledge) + a `CONCEPT_DIRECTIVE` framing — reusing the core so verbatim that `copilot.ts` was byte-unchanged (both Step-8 reviewers confirmed). Extracting the core once means the egress veto + candidate gate + WS-8 re-guard **cannot drift** between skills; adding a skill is a retrieval + a directive + a mount, reviewed against the same invariants each time.

Two corollaries worth keeping: (1) a skill with a **client-supplied** term (concept) carries the Q&A injection posture — bound it at the transport parser (`parseConceptInput`, ≤200 + single-line via a code-point guard, LESSONS Unicode-in-regex) — while a **server-fixed** directive (briefing) has a smaller surface. (2) When a retrieval reads a read-model whose **port** returns raw (e.g. `approvalInbox`→raw `Approval`), redact at the retrieval (read `.length` only), so no raw content enters the egressed `blocks` — no-raw *by construction* beats trusting a downstream projection.

**Rule:** an on-request Copilot synthesis skill supplies its own retrieval + reuses the single-sourced governed core (`runGovernedCopilotSynthesis`) — never a re-implemented gate; the retrieval source varies, the safety machinery does not.

## <a id="2"></a>2. Activate a built-but-dormant boot capability with a pure fail-safe gate helper (default-OFF)

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 1 `727ab76` (brief 042).

To make the shipped app run a capability whose machinery is already built but flag-gated, add a PURE `gate…(opts) → wiring | undefined` helper (mirroring `gateCopilotVaultReadDeps`, `boot.ts:441-463`): it returns the wiring object ONLY when the owner opt-in AND every precondition are present, else `undefined`. The worker-host reads owner config (env/IPC), calls the helper, and spreads the result into `bootWorker` — so with the opt-in unset the boot is **byte-equivalent to the prior degraded boot** (no new construction, no behavior change). Two properties make it safe: (1) any expensive/side-effectful dep is built inside a **thunk** the helper invokes only on the ON path, so the OFF path constructs nothing (unit-test that the builder is never called when OFF); (2) owner-configurability lives in the Electron `main` process (where `process.env` is already read) and threads through the IPC config the same way an existing field does — never hardcode a path (`gateAutoIngest` reads `SOW_INGEST_WATCH`/`SOW_VAULT_ROOT`/…, default OFF).

The security dividend: default-OFF + owner-opt-in IS the activation authorization. Nothing real happens until the owner opts in, so the review surface shrinks to "is the OFF path byte-unchanged, and is every ON-path dep behind the gate." A subtlety worth flagging at review: activating one capability can incidentally satisfy a DORMANT sibling's precondition (auto-ingest-ON defines `proofSpineParams`, which the propose/semantic-dispatch also needs) — call it out; the sibling stays off by its OWN designed locks, not by the incidental barrier you just removed.

**Rule:** activating a built-but-dormant boot capability = a pure fail-safe gate helper (default-OFF, thunk'd deps, owner-config not hardcoded) that augments `bootWorker` only when the opt-in AND its precondition are both present; the shipped default stays byte-equivalent to the prior boot.

## <a id="3"></a>3. A durable KnowledgeWriter-idempotency store is an operational-store repo, fail-closed both directions

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 2a `bbabd5f` (brief 043).

The `KnowledgeRevisionStore` that backs KnowledgeWriter exactly-once (`getByIdempotencyKey`/`record`) must be a real `@sow/db` operational-store repo, NOT an in-memory `Map` — the Map loses exactly-once across a worker restart (a fresh instance sees an empty store → re-commit). Build it as a Drizzle table keyed by `idempotencyKey` (PRIMARY KEY) with `INSERT … ON CONFLICT DO NOTHING` (first-write-wins: `record` returns void, so exactly-once == idempotent no-op, keeping the FIRST — this deliberately DIVERGES from sibling repos that signal a typed conflict, because the interface has no error channel). It passes the ONE `repository-contract.test.ts` suite on BOTH dialects (no dialect-specific SQL; Postgres never a stub). The durability property is inherently a FILE test (temp-file SQLite, close→reopen→fresh repo sees the row) — the in-memory contract suite structurally can't test restart.

The load-bearing safety property is **fail-closed in BOTH directions**: a real `DbError` on `getByIdempotencyKey` OR on `record` must PROPAGATE (reject), never be masked as `undefined`/swallowed — the only `undefined` is a genuine `not_found`. A masked lookup error reads to the writer as "no prior commit" → re-commit (duplicate); a swallowed `record` error means the writer believes it persisted when it didn't → replay re-commits. The consumer (the KnowledgeWriter `applyPlan`, via `createCommitActivity`'s try/catch) must honor the rejection as `commit_failed`, no re-commit. Adapter lives at the composition root (`apps/worker/src/composition/`) because `packages/knowledge` must not import `packages/db` (layer ban). Audit content persists summaries only (REQ-S-003 — no secret/raw column).

**Rule:** a durable KnowledgeWriter-idempotency store is an operational-store repo keyed by `idempotencyKey` (UNIQUE, first-write-wins), passing the one repo-contract suite on both dialects, fail-closed on BOTH `getByIdempotencyKey` AND `record` (reject, never mask); the in-memory Map is an honest interim that loses exactly-once across restart.

## <a id="4"></a>4. Activate a real sole-writer commit by swapping the fake for the existing adapter — never a new writer

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 2b `a6cf0ec` (brief 044).

To make a deterministic-fake commit leaf real, DON'T write a new writer — swap the fake `CommitKnowledgePort` for the EXISTING `createCommitActivity(deps)` (`packages/workflows/src/activities/commitKnowledge.ts`) over the sole-writer `applyPlan` (the meeting flow already uses it — mirror `buildActivities.ts:382-391`). Three details are load-bearing: (1) leave `ownershipCheck`/`secretScan` UNSET so `applyPlan`'s REAL defaults (`enforceHumanOwnership`/`scanForSecrets`) engage — a pass-through would silently disable the sole-writer + secret guards; (2) `expectedBaseRevision` must be a RESOLVER (`() => readVaultHeadRevision(vault)`) not a fixed value, because the live vault head moves between commits; (3) construct the real writer deps + durable store LAZILY behind the same default-OFF gate (rebind the shared `proofSpineParams.revisions` in `bootWorker` after backends are built, gated on `proofSpineParams !== undefined`) so nothing is constructed and nothing persists on the OFF path.

The fail-closed carry-forward from the durable store (lesson §3) is honored WITHOUT touching the sole writer: `createCommitActivity` already wraps `applyPlan` in a try/catch → `commit_failed`, and its doc-comment names the revision store as the throwing substrate — so a store rejection fails closed at the activity boundary. Verify (don't assume) the consumer catches it before concluding "no writer change." A post-commit `record`-reject is the writer's pre-existing `record-fault → System-Health` design: Temporal-retry → `not_found` → re-project onto the advanced head → empty diff → no-op (no duplicate). Watch for a DIFFERENT pre-existing gap the real commit EXPOSES: a fixed output path (`sources/<ws>/ingested.md`) that was harmless while the commit was fake becomes a collision once writes are real (→ a named per-source-path slice).

**Rule:** activate a real sole-writer commit by swapping the fake for `createCommitActivity` over `applyPlan` (real ownership/secret defaults + a live `readVaultHeadRevision` resolver + the durable store), behind the same default-OFF gate — never a new writer; verify the existing adapter honors the store's fail-closed.
