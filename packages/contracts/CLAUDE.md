<!--
  TEMPLATE: area CLAUDE.md → write to <code-area>/CLAUDE.md (e.g. app/CLAUDE.md).
  One per code area. For a multi-area project, generate one per area, each with
  its own stack + launch-protocol row. Keep the launch protocol, session
  start/end protocol, cross-doc-invariants discipline, layer rule, and
  lessons-index meta-rules VERBATIM — those are workflow machinery. Fill the
  stack + commands; leave the lookup table, forbidden patterns, cross-doc table,
  and lessons index near-empty (1-2 illustrative rows + a "populate as you go"
  note). Delete this comment.
-->

# System of Work Assistant `packages/contracts/` — Build Guide

> **You're in `packages/contracts/`.** This file plus root `CLAUDE.md` both load. The root file covers global project conventions + shared comm rules (track-prefix, escalation taxonomy, messaging budget); this file owns code-area conventions for shared contracts & domain.

## Launch protocol

| Working on... | cwd | Loads |
|---|---|---|
| Planning / docs / commits | repo root (`SoW-build/`) | root `CLAUDE.md` only |
| shared contracts & domain code | `packages/contracts/` | this `CLAUDE.md` + root |

<!-- For a multi-area project, add a row per additional code area. -->

If you find yourself fighting the wrong conventions, check your cwd.

## Session start/end protocol

**At session start:**
1. Read `IMPLEMENTATION_PLAN.md` (repo root) **by section, not whole** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for offsets, then Read with offset/limit just "Currently in progress" + the active phase. (The file grows; never load it whole.)
2. Confirm with the user what feature this session is targeting.
3. Read the relevant section of `ARCHITECTURE.md` from the lookup table below.

**At session end** (only when the user explicitly says we're done):

1. **Implementer runs `/session-end`.** Implementer writes ONLY:
   - `packages/contracts/` code files (the slice's implementation)
   - test files (the slice's tests)
   - dependency manifest / lockfile (deps the slice adds)
   - `docs/sessions/<NNN>-<date>-<topic>.md` (session doc, created at `/session-end` Step 5)

   **Implementer must NOT touch (all orchestrator territory).** *This list is the canonical statement
   of the territory rule — `/session-end`, the brief template, and the generated
   `scripts/guards/territory-guard.sh` PreToolUse hook (which mechanically enforces it in team mode)
   all point here.*
   - `IMPLEMENTATION_PLAN.md`
   - `packages/contracts/LESSONS.md`
   - `packages/contracts/CLAUDE.md` (entire file — both the Cross-doc invariants table AND the Lessons logged index)
   - `ARCHITECTURE.md`
   - `docs/orchestrator-briefing.md` / `docs/tdd-brief-template.md` / `docs/briefs/` / `docs/runbooks/`
   - other top-level deliverable / design docs
   - `.gitignore` and root-level dotfiles (unless adding a new artifact to ignore, flagged at Step 9)

   At Step 10: **explicit `git add <path>` per slice file; never `git add -A`/`.`; never stage an orchestrator-territory file.** Changes to any orchestrator-territory file (a new cross-doc model, a lesson, an arch note) are **flagged at Step 9**, not edited here — the orchestrator writes them hot (root `CLAUDE.md` + the Step-9 matrix).

2. **Orchestrator runs `/orchestrate-end`** for round close-out + Carry-forward triage + round terminal commit + push.

## Lookup table — where to find canonical info

Don't paste these sections into the prompt. Grep the file:section, read only what you need. `/check-arch <topic>` dispatches off this table.

| Topic | File (relative to repo root) | Section |
|---|---|---|
| <subsystem A> | `ARCHITECTURE.md` | §X |
| <subsystem B> | `ARCHITECTURE.md` | §Y |
| Lessons logged (full prose) | `packages/contracts/LESSONS.md` | by lesson # |

<!-- Starts near-empty. Add a row whenever a topic is looked up twice. -->

**Code intelligence & docs (when available):** prefer a code-intelligence MCP / docs MCP over grep+read loops — see root `CLAUDE.md` "Code intelligence & docs."

## Stack

<!-- ▼ EXAMPLE BLOCK [id=area-stack]: stack quick-reference for implementer sessions. Canonical stack lives in root CLAUDE.md + ARCHITECTURE.md; this is the cheat sheet. ▼ -->
- **Runtime:** Node 22 LTS + TypeScript 5.x (strict)
- **Stack:** pure TypeScript types + Zod + JSON Schema (ajv) + Drizzle schema source
- **Validation:** Zod + JSON Schema (ajv)
- **Lint / types / tests:** ESLint / tsc --noEmit / Vitest
- **Territory (this track owns):** `packages/contracts/, packages/domain/`
<!-- ▲ END EXAMPLE BLOCK [id=area-stack] ▲ -->

## Standard commands

```bash
# Install deps (run once; re-run when the manifest changes)
pnpm install

# Run the dev server (if applicable)
pnpm --filter <pkg> dev   # e.g. desktop / worker

# Tests
pnpm test

# Quality
pnpm lint
pnpm format:check
pnpm typecheck

# Preflight (use before saying "done" with a feature)
pnpm lint && pnpm typecheck && pnpm test
```

## TDD protocol

**Write the failing test first.** Applies to deterministic code — see the TDD posture in root `CLAUDE.md` for what is test-first vs. exempt.

**Commit per slice when practical.** Never bundle a safety-critical slice with anything else.

## Forbidden patterns

<!-- ▼ EXAMPLE BLOCK [id=forbidden-patterns]: forbidden patterns — 3-5 narrow, enforceable, domain-specific rules. Shape: "Don't <pattern X> because <reason / past incident>; use <alternative Y>." Test-pin them where possible. Starts small; accretes as lessons surface. ▼ -->
Do not:

1. **Write code without a failing test first** (deterministic code — every model, validator, state machine).
2. **Import any app- or adapter-side code** — `packages/contracts` and `packages/domain` are PURE (the §2.5 import-direction root). They depend on nothing downstream; a boundary test pins this.
3. **Change a seam model's field set without editing `ARCHITECTURE.md` Appendix A + its checked-in schema-snapshot in the same round** — seam models are frozen contracts shared across all 6 tracks; a silent field change is a cross-track Finding.
4. **Emit a model without its JSON Schema + a `spec(§3)`-tagged schema-snapshot test** — the schema gate (REQ-S-006) and the no-inference rule (REQ-F-017) depend on the schema being authoritative.
5. **Throw across a subsystem boundary** — return a typed `Result<T,E>` with enumerable failure variants (§16 error convention).
<!-- ▲ END EXAMPLE BLOCK [id=forbidden-patterns] ▲ -->

## Cross-doc invariants — schema/docs mirroring

Several typed models in this codebase are **contracts** mirrored in `ARCHITECTURE.md` and indexed in the table below. The architecture doc is the canonical contract; the model is the executable enforcement. Drift produces silent disagreement.

**Authoring discipline (orchestrator owns this table).** The implementer never edits this table or `ARCHITECTURE.md` directly — it flags a field add/remove/rename at Step 9 as a `Cross-doc invariant change`; the orchestrator writes the row + the arch edit hot the same round (see root `CLAUDE.md` + `docs/orchestrator-briefing.md`). Commits stagger; the working tree stays aligned within the round.

| Model | `ARCHITECTURE.md` section | Notes |
|---|---|---|
| EgressPolicy | §3, §5 | workspaceId, allowedProcessors[], rawContentAllowedProcessors[], employerRawEgressAcknowledged, acknowledgedAt? — refine: acknowledgedAt ⇔ acknowledged. |
| ToolPolicy | §3, §5, §7 | mode(read_only\|scoped_write), allowedTools[], deniedTools[], allowsMutating — read_only ⇒ !allowsMutating; deniedTools-precedence helper. |
| Capability / ProviderRoute | §3, §7 | Capability = open branded id (zod-brands). ProviderRoute = union {runtime}⊕{provider} + model, endpoint, egressClass. |
| ProviderProfile | §3, §4, §7 | provider, endpoint, model, capabilities[], egressClass, costCaps, conformanceStatus — NO inline-secret field (REQ-S-003). |
| ProviderMatrix | §3, §5, §7 | workspaceId, allowedProviders[], capabilityDefaults: Record<Capability,ProviderRoute>, rawCloudEgressEnabled, localProviderPreference? — provider-routes ⊆ allowedProviders. |
| Workspace | §3, §6 | id, name, type, dataOwner, markdownRepoPath, gbrainBrainId, defaultVisibility, egressPolicy, providerMatrix — id≡egressPolicy.workspaceId≡providerMatrix.workspaceId; defaultWorkspace() safe-default factory. |
| AgentJob | §3, §7, §9 | +trustLevel, +carriesRawContent; COST-1 budget pins; embeds ToolPolicy+ProviderRoute; isRegisteredOutputSchema() registry predicate. |
| KnowledgeMutationPlan | §3, §6, §7 | +provenanceOrigin, +gbrainProposalRef?, +signedProvenanceStamp? (LIFECYCLE flag: KW writes stamp at commit; modeled optional). REQ-F-006 reject-on-empty sourceRefs. |
| ProposedAction | §3, §8, §9 | actionId, targetSystem, canonicalObjectKey, payload, approvalPolicy, idempotencyKey. |
| ExternalWriteEnvelope | §3, §8 | embeds WriteReceipt? + approvalId?; envelope↔ProposedAction linkage helper; preconditions (arch_gap, open). |
| WriteReceipt | §8 | externalObjectId, externalUrl?, recordedAt, rawRef? — exactly-once external-write proof. |
| SourceEnvelope | §3, §8, §9 | sourceId, workspaceId(req), origin, contentHash, type, sensitivity, routingHints. |
| GclProjection | §3, §5, §6, §11 | workspaceId+visibilityLevel(req), projectionType, sanitizedPayload (raw-content gate is KEY-NAME-INDEPENDENT: rejects raw-content-shaped key OR any multi-line/over-length string value, recursive — tightened 2026-07-01), sourceRefs. |
| Approval | §3, §9, §10, §11 | id, actionRef, status(6), actor, channel(mac\|telegram), payloadHash, snoozeUntil?, expiresAt? — snooze ⇔ deferred. |
| AuditRecord | §3, §4, §16 | actor, event, refs, payloadHash, before/afterSummary (summaries only — no raw content), timestamps. |
| WorkflowRunRef | §3, §9 | workflowId, trigger, state, idempotencyKey, auditRefs[]. |
| HealthItem | §16, §10, §11 | +sync_lagging/+rebuild_divergence failureClasses, +parityReportRef?, +factIdentity?; state(open\|acknowledged\|resolved); severity open (arch_gap). |
| NotebookMapping | §8, §9 | projectId, notebookKey, driveFolderId, managedDocIds{00_brief,01_decisions,02_meetings,03_research,04_open_questions}. |
| SemanticFact | §6, §12 | factIdentity (content-independent), factKind, workspaceId, mdContentSha, revisionId. |
| FactProvenance | §6, §12 | origin(4), kwRevision?, originPath?, mdContentSha?, stampSig?, gbrainLinkSource?(nullable). |
| SignedProvenanceStamp | §6, §12 | kwRevision, originPath, mdContentSha, writerActor=literal 'KnowledgeWriter', sourceEventRef, committedAt, sig (HMAC). |
| ParityReport | §6, §12, §16 | reportId, workspaceId, reconciledAtRevision, gbrainSchemaVersion, counts, oracleFactCount?, divergences: Divergence[], cleanForServing, coverageComplete. |
| Divergence | §6, §12 | factIdentity, divergenceClass(7), severityFloor(hard\|soft), mdContentSha?, dbContentHash?, remediation(4) — db_only/unstamped ⇒ hard. |
| QuarantineRecord | §6, §16 | factIdentity, workspaceId, divergenceRef(id, not embed), divergenceClass, capturedDbDigest, remediationState(5), healthItemId, auditRef, planId?. |
| GBrainProposedFact | §6, §7 | proposalId, workspaceId, factKind, proposedContent(open), evidenceRefs: CanonicalSourceRef[] (≥1; canonical-only), confidence∈[0,1], generatedBy(4), requiresApproval=default true. |
| GbrainReadGrant / GbrainServePolicy | §6, §7 | workspaceId, brainId, transport='http', scope=['read'], tokenRef, allowedOps[], federationScope='workspace_only', generativeCycleEnabled=false, pinnedSha, indexSchemaVersion (alias: one schema, one $id). |
| GbrainPin | §6, §13 | gbrainSha(40-hex), gbrainTag, gbrainRepo, indexSchemaVersion(int≥0), validatedOn(date\|PENDING sentinel), validationRef, writeThroughEnabled=default false. Mirrors config/gbrain.pin (camel↔snake parser is Phase-4 task 4.20). |

> **All 27 frozen 2026-06-30 (Phase 1, tasks 1.2–1.9).** Authoring = ADR-008 Zod-as-source: each model is `XSchema` (`.strict()`) → `z.infer` type → generated `schemas/<kebab>.schema.json` → frozen `__snapshots__/<kebab>.snap` (top-level field-name set) → registered in the ajv-strict registry. **A field add/remove/rename requires editing `ARCHITECTURE.md` Appendix A + the model's schema + its `.snap` in the same round** — `registry-all.test.ts` + the per-model snapshot test fail otherwise. Shared sub-shapes (`ContextRef`/`SourceRef`/`NoteCreate`/`NotePatch`/`LinkMutation`/`FrontmatterPatch`/`CanonicalSourceRef`) live in `src/models/shared-shapes.ts`; shared enums in `src/models/shared-enums.ts`; brands in `src/primitives/zod-brands.ts` — never re-declare them inline.

## Module organization

<!-- ▼ EXAMPLE BLOCK [id=module-layout]: module layout + layer dependency rule. Replace with the project's real directory tree and import-direction DAG. ▼ -->
```
packages/contracts/   runtime-safe types · JSON Schemas · tRPC router types · event catalog · model snapshots
packages/domain/      pure rules · the 6 state machines · validators (schema gate, no-inference) · canonical-key/idempotency builders
```

Layer dependency direction (top depends on bottom, never reverse):

```
(everything downstream) → packages/domain → packages/contracts
packages/contracts + packages/domain import NOTHING app- or adapter-side (pure root of the DAG)
```
<!-- ▲ END EXAMPLE BLOCK [id=module-layout] ▲ -->

## Subagents

See `.claude/agents/README.md` for the canonical inventory + integration points.

<!-- ▼ EXAMPLE BLOCK [id=area-subagent-candidates]: area-specific subagent candidates — list candidates that would earn their keep specifically in this area (e.g. an ABI/types syncer for a frontend area, a Pyth/feed verifier for a contracts area). Build only on real friction. ▼ -->

<!-- ▲ END EXAMPLE BLOCK [id=area-subagent-candidates] ▲ -->

## Lessons logged from prior sessions

The full prose for each lesson lives in `packages/contracts/LESSONS.md`. This index is the compact orientation surface.

**Lesson numbers are stable IDs** — once assigned, they don't change. New lessons get the next sequential number. `/session-end` proposes additions when it detects them; the user approves before the entry is written and a row is added here.

Lessons start at §1.

| # | Date | Topic | Rule (one-liner) |
|--:|---|---|---|
| 1 | 2026-06-30 | Branded `z.infer` + `declaration:true` → TS4023 | A model whose Zod schema embeds a branded ID must export an explicit `interface` + annotate the schema `z.ZodType<Out, ZodTypeDef, In>` — never rely on bare `z.infer` for the exported type. |
| 2 | 2026-06-30 | Zod-as-source contract recipe (ADR-008) | Each Appendix-A model ships 4 files (`.ts`/`schemas/*.schema.json`/`__snapshots__/*.snap`/test); JSON Schema is generated (never hand-written); import shared brands/enums/sub-shapes — never re-declare them inline. |
| 3 | 2026-06-30 | ajv `validate()` is structural-only — gate is a composition | `zod-to-json-schema` drops `.refine`; the candidate-data gate = ajv `validate()` + the model's Zod parse + the §3 universal rules + the §5/§6/§7 predicates — never ajv alone. |
| 4 | 2026-07-01 | Isolate the URL authority before extracting host in a security predicate | A loopback/SSRF/allowlist gate parsing an untrusted endpoint must strip path/query/fragment + backslash to isolate the authority BEFORE stripping userinfo/host — userinfo-first is spoofable (`http://evil.com/@127.0.0.1` → fake loopback → Phase-3 egress-veto bypass). Green unit tests ≠ safe; gate it with an adversarial-verify pass + regression tests. |

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->
