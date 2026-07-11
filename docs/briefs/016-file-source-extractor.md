# /tdd brief — file_source_extractor (task 13.2 — emit-only file/PDF source extractor over a FAKED transport; dormant, candidate-data-only)

## Feature
Add the **file/PDF source extractor** — the LAST Phase-13 OSB emit-only source adapter (after youtube + web + podcast). `extractFileSource(input, transport)` takes a FAKED `FileExtractTransport` result (path + extracted text + mime/filename metadata), deterministically maps it to a `RegisterSourceInput` **candidate** (`type: "file"`), and emits it through the REAL `registerSource()` candidate-data gate. **Emit-only** — candidate data only, never writes. Ships **DORMANT**: the real transport (file read + PDF/doc text-extraction) is the injected "REAL-EXTRACTOR INJECTION POINT" (out of scope — no fs/vendor I/O); tests use a pure fake transport over fixtures. Mirrors `web-source.ts`/`podcast-source.ts`, applying **Lesson 11** (emit-only + TOTAL never-throws over the untrusted transport). Completes the 13.2 extractor set (YouTube/podcast/web/file).

## Use case + traceability
- **Task ID:** 13.2 source extractor adapters (emit-only) — the file/PDF extractor (the last of the four). Phase-13 OSB inheritance.
- **Architecture sections it implements:** `ARCHITECTURE.md §8` (SourceIngestionPort / Connector Gateway — the `registerSource` candidate-admission) + `§6` (candidate-data gate). Safety rules: **1 (emit-only, never writes)**, **2 (candidate-data gate)**, **6 (ING-7 — consumes UNTRUSTED file content, read-only/emit-only)**, and the no-inference rule. Implementer confirms the §8/§6 anchor at Step 0.
- **The proven MIRROR (just shipped):** `web-source.ts` (`extractWebSource`) + `podcast-source.ts` (`extractPodcastSource`) — the exact adapter pattern (faked `Result`-returning transport → WHOLE map under ONE try → `payloadHash` contentHash → routingHints from metadata only → candidate with scope passthrough), codified as **Lesson 11**.
- **The emit target + gate (unchanged, emit toward):** `RegisterSourceInput` (`packages/integrations/src/connectors/source-register.ts:31`); `registerSource(input, deps)` (`:78`) — ajv + Zod `.strict()` `SourceEnvelopeSchema` + Flow-4 dedupe.

## Scope boundary (IN vs deferred)
- **IN (this slice):** NEW `packages/integrations/src/connectors/adapters/file-source.ts` — `extractFileSource(input: ExtractFileInput, transport: FileExtractTransport): Promise<Result<RegisterSourceInput, FileExtractError>>` (mirror web/podcast): a bespoke `FileExtractTransport` faked seam + `ExtractedFile` shape + a typed `FileExtractError` union; deterministic field-map → candidate `type:"file"`; `contentHash = payloadHash({ path, text })` (dedupe-stable); no-inference; fail-closed; emit-only; TOTAL never-throws (whole map under one try). Fixtures + tests mirroring `web-source.test.ts`.
- **DEFERRED (named follow-ups — record, don't build):** (1) the REAL file transport (fs read + PDF/doc text-extraction — real fs/vendor I/O, DORMANT/out-of-scope). (2) downstream summarization (ModelProviderPort + egress veto). (3) the 3 inherited sibling-wide NITs (a separate LOW sweep across all 4 adapters). (4) the 13.1 anti-corruption grep-guard + `config/osb.pin`.

## Acceptance criteria (what "done" means)
- [ ] NEW `extractFileSource(input, transport)` in `adapters/file-source.ts` returns a typed `Result<RegisterSourceInput, FileExtractError>`; **TOTAL never-throws** — the WHOLE post-transport map runs under ONE try (Lesson 11: a transport that throws OR resolves `ok` with a pathological/non-string text ⇒ typed err, never a throw). Bespoke `FileExtractTransport = (req: { path: string; mime?: string }) => Promise<FileExtractResult>` (Result-returning) + `ExtractedFile = { path; filename?; mime?; text }`.
- [ ] **Deterministic candidate map:** emits `RegisterSourceInput` with `type: "file"` (open `SourceEnvelope.type` — NO frozen-contract change), `origin = path` (the guaranteed file locator; `filename`/`mime` are optional metadata), `contentHash = payloadHash({ path, text })` → `sha256:<64-hex>`, `routingHints` from metadata ONLY (filename/mime — no inference), and `workspaceId`/`sensitivity`/`sourceId` passed through (never invented).
- [ ] **Emit-only (safety rule 1):** emits `RegisterSourceInput`, NEVER calls KnowledgeWriter. Proven by passing the emitted input through the REAL `registerSource()` → `registered{envelope}`.
- [ ] **Fail-closed (rules 2/6):** a transport fault (`!ok`/thrown) ⇒ typed `FileExtractError`; an EMPTY/whitespace/non-string extracted text ⇒ fail-closed typed err (`empty_content`) — never a contentless candidate.
- [ ] **Dedupe-stable:** the same `{path, text}` ⇒ the same `contentHash` ⇒ `registerSource` returns `dedupe_hit` on the second emit; `path` in the hash so the same text at a different path is a DISTINCT source (no false dedupe).
- [ ] **Purity:** `extractFileSource` does not mutate its input (frozen-input test) and does no clock/fs of its own.
- [ ] `packages/integrations` `turbo typecheck test` green (additive adapter + fixtures; `SourceEnvelope`/`registerSource` unchanged — repo-wide typecheck as belt-and-suspenders).

## RED test outline (write cases first)
1. `emits_file_candidate` — a fake transport returning a fixture file ⇒ emits `RegisterSourceInput` `type:"file"`, `origin=path`, mapped fields; `contentHash` matches `/^sha256:[0-9a-f]{64}$/`.
2. `no_inference` — workspace/sensitivity passthrough (not invented); routingHints from metadata only (filename/mime); absent filename/mime OMITTED not fabricated.
3. `governance_proof_registers` — emitted input → REAL `registerSource()` ⇒ `registered{envelope}` (emit-only + gate-valid).
4. `dedupe_hit_on_same_file` — same `{path, text}` twice ⇒ second is `dedupe_hit`.
5. `contenthash_includes_path` — same text + DIFFERENT path ⇒ different hash (no false dedupe across distinct files).
6. `transport_fault_fail_closed` — transport `!ok` / throws ⇒ typed `FileExtractError`, no candidate, no throw.
7. `empty_or_malformed_text_fail_closed` — empty/whitespace/null/non-string text (untrusted transport resolving `ok` with a pathological shape — Lesson 11) ⇒ fail-closed `empty_content`, never a throw.
8. `purity_frozen_input` — frozen input not mutated; no clock/fs.

## Cross-doc invariant impact
- **NONE.** `SourceEnvelope.type` is OPEN, so `"file"` needs NO schema/snapshot/Appendix-A/registry/cross-doc-table edit. `SourceEnvelope`/`RegisterSourceInput`/`registerSource` emitted-toward, unchanged. Purely additive `packages/integrations` adapter + fixtures. NOT a frozen-contract round.

## Things to flag at Step 2.5 (design questions — default votes)
1. **`ExtractedFile` field set (the faked seam shape).** Default vote: `{ path; filename?; mime?; text }` — `path` (the guaranteed locator) + `text` (the extracted content), `filename`/`mime` optional metadata. Confirm (don't over-model; the raw file bytes / PDF parsing are the dormant real-transport concern).
2. **`origin = path`, `contentHash = payloadHash({path, text})`.** Default vote: `origin = path` (the guaranteed file locator — mirrors web's `url`, podcast's `episodeId`); `contentHash` over `{path, text}` (locator+content, `path` in the hash so same-text-different-path is distinct). Confirm.
3. **Text-required (empty ⇒ fail-closed).** Default vote: the extractor REQUIRES non-empty extracted text (an unextractable/empty file ⇒ `empty_content` fail-closed; PDF/doc parsing is the downstream real-transport concern). Confirm.
4. **`type` token = `"file"`.** Confirm (snake/lower-consistent).

## Wiring / entry point (Step 7.5)
- **Entry point:** `extractFileSource` is an emit-only adapter; its production caller is the (dormant) source-ingestion wiring + the REAL file transport injection point (out of scope — no fs I/O). Reachability **judgment-waived** exactly like youtube/web/podcast: proven reachable by emitting through the REAL `registerSource()` gate in tests; the real-transport prod-wiring is the named dormant deferral ("REAL-EXTRACTOR INJECTION POINT").
- **Blocks:** nothing (completes the extractor set). **Depends on:** `registerSource` + `RegisterSourceInput` + `payloadHash` + `SourceEnvelope` (all present).

## Estimated commit count
**1.** The `file-source.ts` adapter + fixtures + tests. Untrusted-content ingest surface (rules 1/2/6) ⇒ **Step-8 review MANDATORY** (emit-only/never-writes; no-inference; fail-closed on fault/empty/malformed; TOTAL never-throws per Lesson 11; the candidate passes the REAL gate; NO real fs/vendor I/O).

## Lessons-logged candidates (implementer flags Step 9)
- Likely NONE new — a direct application of **Lesson 11**. This slice COMPLETES the 13.2 extractor set (YouTube/podcast/web/file) — worth a one-line Step-9 note that the four emit-only extractors are all done + Lesson-11-consistent. Cite Lesson 11.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `web-source.ts`/`podcast-source.ts` (the mirror) + `source-register.ts` + Lesson 11 + confirm `SourceEnvelope.type` is open + `SourceEnvelope.origin` is required `min(1)` (⇒ `origin=path`).
2. Step 2.5 — ping Q1–Q4 (defaults above; Q1 seam shape + Q2 origin/contentHash + Q3 text-required are load-bearing) BEFORE writing cases.
3. RED first (emit-only/governance-proof + no-inference + fail-closed-on-fault/empty/malformed + TOTAL-never-throws + dedupe-stable + contenthash-includes-path are load-bearing).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): emit-only/never-writes; no-inference (nothing fabricated from the file text into routingHints/scope); fail-closed on transport-fault AND empty/malformed text; TOTAL never-throws (whole map under one try — Lesson 11); the candidate passes the REAL `registerSource()` gate; NO real fs/vendor I/O in the adapter or its tests.
5. Step 9 — categorized flags (the deferred real-transport + the 4-extractor-set completion + the sibling-wide NIT sweep + the 13.1 ACL guard) + ship-ask.
