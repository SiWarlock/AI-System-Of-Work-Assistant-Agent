# Session 002 — GBrain write-through amendment + Phase 1 start

- **Date:** 2026-06-29 → 2026-06-30
- **Predecessor:** `001-2026-06-29-phase-0-spikes.md` (Phase 0 close-out)
- **Operating model:** single-operator (one session) driven via the Workflow tool — NOT a team. Ultracode on.
- **Outcome:** Contract fully settled (write-through amendment + Phase-0 fold-forward); **Phase 1 started** — task 1.1 (monorepo + shared primitives) TDD-green and committed.

---

## Headline

This session took the build from "Phase 0 closed" to "Phase 1 underway," with one large architectural addition in between: **GBrain write-through ships in V1, fail-closed**, reversing the Phase-0 read-only/index-only deferral. Everything is committed and pushed to `origin/main` (head `6f00419`).

## 1. What happened (arc)

1. **GBrain installed + organized.** Installed gbrain **0.35.1.0** locally (via gstack `/setup-gbrain`, local PGLite), source at `~/gbrain`, MCP registered (user scope), on PATH via `~/.zshenv`. Local embeddings work (no key needed); `VOYAGE_API_KEY` set but deferred to Phase-4 embedding tuning.
2. **Coding-brain model (option A).** Decided to run **one** local gbrain organized by the 3 SoW workspaces via slug-prefix + `ws:` tag (employer-work / personal-business / personal-life), so it migrates cleanly to 3 governed brains later (or stays one). Convention lives in global `~/.claude/rules/gbrain-workspaces.md` + 3 seeded bucket index pages. Coding work routes by who-it's-for; never per-project brains.
3. **DB-canonical reversal considered + REJECTED.** Keep Markdown canonical (Obsidian editing, durability vs gbrain version churn, no-hidden-brain, and the egress veto is only enforceable because truth flows through KnowledgeWriter into visible Markdown). gbrain is DB-first natively → SoW inverts by policy. gbrain's generative features (dream/synthesize/patterns/Minions) ship as a **gated proposal source**, not an autonomous writer.
4. **Write-through + divergence layer designed** (8-agent Workflow: ground against real gbrain source → 3 independent designs → 3 adversarial safety critics → synthesis). Full spec: **`docs/design/gbrain-write-through-divergence.md`**.
5. **Amendment written + committed** to the binding contract.
6. **Phase-0 fold-forward** ratified into the contract.
7. **Phase 1 started** — monorepo bootstrap + shared primitives, TDD-green, committed.

## 2. Write-through + divergence — the design (see `docs/design/...` for full spec)

**Core insight:** serve answer bytes **from committed Markdown** (the gbrain DB is a pointer/ranking index only) + derive the canonical "what should exist" set with a **SoW-owned, gbrain-INDEPENDENT Markdown parser** (gbrain is outside its own checker's trust base).

**Three independent safety legs:** (1) bytes-from-Markdown serving gate (default-deny); (2) gbrain-independent allow-set + unforgeable **HMAC** provenance stamp (SecretsPort key the generative/runtime never hold); (3) OS-level one-writer lockdown (vault read-only mount + filesystem ACL for every gbrain process). **Fails closed:** any divergence → withhold + `parity_defect` HealthItem; worst case is a pending-review item, never a corrupted answer. `writeThroughEnabled` is per-workspace **default-OFF** (read-only/index-only fallback) until the 4 GO conditions pass LIVE.

**Generative features survive** as propose-only: gbrain output → `GBrainProposedFact` → validation → `KnowledgeMutationPlan` → KnowledgeWriter → Markdown → re-index. Read/analysis features (search/graph/salience/anomalies/code-search) used freely. `dream`/`autopilot`/`sync --install-cron` auto-write-and-serve modes are hard-disabled in V1.

## 3. Contract amendment (committed `cf8ada9`)

- **`ARCHITECTURE.md`:** §6 (write-through layer + 7 invariants + positive out-of-band attribution + OS lockdown), §12 (4 GO conditions + adversarial + fail-closed suites), §13 (re-capture vs 0.35.1.0 + enablement gate), §16 (parity operational-truth + HMAC key), **Appendix A** (+9 new models; `KnowledgeMutationPlan` + `HealthItem` amended — the latter also closes a latent `sync_lagging` gap), §2.5 freeze list, Spec-Anchor Index (+`REQ-K-NEW-001/002/003`, `REQ-S-NEW-008`).
- **`IMPLEMENTATION_PLAN.md`:** Phase-1 freeze list +11 models + seam note; Phase-4 4.6/4.7/4.9 amended + **4.14–4.20 new**; Phase-12 12.7 amended + **12.22/12.23 new**; 11.3/11.5; task 1.13; reversed 0.2 deferral + Decisions-tabled.
- **`config/gbrain.pin`:** typed `GbrainPin` re-captured vs 0.35.1.0 (sha `3933eb6a`, schema_version 2, `write_through_enabled=false`, `validated_on=PENDING_PHASE12`).

**The 11 models that MUST freeze in Phase 1:** `SemanticFact`, `FactProvenance`, `SignedProvenanceStamp`, `ParityReport`, `Divergence`, `QuarantineRecord`, `GBrainProposedFact`, `GbrainReadGrant`/`GbrainServePolicy`, `GbrainPin` (NEW) + amended `KnowledgeMutationPlan` & `HealthItem`.

## 4. Phase-0 fold-forward (committed `cb8ad14`)

- §10 push primitive = **WebSocket** (OQ-002); §7 Hermes **hybrid** surface + provider conformance defaults (OQ-003/007); §18 perf SLOs + cost/concurrency caps (OQ-004/Perf-pass) — OQ rows marked resolved.
- **`packages/providers/LESSONS.md` §1** (+ CLAUDE.md index): Hermes empty-`-t` → full mutating toolset; read-only/ING-7 runs must pass an explicit non-empty minimal toolset.

## 5. Phase 1 status (committed `6f00419`)

**Task 1.1 DONE (TDD-green):**
- TS monorepo bootstrapped: pnpm workspaces + Turbo + Vitest + strict `tsconfig.base.json`.
- `@sow/contracts` + `@sow/domain` packages (pure; no app/adapter imports per §2.5).
- Shared primitives: branded opaque IDs (reject empty/whitespace via `InvalidIdError`; cross-assignment blocked at compile time), exact-literal enums + guards (`WorkspaceType`/`DataOwner`/`VisibilityLevel`/`ProviderId`/`EgressClass`) + branded `ProcessorId`/`ToolId`, `Result<T,E>` envelope, event-name catalog.
- **`pnpm test`: 9 passed; `pnpm typecheck`: clean (strict).**

**Remaining Phase-1 tasks (14):** 1.2 JSON-Schema gate (REQ-S-006) → 1.3–1.9 contract models (incl. the 11 write-through seam models) → 1.10 canonical-key/idempotency builders → 1.11 universal validators + no-inference (REQ-F-017) → 1.12/1.13 the 6 domain state machines → 1.14 Drizzle schema + repo interfaces → 1.15 seam fixtures.

## 6. Commits (all pushed to `origin/main`)

| Commit | What |
|---|---|
| `af1eea4` | Phase 0 close-out (session 001) |
| `cf8ada9` | GBrain write-through + divergence amendment |
| `cb8ad14` | Phase-0 decisions folded into the contract |
| `6f00419` | Phase 1 task 1.1 — monorepo scaffold + shared primitives |
| `319232f` | this session-002 handoff doc |
| `0914f11` | orchestrate-end reconciliation (DECISIONS/EVALUATION_CRITERIA sync; Decisions→Log; Carry-forward) |

## 7. Ops notes / gotchas (for the next session)

- **Run tests:** `pnpm test` (root vitest workspace) or `node_modules/.bin/vitest run --root packages/<pkg>`. `pnpm typecheck` runs turbo per-package `tsc --noEmit`.
- **pnpm 11.5 config lives in `pnpm-workspace.yaml`, NOT `.npmrc`:** `allowBuilds: {esbuild: true}` (build-script gate) + `verifyDepsBeforeRun: false` (the pre-run deps-check re-runs install and trips on the gate). pnpm may re-inject an `allowBuilds: esbuild: <stub>` prompt — set it to `true`.
- **ESLint not yet configured** — the `lint` script is a `tsc --noEmit` placeholder; real ESLint is a later slice.
- **Commit discipline:** explicit `git add <path>` (never `-A`); Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer; push to `origin/main`. Never stage `.env` / `scaffold/`.
- **gbrain:** installed 0.35.1.0, on PATH; coding brain is the default `~/.gbrain` (per `~/.claude/rules/gbrain-workspaces.md`). The SoW product's per-workspace brains are SEPARATE instances (Phase 4).

## 8. Carry-forward — next session

**The workflow fan-out experiment.** Do Phase 1 tasks **1.2–1.9 + the 11 write-through seam models** as a **Workflow fan-out** (deliberate test of single-session + Workflow vs a team). Author a Workflow that, per model, produces the TS type + Zod schema + strict JSON Schema + a `spec(§)`-tagged schema-snapshot test (freezes the field-name set), then a **synthesis/consistency stage** to reconcile shared sub-shapes (`ProviderMatrix`→`Capability`/`ProviderRoute`, `AgentJob`→`ToolPolicy`, the write-through models that reference each other) so nothing drifts, then a verify stage (`pnpm test` + `pnpm typecheck` green). Honor TDD. **Propose the Workflow plan and get owner approval before running.** Field summaries: `ARCHITECTURE.md` Appendix A; freeze authority: §2.5 + the Phase-1 freeze list.
