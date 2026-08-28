// spec(inv-4, R2 restore) — reindexGbrain: the pre-flight "no commit yet" state and
// the client-reported "the commit landed but re-indexing it failed" state share the
// SAME `revision_unavailable` code but are DIFFERENT truths. Collapsing them onto
// one fixed literal ("reindex requires a committed revisionId…") tells the operator
// no commit happened when the opposite may be true — worse than a generic message,
// because it is actively misleading (see the doc comment on `redactReindexError`,
// src/activities/reindexGbrain.ts).
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { createReindexActivity } from "../src/activities/reindexGbrain";
import type { GbrainReindexAck, GbrainReindexClient } from "../src/activities/reindexGbrain";
import type { ReindexError } from "../src/ports/meetingCloseout";

function clientReporting(error: ReindexError): GbrainReindexClient {
  return {
    reindex(): Promise<Result<GbrainReindexAck, ReindexError>> {
      return Promise.resolve(err(error));
    },
  };
}

describe("createReindexActivity — R2 restore: pre-flight vs client-reported revision_unavailable are DIFFERENT states", () => {
  it("the pre-flight guard (empty revisionId — no commit yet, client never called) names the pre-flight reason", async () => {
    const client: GbrainReindexClient = {
      reindex(): Promise<Result<GbrainReindexAck, ReindexError>> {
        throw new Error("unreachable: client must not be called before a commit exists");
      },
    };
    const activity = createReindexActivity({ client });
    const res = await activity.reindex("");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("revision_unavailable");
    expect(res.error.message).toContain("requires a committed revisionId");
  });

  it("a CLIENT-reported revision_unavailable (a commit DID happen) names a DIFFERENT reason", async () => {
    const activity = createReindexActivity({
      client: clientReporting({
        code: "revision_unavailable",
        message: "gbrain: revision rev-1 not found in index store",
        cause: { url: "https://gbrain.internal/index?token=SECRET" },
      }),
    });
    const res = await activity.reindex("rev-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("revision_unavailable");
    // rule 7 stays intact: the raw client cause/message never crosses.
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("rev-1 not found");
    // But the message must NOT claim "no commit happened" — a commit DID happen
    // (reindex was called with a non-empty revisionId; the CLIENT is what failed).
    expect(res.error.message).not.toContain("requires a committed revisionId");
  });

  it("mutation-kill: the pre-flight message and the client-reported message must differ", async () => {
    const preflight = await createReindexActivity({
      client: { reindex: () => Promise.reject(new Error("unreachable: must not be called")) },
    }).reindex("");
    const clientReported = await createReindexActivity({
      client: clientReporting({ code: "revision_unavailable", message: "boom" }),
    }).reindex("rev-1");
    expect(preflight.ok).toBe(false);
    expect(clientReported.ok).toBe(false);
    if (preflight.ok || clientReported.ok) return;
    // Same code (every consumer switches on it byte-identically)…
    expect(preflight.error.code).toBe(clientReported.error.code);
    // …but DIFFERENT messages: one true state is "no commit yet", the other is
    // "a commit landed and the reindex failed" — collapsing them is misleading.
    expect(preflight.error.message).not.toBe(clientReported.error.message);
  });
});
