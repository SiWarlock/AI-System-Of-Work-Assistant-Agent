<!--
  TEMPLATE: area CLAUDE.md → write to <code-area>/CLAUDE.md (e.g. app/CLAUDE.md).
  One per code area. For a multi-area project, generate one per area, each with
  its own stack + launch-protocol row. Keep the launch protocol, session
  start/end protocol, cross-doc-invariants discipline, layer rule, and
  lessons-index meta-rules VERBATIM — those are workflow machinery. Fill the
  stack + commands; leave the lookup table, forbidden patterns, cross-doc table,
  and lessons index near-empty (1-2 illustrative rows + a "populate as you go"
  note). Delete this comment.
-->

# System of Work Assistant `packages/providers/` — Build Guide

> **You're in `packages/providers/`.** This file plus root `CLAUDE.md` both load. The root file covers global project conventions + shared comm rules (track-prefix, escalation taxonomy, messaging budget); this file owns code-area conventions for providers, policy & integration gateways.

## Launch protocol

| Working on... | cwd | Loads |
|---|---|---|
| Planning / docs / commits | repo root (`SoW-build/`) | root `CLAUDE.md` only |
| providers, policy & integration gateways code | `packages/providers/` | this `CLAUDE.md` + root |

<!-- For a multi-area project, add a row per additional code area. -->

If you find yourself fighting the wrong conventions, check your cwd.

## Session start/end protocol

**At session start:**
1. Read `IMPLEMENTATION_PLAN.md` (repo root) **by section, not whole** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for offsets, then Read with offset/limit just "Currently in progress" + the active phase. (The file grows; never load it whole.)
2. Confirm with the user what feature this session is targeting.
3. Read the relevant section of `ARCHITECTURE.md` from the lookup table below.

**At session end** (only when the user explicitly says we're done):

1. **Implementer runs `/session-end`.** Implementer writes ONLY:
   - `packages/providers/` code files (the slice's implementation)
   - test files (the slice's tests)
   - dependency manifest / lockfile (deps the slice adds)
   - `docs/sessions/<NNN>-<date>-<topic>.md` (session doc, created at `/session-end` Step 5)

   **Implementer must NOT touch (all orchestrator territory).** *This list is the canonical statement
   of the territory rule — `/session-end`, the brief template, and the generated
   `scripts/guards/territory-guard.sh` PreToolUse hook (which mechanically enforces it in team mode)
   all point here.*
   - `IMPLEMENTATION_PLAN.md`
   - `packages/providers/LESSONS.md`
   - `packages/providers/CLAUDE.md` (entire file — both the Cross-doc invariants table AND the Lessons logged index)
   - `ARCHITECTURE.md`
   - `docs/orchestrator-briefing.md` / `docs/tdd-brief-template.md` / `docs/briefs/` / `docs/runbooks/`
   - other top-level deliverable / design docs
   - `.gitignore` and root-level dotfiles (unless adding a new artifact to ignore, flagged at Step 9)

   At Step 10: **explicit `git add <path>` per slice file; never `git add -A`/`.`; never stage an orchestrator-territory file.** Changes to any orchestrator-territory file (a new cross-doc model, a lesson, an arch note) are **flagged at Step 9**, not edited here — the orchestrator writes them hot (root `CLAUDE.md` + the Step-9 matrix).

2. **Orchestrator runs `/orchestrate-end`** for round close-out + Carry-forward triage + round terminal commit + push.

## Lookup table — where to find canonical info

Don't paste these sections into the prompt. Grep the file:section, read only what you need. `/check-arch <topic>` dispatches off this table.

| Topic | File (relative to repo root) | Section |
|---|---|---|
| <subsystem A> | `ARCHITECTURE.md` | §X |
| <subsystem B> | `ARCHITECTURE.md` | §Y |
| Lessons logged (full prose) | `packages/providers/LESSONS.md` | by lesson # |

<!-- Starts near-empty. Add a row whenever a topic is looked up twice. -->

**Code intelligence & docs (when available):** prefer a code-intelligence MCP / docs MCP over grep+read loops — see root `CLAUDE.md` "Code intelligence & docs."

## Stack

<!-- ▼ EXAMPLE BLOCK [id=area-stack]: stack quick-reference for implementer sessions. Canonical stack lives in root CLAUDE.md + ARCHITECTURE.md; this is the cheat sheet. ▼ -->
- **Runtime:** Node 22 LTS + TypeScript 5.x (strict)
- **Stack:** AgentRuntimePort (Claude Agent SDK · Hermes) + ModelProviderPort (Claude/OpenAI/OpenRouter/Ollama/LM Studio) · connector APIs/MCP
- **Validation:** Zod + JSON Schema (ajv)
- **Lint / types / tests:** ESLint / tsc --noEmit / Vitest
- **Territory (this track owns):** `packages/providers/, packages/policy/, packages/integrations/`
<!-- ▲ END EXAMPLE BLOCK [id=area-stack] ▲ -->

## Standard commands

```bash
# Install deps (run once; re-run when the manifest changes)
pnpm install

# Run the dev server (if applicable)
pnpm --filter <pkg> dev   # e.g. desktop / worker

# Tests
pnpm test

# Quality
pnpm lint
pnpm format:check
pnpm typecheck

# Preflight (use before saying "done" with a feature)
pnpm lint && pnpm typecheck && pnpm test
```

## TDD protocol

**Write the failing test first.** Applies to deterministic code — see the TDD posture in root `CLAUDE.md` for what is test-first vs. exempt.

**Commit per slice when practical.** Never bundle a safety-critical slice with anything else.

## Forbidden patterns

<!-- ▼ EXAMPLE BLOCK [id=forbidden-patterns]: forbidden patterns — 3-5 narrow, enforceable, domain-specific rules. Shape: "Don't <pattern X> because <reason / past incident>; use <alternative Y>." Test-pin them where possible. Starts small; accretes as lessons surface. ▼ -->
Do not:

1. **Write code without a failing test first** (deterministic code; provider behavior is conformance-tested).
2. **Let any provider/runtime output reach a write adapter without passing the JSON-Schema gate + validator first** — provider output is candidate data until validated (REQ-S-006); the strict side-effect rule is `output → schema gate → validator → KnowledgeMutationPlan/ProposedAction → KnowledgeWriter/Tool Gateway`.
3. **Select a cloud provider for an Employer-Work AgentJob carrying raw content with egress ack = false** — the egress veto requires a local-only provider or fail-closed; OpenRouter is its OWN processor, never an OpenAI-compatible alias.
4. **Admit an untrusted-content job whose ToolPolicy admits a mutating tool** — the ING-7 admission gate rejects it (keys off `AgentJob.trustLevel`/`carriesRawContent`).
5. **Create an external object without a pre-write existence check by canonical key** — vendor create-tools lack native idempotency; match-then-reuse-on-hit, and replay reuses the receipt (no duplicate external writes).
<!-- ▲ END EXAMPLE BLOCK [id=forbidden-patterns] ▲ -->

## Cross-doc invariants — schema/docs mirroring

Several typed models in this codebase are **contracts** mirrored in `ARCHITECTURE.md` and indexed in the table below. The architecture doc is the canonical contract; the model is the executable enforcement. Drift produces silent disagreement.

**Authoring discipline (orchestrator owns this table).** The implementer never edits this table or `ARCHITECTURE.md` directly — it flags a field add/remove/rename at Step 9 as a `Cross-doc invariant change`; the orchestrator writes the row + the arch edit hot the same round (see root `CLAUDE.md` + `docs/orchestrator-briefing.md`). Commits stagger; the working tree stays aligned within the round.

| Model | `ARCHITECTURE.md` section | Notes |
|---|---|---|
| <model> | §X | <field summary> |

<!-- Starts empty (or with the first model if one exists). Populated as contract models land. -->

## Module organization

<!-- ▼ EXAMPLE BLOCK [id=module-layout]: module layout + layer dependency rule. Replace with the project's real directory tree and import-direction DAG. ▼ -->
```
packages/providers/     ModelProviderPort + AgentRuntimePort adapters · Runtime/Provider Broker · conformance harness
packages/policy/        workspace policy · provider×capability matrix · EgressPolicy veto · ToolPolicy/ING-7 admission · approval policy · visibility levels · session-token auth primitive
packages/integrations/  Connector Gateway (reads) · Tool Gateway (external-write envelope) · NotebookPort
```

Layer dependency direction: `{providers,integrations} → policy → {domain,contracts}`. Policy is upstream of providers/integrations/knowledge/workflows.
<!-- ▲ END EXAMPLE BLOCK [id=module-layout] ▲ -->

## Subagents

See `.claude/agents/README.md` for the canonical inventory + integration points.

<!-- ▼ EXAMPLE BLOCK [id=area-subagent-candidates]: area-specific subagent candidates — list candidates that would earn their keep specifically in this area (e.g. an ABI/types syncer for a frontend area, a Pyth/feed verifier for a contracts area). Build only on real friction. ▼ -->

<!-- ▲ END EXAMPLE BLOCK [id=area-subagent-candidates] ▲ -->

## Lessons logged from prior sessions

The full prose for each lesson lives in `packages/providers/LESSONS.md`. This index is the compact orientation surface.

**Lesson numbers are stable IDs** — once assigned, they don't change. New lessons get the next sequential number. `/session-end` proposes additions when it detects them; the user approves before the entry is written and a row is added here.

Lessons start at §1.

| # | Date | Topic | Rule (one-liner) |
|--:|---|---|---|
| [1](LESSONS.md#1) | 2026-06-30 | Hermes empty toolset → full mutating fallback | A read-only / ING-7 Hermes run MUST pass an explicit, asserted-non-empty minimal toolset; empty `-t` silently falls back to the full (mutating) config toolset. |
| [2](LESSONS.md#2) | 2026-07-15 | Reusable connector HTTP transport over an OUTBOUND-inverse SSRF predicate | A real read-only connector HTTP transport is a reusable `createConnectorHttpTransport(spec, deps)` producing a `ConnectorTransport` — SSRF-guard (the vetted OUTBOUND-inverse `isAllowedRemoteEndpoint`: https + allowlisted-host + reject-loopback, composed once, never re-parse) on the FINAL url BEFORE token+dispatch · token header-only/fail-closed-even-on-throw · redacted typed `TransportFailure` behind a positive-2xx gate · wrapped spec callbacks · vendor wire shape a documented `arch_gap` candidate · ING-7 GET-only · `payloadHash` for the contentHash · `readScope` single-sourced at the adapter; real transport+secrets UNBOUND at boot (byte-equivalent); connectors specialize with a per-vendor spec. |
| [3](LESSONS.md#3) | 2026-07-15 | Ground connector wire shapes on Context7; back-verify memory-built ones | Ground every connector's candidate wire shape on Context7 at authoring (endpoint/params/pagination/response/id/fault-map — never training memory or a single fetch); back-verify any connector built pre-Context7 with a field-by-field diff (conformant ⇒ citation comment; drift ⇒ a TDD correction, fail-closed). A memory-authored candidate can silently defeat its own design intent (round-3 caught: a missing Asana `opt_fields` dropped the `modified_at` change token the dedupe hash relies on) while every test still passes; a vendor-required param needing owner data (scope GID, calendarId) is a NAMED arming gap. |
| [4](LESSONS.md#4) | 2026-07-15 | Widen `mapPage(json)`→`mapPage(json, request)` additively for page-number/bare-array connectors | When a connector pages by page-number/Link-header over a bare-array body (no in-body cursor, e.g. GitHub), widen the shared `mapPage` seam ADDITIVELY to `(json, request)` rather than fork the template — backward-compatible by function-param contravariance (existing 1-arg mappers byte-unchanged + green = the proof), rule-7-safe by passing only the token-free `TransportRequest` (pin: no Authorization/token in the mapPage arg). Single-source `per_page` across `buildQuery` + the `done = len < per_page` compare; STRICT `^[1-9][0-9]*$` page-cursor parse (no `Number()` coercion) so a tampered cursor fail-safes to page 1. |
| [5](LESSONS.md#5) | 2026-07-15 | GraphQL-over-POST read connectors: fixed query-only body, params via `variables`, fail-closed on the 200-`errors` array | For a GraphQL-over-POST read connector (e.g. Linear): send a FIXED compile-time query-only body (a `query`, never a `mutation` — pinned by a no-`mutation` test; the transport can't inspect an opaque body ⇒ read-only is the SPEC's contract + review, NOT the method); pass params via `variables` built with `JSON.stringify` (never interpolate input into the query — pinned by a mutation-injection-cursor test); fail closed in the mapper on a top-level `errors` array BEFORE reading `data` (GraphQL returns HTTP 200 on a query error, so the status is not the error signal). SSRF/rule-7 inherited (guard method-agnostic on the final url; token Authorization-only). |

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->
