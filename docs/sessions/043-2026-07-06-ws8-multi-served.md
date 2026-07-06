# Session 043 — WS-8 multi-workspace serving (Option A, single-brain multi-served)

- **Date:** 2026-07-06 · **Predecessor:** `docs/team-handoffs/001-2026-07-06-ws8-scoping-resume.md` (HEAD was `a956a92`/`60af973`)
- **HEAD after:** `31adae0` (+ docs reconciliation commit) · **Gate:** repo-wide `pnpm -w turbo run typecheck test` 31/31, security-reviewer CLEAR for WS-8.

## Goal

Close the last item on the WS-8 arc: the app served exactly ONE workspace (`copilotGbrainWorkspaceId` fixed at boot; `createGbrainSubprocessRetrieval` fixture-fallbacked every other workspace), so only personal-business surfaced Copilot content. Owner: "fine with a single brain for now" → build **multi-workspace serving**.

## Decision

Design fork put to owner via AskUserQuestion. Owner picked **Option A — single-brain, multi-served** (over Option B — per-workspace brains). Rationale: matches "single brain now"; immediately useful; Option B remains the durable per-workspace-isolation target if ever wanted.

## What shipped (3 TDD slices, all WS-8 security-reviewer CLEAR — 0 crit/high/med)

Symmetric change across the two read seams: replace the fixed `servedWorkspaceId` gate with **registry membership** (`descriptorFor`), and rebind the scope (retrieval filter / agentic proxy) to the ASKED workspace per request. Mandatory filter, fail-closed for unregistered.

- **MS1 `daab098`** — `createMultiServedGbrainRetrieval` (`apps/worker/src/api/procedures/copilotGbrainSubprocess.ts`). Gate = `descriptorFor(registry, askedWs) !== undefined` (unregistered → fixture fallback, NO brain read). MANDATORY per-request `createWorkspaceScopeFilter(descriptor.workspaceId, …)` before normalize — no passthrough branch. 8 tests (incl. a non-served registered workspace reading the brain scoped to itself). Single-served `createGbrainSubprocessRetrieval` untouched.
- **MS2 `73592be`** — `gbrainProxyScopeFor?: (ws) => CopilotWorkspaceScope | undefined` on `createClaudeAgentCopilotRunner` (`copilotAgentSynthesis.ts`). When wired, `served` = "resolver returned a scope"; `proxyScope = perAskScope ?? deps.gbrainProxyScope` binds the in-process gbrain proxy to the ASKED workspace. Unregistered → tool-less; partial config → invalid_job; absent resolver → fixed single-served path byte-identical. 3 tests **drive the bound proxy handler** to prove per-ask redaction (a personal-business hit is dropped for a personal-life ask).
- **MS3 `31adae0`** — wiring. `buildCopilotDeps` (`copilotClaudeSynthesis.ts`): `gbrainWorkspaceScope` present ⇒ multi-served composite (else single-served, unchanged); removed the now-dead single-served `scopeFilter` const. `boot.ts`: `gbrainProxyScopeFor` resolver from the registry+policy replaces the fixed `gbrainProxyScope`; `workspaceId` import dropped (dead), `descriptorFor` + `WorkspaceId` added. 3 buildCopilotDeps tests (the behavior change: employer-work reads the brain scoped to itself; unregistered fails closed).

## Adversarial verification

- **security-reviewer:** CLEAR for WS-8 across all 7 axes. Confirmed: the per-ask filter/proxy binds the ASKED workspace (server-derived from the registry descriptor id, never client input); no unscoped brain read (no passthrough); `{assign, personal-business}` bridge stays sound under multi-served (unprefixed served only to personal-business, `decideHitScope` `LEGACY_NOT_SERVED` for other asks); unregistered + partial-config both fail closed with no brain read / no token mint; crafted/prototype `workspaceId` strings can't widen scope or throw (§16); propose stays structurally OFF. 2 low defense-in-depth notes (no fix).
- **code-quality-reviewer:** 1 medium + 2 low — all doc accuracy, fixed in-slice: rewrote the `createClaudeAgentCopilotRunner` docstring (stale "WS-8 by construction" claim → describes both modes), `proposeGranted` comment notes `served` widened, and documented the empty-workspace read cost.

## Live state + operator guards

Multi-served is **LIVE on boot** — worker-host already sets `copilotWorkspaceScoping: true` + `{assign, personal-business}`. Each of the 3 well-known workspaces reads the one brain scoped to itself; only personal-business has content today, so personal-life/employer-work read filtered-to-empty (honest "nothing found"). WS-8 now holds **by scope filtering, not by construction**, so the F2 field-fidelity + A1 body-embedded residuals are REACHABLE for any workspace with real combined-brain content — INERT today.

- **Add content:** `printf '…' | gbrain put "personal-life/<topic>"` — surfaces the next time you ask personal-life. **personal-life is safe.**
- **⚠ Keep EMPLOYER-WORK out of the combined brain until F2 closes** (the gate-(c) governance eval, `packages/evals`, eval-security track).

## Next (deferred — not blockers)

F2 → gate-(c) eval (the gate before employer-work joins the combined brain); A1 → ingest-time; Option B (per-workspace brains) if per-workspace isolation is ever wanted; prior open items (real Copilot model end-to-end app verification, propose go-live C5.4b, C6 skills).
