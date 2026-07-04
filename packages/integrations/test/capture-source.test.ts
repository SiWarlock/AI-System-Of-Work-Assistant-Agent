// @sow/integrations — PROTOTYPE (Phase-13 §13.6 "capture as I work", G4).
//
// ONE governed capture-source adapter, TWO triggers folded onto the same spine:
//   • git-driven (coding session)     → trustLevel 'trusted'   (deterministic)
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

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;
const allowAll: CaptureDeps = { isAllowedTelegramSender: () => true };
const denyAll: CaptureDeps = { isAllowedTelegramSender: () => false };

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
});
