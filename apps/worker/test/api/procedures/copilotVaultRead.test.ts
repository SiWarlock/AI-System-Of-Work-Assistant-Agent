// Vault-B — the vault.read handler: symlink-safe, path-traversal-guarded, WS-8-scoped Markdown page read.
// Three layers: (1) lexical WS-8 + traversal on the requested path, (2) symlink-safe realpath containment +
// re-attribution on the REAL path, (3) read the real path. Any deny/fault → a STABLE empty result. §16 no-throw.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, failure, workspaceId } from "@sow/contracts";
import type { WorkspaceScopeRegistry, LegacyContentPolicy, CopilotWorkspaceScope } from "@sow/policy";
import {
  handleCopilotVaultReadCall,
  type CopilotVaultReadFileExec,
  type CopilotVaultRealpathExec,
} from "../../../src/api/procedures/copilotVaultRead";

const REGISTRY: WorkspaceScopeRegistry = {
  descriptors: [
    { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
    { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
    { workspaceId: workspaceId("personal-life"), slugPrefixes: ["personal-life"] },
  ],
};
const ASSIGN_PB: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };
const scopeFor = (ws: string): CopilotWorkspaceScope => ({
  servedWorkspaceId: workspaceId(ws),
  registry: REGISTRY,
  policy: ASSIGN_PB,
});
const VAULT = "/home/user/vault";
const DENY_TEXT = "";
const notFound = () => err(failure("degraded_unavailable", "not found", { retryable: false, cause: { code: "VAULT_READ_ENOENT" } }));

/** A recording readFile seam over an in-memory file map (abs path → contents). */
function fakeReader(files: Record<string, string>): { readFile: CopilotVaultReadFileExec; calls: string[] } {
  const calls: string[] = [];
  return { calls, readFile: async (abs) => (calls.push(abs), abs in files ? ok(files[abs]!) : notFound()) };
}
/** Identity realpath (NO symlinks): the resolved path equals the input. */
const identityRealpath: CopilotVaultRealpathExec = async (p) => ok(p);
/** A realpath that follows a single configured symlink prefix → target (simulates an on-disk symlink). */
function symlinkRealpath(linkPrefix: string, target: string): CopilotVaultRealpathExec {
  return async (p) => ok(p === linkPrefix ? target : p.startsWith(linkPrefix + "/") ? target + p.slice(linkPrefix.length) : p);
}
const textOf = (r: { content: ReadonlyArray<{ type: "text"; text: string }> }): string => r.content[0]!.text;

describe("handleCopilotVaultReadCall — symlink-safe, path-guarded, WS-8-scoped page read", () => {
  it("reads an in-workspace note (served personal-business) — appends .md, reads the realpath", async () => {
    const { readFile, calls } = fakeReader({ "/home/user/vault/personal-business/notes/x.md": "# My PB note" });
    const r = await handleCopilotVaultReadCall(
      { path: "personal-business/notes/x" },
      { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile },
    );
    expect(textOf(r)).toBe("# My PB note");
    expect(calls).toEqual(["/home/user/vault/personal-business/notes/x.md"]);
  });

  it("accepts an explicit .md extension (any case) WITHOUT double-appending (reads the given file, not `.md.md`)", async () => {
    // `.MD` must not become `a.MD.md`; it reads the requested `a.MD` file (case preserved on a case-sensitive FS).
    const files = { "/home/user/vault/personal-business/a.md": "A-lower", "/home/user/vault/personal-business/a.MD": "A-upper" };
    const lower = fakeReader(files);
    expect(textOf(await handleCopilotVaultReadCall({ path: "personal-business/a.md" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile: lower.readFile }))).toBe("A-lower");
    const upper = fakeReader(files);
    expect(textOf(await handleCopilotVaultReadCall({ path: "personal-business/a.MD" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile: upper.readFile }))).toBe("A-upper");
    expect(upper.calls).toEqual(["/home/user/vault/personal-business/a.MD"]); // NOT a.MD.md
  });

  it("DENIES a foreign-workspace path and NEVER reads the file", async () => {
    const { readFile, calls } = fakeReader({ "/home/user/vault/employer-work/secret.md": "TOP SECRET" });
    const r = await handleCopilotVaultReadCall(
      { path: "employer-work/secret" },
      { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile },
    );
    expect(textOf(r)).toBe(DENY_TEXT);
    expect(calls).toEqual([]);
  });

  it("DENIES a path-traversal attempt (`..`, absolute, backslash) at the LEXICAL layer — no realpath, no read", async () => {
    const { readFile, calls } = fakeReader({});
    const realCalls: string[] = [];
    const realpath: CopilotVaultRealpathExec = async (p) => (realCalls.push(p), ok(p));
    for (const path of ["../../../etc/passwd", "personal-business/../employer-work/secret", "/etc/passwd", "personal-business/..\\employer-work"]) {
      const r = await handleCopilotVaultReadCall({ path }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath, readFile });
      expect(textOf(r)).toBe(DENY_TEXT);
    }
    expect(calls).toEqual([]);
    expect(realCalls).toEqual([]); // denied before realpath (lexical fast-path)
  });

  it("SYMLINK to another workspace INSIDE the vault: the REAL path re-attributes FOREIGN ⇒ DENIED (no read)", async () => {
    // /vault/personal-business/shared → /vault/employer-work  (a symlink an owner might place)
    const realpath = symlinkRealpath("/home/user/vault/personal-business/shared", "/home/user/vault/employer-work");
    const { readFile, calls } = fakeReader({ "/home/user/vault/employer-work/secret.md": "EW SECRET" });
    const r = await handleCopilotVaultReadCall(
      { path: "personal-business/shared/secret" }, // lexically in-workspace, but the REAL file is employer-work
      { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath, readFile },
    );
    expect(textOf(r)).toBe(DENY_TEXT); // re-attribution on the real path denies it
    expect(calls).toEqual([]); // never read the foreign file
  });

  it("SYMLINK to a file OUTSIDE the vault: the REAL path escapes vaultRoot ⇒ DENIED (no read)", async () => {
    // /vault/personal-business/shared → /etc  (escape the vault entirely)
    const realpath = symlinkRealpath("/home/user/vault/personal-business/shared", "/etc");
    const { readFile, calls } = fakeReader({ "/etc/passwd.md": "root:x:0:0" });
    const r = await handleCopilotVaultReadCall(
      { path: "personal-business/shared/passwd" },
      { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath, readFile },
    );
    expect(textOf(r)).toBe(DENY_TEXT); // real path /etc/passwd.md is outside the vault ⇒ containment deny
    expect(calls).toEqual([]);
  });

  it("a realpath fault (broken symlink / missing) fails closed — no read", async () => {
    const realpath: CopilotVaultRealpathExec = async () => err(failure("degraded_unavailable", "realpath failed", { retryable: false, cause: { code: "VAULT_REALPATH_FAULT" } }));
    const { readFile, calls } = fakeReader({ "/home/user/vault/personal-business/x.md": "x" });
    const r = await handleCopilotVaultReadCall({ path: "personal-business/x" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath, readFile });
    expect(textOf(r)).toBe(DENY_TEXT);
    expect(calls).toEqual([]);
  });

  it("legacy (unprefixed) note: KEPT for served personal-business under {assign,PB}, DENIED for another served workspace", async () => {
    const files = { "/home/user/vault/sessions/041.md": "legacy" };
    const pb = fakeReader(files);
    const rPb = await handleCopilotVaultReadCall({ path: "sessions/041" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile: pb.readFile });
    expect(textOf(rPb)).toBe("legacy");
    const pl = fakeReader(files);
    const rPl = await handleCopilotVaultReadCall({ path: "sessions/041" }, { scope: scopeFor("personal-life"), vaultRoot: VAULT, realpath: identityRealpath, readFile: pl.readFile });
    expect(textOf(rPl)).toBe(DENY_TEXT);
    expect(pl.calls).toEqual([]);
  });

  it("a read fault (missing file) fails closed to the stable empty result", async () => {
    const { readFile } = fakeReader({});
    const r = await handleCopilotVaultReadCall({ path: "personal-business/gone" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile });
    expect(textOf(r)).toBe(DENY_TEXT);
  });

  it("malformed args (no path / non-object / non-string / empty) DENY without reading", async () => {
    const { readFile, calls } = fakeReader({ "/home/user/vault/personal-business/x.md": "x" });
    for (const args of [{}, null, "personal-business/x", { path: 42 }, { path: "" }]) {
      const r = await handleCopilotVaultReadCall(args, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile });
      expect(textOf(r)).toBe(DENY_TEXT);
    }
    expect(calls).toEqual([]);
  });

  it("NEVER throws — a readFile that throws is caught and fails closed", async () => {
    const throwingRead: CopilotVaultReadFileExec = async () => {
      throw new Error("disk exploded");
    };
    const r = await handleCopilotVaultReadCall({ path: "personal-business/x" }, { scope: scopeFor("personal-business"), vaultRoot: VAULT, realpath: identityRealpath, readFile: throwingRead });
    expect(textOf(r)).toBe(DENY_TEXT);
  });
});
