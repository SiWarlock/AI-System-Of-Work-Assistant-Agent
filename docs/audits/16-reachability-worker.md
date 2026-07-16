# Phase-16 Reachability Audit — WORKER area (`apps/worker`, `packages/workflows`)

- **Repo / HEAD:** `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build` @ `265e2b1d`
- **Scope:** Phase-16-ADDED worker exports (commits `316760ba` 16.1, `e6a4e573` 16.2, `265e2b1d` 16.6). Incremental — Phase-15-proven symbols trusted; only 16.x new/changed symbols traced.
- **Method:** codegraph (`_context`/`_explore`/`_callers`/`_trace`) + graphify, confirmed with targeted reads.
- **Verdict:** **CLEAR** — every Phase-16-added production symbol is REACHABLE or WAIVERED under a documented Phase-23 arming deferral. Zero undocumented unreachable production code. No path claimed live that isn't.

```
reachability-auditor: worker (apps/worker + packages/workflows), Phase 16 — 12 new exports audited
  REACHABLE:  12
  WAIVERED:    7  (documented Phase-23 arming; Lesson 11 + in-code TODOs)
  UNREACHABLE (undocumented): 0
```

---

## Production entry points (this area)

- **Temporal worker bundle** — `Worker.create({ workflowsPath: require.resolve("./workflows"), activities })` (`registerWorker.ts:241`). `workflowsPath` → `apps/worker/src/temporal/workflows.ts` (every exported `*Workflow` is registered by name); `activities` = `buildProofSpineActivities(backends, params)` (`registerWorker.ts:215`).
- **Live vault fs-watcher** — `startVaultWatcher(...)` wired at `bootWorker` (`boot.ts:~1776`), `dispatch: vaultDispatch` → `dispatchSourceIngestion` → starts `sourceIngestionWorkflow`. Operator env-gated (default-OFF, not a hard line / not a code change) ⇒ dormant-but-reachable production entry point.
- **Boot composition root** — `bootWorker` (`boot.ts:1110`) executes `composeConnectors()` and binds `BootedWorker.connectors`.

---

## REACHABLE (12)

| Symbol | File:line | Production reference / entry-point trail |
|---|---|---|
| `composeConnectors` | `composition/connectors.ts:105` | `bootWorker` `boot.ts:1846` (→ `BootedWorker.connectors`) **and** `buildActivities.ts:798` (→ poll resolve). Executed at boot. |
| `createInertConnectorTransport` | `composition/connectors.ts:46` | Default param of `composeConnectors`; invoked on every call (both call-sites use the default). Executed at boot. |
| `buildConnectorPorts` | `composition/connectors.ts:83` | Called by `composeConnectors` (`connectors.ts:108`). |
| `ComposedConnectors` / `ConnectorPorts` (types) | `composition/connectors.ts:34/31` | `boot.ts:476`, `connectorPolling.ts:81`, `buildActivities.ts`. |
| `createConnectorPollResolve` | `composition/connectorPolling.ts:102` | `buildActivities.ts:797` (`connectorPollPort` build). |
| `ConnectorPollResolveDeps` (type) | `composition/connectorPolling.ts:79` | `buildActivities.ts:797`. |
| `CONNECTOR_POLL_BACKOFF` | `composition/connectorPolling.ts:35` | `buildActivities.ts:800`. |
| `createDormantConnectorCursorRepo` | `composition/connectorPolling.ts:128` | `buildActivities.ts:799` (bound; reachable-but-fail-closed by design — real persistence is Phase-23 TODO #4). |
| `dormantBridgeFor` | `composition/connectorPolling.ts:140` | `buildActivities.ts:802` (bound; returns `undefined` fail-closed by design — binding-metadata seam is Phase-23 TODO #3). |
| `createSeenContentHashProbe` | `composition/seenContentHashProbe.ts:22` | `buildActivities.ts:653` → `sourceRegister` activity → registered → `sourceIngestionWorkflow` → **LIVE fs-watcher**. **De-deads 15.4 (see below).** |
| `connectorPoll` (ProofSpineActivities method) | `buildActivities.ts:322/848` | Registered with the Temporal worker (`registerWorker.ts:215/252`); invoked by `connectorSyncHealthWorkflow` (`workflows.ts:470`, `activities.connectorPoll(connector)`). |
| `connectorSyncHealthWorkflow` | `temporal/workflows.ts:466` | Exported from the bundle module registered via `workflowsPath` (`registerWorker.ts:241`) ⇒ invocable-by-name, exactly like the other 4 workflows. |

### 16.6 de-deads 15.4 — CONFIRMED (fs-watcher path)

Full live chain verified end-to-end:

1. `createSeenContentHashProbe(backends.repos.seenContentHash, backends.now)` is bound as the `seenContentHash` dep of `createRegisterSourceActivity` → the `sourceRegister` activity (`buildActivities.ts:651-654`), replacing the former hardwired `() => false` always-miss.
2. `backends.repos.seenContentHash` resolves to the **real** dual-dialect `SeenContentHashRepository` — sqlite (`packages/db/src/adapters/sqlite/index.ts:575`) + postgres (`.../postgres/index.ts:599`) over the Drizzle `seen_content_hash` table (`schema/seen-content-hash.ts:19`), WS-8-scoped `(workspaceId, contentHash)`, first-write-wins (Lesson 34). Not a stub.
3. `buildProofSpineActivities` returns the activities object incl. `sourceRegister` (`buildActivities.ts:832`) → `buildRegisteredActivities` (`registerWorker.ts:215`) → `Worker.create({ workflowsPath, activities })` (`registerWorker.ts:241`).
4. `sourceIngestionWorkflow` (`workflows.ts:396`) invokes `activities.sourceRegister(ctx)` (`workflows.ts:412`) → `registerSource` consults `deps.seenContentHash` = the real probe.
5. The **LIVE fs-watcher** (`startVaultWatcher` @ boot) → `vaultDispatch` → `dispatchSourceIngestion` → starts `sourceIngestionWorkflow`.

⇒ The Phase-15-gate-flagged 15.4 store (`SeenContentHashRepository`, previously **0 live consumers**) now has a genuine production consumer driven by the live fs-watcher ingestion path. **De-dead confirmed.** L34 fail-safe preserved (a `has`/`record` fault or throw PROCEEDs, never a HOLD or false dedupe-hit; the Temporal `src:ws:hash` `REJECT_DUPLICATE` is the exactly-once backstop).

---

## WAIVERED (7) — documented Phase-23 arming (Lesson 11 + in-code TODOs; NOT gaps)

| # | Item | Where dormant / documented | Phase-23 arming |
|---|---|---|---|
| W1 | `connectorSyncHealthWorkflow` **START** — registered but never started (no `createSchedule`, no client start) | `connectorPolling.ts:38-39`, `workflows.ts:456-466` comments | TODO #2 (live `ScheduleClient.createSchedule` START) |
| W2 | `CONNECTOR_SYNC_SCHEDULE` (config const) — **no production consumer** (only the deferred START reads it); test-ref only (`connectorPolling.test.ts`) | `connectorPolling.ts:41-45` | TODO #2 |
| W3 | `enumerateEnabledConnectorTargets` — **0 production callers** (comment `buildActivities.ts:789` + `connectorPolling.test.ts` only); its consumer is the deferred START's target-list builder | `connectorPolling.ts:52-58` header | TODO #2 ("poll enumerates only ENABLED instances, ZERO in shipped default") |
| W4 | Connector-poll **bridge's own** `seenContentHash` seam stays `()=>false` (16.6 wired the fs-watcher path, NOT the poll-bridge path) | `buildActivities.ts:647-650` (Step-9 flag-2) | TODO #3 (binding-metadata seam) |
| W5 | `createDormantConnectorCursorRepo` real cursor persistence (reachable-but-fail-closed both directions) | `connectorPolling.ts:122-137` | TODO #4 |
| W6 | `dormantBridgeFor` real binding-metadata seam (reachable-but-returns-`undefined` fail-closed) | `connectorPolling.ts:139-141` | TODO #3 |
| W7 | Poll **body** (inert transport + zero enabled instances) — dormant-but-reachable: `runConnectorSync` drives nothing, mints zero health | `connectors.ts:46-52`, `connectorPolling.ts:9-12` | Transport injection = TODO #5 (single-engine coherence) |

All seven match the pre-declared waiver set in the dispatch brief; each is documented in-code and/or by the Phase-23 arming TODO list.

---

## OBSERVATIONS (documented; not gaps)

- **O1 — `BootedWorker.connectors` field is exposed-but-unconsumed.** No production reader of `.connectors` off the boot result exists; the poll path uses a **separate** `composeConnectors()` call inside `buildActivities.ts:798` (its own transport-injection seam), not the boot field. This "split-brain" is explicitly documented at `buildActivities.ts:791-795`: `BootedWorker.connectors` "the API surface exposes but the poll does not consume," and threading it into the poll for single-engine coherence is **Phase-23 TODO #5**. The *symbol* `composeConnectors` remains REACHABLE (two live call-sites); only the boot-result FIELD currently has no reader. Documented arming-coherence item, not an undocumented dead export. Arming note: TODO #5 must inject the real transport at the `buildActivities.ts:798` seam (or thread `BootedWorker.connectors` in) — arming the boot field alone would leave the fetch path inert.

---

## Gate result

- **Undocumented unreachable production code:** NONE.
- **Path claimed live that isn't:** NONE (fs-watcher → probe de-dead of 15.4 is genuinely live-wired).
- **Phase-exit reachability gate (worker, Phase 16): CLEAR.**
