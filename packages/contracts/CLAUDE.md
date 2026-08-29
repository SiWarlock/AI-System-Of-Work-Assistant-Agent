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
⛔ **Read its FAILURE MODES block in the same breath (`### 24.87`) — the instruction and its known failures are one unit.** ⭐ **The asymmetry in one line: _the graph is not a census_ — a HIT is a LEAD, an EMPTY or an EDGE is a QUESTION.** All three tools fail toward PLAUSIBLE, so a wrong answer is indistinguishable from a right one at the point of reading. ⛔ And a TRUNCATED search is never evidence of absence.

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
6. **Re-define a safety predicate/sanitizer that already exists in a lower package** — RE-EXPORT it. A second definition diverges silently from the grammar or guard it tracks (L39/L9: the region-marker neutralizer must live where `REGION_MARKER_RE` lives). Pin it three ways, because a name-grep pins the NAME and not the DEFENSE: referential identity to the canonical symbol, a DEFINITION census (`function` AND `const` forms — an `export const` re-fork is the shape that actually happens), and a MATCHER-LITERAL census (a re-forked regex with the same name is the real hazard). `pattern: [ "$(grep -rlE 'export (function|const) neutralizeRegionMarkers' --include='*.ts' packages apps | grep -vE '/(test|dist|node_modules)/' | wc -l | tr -d ' ')" = 1 ]`
7. **Assert a safety posture from a constant, a default-seed, or a hardcoded string** — DERIVE it from the governing durable state (L56: four rule-5 issues in one round shared this shape). The test: change the governing state and assert the claim moves; a claim that cannot move is a decoration that reads as a guarantee. `pattern: [ -z "$(grep -rnE '\"(local-only|zero-egress)\"|>[^<]*(local-only|zero-egress)' --include='*.tsx' apps/desktop/renderer 2>/dev/null | grep -v /test)" ]`
8. **Cite a plan task or another document's section as a bare `§N.x`** — `ARCHITECTURE.md`'s real numbered subsections are **`§19.x` AND `§2.5`**; every other `§N.x` is shorthand (L101). ⛔ **CLASSIFIER CORRECTED 2026-08-11 (24.6 round 4 / `LES-1`) — `§19.x` **AND `§2.5`** are real anchors; every OTHER `§N.x` is shorthand.** ⚠ **The prior wording — *"real numbered subsections ONLY under §19 … by construction NOT an architecture anchor"* — was FALSE, and it was LOAD-BEARING: `ARCHITECTURE.md:80` is `## §2.5 — Subsystem dependency DAG & parallelization seams`, corroborated three ways (Phase 9's declared `Spec anchors:` line · this file's own *"the §2.5 import-direction root"* · `docs/tdd-brief-template.md`'s seam bullet).** ⛔ **Applying the old rule would have STRIPPED the one cross-cutting seam anchor the brief template mandates.** ⭐ **The correction landed in `IMPLEMENTATION_PLAN.md` (`25acd598`, 2026-07-30) and NEVER PROPAGATED HERE — and a brief dated one day later cited the falsified universal as its justification.** *(contracts L94: a correction that reaches the channel STATING a claim and not the channel REPEATING it leaves the repeating channel authoritative.)* Architecture ⇒ bare `§N`; plan task ⇒ `task N.M`; another doc ⇒ path + its own numbering. A dangling citation gets investigated; an **ambiguous** one gets believed. `pattern: grep -nE '§(1[0-8]|[0-9])\.[0-9]' IMPLEMENTATION_PLAN.md` — hits are CANDIDATES to classify (87 at L101's writing), not defects.
9. **Retain a struck/superseded block with its STATUS or NEXT-ACTION lines intact** — striking a block does NOT tense-shift the sentences inside it (L195). ⛔ **`### 24.84` retained a voided owner ruling ending `STATUS: RE-PUT TO THE OWNER, UNDECIDED`; an implementer read it as live and nearly reopened a settled cat-4 decision** — the live `FINAL OWNER RULING` sat ~4,800 chars ABOVE it, so the dead status line was the LAST and most recent-looking state in the entry. **Keep the REASONING (that is why we retain); strip or past-tense the STATE.** Narrative survives striking; a status claim does not. `pattern: grep -nE '^>?[^A-Za-z0-9]*(STATUS|NEXT|PENDING|UNDECIDED|IN FLIGHT|AWAITING)' IMPLEMENTATION_PLAN.md` — hits inside a struck/retained block are defects; elsewhere they are CANDIDATES to classify.
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
| ProviderId (enum) | §7, §5 | **+`perplexity` +`xai` (RES-1, 13.13, 2026-07-25)** — egress-cloud research processors, each its OWN processor (never an OpenAI/alias). Frozen-contract round: the enum expansion regenerated **5** embedding schemas (provider-route + provider-profile + provider-matrix + agent-job + workspace) + snapshots + membership pins. NOT a §5-veto edit — the rule-5 veto is ProviderId-AGNOSTIC (`LOCAL_PROVIDERS` opt-in allowlist; a new provider absent from it is egress-classed fail-closed BY CONSTRUCTION). L25. |
| Workspace | §3, §6 | id, name, type, dataOwner, markdownRepoPath, gbrainBrainId, defaultVisibility, egressPolicy, providerMatrix — id≡egressPolicy.workspaceId≡providerMatrix.workspaceId; defaultWorkspace() safe-default factory. |
| AgentJob | §3, §7, §9 | +trustLevel, +carriesRawContent; COST-1 budget pins; embeds ToolPolicy+ProviderRoute; isRegisteredOutputSchema() registry predicate. |
| AgentExtractionCandidate | §7, §9, §19.5 | NEW (18.11/CP-1 GATE-1): { fields: Record<name,{value: string\|number(finite)\|boolean\|"TBD", evidenceRef?}> }; `sow:agent-extraction` schema — strict outer+inner + `__proto__`/`constructor`/`prototype` propertyNames blocklist, value `anyOf` (excludes null; finite number), empty `{fields:{}}` structurally valid. Evidence-preserving so `validateNoInference` sees the model's real `evidenceRef` (anti-KMP-stand-in, REQ-F-017). TS type `AgentExtractionCandidate` (avoids @sow/workflows `AgentExtraction` collision); schema id `sow:agent-extraction`. Union member + producer/consumer legs = CP-2/CP-3; charset + maxProperties/maxLength bounds = Future-TODO (§9 catalog). ⛔ **AMENDED 2026-07-31 (13.8g-C leg A, `5eaf33f5`) — a SCOPED, DECLARED, DEFAULT-CLOSED RELAXATION of this rule-2 gate, NOT a reclassification:** exactly the fields in `LIST_VALUED_EXTRACTION_FIELDS` (`attendees`, `decisions`) may additionally carry a `string[]` capped at 200, elements scalar-validated, **nesting rejected**; scalar/`TBD` stay legal everywhere and **every undeclared field keeps today's scalar-only rejection.** ⭐ Default-closed falls out of JSON Schema's own precedence (`properties` for declared keys over `additionalProperties` for the rest), which answers *"can a candidate declare its own list-ness?"* **BY CONSTRUCTION** — a payload cannot add itself to `properties`. ⚠ The container swap drops **three** guards (ajv `propertyNames`; Zod's own key check; and Zod SILENTLY DROPPING a `__proto__` own-key during reconstruction) — all restored via a `z.preprocess` key guard + a `guardCatchallPropertyNames` policy in `emit.ts`; `propertyNames` **verified by READING the regenerated JSON**, and the three reserved-key assertions confirmed **byte-unchanged**. |
| KnowledgeMutationPlan | §3, §6, §7 | +provenanceOrigin, +gbrainProposalRef?, +signedProvenanceStamp? (LIFECYCLE flag: KW writes stamp at commit; modeled optional), +expectedProjectId? (§13.10a gate 1 — verification-only raw projectId; executor rejects a NotePatch whose target frontmatter projectId ≠ this). REQ-F-006 reject-on-empty sourceRefs. |
| ProposedAction | §3, §8, §9 | actionId, targetSystem, canonicalObjectKey, payload, approvalPolicy, idempotencyKey. |
| EntityRef | §3 | name, kind — the living-vault synthesis entity reference; `.strict()` Zod schema + generated JSON Schema (13.18, §DEC-CANDGATE leg 1). Was knowledge-local and UNVALIDATED; now a gated candidate type (REQ-S-006). ✅ **leg 2 LANDED `93cafe5f`** (13.19): knowledge re-points the import, the duplicate declaration is deleted, and the schema is **called** at the `planSynthesis` boundary — so the interim two-declaration state is **over**. ⚠ Leg 3 (worker) remains. *(Prose corrected 2026-07-29 — flagged by the knowledge implementer at `/session-end`; the row said "until then… declared in BOTH places" after "then" had already happened.)* |
| ExternalWriteEnvelope | §3, §8 | embeds WriteReceipt? + approvalId?; envelope↔ProposedAction linkage helper; preconditions (arch_gap, open). |
| WriteReceipt | §8 | externalObjectId, externalUrl?, recordedAt, rawRef? — exactly-once external-write proof. |
| SourceEnvelope | §3, §8, §9 | sourceId, workspaceId(req), origin, contentHash, type, sensitivity, routingHints, **+body?** (candidate extracted text — additive/optional, gate-validated string-if-present, no embedder leak until 15.3; §19.2 note-body threading / §8). |
| GclProjection | §3, §5, §6, §11 | workspaceId+visibilityLevel(req), projectionType, sanitizedPayload (raw-content gate is KEY-NAME-INDEPENDENT: rejects raw-content-shaped key OR any multi-line/over-length string value, recursive — tightened 2026-07-01), sourceRefs. |
| Approval | §3, §9, §10, §11 | id, actionRef?, planRef?, subjectKind(external_action\|semantic_mutation), workspaceId(req), status(6), actor, channel(mac\|telegram), payloadHash, snoozeUntil?, expiresAt? — snooze ⇔ deferred; **§13.10a SUBJECT invariant (refine): subjectKind discriminates the card subject — external_action ⇒ actionRef only; semantic_mutation ⇒ planRef only (exactly the matching ref; a mis-routed card is unrepresentable)**; workspaceId = WS-4 inbox-scope attribution (set at record time, server-bound). |
| AuditRecord | §3, §4, §16 | actor, event, refs, payloadHash, before/afterSummary (summaries only — no raw content), timestamps, workspaceId? (optional WS-8 scope for the §9.5 recent-changes projector; global events unscoped — EventLog/LogRecord precedent; plain string to keep the model brand-free). |
| Project | §3, §6, §9, §13.5 | id(ProjectId), workspaceId, slug, title, lifecycleState(idea\|planning\|active\|paused\|done\|archived), timeline[](bi-temporal, append-only), provenanceOrigin — SEMANTIC (Markdown frontmatter, KW-owned, no operational table); lifecycleState ≡ latest timeline head; 7th state machine (packages/domain/src/state/project.ts) asserts enum equivalence. **ProvenanceOrigin extended** +project_capture/+project_sync (§13.5) +copilot_propose (§13.10a Copilot semantic-write bridge) — each same round; grows the KMP + Project schema enum. |
| Task | §3, §6, §9, §13.15 | id(TaskId), workspaceId, projectId?(ProjectId, optional binding), title, status(TaskLifecycle: todo\|in_progress\|blocked\|done\|cancelled), priority?(Priority: p0\|p1\|p2\|p3 — optional, NEVER inferred: absent⇒unset, REQ-F-017), dueDate?(ISO), provenanceOrigin — SEMANTIC (Markdown-canonical, KW-owned); the db `TaskRow` (dual-dialect TaskRepository, mirrors ProjectRegistry) is a DERIVED operational ROLLUP INDEX (omits provenanceOrigin — NOT a 2nd writer, safety rule 1); NEW enums TaskLifecycle+Priority, NEW brand TaskId; consumed by 13.16 (§13.15, ARC-2 `54b052a7`). |
| WorkflowRunRef | §3, §9 | workflowId, trigger, state, idempotencyKey, auditRefs[]. |
| HealthItem | §16, §10, §11 | +sync_lagging/+rebuild_divergence/**+security_violation/+policy_denial/+egress_denied/+isolation_breach** (task 11.8 C-enum: terminal SECURITY/POLICY/EGRESS/ISOLATION causes) /**+db_unavailable/+provider_routing_unavailable/+outbox_blocked/+write_through_blocked** (task 13.15 ARC-2: db-read/enumeration-unavailable / no-eligible-provider-routing / external-write-outbox-gated / write-through precondition-HELD vs write_through_failed=attempt-errored) failureClasses, +parityReportRef?, +factIdentity?; state(open\|acknowledged\|resolved); severity open, but `defaultSeverityForFailureClass` (`@sow/workflows` activities/healthItem.ts, assertNever-guarded) supplies a per-class default when a producer omits it (security/isolation→critical, policy/egress/provider_routing_unavailable/outbox_blocked→error, else warn incl. db_unavailable/write_through_blocked; producer-explicit severity wins). |
| NotebookMapping | §8, §9 | projectId, notebookKey, driveFolderId, managedDocIds{00_brief,01_decisions,02_meetings,03_research,04_open_questions}. |
| SemanticFact | §6, §12 | factIdentity (content-independent), factKind, workspaceId, mdContentSha, revisionId. |
| FactProvenance | §6, §12 | origin(4), kwRevision?, originPath?, mdContentSha?, stampSig?, gbrainLinkSource?(nullable). |
| SignedProvenanceStamp | §6, §12 | kwRevision, originPath, mdContentSha, writerActor=literal 'KnowledgeWriter', sourceEventRef, committedAt, sig (HMAC). |
| ParityReport | §6, §12, §16 | reportId, workspaceId, reconciledAtRevision, gbrainSchemaVersion, counts, oracleFactCount?, divergences: Divergence[], cleanForServing, coverageComplete. |
| Divergence | §6, §12 | factIdentity, divergenceClass(7), severityFloor(hard\|soft), mdContentSha?, dbContentHash?, remediation(4) — db_only/unstamped ⇒ hard. |
| QuarantineRecord | §6, §16 | factIdentity, workspaceId, divergenceRef(id, not embed), divergenceClass, capturedDbDigest, remediationState(5), healthItemId, auditRef, planId?. |
| GBrainProposedFact | §6, §7 | proposalId, workspaceId, factKind, proposedContent(open), evidenceRefs: CanonicalSourceRef[] (≥1; canonical-only) — `CanonicalSourceRef`={kind, ref, span?, **block?** optional numbered `(src:Bn)` back-ref, 13.7a `58599b3`, additive/DORMANT}, confidence∈[0,1], generatedBy(4), requiresApproval=default true. |
| GbrainReadGrant / GbrainServePolicy | §6, §7 | workspaceId, brainId, transport='http', scope=['read'], tokenRef, allowedOps[], federationScope='workspace_only', generativeCycleEnabled=false, pinnedSha, indexSchemaVersion (alias: one schema, one $id). |
| GbrainPin | §6, §13 | gbrainSha(40-hex), gbrainTag, gbrainRepo, indexSchemaVersion(int≥0), validatedOn(date\|PENDING sentinel), validationRef, writeThroughEnabled=default false. Mirrors config/gbrain.pin (camel↔snake parser is Phase-4 task 4.20). |

> **All 27 frozen 2026-06-30 (Phase 1, tasks 1.2–1.9); +Project (§13.5, 2026-07-06) = 28; +Task (§13.15, ARC-2 2026-07-25) = 29.** Authoring = ADR-008 Zod-as-source: each model is `XSchema` (`.strict()`) → `z.infer` type → generated `schemas/<kebab>.schema.json` → frozen `__snapshots__/<kebab>.snap` (top-level field-name set) → registered in the ajv-strict registry. **A field add/remove/rename requires editing `ARCHITECTURE.md` Appendix A + the model's schema + its `.snap` in the same round** — `registry-all.test.ts` + the per-model snapshot test fail otherwise. Shared sub-shapes (`ContextRef`/`SourceRef`/`NoteCreate`/`NotePatch`/`LinkMutation`/`FrontmatterPatch`/`CanonicalSourceRef`) live in `src/models/shared-shapes.ts`; shared enums in `src/models/shared-enums.ts`; brands in `src/primitives/zod-brands.ts` — never re-declare them inline.

> ⭐ **UI-SAFE PROJECTIONS ARE INDEXED IN `ARCHITECTURE.md` APPENDIX A BUT ARE DELIBERATELY *NOT* ROWS IN THE TABLE ABOVE — and the distinction is load-bearing, not bookkeeping.** The table above is the **29 frozen seams**: Zod-as-source → generated `schemas/<kebab>.schema.json` → frozen `.snap` → ajv-strict registry. A **UI-safe projection** (`src/api/ui-safe.ts`) has **none of those** — no generated schema, no snapshot pin, no registry entry — so listing one here would assert a freeze that does not exist and would put the "29 frozen" count in doubt. **Current projections, both carrying Appendix-A rows:** `UiSafeCopilotAnswer` (§9.6 — the Copilot sidebar's candidate-gate / leakage contract) and `UiSafeAuditDrillSummary` (§9.41 leg A — the audit drill-down; `auditRef` never leaves the worker). ⛔ **They are still ORCHESTRATOR-WRITE territory and still cross-doc invariants** — a field change needs its Appendix-A row edited in the same round, and an implementer flags it at Step 9 rather than editing it. ⚠ **This note exists because the gap it closes was found the hard way:** `UiSafeAuditDrillSummary` shipped with consumers on **both** the worker (`api/procedures/queries.ts`) and desktop (`renderer/lib/audit-drill.ts`) legs while having **no** row in either doc, and the only mechanism that surfaced it was an implementer noticing an absence in territory it is forbidden to edit.

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

Three files, three jobs: **full prose** in `packages/contracts/LESSONS.md` · the **complete 256-row index** in `packages/contracts/LESSONS-INDEX.md` · and below, the **always-on core** — the subset that loads every session.

**Lesson numbers are stable IDs** — once assigned, they don't change. New lessons get the next sequential number. `/session-end` proposes additions when it detects them; the user approves before the entry is written. ⛔ **A new or amended lesson moves BOTH `LESSONS.md` AND its row in `LESSONS-INDEX.md`, in the SAME commit** — the row is the copy that gets paraphrased into code comments, and letting it drift is a measured defect (`### 24.147`). Only add to the core below if the rule actually fires most sessions.

Lessons start at §1.

| # | Rule (the always-on core) |
|--:|---|
| **INSTRUMENTS** | *every defect below was found by an instrument, and several were nearly caused by one* |
| [155](LESSONS.md#155) · [243](LESSONS.md#243) | **Branch on EXIT CODES; never parse rendered output.** A pipe truncates silently and UNDER-reports, and `$?` after a pipeline is the LAST command's. Redirect to a file, then measure the file. |
| [160](LESSONS.md#160) · [249](LESSONS.md#249) · [256](LESSONS.md#256) | **Positive-control every empty result, and report the control's VALUE, not just that it passed.** A correct answer from a broken instrument is worse than a wrong one — it validates the method for reuse. Controls fail three ways, all reassuring: invisible control, unread magnitude, wrong population. |
| [157](LESSONS.md#157) · [152](LESSONS.md#152) · [253](LESSONS.md#253) | **An EMPTY or a MAX is a QUESTION, not a verdict.** `codegraph` "no callers" misses callback-position sites; an unresolvable citation makes a claim UNVERIFIED, not refuted; "the max is N" is an absence claim wearing a number. |
| [178](LESSONS.md#178) · [205](LESSONS.md#205) · [212](LESSONS.md#212) | **Non-vacuity ≠ applicability.** A working instrument pointed at the wrong input reports confidently. A zero exit is ambiguous between "worked" and "never applied" — verify the EFFECT with a DIFFERENT instrument. |
| [244](LESSONS.md#244) · [201](LESSONS.md#201) | **An instrument characterization is SESSION-SCOPED.** `grep` resolves to different binaries in different sessions; wrapped tools have been seen to duplicate and to fabricate absence. State the session that measured it. |
| [199](LESSONS.md#199) | **A subagent's "I verified it" is a CLAIM, not a measurement.** Re-read any cited `file:line` before it enters a durable artifact. |
| **CLAIMS — the dominant defect surface** | *measured 2026-08-28: 9 defects in one session, 6 of them sentences rather than code* |
| [126](LESSONS.md#126) · [143](LESSONS.md#143) | **A lesson records that a defect WAS fixed; a finding records what WAS true.** Neither is evidence about now. Re-MEASURE at HEAD; a triage pass that only re-reads is transcription. |
| [145](LESSONS.md#145) · [161](LESSONS.md#161) | **A comment claiming its own code is LIVE / LOAD-BEARING / safe "by construction" is a whole-program claim made from inside one file.** Overstating invites the reader to stop checking; understating invites deletion AND disguises a regression as the documented state. Entry docs (file header, docblock, config field, index row) rot first — they are nobody's diff. |
| [94](LESSONS.md#94) · [169](LESSONS.md#169) · [174](LESSONS.md#174) | **A correction must reach EVERY channel that carries the claim — especially the INSTRUCTION derived from it, and the INDEX row.** A correction does not protect its own author: grep your own diff for the retracted wording. |
| [100](LESSONS.md#100) · [154](LESSONS.md#154) · [180](LESSONS.md#180) | **A negative claim inherits its search's scope; a measurement of one unit does not license a claim about the system.** State the scope and the CALL PATH with the claim. "Instances I have seen" is a sample, not a population. |
| [99](LESSONS.md#99) · [104](LESSONS.md#104) | **Enumerate, then CLASSIFY — a grep hit is a CANDIDATE.** No mechanical check separates a USE from a MENTION, so the document explaining a rule is the one most likely to trip its own check. Never resolve that by deleting the explanation. |
| [82](LESSONS.md#82) · [186](LESSONS.md#186) · [194](LESSONS.md#194) | **On finding a false claim: make it TRUE or RETRACT it — never re-point it at handy evidence.** Ask whether the doc DESCRIBES or CONSTRAINS: editing a contract to match reality makes the defect unfindable. Deleting an overclaim can delete the only map to it. |
| [235](LESSONS.md#235) · [233](LESSONS.md#233) | **Put uncertainty in the NAME, not only in a caveat** — a hedge in a Done-when does not travel; the title does. And a RIGHT conclusion carried by a WRONG mechanism licenses the wrong remedy. |
| **GUARDS** | |
| [103](LESSONS.md#103) | ⭐ **HOUSE PATTERN — make the violation UNREPRESENTABLE; a detector is belt, never the mechanism.** If the cheapest edit that re-opens it is "add a call site", you built a detector. |
| [75](LESSONS.md#75) · [237](LESSONS.md#237) · [254](LESSONS.md#254) | **Prove a guard by SIMULATING the compromise, and see it FAIL before you trust it passing.** Mutation coverage is per-ASSERTION (a runner aborts at the first failure). A pin that no mutation reds ALONE is documentation, not detection. |
| [80](LESSONS.md#80) · [90](LESSONS.md#90) · [192](LESSONS.md#192) | **Would a constant DENY change anything?** A suite asserting a gate SAID NO cannot tell a working gate from a brick wall. Anchor non-vacuity to the SUBJECT: delete your feature and ask whether the guard still passes. |
| [216](LESSONS.md#216) · [232](LESSONS.md#232) | **A guard's claims must be falsifiable IN PLACE, or name where to check them** — an unverifiable count rots toward deletion. And separate PROPERTY assertions (never edit to pass) from COMPLETENESS assertions (built to red when the set grows). |
| [89](LESSONS.md#89) · [131](LESSONS.md#131) | **A gate named for a check it does not perform is worse than an absent one — its PASSING is read as evidence.** Write conditions as OUTCOMES; one phrased as an ACTION is discharged by activity. ⚠ In this repo `lint` IS `tsc --noEmit`; there is no ESLint. |
| **SCOPE & SAFETY** | |
| [61](LESSONS.md#61) · [72](LESSONS.md#72) | **When a finding names one call site, grep for the CONSTRUCTION — and check the CONTAINER for the same shape** (the barrel, the registry, the index, the migration). A guard on one field of an aggregate is a fail-open for its siblings. |
| [39](LESSONS.md#39) · [88](LESSONS.md#88) | **A predicate/matcher lives ONCE — re-export, never re-define.** But two constants bounding DIFFERENT threat models stay independent even when their values coincide. |
| [68](LESSONS.md#68) · [113](LESSONS.md#113) | **Verification that flows only downward leaves a blind spot the size of whoever sits at the top** — solo, that is the whole hierarchy. This is why the self-review step is mandatory. |
| [133](LESSONS.md#133) · [83](LESSONS.md#83) · [167](LESSONS.md#167) | **Confirm a commit with `git log`, never its own receipt** (`ok (nothing to commit)` has been seen). Stage by path, read `git diff --cached --stat` at commit time. ⛔ **Never `--amend`** — it operates on whatever HEAD points at. |
| [121](LESSONS.md#121) · [127](LESSONS.md#127) | **A forced consequence rides with its cause (same commit); attribution is a MESSAGE problem.** And a scope constraint plus a scope expansion in one message is invisible to its author — the broader reading is the one that lets you proceed, so flag it rather than resolving it. |

⛔ **THIS TABLE IS THE ALWAYS-ON SUBSET, NOT THE LEDGER.** The full **256-row index** moved to
**`packages/contracts/LESSONS-INDEX.md`** on 2026-08-29 (byte-for-byte; it was 93% of this file and
~96k tokens every session). ⛔⛔ **It is NOT a summary of `LESSONS.md` — 12 of 12 sampled rows carry
sentences found nowhere in the prose** — so it is a second ledger, and the rows above are POINTERS
into it, not replacements for it.

⭐ **READ `LESSONS-INDEX.md` when you are: auditing · reviewing a diff · writing or repairing a
durable claim · building a guard or census · diagnosing an instrument · closing out a round.**
⚠ **Selection bias, stated: the core above is what fired in ONE session (2026-08-28/29).** A rule's
absence from it means "did not fire that round", NEVER "less important" — `L180`'s own shape applied
to this table.

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->
