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
| KnowledgeMutationPlan | §3, §6, §7 | +provenanceOrigin, +gbrainProposalRef?, +signedProvenanceStamp? (LIFECYCLE flag: KW writes stamp at commit; modeled optional), +expectedProjectId? (§13.10a gate 1 — verification-only raw projectId; executor rejects a NotePatch whose target frontmatter projectId ≠ this). REQ-F-006 reject-on-empty sourceRefs. |
| ProposedAction | §3, §8, §9 | actionId, targetSystem, canonicalObjectKey, payload, approvalPolicy, idempotencyKey. |
| ExternalWriteEnvelope | §3, §8 | embeds WriteReceipt? + approvalId?; envelope↔ProposedAction linkage helper; preconditions (arch_gap, open). |
| WriteReceipt | §8 | externalObjectId, externalUrl?, recordedAt, rawRef? — exactly-once external-write proof. |
| SourceEnvelope | §3, §8, §9 | sourceId, workspaceId(req), origin, contentHash, type, sensitivity, routingHints. |
| GclProjection | §3, §5, §6, §11 | workspaceId+visibilityLevel(req), projectionType, sanitizedPayload (raw-content gate is KEY-NAME-INDEPENDENT: rejects raw-content-shaped key OR any multi-line/over-length string value, recursive — tightened 2026-07-01), sourceRefs. |
| Approval | §3, §9, §10, §11 | id, actionRef?, planRef?, subjectKind(external_action\|semantic_mutation), workspaceId(req), status(6), actor, channel(mac\|telegram), payloadHash, snoozeUntil?, expiresAt? — snooze ⇔ deferred; **§13.10a SUBJECT invariant (refine): subjectKind discriminates the card subject — external_action ⇒ actionRef only; semantic_mutation ⇒ planRef only (exactly the matching ref; a mis-routed card is unrepresentable)**; workspaceId = WS-4 inbox-scope attribution (set at record time, server-bound). |
| AuditRecord | §3, §4, §16 | actor, event, refs, payloadHash, before/afterSummary (summaries only — no raw content), timestamps, workspaceId? (optional WS-8 scope for the §9.5 recent-changes projector; global events unscoped — EventLog/LogRecord precedent; plain string to keep the model brand-free). |
| Project | §3, §6, §9, §13.5 | id(ProjectId), workspaceId, slug, title, lifecycleState(idea\|planning\|active\|paused\|done\|archived), timeline[](bi-temporal, append-only), provenanceOrigin — SEMANTIC (Markdown frontmatter, KW-owned, no operational table); lifecycleState ≡ latest timeline head; 7th state machine (packages/domain/src/state/project.ts) asserts enum equivalence. **ProvenanceOrigin extended** +project_capture/+project_sync (§13.5) +copilot_propose (§13.10a Copilot semantic-write bridge) — each same round; grows the KMP + Project schema enum. |
| WorkflowRunRef | §3, §9 | workflowId, trigger, state, idempotencyKey, auditRefs[]. |
| HealthItem | §16, §10, §11 | +sync_lagging/+rebuild_divergence/**+security_violation/+policy_denial/+egress_denied/+isolation_breach** failureClasses (last 4 = task 11.8 C-enum: terminal SECURITY/POLICY/EGRESS/ISOLATION causes), +parityReportRef?, +factIdentity?; state(open\|acknowledged\|resolved); severity open, but `defaultSeverityForFailureClass` (`@sow/workflows` activities/healthItem.ts, assertNever-guarded) supplies a per-class default when a producer omits it (security/isolation→critical, policy/egress→error, else warn; producer-explicit severity wins). |
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

> **All 27 frozen 2026-06-30 (Phase 1, tasks 1.2–1.9); +Project (§13.5, 2026-07-06) = 28.** Authoring = ADR-008 Zod-as-source: each model is `XSchema` (`.strict()`) → `z.infer` type → generated `schemas/<kebab>.schema.json` → frozen `__snapshots__/<kebab>.snap` (top-level field-name set) → registered in the ajv-strict registry. **A field add/remove/rename requires editing `ARCHITECTURE.md` Appendix A + the model's schema + its `.snap` in the same round** — `registry-all.test.ts` + the per-model snapshot test fail otherwise. Shared sub-shapes (`ContextRef`/`SourceRef`/`NoteCreate`/`NotePatch`/`LinkMutation`/`FrontmatterPatch`/`CanonicalSourceRef`) live in `src/models/shared-shapes.ts`; shared enums in `src/models/shared-enums.ts`; brands in `src/primitives/zod-brands.ts` — never re-declare them inline.

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
| 5 | 2026-07-02 | Redact secrets/raw-content by per-field TYPE, never a length/shape heuristic | A mandatory redactor cannot decide "is this raw?" from a value's own shape — a short whitespace-free raw word (codename, OTP, opaque token) is indistinguishable from a safe token. Emit a string only if it's a frozen-enum member / id-under-id-field / number / ISO timestamp; fail-safe redact everything else. Run dedicated field validators BEFORE any generic name-suffix rule (an `Id`-suffix shadowed the `providerId` enum case). Document + pin the accepted residual; re-verify each fix until a skeptic can't leak (took 3 rounds). |
| 6 | 2026-07-09 | Serving-trust context assembly honest-by-construction | Resolve citations to the single stamped/rehydratable unit only (page-fact-only, injective, withhold-on-ambiguity) + DERIVE serving coverage from the real ParityReport + pin/oracle legs bound to the head revision — fail-closed to `degraded` on any absent/dirty/stale/mismatched signal, never hardcode green even while dormant; reserve `err` for load faults, never throw. |
| 7 | 2026-07-09 | Security/governance eval must assert the fail-closed path NON-vacuously | Pair every "denied ⇒ X" negative with a POSITIVE anchor proving the grant machinery works; verify each assertion by deleting/inverting its guard; probe the actual actor-facing surface (the model-facing handler text), not an internal object. Keep it deterministic + egress-free; isolate any real-egress case as a gated `it.todo`. |
| 8 | 2026-07-09 | Check engine PURE over an injected probe snapshot; safety posture fails CLOSED | `runDoctor(snapshot)→DoctorReport` does no I/O (real collectors = separate deferred adapter) so it's unit-testable + never-throws (`safeCheck`→`probe_error`); safety-posture checks default to a `finding` on any absent/unknown/malformed probe (assume-worst — a writable/mispointed/stray-writer state is never a silent `ok`); name detected entities via a closed label enum (redaction-safe by construction; `Array.isArray` before `.length`). |
| 9 | 2026-07-09 | Neutralize content boundary-markers at the single inner-body source (fixpoint, linear regex) | A content-embedded `kw:region` marker must never forge/break a boundary: neutralize at the ONE inner-body source feeding both create + patch (one shared helper; also outside-region text like an H1 title), escape to a FIXPOINT so no nested/crafted marker survives per any consumer matcher (graceful, idempotent, content-preserving); keep every marker-scan regex on an untrusted path LINEAR (no adjacent nullable quantifiers `\s*/?\s*` → ReDoS) with a large-input regression pin. |
| 11 | 2026-07-10 | OSB source extractor: emit-only over a FAKED transport, TOTAL never-throws | An OSB source extractor emits a `RegisterSourceInput` CANDIDATE (never writes — proven via the REAL `registerSource()` gate) from a FAKED injected transport; the WHOLE post-transport map runs under ONE try because the untrusted transport can throw OR resolve `ok` with a pathological/non-string body; fail-closed on fault/empty/malformed; contentHash over dedupe-stable content, scope/routingHints never inferred from the untrusted body; `type` rides the open `SourceEnvelope.type` (no frozen round); real transport = dormant injection point (no network in adapter/tests). |
| 10 | 2026-07-10 | Read-model inbox: read-first (empty-until-producer), drop-rules AT WRITE, dormant producer | A UI-safe inbox/list ships the READ path + non-seam UI-safe contract first (empty-until-producer, mirror recentChanges); the write-time PRODUCER applies the drop-rules AT WRITE (no raw refs at rest — the read still re-validates fail-closed), upserts per `(workspaceId,key)` with dedup-by-id + write-key authority (caller ws ≡ source ws) + fault-vs-not_found guard + §16 on BOTH get/put of BOTH ops, and ships dormant (Temporal always-on wiring + UI mount deferred, like `projectRecentChanges`); pin no-drift via read-side-narrower reuse + write-satisfies-read-contract, pin drop-at-write against the SERIALIZED blob, and pin WS-8 with the POSITIVE keying leg (A stored under `(key,A)`), never just "B reads empty". |
| 12 | 2026-07-11 | Anti-corruption/one-writer guard = PURE denylist token-scan over a file family, non-vacuous via count-pin, sentinel-forced pin | Enforce a "no X reaches the write surface" boundary structurally: a pure `scanForWriteSurfaces(files)→{violations,scannedCount}` (fs read in the test) over a self-maintaining glob (`*-source.ts`); deny import PATHS (`@sow/knowledge`/`createFsVault`/fs writes incl. `copyFile`/`cp`/`ExternalWriteEnvelope`) NOT prose symbols (bare `KnowledgeWriter` false-positives doc-comments that name the sole writer); substring for paths, word-boundary regex for short fs-ops so prose can't FP; NON-vacuous via a count-pin (`scannedCount===EXPECTED && >0` — a lost or unbumped-new member fails ⇒ deliberate bump) + a data-driven every-token-self-detects catch-power test; pair a mirror `.pin` whose SHA field is sentinel-OR-real so a bump can't silently drift (TOTAL split-on-first-= parser); a denylist is a tripwire not a proof — name the residual (out-of-model vectors, name-convention surface) + the runtime one-writer invariant as the backstop. |
| 13 | 2026-07-11 | Read-only tool surface = frozen `mutating:false` allowlist + Set-backed fail-safe registry + read-only dispatch (allowlist complement to L12) | Model a read-only external tool surface as a frozen `mutating:false` (literal-typed) descriptor allowlist (mirror `CopilotToolSpec`) + a `Set`-backed fail-safe registry (unregistered id ⇒ reject, never permissive — mirror `isMutatingCopilotTool`; a plain-object map opens `__proto__`/`constructor` prototype-pollution, a `Set` closes it) + a read-only dispatch that checks the registry BEFORE the seam and runs the whole deref+check+call+map under one try (never-throws TOTAL, even a malformed call); excluded write tools are name literals, never registered/reachable; if outside the canonical L12 guard's `*-source.ts` scan surface, back it with a NON-vacuous inline write-surface self-check + document the coverage-bound. The allowlist-registry dual of Lesson 12's denylist-scan tripwire. |
| 14 | 2026-07-11 | Additively strengthen a safety gate by extending the PARSER not the gate (+0/-0 gate diff = no-weakening proof); adopt a marker vocab as one atomic unit w/ machine-checked parser↔neutralizer parity | To grow a safety guarantee without weakening it, extend the parser that FEEDS the gate, not the gate logic — a +0/-0 gate diff IS the machine-checkable no-weakening proof (more protection flows as more protected sections). Adopt a new boundary-marker vocabulary as ONE atomic unit (recognition + gate + neutralizer — splitting leaves a forge-vector intermediate), pin a MACHINE-CHECKED parser↔neutralizer parity (neutralizer ⊇ parser ⇒ no recognized-but-undefused marker, Lesson 9), capture the FULL marked span so DE-marking (not just content-edit) is rejected, use a prose-safe HTML-comment syntax so clean-content is a no-op (Lesson 12), keep recognition additive-to-the-owned-set (never reclassify/seize currently-protected content). Step-8 verifies no-weakening by diffing the gate + all prior tests byte-for-byte green. |
| 15 | 2026-07-11 | Never wire a REQUIRED gate over a NEW field until producers emit it (drops all data else); a frozen additive field on a shared SUB-SHAPE ripples only through its embedder's generated schema | A validator over a new field must ship STANDALONE + dormant + fixture-tested, NEVER composed as a required gate into a live path until producers emit the field (a require-`X` gate today drops every existing record — nothing carries `X`); regression-pin the live path byte-untouched + zero non-test callers; compose the required gate WITH producer emission. Frozen additive field on a shared SUB-SHAPE (e.g. `CanonicalSourceRef`) ripples only through its embedder's generated JSON schema — regenerate that (`freezeGenerated` catches the nested add + transitively proves ajv+Zod both accept it, LESSONS §3), the top-level `fieldSet` `.snap` stays unchanged. Use an explicit field-PICK (not a spread) at a shape→`.strict()` boundary so the new optional field can't leak downstream until intended; keep the field format OPAQUE until its producer defines it (avoid a re-freeze). |
| 16 | 2026-07-11 | Make-it-real live-Temporal activation reuses the proof-spine assembly (only the already-real gate runs real over deterministic leaves); dispatch is idempotent BY CONSTRUCTION | Activate a dormant §9 workflow by REUSING the sandbox bundle + `buildRegisteredActivities` assembly (no divergent activity set) on a LOCAL `TestWorkflowEnvironment` (loopback, no Cloud/egress); run only the already-real pure gate for real, every other leaf a DETERMINISTIC composition-root fake (guardrail-3; never import `test/support` into prod). Idempotent dispatch: the deterministic content-versioned source key IS the Temporal `workflowId` under `REJECT_DUPLICATE` (`AlreadyStarted` folded to a success no-op) + the driver's `resolveRun` = dual dedupe; confine the concrete Client to a thin adapter behind an injected port (degraded-testable + the SAME adapter tested via `env.client`), defer the boot-Client to its first real caller (no dormant untested seam), degraded-safe = typed err + `worker_down` §16 item + never-throw. |
| 17 | 2026-07-11 | Real LOCAL connector I/O safety = realpath ROOT-containment before open + bounded/typed reads + ONE authoritative predicate + workspace-bound-by-config + TOTAL never-throws | A real `node:fs` read confines to an allowed root by REALPATH containment asserted BEFORE any open (`realTarget===realRoot \|\| startsWith(realRoot+sep)` — the `+sep` kills sibling-prefix; reject `../`/absolute-outside/symlink-escape as typed errs reading ZERO bytes; read the resolved realTarget for TOCTOU; fail-closed on a bad root), bounds the read + NUL-sniffs binary + redacts to errno-only. A safety predicate lives ONCE — export + reuse `isContainedUnder` (double-GUARDED but single-SOURCED), never mirror it. Capture is workspace-BOUND by `{root,workspaceId,sensitivity}` config (vault-per-workspace), NEVER content-inferred (WS-2/REQ-F-017, decoy-content pinned). NEVER throws — incl. `fs.watch`'s SYNCHRONOUS start-throw (else it crashes boot + leaks the Connection); lazy Client connect for instant degrade; flag-OFF by default. |
| 18 | 2026-07-11 | A §16 failure-class reflects the CAUSE not the resting state; survey a frozen-taxonomy expansion's ripple EMPIRICALLY + add ONE assertNever-guarded decision point | Class by CAUSE not resting state — a state conflating causes (`failed_terminal`) must thread a cause-derived class from each site, reserve `worker_down` for genuine infra, use a least-wrong member + greppable `arch_gap` + cause-in-message where the frozen enum lacks one, and escalate the expansion as a category-4 owner call. Before a frozen-taxonomy expansion EMPIRICALLY survey the consumer ripple (a pass-through discriminant — open severity string / `humanizeToken` / import-derived redaction set / `Partial<Record>` — can have ZERO tsc-breaking consumers; the only pin was a membership TEST; hand-audit `default`-carrying switches tsc won't catch). Where a new class needs distinct handling add ONE `assertNever`-guarded decision point (`defaultSeverityForFailureClass`, producer-severity-wins) so future members can't silently mis-bucket; security/isolation→critical, policy/egress→error. Commit the frozen-contract canonical-doc mirror IMMEDIATELY (own `docs()` commit, no drift). |
| 19 | 2026-07-12 | Real install-doctor probe COLLECTORS: pure mapper over an injected exec/net port + thin real adapter, never-throw fail-closed; safety-posture fail-closes absence-of-confirmation + closed-label redaction | A real probe collector is a PURE mapper over an injected exec/net port + a thin LOCAL never-throwing adapter (fakes in unit tests, real adapter only under a gated `SOW_DOCTOR_REAL`); fail-close each probe to the assume-worst shape the pure engine maps to a `finding` (completes [8](LESSONS.md#8)). Exec safety = fixed argv ARRAY (`shell:false`, config never string-concatenated — rides a positional/`cwd`), bounded timeout+cap, errno-only redaction, ABSOLUTE bins for security-sensitive probes. A safety-posture collector fail-closes an ABSENCE of confirmation (can't-prove-negative ⇒ assume unsafe: ACL read-only allowlist + exact-10-char mode, ps-fault-omits-field) and classifies a detected entity into a CLOSED label set (the redaction primitive — key on the executable token + exact-path binding, never echo raw args/path). Pin: per-probe fakes (green/assume-worst/malformed/fault) + fixed-argv/no-shell + a gated real-adapter test. [full](LESSONS.md#19) |
| 20 | 2026-07-12 | The reachability-waiver-holder pattern + a multi-instance worst-of fold that hoists shared probes to run exactly once | Land a pure engine + real collectors DORMANT behind a documented reachability waiver (each independently testable/reviewed), then close it with ONE composition-root ENTRY (real adapters + entry-resolved+injected config + a pure render/exit-code core) — `/wired` traces from the entry. The entry is report-only: render ONLY typed fields (redaction-safe), a DERIVED worst-of exit code that never masks a finding, no auto-mutation (idempotent re-probe). A multi-instance check folds worst-of over EVERY configured instance (never silently 1-of-N — a partial rule-1 posture check is a hole that re-opens GO #1) and HOISTS a shared/stateful probe (a loopback bind) to run EXACTLY ONCE (structural collision-elimination, not a sequential workaround), via additive per-field-probe exports. Resolve impure config (`os.userInfo()`, `AppConfig`) at the ENTRY and inject it — the pure collector never reads the OS. Pin: render/exit-code pure units + a multi-instance fold test + a shared-probe-invoked-once test + a gated end-to-end. [full](LESSONS.md#20) |
| 21 | 2026-07-12 | Make-real over a probe whose REAL output contradicts the assumed contract → fail-closed candidate-field parse + delegate to the built pure core + document the identity-gap as a deferred Finding | RUN the real tool/vendor surface BEFORE writing the probe — a broken premise the dormant-over-fakes build hid (an assumed field the real output lacks) surfaces here (gbrain 0.35.1.0 emits NO commit-SHA that `checkVersionPin` assumed). Respond honest-fail-closed: parse the candidate key, return the pure core's UNAVAILABLE value on absent/malformed (NEVER coerce a wrong-typed substitute — the semver tag into the SHA field — into a bogus match), DELEGATE the decision to the built core (the make-real slice adds only probe+parse, TOTAL never-throw incl. the delegate call). Bank the gap as a category-2 Finding tied to the owner-gated path it blocks (in-code + deferred ledger), not a silent paper-over; the non-HITL slice ships fail-closed, the contract-identity fix is the owner's. Pin: a real-surface-shape reality test + a synthetic-with-the-assumed-field forward-compat test + the composition's fail-closed/never-throw paths. [full](LESSONS.md#21) |

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->
