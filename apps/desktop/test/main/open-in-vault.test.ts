import { describe, it, expect, vi } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  guardVaultPath,
  performVaultAction,
  resolveRepoRoot,
  type VaultActionDeps,
} from "../../main/open-in-vault";

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

describe("resolveRepoRoot — a CLOSED repo target resolves to a configured root (never a renderer path)", () => {
  it("maps both targets to the sole configured root today (single-root; multi-root deferred)", () => {
    // spec(§11) — 9.12r Option A: the renderer sends a closed target; main owns the path. Today one vault
    // root covers the workspace repos + the Global/Coordination repo, so both targets resolve to it.
    expect(resolveRepoRoot("workspace", [ROOT])).toBe(ROOT);
    expect(resolveRepoRoot("global", [ROOT])).toBe(ROOT);
  });

  it("returns null for any unknown / malformed / path-shaped value (no arbitrary path resolves)", () => {
    // spec(§5) — the closed union is the gate: a renderer can never smuggle a filesystem path through the target.
    const notTargets: unknown[] = ["/etc/passwd", "/vault/x.md", "../x", "Workspace", "GLOBAL", "", " ", 1, null, undefined, {}, ["workspace"]];
    for (const bad of notTargets) expect(resolveRepoRoot(bad, [ROOT])).toBeNull();
  });

  it("returns null when no root is configured (fail-closed — no accidental open-all)", () => {
    // spec(§5) — a valid target still resolves to null when there is no configured root.
    expect(resolveRepoRoot("workspace", [])).toBeNull();
  });
});

describe("performVaultAction — true Open-in-Obsidian via obsidian:// + reveal, by CLOSED target (A1; renderer path-blind)", () => {
  const seams = (
    over: {
      openPath?: (p: string) => Promise<string>;
      showInFolder?: (p: string) => void;
      openExternal?: (uri: string) => Promise<void>;
      realpathMap?: Record<string, string>;
      realpathThrowOn?: readonly string[];
    } = {},
  ): VaultActionDeps => ({
    realpath: fakeRealpath(over.realpathMap ?? {}, over.realpathThrowOn ?? []),
    stat: fakeStat(true), // unused on the reveal-mode containment path (no isFile), but required by the deps shape
    openPath: over.openPath ?? (async () => ""),
    showInFolder: over.showInFolder ?? (() => {}),
    openExternal: over.openExternal ?? (async () => {}),
  });

  it("open builds obsidian://open?path=<encoded realpath-resolved root> and opens it in Obsidian (not the folder)", async () => {
    // spec(§11/REQ-UX-003) — the A1 true-open: the OPEN branch opens the vault in Obsidian via the verified
    // obsidian:// URI built from the MAIN-resolved, realpath-canonicalized root (Context7 wire shape).
    const openExternal = vi.fn(async () => {});
    const openPath = vi.fn(async () => "");
    const res = await performVaultAction("open", "workspace", [ROOT], seams({ openExternal, openPath, realpathMap: { [ROOT]: "/real/vault" } }));
    expect(res).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith(`obsidian://open?path=${encodeURIComponent("/real/vault")}`);
    expect(openPath).not.toHaveBeenCalled(); // obsidian:// succeeded ⇒ no A2 fallback
  });

  it("url-encodes the root into the URI so no query-param injection is possible (§5 injection guard)", async () => {
    // spec(§5) — the injection guard is STRUCTURAL: encodeURIComponent neutralizes ? & # space so a root with
    // metacharacters cannot inject extra query params. (The root is main-resolved, never renderer-supplied.)
    const openExternal = vi.fn(async (_uri: string): Promise<void> => {});
    const nasty = "/vault/a b&file=x?y#z";
    const res = await performVaultAction("open", "workspace", [ROOT], seams({ openExternal, realpathMap: { [ROOT]: nasty } }));
    expect(res).toEqual({ ok: true });
    const uri = openExternal.mock.calls[0]![0];
    expect(uri).toBe(`obsidian://open?path=${encodeURIComponent(nasty)}`);
    const query = uri.slice("obsidian://open?path=".length);
    expect(query).not.toMatch(/[ &?#]/); // no raw metacharacter survived into the query
  });

  it("reveal reveals the resolved root in the file manager (unchanged) — no obsidian:// URI opened", async () => {
    // spec(§11/REQ-UX-003) — reveal stays show-in-folder; the A1 upgrade is OPEN-only.
    const openExternal = vi.fn(async () => {});
    const openPath = vi.fn(async () => "");
    const showInFolder = vi.fn(() => {});
    const res = await performVaultAction("reveal", "global", [ROOT], seams({ openExternal, openPath, showInFolder }));
    expect(res).toEqual({ ok: true });
    expect(showInFolder).toHaveBeenCalledWith(ROOT);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reveal maps a showInFolder throw to { ok:false } and NEVER throws (§16)", async () => {
    // spec(§16) — the reveal branch's own shell fault folds to { ok:false }, never a propagated throw.
    const res = await performVaultAction("reveal", "global", [ROOT], seams({
      showInFolder: () => {
        throw new Error("finder boom");
      },
    }));
    expect(res).toEqual({ ok: false });
  });

  it("an ARBITRARY PATH or unknown value as the target FAILS CLOSED — NO obsidian:// opened, zero shell calls (§5)", async () => {
    // spec(§5) — THE key Option-A pin: only a closed target resolves; a path (or any non-member) ⇒ no URI, no
    // shell call. Traversal / arbitrary-open is impossible by construction.
    const openExternal = vi.fn(async () => {});
    const openPath = vi.fn(async () => "");
    const showInFolder = vi.fn(() => {});
    const notTargets: unknown[] = ["/etc/passwd", "/vault/notes/x.md", "../secrets", "", "Workspace", "GLOBAL", 123, null, undefined, {}, ["workspace"]];
    for (const bad of notTargets) {
      const res = await performVaultAction("open", bad, [ROOT], seams({ openExternal, openPath, showInFolder }));
      expect(res).toEqual({ ok: false });
    }
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(showInFolder).not.toHaveBeenCalled();
  });

  it("a valid target with NO configured root fails closed (no URI, zero shell calls)", async () => {
    // spec(§5) — no configured root ⇒ nothing to open, fail closed.
    const openExternal = vi.fn(async () => {});
    const openPath = vi.fn(async () => "");
    const res = await performVaultAction("open", "workspace", [], seams({ openExternal, openPath }));
    expect(res).toEqual({ ok: false });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("a realpath fault on the resolved root fails closed — no URI, never throws", async () => {
    // spec(§16) — never-throws: a realpath seam fault folds to { ok:false } before any shell call.
    const openExternal = vi.fn(async () => {});
    const res = await performVaultAction("open", "workspace", [ROOT], seams({ openExternal, realpathThrowOn: [ROOT] }));
    expect(res).toEqual({ ok: false });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back gracefully to the A2 folder-open when the obsidian:// open fails (Obsidian not installed)", async () => {
    // spec(REQ-UX-003 robustness) — an openExternal reject (no obsidian:// handler) falls back to openPath(root)
    // so the action still does SOMETHING useful; never a hard error / hang.
    const openExternal = vi.fn(async () => {
      throw new Error("no handler for obsidian://");
    });
    const openPath = vi.fn(async () => "");
    const res = await performVaultAction("open", "workspace", [ROOT], seams({ openExternal, openPath }));
    expect(res).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith(ROOT);
  });

  it("the A2 fallback maps a shell error / throw to { ok:false } and NEVER throws (rule 7 / §16)", async () => {
    const openExternal = async (): Promise<void> => {
      throw new Error("obsidian fail");
    };
    // fallback openPath returns a non-empty error string (may echo the path) ⇒ bare { ok:false }, never surfaced
    const r1 = await performVaultAction("open", "workspace", [ROOT], seams({ openExternal, openPath: async () => "EACCES: /vault" }));
    expect(r1).toEqual({ ok: false });
    // fallback openPath itself throws ⇒ still { ok:false }, never a propagated throw
    const r2 = await performVaultAction("open", "workspace", [ROOT], seams({
      openExternal,
      openPath: async () => {
        throw new Error("boom");
      },
    }));
    expect(r2).toEqual({ ok: false });
  });
});
