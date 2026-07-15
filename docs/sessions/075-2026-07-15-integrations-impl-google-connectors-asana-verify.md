# Session 075 — 13.12 connector round 3: Google Drive + Calendar transports + Asana Context7 correctness-verify

- **Date:** 2026-07-15
- **Phase:** Go-live build round 3 (runbook Phase-8 connector round — the Google connectors + the owner Context7 correctness pass). Team `session-734f946b`, orchestrator `orch20` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [074-2026-07-15-integrations-impl-connector-transport.md](074-2026-07-15-integrations-impl-connector-transport.md)
- **Successor:** [076-2026-07-15-integrations-impl-granola-transport.md](076-2026-07-15-integrations-impl-granola-transport.md)
- **Commits:** slice 1 Drive `0087154` · slice 2 Calendar `a4e5b9b` · slice 3 Asana-verify `6908b0b` · this session doc

## Why this session existed

Round 3 replicated the round-2 connector-transport template to the owner's next-priority Google connectors (Drive, Calendar) as thin per-vendor specs, then ran an owner-directed **Context7 correctness pass** on the round-2 Asana adapter (authored from memory before the Context7-grounding directive). All DORMANT — real transport/secrets/OAuth tokens UNBOUND; binding a real transport is the owner's arming crossing (HARD LINE). NO hard line crossed.

## What was built

### Slice 1 — Google Drive read transport (task 25, brief 076, `0087154`)
`createDriveHttpTransport(deps): ConnectorTransport` = `createConnectorHttpTransport(DRIVE_HTTP_SPEC, deps)`, added to the EXISTING `drive.ts` (mirror `asana.ts` — no new adapter file, so the OSB anti-corruption count-pin stays at 18, untouched).

**Files modified:**
- `packages/integrations/src/connectors/adapters/drive.ts` — `+createDriveHttpTransport` + `DRIVE_HTTP_SPEC` (`www.googleapis.com`/`/drive/v3/files`) + `driveMapPage` (candidate `{files[], nextPageToken}`, fail-closed) + `driveBuildQuery` (pageSize/fields + `encodeURIComponent` pageToken) + `driveContentHash` (`payloadHash({id, modifiedTime})`). In-code OAuthTokenSource (`drive.readonly` only) + `incompleteSearch` arch_gap notes.
- `packages/integrations/src/connectors/adapters/index.ts` — barrel export.

**Files created:** `packages/integrations/test/connector-drive-transport.test.ts` (15 tests).

### Slice 2 — Google Calendar read transport (task 26, brief 077, `a4e5b9b`)
`createCalendarHttpTransport(deps)` in the EXISTING `calendar.ts` (mirror `drive.ts`, no count-pin trip).

**Files modified:**
- `packages/integrations/src/connectors/adapters/calendar.ts` — `+createCalendarHttpTransport` + `CALENDAR_HTTP_SPEC` (`www.googleapis.com`/`/calendar/v3`/`/calendars/primary/events`) + `calendarMapPage` (candidate `{items[], nextPageToken, nextSyncToken}`, fail-closed) + `calendarBuildQuery` (maxResults/singleEvents + `encodeURIComponent` pageToken) + `calendarContentHash` (`payloadHash({id, updated})`). Paging is `nextPageToken`-only; `nextSyncToken` documented as the arming-era incremental-sync token (NOT the paging cursor). In-code arch_gap (nextSyncToken, calendarId=primary candidate) + OAuthTokenSource (`calendar.readonly` only) notes.
- `packages/integrations/src/connectors/adapters/index.ts` — barrel export.

**Files created:** `packages/integrations/test/connector-calendar-transport.test.ts` (16 tests).

### Slice 3 — Asana Context7 correctness-verify (task 27, brief 078, `6908b0b`)
Verified the round-2 Asana adapter field-by-field against Context7 `/websites/developers_asana`; corrected one real candidate bug.

**Files modified:**
- `packages/integrations/src/connectors/adapters/asana.ts` — `asanaBuildQuery` now appends `&opt_fields=name,modified_at` (encoded); arch_gap comment rewritten to CITE Context7 + NAME 2 arming gaps.
- `packages/integrations/test/connector-http-transport.test.ts` — 2 new tests pinning the corrected query.

## Decisions made

- **Drive/Calendar in their existing adapter files** (mirror `asana.ts`) — no new adapter file, so the OSB §13.1 anti-corruption count-pin is not tripped (stays 18). Confirmed by orch20.
- **Drive:** `payloadHash({id, modifiedTime})` contentHash; candidate `{files[], nextPageToken}`; `incompleteSearch` (partial-corpora signal) intentionally ignored — a documented arming-era completeness decision (both reviewers flagged; pinned by a test).
- **Calendar:** paging from `nextPageToken` ONLY — `nextSyncToken` is the incremental-sync token (arming-era), never the paging cursor (last page ⇒ done; page-token-wins if both present). `calendarId=primary` candidate default. `payloadHash({id, updated})` contentHash.
- **Asana-verify VERDICT = CORRECTED:** 7/8 axes CONFORMANT (host/allowlist, Bearer PAT, list path, offset/`next_page` pagination, `{data[], next_page}` map, `gid`, status→fault). Axis-4 delta CORRECTED — added `opt_fields=name,modified_at` because Context7 confirms `GET /tasks` returns COMPACT records (gid+name) omitting `modified_at`, so the built query silently degraded `asanaContentHash`'s change-token dedupe to a token-less raw hash. + 1 NAMED arming gap: the required scope param (`project`|`tag` OR `assignee`+`workspace`, owner GID) — GET /tasks 400s without it. Source: Context7 `/websites/developers_asana`.
- **Correct `opt_fields` now** (static, owner-independent, realizes the contentHash intent) vs **name-only** — orch20 ruled correct-now; the scope param stays a named arming gap.

## Decisions explicitly NOT made (deferred to arming)

- **Binding any real transport / OAuth token / Asana PAT** — the HARD LINE, owner-gated. All three transports ship dormant/unbound.
- **Drive `incompleteSearch` degrade-vs-ignore** decision (confirm at arming).
- **Calendar `nextSyncToken` incremental-sync resume** + **configurable `calendarId`** (arming refinements).
- **Asana required scope param** (owner's project/workspace GID) + **ingestion-richness `opt_fields`** (notes/assignee/due_on) — named arming gaps.
- **OAuth token manager** (access-token refresh/expiry/rotation behind the SecretsAccessor; 401→auth_locked is the dormant signal) — arming-era for both Google connectors.

## TDD compliance

**CLEAN — test-first all three slices.** Drive/Calendar: RED written first (module-not-found / `is not a function` collection errors), Step-2.5 approved by orch20, then GREEN. Asana-verify: investigation (Context7 diff) first, then a RED test pinning the corrected query (asserting `opt_fields=name%2Cmodified_at`, currently failing against the pre-correction query), then GREEN. All dual-reviewed at Step 8; review fold-ins landed as additional tests/precision. No test-after-impl, no TDD skip.

## Reachability

- **Drive/Calendar transports** — on the public `@sow/integrations` barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (`createXConnector(createXHttpTransport(...))` + real HttpTransport + OAuth-backed SecretsAccessor + read-only token). Verified ZERO production importers ⇒ byte-equivalent.
- **Asana-verify** — no new production symbol (a candidate-query refinement of the already-waivered dormant Asana adapter). Byte-equivalent.

## Open follow-ups

Step-9 categorized items (routed hot to orch20; it writes at round close / Carry-forward):
- **Architecture doc note (§8):** the connector-transport template now has 3 Context7-grounded instances (Asana/Drive/Calendar); fold the Asana=CORRECTED verdict into the round-close report.
- **Convention candidate (providers LESSONS):** "ground every connector candidate on Context7 at authoring; back-verify any built pre-Context7" — the Asana pass caught a real change-token dedupe bug, so orch20 is banking it.
- **Future TODO (arming gate):** Drive `incompleteSearch` degrade decision; Calendar `nextSyncToken` incremental resume + configurable `calendarId`; Asana required scope param (owner GID) + ingestion-richness `opt_fields`; the OAuth token manager (both Google connectors); bind the real transports + tokens (HARD LINE).
- **Cross-doc invariant change:** NONE this round (all `*_HTTP_SPEC` integrations-internal; frozen seams).

## How to use what was built

A new remote connector = a per-vendor `ConnectorHttpSpec` (`baseUrl`, `allowedHosts`, `resourcePath`, `buildQuery`, `mapPage`) passed to `createConnectorHttpTransport(spec, deps)`, co-located in the vendor's existing adapter file, then `makeConnector({connectorId, readScope}, transport)`. Ground the candidate wire shape on Context7 at authoring. Real `deps` (HttpTransport + SecretsAccessor + tokenRef) are bound only at the owner-arming crossing.
