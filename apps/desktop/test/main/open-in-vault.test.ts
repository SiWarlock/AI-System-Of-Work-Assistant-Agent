import { describe, it, expect, vi } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { guardVaultPath, performVaultAction } from "../../main/open-in-vault";

// 9.12 — open-in-vault path-scoping. A renderer-supplied path crossing the trusted preload bridge is
// STILL untrusted: main opens/reveals ONLY a path whose realpath is contained within a configured
// workspace/global repo root, rejecting everything else (no arbitrary path open). These pin the PURE,
// electron-free guard (injected realpath/stat seams, zero real fs) + the shell-dispatch wrapper (injected
// shell seams). Mirrors main/app-protocol.ts (lexical containment) + worker copilotVaultRead (realpath
// re-containment) + worker LESSON 17 (realpath-before-open, +sep guard, never-throws).

const ROOT = "/vault";
const GLOBAL = "/global";
const NUL = String.fromCharCode(0);

/** A fake realpath: resolves via an explicit map, identity for unmapped inputs; a listed key throws (ENOENT). */
function fakeRealpath(map: Record<string, string> = {}, throwOn: readonly string[] = []) {
  return async (p: string): Promise<string> => {
    if (throwOn.includes(p)) throw new Error("ENOENT");
    return map[p] ?? p;
  };
}
/** A fake stat exposing only isFile(); optionally throws to simulate a missing target. */
function fakeStat(isFile: boolean, throws = false) {
  return async (_p: string): Promise<{ isFile: () => boolean }> => {
    if (throws) throw new Error("ENOENT");
    return { isFile: () => isFile };
  };
}

describe("guardVaultPath — path-scoped containment guard (main opens only realpath-contained vault paths)", () => {
  it("a contained regular file resolves ok with its realpath absPath", async () => {
    // spec(§11/REQ-UX-003) — the happy path: Obsidian is a first-class editor for a contained note.
    const r = await guardVaultPath("/vault/notes/x.md", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.absPath).toBe("/vault/notes/x.md");
  });

  it("REJECTS a path under no configured root (no arbitrary open)", async () => {
    // spec(§5) — §5 no-arbitrary-open: a path outside every root fails closed at the lexical layer.
    const r = await guardVaultPath("/etc/passwd", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("outside_roots");
  });

  it("REJECTS a ../ traversal escaping the root (lexical layer)", async () => {
    // spec(§5) — traversal containment (mirror resolveAppRequest): resolve() collapses `..` to /etc/passwd,
    // which is not contained ⇒ rejected BEFORE any fs seam.
    const r = await guardVaultPath("/vault/../etc/passwd", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("outside_roots");
  });

  it("REJECTS a symlink whose realpath escapes the root (realpath layer, not the lexical one)", async () => {
    // spec(§5) — symlink escape (mirror copilotVaultRead / L17): lexically under /vault, but its REAL path
    // resolves outside ⇒ caught by the realpath re-containment layer with a DISTINCT reason.
    const r = await guardVaultPath("/vault/link.md", [ROOT], "open", {
      realpath: fakeRealpath({ "/vault/link.md": "/etc/passwd" }),
      stat: fakeStat(true),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("escapes_roots");
  });

  it("REJECTS a sibling-prefix path (the + sep guard, not a bare startsWith)", async () => {
    // spec(§5) — shared-prefix sibling: /vault-evil merely shares /vault's string prefix ⇒ rejected.
    const r = await guardVaultPath("/vault-evil/x.md", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("outside_roots");
  });

  it("REJECTS a NUL-byte / empty / non-string path before touching any fs seam", async () => {
    // spec(§5) — malformed input: fail closed before realpath/stat (a NUL-injection can't reach the fs).
    const realpath = vi.fn(async (p: string) => p);
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const bads: unknown[] = [`/vault/a${NUL}.md`, "", 123, null, undefined];
    for (const bad of bads) {
      const r = await guardVaultPath(bad, [ROOT], "open", { realpath, stat });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.reason).toBe("malformed");
    }
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("REJECTS a non-file target for open, but reveal does not require a regular file", async () => {
    // spec(§11/REQ-UX-003) — open targets a real file (shell.openPath a dir is wrong); reveal (show-in-folder)
    // legitimately targets a directory / repo root, so it does NOT require isFile — but still runs containment.
    const openDir = await guardVaultPath("/vault/adir", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(false),
    });
    expect(isErr(openDir)).toBe(true);
    if (isErr(openDir)) expect(openDir.error.reason).toBe("not_a_file");

    const revealDir = await guardVaultPath("/vault/adir", [ROOT], "reveal", {
      realpath: fakeRealpath(),
      stat: fakeStat(false),
    });
    expect(isOk(revealDir)).toBe(true);
  });

  it("NEVER throws on a realpath or stat seam fault — folds to a typed reject", async () => {
    // spec(§16) — never-throws: an injected realpath/stat that throws (missing target, permission) yields a
    // typed reject, never a propagated exception.
    const rpFault = await guardVaultPath("/vault/x.md", [ROOT], "open", {
      realpath: fakeRealpath({}, ["/vault/x.md"]),
      stat: fakeStat(true),
    });
    expect(isErr(rpFault)).toBe(true);
    if (isErr(rpFault)) expect(rpFault.error.reason).toBe("fs_fault");

    const statFault = await guardVaultPath("/vault/x.md", [ROOT], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true, true),
    });
    expect(isErr(statFault)).toBe(true);
    if (isErr(statFault)) expect(statFault.error.reason).toBe("fs_fault");
  });

  it("honors multiple roots (workspace repos + the Global/Coordination repo)", async () => {
    // spec(§11) — the roots-set contract: a file under the 2nd root resolves ok; a file under neither rejects.
    const roots = [ROOT, GLOBAL];
    const under2nd = await guardVaultPath("/global/coord/y.md", roots, "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isOk(under2nd)).toBe(true);
    if (isOk(under2nd)) expect(under2nd.value.absPath).toBe("/global/coord/y.md");

    const underNeither = await guardVaultPath("/tmp/z.md", roots, "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isErr(underNeither)).toBe(true);
    if (isErr(underNeither)) expect(underNeither.error.reason).toBe("outside_roots");
  });

  it("rejects when the configured root set is empty (nothing is contained)", async () => {
    // spec(§5) — defensive: no roots ⇒ every path fails closed (no accidental open-all).
    const r = await guardVaultPath("/vault/notes/x.md", [], "open", {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("outside_roots");
  });
});

describe("performVaultAction — shell dispatch over the guard (no side effect on a rejected path)", () => {
  it("a rejected path makes ZERO shell calls and returns { ok: false }", async () => {
    // spec(§5) — the safety pin at the dispatch layer: a path outside the roots reaches neither
    // shell.openPath nor shell.showItemInFolder.
    const openPath = vi.fn(async () => "");
    const showInFolder = vi.fn(() => {});
    const res = await performVaultAction("open", "/etc/passwd", [ROOT], {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
      openPath,
      showInFolder,
    });
    expect(res).toEqual({ ok: false });
    expect(openPath).not.toHaveBeenCalled();
    expect(showInFolder).not.toHaveBeenCalled();
  });

  it("open invokes shell.openPath with the REALPATH-resolved absPath (TOCTOU-safe)", async () => {
    // spec(§11/REQ-UX-003) — the real path (post symlink-resolution), not the requested path, is opened.
    const openPath = vi.fn(async () => "");
    const showInFolder = vi.fn(() => {});
    const res = await performVaultAction("open", "/vault/link.md", [ROOT], {
      realpath: fakeRealpath({ "/vault/link.md": "/vault/real.md" }),
      stat: fakeStat(true),
      openPath,
      showInFolder,
    });
    expect(res).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith("/vault/real.md");
    expect(showInFolder).not.toHaveBeenCalled();
  });

  it("reveal invokes shell.showItemInFolder and not openPath", async () => {
    // spec(§11/REQ-UX-003) — reveal maps to show-in-folder.
    const openPath = vi.fn(async () => "");
    const showInFolder = vi.fn(() => {});
    const res = await performVaultAction("reveal", "/vault/notes/x.md", [ROOT], {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
      openPath,
      showInFolder,
    });
    expect(res).toEqual({ ok: true });
    expect(showInFolder).toHaveBeenCalledWith("/vault/notes/x.md");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("maps a non-empty shell.openPath error to { ok: false } WITHOUT disclosing the error string", async () => {
    // spec(§16) — rule 7: shell.openPath returns a non-empty error string (may echo the path) on failure;
    // it is mapped to a bare { ok: false }, never surfaced.
    const res = await performVaultAction("open", "/vault/notes/x.md", [ROOT], {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
      openPath: async () => "EACCES: /vault/notes/x.md",
      showInFolder: () => {},
    });
    expect(res).toEqual({ ok: false });
  });

  it("NEVER throws when the shell seam throws", async () => {
    // spec(§16) — never-throws: a throwing shell call folds to { ok: false }.
    const res = await performVaultAction("open", "/vault/notes/x.md", [ROOT], {
      realpath: fakeRealpath(),
      stat: fakeStat(true),
      openPath: async () => {
        throw new Error("boom");
      },
      showInFolder: () => {},
    });
    expect(res).toEqual({ ok: false });
  });
});
