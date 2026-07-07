# Session 044 — §13.10d skill self-introspection (`list_skills` / `get_skill`)

- **Date:** 2026-07-06 · **Track:** solo (contract+worker+providers) · **HEAD:** `08a470b` → `d693e32`, pushed origin/main.
- **Owner direction:** "C6 then the real dashboard." This session completes the **second half of the C6 "vault page-reads + skill introspection" pick** (vault page-reads landed session 043); the real dashboard is next.
- **Gate:** repo-wide `pnpm -w turbo run typecheck test` **31/31** green. Dual-reviewer (security + code-quality) clean.

## What shipped — 3 slices (TDD, per-slice commit)

The Copilot agent can now enumerate its own read-skills + read one skill's metadata, via a new in-process
`mcp__skills__list` / `mcp__skills__get` MCP server (behind the default-OFF `copilotSkillIntrospection` flag).

### Skill-A — catalog + the 4th scoping class (`bf994e6`, `packages/policy`)
- `COPILOT_READ_TOOLS`: added `skills.list` + `skills.get` (frozen, `mutating:false`) — they ride into the
  read_only policy and keep it pure (ING-7-safe, zero approval).
- **NEW 4th `CopilotToolScopingClass` value `"workspace-agnostic"`.** The 3 existing SC4 classes all assume
  *brain-scoping* (arg-scopable / result-filterable / unscopable). Skill introspection reads the **STATIC tool
  catalog** — no brain query, no vault read, no workspace data — so there is **nothing to scope and no
  cross-workspace leak is possible**. `workspace-agnostic` is distinct from `arg-scopable` (no workspace-pinning
  arg exists) and from `unscopable` (which would wrongly DENY it on today's non-partitioned brain).
  `copilotScopedReadToolIds` keeps `workspace-agnostic` tools on **any** brain (only `unscopable` is dropped on a
  non-partitioned one). Class documented consistently in the type, the SC4 block comment, `COPILOT_TOOL_SCOPING`,
  and the `copilotScopedReadToolIds` docstring.
- The totality test's allowed-class assertion widened to include the 4th class; the gbrain drift-lock skips
  `skills.*` (non-`gbrain.`). Full policy suite **320/320**.

### Skill-B — the handler (`bdf4170`, `apps/worker`)
- `handleCopilotSkillIntrospect(op, args)` in `apps/worker/src/api/procedures/copilotSkillIntrospect.ts`.
  Dispatches on op: `list` → every `COPILOT_READ_TOOLS` entry projected to `{id, description, mutating:false,
  scoping}`; `get` → one read-skill by id, or `{skill:null}` for an unknown/uncataloged id.
- **INVARIANT 1 — never reveals the write-proposing tool.** `list` projects only `COPILOT_READ_TOOLS`; `get`
  searches only `COPILOT_READ_TOOLS` — **not** the combined `CATALOG` map (which contains `COPILOT_PROPOSE_TOOL`).
  So `get({id:"copilot.propose_action"})` → `{skill:null}`. An untrusted agent is not even told the propose
  capability exists (defense-in-depth on the *information* surface; the real grant gate is ING-7 + the job policy).
- **INVARIANT 2 — never-throws, fail-closed.** Whole body in try/catch → a safe empty list / null skill.
  Malformed `get` args (`!isRecord` / non-string / empty id) → `{skill:null}`; unknown op → `{skills:[]}`.
- 10 handler tests.

### Skill-C — the MCP server + runner/boot wiring (`d693e32`, `packages/providers` + `apps/worker`)
- `createCopilotSkillsMcpServer(handler)` in `packages/providers/src/runtime/copilot-skills-mcp.ts` — a thin
  2-op SDK MCP wrapper (server name `"skills"`, args forwarded UNPARSED; mirrors the gbrain-proxy shape).
  **DAG-clean** — no `@sow/policy` or worker import; the handler is an injected structural type. Exported from
  the providers barrel. 8 tests.
- Runner (`copilotAgentSynthesis.ts`): register the skills server under the distinct `"skills"` key, additive to
  the gbrain proxy + vault, **inside the served & `!proposeGranted` scoped-proxy branch only** (never a seed-only
  propose job). Single factory dep — no scope/root/reader — so no partial-config permutation. 2 wiring tests.
- Boot (`boot.ts`): `copilotSkillIntrospection` flag (default OFF), gated on scoping on; wires
  `createCopilotSkillsMcpServer` into the runner alongside vault.

## Reviews (dual, at the Skill-C security boundary)
- **security-reviewer: 0 crit / 0 high / 0 medium.** Both feature invariants hold *by construction* (propose
  excluded because the handler reads `COPILOT_READ_TOOLS` not `CATALOG`; fail-closed via total try/catch). WS-8
  unaffected (no workspace data touched; `workspace-agnostic` un-drops nothing). ING-7 preserved. 1 by-design
  **low** (informational): `list_skills` advertises the full read catalog incl. tools not reachable on a
  non-partitioned brain — non-exploitable (descriptors carry no workspace data; a steered call fails closed; the
  real grant gate is unchanged). **Deferred.**
- **code-quality-reviewer:** faithful mirror of the vault/gbrain-proxy patterns; the new class documented in all
  4 required places; tests pin the invariants at 3 layers (catalog totality / handler unit / runner wiring).
  3 **lows**: (1) dead `CopilotSkillIntrospectOp` export → **removed in-slice** (folded into `d693e32`);
  (2) `describeSkill` hardcodes `mutating:false` vs projecting `spec.mutating` → **defer** (the catalog totality
  test guards the invariant); (3) the owner's `.claude/settings.json`/`CLAUDE.md` in the working tree →
  **not mine to stage** (correctly excluded from every commit; graphify-install, owner territory).

## Activation (owner runtime step)
- Set `copilotSkillIntrospection: true` in `apps/desktop/worker-host/index.ts` alongside the live
  `copilotAgentMode` / `copilotWorkspaceScoping`. Zero-leak (workspace-agnostic) — flag-gated only for a
  deliberate agentic surface; no vault/disk dependency (unlike `copilotVaultRead`).

## Docs reconciled
`IMPLEMENTATION_PLAN.md` §13.10 Tier-1 + §13.10d · `docs/planning/copilot-skill-catalog.md` (§3.1 row + Tier-1) ·
memory `sow-copilot-skill-catalog` · handoff `docs/team-handoffs/001-2026-07-06-ws8-scoping-resume.md` (RESUME block).

## NEXT (owner-directed)
- **The real dashboard** — wire the Today recent-changes + Projects read projectors (currently stub) to real
  operational-store data (`apps/worker/src/api/adapters/readModel.ts` + `.../projections/uiSafe.ts`
  `UiSafeRecentChange` / `UiSafeProjectDashboard`). Needs an exploration pass first.
- Remaining §13.10d vault-MCP reads (`obsidian_search`/`read_note`/`backlinks`/`vault_health`/`validate_note`) —
  need the Obsidian vault path wired.
