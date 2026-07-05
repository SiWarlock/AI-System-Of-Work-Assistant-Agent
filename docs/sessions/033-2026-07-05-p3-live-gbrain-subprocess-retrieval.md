# Session 033 — P3-live: wire REAL GBrain retrieval into the worker's Copilot (subprocess transport)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Tracks:** worker · desktop
- **Predecessor:** `032-2026-07-05-RESUME-p3-live-gbrain-wired.md`
- **Successor:** `034-2026-07-05-copilot-reachability-and-http-grant-transport.md` (#1 app-reachability + #2 http-grant transport — fixes the PGlite lock)
- **HEAD at start:** `5f9e658` (docs) / `9cc0ee1` (code) · **HEAD at close:** _(this round's commits)_
- **Gate at close:** repo-wide `turbo typecheck test` **31/31 tasks green** (worker 490 + desktop 172 + evals 446 + contracts/domain/etc.; 20 worker + 14 evals gated-tier skipped).
- **Reviews:** security-reviewer **CLEAN** — 0 critical/high/medium; all four load-bearing invariants (WS-8 isolation, secrets/redaction §16, candidate-gate fail-closed, no-throw) PASS; 2 LOW defense-in-depth items (reviewer-marked defer) + 1 informational deployment-invariant note. code-quality-reviewer — 0 high / 2 medium / 1 low; **3 fixed in-slice** (GBRAIN_CLI_EMPTY retryable→false + `echo`-binary test; duplicate-slug page-level citation made intentional + pinned by a test; symmetric empty-string guard on `chunk_text`), **2 lows deferred** (child-env allowlist; pre-cap `.map` bound — both trusted-local-brain hardening).

## Why this session existed

Session 031 delivered the DETERMINISTIC GBrain retrieval adapter (P3.1: `parseGbrainSearchResult` + `createGbrainCopilotRetrieval`, TDD'd over the read-only `GbrainReadAdapter`) but left the LIVE wiring blocked on a real gbrain read transport + a populated brain. Between sessions the gbrain was **fixed + seeded** (outside git — env-var typo `VOYAGER→VOYAGE`, brain re-inited for Voyage `voyage-code-3` @ 1024 dims, `docs/` imported = 98 pages / 554 chunks embedded). This session builds **P3-live**: the worker transport that connects a REAL gbrain read to the already-built P3.1 mapper, behind a flag.

## What was built

### Slice 1 — the subprocess GBrain retrieval transport (deterministic core, TDD)

**File created:** `apps/worker/src/api/procedures/copilotGbrainSubprocess.ts` + `test/api/procedures/copilotGbrainSubprocess.test.ts` (18 tests, 1 gated-live).

- **`normalizeGbrainHits(raw)`** (PURE) — maps a gbrain `call query` response (top-level array of hits) into the `{content, id, title}` shape the P3.1 `parseGbrainSearchResult` accepts. gbrain's own field names DON'T match that mapper's key aliases, so a raw pass-through would be wrong on two counts: its content is `chunk_text` (not a CONTENT_KEY → every hit dropped), and its only per-hit id is the path-like `slug` (NOT an ID_KEY), while `source_id` IS an ID_KEY but is the gbrain SOURCE ("default" for every hit → would collapse every citation to `gbrain:default`). So it maps `chunk_text→content` and derives the id from `slug` with `/`→`:` (a path is rejected by the downstream `uiSafeOpaqueRef` gate; `:` keeps it an opaque scheme-token). Non-array → returned unchanged (mapper fails closed); a hit missing `chunk_text`/`slug` → object lacking `content`/`id` → mapper SKIPS it (fail-closed per hit).
- **`createGbrainSubprocessRetrieval({exec, servedWorkspaceId, fallback, limit})`** (PURE composite) — a `CopilotRetrievalPort` where ONLY the ONE served workspace reads gbrain (via the injected `exec`); every other workspace — known or unknown — delegates to the fixture `fallback` and NEVER triggers a brain read. Reuses the reviewed `parseGbrainSearchResult` (aligned block↔source pairs, `gbrain:<id>` opaque cites, cap, fail-closed). This is **WS-8 by construction** (see caveats).
- **`createGbrainCliExec(options?)`** — the REAL child_process transport (imperative seam; integration-tested behind `SOW_P3_LIVE=1`, never in the default suite). Shells `gbrain call query '{"query":Q,"limit":N}'` via `execFile` (argv, not a shell string — no injection), trims a leading gateway warning, `JSON.parse`s stdout. Redaction-safe: on ANY failure returns only a stable typed code (`GBRAIN_CLI_FAULT`/`GBRAIN_CLI_EMPTY`), never the child's stderr/message (which could echo the query). Deletes inherited `GBRAIN_EMBEDDING_MODEL` (let the brain config drive embeddings); needs `VOYAGE_API_KEY` + `gbrain` on PATH (missing → fail closed).

### Slice 2 — wire into boot behind a flag

**Files modified:** `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts` (`CopilotDepsOptions` gains `gbrainExec?` factory + `gbrainWorkspaceId?`; `buildCopilotDeps` routes the served workspace to the subprocess retrieval on the real path, keeps the fixture on both paths otherwise — factory invoked at most once, only on the gbrain path) · `apps/worker/src/boot.ts` (`BootConfig.copilotGbrainRetrieval?` + `copilotGbrainWorkspaceId?`; constructs `createGbrainCliExec` ONLY when the flag is on) · `apps/desktop/worker-host/index.ts` (**flag flip:** `copilotGbrainRetrieval: true`). +90 lines of `buildCopilotDeps` branch tests (served reads gbrain / non-served stays fixture / OFF ignores exec / factory-once / workspace override).

## The end-to-end proof (and why the throwaway harness was dropped)

Both halves are proven through **production code**, not the interim harness:
- **Retrieval:** a direct `createGbrainCliExec`-shaped `gbrain call query` returned the right SoW docs, semantically ranked (top `sessions/028-…egress-governance`, score **0.886**).
- **Synthesis:** the P2.5 gated real tier passed **14/14** against live Claude Sonnet 5 (session 031).
- **The glue** (normalize → parse → the buildCopilotDeps branch) is unit-tested (21 new deterministic tests).

The temp `_p3-prove.test.ts` (an inline-copy harness) was **deleted** — it duplicated production code and, more importantly, couldn't run reliably here (see the PGlite finding).

## FINDING — PGlite single-connection vs. the subprocess CLI transport

The local brain is a **PGlite (embedded Postgres) file — single-connection**: one process holds it at a time. A concurrently-running `gbrain serve` (e.g. the gbrain **MCP server**, which is supervised/auto-respawned in an agent session) holds that lock, so a `gbrain call query` CLI read **BLOCKS and times out** (→ `GBRAIN_CLI_FAULT`). The gated LIVE test therefore fails in this session unless the DB is exclusively free (it succeeded in a clean window — score 0.886 — then serve respawned). This is not a code defect; it is precisely **why the architecture mandates the `transport:"http"` GbrainReadGrant path** (one server owns the DB; readers go over HTTP). It confirms the subprocess CLI transport is a retrieval TEST seam, not the production path. Documented in the code (`createGbrainCliExec` doc + the LIVE test comment).

## Decisions made

- **WS-8 by construction, not by adapter scoping.** The single seeded brain holds ONE workspace's content (the SoW build docs = a `personal-business` side project). So exactly ONE workspace (`servedWorkspaceId`, default `personal-business`) reads the brain; every other workspace is fixture-fallback and can't reach the brain. This makes the single-brain deployment leak-safe *by construction* — a stronger, simpler guarantee than trying to filter one shared brain by workspace (which the CLI can't do). Real per-workspace isolation still needs a brain/source per workspace (the http-grant path).
- **A factory (`() => GbrainQueryExec`), not the exec**, in `CopilotDepsOptions` — so the CLI transport is constructed only when the gbrain path is actually taken (mirrors the `completion` factory pattern; unit-tested "called exactly once, only on the gbrain path").
- **Kept the subprocess CLI transport** (interim) rather than building the http-grant transport now — the http path needs grant provisioning + the Phase-12 read-gate + `gbrain serve --http` deployment (all still deferred). The CLI seam proves retrieval end-to-end today and is cleanly swappable behind the same `GbrainQueryExec` seam.

## Decisions explicitly NOT made (deferred)

- **App-reachability of P3-live.** The running Electron app passes NO `devProvision`, so Copilot workspaces are empty and every ask fails closed at posture-resolve BEFORE retrieval — the flag is wired + unit-tested but not reachable in the live UI until (a) `personal-business` is provisioned (a devProvision spec so a posture resolves) AND (b) `VOYAGE_API_KEY` + `gbrain` are in the Electron worker's env AND (c) no `gbrain serve` holds the PGlite lock. This is the same reachability class as the rest of the interim Copilot path. **Follow-up.**
- **The mandated `transport:"http"` GbrainReadGrant path** — the production transport (one server owns the DB). Blocked on grant provisioning + the §12 read-gate + `gbrain serve --http`. The `GbrainQueryExec` seam is where it swaps in.
- **Over-long-slug hardening** — a slug > ~120 chars would make `gbrain:<slug>` exceed the `uiSafeOpaqueRef` 128-cap and fail closed (safe drop). The seed's slugs are short; a live-hardening slice can opaque-hash long slugs.

## TDD compliance

Clean. Slice 1 RED→GREEN (module missing → 16 deterministic tests). Slice 2 branch RED→GREEN (5 `buildCopilotDeps` gbrain-branch tests). The imperative `createGbrainCliExec` happy path is EVAL/integration-tested (gated `SOW_P3_LIVE=1`), its fault path unit-tested (missing binary → `GBRAIN_CLI_FAULT`, no query leak) — the LLM/transport posture, not unit-pinnable. No violations.

## Reachability

- **`normalizeGbrainHits` / `createGbrainSubprocessRetrieval`** — reachable from `buildCopilotDeps` (the real path + `gbrainExec`) → `bootWorker`.
- **`createGbrainCliExec`** — reachable from `bootWorker` when `config.copilotGbrainRetrieval === true` (flipped ON in `worker-host/index.ts`). NOTE the app-reachability gap above (no provisioned workspace ⇒ the ask fails closed before retrieval today).

## Open follow-ups

- **App-reachability:** provision `personal-business` (devProvision) + confirm `VOYAGE_API_KEY`/`gbrain` in the Electron worker env + ensure no `gbrain serve` holds the brain — then the live Copilot answers from the seeded gbrain.
- **The http-grant transport** (production path) — swap behind `GbrainQueryExec`.
- **Deferred nits:** long-slug opaque-hashing; the single-brain WS-8 note becomes real per-workspace isolation only with a brain/source per workspace.
- **Deferred review lows (hardening):** (a) `createGbrainCliExec` passes the FULL worker env (`{...process.env}`) to the gbrain child — allowlist it to `PATH`/`HOME`/`VOYAGE_API_KEY` so a shadowed `gbrain` on PATH can't harvest the cloud-model secrets (and/or prefer an absolute `binary`); (b) `normalizeGbrainHits` maps the whole pre-cap array — bound `raw.length` before the map (soft-DoS on a pathological local payload, already capped by `maxBuffer`/`timeout`). Both LOW, trusted-local-brain source, reviewer-marked defer.

## How to use what was built

With the flag ON (`copilotGbrainRetrieval: true` in `worker-host/index.ts`), a `personal-business` Copilot ask reads the local gbrain (`gbrain call query`) and synthesizes with Sonnet 5 — PROVIDED the workspace is provisioned, `VOYAGE_API_KEY`/`gbrain` are in the worker env, and no `gbrain serve` holds the PGlite lock. To prove retrieval in isolation: free the DB (`pkill -9 -f 'gbrain serve'`), then `SOW_P3_LIVE=1 pnpm --filter @sow/worker exec vitest run -t LIVE test/api/procedures/copilotGbrainSubprocess.test.ts`. To turn P3-live OFF: remove the `copilotGbrainRetrieval` line in `worker-host/index.ts` (retrieval reverts to the fixture stub).
