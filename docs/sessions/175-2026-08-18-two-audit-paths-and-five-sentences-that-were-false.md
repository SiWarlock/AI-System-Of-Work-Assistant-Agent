# Session 175 — two audit paths, a carrier that survived, and five sentences of mine that were false

**Date:** 2026-08-17 → 2026-08-18 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (`knowledge-implementer`, single-track `main`)
**Predecessor:** this area's prior session — `172-2026-08-14-24-80-re-scoped-and-the-precedent-that-had-not-solved-it.md`
**Successor:** `179-2026-08-18-the-cut-that-could-not-fire-and-three-pins-that-could-not-fail.md`

**Commits (mine):** `124e3f45` (`### 24.98`) · `e3ae23e3` (brief `290` / `### 24.84` knowledge leg)
**Baseline at start:** `3b74e497`. **Tree at close:** `packages/knowledge` fully clean, no untracked.

---

## Why this session existed

A fresh round after the 2026-08-14 teardown. `### 24.72`'s discharges were knowledge territory. What actually happened is that **three of the four things I was dispatched to do turned out to rest on premises that were false**, and most of the session's value came from measuring that rather than from the code.

## What was built

**Files modified (mine, committed):**
- `packages/knowledge/src/gcl/visibility-gate.ts` — `schema_rejected` gains a REQUIRED `audit`, minted at both rejection sites; `auditOf` stays a pure extractor; `structuralPathOnly` cuts paths at `sanitizedPayload`; `refs` deduped + capped at 20 with the drop reported.
- `packages/knowledge/test/gcl-visibility-gate.test.ts` — 8 pins for the above.
- `packages/knowledge/test/global-markdown-reconcile.test.ts` — a forced fixture update (see Decisions).
- `packages/knowledge/test/gcl-projection.test.ts` — `unsafeWorkspaceIdForTest`, the re-pointed redaction-gate control, and `pre_validator_row_is_refused_recorded_and_credential_free`.

**Files created:** none.

## Decisions made

1. **`schema_rejected`'s `audit` is REQUIRED, not optional.** The compiler then enumerates every construction site — and immediately found a third nobody had listed (`global-markdown-reconcile.test.ts`). The cost is real and recorded: it also created an untested rule-7 construction at the ajv site, which is why that site got its own pin.
2. **The signal is redaction-safe BY CONSTRUCTION, never by detection.** Structural material only — code, stage, cut paths, counts. `message` is excluded categorically because it is validator-authored and measured to echo row content.
3. **`structuralPathOnly` replaced an ARGUMENT with a CONSTRUCTION.** The old posture was "no per-entry issue can be raised under `sanitizedPayload` today" — true, and contingent on a schema nobody promised to keep. Security review executed that condition and produced a real leak ref. Cutting the path makes it unrepresentable instead.
4. **The redaction-gate control was re-pointed, not retired.** Its fixture moved from a URL-userinfo credential id (inadmissible post-`24.84`) to a **slug-valid but credential-shaped** one. ⭐ The mechanism is contract's own documented limitation: `zod-brands.ts` states it is *not* a credential detector, so a slug-valid id can still be credential-shaped and still reaches the gate. **The brand's stated weakness is what preserves the other gate's reachability.**
5. **`### 24.55`'s protection obligation SURVIVES the landing** — measured, discriminating (credential-shaped ids refused 0/1; benign `ws-acme` persisted 1/0). The workspace-ref carrier is **PINNED, not closed by construction** — my earlier assumption, falsified by my own measurement.
6. **Q1 (`### 24.103`): merge the SHAPE, not the unions.** Approved. Extract the duplicated issue-carrying shape into one type that REQUIRES an `audit`; let each union keep its own vocabulary.

## Decisions explicitly NOT made

- **Which of the 5 census channels to fix, and in what order** — routed, not chosen. See "For your successor" for my read.
- **Whether `### 24.103`'s dormant gate deserves a signal at all** — the census says the live risk is elsewhere; I surfaced the asymmetry rather than resolving it.
- **The broad 39-channel population.** I narrowed to 5 by a risk predicate. ⚠ **The other ~34 are refusals with no audit but WITHOUT the echoing field — a deliberate exclusion, not an omission.**
- **`apps/desktop`** was not traced as a program; the renderer receives a freshly-constructed `FailureVariant`, so the drop happens upstream, but I did not verify desktop itself.

## TDD compliance

**Clean.**
- `### 24.98`: tests written first; RED confirmed with 6 failures for the right reason ("signal doesn't exist"); then GREEN. Two mutation tests confirmed the pins discriminate.
- Brief `290`: test-infrastructure only — no production behaviour changed. The helper landed with its control test.
- ⚠ **One deliberate behaviour change re-aimed a pre-existing negative control** (`auditOf returns undefined for the two variants…`). It went RED correctly; it was **narrowed, not deleted**, and later absorbed into its byte-equivalent twin rather than kept alongside it.

## Cross-doc invariant audit

**No model in `packages/contracts/CLAUDE.md`'s table changed by this session.** `GclGateError` is knowledge-local; `AuditSignal` gained no field (checked deliberately — the brief said STOP if it would). Contract's `Workspace`/`WorkspaceId` shape change is **their** slice and their flag.

## Reachability

- **`### 24.98`** — real and already wired: `persistDenialAudit` has exactly two production call sites, `projection.ts:158` and `:201`, both passing `auditOf(...)`. ⚠ **SCOPED: the signal is produced and gated; NO adapter persists it yet** (GCL port binding deferred to Phase 25.2/25.4, `### 24.97`). Never write the unqualified "schema rejections are now audited."
- **Brief `290`** — test infrastructure; drives the already-wired `serveProjection` → `admitProjection` → `persistDenialAudit` path.
- **No tested-but-unwired features introduced.**

## Open follow-ups

- ⛔ **`### 24.103` — the approved shape-merge.** Not started. See below.
- **`### 24.97` leg (b)** (`workspace-read-gate` / `egressRevoke`) REMAINS OPEN. Neither leg ticks alone.
- **Latent condition (filed via Step 9):** `createCommitActivity` is bound as an **in-process port**, not a Temporal activity. If it were ever registered, its returned `Result` — `cause` included — would enter workflow history by construction. **Today's safety rests on a composition choice, not on the type.**
- **Cross-area, flagged not fixed:** the `schema-gate.ts` `e.params` note (contract territory) · `audit-signal.ts`'s producer census 41→42, knowledge 2→3 (policy territory) · `projection.ts`'s `24.55` comment citing call sites `:110`/`:153` where the measured sites are `:158`/`:201`.

---

## ⛔ FOR YOUR SUCCESSOR — you inherit none of my context

**The expensive parts are already durable on `### 24.103`: the 5-channel table, the predicate, the discriminating control, the stated boundary, and the approved remedy with its three grounds. Point at them; do not re-derive them.** What follows is what the tracker cannot carry.

### Which channel to touch first, and why

⭐ **Start with `WriteFailure` + `SchemaRejected` together, and treat them as ONE edit, not two.** Both live in `writer.ts`; `runGate` (`:632`) returns `SchemaRejected` and `applyPlan` (`:373`) folds it into `WriteFailure`. They are the same seam seen twice. **They are also the only LIVE member of the population** — the production caller is `commitKnowledge.ts:156`, i.e. the KnowledgeWriter apply path, **safety rule 1**.

⚠ **Do the dormant three (`IntakeError`, `RemediationError`, `StampError`) last, and expect them to be cheap once the shape exists.** `IntakeError` has **two** echoing members (`schema_rejected` AND `plan_invalid`) — the brief only named one.

⛔ **Do not start with `### 24.103`'s named target.** `intakeGenerativeProposal` has **zero production callers** (`block-provenance.ts:9` says so in terms). Fixing it first is motion on the harmless member.

### What I learned about `writer.ts` that would cost you a re-read

- **`applyPlan`'s step order is load-bearing and its comments say so:** 1 idempotent replay (`getByIdempotencyKey`) → 2 composed gate (`runGate`) → 3 compare-revision → 4 diff → **4.4 already-applied** → 4.5 workspace-path → 5 ownership → 6 secret scan → 6b provenance stamp → 7 atomic commit → 8 audit + revision records. **The step numbers are cited by other blocks; renumbering breaks their reasoning.**
- **§16 posture at step 8:** `audit.append` / `revisions.record` faults are **typed, never thrown, and never rolled back** — the Markdown is durable and stays durable. `audit_record_failed` ⇒ neither record exists; `revision_record_failed` ⇒ the audit row exists and only the revision record is missing. They are two members deliberately.
- **`createCommitActivity` wraps `applyPlan` in a try/catch** that folds a throw to `commit_failed`. `writer.ts` comments lean on that catch existing — in another package.
- **`WriteSuccess.replayed` is declared, copied once, and branched on ZERO times in production** (my `### 24.88` census; the seam question is `### 24.90`).
- ⚠ **`writer.ts` is dense with correction history.** Several blocks record claims that were wrong and were rewritten rather than struck. **Read before editing; the rewrites are the record.**

### The thing I would tell you if I could tell you one thing

**Five defects were found in my work today. Every one was in PROSE OR NAMING. The logic survived every mutation it was given.** A reach claim, a stale schema-valid claim, a false uniqueness claim, three decorative assertions, and — the worst — a false assurance in a source comment that security review **executed** and turned into a real leak ref against a green suite.

⛔ **A source comment is the artifact a maintainer trusts most and reviews least.** A brief is read once; a packet by someone deciding; a reviewer prompt by a reviewer. A comment is read by everyone forever, carries no review step of its own, and is believed because proximity reads as provenance.

⭐ **And the repair that works is the third option.** When a comment asserts a control that does not exist, deleting the sentence fixes the DOCUMENT and leaves the DEFECT — and destroys the only artifact naming the invalidating condition. **Make it true by construction instead; then the pointer survives.** (`L194`.)
