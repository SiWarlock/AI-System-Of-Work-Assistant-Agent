# Session 069 — Dormant arming-prep arc (Items 7 + 2a + 2b; Item 6 deferred)

- **Date:** 2026-07-14
- **Phase:** 13.10 — dormant arming-prep arc (the last buildable-dormant grind before the owner-gated arming gate)
- **Team:** orch18 (orchestrator) + impl20 (worker-area implementer), team `session-734f946b`, single-track on `main`
- **Predecessor:** [068-2026-07-14-impl19-reconcile-trigger-arc-and-runstandup.md](068-2026-07-14-impl19-reconcile-trigger-arc-and-runstandup.md)
- **Successor:** _(none yet — HOLDING at the arming gate)_

## Why this session existed

The reconcile-TRIGGER arc (pieces A–F2) landed dormant last round; the owner steered "stand up + run on the real vault first, don't arm yet." This session built the remaining **buildable-dormant arming-prep** items so nothing but the owner-gated arming (flag flip + Keychain signing key + live transport binding + real corpora + governance eval + owner-confirmed flip) is left. Everything ships DORMANT + byte-equivalent — **no hard line crossed** (nothing armed, no real gbrain I/O, no live transport binding, no propose flip).

## What was built

### Item 7 — reconcile armed-path health semantics (`8c559f9`)
**Files modified:**
- `apps/worker/src/boot.ts` — (7a) `createReconcileHealthSink.record` now **propagates** a `recordFailure` fault (removed the swallowing try/catch), restoring piece A's Lesson-18 `ReconcileHealthSink` contract → driver catches → `pass_faulted`. (7b) `createReconcileLogSink` now **mints a `parity_defect` HealthItem** on a `pass_faulted` outcome from the SAFE `redactedCause.causeCode` (arch_gap `pass_faulted` tag, no new `FailureClass`), via a shared `mintParityHealth` helper; the log sink stays unconditionally never-throwing.
- `apps/worker/test/boot/reconcileBootWiring.test.ts` — 7 new tests (unit + 1 driver+scheduler integration).

### Item 2a — GbrainReadClient HTTP transport (`cdbb389`)
**Files created:**
- `packages/knowledge/src/gbrain/gbrain-http-read-client.ts` — `createGbrainHttpReadClient`: the concrete read-only `GbrainReadClient.invoke` over loopback `gbrain serve --http`. Knowledge-local `HttpTransport`/`SecretsAccessor` seams (mirror the providers shapes, **no `@sow/providers` import** — layer rule); SSRF/egress guard reusing the single vetted `@sow/policy` `isLoopbackEndpoint` predicate (Lesson 4/17) + an allowlist; bearer token from `grant.tokenRef` via the injected `SecretsAccessor` (header-only, never logged); redacted typed `GbrainHttpTransportFault`; candidate op→path map (arch_gap, Lesson 21). Unbound at boot.
- `packages/knowledge/test/gbrain-http-read-client.test.ts` — 19 tests (fake transport + fake secrets, zero real I/O).

### Item 2b — reconciler DB-projection completeness hardening (`4e5f18f`; closes Item 2)
**Files modified:**
- `apps/worker/src/composition/reconcilerDbProjection.ts` — `parseGraphRead` flipped from a fail-open negative default to a **positive `env.complete === true` token** (strict, default-incomplete); **widened** the type-robust more-results rejection set (hasMore/nextPageToken/nextOffset/pageInfo.hasNextPage + truncated/cursor); added a **stated-total cross-check** (degrades on a mismatch of ANY present finite `total`/`totalCount` vs the raw row count). Coverage floor preserved (a token can't rescue a malformed/err/absent-schema read).
- `apps/worker/test/composition/reconcilerDbProjection.test.ts` — 49 tests total (new Item-2b block + existing complete/degrade cases updated to carry the positive token so each isolates its lever).

## Decisions made

- **Split Item 2 into 2a (transport) + 2b (completeness hardening)** — distinct concerns, distinct Step-2.5 questions; 2b needed 2a's wire shape. (Per brief.)
- **2a: knowledge-local seams, no `@sow/providers` import** — `knowledge→providers` is forbidden by layer direction; mirror the small shapes locally. Reused `@sow/policy isLoopbackEndpoint`/`endpointHostRef` + `@sow/domain redactString` (legal downward edges) rather than re-mirroring — a safety predicate lives once (Lesson 17).
- **2a: `getSecret`-throw wrapped fail-closed** (security-review MEDIUM) — the seam is Result-returning but the real Keychain adapter can throw; wrapped → redacted `token_unavailable`, symmetric with the transport wrapping. Fixed + re-confirmed in-slice.
- **2a: positive-2xx gate** (security-review LOW) — a non-numeric status fails closed instead of slipping past a negative range check.
- **2b: positive completeness token `env.complete === true`, STRICT** (Q1/Q2) — default-incomplete; a truthy-non-true value degrades (mirror `stamped`; the false-complete is the dangerous axis).
- **2b: stated-total → mismatch of ANY present finite total** (strengthened from the approved Q3 "first-finite-wins" per security review) — closes a self-contradictory `{total:1,totalCount:100}` false-complete; single-field cases byte-identical. Orch approved the deviation.
- **All three: the gbrain `serve --http` wire shape (op→path, completeness token, paging/total field names + per-field semantics) is a DOCUMENTED CANDIDATE (arch_gap, Lesson 21)** — parsed fail-closed, never hardcoded-as-confirmed; the real shape is confirmed at the owner's arming binding.
- **Item 6 (reconcile trigger-source wiring) — DEFERRED to arming** (orch18 assessment): not cleanly dormant-separable — the committed `revisionId` only exists post-Temporal-commit, the flush is a live timer, and it would modify the live auto-ingest run-path for a dormant-only benefit (= speculative unconsumed code). Item 6's own brief prescribed exactly this deferral if not cleanly dormant-safe.

## Decisions explicitly NOT made

- **Nothing armed** — the arming gate is the owner-gated HARD LINE. No flag flip (`reconcile`/`goLiveArmed`/`copilotProposeMode`), no Keychain signing-key provisioning, no live `GbrainReadGrant` transport binding (`makeDbAdapter` stays `() => undefined`), no real gbrain I/O, no propose flip.
- **The real gbrain `serve --http` wire shape** — not confirmed (owner-gated; cannot run the real serve now). Modeled as a fail-closed candidate; confirmation deferred to arming.

## TDD compliance

**Clean — no violations.** Every slice was failing-test-first (Item 7: 7 tests RED then green; Item 2a: 19 tests RED [module-missing] then green; Item 2b: 13 RED tests drove the flip). Every review-driven fix was also RED-first (2a getSecret-throw + status-NaN; 2b conflicting-total). Mandatory security + code-quality dual review ran on each slice (safety-critical); every actionable finding fixed + re-confirmed in-slice.

## Reachability

All three ship **dormant + reachability-waivered** (like reconcile-arc pieces A–E) — no hard line crossed:
- **Item 7** — the two sink factories are constructed only on the armed reconcile path in `bootWorker` (`createReconcileHealthSink` boot.ts:1355, `createReconcileLogSink` :1358, via `gateReconcile` default-OFF); default boot constructs neither (byte-equivalent, pinned by `reconcileGate` off_default test).
- **Item 2a** — zero production callers; the real binding (real transport + Keychain SecretsAccessor + provisioned endpoint → `makeDbAdapter`) is owner-gated arming. Injection point named in-code.
- **Item 2b** — internal hardening of `parseGraphRead`; reachable only from the dormant armed path (`bootWorker → gateReconcile → driver → getDbProjection`); `makeDbAdapter` unbound (untouched) ⇒ byte-equivalent default boot.

No tested-but-unwired gaps beyond the intentional dormancy waivers.

## Open follow-ups

**Cross-doc invariant changes:** NONE this session (Item 7 reused frozen `FailureClass`; Item 2a used existing `GbrainReadClient`/`GbrainReadGrant`; Item 2b changed completeness LOGIC, no model/schema field change). The `ARCHITECTURE.md` working-tree diff is the orchestrator's hot-routed §6/§12 arch-NOTES, not field changes.

**Step-9 categorized items (routed hot by orch18; ride its `/orchestrate-end` round commit):**
- Convention candidates (Lessons): worker §25 (dormant-era swallow→propagate + `pass_faulted` mints a HealthItem, extends §18); worker §26 (positive-token completeness contract, extends §19); knowledge §1 (read-only HTTP transport behind a mockable seam).
- Architecture-doc notes: §6 (reconcile armed-path health semantics finalized); §6/§7 (GbrainReadClient HTTP transport constructible-dormant + wire-shape arch_gap); §6/§12 (positive-token / default-incomplete completeness; paging/total fields part of the arch_gap).

**Future TODO — arming (the residual risk, deferred to the piece-D/arming binding):**
- **THE anti-false-green residual:** confirm the real gbrain graph-read completeness token + the exact more-results field-NAME set + per-field semantics (incl. `nextOffset:0`) + which total field is authoritative when the real `gbrain serve --http` is run. A real "more-results" field named OUTSIDE the candidate set would be silently missed even with the positive token if gbrain sends `complete:true` loosely — MUST close at the binding.
- Wire a bounded `AbortSignal`/timeout at the real 2a transport binding (the `send(req, signal?)` seam exists; a hung gbrain serve otherwise stalls the read).
- Confirm piece B / `ServingCoverageReader` schema-gates the transport's returned `unknown` at the candidate-data gate before it can drive a parity/coverage GREEN.
- **Item 6** (reconcile trigger-source/timing wiring) — deferred to arming (not cleanly dormant-separable).
- Finalize the precise OBS-2 dedupe `subjectRef` for reconcile health items once real defects flow.

**⇒ No more buildable-dormant slices. HOLDING at the owner-gated ARMING GATE.**
