# RESUME HANDOFF — P3-live (wire real GBrain retrieval into the worker)

> **PROSPECTIVE handoff** for the next session (post-compaction). Predecessor: `031-2026-07-05-real-copilot-flag-flip-gbrain-eval.md`. **Successor: `033-2026-07-05-p3-live-gbrain-subprocess-retrieval.md` (P3-live BUILT — subprocess transport wired behind a flag; PGlite single-connection finding).**
> Everything CODE is DONE + pushed to `origin/main` at **HEAD `9cc0ee1`**. The gbrain SETUP was fixed + seeded this session (outside git). NEXT = **P3-live**: wire real gbrain retrieval into the worker. Read the memory `sow-copilot-real-model-direction` first.

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work BUILD — P3-LIVE: wire REAL GBrain retrieval into the worker's Copilot.
Everything before it is DONE + pushed (origin/main HEAD 9cc0ee1): real Copilot cloud path P2.1–P2.5
COMPLETE (Sonnet 5 + 1M context, flag flipped LIVE, egress notice, grounding eval — the P2.5 real
tier passed 14/14 against live Sonnet), P3.1 (the deterministic GBrain retrieval adapter
createGbrainCopilotRetrieval + parseGbrainSearchResult, TDD'd, reviewed), and a full gbrain SETUP FIX
this session (outside git): env var typo VOYAGER_API_KEY→VOYAGE_API_KEY, and the brain re-inited for
Voyage (voyage-code-3 @ 1024 dims — it was silently defaulting to OpenAI 1536). The gbrain is SEEDED:
the SoW docs/ folder imported = 98 pages / 554 chunks, all embedded via Voyage. BOTH halves of P3 are
PROVEN: retrieval (`gbrain call query` returns the right SoW session docs, semantically ranked) and
synthesis (P2.5 live eval).

BUILD P3-LIVE — a worker transport that connects them:
1. A read-only gbrain retrieval that shells `gbrain call query '{"query":Q,"limit":N}'` (child_process),
   parses the JSON array of hits, maps each hit → {content: chunk_text, id: slug.replace(/\//g,":"),
   title}, and feeds the ALREADY-BUILT parseGbrainSearchResult (P3.1, apps/worker/src/api/procedures/
   copilotGbrainRetrieval.ts) → RetrievedContext. Inject the exec fn so the deterministic mapping is
   TDD-able with canned gbrain JSON; the real child_process call is integration-tested.
2. Wire it into apps/worker/src/boot.ts behind a config flag (like copilotRealModel), replacing
   createFixtureRetrieval on the real path. The worker needs VOYAGE_API_KEY in its env (gbrain embeds
   the query) — verify it inherits the shell env at launch.
3. FIRST run the staged proof harness to confirm end-to-end before wiring:
   SOW_P3_PROVE=1 pnpm --filter @sow/evals exec vitest run test/copilot-eval/_p3-prove.test.ts
   (gbrain retrieval → real Sonnet 5 answer over the seed; it's uncommitted at packages/evals/test/
   copilot-eval/_p3-prove.test.ts — DELETE it after, it's a temp proof).

gbrain call query JSON shape (per hit): { slug, page_id, title, type, chunk_text, chunk_source,
chunk_id, chunk_index, score, stale, source_id }. content=chunk_text; citationId source=slug (path-like
→ replace "/" with ":" so it passes the UI-safe uiSafeOpaqueRef gate); title=title. Use `gbrain call
query` (raw tool JSON), NOT `gbrain query` (human [score] slug -- text format) or `gbrain search`
(keyword-only, no embeddings).

HONEST CAVEATS (this is a TEST path): (a) subprocess transport, NOT the GbrainReadGrant `transport:"http"`
the architecture mandates — production uses gbrain serve --http MCP; (b) WS-8 NOT enforced — one
`default` brain holds all workspaces' content, so real isolation needs a brain/source per workspace;
(c) governance: gbrain should be a DERIVED index of KnowledgeWriter-written vault Markdown — this seed
(gbrain import docs/) bypasses KnowledgeWriter, so in a governed runtime these are un-provenanced
DB-only facts. All acceptable for a retrieval TEST; flag them in the session doc.

Read FIRST: memory `sow-copilot-real-model-direction` (richest context) + docs/sessions/032 (this) +
031 + apps/worker/src/api/procedures/copilotGbrainRetrieval.ts (the P3.1 adapter to reuse).

Method (standing): TDD deterministic/security slices (failing test first); LLM/model work EVAL-tested.
Commit per slice (explicit git add, never -A; Conventional Commits + Co-Authored-By: Claude Opus 4.8
(1M context) <noreply@anthropic.com>); ultracode; security-reviewer + code-quality-reviewer per
security-touching slice (P3-live is WS-8-touching); repo-wide `pnpm -w turbo run typecheck test` after
any port/contract change. Don't touch the parallel worktree ../SoW-build-evalsec. Push at close-out.
```

---

## Current state — DONE + PUSHED (HEAD `9cc0ee1`)

All real-Copilot code is on origin/main:
- **§9.8 Approvals** (`06e4bbf`), **P1** egress governance + notice (`efba9b7`), **P2.1** route-threading, **P2.2** subscription completion client, **P2.3** (`47d57cb`) synthesis adapter, **P2.4** (`03a144a`) live wiring, **P2.4b** (`185b16d`) Sonnet 5 1M + flag flip, **P3.1** (`72ab50c`) GBrain retrieval adapter (deterministic), **P2.5** (`9c84074`) grounding eval, **P2.5b** (`9cc0ee1`) grader/corpus fixes from the live run.
- Session docs: 027–031. Round close-outs pushed. Repo-wide gate 31/31.
- **Real path P2 (P2.1–P2.5) is COMPLETE.** The P2.5 REAL tier passed 14/14 against live Claude Sonnet 5 (the 2 initial fails were grader/corpus bugs I fixed, not the model).

## The gbrain SETUP FIX (this session, OUTSIDE git — the machine, not the repo)

The brain was misconfigured; fixed end-to-end:
- **Env var typo:** `~/.zshenv` had `VOYAGER_API_KEY`; renamed to `VOYAGE_API_KEY` (+ added `GBRAIN_EMBEDDING_MODEL="voyage:voyage-code-3"`; redundant now that the config persists it, harmless). Backup: `~/.zshenv.bak-sow`.
- **Embedding provider/dimension:** gbrain silently defaulted to `openai:text-embedding-3-large` @ **1536 dims**; no Voyage model does 1536, so every embed failed. Fixed by re-initing the (empty) brain: `gbrain init --pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024` (the flags `/setup-gbrain` uses — it's set at init, not a config key). Doctor now: `voyage:voyage-code-3 ✓ 1024 dims, DB aligned`. Backups: `~/.gbrain/brain.pglite.sow-bak-*`, `~/.gbrain/config.json.sow-bak-*`.
- **Seeded:** `gbrain import ~/…/SoW-build/docs` → **98 pages / 554 chunks, all embedded via Voyage** (needed 2 runs; the first hit Voyage rate limits — the owner raised the TPM/rate limits, the re-run finished 0 errors).

## Both halves of P3 — PROVEN

- **Retrieval:** `gbrain call query '{"query":"Copilot egress notice"}'` → sessions/029, 030, 031 with scores 0.88/0.80/0.76. Semantic search over the real seed works.
- **Synthesis:** the P2.5 gated real tier (`SOW_COPILOT_REAL_EVAL=1`) — Sonnet 5 answered all 14 corpus cases grounded + cited.

## P3-live — the build (next)

The transport that connects retrieval → synthesis inside the worker. Plan + shape + caveats are in the RESUME PROMPT above. Reuse the P3.1 `parseGbrainSearchResult` (already built/reviewed). Run `_p3-prove.test.ts` first to confirm end-to-end, then wire into boot behind a flag.

## Uncommitted / carry state

- `packages/evals/test/copilot-eval/_p3-prove.test.ts` — the temp end-to-end proof harness (uncommitted; run then delete).
- The gbrain fixes are on the MACHINE (`~/.zshenv`, `~/.gbrain`), not in git.
- ⚠ **Concurrency:** the `../SoW-build-evalsec` (track/eval-security) session commits Phase-12 plan reconciliation to shared history. No file collision so far (it edits `IMPLEMENTATION_PLAN.md` checkboxes; main-track edits code).

## Load-bearing reminders

- Model: **Claude Sonnet 5** (`claude-sonnet-5`) + **1M context** (SDK `betas: ['context-1m-2025-08-07']`, a query option NOT a model suffix). Flag: `copilotRealModel` at `apps/desktop/worker-host/index.ts`.
- Auth is FRICTIONLESS (ambient local `claude` login; the SDK auto-uses it).
- Safety invariants unchanged (root CLAUDE.md): one-writer / candidate gate / external-write envelope / **WS-8 isolation** (P3-live-relevant) / Employer-Work egress veto / ING-7 / secrets via SecretsPort.
