# Team handoff 002 — §13.10a Copilot→KMP bridge: built end-to-end + DORMANT (resume state)

**Date:** 2026-07-08 · **HEAD:** `b7e677e` (A–H + go-live gates 1/2/3 done, pushed) · **Repo-wide gate:** `pnpm -w turbo run typecheck test` → 31/31.
Companion: session doc `docs/sessions/049-2026-07-08-copilot-kmp-bridge-FGH.md`; memory `sow-kmp-bridge-finish` (READ FIRST) + `sow-copilot-kmp-bridge` (per-slice arc).

## Where the bridge stands
The §13.10a Copilot semantic-write bridge is **BUILT END-TO-END (Slices A–H) and DORMANT.** The full deterministic path exists: model intent → `deriveCopilotProjectKnowledgePlan` (validated KMP) → `copilot.propose_knowledge` tool → sink → a PENDING §9.8 semantic-mutation Approval + a pending-KMP row → on owner approval, `semanticMutationDispatch` commits the KMP through KnowledgeWriter (the sole writer). The desktop inbox now renders the semantic card distinctly.

Commits (all on `main`, reviewed, unpushed until this close-out):
`dd2915b` A · `d38a319` B · `715766b` C · `e1e83f3` D · `2718f35` E · `11faf76` F · `d6a1983` G1 · `09218b6` G2 · `de8ca9e` H.

Nothing runs live: prod `dispatchApproval` is a no-op stub, and no runner exposes the tool to a model.

## Go-live gates — 3 of 4 now CLOSED (session 049)
1. ✅ **DONE — Slug-collision guard** (`1cfa1f4` KMP `expectedProjectId?` frozen round + `09ca3c7` derive-stamp + executor-verify). The executor reads each write TARGET's frontmatter `projectId` (WS-8-scoped `readNoteProjectId` port) and rejects a NotePatch whose target ≠ `plan.expectedProjectId` AND a NoteCreate whose target path already exists (renderCreate overwrites); fail-closed.
2. ✅ **DONE — YAML-safe frontmatter serialization** (`3011749`). `serializeScalar` quotes+escapes unsafe/coercible string values (incl. all C0/C1 control chars); the create `title` path routed through it.
3. ✅ **DONE — FG-2 persisted-form hashing** (`b7e677e`). The sink now hashes the PERSISTED (round-tripped) plan, so the executor's re-hash of the read-back blob always matches — even for a future producer emitting a schema-legal present-`undefined` value (payloadHash's sentinel + JSON's undefined-dropping would otherwise diverge). No-op today; fail-closed either way.
4. **Gate 4 — C5.4b real serving oracle** (provenance-stamping — shared Tier-4 precondition; eval-security-track arc).

## What REMAINS — recommended next sequence (the live wiring)
1. ✅ **DONE (session 050, `dc5b0a9` knowledge + `459553f` worker)** — concrete `readNoteProjectId`. `packages/knowledge/.../frontmatter.ts` (the format codec extracted from writer.ts): `deserializeScalar` (exact inverse of `serializeScalar`) + `readFrontmatterField` (normalizes UNTRUSTED BOM/CRLF/EOF-fence; writer's `parseNote` left byte-exact). `apps/worker/src/api/adapters/noteProjectIdReader.ts`: `createNoteProjectIdReader` + `createNoteExistsProbe`, both WS-8-scoped over a `WorkspaceNoteRead`, redaction-safe, never-throw. Adversarial review folded a MEDIUM → added a `NoteExistsProbe` port + `noteExists` dep so the gate-1 CREATE guard keys on REAL existence (not projectId-presence), closing a silent-overwrite false-accept. See `docs/sessions/050-…`.
2. **G3 — providers SDK-MCP adapter** `createCopilotProposeKnowledgeMcpServer` (mirror `createCopilotProposeMcpServer`; `packages/providers`, zod, eval-gated). ← **NEXT.**
3. **G4 — runner + boot flag** `copilotProposeKnowledge` (OFF; mirror `copilotProposeMode`). Runner MUST: (a) server-bind `workspaceId`; (b) resolve `noteExists` at call time via `projectNotePath(workspaceId, projectId)`; (c) inject BOTH `createNoteProjectIdReader` AND `createNoteExistsProbe` (built from the SAME WS-8 `WorkspaceNoteRead`) into the executor deps (`noteExists` is a required field); (d) route the semantic dispatch into `dispatchApproval` via `createApprovalDispatchRouter`.
4. **Gate 4** + **C6 governance eval** (`packages/evals` = eval-security track — coordinate; don't touch `../SoW-build-evalsec`).

## Method / discipline (carry it)
- Reviewer subagents are gone → run each safety-critical slice's review via a **general-purpose Agent** given security + code-quality prompts (F and G got one; H was inline — small, additive, enum-only). Adversarial pass is mandatory for the safety-critical slices.
- TDD for deterministic code; per-file `git add` (never `-A`/`.`); NEVER stage `.claude/settings.json`, root `CLAUDE.md`, `graphify-out/`. `graphify update .` after code changes. Repo-wide gate after any contract/DB/cross-package change.
- ENVIRONMENT: if reads under `~/Documents/` fail with "Operation not permitted" on a normal file, it's a macOS TCC / Full-Disk-Access revocation — quit + relaunch the host app + a fresh session (a running process can't recover a mid-session TCC grant).
