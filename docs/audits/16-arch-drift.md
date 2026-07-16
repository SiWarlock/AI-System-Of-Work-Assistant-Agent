# Phase 16 — Architecture-drift audit (spec-vs-code)

- **Phase:** 16 — Connector Engine, Composition & Bridge (dormant substrate, §19.3)
- **Repo HEAD:** `265e2b1d` (16.6 seenContentHash wiring)
- **Auditor:** arch-drift-auditor (read-only) · dispatched by `/phase-exit 16`
- **Spec anchors audited:** §19.3 (primary), §8, §9 (workflow 10 / LIFE-4/6), §5 (SSRF/egress + ING-7), §16 (redacted typed faults)
- **Verdict:** **CLEAR** — 0 DRIFT findings. 2 STALE-DOC notes + 1 doc nuance. Phase is a documented pure-build/dormant substrate (Lesson 11); every dormancy seam carries an in-code Phase-23 waiver, and the code is *stronger* than the doc on SSRF (hardened, not weakened).

> Method: read only the cited anchor sections + their landed notes. No frozen Appendix-A contract is touched by Phase 16 (worker Lessons 34/35/36 — the new stores/ports/template-widening are explicitly NOT frozen Appendix-A models), so the schema-snapshot shortcut does not apply; verification is code-vs-spec. Test suite NOT re-run (that is `/preflight`).

---

## Working-tree note (load-bearing for this audit)

`ARCHITECTURE.md` is **modified but uncommitted** in the working tree (`git diff --stat`: 3 insertions / 1 deletion, all in §19.3). The uncommitted edit is the orchestrator's Phase-16 mirror already in progress:
- §19.3 **Invariant** line updated to add the transport-level runtime `{GET,POST}` method-admission gate alongside job-admission ING-7.
- A new **"⭐ LANDED (2026-07-16) — Phase 16 complete"** paragraph in §19.3 documenting 16.1–16.6, the **SSRF fix** (`isAllowedRemoteEndpoint` fail-OPEN → added `isPrivateHost` denylist-beats-allowlist), the `ComposedConnectors` rename rationale, and the §19.10/Phase-23 arming ledger (incl. "re-run `isPrivateHost` on the RESOLVED IP" as the deferred DNS-rebind residual).

This audit reads the doc as it currently sits on disk (the mirror included). **Action for the orchestrator:** commit that §19.3 mirror at round-close, and extend it to §8 + §5 per STALE-DOC-1/2 below.

---

## Per-anchor verification

### §19.3 — Connector Engine, Composition & Bridge (primary)

| # | Contract statement | Verdict | Evidence (`file:line`) |
|--:|---|---|---|
| 1 | Composes the connector port set at boot over all read adapters against an inert transport (no tokenRef, zero fetch) | ✅ VERIFIED | `apps/worker/src/composition/connectors.ts:105` `composeConnectors` → `buildConnectorPorts` (`:83`) over `ADAPTER_FACTORIES` (`:65`, 9 adapters; todoist + obsidian-vault excluded `:59-63`); `createInertConnectorTransport` `:46` fails closed `unreachable`; dup-connectorId fail-fast `:90-92` |
| 2 | "Composes ConnectorPorts + **ConnectorGateway** at boot" (§19.3 header, line 461) | ⚠ NUANCE (see doc-nuance) | Code names the type `ComposedConnectors` (`connectors.ts:34`) deliberately to avoid overloading §8's `runConnectorSync` engine; the gateway *engine* is wired into the poll (16.2), not composed as an object at boot. Uncommitted landed note explains the rename. Not functional drift. |
| 3 | Registers the poll activity + `connectorSyncHealth` workflow into the bundle with a **real `resolve()`** + schedule | ✅ VERIFIED | poll wired `buildActivities.ts:796-804` (`createConnectorPollActivity` + `createConnectorPollResolve`); workflow sandbox import `apps/worker/src/temporal/workflows.ts:56`, `connectorSyncHealthWorkflow` `:466`, `runConnectorSyncHealth(input,deps)` `:495`, health→`surfaceFailure` `:478`, poll→`connectorPoll` `:470` |
| 4 | Schedule is DEFINED but live `createSchedule` START is deferred (dormant) | ✅ VERIFIED (documented waiver) | `connectorPolling.ts:41` `CONNECTOR_SYNC_SCHEDULE` config; `:39` + `workflows.ts:464` comment "live `ScheduleClient.createSchedule` START is Phase-23 arming". Grep: **no `ScheduleClient.createSchedule` src call-site** exists |
| 5 | Poll enumerates only ENABLED connector instances (ZERO in the shipped default ⇒ inert tick, no health spam) | ✅ VERIFIED (documented waiver) | `connectorPolling.ts:52` `enumerateEnabledConnectorTargets` filters `state === "enabled"`; empty default ⇒ `[]` |
| 6 | Lands the reusable real read-only HTTP transport wrapper `createConnectorHttpTransport` | ✅ VERIFIED | `packages/integrations/src/connectors/adapters/http-transport.ts:152`; specialized e.g. `drive.ts:131` |
| 7 | Drive `incompleteSearch` coverage-degrade | ✅ VERIFIED | `drive.ts:81` `driveMapPage`; `:107` `incompleteSearch === true` (strict) → `TransportPage.incompleteCoverage` (`transport.ts:41`); records KEPT (fail-visible), gateway mints coverage-degrade signal |
| 8 | File/PDF binary parsing | ✅ VERIFIED | `file-read-transport.ts:152` `createFileReadTransport`; PDF magic route `:189`; `defaultBinaryTextExtractor` `:100` (unpdf/PDF.js, lazy-imported, offline, `isEvalSupported:false` CVE-2024-4367 guard `:104-109`); bounded input `:178` + extracted-text cap `:197`; root-confinement realpath `:164-171`; fail-closed `:209` |
| 9 | All against a fake transport, no tokenRef bound; scheduled poll → fake records → bridges to `registerSource` e2e; every vendor dormant | ✅ VERIFIED (documented waiver) | inert transport `connectors.ts:46`; poll uses `composeConnectors()` + `createDormantConnectorCursorRepo` + `dormantBridgeFor` `buildActivities.ts:797-803`; bridge→`registerSource` chain via 15.1 `connectorIngestionBridge` (worker Lesson 33) |
| INV-a | ING-7 read-only enforced at **job admission** (source-type-agnostic) | ✅ VERIFIED | `packages/policy/src/admission.ts:43` `admitJob` — `!isTrusted(job) && admitsMutating(...)` → deny `UNTRUSTED_CONTENT_MUTATING_TOOL` `:56-61`; keys on trustLevel+toolPolicy, never source type |
| INV-a′ | ING-7 also enforced at the transport (runtime `{GET,POST}` gate) | ✅ VERIFIED | `http-transport.ts:169-172` step (0) method admission BEFORE query build / SSRF / token / dispatch; POST admitted only for fixed query-only `buildBody` (`:106-119` WARNING) |
| INV-b | SSRF/egress guard on the FINAL URL BEFORE any token read (safety rule 6) | ✅ VERIFIED | `http-transport.ts:187-190` step (1) `isAllowedRemoteEndpoint(fullUrl, spec.allowedHosts)` precedes token resolve step (2) `:195`; predicate `packages/policy/src/processors.ts:340` now composes `isLoopbackHost` (`:357`) **AND `isPrivateHost` denylist that beats the allowlist** (`:358-361`) then the exact whole-host allowlist (`:366`) |
| INV-c | Redacted typed faults, never token/body/cause (safety rule 7) | ✅ VERIFIED | `http-transport.ts:132` `transportFailure` carries only diagnostic code + host-ref/status; raw cause discarded on dispatch reject `:233-234`, body never echoed `:238-246`; throwing spec callbacks wrapped `:179-183,252-256` |
| KIND | Pure-build (dormant); binding a real transport is the independent hard line | ✅ VERIFIED | `connectors.ts:10-14`, `connectorPolling.ts:9-18`, `buildActivities.ts:791-795` all mark the transport-injection as the Phase-23 owner-arming crossing. (§19.3 "Kind" says "§19.10's" hard line = Plan Phase 23; consistent — §19.n ↔ Plan Phase n+13.) |

### §8 — Connector & Tool Gateways (external reads engine)

| # | Contract statement | Verdict | Evidence |
|--:|---|---|---|
| 1 | Connector Gateway owns cursors, retry/backoff, health/reachability signals | ✅ VERIFIED (dormant) | poll projects the gateway verdict `connectorPoll.ts:61` `projectSyncResult` (`cursorAdvanced` derived from `status==='advanced'` only, REQ-I-005); backoff `connectorPolling.ts:35`; cursor persistence dormant Phase-23 `:128` (fail-closed both directions) |
| 2 | Connector-unreachable (REQ-I-005/LIFE-4): queue+retry bounded backoff, mark degraded, no silent drops, drain on reconnect | ✅ VERIFIED (dormant) | `connectorSyncHealth.ts` `ConnectorSyncHealthOutcome.degradedConnectors` (queued, never dropped — inv-2) `:286`, `drainResult` on wake `:287`; unknown connectorId → loud `unreachablePort` `connectorPolling.ts:65`, no-binding → fail-closed `onRecords` `:74` |
| 3 | (§8 template note, line 255) SSRF via `isAllowedRemoteEndpoint` = "https + non-loopback + exact whole-host allowlist"; `isPrivateHost` listed as a future **arming residual** | ❌ STALE-DOC (see STALE-DOC-1) | Code SHIPPED `isPrivateHost` as a composed denylist (`processors.ts:361`); §8 line 255 not updated by the in-flight diff |

### §9 — Temporal Workflows (workflow 10: connector sync & health)

| # | Contract statement | Verdict | Evidence |
|--:|---|---|---|
| 1 | Workflow 10: scheduled/wake-triggered poll per connector → cursor advance → health signal; unreachable branch per §8 (queue/hold/backoff/drain, surface in System Health) | ✅ VERIFIED | `connectorSyncHealth.ts` driver: `ConnectorSyncHealthInput` `:248`, `ConnectorSyncHealthDeps` (poll/wakeDrain/health/runs/schedule/clock) `:262`, `ConnectorSyncHealthOutcome` states done/no_run_due/connector_degraded `:280`; registered `workflows.ts:466` |
| 2 | LIFE-2: durable schedule runs missed occurrences once, collapsed, on wake within catch-up window | ✅ VERIFIED | `collapsed` flag `:284` + `catchUpWindowMs` `:252`; LIFE-2 store `createScheduleStoreAdapter` (`store-adapters.ts:250`) |
| 3 | LIFE-6 drain-on-wake | ✅ VERIFIED | `isWakeTrigger` `:319` (`trigger !== "schedule"`) → `wakeDrain`; `drainResult` present on wake `:287` |

### §5 — Policy, Security & Egress (SSRF/egress guard, ING-7 admission)

| # | Contract statement | Verdict | Evidence |
|--:|---|---|---|
| 1 | Four hard denials incl. ING-7 admission gate (untrusted-content job declaring a mutating tool) | ✅ VERIFIED | `admitJob` `admission.ts:43` (fail-closed, only explicit `"trusted"` bypasses) |
| 2 | Any write adapter called outside Tool Gateway / KnowledgeWriter is denied; connector reads are read-only | ✅ VERIFIED | transport is GET-default / POST-query-only `http-transport.ts:169-172`; Drive/all specs declare least-privilege READ scope only (`drive.ts:25` `drive.readonly`) |
| 3 | §5 body describes the outbound connector SSRF predicate (denylist-beats-allowlist; resolved-IP recheck deferred) | ⚠ STALE-DOC (see STALE-DOC-2) | §5 body (lines 169–180) is SILENT on the outbound predicate; the mirror currently lives only in the uncommitted §19.3 landed note ("SSRF finding fixed (§5)…") + arming ledger, not in §5's own body. Silent, NOT contradictory. |

### §16 — Cross-cutting (redacted typed faults, HealthItem, error-handling)

| # | Contract statement | Verdict | Evidence |
|--:|---|---|---|
| 1 | Mandatory redaction strips credential-shaped + raw-content before any log sink | ✅ VERIFIED | `transportFailure` `http-transport.ts:132` (host-ref/status only); `ConnectorPollResult.healthReason` carried only on held/degraded, never raw payload `connectorPoll.ts:55-59` |
| 2 | Each OBS-2 failure class → typed `HealthItem` (failureClass/severity/auditRef/state) | ✅ VERIFIED (dormant) | health sink `workflows.ts:477-479` `surface→activities.surfaceFailure`; coverage-degrade reuses `sync_lagging` GatewayHealthSignal (uncommitted landed note, worker Lesson 25). No health minted in shipped default (zero enabled instances) |
| 3 | Error-handling convention: typed result with explicit failure variants; nothing fails silently | ✅ VERIFIED | `ConnectorPollError` `connectorSyncHealth.ts:161`, `ConnectorPollResult` `:146`, `TransportFailure` `transport.ts:50` — all typed, never thrown across the boundary |

---

## Mismatch lists

### DRIFT (code ≠ spec, spec is right) — **NONE**

No statement in any audited anchor is violated by the code. Where the code diverges from the doc it is *stronger* (the SSRF denylist hardening), which routes as STALE-DOC, not DRIFT.

### STALE-DOC (code is right, spec lags) — orchestrator Architecture-doc notes

**STALE-DOC-1 — §8 line 255 arming-residual understates the shipped SSRF hardening.**
The §8 connector-real-transport template note describes the guard as `isAllowedRemoteEndpoint` = "https + non-loopback + exact whole-host allowlist" and lists, under *arming residuals (fail-safe)*: "resolved-IP/DNS-rebind pinning + an `isPrivateHost` predicate (a hostname allowlist can't catch DNS-rebind)." As of 16.3 (`5ce1961d`), `isPrivateHost` is **SHIPPED** and composed *inside* `isAllowedRemoteEndpoint` (`packages/policy/src/processors.ts:358-361`) as a denylist that beats the allowlist (RFC-1918 / CGNAT / link-local+metadata / IPv6 ULA+link-local / internal-suffix / non-canonical inet_aton + IPv6-hex forms, fail-closed on malformed). Only the **resolved-IP recheck** (true DNS-rebind defense on the resolved address) remains Phase-23. **Fix:** update §8 line 255 to state the literal/IP-form denylist shipped in 16.3, narrowing the residual to the resolved-IP recheck — mirroring the §19.3 landed note.

**STALE-DOC-2 — §5 body omits the outbound connector SSRF predicate.**
§5 (Policy, Security & Egress) body covers the *inbound* egress veto + ING-7 admission but says nothing about the *outbound* connector SSRF predicate. The substantive mirror currently exists only in the uncommitted §19.3 "LANDED" note (which cross-references "§5"). **Fix:** add a one-liner to §5's body ("outbound connector reads are guarded by `@sow/policy isAllowedRemoteEndpoint`: https-only + loopback-reject + `isPrivateHost` denylist-beats-allowlist + exact whole-host allowlist; resolved-IP recheck is Phase-23"), and commit the in-flight §19.3 mirror. This is the mirror the dispatcher anticipated the orchestrator would apply at round-close.

### AMBIGUOUS (can't tell which side is right) — **NONE**

### Doc nuance (non-blocking)

- **§19.3 header line 461** still reads "Composes `ConnectorPorts` + `ConnectorGateway` at boot," while the code type is `ComposedConnectors` (deliberately renamed off "ConnectorGateway" to avoid overloading §8's `runConnectorSync` engine). The uncommitted §19.3 landed note already states the rename rationale; folding the header phrasing to match at commit-time closes the nuance. Not drift.

---

## Dormancy waivers verified as documented (Lesson 11 — NOT drift)

Every dormant seam this phase ships carries an explicit in-code Phase-23 waiver:
1. Real network send seam UNBOUND — `http-transport.ts:122-128` (deps unbound); `connectors.ts:46` inert transport.
2. `connectorSyncHealth` schedule DEFINED, `createSchedule` START not wired — `connectorPolling.ts:39`, `workflows.ts:464`; no src call-site.
3. Poll enumerates only ENABLED instances, ZERO in default — `connectorPolling.ts:52`.
4. Connector-instance binding-metadata seam + real cursor persistence deferred — `dormantBridgeFor` `connectorPolling.ts:140` (→ fail-closed `onRecords`), `createDormantConnectorCursorRepo` `:128` (fail-closed both directions).
5. Connector-poll bridge's OWN `seenContentHash` seam stays dormant — `buildActivities.ts:647-650` NOTE (the poll path's `registerSource` runs through the 15.1 bridge's separate dedupe seam, to be pointed at the real probe at Phase-23 binding); the 16.6 real `SeenContentHashRepository` IS wired into the fs-watcher `sourceRegister` path (`buildActivities.ts:651-653`, L34 fault-PROCEEDs), and the re-entry probe is intentionally `()=>false` (`:625`, inv-D).
6. Single-engine arming coherence flagged — `buildActivities.ts:791-795` names `composeConnectors()` as THE transport-injection point (split-brain footgun guard).
