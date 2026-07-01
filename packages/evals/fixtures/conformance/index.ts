// spec(§7) — conformance test fixtures (task 5.10). A CONFORMANT and a
// NON-CONFORMANT candidate output per capability, plus a fixture-scoped schema
// gate over the capability's output schema. Pure DATA + a gate factory — no real
// provider/runtime, no network. The non-conformant `meeting.close` output drops
// the required `actionItems[].owner` (an out-of-schema `assignee` instead), so the
// candidate-data gate rejects it — the exact shape a non-conformant provider emits.
import { buildSchemaRegistry } from "@sow/contracts/schema/registry";
import { makeSchemaGate, type ConformanceGate } from "../../src/conformance/conformance-core";
import meetingCloseSchema from "./snapshots/meeting-close.schema.json";
import meetingCloseConformant from "./snapshots/meeting-close.conformant.json";
import meetingCloseNonConformant from "./snapshots/meeting-close.nonconformant.json";

/** The fixture capability output schema id (the gate target for the meeting.close cases). */
export const MEETING_CLOSE_OUTPUT_SCHEMA_ID = "sow:fixture:meeting.close.output" as const;

export const meetingCloseOutputSchema: Record<string, unknown> = meetingCloseSchema as Record<
  string,
  unknown
>;
export const conformantMeetingCloseOutput: unknown = meetingCloseConformant;
export const nonConformantMeetingCloseOutput: unknown = meetingCloseNonConformant;

/**
 * A ConformanceGate scoped to the fixture capability schemas — lets the harness
 * unit tests gate candidate outputs WITHOUT depending on the process-wide contracts
 * registry (which does not carry provider-output capability schemas yet).
 */
export const fixtureConformanceGate: ConformanceGate = makeSchemaGate(
  buildSchemaRegistry([meetingCloseOutputSchema]),
);
