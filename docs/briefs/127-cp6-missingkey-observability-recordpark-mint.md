# /tdd brief — missing_key_observability_and_recordpark_mint

## Feature
A **BUNDLE** of two small, additive, low-risk operational hardenings (both #13 arming must-fixes):
- **(a) missing-key silent-hold observability** — the 17.3 lock-routing accessor mints a `HealthItem` on `locked` but NOT on a genuinely **missing** (un-provisioned) key, so a job that HOLDs pending key provisioning is a *silent* hold. Mint an operator-visible `HealthItem` on the missing-key hold too — redaction-safe (rule 7), distinct from `locked` and from an `invalid_ref` config error.
- **(b) recordPark propagate-or-mint (L25)** — `createDurableMeetingParkPort` writes `auditRef: null`, so a parked source is un-auditable. Propagate an existing audit ref if the caller supplies one, else MINT one (never `null`).

**SAFE-BUILD: no behavior change to the fail-closed HOLD/park itself — purely additive audit/observability; NO real key, NO spend.**

## Use case + traceability
- **Task ID:** 18.16 (CP-6; two #13 operational must-fixes, bundled)
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (primary — the arming observability), `§9` (the ingestion/park path).
- **Related context:**
  - **(a)** `createLockRoutingSecretsAccessor` (worker Lesson 41): today `locked` → `onKeychainLocked` mints a keychain-locked `HealthItem`; `missing`/`denied` fail closed WITHOUT minting (deliberate — an `invalid_ref` config error must not be mislabeled a retryable lock). The #13 gap: a genuinely-missing (not-yet-provisioned) key produces a *silent* HOLD — the operator can't see that a job is stuck pending provisioning. Add a distinct **missing-key `HealthItem`** ("credential not provisioned") on that path — WITHOUT changing the fail-closed behavior, WITHOUT minting on an `invalid_ref` config error, and value-free (rule 7 — the health signal carries only safe codes/refs, never the key or its raw ref; mirror L25's safe-redacted-code minting).
  - **(b)** `createDurableMeetingParkPort` (`apps/worker/src/composition/dispositionDurable.ts:236`) sets `auditRef: null` on the park row. L25 (propagate-or-mint): the park should carry an audit ref — propagate the caller's if present, else mint a stable one — so the park is auditable (the disposition store is operational truth, §16).

## Acceptance criteria (what "done" means)
- [ ] **(a) missing-key hold mints a redaction-safe HealthItem** — a genuinely-missing key on the lock-routing accessor path mints a distinct `HealthItem` (credential-not-provisioned) for operator visibility; the HOLD stays fail-closed (no plaintext, no behavior change). The HealthItem is **value-free** (safe code + subject ref only — never the key or its raw ref; rule 7).
- [ ] **(a) an `invalid_ref` config error still does NOT mint the missing-key item** (L41 — a config error is not a missing-provisioning signal); `locked` still mints its own item; the three cases stay distinct.
- [ ] **(b) recordPark carries a non-null audit ref** — `createDurableMeetingParkPort` propagates an existing `auditRef` if provided, else mints a stable one; a parked row is never `auditRef: null`. Re-park under the same key reuses the prior ref (idempotent, mirrors the disposition CAS, worker L36).
- [ ] **SAFE-BUILD / byte-equivalent on the happy path:** no change to the HOLD/park success behavior; purely additive audit/observability. No real key, no spend.
- [ ] All unit tests pass; `/preflight` clean.

## Wiring / entry point (Step 7.5)
Both sites are already production-wired: the lock-routing accessor is the credential seam (17.3), `createDurableMeetingParkPort` is the park path (15.x). This slice adds a HealthItem mint (a) + a non-null audit ref (b) at those existing seams — no new reachability.

## Files expected to touch (trace exact at Step 1)
- **(a)** the 17.3 lock-routing accessor site (`apps/worker/src/composition/` — trace from `createLockRoutingSecretsAccessor` / `keychain-boot`); the missing-key HealthItem mint (reuse the `onKeychainLocked` HealthItem-minting pattern, safe-code-only).
- **(b)** `apps/worker/src/composition/dispositionDurable.ts` (`createDurableMeetingParkPort` — the `auditRef` propagate-or-mint).

## RED test outline (Step 2)
1. **`missing_key_hold_mints_redaction_safe_healthitem`** — a missing key ⇒ a distinct HealthItem minted, carrying NO key/ref value (assert the safe fields only); the result is still the fail-closed Err.
2. **`invalid_ref_config_error_does_not_mint_missing_key_item`** — an `invalid_ref` ⇒ no missing-key HealthItem (stays distinct from missing; L41 preserved).
3. **`locked_still_mints_its_own_item`** — `locked` behavior unchanged (non-regression).
4. **`recordpark_propagates_existing_auditref`** — a caller-supplied auditRef is written (not null).
5. **`recordpark_mints_auditref_when_absent`** — no caller auditRef ⇒ a stable minted ref (never null); a re-park under the same key reuses it (idempotent).

## Cross-doc invariant impact
- **Model field changes:** none — reuses `HealthItem` + the disposition row shape (`auditRef` already exists, currently null). Confirm at Step 9.
- **Shared-contract seam model touched?** No.

## Things to flag at Step 2.5
1. **Missing vs invalid_ref discrimination** — confirm the accessor can distinguish a genuinely-missing (un-provisioned) key from an `invalid_ref` config error at the mint site (only the former mints the provisioning HealthItem). If the current typed error doesn't separate them cleanly, flag it (may need a distinct error kind — a small contracts touch).
2. **HealthItem redaction** — confirm the missing-key HealthItem carries only safe codes + a subject ref, never the key/ref value (rule 7). Default: mirror L25/L41's safe-redacted-code mint.
3. **Bundle cohesion** — (a) and (b) are independent low-risk hardenings; confirm they stay in one focused commit (per the bundle scope) or split if the discrimination in (1) grows.

## Dependencies + sequencing
- **Depends on:** 18.1 / 17.3 (the lock-routing accessor — landed) for (a); the 15.x park path for (b). Independent of GATE-1 — Wave-1 parallel-eligible.
- **Blocks:** nothing hard; both are arming observability must-fixes.

## Estimated commit count
**1** — the bundled hardening (worker). **security-reviewer** (the missing-key HealthItem touches rule-7 redaction of the health signal) + code-quality = every-slice. BUNDLE (per the round scope).

## Lessons-logged candidates anticipated
- **Convention candidate** — a fail-closed credential HOLD gets operator observability without weakening fail-closed: a genuinely-missing (un-provisioned) key mints a redaction-safe provisioning HealthItem, kept distinct from a `locked` signal and an `invalid_ref` config error; a durable park always carries a propagated-or-minted audit ref (never null, §16 operational truth).

## How to invoke
1. Read this brief end-to-end.
2. Run `/tdd missing_key_observability_and_recordpark_mint` in `worker-impl3` (after CP-4 commits).
3. Step 0 — SAFE-BUILD; additive observability/audit; no HOLD/park behavior change; no real key.
4. Step 1 — trace the 17.3 accessor mint site + `createDurableMeetingParkPort`.
5. Step 2.5 — write-up + the 3 questions → me.
6. Step 8 — security-reviewer (rule-7 HealthItem redaction) + code-quality.
7. Step 9 — flags + ship-ask.
