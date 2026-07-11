// @sow/integrations — Phase-13 §13.4 read-only Obsidian-vault MCP tool surface.
//
// A governed read-ONLY vault tool surface: it registers ONLY the 5 vault READ tools and does NOT
// register the 3 write tools (save_note/update_note/capture) — so no MCP path can write canonical
// Markdown (safety rule 1, KN-4/KN-9). A frozen read-only descriptor set + a fail-safe registry
// (unknown/write id ⇒ rejected, mirroring `isMutatingCopilotTool`) + a read-only `invoke` over a
// FAKED transport that can never reach a write surface. Dormant (no MCP SDK, no real vault I/O).
// Never-throws (Lesson 11); structurally holds no write-surface token (Lesson 12).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import {
  createObsidianVaultReadConnector,
  OBSIDIAN_VAULT_READ_TOOLS,
  OBSIDIAN_VAULT_WRITE_TOOL_IDS,
  type ObsidianVaultTransport,
  type ObsidianVaultConfig,
} from "../src/connectors/adapters/obsidian-vault-mcp";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE_PATH = resolve(HERE, "../src/connectors/adapters/obsidian-vault-mcp.ts");

const READ_TOOL_IDS = ["obsidian_search", "read_note", "backlinks", "vault_health", "validate_note"];

function config(partial: Partial<ObsidianVaultConfig> = {}): ObsidianVaultConfig {
  return { workspaceId: "employer-work", vaultScope: "obsidian_vault:read", ...partial };
}

// A faked transport standing in for the real per-workspace MCP server (no SDK / no vault I/O in tests).
function fakeTransport(payload: Record<string, unknown> = { hits: ["note-a"] }): ObsidianVaultTransport {
  return async (call) => ({ ok: true, payload: { echoTool: call.toolId, ...payload } });
}

describe("Phase-13 §13.4 — createObsidianVaultReadConnector (read-only vault MCP surface)", () => {
  it("registers ONLY the 5 read tools, all mutating:false (frozen; §8 read edge)", () => {
    const c = createObsidianVaultReadConnector(fakeTransport(), config());
    expect([...c.registeredToolIds()].sort()).toEqual([...READ_TOOL_IDS].sort());
    expect(OBSIDIAN_VAULT_READ_TOOLS.every((t) => t.mutating === false)).toBe(true);
    // frozen so the safety-critical read-only set can't be runtime-tampered to admit a write tool
    // (mirrors the copilot-tool-catalog Object.freeze precedent).
    expect(Object.isFrozen(OBSIDIAN_VAULT_READ_TOOLS)).toBe(true);
    expect(OBSIDIAN_VAULT_READ_TOOLS.every((t) => Object.isFrozen(t))).toBe(true);
  });

  it("does NOT register the 3 write tools save_note/update_note/capture (KN-4/KN-9, safety rule 1)", () => {
    const c = createObsidianVaultReadConnector(fakeTransport(), config());
    const registered = c.registeredToolIds();
    for (const writeId of OBSIDIAN_VAULT_WRITE_TOOL_IDS) {
      expect(registered).not.toContain(writeId);
      expect(c.isRegisteredReadTool(writeId)).toBe(false);
    }
    // the exclusion set is exactly the 3 known writes.
    expect([...OBSIDIAN_VAULT_WRITE_TOOL_IDS].sort()).toEqual(["capture", "save_note", "update_note"]);
  });

  it("fail-safe: an unknown/unregistered tool id ⇒ isRegisteredReadTool false AND invoke ⇒ typed err (mirror isMutatingCopilotTool unknown⇒reject)", async () => {
    const c = createObsidianVaultReadConnector(fakeTransport(), config());
    expect(c.isRegisteredReadTool("totally_unknown")).toBe(false);
    const res = await c.invoke({ toolId: "totally_unknown", args: {} });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("not_registered");
  });

  it("invoke of a REGISTERED read tool routes to the injected transport and returns its VaultReadResult (read surface live over the seam)", async () => {
    const c = createObsidianVaultReadConnector(fakeTransport({ note: "hello" }), config());
    const res = await c.invoke({ toolId: "read_note", args: { path: "a.md" } });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.toolId).toBe("read_note");
    expect(res.value.payload).toMatchObject({ echoTool: "read_note", note: "hello" });
  });

  it("invoke of a WRITE tool ⇒ typed err AND the transport is NEVER called (no write path reached, safety rule 1)", async () => {
    let called = false;
    const spy: ObsidianVaultTransport = async () => {
      called = true;
      return { ok: true, payload: {} };
    };
    const c = createObsidianVaultReadConnector(spy, config());
    const res = await c.invoke({ toolId: "save_note", args: { path: "a.md", body: "x" } });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("not_registered");
    expect(called).toBe(false); // the fail-safe rejects BEFORE the transport — a write never reaches the seam
  });

  // The canonical write-path guard (packages/evals/.../anti-corruption-guard.ts) is keyed on the
  // `*-source.ts` naming convention, so this `obsidian-vault-mcp.ts` file is OUTSIDE its scan surface
  // (documented coverage bound). Integrations cannot import @sow/evals (reverse layer direction), so
  // this inline check is this module's structural one-writer tripwire. Per Lesson 12 it must be
  // NON-VACUOUS: a self-detect pass proves the check actually flags a token when present, so an empty
  // result over the real source means "no write surface", not "the check is broken".
  const WRITE_SURFACE_TOKENS = [
    "@sow/knowledge",
    "knowledge-writer",
    "markdown-vault",
    "atomic-write",
    "commitAtomically",
    "createFsVault",
    "writeFile",
    "appendFile",
    "copyFile",
    "createWriteStream",
    "ExternalWriteEnvelope",
    "tools/adapters",
    ".write(",
  ];

  it("the write-surface token check is NON-VACUOUS — every token self-detects in a synthetic line (Lesson 12 catch-power)", () => {
    for (const tok of WRITE_SURFACE_TOKENS) {
      const synthetic = `const x = 1; // uses ${tok} here`;
      expect(WRITE_SURFACE_TOKENS.filter((t) => synthetic.includes(t))).toContain(tok);
    }
  });

  it("the module source holds NO write-surface token (Lesson 12 structural one-writer)", () => {
    const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
    const found = WRITE_SURFACE_TOKENS.filter((t) => source.includes(t));
    expect(found).toEqual([]);
  });

  it("never-throws (Lesson 11): a transport that THROWS resolves to a typed err, never rejects", async () => {
    const throwing: ObsidianVaultTransport = async () => {
      throw new Error("mcp transport exploded");
    };
    const c = createObsidianVaultReadConnector(throwing, config());
    const res = await c.invoke({ toolId: "obsidian_search", args: { q: "x" } });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unknown");
  });

  it("fail-closed: a faked !ok transport result ⇒ typed err (unreachable), never a throw", async () => {
    const failing: ObsidianVaultTransport = async () => ({ ok: false, code: "unreachable", message: "server down" });
    const c = createObsidianVaultReadConnector(failing, config());
    const res = await c.invoke({ toolId: "obsidian_search", args: {} });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unreachable");
  });

  it("the connector's read scope is READ-ONLY (ING-7 least-privilege) — never write/mutate; config passed through, not invented", () => {
    const c = createObsidianVaultReadConnector(
      fakeTransport(),
      config({ workspaceId: "personal-business", vaultScope: "vault:reader-xyz" }),
    );
    expect(c.readScope()).not.toMatch(/write|create|update|delete|admin|mutat/i);
    // pin the ACTUAL passthrough (a hardcoded readScope would pass the read-only regex above):
    expect(c.readScope()).toBe("vault:reader-xyz");
    expect(c.workspaceId).toBe("personal-business"); // isolation binding passed through, never invented
  });

  it("TOTAL never-throws (Lesson 11): a MALFORMED call (null / a throwing toolId getter) resolves to a typed err, never a rejected promise", async () => {
    const c = createObsidianVaultReadConnector(fakeTransport(), config());
    // a null call — the toolId deref is INSIDE the try, so this resolves (never rejects).
    const resNull = await c.invoke(null as unknown as { toolId: string; args: Record<string, unknown> });
    expect(isErr(resNull)).toBe(true);
    if (isErr(resNull)) expect(resNull.error.code).toBe("unknown");
    // a hostile getter on toolId that throws on read.
    const hostile = {
      args: {},
      get toolId(): string {
        throw new Error("hostile getter");
      },
    };
    const resThrow = await c.invoke(hostile);
    expect(isErr(resThrow)).toBe(true);
    if (isErr(resThrow)) expect(resThrow.error.code).toBe("unknown");
  });
});
