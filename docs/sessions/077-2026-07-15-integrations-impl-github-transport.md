# Session 077 — 13.12 connector round 5: GitHub read HTTP transport + `mapPage` widening

- **Date:** 2026-07-15
- **Phase:** Go-live build round 5 (runbook Phase-8 connector round — GitHub). Team `session-734f946b`, orchestrator `orch21` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [076-2026-07-15-integrations-impl-granola-transport.md](076-2026-07-15-integrations-impl-granola-transport.md)
- **Successor:** _(next session)_
- **Commits:** GitHub + widening `66b44ee` · this session doc

## Why this session existed

Round 5 added the GitHub issues connector — the 5th `createConnectorHttpTransport` instance and the FIRST page-number paginator. Because GitHub REST paginates by page number (`?per_page&page` + a Link header) and returns a **bare JSON array** (no in-body cursor), the shared template's body-only `mapPage(json)` couldn't compute the next page — so this slice also carried a minimal, backward-compatible widening of the shared `ConnectorHttpSpec.mapPage` seam (lead-ruled Option A). DORMANT — real transport + PAT UNBOUND; binding is the owner's arming crossing (HARD LINE). NO hard line crossed.

## What was built

### GitHub transport + template `mapPage` widening (task 29, brief 080, `66b44ee`)

**Files modified:**
- `packages/integrations/src/connectors/adapters/http-transport.ts` — **the shared template widening:** `ConnectorHttpSpec.mapPage: (json) => …` → `(json, request: TransportRequest) => …`; call site `spec.mapPage(json, request)` (the closure's existing token-free request). Doc updated (additive/backward-compat + rule-7 token-free note).
- `packages/integrations/src/connectors/adapters/github.ts` — `+createGithubHttpTransport` + `GITHUB_HTTP_SPEC` (`api.github.com`/`/issues`) + `githubMapPage` (bare-array, fail-closed) + `githubBuildQuery` (single-source `GITHUB_PER_PAGE=100` + `state=all&sort=updated&direction=desc&page`) + `githubPageFromCursor` (STRICT `^[1-9][0-9]*$`) + `githubContentHash` (`payloadHash({id: node_id, updated_at})`). Existing file (mirror asana.ts) ⇒ count-pin untouched.
- `packages/integrations/src/connectors/adapters/index.ts` — barrel export.
- `packages/integrations/test/connector-http-transport.test.ts` — 2 template-widening guardrail tests.

**Files created:** `packages/integrations/test/connector-github-transport.test.ts` (27 tests).

## Decisions made

- **`mapPage(json, request)` widening (lead-ruled Option A):** a body-only mapper can't page a page-number/Link-header/bare-array API without the request cursor, so widen the seam additively rather than invent a cursor-only param (mirrors the existing `buildQuery(request)` signature). The token-free `TransportRequest` (`{cursor?, readScope}`) is passed — the PAT never rides it (rule 7). **Backward-compatible:** the 4 existing 1-arg mappers stay byte-unchanged and assign to the widened type (function-param contravariance); the extra arg is a runtime no-op. The two guardrails are pinned by tests + the 4 green vendor suites.
- **GitHub page-number pagination:** `done = json.length < GITHUB_PER_PAGE` (a short page is terminal — mirrors the Link `rel=next`-absent signal without needing headers; an exact-full final page costs one extra empty fetch, fail-safe). `nextCursor = String(page+1)` when not done. `GITHUB_PER_PAGE=100` is single-sourced across `buildQuery` + the `done` comparison (a drift would wedge paging at page 1).
- **`githubPageFromCursor` STRICT parse:** GREEN surfaced that an initial `Number()`-coercion parse accepted `"1e2"`→100 (scientific notation) — a tampered cursor could become page 100. Tightened to `^[1-9][0-9]*$` + `Number.isSafeInteger` (accepted set = exactly our own `String(n)` cursors); everything else fail-safes to page 1 (no param injection, no page loop).
- **recordId = `node_id`** (the stable global STRING id; GitHub `id` is an int). Fail-closed if `node_id` absent/non-string.
- **PRs ingested:** `GET /issues` returns PRs too (tagged `pull_request`); the candidate ingests both (repo/issue/PR scope) — filtering is an arming-era refinement (pinned by a test).
- **Static Bearer PAT** — the template's bearer-string SecretsAccessor verbatim (no OAuth; Gmail's OAuth is R7).
- **Context7 re-confirm (Step 1):** `/websites/github_en_rest` — the built candidate is CONFORMANT (host/`GET /issues`/Bearer/bare-array/`node_id`+`updated_at`/`per_page` max 100/page pagination/PR-tagging).
- **Review fold-ins:** 2 code-quality lows folded in (a `Number.isSafeInteger`-guard cursor case; a `pull_request`-tagged-entry ingestion test); 1 deferred (the `payloadHash({id: node_id})` key label — `id`=recordId is consistent across all 5 connectors).

## Decisions explicitly NOT made (deferred to arming)

- **Binding the real transport + PAT** — the HARD LINE, owner-gated. Ships dormant/unbound.
- **Minimal-scope PAT provisioning** — arming residual (`repo:read` is the informational declared scope).
- **`X-RateLimit`/`Retry-After` backoff scheduling** — arming-era (the fault map returns `auth_locked`/`rate_limited`; scheduling not built).
- **`since`/`labels`/`filter` filters + PR-exclusion** — arming-era ingestion refinements.

## TDD compliance

**CLEAN — test-first.** Both RED test files written first (GitHub → `createGithubHttpTransport is not a function`; guardrail-2 → `expected undefined to be defined`, since `mapPage` was called 1-arg pre-widening), Step-1 Context7 re-confirm + Step-2.5 approved (with an ADD: pin `buildQuery`'s `per_page`/fixed params — folded in), then GREEN. GREEN surfaced the `githubPageFromCursor` leniency + a vacuous empty-cursor assertion — both fixed within-slice (impl hardening + test correctness, not test-to-pass-a-stuck-impl). Dual-reviewed at Step 8; 2 review lows folded in. No test-after-impl, no TDD skip.

## Reachability

- **`createGithubHttpTransport`** — on the public `@sow/integrations` barrel; **DORMANT + reachability-waivered**. Production caller = the owner-arming boot binding (`createGithubConnector(createGithubHttpTransport(...))` + real HttpTransport + PAT). Verified ZERO production importers ⇒ byte-equivalent.
- **The `mapPage` widening** — additive; the 4 existing specializations + their suites stay green (backward-compat proof), and the GitHub mapper is the only 2-arg consumer.

## Open follow-ups

Step-9 categorized items (routed hot to orch21; it writes at the R5 seal / Carry-forward):
- **Architecture doc note (§8):** the connector-template `mapPage(json, request)` widening (integrations-internal template-contract evolution, backward-compat) + GitHub = the 5th Context7-grounded instance (first page-number paginator).
- **Convention candidate (providers LESSONS):** the `mapPage(json, request)` rationale — a body-only mapper can't page a page-number/Link-header/bare-array API without the request cursor; widen additively. orch21 is banking it as durable (pre-pays R6 Linear's GraphQL cursor).
- **Future TODO (arming gate):** minimal-scope PAT; `X-RateLimit`/`Retry-After` backoff; `since`/`labels`/`filter` + PR-exclusion filters; confirm the real wire shape; bind the real transport + PAT (HARD LINE).
- **Cross-doc invariant change:** NONE (the `mapPage` widening is integrations-internal, not a frozen `packages/contracts` model / no Appendix-A / no schema snapshot; `GITHUB_HTTP_SPEC` integrations-internal).

## How to use what was built

A page-number / bare-array connector = a per-vendor `ConnectorHttpSpec` whose `mapPage(json, request)` reads `request.cursor` to compute the next page (`done = len < per_page`, `nextCursor = String(page+1)`), with a strict `^[1-9][0-9]*$` page parse (single-sourced `per_page`). A body-cursor connector keeps its 1-arg mapper. Real `deps` are bound only at the owner-arming crossing.
