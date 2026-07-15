# Session 078 — 13.12 connector round 6: template POST+body extension + Linear GraphQL transport

- **Date:** 2026-07-15
- **Phase:** Go-live build round 6 (runbook Phase-8 connector round — Linear, 2-slice). Team `session-734f946b`, orchestrator `orch21` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [077-2026-07-15-integrations-impl-github-transport.md](077-2026-07-15-integrations-impl-github-transport.md)
- **Successor:** [079-2026-07-15-integrations-impl-gmail-list-transport.md](079-2026-07-15-integrations-impl-gmail-list-transport.md)
- **Commits:** slice 1 (POST+body extension) `8a97f44` · slice 2 (Linear GraphQL) `47fbf99` · this session doc

## Why this session existed

Round 6 added the Linear issues connector — the 6th `createConnectorHttpTransport` instance and the FIRST GraphQL-over-POST connector. Because Linear is a single `POST /graphql` with the query in the request body, the template had no POST path, so R6 split into two slices: (1) an additive, security-reviewed POST+body extension to the shared template, then (2) the Linear GraphQL spec built on it. All DORMANT — real transports/secrets/tokens UNBOUND; binding is the owner's arming crossing (HARD LINE). NO hard line crossed.

## What was built

### Slice 1 — template POST+body extension (task 30, brief 081, `8a97f44`)
Additive optional POST method + JSON body on the shared template.

**Files modified:**
- `packages/integrations/src/connectors/adapters/http-transport.ts` — `HttpTransportRequest.method: "GET"→"GET"|"POST"` + `body?`; `ConnectorHttpSpec.method?` (default GET) + `buildBody?` (token-free, wrapped fail-closed). Flow: `method = spec.method ?? "GET"`; SSRF-guard-first (method-agnostic); POST builds body + `content-type`; GET byte-identical. In-code **READ-ONLY WARNING** on `method`/`buildBody`.
- `packages/integrations/test/connector-http-transport.test.ts` — 6 POST-path tests.

### Slice 2 — Linear GraphQL transport (task 31, brief 082, `47fbf99`)
`createLinearHttpTransport(deps)` = `createConnectorHttpTransport(LINEAR_HTTP_SPEC, deps)`, added to the EXISTING `linear.ts` (count-pin untouched).

**Files modified:**
- `packages/integrations/src/connectors/adapters/linear.ts` — `+createLinearHttpTransport` + `LINEAR_HTTP_SPEC` (POST `api.linear.app`/`/graphql`) + fixed query-only `LINEAR_ISSUES_QUERY` + `linearBuildBody` (`JSON.stringify({query, variables:{first:50, after}})`) + `linearMapPage` (fail-closed incl. GraphQL-200-`errors`) + `linearContentHash` (`payloadHash({id, updatedAt})`) + `linearNextCursor` (STRICT). In-code read-only / injection / GraphQL-200-error / auth-arch_gap notes.
- `packages/integrations/src/connectors/adapters/index.ts` — barrel export.

**Files created:** `packages/integrations/test/connector-linear-transport.test.ts` (25 tests).

## Decisions made

- **Slice 1 — additive POST widening (backward-compat):** `method` defaults GET; the 4 (now 5) existing 1-arg GET mappers + specs stay byte-unchanged (contravariance); GET request shape byte-identical (headers `{accept, Authorization}`, no body/content-type). POST adds a token-free `buildBody` (wrapped fail-closed) + `content-type`.
- **Read-only intent (lead-authorized posture):** widening `method` to allow POST relaxes the type-level ING-7 "GET-only ⇒ read-only" guarantee. A POST connector's read-only-ness rests on the SPEC (a fixed query-only `buildBody`) + review, NOT the HTTP method (the transport can't inspect an opaque GraphQL body). Documented with an in-code WARNING; the no-`mutation` enforcement rides slice 2.
- **SSRF method-agnostic + rule-7 on body:** the guard runs on the FINAL url before token/buildBody/dispatch (POST doesn't bypass — off-allowlist ⇒ zero token/buildBody/dispatch); the token rides only Authorization, never the body (buildBody gets the token-free request). Both pinned.
- **Slice 2 — Linear GraphQL:** POST to `/graphql`; `buildQuery: () => ""` (the query rides the body); `LINEAR_ISSUES_QUERY` a fixed compile-time query-only const (no `mutation`/`subscription`); `linearBuildBody` uses `JSON.stringify` (never interpolation) so a hostile `"`-bearing cursor is escaped verbatim into `variables.after`; `linearMapPage` fail-closes on the GraphQL-200-`errors` case (checked BEFORE the data check — Linear returns 200 even on a query error; partial data dropped), STRICT `hasNextPage`/`endCursor` gate (mirrors Granola). recordId = id; `payloadHash({id, updatedAt})`.
- **Context7 re-confirm** (both slices where relevant): slice 2 `/websites/linear_app_developers` CONFORMANT (POST `/graphql`, `{query, variables}`, `issues(first, after){nodes pageInfo{hasNextPage endCursor}}`, GraphQL-200-errors, Bearer-vs-personal-key auth).
- **Review fold-ins:** slice 1 — pinned the absent-buildBody guard fires before dispatch + an empty-body/stray-GET-buildBody edge test; slice 2 — a benign `errors:null` valid-page test + an empty-`nodes[]` valid-page test.

## Decisions explicitly NOT made (deferred to arming)

- **Binding any real transport / token** — the HARD LINE, owner-gated. Both slices dormant/unbound.
- **AUTH arch_gap (Linear):** a Linear personal API key uses a RAW `Authorization: <key>` (no `Bearer`), NOT template-compatible — a per-spec auth-scheme seam is an arming-era template touch. The candidate assumes an OAuth2 Bearer token (works today). Documented + Carry-forward; NOT widened here.
- **No-`mutation` runtime enforcement beyond the fixed query const + review** — the transport can't inspect an opaque body; the query-only invariant is the spec's contract (pinned by the no-`mutation` test).
- **Minimal-scope token; rate-limit backoff; confirm real wire shape** — arming residuals (both connectors).

## TDD compliance

**CLEAN — test-first both slices.** Slice 1: RED (POST-behavior tests fail; GET-byte-exact + SSRF guardrails hold before+after), Step-2.5 approved, GREEN. Slice 2: RED (`createLinearHttpTransport is not a function`), Context7 re-confirm + Step-2.5 approved, GREEN. Both dual-reviewed at Step 8; review lows folded in as additional tests. No test-after-impl, no TDD skip.

## Reachability

- **Slice 1** — no new production symbol (template capability). GET byte-equivalent for the 5 existing connectors; the POST path is exercised by slice-1 fake-POST tests + slice 2.
- **Slice 2 `createLinearHttpTransport`** — on the public barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (`createLinearConnector(createLinearHttpTransport(...))` + real HttpTransport + Linear OAuth2 token). Verified ZERO production importers ⇒ byte-equivalent.

## Open follow-ups

Step-9 categorized items (routed hot to orch21; it writes at the R6 seal / Carry-forward):
- **Architecture doc note (§8):** the template's POST/GraphQL path (slice 1) + Linear = the 6th Context7-grounded instance, first GraphQL-over-POST (slice 2).
- **Convention candidate (providers LESSONS §5):** GraphQL-over-POST read connectors — a FIXED query-only body (no `mutation`), params via `variables` (JSON.stringify, never interpolation), fail-closed on the GraphQL-200-`errors` case (HTTP status is NOT the error signal). orch21 is banking it as durable.
- **Future TODO (arming gate):** the Linear AUTH arch_gap (personal-key raw-Authorization seam); minimal-scope token; rate-limit backoff; confirm the real wire shape; bind the real transports + tokens (HARD LINE).
- **Cross-doc invariant change:** NONE (`HttpTransportRequest`/`ConnectorHttpSpec`/`LINEAR_HTTP_SPEC` integrations-internal seams; additive/backward-compat).

## How to use what was built

A GraphQL-over-POST read connector = a `ConnectorHttpSpec` with `method:"POST"` + `buildQuery:()=>""` + a `buildBody` that `JSON.stringify`s a FIXED query-only document + `variables` (cursor via a variable, never interpolated), and a `mapPage` that fail-closes on the GraphQL-200-`errors` case. GET connectors keep the default (no method/buildBody). Real `deps` are bound only at the owner-arming crossing.
