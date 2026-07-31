// 13.8f-B — createMeetingVaultPort's own contract: it threads its (minimal, narrow-cut) arguments into
// `rewriteVaultForMeeting` and narrows the receipt to EXACTLY `{meetingNoteLinkMutations}` — never
// `plans`/`refusals`/`groundedPaths`. `rewriteVaultForMeeting` itself is packages/knowledge territory,
// already extensively pinned there (packages/knowledge/test/meeting-rewrite.test.ts) — this test does
// NOT re-verify its grounding/planning correctness, only THIS adapter's own mapping contract, so
// `rewriteVaultForMeeting` is mocked at the module boundary rather than driven end-to-end.
//
// 13.8g-B — `normalizeAttendees` is kept REAL (via `importOriginal`), not mocked: it is small, pure,
// already extensively pinned in packages/knowledge/test/attendee-refs.test.ts, and mapping attendees
// through it IS this adapter's own contract this slice adds — mocking it too would test a double
// standing in for the exact logic under test (contracts L85), not this adapter's real behavior.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { workspaceId, sourceId } from "@sow/contracts";
import type { SourceRef } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { MeetingRewriteReceipt, MeetingRewriteDeps } from "@sow/knowledge";

const rewriteVaultForMeetingMock = vi.fn<(...args: unknown[]) => Promise<MeetingRewriteReceipt>>();
vi.mock("@sow/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sow/knowledge")>();
  return {
    ...actual,
    rewriteVaultForMeeting: (...args: unknown[]) => rewriteVaultForMeetingMock(...args),
  };
});

// No global clearMocks is configured — clear call history before EACH test so `mock.calls[0]` always
// means "this test's own first call," not whatever accumulated from tests that ran earlier in the file.
beforeEach(() => {
  rewriteVaultForMeetingMock.mockClear();
});

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
      // 13.8g-B: no attendees argument supplied here ⇒ normalizeAttendees(undefined) ⇒ both empty —
      // byte-equivalent to 13.8f-B's pre-13.8g-B shape (no entity candidates).
      entityRefs: [],
      identifierOnlyRefs: [],
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

describe("createMeetingVaultPort — 13.8g-B: attendee refs feed the rewrite input via normalizeAttendees", () => {
  it("attendee_refs_reach_the_rewrite_input: named attendees populate entityRefs as {name,kind:'person'}", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close", ["Jane Doe", "John Smith"]);

    const [input] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toMatchObject({
      entityRefs: [
        { name: "Jane Doe", kind: "person" },
        { name: "John Smith", kind: "person" },
      ],
      identifierOnlyRefs: [],
    });
  });

  it("identifier_only_attendees_land_in_identifierOnlyRefs_not_entityRefs — the anti-stub-minting rule (13.8g-A)", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close", ["jane@acme.com"]);

    const [input] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toMatchObject({
      entityRefs: [],
      identifierOnlyRefs: [{ name: "jane@acme.com", kind: "person" }],
    });
  });

  it("a_TBD_or_absent_attendees_value_yields_no_refs_and_no_throw", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    // omitted entirely
    await expect(port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close")).resolves.toBeDefined();
    const [omittedInput] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(omittedInput).toMatchObject({ entityRefs: [], identifierOnlyRefs: [] });

    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    // explicitly the TBD sentinel (the model didn't know)
    await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close", TBD);
    const [tbdInput] = rewriteVaultForMeetingMock.mock.calls[1]!;
    expect(tbdInput).toMatchObject({ entityRefs: [], identifierOnlyRefs: [] });
  });

  it("a_hostile_attendees_value_cannot_escape_the_normalizer — never throws, wiring cannot bypass it", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    const hostileNonArray = { not: "an-array" };
    await expect(
      port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close", hostileNonArray),
    ).resolves.toBeDefined();
    const [input] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toMatchObject({ entityRefs: [], identifierOnlyRefs: [] });
  });

  it("a mixed valid/hostile attendee list keeps the valid refs — one bad entry never drops the rest", async () => {
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    await port.rewrite(WS, NOTE_PATH, SOURCE_REF, "meeting_close", [
      "Jane Doe",
      42,
      "",
      "jane@acme.com",
    ]);
    const [input] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toMatchObject({
      entityRefs: [{ name: "Jane Doe", kind: "person" }],
      identifierOnlyRefs: [{ name: "jane@acme.com", kind: "person" }],
    });
  });

  it("[FINDING, tracked] a REALISTIC schema-gated attendee value (a scalar string) yields ZERO refs today — pinned, not silently shipped", async () => {
    // apps/worker/src/composition/meeting-extraction.ts:72-74's isPrimitiveOrTbd is the REAL, production-
    // wired structural gate (buildActivities.ts:518) every meeting-close field passes through before
    // buildOutputs.ts ever sees it — string | number | boolean | "TBD" ONLY. An array is structurally
    // IMPOSSIBLE here: createMeetingExtractionSchemaGate rejects the WHOLE extraction (schema_rejected,
    // no commit) if any field.value isn't primitive-or-TBD, so a validated meeting extraction can never
    // carry attendees as an array. normalizeAttendees requires Array.isArray(raw) to do anything — so a
    // realistic delimited string (the only shape that can survive the gate) hits its non-array branch
    // and yields empty. This is a KNOWN, ACCEPTED gap this slice does not close — task 13.8g-C tracks
    // the follow-up decision — pinned here so it fails loudly if silently "fixed" by accident in a way
    // that doesn't match the eventual owner ruling.
    rewriteVaultForMeetingMock.mockResolvedValueOnce(fixtureReceipt());
    const port = createMeetingVaultPort(stubKnowledgeDeps);
    await port.rewrite(
      WS,
      NOTE_PATH,
      SOURCE_REF,
      "meeting_close",
      "Jane Doe <jane@acme.com>, John Smith <john@acme.com>",
    );
    const [input] = rewriteVaultForMeetingMock.mock.calls[0]!;
    expect(input).toMatchObject({ entityRefs: [], identifierOnlyRefs: [] });
  });
});
