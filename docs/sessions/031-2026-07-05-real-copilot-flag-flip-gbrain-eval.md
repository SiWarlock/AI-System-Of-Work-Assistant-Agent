# Session 031 — Real Copilot: flag flip (Sonnet 5 1M) + GBrain retrieval adapter + model eval

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Tracks:** worker · providers · desktop · evals
- **Predecessor:** `030-2026-07-05-real-copilot-P2.3-P2.4.md`
- **Successor:** `032-2026-07-05-RESUME-p3-live-gbrain-wired.md` (gbrain setup fixed + seeded; P3-live next)
- **HEAD at close:** `9c84074` (+ this round's doc/plan commit) · **3 feature commits** (`185b16d` P2.4b · `72ab50c` P3.1 · `9c84074` P2.5)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** (worker 466+ · contracts 630 · desktop 172 · providers 240 · evals 426 · 14 gated-tier skipped).
- **Reviews:** 5 subagent reviews (2 security + 3 code-quality). 0 critical/high on the security axis; the P2.5 code-quality HIGHs (grader soundness) fixed in slice.
- **⚠ Concurrency note:** the parallel **`../SoW-build-evalsec` (track/eval-security)** session committed Phase-12 plan reconciliation to shared history (`826f14e`, `a809758`) interleaved with this round. No file collision (they touched only `IMPLEMENTATION_PLAN.md` checkboxes; this round touched code) — surfaced to the owner.

## Why this session existed

The owner directed: **"flip the flag then do p3 and p2.5. Also we should use sonnet 5 1M."** — activate the real Copilot cloud path (built in session 030) with Claude Sonnet 5 + the 1M-context window, then do the two remaining real-Copilot units (real GBrain retrieval, the model eval).

## What was built

### P2.4b — Sonnet 5 1M + flip the flag (`185b16d`)

**Files modified:** `packages/providers/src/model/claude-subscription-completion.ts` (+ `CompletionRequest.betas` → SDK `query({options:{betas}})`, `SdkBeta`, defensive spread-copy) · `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts` (`DEFAULT_CLAUDE_COPILOT_MODEL` → `claude-sonnet-5`; `DEFAULT_COPILOT_BETAS = ["context-1m-2025-08-07"]` defaulted into the request; `betas` threaded through the options + `buildCopilotDeps`) · `apps/worker/src/boot.ts` (`BootConfig.copilotBetas` passthrough) · `apps/desktop/worker-host/index.ts` (**`copilotRealModel: true` + `copilotModel: "claude-sonnet-5"`** — the flip).

The Agent SDK enables 1M context via `betas: ['context-1m-2025-08-07']` (a query option, **not** a model suffix), confirmed via Context7. An Employer-Work Copilot ask now egresses to Anthropic via the ambient local `claude` login with the visible notice. Security review CLEAN (the flip activates the P2.4-reviewed governance path; betas/model inert; nothing egresses at boot — the SDK client is constructed but only `import`s/authenticates inside `complete()`).

### P3.1 — GBrain-backed Copilot retrieval adapter (`72ab50c`)

**Files created:** `apps/worker/src/api/procedures/copilotGbrainRetrieval.ts` + test. `createGbrainCopilotRetrieval` implements `CopilotRetrievalPort` over the read-only, workspace-scoped `GbrainReadAdapter` (`@sow/knowledge`, task 4.7). Selects the per-workspace bound adapter (WS-8: unknown → `WORKSPACE_NOT_FOUND`; mis-keyed/foreign → `RETRIEVAL_SCOPE_MISMATCH`, both fail-closed), runs the read-only `search`, maps the result → `RetrievedContext` with **aligned block↔source pairs** (fixes the P2.3 pairing carry-forward). Fail-closed on a transport fault (retryable) + a malformed non-array shape (not retryable); **opaque `gbrain:<id>` citationIds — no `path` field** (a vault path is neither a safe citationId nor grounding-worthy); accepted response capped at the limit. Deterministic half only, TDD'd (12 tests) with a fake adapter. Security review CLEAN (WS-8 / fail-closed / §16 / prototype-safety all PASS).

### P2.5 — Copilot synthesis eval: grounding + citation correctness (`9c84074`)

**Files created:** `packages/evals/src/copilot-eval/grader.ts` · `packages/evals/src/copilot-eval/corpus.ts` · `packages/evals/test/copilot-eval/copilot-grounding.test.ts`. Fills the gap `copilot-governance.test.ts` explicitly defers (the model-prose QUALITY eval). `gradeCopilotAnswer` scores 5 axes: `citationsGrounded` (no invented source), `requiredCitationsPresent`, **`contentPresent`** (STATES the grounded fact — the correctness axis that closes the "cites right but says nothing/false" hole a review caught), `refusalCorrect` (refuse iff the context can't answer; a refusal grounds nothing), `noForbiddenClaims` (no fabricated figure). + a 14-case synthetic labeled corpus (all 3 workspaces; single/multi-source, refusal/no-inference, fabrication traps), each with a GOLDEN reference answer the suite grades. A **gated real tier** (`SOW_COPILOT_REAL_EVAL=1`, skipped by default) generates answers with the real Sonnet adapter + grades them.

## Decisions made

- **Sonnet 5 1M via the `betas` query option**, not a model-string suffix (SDK contract). Model + betas are config-threadable (`copilotModel` / `copilotBetas`); defaults are the Sonnet-5-1M pair.
- **The flag is flipped at the worker-host assembly site** (hardcoded `true`), the literal "flip the flag" — easily toggled off by removing two lines. A runtime user toggle is a future feature.
- **P3 is delivered as its deterministic core only.** The live wiring is genuinely blocked on external gbrain deployment specifics (see below) — building a real transport blind against an empty/unembedded brain would be guesswork; the adapter is correct + tested + ready for that wiring.
- **P2.5 corpus is a self-contained TS module** (not the JSON+manifest+content-hash harness idiom) — deliberate, to avoid conflicting with the parallel eval-security worktree, and because it carries golden reference *answers* (the query-only harness corpora don't). Flagged for the orchestrator to reconcile into the harness later if desired.
- **The eval grades the reconciled candidate on the real tier**, so `citationsGrounded` is trivially true there (the adapter drops hallucinated cites first) — the real model-quality signal is `contentPresent` + `noForbiddenClaims` + `refusalCorrect`. Documented in the suite.

## Decisions explicitly NOT made (deferred)

- **P3-live wiring** — BLOCKED on: (1) a concrete `GbrainReadClient` transport (real gbrain HTTP read-serving I/O — a P2.2-style seam; the endpoint isn't even in `GbrainReadGrant`), (2) per-workspace grant provisioning (no grant is constructed anywhere; `/setup-gbrain` produced `config/gbrain.pin` but no grants), (3) the gbrain read-surface being enabled (`config/gbrain.pin` shows read/index **PENDING_PHASE12** — the §12 four-condition gate isn't met), (4) a **populated + embedded brain** (live `get_health`: 4 pages, **0 embeddings** — semantic search returns nothing today).
- **P2.5 real-tier run** — not executed (needs the owner to opt in with `SOW_COPILOT_REAL_EVAL=1` + accept the cost / non-determinism).
- **A model-family-aware betas default** — kept the paired Sonnet-5 + 1M default; overriding `copilotModel` to a non-Sonnet family requires also overriding `copilotBetas` (documented; an incompatible combo folds to a typed error).

## TDD compliance

Clean. All three slices RED→GREEN on their deterministic surface: P2.4b (betas/model threading, 5 added tests), P3.1 (12 tests — mapping, WS-8 scoping, fail-closed, cap, path-skip), P2.5 (grader axes + corpus floor/well-formedness + 14 golden-pass + the vacuous/wrong-fact fail cases). The real `query()` call is eval-tested (the gated tier), not unit-tested. No violations.

## Reachability

- **P2.4b** — the flag flip makes `buildCopilotDeps`'s real path LIVE from `bootWorker` (the P2.3/P2.4 path is now reached with a real cloud route + Sonnet 5).
- **P3.1** — `createGbrainCopilotRetrieval` is **tested-but-unwired** (it will replace `createFixtureRetrieval` in `buildCopilotDeps` when the transport + grants land — the deferred P3-live slice). Expected; it belongs to that phase.
- **P2.5** — the grader + corpus are reachable from the eval suite; the gated tier reaches the real adapter when enabled.

## Open follow-ups

- **P3-live** (the four blockers above) — the biggest remaining real-Copilot piece; needs owner/deployment input (gbrain HTTP endpoint, grant provisioning, the Phase-12 read gate, a populated brain).
- **Run the P2.5 real tier** once the owner wants a live grounding measurement.
- **Deferred review nits (low):** `isRefusalAnswer` remains a keyword proxy (imperfect on unconstrained live phrasing); the P2.5 corpus could later fold into the JSON+manifest harness; a `dataOwnerFor(type)` helper for the duplicated derivation (from session 030).
- **Concurrency:** coordinate with the eval-security worktree on `IMPLEMENTATION_PLAN.md` ownership to avoid a future clobber.

## How to use what was built

The real Copilot is LIVE: launching the app, an Employer-Work Copilot ask synthesizes with Claude Sonnet 5 (1M context) over the ambient `claude` login and shows the egress notice. Retrieval is still the fixture stub until P3-live, so answers honestly report finding nothing until real GBrain retrieval + a populated brain land. To measure grounding against the real model: `SOW_COPILOT_REAL_EVAL=1 pnpm --filter @sow/evals test`. To turn the cloud path off: remove the two `copilot*` lines in `apps/desktop/worker-host/index.ts`.
