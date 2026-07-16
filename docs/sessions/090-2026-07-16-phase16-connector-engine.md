# Session 090 — 2026-07-16 — Phase 16: Connector Engine, Composition & Bridge (dormant substrate)

**Team:** `session-734f946b` — lead-carried orchestrator + worker-impl4 + integrations-impl (re-spawned for the providers-integrations track). Single-track `main`. desktop-impl idle (no Phase-16 desktop work).
**Span:** origin/main `32e66c5b` → `265e2b1d` (5 slice commits + this gate/round-close). **Posture: pure-build / dormant substrate — NO hard line crossed.**

## What the phase delivered
The whole connector→ingestion drive path now stands up as INERT substrate: the gateway composes all read adapters, a scheduled poll bridges fake records to real notes end-to-end, the reusable read-only HTTP transport wrapper is built (SSRF/egress + ING-7 guarded), Drive coverage-degrade + File/PDF extraction work, and the content-dedup store is live for the fs-watcher path — every vendor dormant behind an UNBOUND send seam.

## Slices
- **16.1 — connector gateway boot composition (`316760ba`, closes G32).** `composeConnectors()` builds a `ComposedConnectors` port set over all 9 read adapters (7 vendor + url-source + telegram-capture) against an INERT `ConnectorTransport` default — no `create*HttpTransport`, no SecretsAccessor, no tokenRef, zero fetch at boot. todoist excluded (connector factory but no HttpTransport — joins when built); obsidian-vault excluded (not a ConnectorPort). Dup-connectorId fails fast (L39/L30). Exposed on `BootedWorker.connectors`. Files: NEW `apps/worker/src/composition/connectors.ts` + test; `boot.ts`.
- **16.2 — connectorPoll registration + connectorSyncHealth + schedule (`e6a4e573`, closes G33).** Real `resolve()` binds an adapter (from `ComposedConnectors.ports`) + cursor repo + `onRecords` (the 15.1 bridge) + backoff; `connectorSyncHealth` sandbox workflow registered + schedule config defined. Enumerates only ENABLED 14.2 instances (empty shipped default ⇒ inert tick, NO health spam). Files: NEW `connectorPolling.ts` + test; `buildActivities.ts`, `temporal/workflows.ts`.
- **16.3 — read-only HTTP transport wrapper + SSRF hardening (`5ce1961d`, closes G25 build).** `createConnectorHttpTransport` exercised via a fake send seam (real send UNBOUND — Phase-23). Runtime ING-7 {GET,POST} method admission. **Security finding fixed:** the @sow/policy `isAllowedRemoteEndpoint` blocked internal hosts only by allowlist-absence (fail-OPEN on misconfig/DNS-rebind) → added `isPrivateHost` as a DENYLIST that beats the allowlist (RFC-1918/CGNAT/link-local+metadata/ULA/internal + non-canonical inet_aton/IPv6-hex forms; fail-closed on malformed). security-reviewer found 1 high + 2 med + 2 low evasions → all fixed in-slice + RE-VERIFIED PASS. Files: `packages/policy/src/processors.ts`, `packages/integrations/.../http-transport.ts` + tests.
- **16.4 — Drive incompleteSearch coverage-degrade (`07e27aea`, closes G29).** `incompleteSearch=true` → a fail-VISIBLE `incompleteCoverage` flag (adapter→page→base→gateway) → `buildConnectorCoverageDegradeSignal` (reuses `sync_lagging` — frozen enum, L25; a dedicated `coverage_degraded` member is a future contracts change); records still commit, cursor advances.
- **16.5 — File/PDF binary parsing (`07e27aea`, closes G31).** The root-confined fs transport extracts PDF/doc text (unpdf, pure-JS/offline, lazy-imported, behind a `BinaryTextExtractor` seam) ONLY on already-realpath-contained in-root bytes; a NUL-only/unparseable binary still rejects; an out-of-root file never reaches the parser.
- **16.6 — real seenContentHash wiring (`265e2b1d`, de-deads 15.4).** `registerSource`'s dedupe probe now reads the real durable `SeenContentHashRepository` (was hardwired `false`) — closing the Phase-15 gate's dead-code note. L34 fail-safe: a `has`/`record` fault OR a throw across the injected boundary (L20/L24) PROCEEDs (never HOLD, never false hit) — correct under `src:ws:hash` REJECT_DUPLICATE. WS-8-scoped; re-enter probe stays `false` (inv-D). De-deads 15.4 for the fs-watcher path.

## Gate + round-close
- Acceptance smoke: full suite 20/20 tasks green (worker 1531); the inert gateway boots + the e2e poll→bridge→note path works over fakes with every vendor dormant.
- `/phase-exit 16`: spec-lint(16) PASS; /preflight green (typecheck 20/20, lint 11/11); dep-audit clean (incl. unpdf); security = per-slice invariant (16.3 SSRF re-verified); arch-drift + reachability(worker) + reachability(integrations) auditors → verdict in the Log + `docs/audits/16-*.md`.

## Phase-23 arming ledger (all tracked, in-code + plan) — the honest "what go-live requires"
1. Bind real per-vendor `HttpTransport` send + tokenRef (the phase's one hard line; per-vendor owner crossing) + **re-run `isPrivateHost` on the RESOLVED IP** (DNS-rebind/NAT64/6to4/0x-inet_aton residuals).
2. connectorSyncHealth: real DB-backed schedule bookkeeping + wakeDrain (in-sandbox stubs now); live `ScheduleClient.createSchedule` START.
3. Connector-instance BINDING-METADATA seam (`ConnectorInstanceRow` lacks origin/type/sensitivity/kind → `bridgeFor` undefined → onRecords fail-closed until then); real connector cursor persistence.
4. Single-engine arming coherence (the poll-path `composeConnectors()` is THE transport injection seam).
5. Point the connector-poll bridge's own `seenContentHash` seam at the real probe when the bridge is armed with real deps.
6. Coverage-degrade: a dedicated `coverage_degraded` FailureClass (contracts) + multi-signal ConnectorSyncResult (observability); the `ya29.` Google-OAuth redaction pattern; record-on-commit migration for seenContentHash.

## Next
Phase 16 done → Phase 17 (§19.4 Keychain) = the FIRST hard-line / owner-gated phase — needs owner sign-off before kickoff.
