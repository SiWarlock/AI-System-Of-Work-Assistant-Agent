# Phase-18 SUBSCRIPTION ENABLE crossing — reachability audit (apps/worker)

- **Gate:** `/phase-exit 18` (crossing round, NOT safe-build).
- **Area:** `apps/worker` (owns `worker`, `db`, `workflows`).
- **Diff range:** `6d6d94bd..HEAD` (HEAD `7180a49a`). Safe-build 18.1–18.10 EXCLUDED (audited separately in `18-reachability.md`).
- **Tasks in scope:** 18.12b, 18.13b, 18.14, 18.15b, 18.16, 18.17, 18.18a, 18.20, 18.21, 18.23, 18.24, 18.25, 18.27.
- **Production entry point:** `bootWorker(config)` (`apps/worker/src/boot.ts:1285`) — the live worker boot; `assembleBackends` (`backends.ts:762`) + `buildProofSpineActivities` (`buildActivities.ts:415`) are its composition children.
- **Method:** graphify orient → codegraph `trace`/`callers` for call paths (incl. thunk/dynamic-dispatch hops) → targeted Read confirm. Test/comment-only references do NOT count as reachable.

## Verdict: CLEAR

No unreachable non-waived *feature* export. Every crossing-new production export is either (a) reachable+active on the shipped default, (b) statically wired from `bootWorker` but runtime-DORMANT behind owner opt-in (WAIVED per worker LESSON L11, binding site confirmed), or (c) one superseded pure no-effect builder whose feature is reachable via its wired sibling (non-blocking hygiene finding).

---

## Critical check results

### 1. ARMED subscription path — reachable end-to-end ✓
Static chain from the production entry point (`bootWorker`), gated on `config.subscriptionArm.enabled === true`:

```
bootWorker (boot.ts:1285)
 ├─ createReaderHolder()                                    boot.ts:1294
 ├─ buildSubscriptionArmWiring(config.subscriptionArm,…)    boot.ts:1295
 │    └─ gateSubscriptionOnlyExtraction(opts,…)             arming.ts:248  (STRICT enabled===true)
 │         ├─ makeContentResolver = createRealExtractionContentResolver(
 │         │        { reader: createLateBoundParkedReader(readerHolder) })   arming.ts:251
 │         ├─ healthSource = createSubscriptionHealthSources(memoProbe)      arming.ts:204
 │         ├─ providerTransport.make = () => createSubscriptionOnlyProviderRunner{…}  arming.ts:209  (THUNK)
 │         │        └─ createSubscriptionExtractionRunner(…)                 runner.ts:181
 │         └─ route = selectExtractionRoute(true) → CLOUD_EXTRACTION_ROUTE   arming.ts:219
 ├─ resolveSubscriptionArming(effectiveProviderTransport, env)  boot.ts:1315
 │    └─ isProviderTransportArmed(…) && !assertSubscriptionAuthEnv(...)  → effectiveArmed
 ├─ effectiveProviderTransport = armWiring?.providerTransport ?? config.providerTransport  boot.ts:1314
 ├─ buildBackendsConfig({…, providerTransport: effectiveProviderTransport})  boot.ts:1319 → forwards it (18.18a)
 ├─ assembleBackends(backendsConfig)                          boot.ts:1325
 │    ├─ selectProviderRunner(gate, stub)  backends.ts:762 → isProviderTransportArmed===true ⇒ gate.make()  ← FIRES the runner
 │    ├─ selectHealthSources(gate, stub)   backends.ts:762 → gate.healthSource() (else UNAVAILABLE, never stub-green — L52)
 │    └─ broker SCHEMA gate: createSchemaGate({ modelSchemas: CANDIDATE_MODEL_SCHEMAS })  backends.ts:824
 ├─ readerHolder.reader = createDurableParkedReader(backends.repos.sourceDisposition)  boot.ts:1331 (POST-assembly fill)
 └─ withSubscriptionExtractionArming(params, arming.effectiveArmed)  boot.ts:1363
        → "source.process" capability route ⇒ CLOUD_EXTRACTION_ROUTE          boot.ts:1217
        → meetingJobInputs.outputSchemaId ⇒ AGENT_EXTRACTION_SCHEMA_ID        boot.ts:1209
        → sourceIngestion.outputSchemaId ⇒ AGENT_EXTRACTION_SCHEMA_ID         boot.ts:1230
        → sourceIngestion.contextRefs = [{ refKind:"source", ref: sourceId }] boot.ts:1226 (WS-8, id-only)
```
The eager-consumption ordering (the content resolver's durable reader exists only post-`assembleBackends`) is resolved by the late-bound `readerHolder` filled at `boot.ts:1331`. The `make()` thunk (`arming.ts:209`) is why `createSubscriptionOnlyProviderRunner`/`createSubscriptionExtractionRunner` show "no static caller" — the call is a dynamic-dispatch hop through the gate, fired by `selectProviderRunner` on the armed path. Path is complete and reachable.

### 2. 18.27 (#13 Finding C) — agent_extraction registration + co-gating ✓
- **Registered:** `CANDIDATE_MODEL_SCHEMAS` (`backends.ts:599-603`) maps `AGENT_EXTRACTION_SCHEMA_ID → AgentExtractionCandidateSchema` at line **602** (imported from `@sow/contracts` at `backends.ts:35,38`).
- **Reachable from the broker schema-gate:** `assembleBackends` feeds that map to `createSchemaGate({ modelSchemas: CANDIDATE_MODEL_SCHEMAS })` at **backends.ts:824** → the broker's structural candidate-data gate (REQ-S-006). Ships **ON** (deny-only, L44).
- **Byte-equivalence / inert for non-agent-extraction jobs:** the registration only changes the gate's *known-schema set*; a job is validated against `agent_extraction` ONLY if it carries `outputSchemaId = sow:agent-extraction`, which is set ONLY inside `withSubscriptionExtractionArming` on the armed branch. Non-armed jobs never carry that id ⇒ behaviorally byte-equivalent (L23). Confirmed.
- **outputSchemaId flip co-gated on the SAME arming signal (no split-brain):** the `outputSchemaId` flips (meeting `boot.ts:1209`, source `boot.ts:1230`) AND the `source.process` CLOUD route flip (`boot.ts:1217`) ALL live inside `withSubscriptionExtractionArming`, guarded by its single `armed !== true` early-return (`boot.ts:1196`). That `armed` argument is `arming.effectiveArmed` (`boot.ts:1365`), derived from `isProviderTransportArmed(effectiveProviderTransport)` — the EXACT predicate `selectProviderRunner`/`selectHealthSources` read on the same `effectiveProviderTransport`. One signal arms transport + runner + health + route + schema-id together; a shadowing-env refusal (`authRefused`) strips BOTH `backendsConfig.providerTransport` (`boot.ts:1322`) AND sets `effectiveArmed=false` — both legs degrade in lockstep. No split-brain. (Guards against the L64 spend-and-produce-nothing gap: registration + id-flip are both present and co-gated.)

### 3. Dormant-till-arming seams — WAIVED per L11, binding sites confirmed ✓
Each is statically wired from `bootWorker` (or from a boot-consumed owner-config field) and runtime-dormant on the shipped default — a parked seam, NOT dead code:

| Seam (symbol · file) | Binding site that activates on the arm | Status |
|---|---|---|
| arm wiring: `buildSubscriptionArmWiring` · arming.ts:244 | `bootWorker` boot.ts:1295 (gated `config.subscriptionArm`) | WAIVED — wired, dormant on default |
| arm wiring: `gateSubscriptionOnlyExtraction` · arming.ts:189 | `buildSubscriptionArmWiring` arming.ts:248 | WAIVED |
| subscription-extraction runner: `createSubscriptionOnlyProviderRunner` · runner.ts:181 | `gateSubscriptionOnlyExtraction` make-thunk arming.ts:209 → `selectProviderRunner` backends.ts:762 | WAIVED |
| subscription-extraction runner: `createSubscriptionExtractionRunner` · runner.ts:201 | `createSubscriptionOnlyProviderRunner` runner.ts:181 | WAIVED |
| ExtractionContentResolver: `createRealExtractionContentResolver` · resolver.ts:103 | `buildSubscriptionArmWiring` arming.ts:251 | WAIVED |
| ExtractionContentResolver plumbing: `createReaderHolder` · resolver.ts:55 | `bootWorker` boot.ts:1294 | WAIVED |
| ExtractionContentResolver plumbing: `createLateBoundParkedReader` · resolver.ts:64 | `buildSubscriptionArmWiring` arming.ts:251 (reader filled boot.ts:1331) | WAIVED |
| health wrap: `createSubscriptionHealthSources` · subscription-health-sources.ts:22 | `gateSubscriptionOnlyExtraction` arming.ts:204 | WAIVED |
| route knob: `selectExtractionRoute` · extraction-route-gate.ts:52 | `gateSubscriptionOnlyExtraction` arming.ts:219 + `withSubscriptionExtractionArming` (CLOUD_EXTRACTION_ROUTE) boot.ts:1217 | WAIVED |
| detectLogin: `detectClaudeKeychainLogin` · claude-keychain-login.ts:50 | owner injects `config.subscriptionArm.checkReachable = () => probeSubscriptionReachability({ detectLogin })`; boot CONSUMES `config.subscriptionArm.checkReachable` at boot.ts:1301 | WAIVED — library primitive, owner-config binding |
| raw-API fallback transport: `buildRealProviderTransportGate` · real-provider-transport-gate.ts:47 | owner sets `config.providerTransport = buildRealProviderTransportGate(…)` (L58); boot CONSUMES `config.providerTransport` at boot.ts:1314/1264 | WAIVED — raw-API fallback (NOT the active Option-B path) |
| raw-API fallback runner: `createRealProviderRunner` · provider-runner.ts:270 | `buildRealProviderTransportGate` default `createRunner` real-provider-transport-gate.ts:50 | WAIVED |

`detectClaudeKeychainLogin` binds via the boot-consumed `config.subscriptionArm.checkReachable` seam (boot.ts:1301) — the owner wires the primitive at the arm; its only code references today are its own test + the in-code binding note (`claude-keychain-login.ts:16`). Parked, not dead.

### 4. Contracts-side 18.11 `agent_extraction` schema consumed by the worker gate (cross-package) ✓
`packages/contracts/src/models/agent-extraction.ts` exports `AGENT_EXTRACTION_SCHEMA_ID` (`= "sow:agent-extraction"`, L38) + `AgentExtractionCandidateSchema` (L82). The worker imports both (`backends.ts:35,38`), registers them (`backends.ts:602`), and feeds them to `createSchemaGate` (`backends.ts:824`) inside `assembleBackends`. Cross-package edge worker→contracts confirmed reachable and active.

---

## Reachability classification (crossing-new/changed production exports)

### REACHABLE + ACTIVE on shipped default (runs every boot)
- `withSubscriptionExtractionArming` (boot.ts:1192) ← `bootWorker`:1363 — no-op unless armed, but on-path.
- `buildBackendsConfig` (boot.ts:1255) ← `bootWorker`:1319.
- `resolveSubscriptionArming` (arming.ts:280) ← `bootWorker`:1315 (runs every boot; unarmed ⇒ armed=false).
- `assertSubscriptionAuthEnv` (subscription-auth-guard.ts:63) + `SUBSCRIPTION_SHADOWING_ENV_KEYS` ← `resolveSubscriptionArming`:285.
- `isProviderTransportArmed` (provider-runner.ts:90) ← `selectProviderRunner`, `selectHealthSources`, `resolveSubscriptionArming`.
- `selectProviderRunner` / `selectHealthSources` / `UNAVAILABLE_HEALTH_SOURCES` (provider-runner.ts) ← `assembleBackends`:762.
- `createSourceAgentBrokerRouting` (source-extraction.ts:137) ← `buildProofSpineActivities`:415.
- `mapAcceptedMeetingExtraction` / `createMeetingExtractionSchemaGate` (meeting-extraction.ts) ← `buildProofSpineActivities`:415.
- `DEFAULT_CLAUDE_PRICING` (budget-ledger.ts:104) → `DEFAULT_PROVIDER_PRICING` (budget-ledger.ts:122) → `createLedgeredBudgetGate` pricing (backends.ts:814) inside `assembleBackends`:808. Deny-only cost cap ships ON (L54). [module-const→const reference, missed by codegraph caller-edges; confirmed by read.]
- `DEFAULT_HEALTH_SOURCES` (backends.ts:578, Object.freeze'd) ← `selectHealthSources` stub default.
- `CANDIDATE_MODEL_SCHEMAS` agent_extraction registration (backends.ts:602) → `createSchemaGate` (backends.ts:824).

### REACHABLE + DORMANT (WAIVED L11) — see Critical check 3 table
All arm-chain + raw-API-fallback + detectLogin seams above. Type-surface interfaces (`SubscriptionArming*`, `RealProviderRunnerDeps`, `ProviderTransportGate`, `ReaderHolder`, `ExtractionContentResolver`, `RealProviderTransportGateDeps`, `SubscriptionAuthFault`, etc.) ride their owning function's reachability. Route/id constants (`CLOUD_EXTRACTION_ROUTE`, `LOCAL_EXTRACTION_ROUTE`, `DEFAULT_EXTRACTION_MODEL`, `SOURCE_CONTEXT_REF_KIND`, `DEFAULT_HEALTH_PROBE_TTL_MS`) referenced on the arm chain (`CLOUD_EXTRACTION_ROUTE`/`SOURCE_CONTEXT_REF_KIND` also from `withSubscriptionExtractionArming` directly).

### NON-BLOCKING FINDING — superseded orphan (pure builder)
- **`gateSubscriptionExtraction` (apps/worker/src/composition/subscription-extraction-arming.ts:124)**
  - Referenced from: **test only** (`subscription-extraction-arming.test.ts`, 12×) + comments. No production importer (grep across `apps/worker/src` + `packages` returns only its own defining file + a comment in `subscription-extraction-runner.ts:179`).
  - This is the 18.24-era subscription-over-full-registry builder (threads subscription deps into `createRealProviderRunner`'s `runnerDeps.subscription`). It was **superseded at 18.25 by `gateSubscriptionOnlyExtraction`** (L63 explicitly rejected the full-registry approach as the "works-because-never-used" anti-pattern). `bootWorker`'s arm wiring uses `gateSubscriptionOnlyExtraction`; the raw-API fallback uses `buildRealProviderTransportGate` directly — neither routes through `gateSubscriptionExtraction`.
  - **Why NON-BLOCKING:** it is a PURE builder (constructs nothing on the OFF path; zero side effect / spend / socket even if invoked); the subscription-extraction FEATURE it duplicates IS reachable via the wired sibling; it is fully unit-tested for its OFF-contract. It is a superseded-duplicate, not an unwired feature — so it does not trip the "feature reachable only from its tests" reachability invariant.
  - **Recommended entry point:** none — recommend the orchestrator either (a) DELETE it (+ its 18.24-era test block) in a hygiene slice, or (b) if the subscription-over-raw-API-registry path is still a planned fallback, add an explicit in-code L11 waiver note naming the deferred binding. Step-9 routing: Future TODO — Phase-18 crossing close-out cleanup (or fold into a later hygiene phase).

### OUT OF SCOPE (pre-existing; no new export in the crossing diff)
- `createKeychainLockController` + the `keychain-locked.ts`/`keychain-boot.ts` changes (+38/+43 lines) added NO new exports (export-diff grep empty) — internal/interface-field/comment edits over Phase-16/L41 symbols. `createKeychainLockController`'s test-only caller status is pre-existing, not introduced by this crossing; not a crossing-gate concern.

---

## Summary for orchestrator
- Crossing-new/changed worker production exports audited across `bootWorker` + `assembleBackends` + `buildProofSpineActivities` entry points.
- REACHABLE+ACTIVE: full active set above (arming decision, selectors, broker schema-gate feed, cost-cap pricing, source/meeting routing).
- REACHABLE+DORMANT (WAIVED L11, binding sites all confirmed boot-consumed): the entire subscription arm chain, the raw-API fallback transport seam, and `detectClaudeKeychainLogin`.
- 4 critical checks all PASS (armed path e2e · 18.27 register+co-gate no-split-brain · dormant seams parked-not-dead · contracts→worker schema cross-package).
- 0 wiring tasks required. 1 non-blocking hygiene finding: `gateSubscriptionExtraction` (superseded pure builder, subscription-extraction-arming.ts:124) — recommend delete-or-annotate, does not block.
- **Phase-exit gate: CLEAR.**
