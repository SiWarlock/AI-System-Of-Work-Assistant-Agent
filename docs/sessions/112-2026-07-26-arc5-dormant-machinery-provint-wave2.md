# Session 112 — ARC-5 dormant machinery (provint Wave-2)

- **Date:** 2026-07-26
- **Phase:** Part-II Wave-2 (ARC-5 dormant machinery — build-behind-the-line; §13.2 / §13.13 / §21.1-2 / §21.10 / §21.3)
- **Role:** provint-implementer (single-track `main`; owns `packages/providers`, `packages/policy`, `packages/integrations`)
- **Predecessor:** (fresh provint spawn — no prior provint session doc this arc)
- **Successor:** _(next provint session — TBD; set on spawn)_

## Why this session existed

The ARC-5 dormant-machinery arc: build every mechanism the owner-gated crossings later arm — all default-OFF, byte-equivalent shipped, real transports/keys/writes held behind §ARM-* owner crossings. Seven slices dispatched by main-orchestrator, TDD, security-reviewer=invariant each.

## What was built (7 slices, 8 commits — all dormant / byte-equivalent)

**Files created:**
- `packages/integrations/src/tools/write-adapter-registry.ts` (#23 `07145feb`) — per-`TargetSystem` write-adapter routing registry: exhaustive `Record` + `Object.hasOwn` prototype-safe fail-closed `selectWriteAdapter` + `createUnroutedWriteAdapter` sentinel + `dispatchRouted` (env↔action guard). Closes G15/G16.
- `packages/providers/src/model/research-provider.ts` (#34 `4a3ea13e`) — RES-1 Perplexity Sonar + Grok Live Search ModelProviderPort (each own processor, citations verbatim, broker egress-veto-first).
- `packages/integrations/src/connectors/adapters/free-source-aggregator.ts` (#34 `727f3bd2`) — key-less aggregator that SELF-runs the real `@sow/policy` egressVeto over a synthetic egress-classed cloud route (gates identically; `--academic`).
- `packages/integrations/src/connectors/adapters/web-fetch-transport.ts` (#45 `3c501687`) — web source real-parse: pure ReDoS-safe `parseReadabilityHtml` (tag-strip) + SSRF-guarded `createWebFetchTransport` over an injected httpGet.
- Test files (one per slice): `test/write-adapter-registry.test.ts`, `test/research-provider.test.ts`, `test/free-source-aggregator.test.ts`, `test/web-fetch-transport.test.ts`, `test/credential-seam.test.ts`, `test/connector-todoist-transport.test.ts`, `test/connector-telegram-transport.test.ts`.

**Files modified:**
- `packages/integrations/src/tools/adapters/adapter-core.ts` + `tools/gateway.ts` (#41 `e023f682`) — 21.10-core external-write credential seam: optional `WriteSecretsAccessor` + `writeSecretRef(targetSystem)` (17.4 ref) + a dispatch-time fail-closed gate (unavailable/empty/throw ⇒ `held`; token value read only for the non-empty check, never logged).
- `packages/integrations/src/connectors/adapters/todoist.ts` (#48 `6facc356`) — added the read TRANSPORT half (`createTodoistHttpTransport` + `TODOIST_HTTP_SPEC`, Context7 v1 `{results,next_cursor}` wire shape). Connector pre-existed.
- `packages/integrations/src/connectors/adapters/http-transport.ts` + `telegram-capture.ts` (#49 `15a90ed4`) — added a shared `pathAuth` template mode (token-in-URL-path, safe-path allowlist, never-logged, Bearer branch byte-equivalent) + the Telegram `getUpdates` transport. **Closes task 21.3.**
- `packages/providers/src/index.ts`, `packages/integrations/src/index.ts`, `.../connectors/adapters/index.ts` — barrel exports (additive).

## Decisions made

- **Registry (#23):** exhaustive `Record<TargetSystem,adapter>` (compile-time completeness) + `Object.hasOwn` runtime guard (closes the prototype-pollution fail-open, providers L13). Code-only fault (rule 7). Kept the composition-root binding a separate worker task (logic-in-package).
- **Research (#34):** provider = broker run-leg (veto-first is a broker property, perplexity/xai cloud-by-construction via absence from LOCAL_PROVIDERS); aggregator SELF-runs the real veto over a synthetic egress-classed route (the sharp fail-open pin: `processorOfRoute !== null`). Emit-all candidate data, citations verbatim.
- **Web (#45):** deterministic tag-strip parse (no jsdom); real `@mozilla/readability` = §ARM-23 swap. `<[^>]*(?:>|$)` (linear + strips unterminated tags), `Number.isInteger` 2xx gate, decode-before-collapse.
- **Credential seam (#41):** optional accessor → byte-equivalent when absent; `held` (retryable) on unavailable; `WriteSecretsAccessor` naming avoids the connectors' read-auth `SecretsAccessor` barrel collision.
- **Todoist (#48):** built against the CURRENT Todoist unified **v1** API (Context7-grounded), superseding the brief's legacy REST v2 (ground-on-Context7 wins, L3/L21).
- **Telegram (#49):** extended the single vetted `createConnectorHttpTransport` with an additive `pathAuth` mode (token-in-URL-path) rather than a bespoke transport (L4); safe-path ALLOWLIST per the orch TWEAK (L12/L13); fail-fast on a missing `{token}` placeholder; updates emit type-agnostic (raw per update_id; immutable ⇒ id-is-the-token).

## Decisions explicitly NOT made (deferred)

- All real transports / keys / network I/O / real writes — owner-gated §ARM-23 (web/todoist/telegram real fetch+token, DNS-rebind resolved-IP re-check), §ARM-RESEARCH (real Perplexity/xAI transport+paid keys), §ARM-21 (real write transport ⟺ credential accessor arm-together coupling + token→header binding).
- Worker composition-root bindings (write-registry into backends.ts — done as a worker task #29; research-provider broker registration; credential-seam getSecret bind) — logic-in-package, worker binds at boot.
- The frozen-contract `perplexity`/`xai` ProviderId round was a separate contract task (landed `50b302b0`).

## TDD compliance

**Clean.** Every slice: RED test written first (confirmed module-not-found / undefined-export failure), then GREEN. Model/provider-driven legs (research-provider extraction, aggregator) are candidate-data emit-only over faked transports — deterministic-testable; the LLM output itself is eval-path (evalsec follow-ons flagged). No TDD violations.

## Reachability

All 7 slices ship DORMANT behind unbound seams by design — reachability-WAIVERED until the owner arming crossing binds a real transport/key. Confirmed at each Step 7.5: exported from the package barrels for the arming binding; a `dormant_no_real_caller` scan pins zero production callers. Not a silent gap — the unbound state is the intended shipped default (§ARM-23/§ARM-RESEARCH/§ARM-21).

## Open follow-ups (Step-9 categorized — all routed hot to main-orchestrator during the session)

- **§ARM-23 (web/todoist/telegram arming):** bind real transports + tokens; field-confirm the candidate wire shapes (readability, todoist v1, telegram getUpdates) against live APIs; the inherited DNS-rebind resolved-IP re-check; no-cross-host-redirect re-guard (web).
- **§ARM-RESEARCH (research arming):** real Perplexity/xAI transport + paid keys; leave the injectable veto/vetoFn UNDEFINED in prod; allowlist the research processors; aggregator AbortSignal-awareness. Egress-leakage DoD eval = evalsec (#42, landed).
- **§ARM-21 (write arming):** the real write transport ⟺ `WriteSecretsAccessor` MUST bind together at boot (no compile-time coupling); auth-ref alignment; outbox drain policy for non-transient credential faults.
- **Worker bindings:** research-provider broker registration; credential-seam `getSecret` bind in backends.ts.
- **Consistency (owner call):** SecretsPort shape triplicated (providers/connectors/tools) → a shared `@sow/contracts` SecretsPort would collapse them.
- **Arch-doc notes (orchestrator writes at /orchestrate-end):** §8/§19.8 candidate wire-shape notes for each dormant connector/provider + the template's new `pathAuth` token-in-URL-path mode.
- **Lessons (orchestrator banks to LESSONS.md):** one convention candidate per slice (prototype-safe registry; broker-veto-first research + synthetic-egress-route aggregator; ReDoS-safe tag-strip transport; dispatch-time credential seam; connector template = asana pattern + Context7-current-API-wins; pathAuth additive template mode L4/L12/L13).

## Cross-doc invariant audit

Clean — **no frozen-model field changes this session**. All slices reuse `TargetWriteAdapter`/`ExternalWriteEnvelope`/`ProviderRoute`/`WebPage`/`WebFetchTransport`/`RegisterSourceInput`/`ConnectorPort`/`ConnectorTransport`/`TransportItem` as-is. `ARCHITECTURE.md` untouched by this session (verified `git diff -- ARCHITECTURE.md` empty). No cross-doc drift.

## Status

Task 21.3 (read/write connector symmetry, #27 owner decision) CLOSED by #48 + #49 (both read connectors dormant). Session drained at HARD-STOP; over to the lead for shutdown + fresh-provint respawn.
