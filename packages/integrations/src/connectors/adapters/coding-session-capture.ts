// @sow/integrations — 23.6: coding-session git-hook capture producer + repo→workspace
// resolver + the sanctioned `verifyCodingSessionOrigin` binding (Phase-13 §13.6, 24.14).
//
// PREMISE (corrected — the plan row's "telegram-capture.ts:1-16" citation is stale;
// that file is a complete 104-line Telegram Bot API receiver, untouched here). The git
// leg of "capture as I work" was UNBUILT: capture-source.ts already declares the
// `CodingSessionCapture` shape and REQUIRES a `verifyCodingSessionOrigin` (no default),
// but nothing produced a capture from a real git event, mapped a repo to a workspace, or
// supplied a real verifier — so a future binding could silently supply a permissive
// `() => true`. This file supplies all three.
//
// PURE + TOTAL (§16): every export here is deterministic — no child_process (never shells
// out to `git`), no fs, no clock, no randomness. `buildCodingSessionCapture` maps the SAME
// `GitHookEvent` to the SAME `CodingSessionCapture` on every call. NO INFERENCE
// (REQ-F-017): the capture carries only `kind`/`repo`/`sessionSummary`/`commit` — never an
// author, date, owner, or workspace (workspace resolution is `createRepoWorkspaceResolver`'s
// separate, later concern, itself fail-closed on an unmapped repo).
//
// DORMANT: no hook is installed, no worker activity calls these exports (that ingress —
// receiving an actual git-hook invocation — is apps/worker territory, out of scope here).
// ING-7: nothing in this file imports @sow/knowledge or exposes a mutating path; a capture
// this module builds only ever flows through `buildCaptureSource` (emit-only) and, when
// unverified, downstream extraction runs read-only per the existing `trustLevel` downgrade.
import { posix as posixPath } from "node:path";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { CodingSessionCapture, CaptureDeps } from "./capture-source";

/** A single git-hook invocation's raw facts. Pure input — no clock/fs/child_process. */
export interface GitHookEvent {
  readonly repoPath: string;
  readonly commitSha: string;
  readonly subject: string;
  readonly body?: string;
  readonly changedFiles: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

/** The closed capture-build failure set (§16 — enumerable). */
export interface CaptureBuildError {
  readonly code: "empty_content" | "unmapped_repo";
  readonly message: string;
}

/**
 * Normalize a repo path for EXACT-SEGMENT comparison: purely lexical (no fs/symlink
 * resolution to consult without I/O) and POSIX-style so the result never depends on the
 * host OS, then stripped of a trailing slash (except root). `createRepoWorkspaceResolver`
 * and `createCodingSessionOriginVerifier` both call this so a repo is matched the SAME
 * way in both places. `path.posix.normalize` collapses `..`/`.` segments lexically — it
 * never reads the filesystem, so "/repos/foo/../foo-evil" becomes "/repos/foo-evil"
 * (a distinct string, correctly refused) without ever touching disk.
 */
function normalizeRepoPath(repoPath: string): string {
  const normalized = posixPath.normalize(repoPath.trim());
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Build a CANDIDATE `CodingSessionCapture` from a raw git-hook event. Fails closed —
 * mirroring capture-source.ts's own `empty_content` hollow-source guard one hop
 * upstream — when subject, body, AND changedFiles are ALL empty: no hollow capture is
 * ever built. `sessionSummary` is a deterministic digest of subject + changed-file
 * COUNT + insertions/deletions — never the changed file names or the commit body
 * verbatim (either could carry a pasted secret or a full diff; digesting only shape-level
 * facts keeps this producer minimal-carry, §16).
 */
export function buildCodingSessionCapture(event: GitHookEvent): Result<CodingSessionCapture, CaptureBuildError> {
  const subject = event.subject.trim();
  const body = (event.body ?? "").trim();
  if (subject.length === 0 && body.length === 0 && event.changedFiles.length === 0) {
    return err({ code: "empty_content", message: "git hook event carries no subject, body, or changed files" });
  }
  const sessionSummary = payloadHash({
    subject: event.subject,
    changedFileCount: event.changedFiles.length,
    insertions: event.insertions,
    deletions: event.deletions,
  });
  return ok({
    kind: "coding_session",
    repo: normalizeRepoPath(event.repoPath),
    sessionSummary,
    commit: event.commitSha,
  });
}

/**
 * Build a repo→workspace resolver over a static map. FAILS CLOSED on any repoPath not
 * present in the map — never guesses/derives a workspaceId (no inference, REQ-F-017).
 * Matching is on the normalized path, exact-segment: "/repos/foo-evil" never matches a
 * "/repos/foo" entry (no prefix/substring matching), and a `..` traversal is resolved
 * lexically BEFORE comparison so it can only ever match the real path it lexically
 * resolves to — never smuggle a match past the map.
 */
export function createRepoWorkspaceResolver(
  map: ReadonlyArray<{ readonly repoPath: string; readonly workspaceId: string }>,
): (repoPath: string) => Result<string, CaptureBuildError> {
  const byNormalizedPath = new Map<string, string>();
  for (const entry of map) {
    byNormalizedPath.set(normalizeRepoPath(entry.repoPath), entry.workspaceId);
  }
  return (repoPath: string): Result<string, CaptureBuildError> => {
    const workspaceId = byNormalizedPath.get(normalizeRepoPath(repoPath));
    if (workspaceId === undefined) {
      return err({ code: "unmapped_repo", message: `repo '${repoPath}' is not in the known repo→workspace map` });
    }
    return ok(workspaceId);
  };
}

/**
 * Build the sanctioned `CaptureDeps.verifyCodingSessionOrigin` binding (24.14 —
 * capture-source.ts's REQUIRED-no-default seam). Rejects in BOTH directions: a repo
 * absent from `knownRepos`, AND a commit `verifyCommitSha` refuses — a capture with no
 * `commit` at all fails closed too (nothing to verify). This is the mechanical backstop
 * capture-source.ts's binding-status comment asked for: the sanctioned constructor for
 * a real verifier, so a future caller has a correct binding ready rather than an
 * incentive to hand-roll a permissive `() => true`.
 */
export function createCodingSessionOriginVerifier(deps: {
  readonly knownRepos: readonly string[];
  readonly verifyCommitSha: (repo: string, sha: string) => boolean;
}): CaptureDeps["verifyCodingSessionOrigin"] {
  const known = new Set(deps.knownRepos.map(normalizeRepoPath));
  return (capture: CodingSessionCapture): boolean => {
    if (!known.has(normalizeRepoPath(capture.repo))) return false;
    if (capture.commit === undefined) return false;
    return deps.verifyCommitSha(capture.repo, capture.commit);
  };
}
