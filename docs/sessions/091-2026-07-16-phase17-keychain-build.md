# Session 091 — 2026-07-16 — Phase 17: Keychain Secrets Activation (BUILD complete; crossing PENDING)

**Team:** lead-carried orchestrator + worker-impl4 (17.1/17.2, then CYCLED at 86%) → worker-impl5 (successor: 17.3/17.4) + integrations-impl (warm). desktop-impl stood down. Single-track `main`.
**Span:** origin/main `44ec4253` → `<this round-close>` (4 build slices + round-close). **Posture: the FIRST hard-line phase — the whole BUILD landed on the SAFE side, NO hard line crossed. The owner provisioning+arming crossing is PENDING (owner-gated).**

## What Phase 17 delivered (build)
Every slice was a VERIFICATION pass over already-built machinery (Lessons 9/10/11 built the SecretsPort adapter + CLI reader + boot gate) plus a small defense-in-depth hardening on the credential trust boundaries — no real Keychain, `security` process, or provisioning anywhere (all mock/inert).

- **17.1 `8ebb55ff` (G47)** — KeychainSecretsAdapter core: the adapter now de-aliases a backend hit into an INDEPENDENT `Uint8Array` at the trust boundary (doesn't trust the swappable backend to have de-aliased; an aliasing leak = key exposure, rule 7). Zero-length reject before the copy.
- **17.2 build `2737e0df` (G48 build half)** — the no-shell `execFile` `security`-CLI wrapper: a code-0 stdout > 4KB rejects to `backend_error` (max-length guard; the wrapper doesn't trust the injected exec to bound stdout). Checked on the raw length before de-alias.
- **17.3 build `09e0630e` (G49 build half)** — `createLockRoutingSecretsAccessor`: a `locked` Keychain routes to `KeychainLockController.onKeychainLocked` (keychain-locked HealthItem) AND still returns the fail-closed Err — NEVER a plaintext fallback. Routes ONLY on `locked` (a `missing`-collapsed config error must not be mislabeled). Throw-safe on BOTH injected seams (facade + router). Landed the deferred `onKeychainLocked` it.todo. **Boot binding deferred to Phase 18** (the ModelProvider/Stamper deps don't exist yet — wiring an unconsumed seam = dormant-on-dormant, L11).
- **17.4 `732be4dc`** — the secret-ref convention over `keychain://<service>/<account>`: traversal-safe by construction (build round-trip-validates through the single-sourced `parseKeychainRef`), fail-closed to null, value-free. Build-side runtime closed-set validation symmetric with parse.

## Finalized secret-ref namespace (Option A — canonical enum, no Phase-18 translation layer)
`providers/{claude,openai,openrouter}` (the `claude` account holds the Anthropic key) · `embeddings/voyage` (distinct kind — not a ModelProvider) · `sow/kw-signing` (HMAC) · `connector-read/<vendor>` + `connector-write/<vendor>` · `telegram-bot/token`.

## ⚠ THE OWNER CROSSING (pending owner go/no-go)
Provision via `security add-generic-password`: `sow/kw-signing` (HMAC, generated) + `providers/{claude,openai,openrouter}` + `embeddings/voyage`; then flip `config.keychainSecrets` present ⇒ the real backend + real read-back at boot. **G48/G49 fully close at the crossing.** GO-LIVE VERIFY: the real `security` exit codes (not-found/locked/denied) + stderr strings + key-encoding (the mock tests pinned the CLASSIFIER, not the real codes).

## Cycle
worker-impl4 hit 86% context after 17.2 → `/session-end`-style handoff recap → terminated (verified via system `teammate_terminated`) → worker-impl5 re-spawned with the hard-line discipline, carried 17.3/17.4 cleanly.

## Phase-18 follow-ups (tracked)
Bind the accessor + secret-ref convention into the real ModelProvider/Stamper deps (with a never-reject `KeychainLockController`, L21/L29); `denied`-operator-visibility (a non-"locked" signal); the connector read/write + telegram token resolution-site bindings (21/23).

## Lessons (candidates — captured in the plan gate note + commit messages; to formalize in worker LESSONS §40-42)
(40) trust-boundary de-alias/output-contract defense-in-depth; (41) degraded lock-routing accessor; (42) single-sourced traversal-safe secret-ref convention.

## Next
The owner Keychain crossing (go/no-go), then Phase 18 (§19.5 real ModelProvider — the first consumer of the getSecret accessor + secret-ref convention).
