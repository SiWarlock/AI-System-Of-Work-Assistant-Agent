# Phase 10 Security Audit (cross-cutting) — `/phase-exit`

**Auditor:** security-reviewer · **Scope:** Phase-10 accumulated branch diff (commits `9fd682a` substrate + `2a54480` lifecycle/suites, over frozen contracts `a2f09f7`) · **Date:** 2026-07-02
**Surface:** phase-boundary — over-approximates to the accumulated worker-track diff (redaction/logger, error-routing, operational-truth stores, lease/fencing, recovery, degraded modes, backup/restore, config guard, policy processors).
**Verdict: CLEAR.** No critical/high finding. Two bounded residuals (both pre-accepted / documented), one LOW note.

---

## 1. Redaction — independent re-derivation (safety rule 7 + rule 5) — PASS

Re-derived the value classifier from source (`packages/domain/src/redaction/{redaction-rules,redact}.ts`), not from the brief.

**The gate, as built.** `redactRecord` keeps EVERY key but replaces each value:
- Field name NOT on `SAFE_FIELD_ALLOWLIST` ⇒ `REDACTED_FIELD` (value unseen — denylist rejected as insufficient, allowlist is exhaustive). ✔ correct default-deny.
- Allowlisted key, string value ⇒ **credential-scrub FIRST** (`redactString`: PEM / URL-userinfo / `CREDENTIAL_TOKEN` substitution, then a `looksUnsafe` safety-net whole-field drop). A surviving clean string passes **only** if `isSafeFieldValue(key, s)` proves it safe by TYPE: frozen-enum member for its field, id-charset under an id-named key, ISO-8601 under a timestamp key, or a structured `UPPER_SNAKE` code. Everything else ⇒ `REDACTED_RAW`. ✔ matches the claimed rule.
- number / boolean / null ⇒ pass by `typeof`; object/array ⇒ recursed (each nested value re-keyed); function/symbol/bigint ⇒ dropped. ✔

**Attack A — raw/secret via a NON-id field.** Blocked. Any allowlisted non-id field (`status`/`kind`/`code`/`failureClass`/`state`/`event`/`provider(Id)`/`targetSystem`/`capability`/`transport`) is enum/token-validated; a bare codename (`ACME`), an OTP (`824193`), or an opaque base64url token is not a member ⇒ `REDACTED_RAW`. Confirmed by test (`redact.test.ts:303-341`). An unallowlisted field never even reaches the value gate. **PASS.**

**Attack B — the `providerId` Id-suffix defeat.** Blocked. `isSafeFieldValue` runs the per-field `switch` BEFORE the generic `isIdNamedKey` short-circuit, so `providerId`/`provider` are enum-validated against `ProviderId` even though the name ends in `Id`. A raw codename/OTP/opaque token under `providerId` ⇒ `REDACTED_RAW` (`redact.test.ts:344-357`). **PASS** — this was the re-verify HIGH and it holds.

**Attack C — Error / stack / cause path.** Blocked. `redactError` routes `message` and `stack` through `redactMessageLike`, which credential-scrubs then drops ANY surviving non-empty payload to `REDACTED_RAW` (no field context ⇒ no verbatim surface; the only pass-through is the empty string). The cause chain surfaces ONLY a typed `.code`, itself re-validated via `isSafeFieldValue("code", …)` — a free-form `.code` with whitespace / a bare word / an OTP drops to `undefined` (`redact.test.ts:266-289`). A short single-line raw sentence in a message can no longer survive. **PASS.**

**Attack D — `debug` unlocks raw.** Blocked. `RedactRecordOptions.debug` is inert on redaction; `errorMessage`/raw stays `REDACTED_RAW` at debug (`redact.test.ts:221-224`). Matches safety rule 5 (raw Employer-Work content stays redacted behind a debug flag). **PASS.**

**Accepted residual (correctly bounded).** A string that is (a) NOT credential-prefix/keyword/userinfo-shaped AND (b) matches the bounded id charset `/^[A-Za-z0-9_:.-]+$/` (≤128, whitespace-free) placed by the CALLER under a genuine id-named field (`correlationId`/`*Id`/`*Ref`) passes verbatim. This is exactly the documented residual: a secret **mislabeled** under a system-generated id field. It requires caller misuse (the field NAME is caller-chosen, not attacker-chosen), the enum-validated id fields (`providerId`) are excluded, and the charset caps blast radius. **Correctly bounded — accept.**

**Chokepoint.** `createLogger(sink)` (`apps/worker/src/observability/logger.ts`) is the single non-bypassable path: the sink is closure-captured and never exposed; all five methods (debug/info/warn/error/errorFrom) funnel through one private `emit` that runs `redactRecord`/`redactError` first, lifts the traceability keys each through a one-key `redactRecord`, then `logRecordSchema.safeParse` before the sink (a non-conforming record drops to a minimal `{level,event}`, never throws — §16). No `console.*` / `process.stdout` / raw fs sink appears anywhere in the Phase-10 worker/domain diff (grep clean). The provider-boundary redactor (`provider-log-redaction.ts`) now imports the single-sourced domain detectors (no divergent second copy). **createLogger is the single non-bypassable chokepoint — PASS.**

## 2. Recovery reuses the §8 envelope (safety rule 3) — PASS
`recoverRun` (`lifecycle/recovery.ts`) replans via pure `planResume`, then re-drives each RE-DRIVE `external_write` through `reuseExternalWriteOnResume` with the SAME envelope (idempotencyKey + canonicalObjectKey + payloadHash). A stored receipt ⇒ `reused`, `adapter.create` never re-called ⇒ zero duplicate write, idempotent across repeated crashes. A torn commit is caught upstream (`unrecoverable`) and never re-driven; a held step surfaces a `worker_down` HealthItem (never a silent drop) yet does not strand independent later writes. Tests green (`recovery.test.ts` 7/7).

## 3. Config secret-shape guard (REQ-S-003) — PASS
`loadConfig` runs the frozen `secretShapeGuard` at the worker entry point BEFORE config crosses into services: a secret-shaped KEY or credential-shaped VALUE ⇒ `secret_in_config` (fail-closed); a non-object folds to `invalid_config`; never throws (§16). Secrets stay Keychain-only. Tests green (`load-config.test.ts` 6/6).

## 4. Degraded modes never silently drop work — PASS
`temporal-unavailable` controller HOLDS dispatches in-queue while degraded (never fires at a dead Temporal), surfaces a deduped `worker_down` item via `routeFailure(degraded_unavailable)` (health class never invented ad-hoc), and drains on reconnect through the SAME `dispatch` (idempotent via the §8 envelope). A mid-drain reject re-holds the job + surfaces its own item — no loss. `routeFailure` is total (exhaustive `switch` with a `never` default): every `FailureVariantKind` routes to retry OR outbox OR a health item. Conformance green (supervision-degraded 14/14).

## 5. Egress identity (safety rule 5) — PASS
`processors.ts`: `processorOfRoute` is fail-closed — a `'local'` egressClass claim is trusted only with loopback PROOF (`isLoopbackEndpoint`), the tunneled-local hole returns a processor (egress) not null, a malformed route ⇒ `MALFORMED_ROUTE` (egress). **OpenRouter is its own `processorId('openrouter')`, never an OpenAI alias.** A cloud provider id claiming loopback still egresses. Lesson-4 URL-authority isolator is the single vetted copy (path-before-userinfo order preserved). `endpointHostRef` strips userinfo/port ⇒ no basic-auth credential leaks into the audit/health stream.

## 6. Lease-fencing-unwired — residual risk assessment — LOW (accept, deferred)
`isFencedStale(operationGeneration, latestGeneration)` and the generation-bump/preserve logic land in `instanceLease.ts`, but the guard has **no consumer**: grep confirms `isFencedStale` / `.generation` are referenced only within `instanceLease.ts` (definition + the acquire/reacquire write) — the token is not yet threaded onto a side effect nor checked at any target. The module's own docstring states this wiring is deferred.

**Residual risk: LOW / acceptable.** No-duplicate-external-write does NOT depend on fencing: it is already guaranteed by the §8 envelope (idempotencyKey + canonical object key + pre-write existence check + stored-receipt replay), which `recoverRun` and the degraded-drain both reuse. The lease's durable-reserve + atomic `compareAndSet` + single-owner reacquire already prevent split-brain ACQUISITION (a paused holder loses the CAS on renew; a store fault / lost race fails closed to `passive`). Fencing closes only the narrower Mac-sleep window where a paused prior holder ACTS inside its not-yet-expired TTL — and even there the external-write envelope's existence-check + receipt still block a duplicate write. So the unwired token is a defence-in-depth gap, not a duplicate-write or split-brain exposure. Consistent with the Phase-7 / Phase-3 deferral posture; track it as a wiring item for the app-shell wave.

## 7. Deferred app-shell wiring — UNREACHABLE-BY-DESIGN (not a defect)
Per the dispatch waiver (mirrors Phase 7): loopback tRPC/WS mount in the running bootstrap, persistent `@sow/db` store swap into the live proof-spine, Electron-main supervisor spawn (apps/desktop → Phase 9), backup cron scheduler, and the live renderer WS handshake are intentionally deferred. Leaf modules are unit + conformance tested and importable via the subpath export map. Classified UNREACHABLE-BY-DESIGN / deferred, NOT a reachability defect.

---

### Findings ledger
| # | Severity | File:area | Note | Action |
|---|---|---|---|---|
| 1 | LOW | `apps/worker/src/lease/instanceLease.ts` — `isFencedStale` | Fencing token minted but not threaded to any side-effect target; no consumer. No-dup-write already guaranteed by §8 envelope + CAS + single-owner reacquire. | defer (app-shell wiring wave) |
| — | (accepted residual) | `packages/domain/src/redaction/redaction-rules.ts` — id-charset pass | A non-credential-shaped, id-charset secret CALLER-mislabeled under a `*Id`/`*Ref` field passes verbatim. Bounded (caller-chosen name, enum id-fields excluded, ≤128 charset-limited). | accept (documented) |

**Test evidence:** `@sow/domain` 276/276 · `@sow/worker` 268 pass/5 skip · `@sow/evals` conformance 119/119 (redaction / system-health / lifecycle / supervision-degraded all green).

**Verdict: CLEAR** — no critical/high; the two residuals are bounded and pre-accepted; deferred app-shell wiring is UNREACHABLE-BY-DESIGN.
