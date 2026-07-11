# Session 055 — §9.7 ingestion arc + UI-safe bounding + 13.2-web extractor

- **Date:** 2026-07-11
- **Phase:** Phase 9 (Electron UI / read-model surfaces) + Phase 13 (OSB source extractors)
- **Team:** `session-f2673cd5` (single-track on `main`), implementer + orchestrator (`orchestrator-2`) autonomous
- **Predecessor:** [054-2026-07-09-frontmatter-marker-safety.md](054-2026-07-09-frontmatter-marker-safety.md)
- **Successor:** _(next implementer — the podcast extractor, 13.2-podcast)_
- **Commits (6 slices, all on `main`):** `1dc53e6` (9.7-A) · `27818cf` (9.7-B) · `bd134f4` (9.7-C) · `f9e9adb` (9.7-hardening) · `810af35` (9.7-sweep) · `e05285a` (13.2-web)

## Why this session existed

Two arcs. First, close the **§9.7 ingestion inbox** end-to-end: the read path had only a misleading `query.ingestionInbox = pendingApprovals` alias — no dedicated read-model, producer, or surface. Second, on the owner's **direction C** (autonomous, everything dormant over faked ports, no real vendor I/O / no HITL), open the **Phase-13 OSB source-extractor arc** after the shipped `youtube-source` prototype. Between the two, a UI-safe hardening thread surfaced (a security-reviewer LOW from the producer slice) and was completed as its own convention.

## What was built

### Files created
- `packages/contracts/src/api/ui-safe.ts` — *(modified, see below; NEW symbols)* `UiSafeIngestionItem` interface + `.strict()` schema, `uiSafeToken` validator, `isSingleLine` shared guard.
- `apps/worker/src/api/projections/ingestionInboxProjection.ts` — the write-time producer core `createIngestionInboxProjectionPort({readModels, now})` (`recordPark`/`recordDisposition`); dormant.
- `apps/worker/test/api/projections/ingestionInboxProjection.test.ts` — 16 unit tests (drop-at-write, dedup, WS-8 keying + write-key authority, §16 both-ops both-faults).
- `apps/desktop/renderer/surfaces/ingestion-inbox/index.tsx` — the routable `IngestionInbox` surface (cards + empty-state; reads only the 4 UI-safe fields).
- `apps/desktop/test-dom/ingestion-inbox-page.test.tsx` — jsdom render + `hydrateIngestionInbox` + route-mount tests (LESSONS §4 second tier).
- `packages/integrations/src/connectors/adapters/web-source.ts` — `extractWebSource(input, transport)` emit-only web-article extractor; dormant.
- `packages/integrations/test/web-source.test.ts` — 11 tests mirroring `youtube-source.test.ts`.
- `docs/sessions/055-2026-07-11-ingestion-arc-uisafe-bounding-web-extractor.md` — this doc.

### Files modified
- `packages/contracts/src/api/ui-safe.ts` — added `UiSafeIngestionItem` (9.7-A); factored `isSingleLine`, added `uiSafeToken`, bound 5 open display tokens (9.7-hardening) + 2 outliers `RecentChange.kind`/`DashboardCard.title` (9.7-sweep). **Non-seam** — no field-set change; freeze/allowlist/parity held.
- `packages/contracts/test/api/ui-safe.test.ts` — ingestion contract tests + token-bounding + uniformity-sweep tests (95 total).
- `apps/worker/src/api/procedures/queries.ts` — `query.ingestionInbox → UiSafeIngestionItem[]` + `sanitizeIngestionInbox` fail-closed re-validation; removed the approvals alias.
- `apps/worker/src/api/adapters/readModel.ts` — `READ_MODEL_KEYS.ingestion` + `readIngestionItems` (exported for the producer's no-drift read-back) + WS-8-scoped adapter method.
- `apps/worker/src/api/projections/uiSafe.ts` — `toUiSafeIngestionItem` projector (drop-rules; empty-summary fallback).
- `apps/worker/test/api/{adapters/readModel,procedures/queries,uiSafe}.test.ts` — ingestion coverage incl. WS-8 A-vs-B isolation.
- `apps/desktop/renderer/{store/{route,index,projections}.ts, lib/live.ts, chrome/AppShell.tsx, App.tsx}` — `ingestion` slice + `replaceIngestion` + `hydrateIngestionInbox` + Inbox nav repurposed → routable `{surface:"ingestion"}`.
- `apps/desktop/test/renderer/{fixtures,projections}.test.ts` — `uiSafeIngestionItem` fixture + `replaceIngestion` unit tests.

## Decisions made
- **§9.7 read-first, empty-until-producer** (mirror recentChanges/projectDashboards): ship the read path + non-seam contract, then producer, then surface — all dormant behind the deferred Temporal wiring.
- **Drop-rules AT WRITE** (9.7-B): the producer applies `toUiSafeIngestionItem` before storing, so raw refs are never persisted at rest (defense-in-depth beyond the read-time drop). Reuses `readIngestionItems` for a no-drift write-side read-back.
- **WS-8 write-key authority** (9.7-B, folded reviewer LOW): `recordPark` fails closed if `input.workspaceId ≠ source.workspaceId` (REQ-F-002) — mis-attribution unrepresentable.
- **Desktop store mirrors recentChanges/projects, NOT the global approvals Map** (9.7-C) — ingestion is workspace-scoped + empty-under-Global (the correct sibling; orchestrator endorsed the correction over the brief's imprecise "mirror hydrateApprovalInbox").
- **`uiSafeToken` (max 64) vs `uiSafeSummaryLine` (max 1024)**: display tokens get the token cap; titles get the summary-line cap. The 68-char real dashboard title proved a title MUST NOT take the 64 cap (pinned as an accept-case).
- **13.2-web = total §16 over an untrusted transport** (folded convergent Step-8 finding): the WHOLE mapping runs under one try, because the deferred real transport can throw OR resolve `ok` with a pathological/non-string body — both → typed err, never a throw. `contentHash=payloadHash({url,text})` (url distinguishes same-text pages).

## Decisions explicitly NOT made (deferred)
- The **Temporal always-on wiring** for the ingestion producer (`sourceIngestion` park route + `createRecordDispositionActivity`) — the upstream park flow is a stub; stays dormant (R5-style).
- The **desktop triage-action UI** (`command.disposeTriage`) + the **live stream path** for ingestion items — read-only cold-load ships now.
- Optional `state`/`queuedAt` on `UiSafeIngestionItem` (needs an ordering key) — non-seam additive when the producer supplies them.
- The **real WebFetch transport** + downstream summarization (ModelProviderPort + egress veto) + **podcast/file extractor siblings** + the **13.1 ACL grep-guard / `config/osb.pin`** — the extractor arc continues.
- Folding the **same §16 gap in `youtube-source.ts`** (post-transport access outside its try) — held out of 13.2-web's scope; a Carry-forward uniformity follow-up.

## TDD compliance
**CLEAN.** All 6 slices were strict RED→GREEN — each RED confirmed for the right reason before any implementation, per `/tdd` Step 3. Every folded Step-8 review-fix (empty-summary fallback 9.7-A, WS-8 write-key guard 9.7-B, malformed-body guard 13.2-web) got a **failing test first**, then the fix. No test written after a green pass; no safety-critical TDD skip.

## Cross-doc invariant audit
**CLEAN — no frozen seam model changed this session.** The only `packages/contracts` change is `src/api/ui-safe.ts` (the **non-seam** UI-safe projection family — not in the cross-doc invariants table). `UiSafeIngestionItem` is a non-seam addition (same family as `UiSafeApproval`); the token bounding is validator-tighten only (no field-set change). `type:"web_article"` rides the **open** `SourceEnvelope.type` (no field change). No `ARCHITECTURE.md` Appendix-A / schema-snapshot / ajv-registry edit was required.

## Reachability
- **9.7-A** `query.ingestionInbox` — LIVE: `boot.ts:435` (`createDbReadModelQueryPort`) → `server.ts:90` (`buildQueryRouter`) → `sanitizeIngestionInbox` → adapter.
- **9.7-B** producer core — judgment-WAIVED (dormant, mirror of `projectRecentChanges`); entry `query.ingestionInbox` is live and surfaces produced rows once the wiring attaches.
- **9.7-C** `IngestionInbox` surface — LIVE: "Inbox" NavLink → `onNavigate({surface:"ingestion"})` → route store → `App` renders it; `hydrateIngestionInbox` on connect + scope-change.
- **9.7-hardening / 9.7-sweep** — the tightened validators run at the existing UI-safe query boundary (`query.dashboard`/`ingestionInbox`/`recentChanges`/`projectDashboards` → `sanitize*` → schema gate).
- **13.2-web** — judgment-WAIVED (dormant prototype, like `youtube-source`); proven reachable via the REAL `registerSource()` gate in the governance-proof test; real WebFetch transport = the named "REAL-EXTRACTOR INJECTION POINT" deferral.

No tested-but-silently-unwired gaps: the dormant cores (9.7-B, 13.2-web) are explicitly phase-attributed to their deferred Temporal / real-transport wiring.

## Open follow-ups (Step-9 categorized; orchestrator already routed hot)
- **Future TODO (belongs-to-a-phase):** §9.7 Temporal always-on wiring (park route + `createRecordDispositionActivity`); desktop triage-action UI + live stream path; the 13.2 real WebFetch transport, downstream summarization, and podcast/file extractor siblings; the 13.1 ACL grep-guard + `config/osb.pin`.
- **Convention candidate (uniformity):** fold the total-§16 widened-try into `youtube-source.ts` (same latent post-transport gap).
- **Future TODO (next-brief, non-seam additive):** optional `state`/`queuedAt` on `UiSafeIngestionItem`.
- **Cross-doc invariant: NONE** this session. **Deferred-HITL ledger: UNCHANGED** (all propose/serving-oracle/real-egress flips stay human-gated; every extractor is dormant over faked ports).
- **Lessons:** orchestrator banked the read-model-inbox discipline (§10) + the emit-only extractor / total-§16 discipline (Lesson 11).

## How to use what was built
- The §9.7 ingestion inbox is wired end-to-end and renders its empty-state today; it populates automatically once the producer's Temporal park/disposition wiring lands. `extractWebSource` is a drop-in emit-only adapter — inject a real `WebFetchTransport` at the marked injection point to activate (still routes through `registerSource` → KnowledgeWriter downstream; the adapter never writes).
