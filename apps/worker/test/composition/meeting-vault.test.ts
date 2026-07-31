// 13.8f-B — createMeetingVaultPort's own contract: it threads its (minimal, narrow-cut) arguments into
// `rewriteVaultForMeeting` and narrows the receipt to EXACTLY `{meetingNoteLinkMutations}` — never
// `plans`/`refusals`/`groundedPaths`. `rewriteVaultForMeeting` itself is packages/knowledge territory,
// already extensively pinned there (packages/knowledge/test/meeting-rewrite.test.ts) — this test does
// NOT re-verify its grounding/planning correctness, only THIS adapter's own mapping contract, so
// `@sow/knowledge` is mocked at the module boundary rather than driven end-to-end.
import { describe, it, expect, vi } from "vitest";
import { workspaceId, sourceId } from "@sow/contracts";
import type { SourceRef } from "@sow/contracts";
import type { MeetingRewriteReceipt, MeetingRewriteDeps } from "@sow/knowledge";

const rewriteVaultForMeetingMock = vi.fn<(...args: unknown[]) => Promise<MeetingRewriteReceipt>>();
vi.mock("@sow/knowledge", () => ({
  rewriteVaultForMeeting: (...args: unknown[]) => rewriteVaultForMeetingMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe either way, but keeping
// the import below the mock keeps the file's read order matching its actual execution order).
const { createMeetingVaultPort } = await import("../../src/composition/meeting-vault");

const WS = workspaceId("ws-bound");
const SOURCE_REF: SourceRef = { sourceId: sourceId("src-meeting-1") };
const NOTE_PATH = "meetings/ws-bound/weekly-sync.md";

function fixtureReceipt(over: Partial<MeetingRewriteReceipt> = {}): MeetingRewriteReceipt {
  return {
    runId: "run-1",
    plans: [],
    planIds: [],
    autoCount: 0,
    proposeCount: 0,
    meetingNoteLinkMutations: [],
    groundedPaths: [],
    refusals: [],
    ...over,
  };
}

// A minimal, never-actually-invoked MeetingRewriteDeps — the mock replaces rewriteVaultForMeeting
// itself, so these ports are never called; only their TYPE shape matters here.
const stubKnowledgeDeps: MeetingRewriteDeps = {
  gbrain: { workspaceId: WS, get: () => Promise.resolve(undefined) } as unknown as MeetingRewriteDeps["gbrain"],
  reason: {} as MeetingRewriteDeps["reason"],
  sections: {} as MeetingRewriteDeps["sections"],
  newPlanId: () => "plan-1",
  newRunId: () => "run-1",
};

describe("createMeetingVaultPort — 13.8f-B adapter contract (rewriteVaultForMeeting mocked at the module boundary)", () => {
  it("threads workspaceId/meetingNotePath/provenanceOrigin/sourceRefs into rewriteVaultForMeeting verbatim", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close");

    expect(rewriteVaultForMeetingMock).toHaveBeenCalledTimes(1);
    const [input, deps] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toEqual({
      workspaceId: WS,
      provenanceOrigin: "meeting_close",
      meetingNotePath: NOTE_PATH,
      sourceRefs: [{ sourceId: String(SOURCE_REF.sourceId) }],
    });
    expect(deps).toBe(stubKnowledgeDeps);
  });

  it("narrows the receipt to EXACTLY meetingNoteLinkMutations — plans/refusals/groundedPaths never cross the port", async () => {
    const linkMutation = { op: "add" as const, srcPath: NOTE_PATH, dstSlug: "projects/acme" };
    rewriteVaultForMeetingMock.mockResolvedValueOnce(
      fixtureReceipt({
        meetingNoteLinkMutations: [linkMutation],
        plans: [{ planId: "p1" } as never], // a non-empty sibling plan — must NOT leak through
        refusals: ["structural_surface"],
        groundedPaths: ["projects/acme.md"],
      }),
    );
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    const result = await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close");

    expect(result).toEqual({ meetingNoteLinkMutations: [linkMutation] });
    expect(Object.keys(result)).toEqual(["meetingNoteLinkMutations"]);
  });
});
