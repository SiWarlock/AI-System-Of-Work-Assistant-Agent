// @sow/workflows — task 25.4 (PKG-W3) ACTIVITY: implement {@link
// GatherAvailabilityPort} — read busy/free across every bound availability
// source through the GCL Visibility Gate (REQ-F-009 / Flow-3 / safety rule 4).
//
// This is an ACTIVITY, NOT workflow code. It mirrors buildGclProjection.ts's
// source+gate shape deliberately (parallel structure aids review): an injected
// PURE {@link AvailabilitySourceQuery} proposes a CANDIDATE busy/free reading per
// source (which MAY still carry raw event detail — the source is not trusted to
// have sanitized correctly), and an injected {@link AvailabilityGate} is the
// enforcement point that admits ONLY a sanitized {@link BusyWindow} (generic
// reason, no raw title/attendee/body) — mirroring the cross-workspace
// owner-approved-link check the driver-level comment on
// ports/crossCalendarScheduling.ts names ("every cross-workspace calendar read
// goes through the GCL Visibility Gate over owner-approved links").
//
// TWO safety invariants this activity makes true:
//   REQ-F-009 (no-silent-free): a source that cannot be read, OR whose candidate
//     is refused by the gate, HARD-FAILS THE WHOLE gather (never a partial
//     result silently dropping one source) — the caller (the crossCalendarScheduling
//     driver) additionally re-asserts `readSources` covers the full bound set;
//     this activity never returns a `readSources` entry for a source it did not
//     successfully admit.
//   Flow-3 leakage: an admitted window carries ONLY `{sourceId, start, end,
//     genericReason?}` — never raw event detail — and `genericReason` is run
//     through `isGenericExplanation` (the SAME short/single-line check
//     activities/proposeWindows.ts already uses) as a second, independent
//     backstop over whatever the gate returns.
//
// §16: never throws. A read failure or a gate rejection is a typed
// {@link GatherAvailabilityError}.
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import type {
  AvailabilitySource,
  BusyWindow,
  GatheredAvailability,
  GatherAvailabilityPort,
  GatherAvailabilityError,
  CrossCalendarSchedulingContext,
} from "../ports/crossCalendarScheduling";
import { isGenericExplanation } from "./proposeWindows";

/**
 * A CANDIDATE busy/free window ONE source proposes — it MAY still carry raw
 * event detail (`rawTitle`/`rawAttendees`); the source is not trusted to have
 * sanitized correctly, so the gate below is the real enforcement point
 * (defense in depth, mirrors buildGclProjection.ts's CandidateProjection).
 */
export interface CandidateBusyWindow {
  readonly sourceId: string;
  readonly workspaceId: WorkspaceId;
  readonly start: string;
  readonly end: string;
  readonly rawTitle?: string;
  readonly rawAttendees?: readonly string[];
  readonly genericReason?: string;
}

/**
 * The injected PURE-from-this-activity's-perspective query for ONE availability
 * source's candidate busy/free windows. MUST return a typed error rather than a
 * guessed/empty reading when it cannot freshly read a source (fail-closed) — the
 * activity folds that to `calendar_unreachable` and hard-fails the WHOLE gather
 * (REQ-F-009: a source is NEVER silently treated as free).
 */
export interface AvailabilitySourceQuery {
  query(
    source: AvailabilitySource,
    ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<readonly CandidateBusyWindow[], GatherAvailabilityError>>;
}

/**
 * The injected cross-workspace availability gate — the GCL Visibility Gate over
 * owner-approved links (Flow 3). Admits a candidate window ONLY when the read is
 * authorized (same-workspace, or an approved link from `organizerWorkspaceId` to
 * the candidate's `workspaceId`) — a candidate from an unauthorized workspace, or
 * one carrying raw event detail, is a typed {@link GateRejection}, never
 * downgraded-and-admitted.
 */
export interface AvailabilityGate {
  admit(
    candidate: CandidateBusyWindow,
    organizerWorkspaceId: WorkspaceId,
  ): Promise<Result<BusyWindow, AvailabilityGateRejection>>;
}

/**
 * A gate rejection — unauthorized cross-workspace read, or raw content present.
 * Named distinctly from buildGclProjection.ts's `GateRejection` (the package
 * barrel is a flat `export *` — a same-named export from two activity files
 * would collide).
 */
export interface AvailabilityGateRejection {
  readonly reason: string;
}

/** Injected deps for the gather-availability activity. */
export interface GatherAvailabilityActivityDeps {
  readonly query: AvailabilitySourceQuery;
  readonly gate: AvailabilityGate;
}

/**
 * Build a {@link GatherAvailabilityPort} that reads busy/free across EVERY bound
 * source through the query+gate pair. Any single unreadable source, or any single
 * gate-rejected candidate, fails the WHOLE gather closed (`calendar_unreachable` /
 * `gate_rejected`) — never a partial `readSources` set that silently treats an
 * unread/unauthorized source as free (REQ-F-009). On success `readSources`
 * covers exactly the bound `ctx.sources` set. Never throws.
 */
export function createGatherAvailabilityActivity(
  deps: GatherAvailabilityActivityDeps,
): GatherAvailabilityPort {
  return {
    async gather(
      ctx: CrossCalendarSchedulingContext,
    ): Promise<Result<GatheredAvailability, GatherAvailabilityError>> {
      const readSources: string[] = [];
      const busyWindows: BusyWindow[] = [];

      for (const source of ctx.sources) {
        const queried = await deps.query.query(source, ctx);
        if (!queried.ok) {
          // Fail-closed: a source that cannot be read is NEVER assumed free —
          // the whole gather fails, carrying the sources read so far (for the
          // health item), rather than a silently-partial result.
          return err({
            code: "calendar_unreachable",
            message: `availability source ${source.sourceId} unreachable: ${queried.error.message}`,
            readSources,
            cause: queried.error,
          });
        }

        for (const candidate of queried.value) {
          const admitted = await deps.gate.admit(candidate, ctx.organizerWorkspaceId);
          if (!admitted.ok) {
            return err({
              code: "gate_rejected",
              message: `availability source ${source.sourceId} rejected by the visibility gate: ${admitted.error.reason}`,
              readSources,
            });
          }
          // Independent second backstop (Flow 3): the admitted window's generic
          // reason must itself be short + single-line, whatever the gate did.
          if (!isGenericExplanation(admitted.value.genericReason)) {
            return err({
              code: "gate_rejected",
              message: `availability source ${source.sourceId} produced a raw-content-shaped reason — refused (Flow 3 leakage)`,
              readSources,
            });
          }
          busyWindows.push(admitted.value);
        }
        readSources.push(source.sourceId);
      }

      return ok({ readSources, busyWindows });
    },
  };
}
