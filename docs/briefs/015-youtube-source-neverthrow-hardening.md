# /tdd brief — youtube_source_neverthrow_hardening (task 13.2 — close the latent never-throw gap in the shipped youtube-source extractor; apply the Lesson-11 discipline for sibling parity)

## Feature
Harden the **shipped** `youtube-source.ts` (G1 prototype) to match the Lesson-11 extractor discipline now proven in `web-source` + `podcast-source`: (1) **widen the try** so the WHOLE post-transport map runs under ONE try — today youtube's post-transport property access + mapping sit OUTSIDE its try, so an untrusted transport that resolves `ok` with a pathological/non-string shape (a null/circular transcript, a hostile getter) throws across the seam instead of returning a typed err; and (2) add an **adapter-level empty/malformed-transcript guard** → `empty_content` — today youtube relies ONLY on the transport self-signalling `no_transcript`, so a transport that resolves `ok` with an empty/whitespace/non-string transcript (not signalling `no_transcript`) has no fail-closed guard. This is the latent §-gap the web-source Step-8 reviewers flagged (both convergently) + the podcast Step-9 confirmed. Dormant (youtube's real transport stays an injection point); a pure hardening + regression tests, no behavior change on the happy path.

## Use case + traceability
- **Task ID:** 13.2 source extractor adapters — the youtube-source never-throw/fail-closed hardening (origin: 13.2-web + 13.2-podcast Step-9 flags; sibling parity with the web+podcast fix). Phase-13 OSB inheritance.
- **Architecture sections it implements:** `ARCHITECTURE.md §8` (SourceIngestionPort / Connector Gateway — the emit-only extractor) + `§6` (candidate-data gate). Safety rules: **1 (emit-only, never writes)**, **2 (candidate-data gate)**, **6 (ING-7 — youtube consumes UNTRUSTED transcript content, read-only/emit-only)**, and the never-throw convention. Implementer confirms the §8/§6 anchor at Step 0.
- **The proven MIRROR (just shipped):** `web-source.ts` (`extractWebSource`) + `podcast-source.ts` (`extractPodcastSource`) — the WHOLE post-transport map under ONE try + an adapter-level empty/whitespace/non-string content guard → `empty_content`. Codified as **Lesson 11** (OSB extractor: emit-only + TOTAL never-throws — the untrusted transport can throw OR resolve `ok` with a pathological shape).
- **The file to fix:** `packages/integrations/src/connectors/adapters/youtube-source.ts` (`extractYouTubeSource`) + its test `packages/integrations/test/youtube-source.test.ts`.

## Scope boundary (IN vs deferred)
- **IN (this slice):** in `youtube-source.ts` — widen the try to wrap the WHOLE post-transport map (property access + hashing + candidate build), and add an adapter-level empty/whitespace/non-string transcript guard → the existing typed fail-closed error (an `empty_content`-equivalent code; reuse youtube's error union — add the code if absent). Regression tests pinning both. NO happy-path behavior change; NO signature change (the transport contract + the `no_transcript` transport-code path are preserved — the adapter guard is defense-in-depth ON TOP).
- **DEFERRED (not this slice):** the REAL youtube transport (dormant injection point); downstream summarization; the file/PDF extractor (the next arc slice); the 3 inherited sibling-wide NITs (frozen-input `toEqual`, the `*ExtractResult` doc-comment, the transport-request-shape assertion — a separate LOW sibling-wide sweep across all 3 adapters, never one-only).

## Acceptance criteria (what "done" means)
- [ ] **TOTAL never-throws:** the WHOLE post-transport map in `extractYouTubeSource` runs under ONE try — a transport that THROWS or resolves `ok` with a pathological/non-string shape (null/circular transcript, hostile getter) ⇒ a typed error (youtube's `unknown`-equivalent), NEVER a throw across the seam. (Match web/podcast exactly.)
- [ ] **Adapter-level empty/malformed guard:** a transport that resolves `ok` with an empty / whitespace-only / non-string transcript (WITHOUT signalling `no_transcript`) ⇒ fail-closed typed err (`empty_content`-equivalent), NO contentless candidate. The existing `no_transcript` transport-code path is preserved (both paths fail-closed).
- [ ] **No happy-path change:** a valid transcript ⇒ the SAME `RegisterSourceInput` candidate as before (`type:"youtube_video"`, `contentHash=payloadHash({videoId,transcript})`, routingHints, scope passthrough) — the existing youtube tests stay green; emit-only + the REAL `registerSource()` governance-proof unchanged.
- [ ] `packages/integrations` `turbo typecheck test` green (the change is internal to youtube-source; repo-wide typecheck as belt-and-suspenders).

## RED test outline (write cases first)
1. `youtube_pathological_ok_shape_fail_closed` — a transport resolving `ok` with a null/non-string transcript (or a hostile getter that throws on access) ⇒ typed err, NEVER a throw across the seam (the whole-map-under-one-try pin — currently FAILS: the map is outside the try).
2. `youtube_empty_transcript_adapter_guard` — a transport resolving `ok` with an empty/whitespace transcript (not `no_transcript`) ⇒ fail-closed typed err, no candidate (currently FAILS: no adapter-level guard).
3. `youtube_no_transcript_code_still_fail_closed` — the existing `no_transcript` transport-code path still ⇒ typed err (regression: don't break the existing path).
4. `youtube_happy_path_unchanged` — a valid transcript ⇒ the same candidate + passes the REAL `registerSource()` gate (regression: no happy-path change).

## Cross-doc invariant impact
- **NONE.** Internal hardening of an existing adapter — no contract/schema/snapshot/Appendix-A change; `SourceEnvelope`/`registerSource` untouched. Additive guard + a widened try + tests.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Reuse youtube's existing error code vs. add `empty_content`.** Default vote: reuse youtube's existing empty/typed error code if it has one; else add `empty_content` to youtube's error union (mirror web/podcast's `unreachable|empty_content|unknown`). Confirm at Step 0 by reading youtube's current error union.
2. **Preserve the `no_transcript` transport-code path.** Default vote: KEEP it (both the transport-signalled `no_transcript` AND the new adapter-level empty guard fail-closed — defense-in-depth, no regression). Confirm.
3. **Exact try boundary.** Default vote: wrap from the first post-transport property access through the candidate build (everything that touches the untrusted `result.*`), mirroring web/podcast exactly. Confirm.

## Wiring / entry point (Step 7.5)
- **Entry point:** unchanged — `extractYouTubeSource` is the emit-only adapter; the real transport is the dormant injection point. Reachability judgment-waived (dormant prototype; proven via the REAL `registerSource()` gate in tests). No new entry point.
- **Blocks:** nothing. **Depends on:** the shipped youtube-source + Lesson 11 (present).

## Estimated commit count
**1.** The `youtube-source.ts` try-widening + empty-guard + regression tests. Untrusted-content §-hardening of shipped code (rules 1/2/6) ⇒ **Step-8 review MANDATORY** — a focused review (the fix mirrors the already-CLEARED web/podcast pattern): confirm the whole map is under one try, the empty guard fails closed, no happy-path regression, no real I/O.

## Lessons-logged candidates (implementer flags Step 9)
- NONE new — this closes the sibling gap under **Lesson 11**. Cite it.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `youtube-source.ts` (find the post-transport map currently OUTSIDE the try + the error union) + the `web-source.ts`/`podcast-source.ts` fix pattern + Lesson 11.
2. Step 2.5 — ping Q1–Q3 (the error-code reuse + the try boundary) BEFORE writing cases.
3. RED first (the pathological-ok-shape + empty-transcript-guard tests FAIL against current youtube-source — that's the point; the happy-path + `no_transcript` regressions must stay green).
4. **Step 8 — MANDATORY (focused) adversarial review:** the whole post-transport map is under one try (no throw across the seam on any pathological transport shape); the adapter-level empty guard fails closed; the `no_transcript` path + the happy path are unregressed; emit-only + gate-valid unchanged; NO real I/O.
5. Step 9 — categorized flags (the file/PDF extractor next + the sibling-wide NIT sweep) + ship-ask.
