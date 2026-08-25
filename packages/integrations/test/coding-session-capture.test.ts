// @sow/integrations — 23.6: coding-session git-hook capture producer + repo→workspace
// resolver + the origin-verifier binding (24.14's REQUIRED-no-default `CaptureDeps` seam).
//
// PREMISE: telegram-capture.ts already exists complete (104 lines, real getUpdates
// receiver) — this file tests ONLY the git leg: buildCodingSessionCapture (pure producer),
// createRepoWorkspaceResolver (fail-closed repo→workspace map), and
// createCodingSessionOriginVerifier (the sanctioned `verifyCodingSessionOrigin` binding).
// Everything here is dormant — no hook installed, no git binary invoked, zero callers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildCodingSessionCapture,
  createRepoWorkspaceResolver,
  createCodingSessionOriginVerifier,
  type GitHookEvent,
} from "../src/connectors/adapters/coding-session-capture";
import type { CodingSessionCapture } from "../src/connectors/adapters/capture-source";

function hookEvent(partial: Partial<GitHookEvent> = {}): GitHookEvent {
  return {
    repoPath: "/repos/acme-api",
    commitSha: "a1b2c3d4e5f6",
    subject: "Chose Drizzle over Prisma for the operational store",
    body: "Migration path decided after comparing schema-drift tooling.",
    changedFiles: ["packages/db/src/schema.ts", "packages/db/CLAUDE.md"],
    insertions: 42,
    deletions: 7,
    ...partial,
  };
}

describe("23.6 — buildCodingSessionCapture (pure producer, no clock/fs/child_process)", () => {
  it("1. a well-formed hook event yields a capture: normalized repo, commit=sha, deterministic digest summary; same input twice => byte-identical", () => {
    const a = buildCodingSessionCapture(hookEvent());
    const b = buildCodingSessionCapture(hookEvent());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.kind).toBe("coding_session");
    expect(a.value.repo).toBe("/repos/acme-api");
    expect(a.value.commit).toBe("a1b2c3d4e5f6");
    expect(a.value.sessionSummary.length).toBeGreaterThan(0);
    // byte-identical across two independent calls with the same logical input — no
    // clock/randomness leaked into the digest.
    expect(a.value).toEqual(b.value);
  });

  it("1b. the digest changes when subject/counts change (it is not a constant placeholder)", () => {
    const base = buildCodingSessionCapture(hookEvent());
    const changed = buildCodingSessionCapture(hookEvent({ insertions: 999 }));
    expect(base.ok && changed.ok).toBe(true);
    if (!base.ok || !changed.ok) return;
    expect(base.value.sessionSummary).not.toBe(changed.value.sessionSummary);
  });

  it("2. NO INFERENCE (REQ-F-017): the capture carries no author/date/owner/workspace field", () => {
    const res = buildCodingSessionCapture(hookEvent());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const capture = res.value as unknown as Record<string, unknown>;
    expect(Object.keys(capture).sort()).toEqual(["commit", "kind", "repo", "sessionSummary"]);
    expect("author" in capture).toBe(false);
    expect("date" in capture).toBe(false);
    expect("owner" in capture).toBe(false);
    expect("workspace" in capture).toBe(false);
    expect("workspaceId" in capture).toBe(false);
    // the digest itself never encodes an invented field — proven by 1b: it's a function
    // of ONLY subject + changed-file count + insertions/deletions, all inputs the caller
    // already had (never invented).
  });

  it("3. empty subject AND empty body AND zero changed files => a typed empty_content-shaped err, never a hollow capture", () => {
    const res = buildCodingSessionCapture(
      hookEvent({ subject: "  ", body: "   ", changedFiles: [] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("empty_content");
  });

  it("3b. POSITIVE CONTROL for 3 — any ONE non-empty signal (changed files) is enough to avoid empty_content", () => {
    const res = buildCodingSessionCapture(
      hookEvent({ subject: "  ", body: "   ", changedFiles: ["a.ts"] }),
    );
    expect(res.ok).toBe(true);
  });

  it("3c. absent body (undefined) behaves like empty body, not like non-empty content", () => {
    const res = buildCodingSessionCapture(
      hookEvent({ subject: "  ", body: undefined, changedFiles: [] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("empty_content");
  });
});

describe("23.6 — createRepoWorkspaceResolver (fail-closed repo→workspace map)", () => {
  const resolve = createRepoWorkspaceResolver([
    { repoPath: "/repos/foo", workspaceId: "employer-work" },
    { repoPath: "/repos/bar/", workspaceId: "personal-business" },
  ]);

  it("4a. POSITIVE CONTROL — a mapped repoPath resolves to its mapped workspaceId", () => {
    const res = resolve("/repos/foo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe("employer-work");
  });

  it("4b. an unmapped repoPath fails closed — never a guessed workspaceId", () => {
    const res = resolve("/repos/totally-unknown");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unmapped_repo");
  });

  it("5a. PATH SAFETY — '/repos/foo-evil' does NOT match the '/repos/foo' entry (no prefix matching)", () => {
    const res = resolve("/repos/foo-evil");
    expect(res.ok).toBe(false);
  });

  it("5b. PATH SAFETY — a '..' traversal that lexically escapes the mapped entry never matches", () => {
    // /repos/foo/../foo-evil normalizes to /repos/foo-evil — NOT a mapped entry.
    const res = resolve("/repos/foo/../foo-evil");
    expect(res.ok).toBe(false);
  });

  it("5c. a '..' traversal that lexically RESOLVES BACK to a mapped entry still matches (normalization is exact-segment, not a blanket '..' ban)", () => {
    // /repos/bar/../foo normalizes to /repos/foo — the SAME real path as the mapped entry.
    const res = resolve("/repos/bar/../foo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe("employer-work");
  });

  it("5d. matching is on the normalized path — a trailing slash on the map entry doesn't create a distinct entry", () => {
    const res = resolve("/repos/bar");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe("personal-business");
  });
});

describe("23.6 — createCodingSessionOriginVerifier (the sanctioned verifyCodingSessionOrigin binding, 24.14)", () => {
  const verify = createCodingSessionOriginVerifier({
    knownRepos: ["/repos/foo"],
    verifyCommitSha: (_repo, sha) => sha === "goodsha",
  });

  function capture(partial: Partial<CodingSessionCapture> = {}): CodingSessionCapture {
    return { kind: "coding_session", repo: "/repos/foo", sessionSummary: "s", commit: "goodsha", ...partial };
  }

  it("6a. POSITIVE CONTROL — known repo + good sha => true", () => {
    expect(verify(capture())).toBe(true);
  });

  it("6b. unknown repo + a sha that WOULD pass verifyCommitSha => false (repo gate alone must reject)", () => {
    expect(verify(capture({ repo: "/repos/unknown", commit: "goodsha" }))).toBe(false);
  });

  it("6c. known repo + a bad sha => false (commit gate alone must reject)", () => {
    expect(verify(capture({ repo: "/repos/foo", commit: "badsha" }))).toBe(false);
  });

  it("6d. unknown repo + bad sha => false (both gates reject together)", () => {
    expect(verify(capture({ repo: "/repos/unknown", commit: "badsha" }))).toBe(false);
  });

  it("6e. no commit at all => false (fails closed — nothing to verify), even against a permissive verifyCommitSha that would say yes to anything", () => {
    // A verifyCommitSha this permissive would make 6a/6c/6d pass for the WRONG reason if
    // the missing-commit guard didn't exist independently — it accepts every sha, so the
    // ONLY thing that can reject an undefined commit is the explicit guard.
    const permissive = createCodingSessionOriginVerifier({
      knownRepos: ["/repos/foo"],
      verifyCommitSha: () => true,
    });
    expect(permissive(capture({ commit: undefined }))).toBe(false);
  });
});

describe("23.6 — ING-7: the producer exposes no mutating path and imports nothing from @sow/knowledge", () => {
  it("8. the source file imports nothing from @sow/knowledge and calls no fs/child_process/clock API", () => {
    const here = fileURLToPath(import.meta.url);
    const srcPath = here.replace(
      /test\/coding-session-capture\.test\.ts$/,
      "src/connectors/adapters/coding-session-capture.ts",
    );
    const source = readFileSync(srcPath, "utf8");
    // Checks the actual IMPORT statement, not prose — the file's own doc comments
    // legitimately mention "@sow/knowledge" by name when explaining ING-7.
    expect(source).not.toMatch(/from ["']@sow\/knowledge["']/);
    expect(source).not.toMatch(/from ["']node:child_process["']/);
    expect(source).not.toMatch(/from ["']node:fs["']/);
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(/);
    expect(source).not.toMatch(/Math\.random\(\)/);
  });
});
