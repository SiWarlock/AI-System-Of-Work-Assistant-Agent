// §13.10d go-live — the BOOT flag-gating for the two read-only Copilot skills (vault.read +
// skill-introspection). This is the go-live SAFETY pin for task 39: the flip only activates the
// capability when EVERY precondition holds; any missing one ⇒ the deps are NOT built and no vault/skills
// MCP server is wired (fail-safe). The handler-internal safety (WS-8 personal-business-only scope,
// symlink/traversal realpath-confinement, read-only, skills-never-reveal-propose) is pinned by the
// existing handler + MCP unit tests (copilotVaultRead(.fs).test.ts / copilotSkillIntrospect.test.ts /
// copilot-{vault,skills}-mcp.test.ts) — cited, NOT duplicated. The runner wiring (deps ⇒ tool exposed;
// partial ⇒ fail-closed) is pinned by copilotAgentSynthesis.test.ts. This file pins the config→deps GATE.
import { describe, it, expect, vi } from "vitest";
import { gateCopilotVaultReadDeps, gateCopilotSkillIntrospectionDeps } from "../src/boot";

const VAULT_SENTINEL = "vault-deps" as const;
const SKILLS_SENTINEL = "skills-deps" as const;

describe("gateCopilotVaultReadDeps — §13.10d vault.read go-live gating (fail-safe)", () => {
  // spec(§7) — vault.read deps are built IFF copilotVaultRead === true AND a vaultRoot is configured AND
  // workspace-scoping is active (wsScope !== undefined). Every other combination is fail-safe undefined,
  // and the deps builder is NEVER invoked (no fs exec / MCP server constructed on the OFF path).
  const combos: ReadonlyArray<{ flag?: boolean; root?: string; scope: boolean; wired: boolean }> = [
    { flag: true, root: "/vault", scope: true, wired: true }, // all preconditions → WIRED
    { flag: false, root: "/vault", scope: true, wired: false }, // flag explicitly off
    { flag: undefined, root: "/vault", scope: true, wired: false }, // flag absent (default OFF)
    { flag: true, root: undefined, scope: true, wired: false }, // no vaultRoot (owner runtime precondition)
    { flag: true, root: "/vault", scope: false, wired: false }, // scoping off (no per-ask WS-8 scope)
    { flag: true, root: undefined, scope: false, wired: false }, // multiple missing
  ];

  it.each(combos)(
    "copilotVaultRead=$flag vaultRoot=$root scopingActive=$scope ⇒ wired=$wired",
    ({ flag, root, scope, wired }) => {
      const buildDeps = vi.fn((vaultRoot: string) => ({ deps: VAULT_SENTINEL, vaultRoot }));
      const result = gateCopilotVaultReadDeps({ copilotVaultRead: flag, vaultRoot: root }, scope, buildDeps);
      if (wired) {
        // Built — and the configured vaultRoot is THREADED to the builder (scope-binding to the real root).
        expect(result).toEqual({ deps: VAULT_SENTINEL, vaultRoot: root });
        expect(buildDeps).toHaveBeenCalledWith(root);
      } else {
        // Fail-safe: undefined AND the builder was never called (no fs exec / vault MCP server constructed).
        expect(result).toBeUndefined();
        expect(buildDeps).not.toHaveBeenCalled();
      }
    },
  );
});

describe("gateCopilotSkillIntrospectionDeps — §13.10d skill-introspection go-live gating (fail-safe)", () => {
  // spec(§7) — skills deps are built IFF copilotSkillIntrospection === true AND workspace-scoping is active.
  // No vaultRoot/reader needed (static catalog). Every other combination is fail-safe undefined.
  const combos: ReadonlyArray<{ flag?: boolean; scope: boolean; wired: boolean }> = [
    { flag: true, scope: true, wired: true }, // flag + scoping → WIRED
    { flag: false, scope: true, wired: false }, // flag explicitly off
    { flag: undefined, scope: true, wired: false }, // flag absent (default OFF)
    { flag: true, scope: false, wired: false }, // scoping off
  ];

  it.each(combos)(
    "copilotSkillIntrospection=$flag scopingActive=$scope ⇒ wired=$wired",
    ({ flag, scope, wired }) => {
      const buildDeps = vi.fn(() => SKILLS_SENTINEL);
      const result = gateCopilotSkillIntrospectionDeps({ copilotSkillIntrospection: flag }, scope, buildDeps);
      if (wired) {
        expect(result).toBe(SKILLS_SENTINEL);
        expect(buildDeps).toHaveBeenCalledOnce();
      } else {
        expect(result).toBeUndefined();
        expect(buildDeps).not.toHaveBeenCalled();
      }
    },
  );
});
