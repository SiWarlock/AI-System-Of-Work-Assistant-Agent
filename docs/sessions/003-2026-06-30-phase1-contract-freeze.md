# Session 003 — Phase 1 contract freeze (Workflow fan-out experiment)

- **Date:** 2026-06-30
- **Predecessor:** `002-2026-06-30-gbrain-write-through-and-phase-1-start.md`
- **Operating model:** single-operator (one session) driven via the **Workflow** tool — NOT a team. Ultracode on (xhigh + dynamic workflow orchestration).
- **Outcome:** **Phase 1 contract freeze COMPLETE.** Tasks 1.2–1.9 + the full 27-model Appendix-A seam freeze landed TDD-green and committed/pushed. Remaining Phase 1 = the domain layer (1.10–1.15).

---

## Headline

This session executed the **workflow fan-out experiment** the session-002 handoff teed up: author the entire Phase-1 contract surface as a single-session **Workflow** (parallel sub-agent fan-out) instead of an agent team. It worked — **27 cross-track seam models frozen, 495 tests green, typecheck clean, consistency-critic driftDetected=false** — and it surfaced one real operational failure mode (a mid-run API burst stalling a batch of agents) plus the recovery pattern for it.

## 1. What happened (arc)

1. **Orientation + plan.** Read the session-002 handoff, memory notes, `IMPLEMENTATION_PLAN.md` Phase 1, `docs/design/gbrain-write-through-divergence.md`, `ARCHITECTURE.md` (§2.5 + §3 + Appendix A), and the existing 1.1 code. Confirmed `zod` resolves but `ajv`/`ajv-formats`/`zod-to-json-schema` were absent.
2. **Owner gate (2 decisions).** Proposed the workflow plan + asked the two load-bearing decisions: **authoring approach** → owner chose **Zod-as-source** (ADR-008); **go/no-go** → owner chose run now. Installed the 3 deps into `@sow/contracts`.
3. **Workflow run 1** (`wf_53604175-8b0`): foundation (A1 gate+harness → A2 shared brands/enums/sub-shapes → A3 EgressPolicy reference) → 3 dependency-ordered model waves → synthesis → adversarial verify.
4. **Mid-run API burst.** ~6 min into wave 1, **8 of the 20 wave-1 agents stalled simultaneously** (no transcript writes for ~350s) — an API overload/rate-limit burst. Stalled agents block the `parallel()` wave-1 barrier, so waves 2/3/synthesis/verify never started. 13 agents had completed (foundation + 16 models on disk and green); 2 were still actively working.
5. **Diagnosis + repair.** Confirmed the stall via **filesystem completeness** (per-model: are all 4 files present?) + **agent-transcript staleness** (seconds since last write). Stopped run 1 (`TaskStop`). Baseline test run confirmed **the 16 complete models + foundation were green (274 tests)** — the harness was sound; the stalls were purely the burst. Authored a **targeted repair Workflow** (`wf_3f886f26-462`) re-running ONLY the 11 incomplete models (foundation + the 16 complete models persisted on disk, so repair agents imported them).
6. **Repair run** completed clean: 11/11 repaired green → synthesis wired the barrel + a registry-coverage proof → consistency-critic (driftDetected=false) + verify (**495 tests, typecheck clean**).
7. **Independent re-verify** in the main loop (`pnpm test` + `pnpm typecheck`) before committing. Committed in 4 batches; full solo close-out (this doc).

## 2. The freeze (27 models)

All authored **Zod-as-source** (ADR-008): one `.strict()` Zod schema → `z.infer`/explicit-interface TS type → generated strict JSON Schema (`schemas/<kebab>.schema.json`) → hand-authored frozen field-set snapshot (`__snapshots__/<kebab>.snap`) → registered in the ajv-strict `defaultSchemaRegistry`. Field-sets verified against `ARCHITECTURE.md` Appendix A.

- **Gate (1.2):** `emit` (zod→JSON Schema), `field-set` (top-level extractor), `registry` (ajv strict + glob), domain `schema-gate` (`validate(output, schemaId) → Result`, the candidate-data boundary, REQ-S-006), `freeze` test helper. Shared: `zod-brands`, `shared-enums`, `shared-shapes`.
- **16 base seam models (1.3–1.9 + co-frozen):** EgressPolicy, ToolPolicy, ProviderRoute, ProviderProfile, ProviderMatrix, Workspace, AgentJob, ProposedAction, ExternalWriteEnvelope, SourceEnvelope, GclProjection, Approval, WorkflowRunRef, AuditRecord, WriteReceipt, NotebookMapping.
- **11 write-through/divergence models (9 new + 2 amended):** SemanticFact, FactProvenance, SignedProvenanceStamp, ParityReport, Divergence, QuarantineRecord, GBrainProposedFact, GbrainReadGrant/ServePolicy, GbrainPin + amended KnowledgeMutationPlan & HealthItem.

`registry-all.test.ts` proves the ajv registry compiles every `schemas/*.schema.json`, `$id`s are unique, and every barrel-exported `*_SCHEMA_ID` resolves — i.e. the candidate-data gate covers every frozen model.

## 3. Decisions

- **ADR-008 — Zod-as-source contract authoring** (locked). One Zod schema per model is the single source; TS type = `z.infer`, JSON Schema = generated, field-set frozen by snapshot. The three representations cannot drift. Full ADR in `docs/planning/DECISIONS.md`; summary row added.

## 4. Findings / flags carried forward (consistency-critic, driftDetected=false — all NOTE-level)

1. **`KnowledgeMutationPlan.signedProvenanceStamp` modeled `.optional()`** — Appendix A lists it without `?`, but KW writes the HMAC stamp **at the atomic commit** while the plan is KW *input*. Confirm at §6/Phase-4 whether it belongs on the plan at all (vs only on committed frontmatter).
2. **`GbrainReadGrant.scope` cardinality** — `z.array(z.literal('read'))` accepts `[]`/duplicates vs Appendix A's literal `['read']`. Pin cardinality if §7 GbrainServePolicy semantics require exactly-one.
3. **schema-version numeric posture asymmetry** — `GbrainPin.indexSchemaVersion` is `int().nonnegative()` but `ParityReport.gbrainSchemaVersion` + `GbrainReadGrant.indexSchemaVersion` are open `number()`. Unify when a parity/serving consumer compares them.
4. **Under-specified sub-shapes frozen provisionally (arch_gaps):** the KW mutation primitives (`NoteCreate`/`NotePatch`/`LinkMutation`/`FrontmatterPatch`), `ContextRef`, `CanonicalSourceRef`, and the open `proposedContent`/`payload`/`preconditions`/`sanitizedPayload`/`routingHints` records — modeled minimally (no invented closed enums); nested field-level contracts firm up at §6 KnowledgeWriter / §8 gateways. Treat a nested-shape change there as a cross-track Finding.
5. **Doc nit:** the Phase-1 acceptance enumeration omitted `WriteReceipt`/`NotebookMapping`/`HealthItem` from its base list though §2.5 requires them; all three were frozen. Fold into the acceptance enumeration next edit.

## 5. Commits (all on `main`, pushed to `origin/main`)

| Commit | What |
|---|---|
| `8a42f13` | Phase 1 task 1.2 — JSON-Schema gate + Zod-source freeze harness (+ deps) |
| `512d731` | Phase 1 tasks 1.3–1.9 — 16 base Appendix-A seam models |
| `4bdedf6` | Phase 1 — 11 GBrain write-through/divergence seam models |
| `bbd2007` | Phase 1 — wire contract barrel + ajv registry coverage proof |
| _(this doc)_ | close-out: plan/checkbox sync, DECISIONS/EVALUATION_CRITERIA, contracts CLAUDE.md/LESSONS, session doc |

## 6. Ops gotchas (banked)

- **Workflow burst-stall + repair pattern.** A long parallel fan-out can lose a *batch* of agents to one simultaneous API overload; they hang (no transcript writes) rather than erroring, which blocks any downstream `parallel()` barrier. Diagnose via **(a) filesystem completeness** (per unit: are all expected output files present?) and **(b) per-agent transcript staleness** (`mtime` age). Stop the run; re-run a **targeted repair Workflow** over only the incomplete units (completed units persist on disk; repair agents import them). Don't relaunch the whole fan-out.
- **`zsh` word-splitting.** Unquoted `$VAR` does NOT word-split in zsh — use an array `X=(a b c); for m in $X`, or `${=VAR}`. (Also `status` is a read-only zsh var; don't name a loop var `status`.)
- **TS4023 (branded `z.infer` + `declaration:true`).** See `packages/contracts/LESSONS.md` §1 — every branded model needs an explicit interface + `z.ZodType<Out,Def,In>` annotation; `tsc --noEmit` still enforces it.
- **`.refine` ⇏ JSON Schema.** `zod-to-json-schema` drops `.refine`; conditional invariants are enforced by Zod + tests, the ajv gate stays structural. Deeper validators are task 1.11.
- **Tooling.** Tests: `pnpm test` (root vitest workspace) or `node_modules/.bin/vitest run <path>`. Typecheck: `pnpm typecheck` (turbo). pnpm 11.5 build-gate lives in `pnpm-workspace.yaml`. `.codegraph/`/`.tokensave/` are local tool caches — now gitignored.

## 7. Carry-forward — next session

**Remaining Phase 1 = the domain layer (1.10–1.15)**, against the now-frozen `@sow/contracts`:
- **1.10** canonical-object-key + idempotency-key builders (pure, deterministic, replay-stable).
- **1.11** the 5 universal validation rules + REQ-F-017 no-inference hard-reject (delegate to the 1.2 schema-gate + the 27 models).
- **1.12 / 1.13** the 6 domain state machines (Source, Meeting Closeout, Knowledge Mutation, Proposed External Action, AgentJob, Approval) — pure total transition functions.
- **1.14** Drizzle operational-store schema source + repository interfaces (dialect-neutral, column-name parity to Appendix A).
- **1.15** shared seam fixtures (valid + per-rule invalid).

Then `/phase-exit 1` → fork the parallel tracks (Phase 1 is the forced-serial bottleneck; everything waits on it). Resolve the §4 NOTE flags at §6/§7/Phase-4. Stand up real ESLint (the `lint` script is still a `tsc --noEmit` placeholder).
