# Phase-18 reachability audit — worker area (`apps/worker`)

Gate input for `/phase-exit 18`. Read-only audit. Incremental scope: exported symbols
ADDED/CHANGED by the Phase-18 slices (`035dc60f..29555821`, i.e. `99cae521^..29555821`
so 18.1 is included) in `apps/worker/src`. `packages/providers/src` had **zero** changes
in-range — Phase-18 *consumes* the pre-existing broker gate/runner surfaces
(`createBudgetGate`, `createSchemaGate`, the `ProviderRunner` broker run leg), it does not
add exports there, so those are already-reachable and out of new-symbol scope.

## Production entry points (worker area)
- `bootWorker` (`apps/worker/src/boot.ts:1133`) — the composition root; runs unconditionally
  on every worker boot.
- `assembleBackends` (`apps/worker/src/composition/backends.ts:737`) — called by `bootWorker`
  every boot (always-on path).
- Temporal proof-spine registration: `bootWorker` → `makeProofSpineRegisterHook`
  (`registerWorker.ts:339`) → `buildRegisteredActivities` (`registerWorker.ts:211`) →
  `buildProofSpineActivities` (`buildActivities.ts:395`). This is the pre-Phase-18 spine
  proven reachable at the Phase-15/16 gates; the Phase-18 legs plug into it.
- Desktop worker-host: `apps/desktop/worker-host/index.ts:217` — `boot.gateAutoIngest(...)`
  + `boot.buildAutoIngestProofSpineParams` build the `proofSpineParams` handed to `bootWorker`
  (accessed via the `boot.` namespace import — a dynamic property hop the static index misses,
  confirmed by read).

## Two production reachability tiers
1. **Always-on (every boot):** `assembleBackends` legs — budget-ledger, provider-runner
   selection, health sources.
2. **Proof-spine (arm the auto-ingest gate → params → register hook):** `buildProofSpineActivities`
   legs — source-extraction, meeting-extraction, content-project resolver/correlation, proposed-action
   producer. The spine registration path itself is proven production wiring from Phase-15/16; the
   Phase-18 legs are new *consumers* on it.

## Classification — Phase-18 new/changed exported symbols

### `provider-runner.ts` (NEW · 18.1)
| Symbol | Class | Production reference |
|---|---|---|
| `selectProviderRunner` | REACHABLE | `assembleBackends` (`backends.ts:779`) |
| `ProviderTransportGate` (iface) | REACHABLE | `selectProviderRunner` param + `backends.ts` import |
| `createRealProviderRunner` | DORMANT / WAIVERED | providerTransport real runner; armed via `config.providerTransport.make` (`selectProviderRunner` gate). Ships UNBOUND (default-OFF, byte-equivalent). Lessons 11/23/43. Named dormant seam. |
| `RealProviderRunnerDeps` (iface) | REACHABLE-when-armed | `createRealProviderRunner` param |

### `budget-ledger.ts` (NEW · 18.2)
| Symbol | Class | Production reference |
|---|---|---|
| `createSingleRunBudgetLedger` | REACHABLE | `assembleBackends` (`backends.ts:765`, `??` default — static index missed the default-expr hop) |
| `createLedgeredBudgetGate` | REACHABLE | `assembleBackends` (`backends.ts:773`) |
| `DEFAULT_BUDGET_DEFAULTS` | REACHABLE | `assembleBackends` (`backends.ts:774`) |
| `BudgetLedgerEntry` / `BudgetLedgerPort` / `SingleRunBudgetLedger` (ifaces) | REACHABLE | structural over the reachable factories |

### `source-extraction.ts` (NEW · 18.4)
| Symbol | Class | Production reference |
|---|---|---|
| `createSourceAgentBrokerRouting` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:776`) |
| `SourceBroker` / `SourceJobInputs` / `SourceRunAgentJobDeps` (ifaces) | REACHABLE | structural over the reachable routing factory |

### `meeting-extraction.ts` (NEW · 18.3)
| Symbol | Class | Production reference |
|---|---|---|
| `mapAcceptedMeetingExtraction` | REACHABLE | `buildProofSpineActivities` |
| `createMeetingExtractionSchemaGate` | REACHABLE | `buildProofSpineActivities` + `temporal/workflows.ts` |

### `content-project-resolver.ts` (NEW · 18.5/18.6)
| Symbol | Class | Production reference |
|---|---|---|
| `createContentProjectClassify` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:744`) |
| `createBootWorkspaceContentResolver` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:748`, boot default) |
| `createCorrelationSignalProducer` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:430`) |
| `createBootCorrelationScorer` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:431`) |
| `DEFAULT_THRESHOLD` | REACHABLE | `buildActivities.ts:159` (as `ROUTING_THRESHOLD`) + single-sourced in-module |
| `createRegistryContentResolver` | DORMANT / WAIVERED | the real registry-backed resolver; armed via `params.contentResolver` (boot default is `createBootWorkspaceContentResolver`). G11 LIVE half. Lessons 11/45. Named dormant seam. |
| `ContentResolver` / `CorrelationScore` / `CorrelationScorerPort` (ifaces) | REACHABLE | structural over the reachable factories |

### `proposed-action-producer.ts` (NEW · 18.7)
| Symbol | Class | Production reference |
|---|---|---|
| `produceProposedActions` | REACHABLE | `buildProofSpineActivities` (`buildActivities.ts:853`). Pure/gateway-free ⇒ proposals land PENDING by construction (no dispatch, Lesson 48). |
| `ExternalActionBinding` (iface) | REACHABLE-when-bound | consumed from `sourceBinding.externalActionBinding` (`buildActivities.ts:856`); unbound ⇒ no proposals (the named `externalActionBinding` dormant seam). |
| `ActionIdentity` (iface) | REACHABLE | structural |

### `backends.ts` / `buildActivities.ts` / `boot.ts` (MODIFIED)
| Symbol | Class | Production reference |
|---|---|---|
| `DEFAULT_HEALTH_SOURCES` (backends, new) | REACHABLE | `assembleBackends` (`backends.ts:771`) |
| `SourceIngestionParams` (buildActivities, new iface) | REACHABLE | `ProofSpineParams.sourceIngestion` (`buildActivities.ts:265`) |
| `gateAutoIngest` (boot; pre-Phase-18, named dormant seam) | REACHABLE-when-armed | worker-host `apps/desktop/worker-host/index.ts:217` (default-OFF auto-ingest arming) |
| `buildAutoIngestProofSpineParams` (boot) | REACHABLE-when-armed | worker-host `index.ts:225` |
| `DEFAULT_INGEST_WORKSPACE` (boot) | REACHABLE | `gateAutoIngest` (`boot.ts:628`) |

## Named dormant-till-arming seams (WAIVERED per Lesson 11 — NOT gaps)
- `createRealProviderRunner` — providerTransport real ModelProvider runner; arm via
  `config.providerTransport = { enabled: true, make: () => createRealProviderRunner(deps) }`.
- `createRegistryContentResolver` — real content→project registry resolver; arm via
  `params.contentResolver`.
- `ExternalActionBinding` — the propose-leg binding; arm via `sourceBinding.externalActionBinding`.
- `gateAutoIngest` / `buildAutoIngestProofSpineParams` — the auto-ingest boot gate (default-OFF).

Each has a real, in-code arming path (a strict `=== true` flag and/or an owner-injected factory/
param) and a byte-equivalent shipped default; each is exercised by its tests over fakes. These are
reachable-WHEN-ARMED and reachability-waivered, not orphans.

## Genuinely unreachable / orphaned symbols
**NONE.** No Phase-18 exported symbol is referenced only from `test/**` / fixtures / mocks with
no production or documented-arming path. Every new factory/value traces to a production entry point
(`assembleBackends` on every boot, or `buildProofSpineActivities` via the proven `bootWorker` →
`makeProofSpineRegisterHook` → `buildRegisteredActivities` register hook), and the four named dormant
seams each carry an in-code arming path.

## Verdict
**Phase-exit gate: CLEAR** — 0 unreachable, 0 wiring tasks recommended. 4 dormant-till-arming seams
carried forward as owner-gated arming (Future TODO, Phase-19/§19.5 + G11), consistent with the
Phase-18 safe-build/no-hard-line posture.
