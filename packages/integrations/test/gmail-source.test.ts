// @sow/integrations — Phase-13 §13.10c Gmail ingestion source adapter (emit-only, on the §13.2 pattern).
//
// The governed-inheritance seam for a Gmail message extraction. A real
// `messages.get` hydration (§13.10a, PKG-INT-5's `createGmailHydrator` if/when it
// lands) runs behind an INJECTED `GmailSourceTransport` (a fake in tests — NO
// network) and the adapter turns its output into a CANDIDATE `RegisterSourceInput`.
// The proof that governance holds: the emitted candidate must pass the REAL
// `registerSource()` gate end-to-end (transport → candidate → gate), and every
// failure is a typed `Result` err, never a throw across the boundary (Lesson 11).
// Mirrors `podcast-source.test.ts` / `youtube-source.test.ts`.
//
// WRITE-SURFACE SCAN (by inspection of gmail-source.ts's import list): the module
// imports ONLY `@sow/contracts` (ok/err/Result), `../../hash/payload-hash`
// (payloadHash), and `../source-register` (the RegisterSourceInput type). No
// `@sow/knowledge` import, no `node:fs`, no filesystem write of any kind.
import { describe, it, expect } from "vitest";
import {
  extractGmailSource,
  type GmailSourceTransport,
  type ExtractGmailSourceInput,
} from "../src/connectors/adapters/gmail-source";
import {
  registerSource,
  type RegisterSourceDeps,
  type RegisterSourceInput,
} from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A fake extractor transport standing in for a real Gmail message hydration (no network in tests).
function fakeTransport(
  bodyText = "The message body. Candidate data flows to the gate, never the vault.",
): GmailSourceTransport {
  return async () => ({
    ok: true,
    message: {
      messageId: "msg-abc123",
      threadId: "thread-1",
      subject: "Quarterly planning",
      from: "alice@example.com",
      receivedAt: "2026-07-01T12:00:00Z",
      bodyText,
    },
  });
}

function input(partial: Partial<ExtractGmailSourceInput> = {}): ExtractGmailSourceInput {
  return {
    sourceId: "src_gmail_1",
    workspaceId: "employer-work",
    messageId: "msg-abc123",
    sensitivity: "normal",
    ...partial,
  };
}

describe("Phase-13 §13.10c — extractGmailSource (emit-only Gmail ingestion source adapter)", () => {
  it("maps a Gmail message → a candidate RegisterSourceInput (type gmail_message, stable origin, workspace/sensitivity/sourceId passed through)", async () => {
    const res = await extractGmailSource(input(), fakeTransport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("gmail_message");
    expect(c.origin).toBe("gmail://message/msg-abc123"); // stable locator derived from messageId
    expect(c.workspaceId).toBe("employer-work");
    expect(c.sensitivity).toBe("normal");
    expect(c.sourceId).toBe("src_gmail_1");
    expect(c.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(c.routingHints).not.toHaveProperty("bodyText"); // the content is not a routing hint
  });

  it("contentHash is WORKSPACE-SCOPED — the SAME message content in two DIFFERENT workspaceIds yields DIFFERENT hashes (no false cross-workspace dedupe)", async () => {
    const a = await extractGmailSource(input({ workspaceId: "employer-work" }), fakeTransport("identical body"));
    const b = await extractGmailSource(input({ workspaceId: "personal-business" }), fakeTransport("identical body"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.contentHash).not.toBe(b.value.contentHash);
  });

  it("REPLAY STABILITY: the same input extracted twice yields a byte-identical candidate (no clock, no randomness)", async () => {
    const a = await extractGmailSource(input(), fakeTransport("stable body"));
    const b = await extractGmailSource(input(), fakeTransport("stable body"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toEqual(b.value);
  });

  it("NO INFERENCE (REQ-F-017): workspaceId/sourceId/sensitivity are passed through from input, NEVER derived from the message; a message whose from/subject imply a different workspace still carries input.workspaceId", async () => {
    const res = await extractGmailSource(
      input({ workspaceId: "personal-life", sourceId: "src_x", sensitivity: "confidential" }),
      async () => ({
        ok: true,
        message: {
          messageId: "msg-y",
          subject: "Re: employer-work quarterly numbers",
          from: "boss@acme-corp.com",
          bodyText: "this content strongly implies a different workspace entirely",
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workspaceId).toBe("personal-life"); // NOT derived from from/subject content
    expect(res.value.sourceId).toBe("src_x");
    expect(res.value.sensitivity).toBe("confidential");
  });

  it("no-inference on absent optional metadata: a message with NO receivedAt/threadId OMITS them from routingHints — never defaulted (REQ-F-017)", async () => {
    const res = await extractGmailSource(
      input(),
      async () => ({
        ok: true,
        message: { messageId: "msg-bare", subject: "Bare", from: "a@b.com", bodyText: "some body" },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.routingHints).not.toHaveProperty("receivedAt");
    expect(res.value.routingHints).not.toHaveProperty("threadId");
    expect(res.value.routingHints).toMatchObject({ subject: "Bare", from: "a@b.com" });
  });

  it("fails CLOSED on an EMPTY / whitespace-only / non-string bodyText — never emits a contentless candidate (safety rules 2/6)", async () => {
    for (const bad of ["", "   \n  ", null, undefined] as const) {
      const res = await extractGmailSource(
        input(),
        (async () => ({
          ok: true,
          message: { messageId: "msg-z", subject: "S", from: "a@b.com", bodyText: bad },
        })) as unknown as GmailSourceTransport,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a pathological message shape — a null message ⇒ empty_content, a field read that THROWS ⇒ 'unknown'; never a throw across the seam (Lesson 11, whole map under one try)", async () => {
    const nullMessage = (async () => ({ ok: true, message: null })) as unknown as GmailSourceTransport;
    const resNull = await extractGmailSource(input(), nullMessage);
    expect(resNull.ok).toBe(false);
    if (resNull.ok) return;
    expect(resNull.error.code).toBe("empty_content");

    const hostileGetter = (async () => {
      const message = { messageId: "msg-h", subject: "S", from: "a@b.com" };
      Object.defineProperty(message, "bodyText", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return { ok: true, message };
    }) as unknown as GmailSourceTransport;
    const resHostile = await extractGmailSource(input(), hostileGetter);
    expect(resHostile.ok).toBe(false);
    if (resHostile.ok) return;
    expect(resHostile.error.code).toBe("unknown");
  });

  it("never throws across the boundary — a transport that throws becomes a typed 'unknown' err", async () => {
    const throwing: GmailSourceTransport = async () => {
      throw new Error("gmail fetch exploded");
    };
    const res = await extractGmailSource(input(), throwing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
  });

  it("typed transport codes pass through UNCOLLAPSED — unreachable stays unreachable, not_found stays not_found", async () => {
    const unreachable: GmailSourceTransport = async () => ({ ok: false, code: "unreachable", message: "gmail API 503" });
    const resUnreachable = await extractGmailSource(input(), unreachable);
    expect(resUnreachable.ok).toBe(false);
    if (resUnreachable.ok) return;
    expect(resUnreachable.error.code).toBe("unreachable");

    const notFound: GmailSourceTransport = async () => ({ ok: false, code: "not_found", message: "message deleted" });
    const resNotFound = await extractGmailSource(input(), notFound);
    expect(resNotFound.ok).toBe(false);
    if (resNotFound.ok) return;
    expect(resNotFound.error.code).toBe("not_found");
  });

  it("ING-7 (safety rule 6): routingHints carries trustLevel 'untrusted' UNCONDITIONALLY — mail bodies are untrusted external content, so the downstream extraction agent runs read-only with no mutating tools; there is no code path that can produce 'trusted'", async () => {
    const withEverything = await extractGmailSource(
      input(),
      async () => ({
        ok: true,
        message: {
          messageId: "msg-t",
          threadId: "thread-t",
          subject: "S",
          from: "a@b.com",
          receivedAt: "2026-01-01T00:00:00Z",
          bodyText: "body",
        },
      }),
    );
    const bare = await extractGmailSource(
      input(),
      async () => ({ ok: true, message: { messageId: "msg-b", subject: "S", from: "a@b.com", bodyText: "body" } }),
    );
    for (const res of [withEverything, bare]) {
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.value.routingHints.trustLevel).toBe("untrusted");
    }
  });

  it("GOVERNANCE PROOF: the emitted candidate PASSES the REAL registerSource() gate for a valid case, and is REJECTED by it for a candidate with an empty origin (the gate is genuinely exercised, not vacuous)", async () => {
    const extracted = await extractGmailSource(input(), fakeTransport());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;

    const registered = await registerSource(extracted.value, { seenContentHash: neverSeen });
    expect(registered.outcome).toBe("registered");
    if (registered.outcome === "registered") {
      expect(registered.envelope.type).toBe("gmail_message");
      expect(registered.envelope.workspaceId).toBe("employer-work");
    }

    const emptyOrigin: RegisterSourceInput = { ...extracted.value, origin: "" };
    const rejected = await registerSource(emptyOrigin, { seenContentHash: neverSeen });
    expect(rejected.outcome).toBe("rejected");
  });

  it("re-registering the same message content is a NO-OP dedupe hit (Flow-4), never a duplicate source", async () => {
    const extracted = await extractGmailSource(input(), fakeTransport("dedupe me"));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(extracted.value, { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
  });

  it("does not mutate its input (pure, emit-only — no hidden side effect, no clock/network of its own)", async () => {
    const original = input();
    const frozen = Object.freeze({ ...original });
    const res = await extractGmailSource(frozen, fakeTransport());
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(original);
  });
});
