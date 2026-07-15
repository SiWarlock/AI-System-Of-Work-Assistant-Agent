# Session 079 — 13.12 connector round 7: Gmail messages list-only read transport

- **Date:** 2026-07-15
- **Phase:** Go-live build round 7 (runbook Phase-8 connector round — Gmail, list-only). Team `session-734f946b`, orchestrator `orch21` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [078-2026-07-15-integrations-impl-linear-graphql.md](078-2026-07-15-integrations-impl-linear-graphql.md)
- **Successor:** [080-2026-07-15-integrations-impl-osb-extractor-verify.md](080-2026-07-15-integrations-impl-osb-extractor-verify.md)
- **Commits:** Gmail `c7dcd16` · this session doc

## Why this session existed

Round 7 added the Gmail messages connector — the 7th `createConnectorHttpTransport` instance, a GET body-cursor connector (mirrors Drive/Calendar). Lead-ruled **LIST-ONLY**: `messages.list` returns id-level refs (`{id, threadId}`) only; per-message content requires a `messages.get` fan-out, deliberately deferred. DORMANT — real transport/secrets/token UNBOUND; binding is the owner's arming crossing (HARD LINE). NO hard line crossed.

## What was built

### Gmail list-only transport (task 32, brief 083, `c7dcd16`)

**Files created:**
- `packages/integrations/src/connectors/adapters/gmail.ts` — `createGmailConnector` (readScope `gmail.readonly`) + `createGmailHttpTransport` + `GMAIL_HTTP_SPEC` (GET `gmail.googleapis.com`/`/gmail/v1/users/me/messages`) + `gmailMapPage` (absent `messages` ⇒ empty page; present non-array / bare array / bad msg ⇒ fail-closed) + `gmailBuildQuery` (maxResults=100 + encoded pageToken) + `gmailContentHash` (`payloadHash({id, threadId})` or `{id}`) + `gmailNextCursor` (STRICT). In-code LIST-ONLY hydration + ING-7 + auth arch_gap notes.
- `packages/integrations/test/connector-gmail-transport.test.ts` — 22 tests.

**Files modified:**
- `packages/integrations/src/connectors/adapters/index.ts` — barrel exports (both `createGmailConnector` + `createGmailHttpTransport`).
- `packages/evals/test/osb/anti-corruption.test.ts` — **cross-track, pre-authorized:** OSB count-pin `EXPECTED_CONNECTOR_ADAPTER_COUNT` 18→19 (CONSTANT-ONLY + the brief's audit comment; scan logic + `violations` assertion untouched).

## Decisions made

- **LIST-ONLY (lead ruling) — a NAMED deferral, NOT a silent drop:** `messages.list` returns id-level `{id, threadId}` only. Detail-HYDRATION (`messages.get` per id — a fan-out with batching / rate-limit backoff / partial-failure design questions) is an arming residual + a candidate FUTURE round (likely reusable beyond Gmail). Documented in-code + Carry-forward.
- **⚠ ING-7 baked in NOW (as a note):** when hydration lands, email content is UNTRUSTED external content ⇒ ING-7 tool-stripping applies HARD (any agent consuming it runs read-only, no mutating tools).
- **`gmail.readonly` scope ONLY** — never a send/modify/compose scope; the e2e test asserts the readScope handed to the transport.
- **Absent-vs-malformed `messages`:** an ABSENT `messages` key (empty inbox — Context7-confirmed the empty shape omits it) ⇒ an empty page; a PRESENT non-array `messages`, a bare top-level array, a non-object entry, or a missing `id` ⇒ fail-closed. `done` is driven by the `nextPageToken` cursor (not `items.length`) — an empty filtered page WITH a token keeps paginating.
- **contentHash on immutable id-refs:** `payloadHash({id, threadId})` (or `{id}`) — list-only refs are immutable, so a message dedupes to one emission; a content-derived change token arrives with hydration (arming).
- **Count-pin (pre-authorized cross-track):** the new `gmail.ts` trips the OSB anti-corruption tripwire +1; bumped 18→19 CONSTANT-ONLY + the audit comment, 0 violations (gmail.ts read-only) — the tripwire working as designed.
- **Context7 re-confirm (Step 1):** `/websites/developers_google_workspace_gmail_api` CONFORMANT (host/`messages.list`/Bearer/`gmail.readonly`/`{messages:[{id,threadId}], nextPageToken}`/`maxResults`+`pageToken`; empty-inbox omits `messages`).
- **Review fold-ins:** 2 code-quality lows folded (non-string-`threadId` `{id}`-fallback + present-empty-array+token paginate); 2 deferred (numeric-id = same predicate; resourcePath-carries-version = per-brief).

## Decisions explicitly NOT made (deferred to arming / future round)

- **Detail-HYDRATION (`messages.get` fan-out)** — the LIST-ONLY deferral; a candidate FUTURE round with real design questions (batching/backoff/partial-failure), best settled at arming with real data.
- **Binding the real transport + OAuth token** — the HARD LINE, owner-gated. Ships dormant/unbound.
- **OAuth token manager (refresh/expiry) + minimal-scope `gmail.readonly` token** — arming residuals.
- **`q`/`labelIds`/`includeSpamTrash` filters + the legacy `www.googleapis.com/gmail/v1` host alt** — arming-era ingestion refinements.

## TDD compliance

**CLEAN — test-first.** RED (`createGmailHttpTransport is not a function` — new module), Step-1 Context7 re-confirm + Step-2.5 approved, GREEN. GREEN surfaced a top-level-array (`[]`) mapping to an empty page (its `.messages` is absent) — added an `Array.isArray(json)` envelope guard so a bare array fails-closed (the test expectation was correct; impl hardening). Dual-reviewed at Step 8; 2 review lows folded in. No test-after-impl, no TDD skip.

## Reachability

- **`createGmailHttpTransport` / `createGmailConnector`** — on the public `@sow/integrations` barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (`createGmailConnector(createGmailHttpTransport(...))` + real HttpTransport + OAuth `gmail.readonly` token). Verified ZERO production importers ⇒ byte-equivalent.

## Open follow-ups

Step-9 categorized items (routed hot to orch21; it writes at the R7 seal / Carry-forward):
- **Architecture doc note (§8):** Gmail = the 7th Context7-grounded instance (list-only, GET body-cursor).
- **Future TODO (arming gate) — NAMED:** the detail-hydration (`messages.get` fan-out) + the ING-7 tool-stripping obligation (untrusted email content); OAuth token manager; minimal-scope `gmail.readonly` token; `q`/`labelIds`/`includeSpamTrash` filters + the `www.googleapis.com` host alt; bind the real transport + token (HARD LINE).
- **Cross-track note:** the OSB count-pin is now 19 (pre-authorized, CONSTANT-ONLY + audit comment) — orch21 folds the durable eval-security review-line note at round close.
- **Cross-doc invariant change / convention candidate:** NONE.

## How to use what was built

A LIST-ONLY id-ref connector = a `ConnectorHttpSpec` (GET) whose `mapPage` treats an ABSENT collection key as an empty page (not a failure), fails closed on a present-but-malformed collection, and drives `done` from the cursor. Hydrating detail (a per-id fetch) is a separate step to design at arming — and its content is untrusted (ING-7). Real `deps` are bound only at the owner-arming crossing.
