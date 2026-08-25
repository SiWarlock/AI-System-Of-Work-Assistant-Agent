// @sow/integrations — PROTOTYPE (Phase-13 §13.6 "capture as I work", G4).
//
// ONE governed capture-source adapter, TWO triggers folded onto the same spine:
//   • git-driven (coding session)     → trustLevel DERIVED from an injected verifier (24.14),
//                                        downgrading to 'untrusted' when unverified — see below
//   • telegram mobile quick-capture   → trustLevel 'untrusted' (ING-7 read-only
//                                        downstream) + sender allowlist (fail-closed)
// Both are EMIT-ONLY: they map a capture into a CANDIDATE `RegisterSourceInput` and
// never write. The proof: the emitted candidate passes the REAL `registerSource()`
// gate; every failure is a typed `Result` err, never a throw.
import { describe, it, expect } from "vitest";
import {
  buildCaptureSource,
  type BuildCaptureInput,
  type CaptureDeps,
} from "../src/connectors/adapters/capture-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";
import {
  buildCodingSessionCapture,
  createCodingSessionOriginVerifier,
} from "../src/connectors/adapters/coding-session-capture";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;
const allowAll: CaptureDeps = { isAllowedTelegramSender: () => true, verifyCodingSessionOrigin: () => true };
const denyAll: CaptureDeps = { isAllowedTelegramSender: () => false, verifyCodingSessionOrigin: () => false };

function gitInput(partial: Partial<BuildCaptureInput> = {}): BuildCaptureInput {
  return {
    sourceId: "src_cap_git_1",
    workspaceId: "employer-work",
    sensitivity: "normal",
    capture: {
      kind: "coding_session",
      repo: "github.com/acme/api",
      sessionSummary: "Chose Drizzle over Prisma for the operational store; migration path decided.",
      commit: "a1b2c3d",
    },
    ...partial,
  };
}

function tgInput(partial: Partial<BuildCaptureInput> = {}): BuildCaptureInput {
  return {
    sourceId: "src_cap_tg_1",
    workspaceId: "personal-business",
    sensitivity: "normal",
    capture: {
      kind: "telegram",
      chatId: "chat123",
      sender: "owner",
      messageKind: "voice",
      content: "Idea: add a retrieval-eval gate before trusting the new embed model.",
    },
    ...partial,
  };
}

describe("Phase-13 §13.6 — buildCaptureSource (git + telegram triggers, one governed spine)", () => {
  it("GIT trigger → candidate (type coding_session, trusted, workspace passed through)", async () => {
    const res = buildCaptureSource(gitInput(), allowAll);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("coding_session");
    expect(c.origin).toBe("github.com/acme/api");
    expect(c.workspaceId).toBe("employer-work"); // scoped-before-durable, not inferred
    expect(c.routingHints).toMatchObject({ trigger: "git", trustLevel: "trusted", commit: "a1b2c3d" });
    // and it passes the REAL gate end-to-end
    const reg = await registerSource(c, { seenContentHash: neverSeen });
    expect(reg.outcome).toBe("registered");
  });

  it("GIT trigger WITHOUT a verified origin FAILS CLOSED to UNTRUSTED (24.14) — a bare `kind: coding_session` claim does not self-grant trust", () => {
    const res = buildCaptureSource(gitInput(), denyAll);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Still emits a candidate (emit-only posture, never a construct-time reject) — just
    // classified honestly, mirroring the acceptance wording: "not trusted", not "rejected".
    expect(res.value.routingHints).toMatchObject({ trustLevel: "untrusted", trigger: "git" });
  });

  it("TELEGRAM trigger (allowlisted sender) → candidate (type telegram_capture, UNTRUSTED → ING-7 downstream)", async () => {
    const res = buildCaptureSource(tgInput(), allowAll);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("telegram_capture");
    expect(c.origin).toBe("telegram://chat123");
    expect(c.routingHints).toMatchObject({ trigger: "telegram", trustLevel: "untrusted", messageKind: "voice" });
    const reg = await registerSource(c, { seenContentHash: neverSeen });
    expect(reg.outcome).toBe("registered");
  });

  it("TELEGRAM from a NON-allowlisted sender FAILS CLOSED (sender allowlist) — no candidate", () => {
    const res = buildCaptureSource(tgInput(), denyAll);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("sender_not_allowed");
  });

  it("only telegram consults the sender allowlist — git capture ignores it", () => {
    // denyAll would reject a telegram capture, but a git capture must still succeed.
    const res = buildCaptureSource(gitInput(), denyAll);
    expect(res.ok).toBe(true);
  });

  it("empty capture content fails closed (no hollow source, no inference)", () => {
    const g = buildCaptureSource(gitInput({ capture: { kind: "coding_session", repo: "r", sessionSummary: "  " } }), allowAll);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.code).toBe("empty_content");
  });

  it("derives a deterministic, replay-stable contentHash (Flow-4 dedupe key)", async () => {
    const a = buildCaptureSource(gitInput(), allowAll);
    const b = buildCaptureSource(gitInput(), allowAll);
    const c = buildCaptureSource(gitInput({ capture: { kind: "coding_session", repo: "github.com/acme/api", sessionSummary: "different" } }), allowAll);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.value.contentHash).toBe(b.value.contentHash);
    expect(a.value.contentHash).not.toBe(c.value.contentHash);
    // same content re-registered → NO-OP dedupe hit, never a duplicate source
    const dedupe = await registerSource(a.value, { seenContentHash: async () => true });
    expect(dedupe.outcome).toBe("dedupe_hit");
  });

  it("is pure/emit-only — does not mutate its input and never throws", () => {
    const input = gitInput();
    const frozen = Object.freeze({ ...input });
    const res = buildCaptureSource(frozen, allowAll);
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(input);
  });

  // 23.6 mirror case: the REAL producer (buildCodingSessionCapture) + the REAL sanctioned
  // verifier (createCodingSessionOriginVerifier) wired through this UNCHANGED gate.
  describe("23.6 end-to-end — the real coding-session producer + verifier through the unchanged gate", () => {
    const verifier = createCodingSessionOriginVerifier({
      knownRepos: ["/repos/acme-api"],
      verifyCommitSha: (_repo, sha) => sha === "goodsha",
    });
    const deps: CaptureDeps = { isAllowedTelegramSender: () => true, verifyCodingSessionOrigin: verifier };

    it("a verified origin (known repo + good sha) => trustLevel 'trusted'", () => {
      const built = buildCodingSessionCapture({
        repoPath: "/repos/acme-api",
        commitSha: "goodsha",
        subject: "Add the resolver",
        changedFiles: ["a.ts"],
        insertions: 10,
        deletions: 0,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const res = buildCaptureSource(
        { sourceId: "src_e2e_1", workspaceId: "employer-work", sensitivity: "normal", capture: built.value },
        deps,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.routingHints).toMatchObject({ trustLevel: "trusted" });
    });

    it("an UNVERIFIED origin (bad sha) => trustLevel 'untrusted' — a downgrade, never a rejection", () => {
      const built = buildCodingSessionCapture({
        repoPath: "/repos/acme-api",
        commitSha: "badsha",
        subject: "Add the resolver",
        changedFiles: ["a.ts"],
        insertions: 10,
        deletions: 0,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const res = buildCaptureSource(
        { sourceId: "src_e2e_2", workspaceId: "employer-work", sensitivity: "normal", capture: built.value },
        deps,
      );
      expect(res.ok).toBe(true); // still emits a candidate — emit-only posture (rule 1)
      if (!res.ok) return;
      expect(res.value.routingHints).toMatchObject({ trustLevel: "untrusted" });
    });

    it("an UNKNOWN repo (not in knownRepos) => trustLevel 'untrusted' too — the repo gate alone must downgrade", () => {
      const built = buildCodingSessionCapture({
        repoPath: "/repos/some-other-repo",
        commitSha: "goodsha",
        subject: "Add the resolver",
        changedFiles: ["a.ts"],
        insertions: 10,
        deletions: 0,
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const res = buildCaptureSource(
        { sourceId: "src_e2e_3", workspaceId: "employer-work", sensitivity: "normal", capture: built.value },
        deps,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.routingHints).toMatchObject({ trustLevel: "untrusted" });
    });
  });
});
