# Session 034 — Copilot app-reachability (#1) + the http-grant transport (#2)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Tracks:** worker · desktop
- **Predecessor:** `033-2026-07-05-p3-live-gbrain-subprocess-retrieval.md`
- **Successor:** `035-2026-07-05-phase-c-tool-enabled-copilot-survey-and-c1.md` (owner chose Option C — full agent; Phase C started: survey + C1 tool catalog)
- **HEAD at close:** this round's commits (`dd4398b` #1 · `452e359` #2) atop the P3-live round.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31 tasks green** (worker 528 + desktop 172 + evals 446; gated tiers skipped).
- **Reviews (#2):** security-reviewer — all 7 invariants PASS, redaction/secrets clean, 0 crit/high. code-quality-reviewer — 1 high (concurrent DCR double-register) + mediums; the load-bearing findings fixed in-slice (see below). (#1 was a small pure-function decoupling — no separate review.)

## Why this session existed

The owner said **"do all of them"** on the three P3-live follow-ups: **#1** app-reachability, **#2** the http-grant transport, **#3** P4 full tools. This session delivered #1 and #2; #3 is surfaced as an owner decision (load-bearing).

## #1 — app-reachability: decouple Copilot workspaces from devProvision (`dd4398b`)

The Copilot ask failed closed at posture-resolve because worker-host passes no `devProvision` → the copilot workspace list was empty. Copilot reachability was wrongly coupled to `devProvision` (which is SURFACE data). Fix (`copilotClaudeSynthesis.ts`):
- **`resolveCopilotWorkspaces(opts)`** (pure): an explicit list wins; else devProvision-derived (backward compat); else — on the real path — the **3 WELL_KNOWN_COPILOT_WORKSPACES** (employer-work / personal-business / personal-life). So the Copilot answers without a vault note.
- **`copilotWorkspaceType`** extracted + exported (personal scopes explicit; everything else → most-restrictive `employer_work`).
- `BootConfig.copilotWorkspaces` (explicit override); boot uses `resolveCopilotWorkspaces` instead of the inline devProvision map.

Now a personal-business ask resolves a posture → reaches the gbrain retrieval; the other two scopes get the fixture-empty fallback. +6 tests. **Runtime caveats for the live app (subprocess transport):** VOYAGE_API_KEY + gbrain in the Electron worker env + no concurrent `gbrain serve`.

## #2 — the http-grant transport: read gbrain over `serve --http` (`452e359`)

The MANDATED `transport:"http"` GbrainReadGrant path. New `apps/worker/src/api/procedures/copilotGbrainHttp.ts`:
- **`createGbrainHttpExec`** — `tools/call query` over the MCP-over-HTTP `/mcp` endpoint with a bearer token; reactive 401→refresh→retry-once; fail-closed + redaction-safe on every path. **LOOPBACK-ONLY** (`isLoopbackUrl`, URL-API/userinfo-spoof-safe): the question can carry employer context, so a non-loopback baseUrl fails closed (rule 5 — no un-vetoed off-box egress).
- **`createGbrainDcrTokenProvider`** — the batteries-included auth: DCR (RFC 7591) + OAuth 2.1 `client_credentials`, cached + re-minted on `forceRefresh`, **single-flight** (concurrent cold asks share one register+mint — no duplicate OAuth clients). Auth is a pluggable `GbrainTokenProvider` seam — a **SecretsPort-preprovisioned token** (the `GbrainReadGrant.tokenRef` model) is a drop-in alternative with no transport change.
- Plugs into the SAME `GbrainQueryExec` seam; boot selects by **`BootConfig.copilotGbrainTransport`** ("subprocess" | "http") + `copilotGbrainHttpUrl`.

**Why it's the keystone:** one `gbrain serve` OWNS the single-connection PGlite DB and the worker reads over HTTP — so it **FIXES the P3-live PGlite-lock finding** (the worker reads WHILE a serve runs) and moves VOYAGE_API_KEY to the serve process.

**PROVEN end-to-end:** the gated LIVE test (`SOW_P3_LIVE=1`) ran the real DCR → token → `tools/call query` against a running `gbrain serve --http --enable-dcr` **while it held the PGlite DB** — grounded context returned. 31 http tests (1 gated-live).

## Reviews + Step-9 (#2)

Security CLEAN (all invariants PASS). Code-quality 1-high/5-medium/3-low; **fixed in-slice:** single-flight DCR (the HIGH concurrency bug); `res.text()` moved inside the try + whole exec body wrapped (the §16 no-throw finding — an untyped throw could have escaped `answerCopilotQuestion`); `parseMcpSseBody` prefers the JSON-RPC result frame (multi-frame SSE safe); `GBRAIN_HTTP_UNAUTHORIZED` → `retryable:false` (deterministic after a fresh token); + coverage tests for the DCR throwing/malformed-2xx branches, single-flight, loopback rejection, and the persistent-401 retryable assertion. **Deferred (low):** response-size byte-cap on `res.text()` (trusted-local, time-bounded); the `"error" in obj` / bare-cast cosmetics. **Informational (confirm at live-wiring):** the http transport adds NO per-workspace scoping — WS-8 still rests on the serve at `baseUrl` holding ONLY the served workspace's brain (single-brain assumption); TRUE isolation needs a serve/grant per workspace.

## Decisions made

- **Copilot workspaces decoupled from devProvision** — reachability shouldn't depend on vault-note provisioning.
- **Auth as a pluggable `GbrainTokenProvider` seam** — resolves "how does the worker authenticate to gbrain" as a WIRING choice (DCR default now; SecretsPort/tokenRef later), not baked into the transport.
- **Loopback-only http reads** — a non-loopback gbrain read is an un-vetoed egress of a possibly-employer question; fail closed rather than support a remote brain in this interim transport.
- **worker-host default stays `subprocess`** — the http transport needs an extra `gbrain serve --http --enable-dcr` process; kept the zero-extra-process default and made http a documented config flip (`copilotGbrainTransport: "http"`).

## Decisions explicitly NOT made (deferred)

- **#3 P4 "full tools"** — LOAD-BEARING (touches ING-7 tool-stripping, egress, tool policy, the candidate gate). Surfaced to the owner as an Option A/B/C decision; not built blind.
- **The SecretsPort token provider** (production auth) — the seam exists; the DCR default covers local self-hosted.
- **Per-workspace gbrain isolation** (serve/grant per workspace) — the single-brain assumption holds for the seed; TRUE WS-8 isolation is a later slice.

## TDD compliance

Clean. #1: `resolveCopilotWorkspaces`/`copilotWorkspaceType` RED→GREEN (6 tests). #2: the deterministic surface (request builder, SSE/result parsers, 401-retry, DCR mapping, single-flight, loopback) RED→GREEN (30 tests); the real fetch + OAuth handshake are integration-gated (`SOW_P3_LIVE=1`), the LLM/transport posture. No violations.

## Reachability

- `resolveCopilotWorkspaces` → `bootWorker` (live; the 3 scopes now resolve on the real path).
- `createGbrainHttpExec` / `createGbrainDcrTokenProvider` → `bootWorker` when `copilotGbrainTransport === "http"` (the exec factory). Currently reachable via config; worker-host defaults to subprocess.

## Open follow-ups

- **#3 P4 full tools** — pending the owner's Option A/B/C decision.
- **Flip worker-host to http** once the owner runs `gbrain serve --http --enable-dcr` as a service (immune to the PGlite lock).
- **SecretsPort token provider** for hardened auth.
- **Per-workspace serve/grant** for true WS-8 isolation; response-size cap; the deferred cosmetics.

## How to use what was built

- **Subprocess (default):** `copilotRealModel: true` + `copilotGbrainRetrieval: true` (already set) — the personal-business Copilot reads the local gbrain when no `gbrain serve` holds the DB.
- **http (lock-immune):** run `gbrain serve --http --enable-dcr` (default port 8899), then set `copilotGbrainTransport: "http"` in `worker-host` — the worker reads over MCP-over-HTTP with DCR auth, coexisting with the serve.
