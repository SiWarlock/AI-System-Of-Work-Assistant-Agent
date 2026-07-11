# /tdd brief — podcast_source_extractor (task 13.2 — emit-only podcast source extractor over a FAKED transport; dormant, candidate-data-only)

## Feature
Add the **podcast source extractor** — the next Phase-13 OSB emit-only source adapter after `youtube-source` (G1) + `web-source` (13.2-web). `extractPodcastSource(input, transport)` takes a FAKED `PodcastExtractTransport` result (episode guid/id + transcript + RSS/audio metadata), deterministically maps it to a `RegisterSourceInput` **candidate** (`type: "podcast"`), and emits it through the REAL `registerSource()` candidate-data gate. **Emit-only** — candidate data only, never writes. Ships **DORMANT**: the real transport (RSS fetch + audio transcription) is the injected "REAL-EXTRACTOR INJECTION POINT" (out of scope — no network/vendor I/O); tests use a pure fake transport over fixtures. Mirrors `web-source.ts`, applying the **Lesson 11** extractor discipline (emit-only + TOTAL never-throws over the untrusted transport).

## Use case + traceability
- **Task ID:** 13.2 source extractor adapters (emit-only) — the podcast extractor (YouTube + web done; podcast is the next in the arc). Phase-13 OSB inheritance.
- **Architecture sections it implements:** `ARCHITECTURE.md §8` (SourceIngestionPort / Connector Gateway — the `registerSource` candidate-admission) + `§6` (candidate-data gate). Safety rules: **1 (one writer — emit-only, NEVER writes)**, **2 (candidate-data gate)**, **6 (ING-7 — consumes UNTRUSTED podcast content, read-only/emit-only)**, and the no-inference rule. Implementer confirms the §8/§6 anchor at Step 0.
- **The proven MIRROR (just shipped):** `web-source.ts` (`extractWebSource`, `e05285a`) + `youtube-source.ts` (G1) — the exact adapter pattern: faked `Result`-returning transport → try-wrapped WHOLE map → `payloadHash` contentHash → routingHints from metadata only → candidate with scope passthrough. And **Lesson 11** (the extractor discipline: emit-only, TOTAL never-throws, the untrusted transport can throw OR resolve `ok` with a pathological shape).
- **The emit target + gate (unchanged, emit toward):** `RegisterSourceInput` (`packages/integrations/src/connectors/source-register.ts:31`); `registerSource(input, deps)` (`:78`) — ajv `SOURCE_ENVELOPE_SCHEMA_ID` + Zod `.strict()` `SourceEnvelopeSchema` + Flow-4 dedupe; outcome `registered{envelope}|dedupe_hit|rejected`.

## Scope boundary (IN vs deferred)
- **IN (this slice):** NEW `packages/integrations/src/connectors/adapters/podcast-source.ts` — `extractPodcastSource(input, transport: PodcastExtractTransport): Promise<Result<RegisterSourceInput, PodcastExtractError>>` (mirror web-source): a bespoke `PodcastExtractTransport` faked seam + `PodcastEpisode` shape + a typed `PodcastExtractError` union; deterministic field-map → candidate `type:"podcast"`; `contentHash = payloadHash({ episodeId, transcript })` (dedupe-stable); no-inference; fail-closed; emit-only; TOTAL never-throws (whole map under one try). Fixtures + tests mirroring `web-source.test.ts`.
- **DEFERRED (named follow-ups — record, don't build):** (1) the REAL podcast transport (RSS fetch + audio transcription — real network/vendor I/O, DORMANT/out-of-scope). (2) downstream summarization (ModelProviderPort + egress veto). (3) the file/PDF extractor (the next arc slice). (4) the youtube-source never-throw try-widening (its own carry-forward follow-up). (5) the 13.1 anti-corruption grep-guard.

## Acceptance criteria (what "done" means)
- [ ] NEW `extractPodcastSource(input, transport)` in `adapters/podcast-source.ts` returns a typed `Result<RegisterSourceInput, PodcastExtractError>`; **TOTAL never-throws** — the WHOLE post-transport mapping runs under ONE try (Lesson 11: a transport that throws OR resolves `ok` with a pathological/non-string transcript ⇒ typed err, never a throw across the seam). Bespoke `PodcastExtractTransport = (req: { feedUrl?: string; episodeId: string }) => Promise<PodcastExtractResult>` (Result-returning, mirror web-source) + `PodcastEpisode = { episodeId; title; showTitle?; publishedAt?; audioUrl?; transcript }`.
- [ ] **Deterministic candidate map:** emits `RegisterSourceInput` with `type: "podcast"` (open `SourceEnvelope.type` — NO frozen-contract change), `contentHash = payloadHash({ episodeId, transcript })` → `sha256:<64-hex>` key, `routingHints` from metadata ONLY (title/showTitle/publishedAt — no inference), and `workspaceId`/`sensitivity`/`sourceId` passed through from the policy input (never invented).
- [ ] **Emit-only (safety rule 1):** emits `RegisterSourceInput`, NEVER calls KnowledgeWriter. Proven by passing the emitted input through the REAL `registerSource()` → `registered{envelope}`.
- [ ] **Fail-closed (rules 2/6):** a transport fault (`!ok`/thrown) ⇒ typed `PodcastExtractError`; an EMPTY/whitespace/malformed transcript ⇒ fail-closed typed err (`empty_content` — the adapter-level check, since a podcast needs its transcript to have content; audio-only-not-yet-transcribed is a downstream concern) — never a contentless candidate.
- [ ] **Dedupe-stable:** the same `{episodeId, transcript}` ⇒ the same `contentHash` ⇒ `registerSource` returns `dedupe_hit` on the second emit.
- [ ] **Purity:** `extractPodcastSource` does not mutate its input (frozen-input test) and does no clock/network of its own.
- [ ] `packages/integrations` `turbo typecheck test` green (additive adapter + fixtures; `SourceEnvelope`/`registerSource` unchanged — repo-wide typecheck as belt-and-suspenders).

## RED test outline (write cases first)
1. `emits_podcast_candidate` — a fake transport returning a fixture episode ⇒ emits `RegisterSourceInput` `type:"podcast"` + mapped fields; `contentHash` matches `/^sha256:[0-9a-f]{64}$/`.
2. `no_inference` — workspace/sensitivity passthrough (not invented); routingHints from metadata only; absent showTitle/publishedAt OMITTED not fabricated.
3. `governance_proof_registers` — emitted input → REAL `registerSource()` ⇒ `registered{envelope}` (emit-only + gate-valid).
4. `dedupe_hit_on_same_episode` — same `{episodeId, transcript}` twice ⇒ second is `dedupe_hit`.
5. `transport_fault_fail_closed` — transport `!ok` / throws ⇒ typed `PodcastExtractError`, no candidate, no throw.
6. `empty_or_malformed_transcript_fail_closed` — empty/whitespace/non-string transcript (the untrusted transport resolving `ok` with a pathological shape — Lesson 11) ⇒ fail-closed typed err, never a throw, no candidate.
7. `purity_frozen_input` — frozen input not mutated; no clock/network.

## Cross-doc invariant impact
- **NONE.** `SourceEnvelope.type` is OPEN, so `"podcast"` needs NO schema/snapshot/Appendix-A/registry/cross-doc-table edit. `SourceEnvelope`/`RegisterSourceInput`/`registerSource` emitted-toward, unchanged. Purely additive `packages/integrations` adapter + fixtures (like youtube/web/capture). NOT a frozen-contract round.

## Things to flag at Step 2.5 (design questions — default votes)
1. **`PodcastEpisode` field set (the faked seam shape).** Default vote: `{ episodeId; title; showTitle?; publishedAt?; audioUrl?; transcript }` — `episodeId` (stable guid) + `transcript` (the required content), the rest metadata for routingHints. Confirm (don't over-model; `audioUrl` is metadata, not fetched here).
2. **`contentHash` inputs.** Default vote: `payloadHash({ episodeId, transcript })` — the stable episode identity + the content (mirrors youtube's `{videoId, transcript}` / web's `{url, text}`). NOT the volatile metadata. Confirm.
3. **Transcript-required (empty ⇒ fail-closed).** Default vote: the extractor REQUIRES a non-empty transcript in the faked payload (audio-only-not-yet-transcribed ⇒ `empty_content` fail-closed; transcription is the downstream ModelProviderPort concern, not this adapter). Confirm.
4. **`type` token = `"podcast"`.** Confirm (snake-case-consistent).

## Wiring / entry point (Step 7.5)
- **Entry point:** `extractPodcastSource` is an emit-only adapter; its production caller is the (dormant) source-ingestion wiring + the REAL podcast transport injection point (out of scope — no real I/O). Reachability **judgment-waived** exactly like youtube/web-source: proven reachable by emitting through the REAL `registerSource()` gate in tests; the real-transport prod-wiring is the named dormant deferral ("REAL-EXTRACTOR INJECTION POINT").
- **Blocks:** nothing (file/PDF is a sibling). **Depends on:** `registerSource` + `RegisterSourceInput` + `payloadHash` + `SourceEnvelope` (all present).

## Estimated commit count
**1.** The `podcast-source.ts` adapter + fixtures + tests. Untrusted-content ingest surface (rules 1/2/6) ⇒ **Step-8 review MANDATORY** (emit-only/never-writes; no-inference; fail-closed on fault/empty/malformed; TOTAL never-throws per Lesson 11; the candidate passes the REAL gate; NO real I/O).

## Lessons-logged candidates (implementer flags Step 9)
- Likely NONE new — this is a direct application of **Lesson 11** (the OSB extractor discipline). If the podcast surfaces a genuinely new wrinkle, flag it; otherwise cite Lesson 11.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `web-source.ts` + `web-source.test.ts` (the exact just-shipped mirror) + `source-register.ts` + **Lesson 11** (the extractor discipline: TOTAL never-throws, whole map under one try) + confirm `SourceEnvelope.type` is open.
2. Step 2.5 — ping Q1–Q4 (defaults above; Q1 seam shape + Q2 contentHash inputs + Q3 transcript-required are load-bearing) BEFORE writing cases.
3. RED first (emit-only/governance-proof + no-inference + fail-closed-on-fault/empty/malformed + TOTAL-never-throws + dedupe-stable are load-bearing).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): emit-only/never-writes (rule 1); no-inference (nothing fabricated from the transcript into routingHints/scope); fail-closed on transport-fault AND empty/malformed transcript; TOTAL never-throws (whole map under one try — untrusted transport can resolve `ok` with a pathological shape, Lesson 11); the candidate passes the REAL `registerSource()` gate; NO real network/vendor I/O in the adapter or its tests.
5. Step 9 — categorized flags (the deferred real-transport + downstream transcription/summarization + the file/PDF sibling + the youtube-source never-throw follow-up) + ship-ask.
