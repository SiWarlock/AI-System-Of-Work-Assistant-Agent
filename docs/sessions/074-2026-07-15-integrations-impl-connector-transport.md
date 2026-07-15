# Session 074 — 13.12 connector real-transport arc (round 2): SSRF predicate + connector HTTP transport template + Asana

- **Date:** 2026-07-15
- **Phase:** Go-live build round 2 (runbook Phase-8 connector round — the FIRST connector build round). Team `session-734f946b`, orchestrator `orch20` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [073-2026-07-15-impl22-rebuild-oracle-boot-binding.md](073-2026-07-15-impl22-rebuild-oracle-boot-binding.md)
- **Successor:** _(next session)_
- **Commits:** slice 1 `c2c6525` · slice 2 `47c55c2` · this session doc

## Why this session existed

Round 2 = establish the reusable, DORMANT, read-only external connector-adapter template on Asana, behind UNBOUND transport + secrets seams (faked in tests, unbound at boot ⇒ byte-equivalent; NO real network, NO credentials, NO hard line crossed — binding a real connector transport stays owner-gated arming). Two slices: (1) the SSRF safety CORE, (2) the transport template + first vendor instance.

## What was built

### Slice 1 — `isAllowedRemoteEndpoint` (task 23, brief 074, `c2c6525`)
The OUTBOUND connector-egress SSRF/authority-isolation predicate — the inverse of the existing `isLoopbackEndpoint`.

**Files modified:**
- `packages/policy/src/processors.ts` — `+isAllowedRemoteEndpoint(endpoint, allowedHosts): boolean`. True IFF: scheme is `https` (checked on the raw string via `/^https:\/\//i` after `.trim()`), the host parses (`extractHost !== null`), the host is NOT loopback (`isLoopbackHost` false — SSRF-to-local), and the host is on `allowedHosts` by exact whole-host match (both sides normalized through `extractHost` — symmetric parse). Composes the vetted `extractHost`/`isLoopbackHost` primitives; never re-parses (Lesson 4). Port-blind by design; DNS-rebind/private-range/resolved-IP-pinning documented in-code as an arming-era ARCH_GAP.
- `packages/policy/test/processors.test.ts` — the SSRF-vector suite (positive contract + off-allowlist/substring-spoof, non-https/TLS, loopback SSRF-to-local, userinfo/path spoof, fail-closed unparseable, symmetric-entry normalization).

### Slice 2 — connector HTTP transport template + Asana (task 24, brief 075, `47c55c2`)
The reusable real read-only HTTP transport every remote connector specializes, + its first instance.

**Files created:**
- `packages/integrations/src/connectors/adapters/http-transport.ts` — `createConnectorHttpTransport(spec, deps): ConnectorTransport`. Flow (mirrors `createGbrainHttpReadClient`/knowledge Lesson 1, but RETURNS a typed `TransportFailure` instead of throwing): SSRF-guard-FIRST on the FINAL constructed URL (slice-1 `isAllowedRemoteEndpoint`) → token from an injected `SecretsAccessor` (Authorization header only; fail-closed on a typed-unavailable AND a THROWING accessor) → GET (ING-7 read-only) → positive-2xx gate → JSON parse → `spec.mapPage`. The spec callbacks (`buildQuery`/`mapPage`) are wrapped in try/catch so a throwing specialization can't escape unredacted into the log sink. Every fault a redacted typed `TransportFailure` (status/reason/host-ref only — never token/body/cause). Local re-declared `HttpTransport`/`SecretsAccessor` seams (integrations ⊅ providers).
- `packages/integrations/test/connector-http-transport.test.ts` — 29 tests over fakes (SSRF-first, token fail-closed, positive-2xx gate, malformed body, candidate wire-map, end-to-end via `createAsanaConnector`, redaction, throwing-callback hardening, trailing-slash/404 coverage).

**Files modified:**
- `packages/integrations/src/connectors/adapters/asana.ts` — `+createAsanaHttpTransport(deps)` = `createConnectorHttpTransport(ASANA_HTTP_SPEC, deps)`; candidate Asana wire-map (`asanaMapPage` fail-closed / `asanaContentHash` via the canonical `payloadHash` / `asanaBuildQuery` with `encodeURIComponent`'d cursor). Asana envelope shape (`data[]`/`next_page.offset`/`modified_at`) documented as an arch_gap candidate, confirmed at arming.
- `packages/integrations/src/connectors/adapters/index.ts` — minimal barrel exports (the two factories + deps/seam types; `transportFailure` kept internal).
- `packages/evals/test/osb/anti-corruption.test.ts` — **AUTHORIZED cross-territory** count-pin `EXPECTED_CONNECTOR_ADAPTER_COUNT` 17→18 (constant-only, single-token). See Decisions.

## Decisions made

- **Slice 1 name `isAllowedRemoteEndpoint`** (mirrors `isLoopbackEndpoint`). Loopback-reject NOW via `isLoopbackHost`; broader private-range/DNS-rebind = arming-era residual (arch_gap).
- **Symmetric allowlist normalization** — both the endpoint host and each allowlist entry pass through the one vetted `extractHost` (Lesson-4 "one parser, both sides"; fail-closed on a null-extracting/non-string entry).
- **`https` scheme checked on the raw string**, not re-derived from the host (the parse primitives strip the scheme by design) — a scheme test orthogonal to host extraction, NOT the forbidden re-parse.
- **Slice 2 seam source:** re-declare `HttpTransport`/`SecretsAccessor` locally (integrations doesn't depend on providers — same reason GbrainReadClient re-declared). `method` is the literal `"GET"` (ING-7 at the type level; no body).
- **`TransportFailure.code` map:** 429→rate_limited, 401/403+token-unavailable→auth_locked, else→unreachable, malformed-body→unknown (diagnostic-only — the base `makeConnector` collapses all to `unreachable`).
- **contentHash reuses the canonical `payloadHash`** (replay-stable, key-order-safe) rather than a hand-rolled hash (live-once).
- **`readScope` dropped from the spec** — supplied to the transport via `request.readScope` from the adapter's `makeConnector({readScope})` (single source, no dual-source drift).
- **File split:** template in `http-transport.ts` (vendor-agnostic), Asana specifics in `asana.ts` (co-located with `createAsanaConnector`; future connectors add their own specs).
- **Reviewer fold-ins (slice 2):** wrapped the spec callbacks (security LOW — reusable-boundary redaction); documented + pinned the present-but-offsetless `next_page`→done candidate decision; added trailing-slash/404 coverage; trimmed speculative barrel exports.
- **eval-security count-pin bump (cross-track):** orch20 ruling (a), lead-endorsed — the OSB anti-corruption tripwire correctly detected the new read-edge file; its line-122 `violations` (write-surface) assertion stayed GREEN (0 violations) and `http-transport.ts` was security-reviewed as read-only GET, so the resolution is to ACK the confirmed-read-only file via a CONSTANT-ONLY count bump (scan logic + safety assertion untouched byte-for-byte). Held for the ruling rather than editing cross-track unilaterally.

## Decisions explicitly NOT made (deferred)

- **The present-but-offsetless `next_page` fail-open(done)-vs-fail-closed decision** — deferred to the arming binding where the real Asana shape is known. Current behavior (treat as done) is documented + test-pinned.
- **Binding a real transport** — the real Node `HttpTransport` + Keychain `SecretsAccessor` + provisioned Asana PAT stay UNBOUND. Binding them (real external network I/O) is the owner's arming HARD LINE, NOT this arc.
- **Real Asana wire-shape confirmation** (`data[]`/`next_page.offset`/`modified_at`) — candidate/arch_gap, confirmed at arming.
- **Resolved-IP / DNS-rebind IP-pinning** — carried into the same real-transport arming binding (slice-1 documented it in-code; an `isPrivateHost` predicate would live once in `@sow/policy`).

## TDD compliance

**CLEAN — strict test-first both slices.** Each slice: RED test written first, RED confirmed for the right reason (slice 1: `isAllowedRemoteEndpoint is not a function`; slice 2: module-not-found collection error), Step-2.5 test-design reviewed + APPROVED by orch20, then GREEN. Both dual-reviewed (security + code-quality) at Step 8; review fold-ins landed as additional tests. No test-after-impl, no TDD skip.

## Reachability

- **Slice 1 `isAllowedRemoteEndpoint`** — on the public `@sow/policy` barrel (`export * from "./processors"`); production caller = slice 2's `createConnectorHttpTransport` (reachable, in-repo).
- **Slice 2 `createConnectorHttpTransport` / `createAsanaHttpTransport`** — on the public `@sow/integrations` barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (binds the real HttpTransport + SecretsAccessor + Asana PAT). Verified ZERO production importers ⇒ shipped default byte-equivalent. No tested-but-unwired gap that a real entry point should already cover (the entry point is the deferred arming binding).

## Open follow-ups

Step-9 categorized items (routed hot to orch20; it writes at round close / Carry-forward):
- **Convention candidate (providers-integrations LESSONS):** the reusable `createConnectorHttpTransport(spec, deps)` pattern (SSRF-guard-on-final-url before token+dispatch · SecretsAccessor header-only/fail-closed-even-on-throw · redacted typed `TransportFailure` behind a positive-2xx gate · wrapped spec callbacks · vendor wire shape a documented candidate · ING-7 GET-only · real transport+secrets unbound at boot · reuse `payloadHash`). Plus the slice-1 OUTBOUND-inverse SSRF convention.
- **Architecture doc note (§5 + §8):** the OUTBOUND connector-egress SSRF predicate (§5) + the connector-transport-template (§8, Asana the first instance).
- **Future TODO (arming gate):** confirm the real Asana wire shape + the offsetless-`next_page` decision; bind the real transport/Keychain/PAT; carry the resolved-IP/DNS-rebind pinning + a potential `isPrivateHost` predicate. Slice-1 arming residual: resolved-IP validation before this predicate goes live.
- **Cross-track note:** eval-security OSB count-pin 17→18 (orch20 makes the durable Carry-forward pin-move note at round close per the lead).
- **Cross-doc invariant change:** NONE (no model/contract field add/remove/rename this session).

## How to use what was built

A new remote connector = a per-vendor `ConnectorHttpSpec` (`baseUrl`, `allowedHosts`, `resourcePath`, `buildQuery`, `mapPage`) passed to `createConnectorHttpTransport(spec, deps)`, then `makeConnector({connectorId, readScope}, transport)`. The real `deps` (HttpTransport + SecretsAccessor + tokenRef) are bound only at the owner-arming crossing.
