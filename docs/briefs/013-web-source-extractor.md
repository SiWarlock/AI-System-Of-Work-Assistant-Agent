# /tdd brief — web_source_extractor (task 13.2 — emit-only web-article source extractor over a FAKED fetch transport; dormant, candidate-data-only)

## Feature
Add the **web-article source extractor** — the next Phase-13 OSB emit-only source adapter after the shipped `youtube-source` (G1). `extractWebSource(input, transport)` takes a FAKED `WebFetchTransport` result (url/title/byline?/publishedAt?/text — what a real readability extraction yields), deterministically maps it to a `RegisterSourceInput` **candidate** (`type: "web_article"`), and emits it through the REAL `registerSource()` candidate-data gate. It **never writes** — candidate data only (flows candidate-gate → `KnowledgeMutationPlan` → `KnowledgeWriter` → Approval Inbox strictly downstream). Ships **DORMANT**: the real WebFetch transport is the injected "REAL-EXTRACTOR INJECTION POINT" (out of scope — no network/vendor I/O); tests use a pure fake transport over fixtures. Directly mirrors `youtube-source.ts`.

## Use case + traceability
- **Task ID:** 13.2 source extractor adapters (emit-only) — the web-article extractor (YouTube already full parse-logic; web is the best-sequenced next). Phase-13 OSB inheritance.
- **Architecture sections it implements:** `ARCHITECTURE.md §8` (SourceIngestionPort / Connector Gateway — the `registerSource` candidate-admission the adapter emits through) + `§6` (candidate-data gate — the ajv+Zod+dedupe admission). Safety rules: **1 (one writer — emit-only, the adapter NEVER writes Markdown)**, **2 (candidate-data gate — output is candidate data until it passes `registerSource`)**, **6 (ING-7 — the adapter consumes UNTRUSTED web content and is read-only/emit-only, no mutating path)**, and the no-inference rule (never invent workspace/owner/sensitivity — pass through / emit TBD). Implementer confirms the §8/§6 anchor at Step 0.
- **The proven MIRROR (research-mapped):** `youtube-source.ts` (`packages/integrations/src/connectors/adapters/youtube-source.ts`) — `extractYouTubeSource(input, transport): Result<RegisterSourceInput, {code,message}>` (`:78`); the FAKED transport seam `YouTubeExtractTransport` (`:51`); parse steps (`:85-124`): transport call in try/catch → typed `unknown` err (`:85-89`), map `!ok` transport code → typed err (`:91-93`), `contentHash = payloadHash({videoId, transcript})` → `sha256:` key (`:100`), `routingHints` from metadata only / no inference (`:104-109`), build candidate `type:"youtube_video"` with `workspaceId`/`sensitivity`/`sourceId` passed through from policy input (`:114-124`).
- **The emit target + gate (unchanged, emit toward):** `RegisterSourceInput` (`packages/integrations/src/connectors/source-register.ts:31`); `registerSource(input, deps)` (`source-register.ts:78`) — (1) ajv `SOURCE_ENVELOPE_SCHEMA_ID` (`:88`), (2) Zod `.strict()` `SourceEnvelopeSchema` (`:94`), (3) Flow-4 dedupe via injected `seenContentHash` (`:102`); outcome union `registered{envelope}|dedupe_hit|rejected` (`:62`).
- **The read-transport reference:** the `url-source.ts` connector already models the `http:get` read transport (a shape reference for the faked `WebFetchTransport`; do NOT wire real I/O).

## Scope boundary (IN vs deferred)
- **IN (this slice):** NEW `packages/integrations/src/connectors/adapters/web-source.ts` — `extractWebSource(input: ExtractWebInput, transport: WebFetchTransport): Promise<Result<RegisterSourceInput, WebExtractError>>` (mirror youtube-source): a bespoke `WebFetchTransport` faked seam + `WebFetchResult` shape + a typed `WebExtractError` union; deterministic field-map → candidate `type:"web_article"`; `contentHash = payloadHash({url, text})` (dedupe-stable); no-inference; fail-closed; emit-only. Fixtures + tests mirroring `youtube-source.test.ts`.
- **DEFERRED (named follow-ups — record, don't build):** (1) the REAL WebFetch transport (the injected prod-wiring — real network I/O, DORMANT/out-of-scope). (2) downstream summarization (ModelProviderPort + egress veto — not in the adapter). (3) the podcast + file/PDF extractors (the next slices in this arc). (4) the 13.1 anti-corruption grep-guard/boundary test + `config/osb.pin` (governance boundary — a parallel slice; does not block extractors).

## Acceptance criteria (what "done" means)
- [ ] NEW `extractWebSource(input, transport)` in `adapters/web-source.ts` returns a typed `Result<RegisterSourceInput, WebExtractError>`; NEVER throws (transport throw ⇒ caught → typed err — the never-throw convention). Bespoke `WebFetchTransport = (req: { url: string }) => Promise<WebFetchResult>` (or a `Result`-returning variant mirroring youtube's) + `WebFetchResult = { url; title; byline?; publishedAt?; text }`.
- [ ] **Deterministic candidate map:** emits `RegisterSourceInput` with `type: "web_article"` (open `SourceEnvelope.type` — NO frozen-contract change), `contentHash = payloadHash({ url, text })` → `sha256:<64-hex>` key, `routingHints` derived from metadata ONLY (title/byline/publishedAt — no inference), and `workspaceId`/`sensitivity`/`sourceId` passed through from the policy input (never invented — no-inference rule).
- [ ] **Emit-only (safety rule 1):** the adapter emits `RegisterSourceInput` and NEVER calls KnowledgeWriter / never writes Markdown. Proven by passing the emitted input through the REAL `registerSource()` (governance-proof) → `registered{envelope}`.
- [ ] **Fail-closed (safety rules 2/6):** a transport fault (`!ok` / thrown) ⇒ typed `WebExtractError` (never a partial/invented candidate); an EMPTY body (no text) ⇒ fail-closed typed err (mirror youtube's empty-content rejection) — never emit a contentless candidate.
- [ ] **Dedupe-stable:** the same `{url, text}` ⇒ the same `contentHash` ⇒ `registerSource` returns `dedupe_hit` on the second emit (Flow-4).
- [ ] **Purity:** `extractWebSource` does not mutate its input (frozen-input test) and does no clock/network of its own (the transport is the only seam).
- [ ] `packages/integrations` `turbo typecheck test` green (this is additive integrations adapter code + fixtures; `SourceEnvelope`/`registerSource` unchanged — no cross-package contract change, but run repo-wide typecheck as belt-and-suspenders).

## RED test outline (write cases first)
1. `emits_web_article_candidate` — a fake transport returning a fixture web page ⇒ `extractWebSource` emits a `RegisterSourceInput` with `type:"web_article"` + the mapped fields; `contentHash` matches `/^sha256:[0-9a-f]{64}$/`.
2. `no_inference` — workspace/sensitivity are passed through from the input (not invented); routingHints derive from metadata only (title/byline), never fabricated.
3. `governance_proof_registers` — the emitted input passed through the REAL `registerSource()` ⇒ `registered{envelope}` (proves emit-only + gate-valid).
4. `dedupe_hit_on_same_content` — the same `{url,text}` emitted twice through `registerSource` ⇒ second is `dedupe_hit` (contentHash-stable).
5. `transport_fault_fail_closed` — the transport returns `!ok` / throws ⇒ a typed `WebExtractError`, no candidate, no throw (never-throw convention).
6. `empty_body_fail_closed` — a transport result with empty text ⇒ fail-closed typed err (no contentless candidate).
7. `purity_frozen_input` — a frozen input is not mutated; no clock/network used.

## Cross-doc invariant impact
- **NONE.** `SourceEnvelope.type` is an OPEN `z.string().min(1)` (`packages/contracts/src/models/source-envelope.ts`), so `"web_article"` needs NO schema/snapshot/Appendix-A/ajv-registry/cross-doc-table edit (§13.2 confirms). `SourceEnvelope`/`RegisterSourceInput`/`registerSource` are emitted-toward, unchanged. Purely additive `packages/integrations` adapter + fixtures (like the youtube/capture prototypes). NOT a frozen-contract round.

## Things to flag at Step 2.5 (design questions — default votes)
1. **`WebFetchResult` field set (the faked seam shape).** Default vote: `{ url; title; byline?; publishedAt?; text }` — matches a readability/extraction yield (what a real WebFetch would return); `text` is the required body, the rest are metadata for routingHints. Confirm (mirror the shape a real extractor gives; don't over-model).
2. **`contentHash` inputs.** Default vote: `payloadHash({ url, text })` — url + body, dedupe-stable (mirrors youtube's `{videoId, transcript}`). NOT the metadata (title/byline can change without the article changing). Confirm.
3. **Transport signature: `Result`-returning vs. throwing.** Default vote: mirror youtube-source's exact transport contract (whatever it is — `Result`-returning per the research) so the two adapters are consistent; handle BOTH a `!ok`/`err` AND a thrown exception → typed err (never-throw convention). Confirm at Step 0 by reading youtube-source's transport.
4. **`type` token = `"web_article"`.** Default vote: `"web_article"` (snake_case, consistent with `"youtube_video"`). Confirm.

## Wiring / entry point (Step 7.5)
- **Entry point:** `extractWebSource` is an emit-only adapter; its production caller is the (dormant) source-ingestion wiring + the REAL WebFetch transport injection point (out of scope — no real I/O). Reachability is **judgment-waived** for this slice exactly like `youtube-source` (the prototype pattern): the adapter is proven reachable by emitting through the REAL `registerSource()` gate in tests; the real-transport prod-wiring is the named dormant deferral. Name the injection point at Step 7.5 (the "REAL-EXTRACTOR INJECTION POINT" convention).
- **Blocks:** nothing (the podcast/file extractors are siblings, not dependents). **Depends on:** `registerSource` + `RegisterSourceInput` + `payloadHash` + the `SourceEnvelope` contract (all present).

## Estimated commit count
**1.** The `web-source.ts` adapter + fixtures + tests (all `packages/integrations`; emits toward the unchanged gate). Untrusted-content ingest surface (safety rules 1/2/6) ⇒ Step-8 review MANDATORY (focused: emit-only / never-writes; no-inference; fail-closed on fault/empty; the candidate passes the REAL gate).

## Lessons-logged candidates (implementer flags Step 9)
- Possible (implementer's call): "an OSB source extractor is an EMIT-ONLY adapter over a FAKED transport — deterministic field-map → `RegisterSourceInput` candidate (`contentHash` over the dedupe-stable content, routingHints from metadata only / no-inference), fail-closed on transport-fault/empty, proven by passing the REAL `registerSource()` gate; the real transport is a dormant injection point (no network in the adapter or its tests)." May fold into a Phase-13 extractor lesson as the arc grows.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `youtube-source.ts` + `youtube-source.test.ts` (the exact mirror) + `source-register.ts` (`registerSource`/`RegisterSourceInput`) + confirm `SourceEnvelope.type` is open + the youtube transport's exact `Result`-vs-throw contract.
2. Step 2.5 — ping Q1–Q4 (defaults above; Q1 the seam shape + Q2 the contentHash inputs are the load-bearing ones) BEFORE writing cases.
3. RED first (emit-only/governance-proof + no-inference + fail-closed-on-fault/empty + dedupe-stable are load-bearing).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): the adapter NEVER writes (emit-only, safety rule 1); no-inference (workspace/sensitivity/routingHints never invented); fail-closed on transport-fault AND empty-body (no contentless/partial candidate); the emitted candidate passes the REAL `registerSource()` gate; never-throws (typed Result); NO real network/vendor I/O in the adapter or its tests.
5. Step 9 — categorized flags (the deferred real-transport injection + the podcast/file siblings + the 13.1 ACL grep-guard) + ship-ask.
