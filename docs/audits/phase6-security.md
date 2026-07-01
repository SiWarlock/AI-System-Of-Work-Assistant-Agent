# Phase 6 — Security review (`/phase-exit 6` gate)

**Subject:** `packages/integrations` (`@sow/integrations`) — §8 Connector & Tool Gateways, the ONLY external-write path.
**Surface:** whole package (new, uncommitted/untracked working tree — `git status` shows `?? packages/integrations/`), reviewed as the Phase-6 accumulated diff (phase-boundary policy).
**Gate:** `pnpm --filter @sow/integrations exec vitest run` → **150 passed (19 files)**. Confirmed green.
**Reviewer disposition:** re-derived each of the three adversarial-verify fixes from source; did not take the dispatch summary's word.

---

## 1. Safety rule 3 — no duplicate external writes under concurrency (CROWN invariant) — CLEAR

**Fix under review:** an atomic create-reservation (`ReceiptStore.reserve(targetSystem, canonicalObjectKey)`) inserted between the pre-write existence check and `adapter.create` in `src/tools/gateway.ts` `dispatchExternalWrite` (§3.5, lines 176–194), with `release` on a create fault (line 208) and reservation-clear on `put` (`test/support/fakes.ts` lines 88–94).

Refutation attempts and results:

- **Two dispatches, same canonicalObjectKey, interleaved (the gap the verify pass found).** Trace: D1 and D2 both pass `resolveExisting` → `none`. D1 calls `reserve` → in `InMemoryReceiptStore.reserve` (`fakes.ts` 65–82) the body runs `Map.get` (committed?) → `Set.has` (in-progress?) → `Set.add`, **with zero `await` between the check and the set**. On the single-threaded event loop this check-and-set is atomic — no other dispatch can interleave inside it. D2's later `reserve` observes `reserved.has(key) === true` → returns `in_progress` → D2 returns `held`. Only D1 reaches `adapter.create`. `test/tool-gateway-race.test.ts` parks D1 inside `create` and drives D2 to completion: asserts `createCalls === 1` and `d2.status === "held"`. **Refutation fails — exactly one create.** Verified green.
- **Different idempotencyKey, SAME canonicalObjectKey.** The reservation is keyed on `objectKey(targetSystem, canonicalObjectKey)` (`fakes.ts` 50–52), NOT on idempotencyKey. So two envelopes with distinct replay keys but the same object identity still collide on the reservation → only one create. This is the correct keying: idempotencyKey guards replay (existence-check step a), canonicalObjectKey guards object identity (reserve). **Refutation fails.**
- **Is the in-memory check-and-set atomic across `await` points?** `reserve` is declared `async` but awaits nothing internally; the atomic region is fully synchronous. The port doc (`persistence.ts` 58–64) states the production adapter backs `reserve` with a unique-constraint insert for cross-PROCESS atomicity — the correct real-world primitive. **No await-hole.**
- **Does `release`-on-fault open a window?** On a create fault the winner calls `release` (line 208) which deletes the reservation; a concurrent D2 that was holding (`held`) is expected to retry via the outbox drain and re-claim. There is no path where `release` runs while a create is still in flight — it runs only after `adapter.create` has returned a fault. The release→re-claim→create sequence is covered by the second race test (`createCalls === 2` after a fault then a retry). **No duplicate-create window.** (Residual, informational: `release` is unconditional on any fault including `conflict`; a `conflict` means the object now exists at the vendor, so a re-claim's next existence probe will hit and reuse — no duplicate. Acceptable.)
- **Commit path.** On create success `recordReceipt` → `store.put` indexes the receipt by BOTH keys and clears the reservation atomically (`fakes.ts` 88–94); a subsequent dispatch short-circuits at existence-check step (a)/(b) → `reused`. The race test's third dispatch confirms `reused` with `createCalls` still `1`.

Sole external-write call site audited: `grep` across `src/` finds `adapter.create(` at exactly ONE location — `gateway.ts:199`, downstream of gate + approval + existence-check + reserve. `adapter.update(` is never called in `src/` (upserts route through `create` on a stable canonicalObjectKey). **Verdict: CLEAR.**

## 2. Safety rule 3 — only-write-path + approval-before-dispatch (REQ-F-012) — CLEAR

- **Gate-before-side-effect.** `dispatchExternalWrite` step 1 runs `admitExternalWriteEnvelope(env, action)` (candidate-gate composition ajv→Zod→§3-keys→`envelopeMatchesAction` linkage pin) and returns `{status:'rejected'}` BEFORE any existence probe, reserve, or create (`gateway.ts` 127–132). The candidate-gate is the correct composition, not ajv alone (`candidate-gate.ts` — discharges LESSONS §3). **CLEAR.**
- **Approval-before-dispatch.** Step 2 (`gateway.ts` 137–144): if `requireApproval(action).requiresApproval` and `!isApproved(env)`, it records a pending approval and returns `{status:'approval_pending'}` WITHOUT probing or creating. The fixes to §1/§3 did not regress this ordering (approval is step 2, reserve is step 3.5). `notebooklm-sync.ts` `classifyDispatch` correctly maps `approval_pending` → hard `dispatch_failed` (never treats an unapproved write as synced). **CLEAR — no regression.**
- **Linkage integrity.** `envelopeMatchesAction` pins actionId/targetSystem/canonicalObjectKey/idempotencyKey (`contracts/.../external-write-envelope.ts` 88–98). `payloadHash` is intentionally NOT in the linkage compare — but `buildEnvelopeFromAction` computes `payloadHash(action.payload)` itself (`envelope.ts` 47), and `payload-hash.ts` is a pure, replay-stable, key-order-independent sha256, so the envelope's hash is bound to the action's payload by construction. `adapter.create(env, action.payload)` writes `action.payload` — the same object the hash covers. No approved-for-X / written-as-Y split. **CLEAR.**

## 3. Safety rule 7 — redaction (§16) — CLEAR with LOW residual gaps (defense-in-depth)

**Fix under review:** `src/redaction/gateway-log-redaction.ts` broadened detection + scrub to Google `AIza…` keys (`GOOGLE_API_KEY`) and credential URL/query params (`URL_CREDENTIAL_PARAM` / `URL_CREDENTIAL_PARAM_SEGMENT`). Regression: `test/gateway-redaction-credentials.test.ts` (7 tests, green).

Refutation (probed in isolation against the exact predicates) — shapes that STILL reach a sink:

- **AWS 40-char bare secret, no prefix, no param** → SAFE (leaks). This is DOCUMENTED in the source (lines 52–54: "a bare 40-char opaque secret cannot be told apart from a content hash"). Inherent to shape-based detection. **LOW / accepted.**
- **AWS SigV4 secret in a signed URL (`?X-Amz-Signature=…`)** → SAFE (leaks). The new `URL_CREDENTIAL_PARAM` allowlist matches `[?&]sig=`/`[?&]signature=` but NOT `X-Amz-Signature=` (the `X-Amz-` prefix defeats the `[?&]` anchor). So the very leak-class the fix targets — "AWS secret in a signed URL" — is only partially closed. **LOW / new residual (see finding L-1).**
- **Opaque bearer token without the word "bearer"** → SAFE (leaks). Documented limitation; a random 24–32-char token is indistinguishable from an opaque id. **LOW / accepted.**
- **Plain base64 blob (no JWT dots)** → SAFE. A raw base64 body would leak IF it reached a diagnostic — but it cannot: raw payloads/response bodies are STRUCTURALLY DROPPED (never placed on the `Safe*Log` record; `buildSafeConnectorLog`/`buildSafeToolWriteLog` omit `rawContent`/`rawPayload`/`responseBody` by field selection). **Not reachable — accepted.**

Over-redaction check (no false-drop of useful diagnostics): `?page=2&limit=50` → SAFE (kept); `sha256:` hash → SAFE (kept); `cok_drive_…` object key → SAFE (kept); `AUTH_TOKEN_INVALID` status code → SAFE (kept, `SENSITIVE_KEYWORD` deliberately omits bare "token"). The query-param SCRUB keeps the param name + `=` and replaces only the value with `[REDACTED]` (negative-lookahead prevents double-redaction), so a scrubbed URL stays log-safe without dropping the whole field. **No over-redaction regression.**

Per the dispatch's own framing, redaction is defense-in-depth (primary guarantee: raw content is structurally dropped + "redaction-safe by convention" at the transport). The residual gaps are shape-detection limits, two of them explicitly documented; L-1 is a genuinely-narrow miss in the NEW code. **Verdict: CLEAR (no blocker); one LOW finding to consider fixing.**

## 4. No-silent-drop reads (REQ-I-005) + hold-through-outage (§8) — CLEAR

- **Cursor discipline (`connectors/gateway.ts`).** On `onRecords` failure the function `return`s `{status:'held', cursor}` BEFORE the `cursors.upsert` (lines 164–178) — the persisted cursor never advances past unprocessed records. auth_locked and degraded fetch faults also return before any upsert. The cursor advances (`cursors.upsert`, 183–193) ONLY after a successful consumer commit, per-page. A fully-deduped page (`fresh.length === 0`) skips `onRecords` but correctly advances (nothing unprocessed). **No silent drop.**
- **Held write never dropped (`tools/outbox.ts` + `notebook/notebooklm-sync.ts`).** `holdWrite` persists the FULL envelope as a NON-TERMINAL `OutboxEntry` (`toOutboxStatus` → `retry_queued`/`proposed`, never a terminal state), so `listDue` always re-surfaces it; a same-idempotencyKey re-hold is a no-op (replay gate). The new sync wiring (`notebooklm-sync.ts` 182–208) enqueues an unreachable held write via `holdWrite` and returns `{kind:'held'}` (never dropped, never a false `upserted`); an enqueue failure fails the sync closed. `outbox-drain.ts` re-drives DUE entries through the SAME `dispatchExternalWrite` pipeline (existence-check + replay gate → zero duplicate create), re-holds still-unreachable entries with bounded backoff, and never lets a held item silently expire (exhaustion → bounded `maxMs` delay, surfaced via depth/health, not a drop). **CLEAR.**

## General pass

- **Input validation at the gateway boundary** — every external-write entry is gated by the ajv+Zod+§3-keys composition (never ajv alone; LESSONS §3 discharged). Connector reads return typed `Result` unions, never throw. **Clean.**
- **Injection** — no string-concat into a system/query surface; payloads flow as structured `Record<string,unknown>` to injected transports. **Clean.**
- **Unbounded loops** — connector fetch loop is bounded by backoff `EXHAUSTED` + `done`; outbox drain is bounded by `listDue(limit)`; reserve/create is single-shot. No user-controlled unbounded iteration. **Clean.**
- **Secrets in logs/audit** — `AuditRecord` (`emitCommitDiagnostics`) carries only refs + `payloadHash` + summaries, never raw payload (`gateway.ts` 84–114); every surviving log string runs through `redactString`. **Clean** (subject to §3 shape-detection residuals).
- **Determinism/purity** — no `Date.now()`/`Math.random()`/real network in `src`; all effects injected. **Clean.**

## Findings

| id | severity | file:line | description | action |
|----|----------|-----------|-------------|--------|
| L-1 | LOW | `src/redaction/gateway-log-redaction.ts:63,101` | The new credential URL/query-param scrub misses AWS SigV4 params (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`) because the `[?&]…=` anchor + fixed name allowlist does not match the `X-Amz-`-prefixed names — the "AWS secret in a signed URL" leak-class the fix targeted is only partially closed. Defense-in-depth layer (raw content is already structurally dropped), so not a blocker. | step-9-flag (defer / broaden allowlist to include `x-amz-*` signed-URL params in a follow-up) |
| I-1 | INFO | `src/index.ts:49–58` | The barrel re-exports per-vendor adapter factories, so a hypothetical out-of-package caller could obtain an adapter and call `.create()` directly, bypassing the gateway. No in-phase code does this (sole `create` call site is `gateway.ts:199`); inherent to a port/adapter split and enforced by convention, not the type surface. | defer (note only) |

No CRITICAL or HIGH findings. No invariant bypass, no duplicate-create interleaving, no unauthorized/unapproved dispatch, no raw-content/secret exfiltration through the structural log surface.

---

**Verdict: CLEAR** — the three adversarial-verify fixes independently re-derive as sound; the one new residual (L-1) is a LOW defense-in-depth gap, not a blocker.
