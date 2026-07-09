# Team handoff 002 — §13.10a Copilot→KMP bridge: built end-to-end + DORMANT (resume state)

**Date:** 2026-07-08 · **HEAD:** `de8ca9e` · **Repo-wide gate:** `pnpm -w turbo run typecheck test` → 31/31.
Companion: session doc `docs/sessions/049-2026-07-08-copilot-kmp-bridge-FGH.md`; memory `sow-kmp-bridge-finish` (READ FIRST) + `sow-copilot-kmp-bridge` (per-slice arc).

## Where the bridge stands
The §13.10a Copilot semantic-write bridge is **BUILT END-TO-END (Slices A–H) and DORMANT.** The full deterministic path exists: model intent → `deriveCopilotProjectKnowledgePlan` (validated KMP) → `copilot.propose_knowledge` tool → sink → a PENDING §9.8 semantic-mutation Approval + a pending-KMP row → on owner approval, `semanticMutationDispatch` commits the KMP through KnowledgeWriter (the sole writer). The desktop inbox now renders the semantic card distinctly.

Commits (all on `main`, reviewed, unpushed until this close-out):
`dd2915b` A · `d38a319` B · `715766b` C · `e1e83f3` D · `2718f35` E · `11faf76` F · `d6a1983` G1 · `09218b6` G2 · `de8ca9e` H.

Nothing runs live: prod `dispatchApproval` is a no-op stub, and no runner exposes the tool to a model.

## What REMAINS (the live wiring + the go-live gates)
- **G3 — providers SDK-MCP adapter** `createCopilotProposeKnowledgeMcpServer` (mirror `createCopilotProposeMcpServer`; `packages/providers`, zod, eval-gated).
- **G4 — runner + boot flag** `copilotProposeKnowledge` (OFF; mirror `copilotProposeMode`). The runner MUST (a) server-bind `workspaceId`, (b) resolve `noteExists` at call time against `projectNotePath(workspaceId, projectId)` (the SAME authority derive uses), (c) route the semantic dispatch into `dispatchApproval` via `createApprovalDispatchRouter`.
- **Go-live gates — ALL fail-CLOSED today, documented in-code:**
  1. **Slug-collision** — on a NotePatch, verify the existing note's frontmatter `projectId` before applying. Needs a Slice-B/contract follow-up to carry the intended projectId to the executor + a frontmatter reader (the KMP patch carries no projectId).
  2. **YAML-escape** frontmatter values in KnowledgeWriter `serializeScalar` (first untrusted→frontmatter exposure).
  3. **FG-2 persisted-form hashing** — before admitting any producer that can emit a schema-legal present-`undefined` value (today's `deriveCopilotProjectKnowledgePlan` emits none, so FG-2 holds).
  4. **C5.4b real serving oracle** (provenance-stamping — shared Tier-4 precondition).
- **C6 governance eval** (`packages/evals` = eval-security track — coordinate; don't touch `../SoW-build-evalsec`).

## Method / discipline (carry it)
- Reviewer subagents are gone → run each safety-critical slice's review via a **general-purpose Agent** given security + code-quality prompts (F and G got one; H was inline — small, additive, enum-only). Adversarial pass is mandatory for the safety-critical slices.
- TDD for deterministic code; per-file `git add` (never `-A`/`.`); NEVER stage `.claude/settings.json`, root `CLAUDE.md`, `graphify-out/`. `graphify update .` after code changes. Repo-wide gate after any contract/DB/cross-package change.
- ENVIRONMENT: if reads under `~/Documents/` fail with "Operation not permitted" on a normal file, it's a macOS TCC / Full-Disk-Access revocation — quit + relaunch the host app + a fresh session (a running process can't recover a mid-session TCC grant).
