# Session 076 — 13.12 connector round 4: Granola read HTTP transport

- **Date:** 2026-07-15
- **Phase:** Go-live build round 4 (runbook Phase-8 connector round — Granola). Team `session-734f946b`, orchestrator `orch20` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [075-2026-07-15-integrations-impl-google-connectors-asana-verify.md](075-2026-07-15-integrations-impl-google-connectors-asana-verify.md)
- **Successor:** [077-2026-07-15-integrations-impl-github-transport.md](077-2026-07-15-integrations-impl-github-transport.md)
- **Commits:** Granola `7687f2c` · this session doc

## Why this session existed

Round 4 added the Granola meeting-notes connector — the simplest template-follow yet (a static `grn_` Bearer API key, no OAuth) — as a thin per-vendor spec over the round-2 `createConnectorHttpTransport` template. Owner-corrected scope: Granola has a public HTTP API (`public-api.granola.ai`), not a local reader. DORMANT — real transport + `grn_` key UNBOUND; binding is the owner's arming crossing (HARD LINE). NO hard line crossed.

## What was built

### Granola read transport (task 28, brief 079, `7687f2c`)
`createGranolaHttpTransport(deps): ConnectorTransport` = `createConnectorHttpTransport(GRANOLA_HTTP_SPEC, deps)`, added to the EXISTING `granola.ts` (mirror `asana.ts` — no new adapter file, so the OSB anti-corruption count-pin stays at 18, untouched).

**Files modified:**
- `packages/integrations/src/connectors/adapters/granola.ts` — `+createGranolaHttpTransport` + `GRANOLA_HTTP_SPEC` (`public-api.granola.ai`/`/v1/notes`) + `granolaMapPage` (candidate `ListNotesOutput{notes[], hasMore, cursor}`, fail-closed) + `granolaBuildQuery` (page_size=30 + `encodeURIComponent` cursor) + `granolaContentHash` (`payloadHash({id, updated_at})`) + `granolaNextCursor` (the STRICT pagination gate). In-code Context7 citation + rate-limit + minimal-scope-key arming notes.
- `packages/integrations/src/connectors/adapters/index.ts` — barrel export.

**Files created:** `packages/integrations/test/connector-granola-transport.test.ts` (22 tests).

## Decisions made

- **Existing `granola.ts`** (mirror `asana.ts`) — no new adapter file ⇒ count-pin untouched at 18.
- **STRICT pagination gate (load-bearing):** `granolaNextCursor` advances ONLY on `hasMore === true` (strict — a truthy-non-`true` value must not drive an infinite page loop; worker Lesson-28 class) AND a non-empty `cursor` string; every other state (hasMore false/absent/non-boolean, cursor null/absent/empty) fail-closes to `done`. Expressed as `done = (nextCursor === undefined)` — a clean single derivation, fail-safe (only ever terminates early, never loops). orch20 endorsed the combined rule as cleaner than the brief's two separate conditions.
- **Static `grn_` Bearer** — the template's bearer-string SecretsAccessor verbatim (no OAuth manager / refresh); the simplest connector.
- **`page_size = 30`** (the vendor max per Context7; >30 400s).
- **contentHash** = `payloadHash({id, updated_at})` (`updated_at` = Granola's change token), raw-note fallback if absent.
- **Context7 re-confirm (Step 1):** `/websites/granola_ai` (OpenAPI 3.1) — the built candidate is CONFORMANT (server/auth/`/v1/notes`/`ListNotesOutput`/`page_size` max 30/`not_` id all match). Noted the changelog's last-page example returns `hasMore:false` with `cursor` OMITTED (not null) — the mapper treats null and absent cursor uniformly.
- **Review fold-ins:** the code-quality MEDIUM (empty-string `cursor:""` not pinned — a regression dropping `.length>0` could loop) folded in as a test; +2 LOW coverage adds (updated_at-absent hash fallback; zero-item non-final page).

## Decisions explicitly NOT made (deferred to arming)

- **Binding the real transport + `grn_` key** — the HARD LINE, owner-gated. Ships dormant/unbound.
- **Provisioning the `grn_` key with MINIMAL scope** — arming residual (`meetings:read` is the informational declared scope).
- **429 backoff/retry SCHEDULING** (25 burst / 5 rps) — arming-era (the fault map returns `rate_limited`; scheduling is not built).
- **Filter params** (`created_after`/`updated_after`/`folder_id`) — arming-era ingestion refinement.
- **`not_…`-pattern id validation** — the mapper fail-closes on a missing/empty id (consistent with the sibling connectors' posture); strict-pattern validation is not enforced (a present-but-renamed id format is a candidate concern).

## TDD compliance

**CLEAN — test-first.** RED written first (`createGranolaHttpTransport is not a function`), Step-1 Context7 re-confirm + Step-2.5 approved by orch20, then GREEN. Dual-reviewed at Step 8; the review medium + 2 lows folded in as additional tests. No test-after-impl, no TDD skip.

## Reachability

- **`createGranolaHttpTransport`** — on the public `@sow/integrations` barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (`createGranolaConnector(createGranolaHttpTransport(...))` + real HttpTransport + the `grn_` key). Verified ZERO production importers ⇒ byte-equivalent.

## Open follow-ups

Step-9 categorized items (routed hot to orch20; it writes at the round-4 seal / Carry-forward):
- **Architecture doc note (§8):** Granola is the 4th instance of the connector-transport template (Asana/Drive/Calendar/Granola — all Context7-grounded).
- **Future TODO (arming gate):** minimal-scope `grn_` key; 429 backoff scheduling; filter params; confirm the real wire shape; bind the real transport + key (HARD LINE).
- **Convention candidate:** none new (4th application of the connector-template Lesson, Context7-grounded per the round-3 providers-LESSONS candidate).
- **Cross-doc invariant change:** NONE (`GRANOLA_HTTP_SPEC` integrations-internal; frozen seams).

## How to use what was built

A new remote connector = a per-vendor `ConnectorHttpSpec` passed to `createConnectorHttpTransport(spec, deps)`, co-located in the vendor's existing adapter file, then `makeConnector({connectorId, readScope}, transport)`. Ground the candidate wire shape on Context7 at authoring. For a `{hasMore, cursor}`-style paginator, gate the next cursor on STRICT `hasMore === true` + a valid cursor. Real `deps` are bound only at the owner-arming crossing.
