// §13.10d go-live — the BOOT flag-gating for the two read-only Copilot skills (vault.read +
// skill-introspection). This is the go-live SAFETY pin for task 39: the flip only activates the
// capability when EVERY precondition holds; any missing one ⇒ the deps are NOT built and no vault/skills
// MCP server is wired (fail-safe). The handler-internal safety (WS-8 personal-business-only scope,
// symlink/traversal realpath-confinement, read-only, skills-never-reveal-propose) is pinned by the
// existing handler + MCP unit tests (copilotVaultRead(.fs).test.ts / copilotSkillIntrospect.test.ts /
// copilot-{vault,skills}-mcp.test.ts) — cited, NOT duplicated. The runner wiring (deps ⇒ tool exposed;
// partial ⇒ fail-closed) is pinned by copilotAgentSynthesis.test.ts. This file pins the config→deps GATE.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateCopilotVaultReadDeps, gateCopilotSkillIntrospectionDeps, createFsVaultUsable } from "../src/boot";

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
      // vaultUsable → true isolates the 3-precondition matrix (the §13.10d usable dimension is pinned below).
      const result = gateCopilotVaultReadDeps({ copilotVaultRead: flag, vaultRoot: root }, scope, buildDeps, () => true);
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

describe("gateCopilotVaultReadDeps — §13.10d vaultUsable dimension (offer the tool ONLY on a usable vault)", () => {
  const GATE = { copilotVaultRead: true, vaultRoot: "/vault" } as const;
  const build = () => vi.fn((vaultRoot: string) => ({ deps: VAULT_SENTINEL, vaultRoot }));

  it("gate_wired_when_vault_usable", () => {
    // spec(§6) — all 3 preconditions + a usable vault ⇒ WIRED (byte-equivalent to today's real-vault behavior)
    const buildDeps = build();
    const result = gateCopilotVaultReadDeps(GATE, true, buildDeps, () => true);
    expect(result).toEqual({ deps: VAULT_SENTINEL, vaultRoot: "/vault" });
    expect(buildDeps).toHaveBeenCalledOnce();
  });

  it("gate_inert_when_vault_unusable", () => {
    // an empty/absent vault (vaultUsable → false) ⇒ undefined + buildDeps NOT called (don't offer an inert tool)
    const buildDeps = build();
    const result = gateCopilotVaultReadDeps(GATE, true, buildDeps, () => false);
    expect(result).toBeUndefined();
    expect(buildDeps).not.toHaveBeenCalled();
  });

  it("gate_inert_when_vault_usable_throws", () => {
    // fail-safe: a THROWING predicate ⇒ treated as false ⇒ inert; the gate itself never throws (Lesson 15)
    const buildDeps = build();
    const vaultUsable = () => {
      throw new Error("stat blew up");
    };
    expect(() => gateCopilotVaultReadDeps(GATE, true, buildDeps, vaultUsable)).not.toThrow();
    expect(gateCopilotVaultReadDeps(GATE, true, buildDeps, vaultUsable)).toBeUndefined();
    expect(buildDeps).not.toHaveBeenCalled();
  });

  it("vaultUsable is NOT consulted when a prior precondition already gates OFF (no wasted fs read)", () => {
    // the flag-off default path must not touch the fs — vaultUsable is checked ONLY after the 3 preconditions pass
    const vaultUsable = vi.fn(() => true);
    gateCopilotVaultReadDeps({ copilotVaultRead: false, vaultRoot: "/vault" }, true, build(), vaultUsable);
    expect(vaultUsable).not.toHaveBeenCalled();
  });
});

describe("createFsVaultUsable — §13.10d fs usability predicate (exists + ≥1 .md; fault ⇒ false)", () => {
  it("fs_vault_usable_empty_dir_false", () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-vault-empty-"));
    try {
      expect(createFsVaultUsable()(dir)).toBe(false); // the default empty <userData>/vault ⇒ inert
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fs_vault_usable_with_md_true", () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-vault-md-"));
    try {
      writeFileSync(join(dir, "note.md"), "# hi");
      expect(createFsVaultUsable()(dir)).toBe(true); // a real populated vault ⇒ wired
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fs_vault_usable_nested_md_true", () => {
    // mirrors the committed-vault reader's RECURSIVE .md enumeration — a .md in a subdir counts
    const dir = mkdtempSync(join(tmpdir(), "sow-vault-nested-"));
    try {
      mkdirSync(join(dir, "projects"));
      writeFileSync(join(dir, "projects", "deep.md"), "# deep");
      expect(createFsVaultUsable()(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fs_vault_usable_non_md_only_false", () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-vault-nonmd-"));
    try {
      writeFileSync(join(dir, "readme.txt"), "not markdown");
      expect(createFsVaultUsable()(dir)).toBe(false); // no .md ⇒ inert
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fs_vault_usable_md_named_directory_false", () => {
    // a DIRECTORY named `notes.md/` is NOT a page — the reader (isFile() gated) serves zero, so the gate must be
    // inert (else it offers exactly the SAFE_EMPTY-only tool this slice exists to prevent)
    const dir = mkdtempSync(join(tmpdir(), "sow-vault-mddir-"));
    try {
      mkdirSync(join(dir, "notes.md"));
      expect(createFsVaultUsable()(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fs_vault_usable_missing_dir_false", () => {
    // fail-safe: a non-existent path ⇒ false, never a throw. Create-then-remove ⇒ a GUARANTEED-missing unique path.
    const missing = mkdtempSync(join(tmpdir(), "sow-vault-missing-"));
    rmSync(missing, { recursive: true, force: true });
    expect(() => createFsVaultUsable()(missing)).not.toThrow();
    expect(createFsVaultUsable()(missing)).toBe(false);
  });
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
