// @sow/workflows — task U2/C4: PIN THE PAYLOAD that six rounds of "strip more text from
// activity returns" (safety rule 7 hardening) could have silently emptied along the way.
//
// WHY THIS FILE EXISTS: rule 7 says redact INCIDENTAL text nothing consumes before it
// crosses an activity boundary into durable, replayed Temporal workflow history — never
// the PAYLOAD the workflow actually moves between steps (root CLAUDE.md "THE SCOPE
// BOUNDARY"). An adversarial gate found that the most load-bearing payload in the
// meeting pipeline — `meetingValidate`'s ok-arm `fields` (the validated extraction that
// becomes the committed note) — had NO pin: an earlier round REPORTED that replacing
// `fields: extraction.fields` with `fields: {}` in production left the whole @sow/workflows
// package green. `meetingCorrelate`'s low-confidence ok-arm `reason` had the same gap. Six
// consecutive redaction rounds ran straight over this code; nothing would have caught an
// over-redaction that emptied it.
//
// THAT "WHOLE PACKAGE GREEN" NUMBER IS NOT RESTATED HERE, BECAUSE IT NO LONGER HOLDS AND
// REPEATING IT WOULD MISLEAD. Re-measured 2026-08-27 on the current working tree (controlled
// A/B, same tree, four suites): with `fields: {}` applied, exactly TWO files red — this one,
// and `validate-closeout-schema-gate-redaction.test.ts`. The second is an UNTRACKED redaction
// suite this round's hardening created. So the gap the original census found has since been
// covered — but ONLY inside a file that a future redaction round can delete along with the
// over-redaction it is supposed to catch. That is the exact fragility task C4 exists to remove,
// and it is why the pin is restated below rather than delegated.
//
// WHY EVERY PAYLOAD PIN LIVES *HERE*, INCLUDING ONES THAT ALSO EXIST ELSEWHERE (task C4):
// the pins that did exist were scattered across suites whose SUBJECT is redaction — files
// the hardening rounds themselves created, and that a future hardening round is likely to
// rewrite or replace wholesale. A payload pin that only lives inside a redaction suite is
// deleted by the same edit that over-redacts the payload. So this file duplicates them on
// purpose: it is the COUNTERWEIGHT to that hardening, and it must red on an emptied payload
// field WHATEVER ELSE THE ROUND DELETES. Duplication with the redaction suites is the point,
// not an oversight — do not "de-duplicate" these back out.
//
// THE SEVEN PAYLOAD SITES PINNED BELOW (one `describe` each), re-derived from the ok-arm
// returns of the activities the redaction rounds touched:
//   1. validateCloseout.ts        — ok arm `fields`                (the committed note's data)
//   2. correlateMeeting.ts        — HIGH ok arm `workspaceId`/`projectId` (the WS-2 bind)
//   3. correlateMeeting.ts        — LOW  ok arm `reason`           (why it needs routing review)
//   4. proposeExternalActions.ts  — ok arm `envelope.writeReceipt` (the no-duplicate-write proof)
//   5. gatherAvailability.ts      — ok arm `busyWindows` + `readSources`
//   6. runAgentJob.ts             — ok arm `mapCandidate` pass-through
//   7. readOnlyAgentJob.ts        — ok arm `mapCandidate` pass-through
//
// Every `it` below asserts DEEP EQUALITY / exact VALUE identity against real field content —
// never a shape check `{}` would satisfy. A `toBeDefined()` or `toHaveLength()` alone is
// exactly the kind of assertion that let the confirmed gaps through: `proposeExternalActions`'s
// `envelope.writeReceipt` and `gatherAvailability`'s `busyWindows` were pinned only by
// presence/length in the pre-existing suites, not by content.
//
// SCOPE OF THE MUTATION CLAIM, STATED PRECISELY: each of the seven was proved by transiently
// emptying the named production expression, running ONLY THIS FILE, observing RED, and
// reverting (production sha256 re-checked against its pre-mutation value). That proves this
// file DISCRIMINATES an emptied payload at those seven sites. It does NOT prove the seven are
// the complete set of payload-bearing ok arms in the package — no such census has been run.
// A reader adding an activity should assume this list is a floor, not a closure.
import { describe, it, expect } from "vitest";
import { ok, isOk, workspaceId, workflowId, actionId } from "@sow/contracts";
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
} from "@sow/contracts";
import type { ExternalWriteResult } from "@sow/integrations";
import type { BrokerAccepted, BrokerOutcome } from "@sow/providers";

import { createValidateActivity } from "../src/activities/validateCloseout";
import type { AgentExtraction } from "../src/ports/meetingCloseout";

import { createCorrelateActivity } from "../src/activities/correlateMeeting";
import type { CorrelationSignals } from "../src/activities/correlateMeeting";
import { makeMeetingContext } from "./support/meeting-fakes";

import { createProposeActivity } from "../src/activities/proposeExternalActions";
import type { DispatchExternalWriteFn } from "../src/activities/proposeExternalActions";

import { createGatherAvailabilityActivity } from "../src/activities/gatherAvailability";
import type {
  AvailabilitySourceQuery,
  AvailabilityGate,
} from "../src/activities/gatherAvailability";
import type { BusyWindow } from "../src/ports/crossCalendarScheduling";

import { createRunAgentJobActivity } from "../src/activities/runAgentJob";
import type { MeetingBroker, MeetingJobInputs } from "../src/activities/runAgentJob";

import { createReadOnlyAgentJobActivity } from "../src/activities/readOnlyAgentJob";
import type {
  ReadOnlyAgentBroker,
  ReadOnlyAgentJobInputs,
  ReadOnlyAgentJobDeps,
} from "../src/activities/readOnlyAgentJob";

// ---------------------------------------------------------------------------
// 1. meetingValidate — ok-arm `fields` (validateCloseout.ts, the `validated` literal)
// ---------------------------------------------------------------------------

describe("payload pin 1/7: meetingValidate ok arm carries the validated extraction's fields intact", () => {
  it("fields is deep-equal to the extraction's own fields — non-empty, real values, not a shape `{}` would satisfy", () => {
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    const extraction: AgentExtraction = {
      fields: {
        owner: { value: "Priya Shah", evidenceRef: "transcript#L42" },
        dueDate: { value: "2026-09-01", evidenceRef: "transcript#L44" },
        title: { value: "Q3 Planning Sync", evidenceRef: "transcript#L1" },
      },
      schemaId: "sow:meeting-close-output",
    };
    const res = port.validate(extraction);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Deep-equal against the WHOLE fields object — an empty `{}` fails this immediately.
    expect(res.value.fields).toEqual(extraction.fields);
    expect(Object.keys(res.value.fields).length).toBeGreaterThan(0);
    // And the individual values that would matter downstream (the committed note).
    expect(res.value.fields.owner?.value).toBe("Priya Shah");
    expect(res.value.fields.owner?.evidenceRef).toBe("transcript#L42");
    expect(res.value.fields.title?.value).toBe("Q3 Planning Sync");
    expect(res.value.fields.dueDate?.value).toBe("2026-09-01");
    // The schemaId rides the same literal and is equally droppable.
    expect(res.value.schemaId).toBe("sow:meeting-close-output");
  });
});

// ---------------------------------------------------------------------------
// 2. meetingCorrelate — HIGH-confidence ok-arm `workspaceId` / `projectId`
//    (correlateMeeting.ts, the `high` outcome literal)
// ---------------------------------------------------------------------------
//
// This is the WS-2 bind: every downstream write targets THIS workspace. `projectId` rides the
// same literal on a conditional spread, so it is the field an over-narrowing edit drops first.

describe("payload pin 2/7: meetingCorrelate high-confidence ok arm carries the resolved workspace AND project", () => {
  it("workspaceId and projectId are the resolver's own values, not merely a `high` verdict", async () => {
    const BOUND_WS = workspaceId("ws-employer-payload-pin");
    const signals: CorrelationSignals = {
      confidence: 0.95,
      workspaceId: BOUND_WS,
      projectId: "proj-acme-payload-pin",
    };
    const port = createCorrelateActivity({
      resolveSignals: () => Promise.resolve(ok(signals)),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBe("high");
    if (res.value.confidence !== "high") return;
    expect(res.value.workspaceId).toBe(BOUND_WS);
    expect(res.value.projectId).toBe("proj-acme-payload-pin");
    // Deep-equal the whole outcome so a silently-added or silently-dropped member reds too.
    expect(res.value).toEqual({
      confidence: "high",
      workspaceId: BOUND_WS,
      projectId: "proj-acme-payload-pin",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. meetingCorrelate — LOW-confidence ok-arm `reason` (correlateMeeting.ts, the `low` literal)
// ---------------------------------------------------------------------------

describe("payload pin 3/7: meetingCorrelate low-confidence ok arm carries `reason` through", () => {
  it("reason is the exact resolved-signal text, verbatim — not merely present", async () => {
    const REASON_TEXT = "sub-threshold confidence 0.42 on the acme-standup signal set";
    const signals: CorrelationSignals = { confidence: 0.42, reason: REASON_TEXT };
    const port = createCorrelateActivity({
      resolveSignals: () => Promise.resolve(ok(signals)),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBe("low");
    if (res.value.confidence !== "low") return;
    expect(res.value.reason).toBe(REASON_TEXT);
    expect(res.value.routingReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. proposeExternalActions — ok-arm `envelope.writeReceipt` content
// ---------------------------------------------------------------------------
//
// The pre-existing suite (meeting-activities.test.ts) asserts only
// `expect(res.value.envelope.writeReceipt).toBeDefined()` — an empty `{}` in place of
// the real receipt would still pass that. This pins the RECEIPT CONTENT, which is the
// evidence safety rule 3 rests on (a replay reuses THIS receipt to avoid a duplicate write).

describe("payload pin 4/7: proposeExternalActions ok arm carries the dispatch's real writeReceipt content", () => {
  it("envelope.writeReceipt deep-equals the dispatch's own receipt object — not merely 'defined'", async () => {
    const receipt: WriteReceipt = {
      externalObjectId: "ext-real-object-77",
      recordedAt: "2026-08-27T12:00:00.000Z",
    };
    const dispatch: DispatchExternalWriteFn = () =>
      Promise.resolve({ status: "created", receipt } as ExternalWriteResult);
    const port = createProposeActivity({ dispatch, deps: {} as never });
    const action: ProposedAction = {
      actionId: actionId("action-payload-pin"),
      targetSystem: "todoist",
      canonicalObjectKey: "todoist:task:payload-pin",
      payload: {},
      approvalPolicy: "auto",
      idempotencyKey: "idem-payload-pin",
    };
    const env: ExternalWriteEnvelope = {
      actionId: actionId("action-payload-pin"),
      targetSystem: "todoist",
      canonicalObjectKey: "todoist:task:payload-pin",
      idempotencyKey: "idem-payload-pin",
      preconditions: ["not-exists"],
      payloadHash: "hash-payload-pin",
    };
    const res = await port.propose(action, env);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.status).toBe("created");
    expect(res.value.envelope.writeReceipt).toEqual(receipt);
    expect(res.value.envelope.writeReceipt?.externalObjectId).toBe("ext-real-object-77");
    expect(res.value.envelope.writeReceipt?.recordedAt).toBe("2026-08-27T12:00:00.000Z");
    // The rest of the envelope still carries the caller's own linkage keys through the spread.
    expect(res.value.envelope.canonicalObjectKey).toBe(env.canonicalObjectKey);
    expect(res.value.envelope.idempotencyKey).toBe(env.idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// 5. gatherAvailability — ok-arm `busyWindows` + `readSources` content
// ---------------------------------------------------------------------------
//
// The pre-existing suite (output-activities/calendar-boundary.test.ts) asserts
// `busyWindows).toHaveLength(1)` plus the ABSENCE of raw fields — never the admitted
// window's own sourceId/start/end/genericReason CONTENT. A `busyWindows.push({})` in
// place of `busyWindows.push(admitted.value)` would still satisfy every assertion there
// (length 1, no `rawTitle` key, no raw-body substring). `readSources` is pinned in the
// same test because it rides the same ok-arm literal and REQ-F-009's no-silent-free
// guarantee is stated in terms of it.

describe("payload pin 5/7: gatherAvailability ok arm carries the gate-admitted window's real content", () => {
  it("busyWindows carries the admitted window's sourceId/start/end/genericReason verbatim, and readSources names the source", async () => {
    const ORG_WS = workspaceId("ws-gather-payload-pin");
    const admittedWindow: BusyWindow = {
      sourceId: "cal-payload-pin",
      start: "2026-08-27T09:00:00.000Z",
      end: "2026-08-27T09:30:00.000Z",
      genericReason: "busy",
    };
    const query: AvailabilitySourceQuery = {
      query: () =>
        Promise.resolve(
          ok([
            {
              sourceId: "cal-payload-pin",
              workspaceId: ORG_WS,
              start: admittedWindow.start,
              end: admittedWindow.end,
              genericReason: "busy",
            },
          ]),
        ),
    };
    const gate: AvailabilityGate = {
      admit: () => Promise.resolve(ok(admittedWindow)),
    };
    const port = createGatherAvailabilityActivity({ query, gate });
    const res = await port.gather({
      sources: [{ sourceId: "cal-payload-pin", workspaceId: ORG_WS }],
      organizerWorkspaceId: ORG_WS,
    });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.busyWindows).toEqual([admittedWindow]);
    expect(res.value.busyWindows[0]?.start).toBe("2026-08-27T09:00:00.000Z");
    expect(res.value.busyWindows[0]?.end).toBe("2026-08-27T09:30:00.000Z");
    expect(res.value.busyWindows[0]?.genericReason).toBe("busy");
    // REQ-F-009 (no-silent-free): the caller re-asserts `readSources` covers the bound set,
    // so an emptied `readSources` turns a fail-closed guarantee into a silent pass.
    expect(res.value.readSources).toEqual(["cal-payload-pin"]);
  });
});

// ---------------------------------------------------------------------------
// 6. runAgentJob — ok-arm `mapCandidate` pass-through (the meeting-closeout candidate)
// 7. readOnlyAgentJob — ok-arm `mapCandidate` pass-through (all four output-workflow families)
// ---------------------------------------------------------------------------
//
// Both activities return `ok(deps.mapCandidate(outcome))` — a straight identity pass-through
// with no field-by-field reconstruction, so `toBe` reference identity is the sharpest available
// assertion and it reds on ANY substitution (an empty literal, a narrowed copy, a redacted
// clone). Content is asserted too, so a future refactor to a reconstructing shape still reds
// on an emptied field rather than only on the identity change.
//
// These two are pinned HERE, not left to the redaction suites, because that is precisely the
// fragility task C4 exists to remove: `readOnlyAgentJob`'s candidate payload had exactly ONE
// pin repo-wide and it lived in `read-only-agent-job-broker-rejection-redaction.test.ts` — an
// untracked file a hardening round created and a hardening round could delete.

function acceptedBrokerOutcome(): BrokerAccepted {
  return {
    jobState: "accepted",
    route: {
      provider: "claude",
      model: "claude-x",
      endpoint: "local",
      egressClass: "local_zero_egress",
    } as unknown as BrokerAccepted["route"],
    candidate: { kind: "knowledge_mutation_plan", plan: {} as never },
    usage: {} as unknown as BrokerAccepted["usage"],
    audits: [],
    replayed: false,
  };
}

function meetingBrokerReturning(outcome: BrokerOutcome): MeetingBroker {
  return { runJob: () => Promise.resolve(outcome) };
}

function meetingInputs(): MeetingJobInputs {
  return {
    workflowRunId: workflowId("wf-payload-pin-6"),
    workspaceId: workspaceId("ws-employer-payload-pin"),
    capability: "meeting.close",
    outputSchemaId: "sow:meeting-close-output",
    maxRuntimeSeconds: 120,
    idempotencyKey: "idem-payload-pin-6",
  };
}

describe("payload pin 6/7: runAgentJob ok arm passes the mapped candidate extraction through untouched", () => {
  it("the returned value IS the mapper's own object (reference-identical) and its field content survives", async () => {
    const extraction: AgentExtraction = {
      fields: {
        owner: { value: "Dana Wu", evidenceRef: "transcript#L7" },
        dueDate: { value: "2026-10-15", evidenceRef: "transcript#L9" },
      },
      schemaId: "sow:meeting-close-output",
    };
    const port = createRunAgentJobActivity({
      broker: meetingBrokerReturning(ok(acceptedBrokerOutcome())),
      inputs: meetingInputs(),
      buildEgress: () => ({}) as never,
      buildMatrix: () => ({}) as never,
      buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
      mapCandidate: () => extraction,
    });
    const res = await port.run(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Identity: no copy, no narrowing, no redacted clone between mapper and caller.
    expect(res.value).toBe(extraction);
    // Content, so a future reconstructing refactor still reds on an emptied field.
    expect(res.value.fields).toEqual(extraction.fields);
    expect(res.value.fields.owner?.value).toBe("Dana Wu");
    expect(res.value.fields.owner?.evidenceRef).toBe("transcript#L7");
    expect(res.value.fields.dueDate?.value).toBe("2026-10-15");
    expect(res.value.schemaId).toBe("sow:meeting-close-output");
  });
});

interface PinnedOutput {
  readonly fields: Record<string, unknown>;
  readonly narrative: string;
}

function readOnlyInputs(): ReadOnlyAgentJobInputs {
  return {
    workflowRunId: workflowId("wf-payload-pin-7"),
    workspaceId: workspaceId("ws-personal-payload-pin"),
    capability: "daily_brief.synthesize",
    outputSchemaId: "sow:daily-brief-output",
    maxRuntimeSeconds: 60,
    idempotencyKey: "idem-payload-pin-7",
  };
}

function readOnlyDeps(
  broker: ReadOnlyAgentBroker,
  mapCandidate: () => PinnedOutput,
): ReadOnlyAgentJobDeps<Record<string, never>, PinnedOutput> {
  return {
    broker,
    inputs: readOnlyInputs(),
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "personal_life" as never, dataOwner: "user" as never }),
    mapCandidate,
  };
}

describe("payload pin 7/7: readOnlyAgentJob ok arm passes the mapped candidate output through untouched", () => {
  it("the returned value IS the mapper's own object (reference-identical) and its field content survives", async () => {
    const output: PinnedOutput = {
      fields: { headline: "3 approvals waiting", owner: "Erin" },
      narrative: "Two meetings and one overdue follow-up.",
    };
    const broker: ReadOnlyAgentBroker = {
      runJob: () => Promise.resolve(ok(acceptedBrokerOutcome())),
    };
    const port = createReadOnlyAgentJobActivity(readOnlyDeps(broker, () => output));
    const res = await port.run({});
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Identity: the generic core must not rebuild, narrow, or redact the family's output.
    expect(res.value).toBe(output);
    // Content, so a future reconstructing refactor still reds on an emptied field.
    expect(res.value.fields).toEqual({ headline: "3 approvals waiting", owner: "Erin" });
    expect(Object.keys(res.value.fields).length).toBeGreaterThan(0);
    expect(res.value.narrative).toBe("Two meetings and one overdue follow-up.");
  });
});
