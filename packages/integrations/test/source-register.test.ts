// @sow/integrations — slice 6.3 SourceEnvelope registration tests.
//
// `registerSource(input, deps)` builds + validates a `SourceEnvelope` (candidate-
// gate style: ajv `SOURCE_ENVELOPE_SCHEMA_ID` + Zod `SourceEnvelopeSchema`) BEFORE
// any downstream extraction. Load-bearing pins (REQ-F-002 / REQ-F-010 / REQ-F-017,
// Flow 4):
//   • contentHash dedupe: a re-register with an already-seen contentHash
//     (injected `seenContentHash`) is a NO-OP dedupe hit — NEVER a duplicate source.
//   • workspaceId REQUIRED (scoped-before-durable) — a missing/blank one is rejected.
//   • a malformed envelope (unknown key, missing field) is rejected by the gate.
//   • NO owner/date/workspace INFERENCE (REQ-F-017) — low-confidence routing is
//     left to downstream triage; the register step never invents fields.
import { describe, it, expect } from "vitest";
import {
  registerSource,
  type RegisterSourceInput,
  type RegisterSourceDeps,
} from "../src/connectors/source-register";

// A never-seen `seenContentHash` (fresh registration path).
const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A valid, complete register input.
function validInput(partial: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    sourceId: "src_1",
    workspaceId: "employer-work",
    origin: "https://www.youtube.com/watch?v=abc",
    contentHash: "sha256:deadbeef",
    type: "youtube_video",
    sensitivity: "normal",
    routingHints: { projectHint: "acme-api" },
    ...partial,
  };
}

describe("slice 6.3 — registerSource (SourceEnvelope registration)", () => {
  it("registers a valid source → { outcome:'registered', envelope } with the built SourceEnvelope", async () => {
    const res = await registerSource(validInput(), { seenContentHash: neverSeen });
    expect(res.outcome).toBe("registered");
    if (res.outcome !== "registered") return;
    expect(res.envelope.sourceId).toBe("src_1");
    expect(res.envelope.workspaceId).toBe("employer-work");
    expect(res.envelope.contentHash).toBe("sha256:deadbeef");
    expect(res.envelope.origin).toBe("https://www.youtube.com/watch?v=abc");
    expect(res.envelope.type).toBe("youtube_video");
    expect(res.envelope.routingHints).toEqual({ projectHint: "acme-api" });
  });

  it("a re-register with an already-seen contentHash is a NO-OP dedupe hit (REQ-F-010 / Flow 4)", async () => {
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(validInput(), { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
    // A dedupe hit carries the offending contentHash but mints NO new source.
    if (res.outcome !== "dedupe_hit") return;
    expect(res.contentHash).toBe("sha256:deadbeef");
    expect((res as { envelope?: unknown }).envelope).toBeUndefined();
  });

  it("the dedupe check is keyed on contentHash (the exact value is what seenContentHash receives)", async () => {
    const seenArgs: string[] = [];
    const spy: RegisterSourceDeps["seenContentHash"] = async (h) => {
      seenArgs.push(h);
      return false;
    };
    await registerSource(validInput({ contentHash: "sha256:cafe" }), { seenContentHash: spy });
    expect(seenArgs).toEqual(["sha256:cafe"]);
  });

  it("rejects a missing workspaceId (scoped-before-durable, REQ-F-002)", async () => {
    const res = await registerSource(
      validInput({ workspaceId: "" }),
      { seenContentHash: neverSeen },
    );
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.code).toBe("MALFORMED");
  });

  it("rejects a blank contentHash (Flow-4 dedupe key must be present)", async () => {
    const res = await registerSource(
      validInput({ contentHash: "" }),
      { seenContentHash: neverSeen },
    );
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.code).toBe("MALFORMED");
  });

  it("rejects a malformed envelope (unknown extra key) via the .strict() gate", async () => {
    const dirty = { ...validInput(), bogusKey: "nope" } as unknown as RegisterSourceInput;
    const res = await registerSource(dirty, { seenContentHash: neverSeen });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.code).toBe("MALFORMED");
  });

  it("does NOT invoke seenContentHash when the envelope is malformed (gate runs BEFORE dedupe)", async () => {
    let called = false;
    const spy: RegisterSourceDeps["seenContentHash"] = async () => {
      called = true;
      return false;
    };
    await registerSource(validInput({ workspaceId: "" }), { seenContentHash: spy });
    expect(called).toBe(false);
  });

  it("does not invent missing fields — a source with no routingHints is rejected, never defaulted (REQ-F-017)", async () => {
    const noHints = { ...validInput() } as Record<string, unknown>;
    delete noHints.routingHints;
    const res = await registerSource(
      noHints as unknown as RegisterSourceInput,
      { seenContentHash: neverSeen },
    );
    // The register step never fabricates an empty {} — a missing required field is
    // a gate rejection, left for downstream triage.
    expect(res.outcome).toBe("rejected");
  });

  it("never throws — a validation failure returns a typed rejection (§16)", async () => {
    await expect(
      registerSource(validInput({ workspaceId: "" }), { seenContentHash: neverSeen }),
    ).resolves.toBeDefined();
  });
});
