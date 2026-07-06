# WS-8 per-workspace scoping of the combined gbrain brain — design (§13.10 go-live gate a)

> **Status:** DESIGN COMPLETE + foundation slice SC1 landing. The rest is owner-gated (below).
> **Method:** survey→3-designs→judge→4 adversarial verifiers (workflow `wf_039163e8-07d`, session 042) + a standalone re-run of the RESULT-LEAKAGE verifier. This doc is the durable synthesis; the workflow transcript is the raw material.
> **Gate:** this is go-live gate (a) for flipping `copilotAgentMode` — the hard blocker. Gates (b)/(c)/(d) are cleared (see `docs/runbooks/copilot-propose-go-live.md` §13.10).

## The problem

The served gbrain brain is ONE combined store. TODAY it holds ONE source (`default`, 99 pages) with legacy UNPREFIXED slugs (`sessions/…`, `archive/…`, `concepts/…`) — the ws-convention (`<workspace>/<area>/<topic>` slug + `ws:<workspace>` tag; workspaces `employer-work`/`personal-business`/`personal-life`) is the owner's FUTURE convention, not yet true of existing content. TWO paths read this brain and neither enforces workspace scope:

- **P1 — the LIVE retrieval seam** (`createGbrainSubprocessRetrieval` / `createGbrainHttpExec`): SoW issues `query {query,limit}` and controls args + can post-filter hits. Live today for `personal-business`.
- **P2 — the DORMANT agentic path** (`copilotAgentMode` OFF): the model calls `mcp__gbrain__*` directly with model-suppliable args (`source_id='__all__'`, foreign `slug`/`slugPrefix`, `all_sources`, …).

`query` has no tag/slug-prefix filter; the only runtime levers are **slug-prefix** (Phase A) or **`source_id`** after a migration (Phase B). The `ws:` tag is an ingest/migration-time attribute, never a runtime post-filter.

## The chosen design — one shared pure core, two enforcement paths

**Design 3 (data-partitioning) as the SPINE, merged with Design 2's arg-policer/result-redactor (defense-in-depth) and Design 1's in-process gbrain-proxy MCP (P2 primary delivery).** Everything default-OFF and fail-closed; NO frozen-contract change in a code slice.

### The pure core (SC1 — `packages/policy/src/copilot-workspace-scope.ts`)
- `WorkspaceScopeRegistry`: `workspaceId → { slugPrefixes[], sourceId?, brainId? }`. The optional `sourceId`/`brainId` keep the descriptor **split-ready** so Phase B (per-workspace `source_id`) and Phase C (brain-per-workspace) reuse the shape without redesign — the deferred 3-brain split is NOT baked in but is NOT precluded.
- `attributeSlug(slug, registry)`: longest-registered-prefix match; no-match ⇒ `legacy`; ambiguous(>1)/empty/malformed ⇒ **fail-closed**. Boundary-correct (`personal-business/` must NOT match `personal-business-x/`).
- `LegacyContentPolicy`: `{mode:'deny'}` (default, fail-closed — drops every unattributed hit) or `{mode:'assign', toWorkspaceId}` (transitional bridge).
- `decideHitScope(hit, servedWorkspaceId, registry, policy)`: match⇒keep, foreign⇒drop, legacy under `{deny}`⇒drop, legacy under `{assign,X}`⇒keep IFF `servedWorkspaceId===X`.

### P1 (LIVE) — SC2/SC3
Inject an optional `scopeFilter` into `GbrainSubprocessRetrievalDeps` and apply `decideHitScope` over the **RAW hit array** BETWEEN `deps.exec` and `normalizeGbrainHits` — the only point where per-hit `slug`+`source_id` still exist un-lossily (`normalizeGbrainHits` rewrites `/`→`:` and DROPS `source_id`/tags). The survivors then normalize, so the mapper's self-stamped `context.workspaceId` becomes a TRUE assertion `enforceRetrievalScope` can back. The filter runs INSIDE the composite ⇒ structurally BEFORE the `createProvenanceStampingRetrieval` decorator (its subset-or-fail-closed check stays intact). Absent filter = today's passthrough. Boot flag `copilotWorkspaceScoping` (default OFF) + `copilotLegacyContentPolicy` (default `{deny}`).

### P2 (DORMANT) — SC4–SC9
- **SC4 catalog narrowing:** a SEPARATE additive classification map (NOT a mutation of the frozen `COPILOT_READ_TOOLS`) tags each read ToolId `arg-scopable`|`result-filterable`|`unscopable`; `copilotScopedReadToolIds(brainPartitioned:false)` DENIES the whole-brain aggregators (`find_experts`/`find_anomalies`/`find_orphans`, `takes_scorecard`/`takes_calibration`, conservatively all `takes_*`). Fail-safe: unknown ToolId ⇒ unscopable ⇒ denied (mirrors `isMutatingCopilotTool`).
- **SC5 pure cores:** `policeGbrainToolArgs` (deny `__all__`/`all_sources`, pin `source_id`/`slugPrefix`, validate seed slugs; never return null) + `redactGbrainToolResult` (drop foreign hits/neighbors; `find_contradictions` pair dropped if either side foreign; malformed⇒drop-all).
- **SC6 transport seams / SC7 gbrain-proxy MCP:** PRIMARY = an in-process gbrain-PROXY SDK MCP server (mirror `createCopilotProposeMcpServer`) registered under key `gbrain` with identity names, REPLACING the http entry; handlers call the worker exec + shared DCR token provider and enforce scope + filter server-side per call. FALLBACK = SDK-native `canUseTool` arg-rewrite + `PostToolUse` result-redact (UNVERIFIED SDK semantics — see flagged conformance test).
- **SC8 runner wiring / SC9 admission backstop:** drive `allowedToolNames` from `copilotScopedReadToolIds`; `admitCopilotAgentJob` rejects a job whose allow-list carries an unscopable tool or whose scope is unresolved. Seed-only propose (gbrain tools stripped) untouched.

## Adversarial verdicts (all four lenses)

| Lens | Verdict | Load-bearing takeaway |
|---|---|---|
| ARG-SMUGGLING | HOLDS_WITH_FIXES (9) | source_id/all_sources widening denied; prefix boundary + casing/`../` fail-closed in `attributeSlug`. |
| FAIL-CLOSED + LIVE-PATH | HOLDS_WITH_FIXES (12) | `{deny}` airtight; legacy `assign` sound ONLY while the brain holds one workspace's content — fails OPEN the instant multi-workspace content lands unprefixed (no runtime detection). |
| DRIFT + COMPOSITION | HOLDS_WITH_FIXES (10) | unknown-tool fail-closed; propose seed-only strip intact; descriptor survives the 3-brain split. |
| **RESULT-LEAKAGE** | **HOLDS_WITH_FIXES** | **The container/contents gap (below) — the decisive finding.** |

### The RESULT-LEAKAGE finding (the load-bearing one)
`decideHitScope` attributes the **container** (slug); the leak can ride in the **contents** (body, edges, command strings, prose), and the only downstream WS-8 guard (`enforceRetrievalScope`) checks a **label, not contents**. Four gaps:

- **A1 — body-embedded foreign content (LEAKS; IRREDUCIBLE).** An in-workspace-slugged page whose `chunk_text` verbatim quotes another workspace's content is KEPT (slug-only attribution is blind to the body). **No runtime post-filter can fix this.** The plan MUST NOT imply slug attribution achieves WS-8's "0 raw employer content in personal outputs." Real mitigation is **ingest-time**: KnowledgeWriter classifies/quarantines cross-workspace embeds at authoring + Phase-B/C per-workspace `source_id`/brain partitioning so a personal query never retrieves over employer-authored bytes. **→ owner-facing residual (accepted or blocks the flip).**
- **A2 — `traverse_graph` edges/targets cross partitions (LEAKS; FIXABLE).** A kept node's `links[]` can name a foreign target slug + `context` string. Fix: filter **both nodes AND edges** (drop an edge whose `from` OR `to` is foreign; strip link `context`).
- **A3 — `find_contradictions` far-side must be FAIL-CLOSED (LEAKS; FIXABLE).** "Best-effort far-side" violates fail-closed — an unattributable far side (page_id/title only, no slug) must be treated as foreign and the pair dropped.
- **A4 — `resolution_command` + page-naming fields reach the model verbatim (LEAKS; FIXABLE).** The UI-safe gate (`collapseToSummaryLine`/`uiSafeSummaryLine`) is **shape-only** (collapses whitespace, clamps length; does NOT strip slug/path substrings; `uiSafeOpaqueRef` allows colons). Fix: strip `resolution_command` + every page/path/title-naming field **server-side, before the model sees the result** (keep only `severity`/`axis`/`confidence` + opaque in-workspace refs).
- A5/A6/A7/A8 blocked-or-contingent; hardening notes: add a per-source slug re-attribution in `enforceRetrievalScope`/the decorator (today it is label-only, a single point of failure); if the dormant `createGbrainCopilotRetrieval` is ever wired it must carry `slug` (its citation mapping is `source_id`-first ⇒ `gbrain:default`, no slug to attribute on).

## Build order (revised by the verdicts)

1. **SC1 — the pure scope core** (owner-decision-FREE, default-OFF, wires nothing). ← landing this session.
2. SC2/SC3 — P1 live wiring (default-OFF; live path byte-identical when OFF). **Gated on the owner's legacy-policy choice** (below) for the flag-ON behavior.
3. SC4–SC9 — P2 (all under `copilotAgentMode` OFF). **Fold in the A2/A3/A4 fixes** as SC5 requirements (edge+target filtering; fail-closed far-side; server-side field-stripping).
4. Flagged future work (other tracks / owner-run): Appendix-A frozen truth-pass (contracts); the ingest-side attribution rule (knowledge — **the real WS-8 enabler + the only A1 mitigation**); the legacy-migration runbook (docs, human-run); the workspace-leakage governance eval (eval-security); the SDK-0.3.201 conformance test; `WorkspaceConfigRepository`; Global-scope via the GCL Visibility-Gate union.

## BUILD-ORDER VERDICT (owner delegated the call; session 042) — RUNTIME-FIRST

The owner asked for the architecturally-correct order: ingest-attribution-first (option 2) if correct before the runtime layer, else runtime-first (option 1); legacy posture = `{assign, personal-business}`. A focused survey of the concrete ingest→gbrain→retrieval data path (session 042) settled it:

- **KnowledgeWriter writes a FLAT slug** straight from `NoteCreate.path`; no workspace prefix, no `ws:` tag; `workspaceId` is present at the write site but unused for attribution (`writer.ts`). The ws-prefix rule is *mechanically* buildable there — but landing it changes nothing the Copilot sees, because…
- **The KW→gbrain reindex is a STUB** (`createStubIndexApplyClient`, `backends.ts:725` — a no-op in-memory ACK; the "REAL-SDK INJECTION POINT" is unfilled), AND the KW commit path runs only under Temporal workflows that are **degraded/unregistered** in the running app.
- **The Copilot reads a SEPARATE, hand-seeded brain** (session-032 `gbrain import docs/`, bypassing KnowledgeWriter) whose slugs are the repo's `docs/…`/`packages/…` paths — NOT ws-prefixed. Ingest attribution cannot retroactively re-slug an already-seeded brain; only a re-seed can.
- **Per-workspace `source_id` (Phase B) is absent** (no `sources_add`-per-workspace, no `source_id` on the query seam) and is a config + **owner-run gbrain migration** (writes to gbrain), not a code task.
- **No authoritative registry** populates slug-prefixes today (`WELL_KNOWN_COPILOT_WORKSPACES` = `{id,type}` only; `Workspace.markdownRepoPath`/`gbrainBrainId` unpopulated; `WorkspaceConfigRepository` unseeded).

**Verdict:** ingest-attribution is currently INERT — it presupposes a de-stubbed KW→gbrain pipeline **and** a re-seed the runtime filter does not need. The runtime layer is the ONLY thing that can enforce WS-8 over the brain the Copilot actually reads today, and `{assign, personal-business}` is purpose-built for exactly this single-workspace state. **So: runtime SC2–SC9 (assign-bridge) FIRST; ingest-attribution + per-workspace sourcing later, as the documented EXIT from the assign-bridge, once the reindex stub is replaced and the served brain is (re)built from KnowledgeWriter output.**

### Build progress (session 042)
- **SC1 DONE** (`a0870bb`) — the pure scope core (`packages/policy/src/copilot-workspace-scope.ts`).
- **SC2 DONE** (`369a3b1`) — the P1 scope filter over the raw gbrain hits (`createWorkspaceScopeFilter` + `scopeFilter?` on the composite; both transports flow through it). Dual-reviewer clean. **DORMANT — not yet constructed at the live composite (that is SC3).**
- **SC3 NEXT** — boot wiring: build the interim registry (the 3 well-known workspaces → slug-prefixes, since no authoritative source exists yet) + thread `createWorkspaceScopeFilter(served, registry, {assign,personal-business})` into `buildCopilotDeps`→`createGbrainSubprocessRetrieval`, behind a default-OFF `copilotWorkspaceScoping` flag. NOTE: on today's brain this is functionally inert (all content is personal-business legacy, all kept) — it lands the mechanism live+tested, not observable enforcement.
- **SC4–SC9** — the dormant P2 agentic layer (behind `copilotAgentMode`); SC5 must fold in the A2/A3/A4 result-leakage fixes.

## OWNER-GATED decisions (must NOT be picked on the owner's behalf)

1. **The A1 residual (NEW, load-bearing):** accept that runtime slug-scoping does NOT fully satisfy WS-8 over one combined brain (body-embedded foreign content leaks until ingest-time attribution + source partitioning exist), OR treat A1 as a hard blocker and require the ingest rule + per-workspace source partitioning BEFORE flipping `copilotAgentMode`.
2. **Legacy content policy at flag-flip:** `{deny}` (airtight; kills the live `personal-business` path until the migration runs) vs `{assign,personal-business}` (preserves the live path; carries the fail-OPEN leak surface if multi-workspace content ever lands unprefixed — requires the owner's behavioral guarantee "don't save non-personal-business content unprefixed while assign is on").
3. **When/which legacy migration** (slug re-prefix / `sources_add`+re-import / tag-only) — it WRITES to the owner's gbrain ⇒ owner-authorized, human-run, outside the autonomous KnowledgeWriter path.
4. **P2 delivery mechanism:** in-process gbrain-proxy (robust, SDK-independent) vs SDK-native `canUseTool`+`PostToolUse` (lighter, unverified).
5. **Reclassifying any 'unscopable' aggregator** — a security-posture decision (reintroduces the aggregate-basis leak).
6. **Retire vs align** the dormant `createGbrainCopilotRetrieval`/`GbrainReadAdapter` (the natural Phase-C brain-split seam).
7. **The 3-brain split itself** + its Appendix-A frozen changes — the descriptor stays split-ready but the decision is the owner's.
