# Session 056 — Phase-13 OSB extractor set (round 5): podcast + youtube-hardening + file

- **Date:** 2026-07-11
- **Team:** `session-f2673cd5` — orchestrator `orchestrator-2` (this doc; authored at the orchestrator cycle, since the still-alive `implementer` did NOT `/session-end` this round) + `implementer` (worker area, stays up).
- **Predecessor:** `055-2026-07-11-ingestion-arc-uisafe-bounding-web-extractor.md` (round 4).
- **Round scope:** round 5 = the 3 extractor slices since round-4 seal `ea0dae5`. Owner direction C (autonomous, everything DORMANT over FAKED ports, no real vendor I/O, no HITL). Repo-wide `turbo typecheck test` 31/31 green throughout.

## What was built

Completed the Phase-13 OSB **4-extractor set** (task 13.2). The web-article extractor (`e05285a`) landed in round 4 (session 055); round 5 added the remaining three:

- **`e73168d` — podcast extractor** (`extractPodcastSource`, `packages/integrations/src/connectors/adapters/podcast-source.ts`). Emit-only over a FAKED `PodcastExtractTransport`; `origin = episodeId` (the guaranteed RSS-guid locator; `audioUrl` optional → routingHints); `contentHash = payloadHash({episodeId, transcript})` (episodeId in the hash ⇒ distinct episodes with identical transcripts don't false-dedupe); `type: "podcast"`. Step-8 both CLEAR.
- **`54c9363` — youtube-source never-throw hardening** (`fix`, closes the latent §-gap the web-source Step-8 reviewers flagged). Widened the try to wrap the WHOLE post-transport map under ONE `catch → unknown`; added an adapter-level empty/whitespace/non-string transcript guard → new `empty_content` code (adapter error union only; transport union unchanged; `no_transcript` transport-code path preserved). No happy-path/signature change. Brings all 3 shipped extractors to Lesson-11 parity. Step-8 CLEAR.
- **`0d2409c` — file/PDF extractor** (`extractFileSource`, `file-source.ts`), completes the set. `origin = path`; `contentHash = payloadHash({path, text})`; `type: "file"`; routingHints metadata-only, **empty `{}` when both optional hints absent** (honest no-inference — such a source is low-confidence → parked in the §9.7 ingestion inbox). Step-8: security CLEAR + code-quality 1 MEDIUM fixed (the dead `mime?` transport-request surface was threaded LIVE as an `ExtractFileInput.mime` caller/policy parser-selection hint — honors the brief's signature without introducing inference).

All 4 adapters: emit `RegisterSourceInput` **candidates** through the REAL `registerSource()` gate (emit-only — never write; safety rule 1), TOTAL never-throws over the untrusted transport (**Lesson 11** — the transport can throw OR resolve `ok` with a pathological/non-string shape, so the whole map runs under one try), fail-closed on fault/empty/malformed, no-inference (scope/routingHints never fabricated from the untrusted body), `type` on the OPEN `SourceEnvelope.type` (no frozen-contract round). Dormant — the real transports (RSS/audio/fs/PDF/web fetch) are named "REAL-EXTRACTOR INJECTION POINT" deferrals, no real I/O in any adapter or its tests.

## Decisions made

- **`origin` = each source's guaranteed locator** — web `url`, youtube `watchUrl`, podcast `episodeId` (guid), file `path`. `contentHash` = `payloadHash({locator, content})` so a distinct source (different locator) never false-dedupes with identical content.
- **Empty `routingHints {}` allowed (file)** — no synthetic default fabricated (that would violate no-inference); gate-valid (`z.record` accepts `{}`); the honest low-confidence result.
- **youtube hardening = whole-body-under-one-try + adapter empty guard + additive `empty_content`** (not overloading `no_transcript`; distinct semantics — `no_transcript` = transport `!ok`, `empty_content` = `ok` with empty/pathological content).
- **Slice atomicity upheld** — the youtube try-widening was NOT folded into the podcast slice (implementer correctly cited "never bundle a safety-critical slice"); it ran as its own focused slice `54c9363`.
- **mime threaded live (file)** over dropping the declared surface — a caller/policy parser hint, not content-derived.

## Decisions explicitly NOT made (deferred)

- The **REAL fetch transports** (RSS/audio-transcription/fs/PDF/web) — dormant injection points; no real vendor I/O per direction C.
- **Downstream summarization/transcription** (ModelProviderPort + egress veto) — HITL/real-egress, deferred.
- The **13.1 anti-corruption grep-guard** + `config/osb.pin` — the NEXT non-HITL deterministic target (a governance-boundary test proving no vendored/extractor path can write the canonical vault; structurally enforces emit-only / one-writer).
- The **sibling-wide NIT sweep** (LOW) — 3 inherited NITs (frozen-input `toEqual`, `*ExtractResult` doc-comment opener, transport-request-shape assertion) across youtube/web/podcast (file's is covered); a single sweep, never one-only (sibling parity).

## TDD compliance

All 3 slices strict RED→GREEN (the 2 new youtube tests correctly failed against the pre-fix code). Mandatory Step-8 adversarial review (untrusted-content ingest) on every slice — podcast CLEAR, youtube CLEAR (focused), file security-CLEAR + code-quality 1 MEDIUM fixed. Repo-wide `turbo typecheck test` 31/31 green after each.

## Cross-doc invariant audit

**NONE.** All emit-only extractors ride the OPEN `SourceEnvelope.type`; no frozen Appendix-A seam / schema / snapshot / registry / cross-doc-table change. Purely additive `packages/integrations` adapters + fixtures.

## Reachability

Judgment-waived per adapter (dormant prototypes; the real transport is the named injection point) — each proven reachable by emitting through the REAL `registerSource()` gate in its tests.

## Open follow-ups

1. **13.1 anti-corruption grep-guard + `config/osb.pin`** — next non-HITL deterministic slice (the successor orchestrator authors it).
2. Sibling-wide NIT sweep (LOW, youtube/web/podcast).
3. Real transports + downstream summarization (dormant/HITL).
4. Phase-13 continues: 13.3 retrieval, 13.4 vault MCP, 13.5 Project model, etc. (various; some HITL/bigger).

## How to use what was built

The 4 emit-only extractors are ready to wire to real transports when the owner authorizes real vendor I/O (out of direction-C scope). Until then they parse fixture payloads → candidate `SourceEnvelope`s through the real gate — fixture-testable, governed, dormant.
