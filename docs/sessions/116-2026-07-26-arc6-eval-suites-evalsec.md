# Session 116 — ARC-6 eval & test-harness suites (evalsec, Wave-2)

- **Date:** 2026-07-26
- **Track / role:** `main` · evalsec-implementer (`packages/evals/`)
- **Arc:** Wave-2 ARC-6 — complete the §12 DoD eval & test-harness suites (all provider-free / deterministic; import landed code, never edit source packages — Lesson 29).

## Slices landed this session

| Slice | What landed | Commit |
|---|---|---|
| 12.16 | no-inference validator suite pins REQ-F-017 over the 23-entry corpus (validator leg; e2e leg deferred) | `3f3baeae` |
| 12.18 | worker-API session-token/Origin auth suite — anti-DNS-rebind spoof + handshake token-source (worker leg; Electron leg deferred) | `67c8f39a` |
| 13.3b | retrieval recall@10 bar over recorded-embedding fixture — fused hybrid ≥0.91 + re-ranker no-regression, zero-egress | `cdb1c47f` |
| 13.3b ripple | reconcile anti-corruption count-pin 19→20 — free-source-aggregator.ts acknowledged read-edge (own scan clean) | `1038faa3` |
| 13.13r | research egress-leakage DoD eval — employer-raw ack-OFF fails closed on BOTH broker-veto provider AND self-veto aggregator; zero real egress | `1aaa575a` |
| 9.9a ripple | add `calendar` member to readModel fakes — reconcile ReadModelQueryPort extension | `f7829ce5` |
| 12.20 | doctor-prereqs acceptance eval — install-doctor posture fails closed over injected ProbeSnapshots (clean-install e2e = it.todo) | `6b38f022` |
| 13.16 ripple | add `taskRollup` member to readModel fakes — reconcile ReadModelQueryPort extension | `f4555713` |
| 13.8c-eval | synthesis REASON-leg — planSynthesis safety invariants @ hard-100% floor + faithfulness over a 20-entry recorded-candidate corpus (provider-free) | `a34de8e1` |
| guard L12 | tighten anti-corruption `@sow/knowledge` token to the QUOTED import specifier + count-pin 20→21 | `2c5ac552` |
| egressCommand | add `egressCommand` fake to auth-suite `serverDeps` (ApiServerDeps growth from 9.10-B) | `3a881899` |

## Exogenous anti-corruption RED — resolved (the two closing commits)

The `@sow/evals` gate went RED from two concurrent-track ripples (both fixed this session):

1. **Prose false-positive (L12).** `web-fetch-transport.ts` (13.2a, `3c501687`) — the net-new 21st `connectors/adapters` read-edge — carries a **backtick-fenced** doc comment on line 27 (`imports no \`@sow/knowledge\`/fs-write`). The guard's `@sow/knowledge` token was a bare substring, so the LIVE conformance scan flagged the prose as a violation. Fix: token tightened to the **quoted import specifier** `/['"]@sow\/knowledge/` — deny import PATHS, not prose. **+0/-0 no-weakening**: a new fixture proves all 12 idiomatic import forms (from/require/dynamic import · single+double quote · deep subpath) still trip (every real specifier is quote-preceded), while backtick/bare prose does not. `security-reviewer=invariant` verdict was SOUND / no-weakening (orch-confirmed).
2. **Count-pin 20→21.** `telegram-capture.ts` is a Phase-6 stub already counted; **web-fetch-transport.ts** is the net-new adapter. Certified write-free by `scanForWriteSurfaces` (0 violations — the deciding CERTIFY).

`egressCommand` (9.10-B / #53, `225c10ca`) added a required `ApiServerDeps.egressCommand` member, breaking the auth suite's `serverDeps()` fake at the two `createApiServer` call sites. Fix: a canned fail-closed `store_fault` err stub (the auth suite never exercises egress revoke → an un-exercised port must never fake a successful egress-ack flip).

**@sow/evals gate is now GREEN** (typecheck clean; anti-corruption 20 tests + auth 32 tests pass).

## Task #55 — COMPLETE (nothing left for a fresh evalsec)

Task #55 was created to defer three evalsec ripples to a fresh session. Per the orchestrator's revised (post-security-review) directive, all three landed this session:
- ✅ anti-corruption guard L12 fix (`2c5ac552`)
- ✅ count-pin 20→21 (`2c5ac552`)
- ✅ egressCommand fake (`3a881899`)

## Carry-forward / deferred (owned, not dropped)

- **Backtick-specifier import gap (DEFERRED — orch ruling).** `import(\`@sow/knowledge\`)` (a non-idiomatic backtick import specifier) is NOT caught by `/['"]@sow\/knowledge/`. Precision follow-up = keyword-anchored upgrade `\b(from|import|require)\s*\(?\s*['"\`]@sow\/knowledge`. Deferred during the team pause (no real code backtick-imports a fixed package; the runtime one-writer invariant is the backstop). Orchestrator carries it forward.
- **DoD e2e legs (deferred, tracked as `it.todo` so the row is visibly pending):** 12.16 validator→e2e, 12.18 Electron renderer auth leg, 12.20 clean-install e2e, 13.8c live real-model REASON leg (§ARM-RESEARCH). Each is the live-integration / owner-gated half of a suite whose deterministic leg landed green.

## Notes

- No source-package edits — every suite imports landed code and asserts against it (Lesson 29).
- The two closing commits are staggered (guard fix is its own safety commit; egressCommand is a separate typecheck reconcile — never bundle a rule-1 safety-guard slice with anything else).
- graphify updated (`packages/evals/graphify-out`: 802 nodes / 1181 edges).
