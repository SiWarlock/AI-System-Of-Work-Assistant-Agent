# reachability-auditor: Phase 16 — providers-integrations (packages/integrations, packages/policy)

- **Repo / HEAD:** `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build` @ `265e2b1d`
- **Area:** providers-integrations track — `packages/integrations` + `packages/policy`
- **Scope:** Phase-16-ADDED/CHANGED integrations+policy exports (16.3 / 16.4 / 16.5), incremental over the two integrations commits `5ce1961d` (16.3) + `07e27aea` (16.4/16.5). Worker-side legs (16.1 `composeConnectors`, 16.2 `connectorPoll` registration, 16.6 seenContentHash) are the worker track's territory — treated here only as the production ENTRY POINTS the integrations symbols trace back to.
- **Method:** graphify + codegraph (`codegraph_callers`/`codegraph_trace`/`codegraph_explore`) for the call graph, confirmed with targeted reads of the load-bearing wiring lines.

## Production entry points enumerated for this area

| Entry point | Where | Drives |
|---|---|---|
| Vault fs-watcher (`startVaultWatcher`) | `apps/worker/src/boot.ts:1776` (behind default-OFF `SOW_INGEST_WATCH`) | `createFileReadTransport(watchRoot)` → the 16.5 binary/PDF branch |
| `connectorPoll` Temporal activity (registered 16.2) | `packages/workflows/src/activities/connectorPoll.ts` → imports `runConnectorSync` (graphify: 1 hop) | the §8 connector gateway → the 16.4 coverage-degrade path |
| Per-vendor `create*HttpTransport` factories (Phase-23 binding site) | `drive/github/gmail/calendar/granola/linear/asana` adapters | `createConnectorHttpTransport` (the 16.3 wrapper + ING-7 gate + SSRF) |

## Exports audited (11) — REACHABLE 10 · WAIVERED 1 · UNREACHABLE(undocumented) 0

### 1. `createConnectorHttpTransport` + its runtime ING-7 {GET,POST} method-admission gate — WAIVERED (documented Phase-23)
- **File:** `packages/integrations/src/connectors/adapters/http-transport.ts:152` (the ING-7 gate is the first block inside the returned transport fn).
- **Production callsites:** the 7 per-vendor factories — `drive.ts:132`, `github.ts:128`, `gmail.ts:129`, `calendar.ts:127`, `granola.ts:127`, `linear.ts:151`, `asana.ts:133` — each `return createConnectorHttpTransport(<VENDOR>_HTTP_SPEC, deps)`.
- **Why WAIVERED, not a gap:** `composeConnectors` ships the **inert** transport (`createInertConnectorTransport`, `apps/worker/src/composition/connectors.ts:46`) — the real per-vendor `create*HttpTransport` factories are NOT invoked by any production entry point; they are the **Phase-23 owner-arming binding site** (real undici/https/fetch send + SecretsPort tokenRef). This is the documented Phase-23 HARD LINE (worker Lesson 11; commit `5ce1961d`; the `connectors.ts` dormancy header at lines 10-14, 38-45). Real, dual-reviewed machinery; real-send seam intentionally UNBOUND. The ING-7 runtime gate rides the same wrapper (runs at admission whenever the transport is exercised) — WAIVERED alongside it.
- **Classification:** WAIVERED — matches the dispatcher's explicit waiver; not counted as a gap.

### 2. `isPrivateHost` — REACHABLE
- **File:** `packages/policy/src/processors.ts` (denylist-beats-allowlist layered into `isAllowedRemoteEndpoint`).
- **Caller (codegraph):** `isAllowedRemoteEndpoint` (`packages/policy/src/processors.ts:340`) — confirmed edge. `isAllowedRemoteEndpoint` is the canonical @sow/policy SSRF predicate consumed by `createConnectorHttpTransport` (`http-transport.ts` imports `@sow/policy` at :30, invokes the predicate at admission). The private-host denylist runs at admission-time (BEFORE the send seam) on every transport exercise.
- **Classification:** REACHABLE from its consumer, exactly as the dispatcher required. (Its ultimate production entry rides the same connector chain that is Phase-23-armed for a *real* endpoint, but the predicate itself is live admission-path machinery, not a dead symbol.)

### 3. `parseIpv6Hextets` — REACHABLE
- **Caller (codegraph):** `isPrivateHost` (`packages/policy/src/processors.ts:197`) — confirmed edge. Reachable transitively via #2.

### 4. `isAllowedRemoteEndpoint` (16.3 hardening of a pre-existing export) — REACHABLE
- **Production consumer:** `packages/integrations/src/connectors/adapters/http-transport.ts` (the only non-self production reference; policy self-reference aside). Same admission-path posture as #2.

### 5. `buildConnectorCoverageDegradeSignal` + `CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS` — REACHABLE
- **File:** `packages/integrations/src/health/health-signal.ts:98` (fn) / `:36` (const).
- **Caller (codegraph):** `runConnectorSync` (`packages/integrations/src/connectors/gateway.ts:83`), minted at `gateway.ts:214` on the advanced-with-partial-coverage result. `runConnectorSync` ← `connectorPoll` activity (graphify path: `connectorPoll.ts --imports--> runConnectorSync`, 1 hop) — the 16.2-registered Temporal activity is the production entry point. The const is consumed by the build fn.
- **Classification:** REACHABLE. The signal only FIRES on a real `incompleteSearch:true` page (Phase-23-armed real transport + an enabled instance), but the machinery is production-wired to the registered poll — reachable, not dead.

### 6. `incompleteCoverage` thread (16.4) — REACHABLE, no dead segment
Full producer→consumer thread verified live at every hop:
- **Produce:** `drive.ts:107` reads Drive `incompleteSearch === true`; `:113` sets `incompleteCoverage: true` on the `TransportPage`.
- **Field decls:** `transport.ts:41` (`TransportPage.incompleteCoverage`), `port.ts:30` (`ConnectorFetchPage.incompleteCoverage`).
- **Thread:** `base.ts:70` (`makeConnector.fetch`) copies `result.incompleteCoverage` → `ConnectorFetchPage`.
- **Consume:** `gateway.ts:158` destructures it, `:202` sets `coverageIncomplete`, `:214` mints the signal.
- **Classification:** REACHABLE — every hop has a live consumer; the field is not a declared-but-unpopulated dead segment.

### 7. `BinaryTextExtractor` (type) + `defaultBinaryTextExtractor` (unpdf) + `MAX_EXTRACTED_TEXT_CHARS` + `createFileReadTransport` binary branch (16.5) — REACHABLE and LIVE
- **File:** `packages/integrations/src/connectors/adapters/file-read-transport.ts:75` (type), `:100` (`defaultBinaryTextExtractor`/unpdf), `:65` (cap const), `:152/:159` (`createFileReadTransport`, `parseBinary = opts.parseBinary ?? defaultBinaryTextExtractor`).
- **Production callsite:** `apps/worker/src/boot.ts:1783` — `createFileReadTransport(watchRoot)` (no `opts` ⇒ the real unpdf `defaultBinaryTextExtractor` is bound in production) inside `startVaultWatcher(...)` at `boot.ts:1776`, imported at `boot.ts:190`.
- **Classification:** REACHABLE and LIVE — the vault fs-watcher is a real production entry point (behind default-OFF `SOW_INGEST_WATCH`, but the wiring constructs the real transport + real unpdf extractor when the flag is on). Unlike the connector legs, this one is NOT Phase-23-dormant: PDF text extraction genuinely runs on a watched PDF. (Tests inject a fake extractor; production takes the unpdf default.)

## Undocumented unreachable production code

**None.** Every Phase-16-added integrations/policy export is either REACHABLE from a production entry point (isPrivateHost/parseIpv6Hextets via the admission-path SSRF predicate; the coverage-degrade thread via the 16.2-registered connectorPoll → gateway; the PDF-parse branch via the live fs-watcher) or the single documented Phase-23 WAIVER (`createConnectorHttpTransport` real-send seam — worker Lesson 11).

## Summary for orchestrator

- 11 Phase-16 exports/changes audited — REACHABLE 10, WAIVERED 1 (documented Phase-23), UNREACHABLE(undocumented) 0.
- 0 wiring tasks recommended.
- Note: the connector-read legs (16.3 wrapper + SSRF, 16.4 coverage-degrade) are production-WIRED but their real-data FIRE is Phase-23-armed (inert transport ships by default) — documented dormancy, not a gap. The 16.5 PDF-parse leg is LIVE now (fs-watcher, behind default-OFF `SOW_INGEST_WATCH`).
- **Phase-exit gate: CLEAR.**
