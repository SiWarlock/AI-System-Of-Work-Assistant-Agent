// Task 11.1 slice #46 — deriveSourceNotePath: a TRAVERSAL-SAFE, deterministic, collision-free
// per-source Markdown note path for the ingestion build stage. spec(§13) spec(§16)
//
// This is the injection-surface core: the ingestion `sourceBuildOutputs.build` derives the note
// path from the per-file source identity (sourceId — which carries the hostile file relPath — +
// contentHash). The path MUST stay under the routing-bound `sources/<ws>/` and can NEVER contain
// a traversal, an absolute prefix, an escaping separator, a leading slash/tilde, a NUL, or a
// control char — regardless of what the raw source identity or ws contains. Safe BY CONSTRUCTION:
// the per-source segment is a sha256 hex digest (hex only — no separators/dots/control), and the
// ws segment is guarded (a hostile ws fails closed, never interpolated raw).
import { describe, it, expect } from "vitest";
import { isOk, isErr, sourceId, workspaceId } from "@sow/contracts";
import type { SourceId, WorkspaceId } from "@sow/contracts";
import {
  deriveSourceNotePath,
  sourceIdentityDigest,
  type SourceNoteIdentity,
} from "../../src/composition/sourceNotePath";

// Control/backslash chars are CONSTRUCTED (never source string-literals) so this test's own bytes
// stay pure printable ASCII — a file about traversal/injection safety must carry no stray control
// byte of its own (and no tool/JSON-boundary mangling of escapes).
const NUL = String.fromCharCode(0);
const NL = String.fromCharCode(10); // newline
const TAB = String.fromCharCode(9);
const BSL = String.fromCharCode(92); // backslash

const WS: WorkspaceId = workspaceId("personal-business");
const ident = (id: string, contentHash = "sha256:c1"): SourceNoteIdentity => ({
  sourceId: sourceId(id) as SourceId,
  contentHash,
});
/** Unwrap an ok path (an err here is a test failure). */
function path(ws: WorkspaceId, i: SourceNoteIdentity): string {
  const r = deriveSourceNotePath(ws, i);
  if (!isOk(r)) throw new Error(`expected ok path, got err: ${JSON.stringify(r.error)}`);
  return r.value;
}

// A sha256 hex digest under a `sources/<ws>/` prefix, `.md` suffix — the only shape allowed out.
// The ws segment class mirrors the guard's SAFE_WS_SEGMENT exactly (A-Za-z0-9_- , NO dot).
const SAFE_SHAPE = /^sources\/[A-Za-z0-9_-]+\/[0-9a-f]+\.md$/;

describe("deriveSourceNotePath — collision-free + deterministic (§13)", () => {
  it("two DISTINCT sources into the same workspace derive DIFFERENT paths", () => {
    expect(path(WS, ident("file:personal-business:notes/a.md"))).not.toBe(
      path(WS, ident("file:personal-business:notes/b.md")),
    );
  });

  it("content-addressed: the SAME sourceId with DIFFERENT content derives DIFFERENT paths", () => {
    expect(path(WS, ident("file:personal-business:a.md", "sha256:v1"))).not.toBe(
      path(WS, ident("file:personal-business:a.md", "sha256:v2")),
    );
  });

  it("deterministic: repeated derivation for the same (ws, identity) is byte-identical", () => {
    expect(path(WS, ident("file:pb:a.md", "sha256:x"))).toBe(path(WS, ident("file:pb:a.md", "sha256:x")));
  });

  it("the derived path always matches the safe shape (sources/<ws>/<hex>.md)", () => {
    expect(path(WS, ident("file:personal-business:a.md"))).toMatch(SAFE_SHAPE);
  });
});

describe("sourceIdentityDigest — the content-addressed key the path + planId share (§13)", () => {
  it("is hex-only (safe by construction) + deterministic", () => {
    const d = sourceIdentityDigest(ident("file:personal-business:a.md", "sha256:x"));
    expect(d).toMatch(/^[0-9a-f]+$/);
    expect(sourceIdentityDigest(ident("file:personal-business:a.md", "sha256:x"))).toBe(d);
  });

  it("distinct sourceId OR distinct contentHash ⇒ distinct digest; same both ⇒ same digest", () => {
    const base = sourceIdentityDigest(ident("file:pb:a.md", "c1"));
    expect(sourceIdentityDigest(ident("file:pb:b.md", "c1"))).not.toBe(base); // diff sourceId
    expect(sourceIdentityDigest(ident("file:pb:a.md", "c2"))).not.toBe(base); // diff content
    expect(sourceIdentityDigest(ident("file:pb:a.md", "c1"))).toBe(base); // same both
  });

  it("the note path embeds exactly this digest", () => {
    const i = ident("file:pb:a.md", "c1");
    expect(path(WS, i)).toBe(`sources/${String(WS)}/${sourceIdentityDigest(i)}.md`);
  });
});

describe("deriveSourceNotePath — traversal-safe BY CONSTRUCTION (§16, load-bearing)", () => {
  // A hostile sourceId (the relPath is attacker-controlled) can carry any of these; the derived
  // path must be hashed → STAY under sources/<ws>/, never escape.
  const hostileSourceIds = [
    "file:personal-business:../../etc/passwd",
    "file:personal-business:/abs/path",
    "file:personal-business:~/secret",
    "../../../../etc/shadow",
    "file:personal-business:a/../../b",
    "file:personal-business:sources/other-ws/pwned.md",
    "file:personal-business:x y",
    `file:personal-business:a${NL}b${TAB}c`, // embedded newline + tab
    `file:personal-business:a${NUL}b`, // embedded NUL
    "..",
    "/",
    "",
  ];
  for (const hostile of hostileSourceIds) {
    it(`hostile sourceId ${JSON.stringify(hostile)} → hashed, stays under sources/<ws>/ (no escape)`, () => {
      // Build the identity directly (bypass the brand constructor which rejects empty) to probe the
      // helper's own guard; a degenerate identity may fail-closed OR hash to a safe path — never escape.
      const i: SourceNoteIdentity = { sourceId: hostile as SourceId, contentHash: "sha256:c" };
      const r = deriveSourceNotePath(WS, i);
      if (isErr(r)) return; // fail-closed is acceptable for a degenerate identity
      expect(r.value).toMatch(SAFE_SHAPE);
      expect(r.value.startsWith(`sources/${String(WS)}/`)).toBe(true);
      expect(r.value).not.toContain("..");
      expect(r.value).not.toContain(" ");
      expect(r.value.split("/").filter((seg) => seg === "..")).toHaveLength(0);
    });
  }

  it("a hostile contentHash cannot escape either (hashed with the sourceId)", () => {
    const r = deriveSourceNotePath(WS, {
      sourceId: sourceId("file:personal-business:a.md") as SourceId,
      contentHash: "../../etc /passwd",
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toMatch(SAFE_SHAPE);
  });
});

describe("deriveSourceNotePath — WS-8: path under the routing-bound workspace (§16)", () => {
  it("the path is under sources/<the passed ws>/ (stamped from ws, not source content)", () => {
    expect(
      path(workspaceId("employer-work"), ident("file:employer-work:a.md")).startsWith("sources/employer-work/"),
    ).toBe(true);
  });

  // The ws segment is interpolated into the path but WorkspaceId is NOT charset-validated (a bare
  // branded string). An unsafe ws must FAIL CLOSED — never break sources/<ws>/ confinement. Incl. a
  // trailing-newline case: JS `$` (no `m` flag) matches end-of-STRING, so `^…$` does NOT anchor
  // before a trailing newline — pinning it guards the guard against a future regex refactor to `m`.
  const unsafeWs = ["..", ".", "a/b", `a${BSL}b`, "../other-ws", "x y", "", "  ", "a/../b", `ws${NL}`, "ws "];
  for (const bad of unsafeWs) {
    it(`unsafe ws ${JSON.stringify(bad)} → fail-closed err (never an escaping/confused path)`, () => {
      expect(isErr(deriveSourceNotePath(bad as WorkspaceId, ident("file:x:a.md")))).toBe(true);
    });
  }

  it("a normal kebab workspace id is accepted", () => {
    expect(isOk(deriveSourceNotePath(workspaceId("personal-life"), ident("file:personal-life:a.md")))).toBe(true);
  });
});
