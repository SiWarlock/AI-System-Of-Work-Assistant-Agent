# Phase 8 Security Audit — Local App API (§10)

- **Auditor:** security-reviewer (phase-boundary dispatch, `/phase-exit`)
- **Date:** 2026-07-02
- **Surface:** Phase 8A `745573f` + Phase 8B `cd3a5da` accumulated worker-track branch diff (auth gate, tRPC base + UI-safe boundary, query/command procedures, push stream, URL-authority convergence, §12 auth/leakage/exactly-once eval suites). Shared-contract freeze `a2f09f7` (ui-safe / events) in scope where it defines the boundary. Redaction hardening in `9fd682a`/`2a54480` reviewed where safety rule 7 crosses the log sink.
- **Verdict:** **CLEAR** — no new finding. Both prior verify HOLDS (auth, leakage) re-derived independently and confirmed.

## Scope + deferral waiver (mirrors Phase 7 / Phase 3)

App-shell wiring is **UNREACHABLE-BY-DESIGN / deferred**, documented in `IMPLEMENTATION_PLAN.md` (Phase-7 carry-forward a-iii: "session-auth wiring → Phase 8.1"; DoD notes on each 8.x task). Specifically NOT flagged as reachability defects:
- The loopback tRPC+WS server is not mounted in the running worker bootstrap; `server.ts` `appRouter` mounts only the `health` seam (8.3 query / 8.4 command / 8.5 stream routers shown as commented `mountRouters` placeholders).
- Persistent `@sow/db` health/schedule/lease stores not swapped into the live proof-spine (in-memory now).
- Electron-main worker-supervisor spawn, backup cron scheduler, live renderer WS handshake → Phase 9.

Every leaf module is unit + conformance tested and importable via the package subpath export map. The waiver mirrors Phase 7 (worker-wiring) and Phase 3 (session-auth app wiring). Confirmed reachable-under-test via the `@sow/evals` worker-api-auth suites, which drive the REAL modules (`createApiServer`, `buildCommandRouter`, `runStreamHandshake`, `createPushStream`) end-to-end.

## Key-safety-rule cross-check (invariant pass)

| # | Rule | Verdict | Basis |
|---|---|---|---|
| 4 | Workspace isolation / WS-8 | **PASS** | UI-safe projectors copy ONLY `UI_SAFE_ALLOWLIST` names by explicit assignment — no `...spread` (the one grep hit is an array copy of the already-gated replay log, not an object-field spread). Standalone interfaces (not `Pick<>`) + checked-in allowlist mean a later field-add to a frozen model cannot silently widen the UI surface. Stream publish re-validates every payload against `.strict()` `streamEventSchema` (fail-closed → dropped, never emitted). System-Health `egressStatus` reconstructed field-by-field (no verbatim port passthrough). Leakage suite drives every projector + every stream class with tainted records (deep-scan for 5 sentinel classes + allowlist-subset + dropped-field-absent) — green. |
| 5 | Employer-Work egress veto | **PASS (unchanged)** | Not re-litigated by Phase 8; the converged `@sow/policy` `processorOfRoute`/`isLoopbackEndpoint` preserve the Phase-3 tunneled-local fail-closed + OpenRouter-own-processor semantics (read verbatim). `redactRecord` `debug` option never unlocks raw content (rule 5 at the log sink). |
| 6 | ING-7 tool-stripping | **N/A** | Phase 8 introduces no untrusted-content job admission surface. |
| 7 | Secrets never to renderer/logs | **PASS** | tRPC `ApiContext` is exactly `{ auth: Result<AuthedContext, FailureVariant> }` — secret-free by construction; the token bytes never ride the context. `errorFormatter` overwrites `message` with a fixed literal + drops stack/cause/input-echo. `sessionAuth`/`originAllowlist` failures are opaque literals. Handshake reads the token ONLY from `connectionParams.token`, NEVER a URL (a `url`-smuggled token is treated absent). No `console.*` in the API surface. Redaction module (10.1) is a fail-safe field ALLOWLIST classifier validating value TYPE per field (not shape) — a bare employer codename / OTP / opaque token under an allowlisted key is REDACTED_RAW; `redactError` reduces a thrown value to a scrubbed message + typed cause `.code` only. |
| 1/2/3 | One-writer / candidate-gate / external-write envelope | **PASS** | Command procedures dispatch ONLY via injected ports (`ApprovalCommandPort` + dispatch fn + `TriagePort`); the API never writes an external system or Markdown directly (§7/§8). Transport-edge inputs pass a pure candidate-data gate returning typed `err(validation_rejected)` — no raw client value reaches a handler unvalidated. |

## §5 auth — independent re-derivation (HOLDS)

- **Constant-time session verify:** `@sow/policy verifySessionToken` guards operand length BEFORE `timingSafeEqual` (which throws on unequal length; an early length-reject leaks no per-byte content timing), then compares full-length. Worker wrapper maps DENY → opaque `err("unauthenticated")`. The auth suite mints an EQUAL-LENGTH wrong token (fixed rng) to drive the constant-time branch, not a length short-circuit.
- **Origin/Host DNS-rebind:** worker checks BOTH request Origin AND Host against a strict exact-match allowlist, plus a defense-in-depth Origin-authority == Host-authority cross-check. The suite's `wrong-host` vector (valid token + on-list Origin + off-list Host) is the rebind case — rejected.
- **Loopback-only bind (REQ-NF-004):** `assertLoopbackBind` refuses `0.0.0.0`/`::`/LAN/public/hostname/empty and the `127.0.0.1.evil.com` suffix spoof; admits `127.0.0.1`/`::1`/`localhost`. Suite covers all.
- **Auth-before-authz ordering:** interceptor runs token FIRST, then origin — a wrong-token+wrong-origin request fails `unauthenticated` without revealing the origin was also off-list.
- **Converged URL-authority isolator (Lesson 4):** the single vetted `@sow/policy extractAuthority` applies the Lesson-4 order EXACTLY: trim → strip `scheme://`|`//` → `firstSegment(s, "/?#\\")` (path/query/fragment/backslash) → strip userinfo via `lastIndexOf("@")` → lowercase, PORT-PRESERVING. Step-2 (path) precedes step-3 (userinfo), so `http://evil.com/@localhost:5173` isolates to `evil.com` (the `@` is in the path). The deleted worker-local `originAuthority`/`hostAuthority` copies were byte-for-byte the same algorithm — deleting them removes a drift surface and preserves behavior (diff reviewed; worker auth 25 green, policy url-authority suite 208 green).
- **Pre-handler enforcement:** the auth suite proves rejection BEFORE any handler by asserting the injected command port is NEVER touched on a rejected vector, and the stream generator yields NOTHING. Positive controls prevent an all-reject broken interceptor from passing.

## REQ-F-012 approval exactly-once (cross-channel) — HOLDS

Command layer issues the CAS EXACTLY ONCE over `decideApprovalCas`; a Mac+Telegram double-apply of the same decision collapses to exactly one durable transition (`applied:true`) + one dispatch — the second contender resolves `applied:false` (idempotent no-op) and does NOT re-dispatch (one-writer §7/§8). The stream source additionally dedupes by transition identity `${id}:${status}` (a resumed-workflow re-drive publishes no duplicate approval event). The exactly-once eval suite drives this through the REAL command router behind the real auth gate and asserts appliedCount==1, dispatchCount==1, terminal==approved, across a 3rd replay too — green.

## §16 untyped-throw-across-boundary — HOLDS

Every boundary path returns `Result<T, FailureVariant>`; no untyped throw crosses. `authedResolver` wraps the handler in try/catch → `err(degraded_unavailable, "internal_error")` even under a handler bug; `errorFormatter` is a redaction-safe net for any unexpected throw. Command procedures use a passthrough parser + inside-handler validation SO a malformed input is typed-err DATA (a throwing tRPC parser would bypass the Result boundary); `systemHealth` query uses a throwing transport-parser caught by the formatter (also fail-closed). `runStreamHandshake` wraps the interceptor in try/catch as belt-and-suspenders.

## Gates observed

- `@sow/worker` 268 pass / 5 skipped.
- `@sow/evals` worker-api-auth: auth 4, leakage 4, exactly-once 3; redaction-conformance 24 — all green (119 total in package).
- `@sow/domain` redaction 42, package 276 pass.

No fix-in-slice, no step-9 Finding. Verdict: **CLEAR**.
