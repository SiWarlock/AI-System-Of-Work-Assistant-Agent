// spec(safety rule 7 / task 25.1 registration precondition) — F5: these four
// activities (createBuildSyncOutputsActivity, createDashboardUpdateActivity,
// createRefreshConnectorsActivity, createGatherAvailabilityActivity) are now
// REAL registered Temporal activities (task 25.1 bound `createOutputWorkflowActivities`'s
// members, including these, into apps/worker/src/composition/buildActivities.ts's
// registered `outputWorkflowActivities`). Temporal workflow history is durable
// and replayed — a rule-7 log sink — so a raw upstream `cause`, or a `message`
// that interpolates caller/filesystem-derived detail, forwarded from any of
// these activities would leak into it BY CONSTRUCTION the moment the activity
// runs.
//
// Each suite below drives the activity through a HOSTILE injected dependency
// that fails carrying POISON — a secret marker, a foreign-workspace absolute
// path, or (the exact reachable shape the F5 brief names) a REAL Node fs error
// with a stack trace and an absolute path as OWN ENUMERABLE properties — and
// asserts the poison is ABSENT from `JSON.stringify` of the WHOLE activity
// result, while the stable, closed `code` still crosses byte-identically (every
// workflow driver switches on it).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ok, err, workspaceId } from "@sow/contracts";
import type { WorkspaceId, SourceId } from "@sow/contracts";
import { createBuildSyncOutputsActivity } from "../../src/activities/deterministicProgress";
import type { SyncOutputsProjection } from "../../src/activities/deterministicProgress";
import type { ValidatedNarrative, DeterministicProgress, NoteExistsReader } from "../../src/ports/projectSync";
import { createDashboardUpdateActivity } from "../../src/activities/dashboardUpdate";
import type { DashboardReadModelStore } from "../../src/activities/dashboardUpdate";
import { createRefreshConnectorsActivity } from "../../src/activities/refreshConnectors";
import type { ConnectorRefresher } from "../../src/activities/refreshConnectors";
import { createGatherAvailabilityActivity } from "../../src/activities/gatherAvailability";
import type { AvailabilitySourceQuery, AvailabilityGate } from "../../src/activities/gatherAvailability";
import type { CrossCalendarSchedulingContext, GatherAvailabilityError } from "../../src/ports/crossCalendarScheduling";

// ---------------------------------------------------------------------------
// Shared hostile fixtures
// ---------------------------------------------------------------------------

const SECRET_POISON = "POISON-SECRET-9f3a1c";
const PATH_POISON = "/Users/x/vault/other-workspace/SECRETMARKER.md";
const POISON_DIR_NAME = "sow-f5-poison-does-not-exist";

/**
 * A REAL Node fs ENOENT error — carries an absolute path + a stack trace, and
 * (unlike a bare `new Error(...)`, whose `message`/`stack` are NON-enumerable
 * and so never show up in `JSON.stringify`) exposes `.path`/`.code`/`.errno`/
 * `.syscall` as OWN ENUMERABLE properties. This is the exact reachable shape
 * the F5 brief names — "a thrown fs error object carrying an absolute vault
 * path and a stack trace" — and, unlike a plain `new Error(...)`, actually
 * makes a hostile-fixture test meaningful under `JSON.stringify`.
 */
function realFsPoison(): NodeJS.ErrnoException {
  const poisonPath = path.join(os.tmpdir(), POISON_DIR_NAME, "SECRETMARKER.md");
  try {
    fs.readFileSync(poisonPath);
    throw new Error("unreachable: poison path must not exist");
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
}

function expectNoPoison(serialized: string): void {
  expect(serialized).not.toContain(SECRET_POISON);
  expect(serialized).not.toContain(PATH_POISON);
  expect(serialized).not.toContain(POISON_DIR_NAME);
}

// ===========================================================================
// (A) deterministicProgress.ts — createBuildSyncOutputsActivity
// ===========================================================================

const validated: ValidatedNarrative = { validated: true, fields: {} };
const progress: DeterministicProgress = { completedCount: 1, totalCount: 2, percentComplete: 50, perProvider: [] };
const BUILD_WS = "personal-business" as WorkspaceId;
const identity = { projectId: "x", title: "X", slug: "personal-business/x", lifecycleState: "active" as const };
const AT = "2026-07-07T00:00:00.000Z";
const sourceRef = { sourceId: "src-1" as SourceId };

/** The projection must never be reached: the note-exists probe fails first in every case below. */
const unreachableProjection: SyncOutputsProjection = {
  project: (..._args: Parameters<SyncOutputsProjection["project"]>): ReturnType<SyncOutputsProjection["project"]> => {
    throw new Error("projection must not be reached — the note-exists probe fails closed first");
  },
};

function makeHostileNoteExists(cause: unknown): NoteExistsReader {
  return {
    exists: () => Promise.resolve(err({ code: "read_failed", message: "fake probe failure", cause })),
  };
}

describe("createBuildSyncOutputsActivity — SAFETY RULE 7: noteExists probe cause never crosses (F5)", () => {
  it("a poisoned plain-object cause never crosses — code still build_failed", async () => {
    const port = createBuildSyncOutputsActivity({
      projection: unreachableProjection,
      sourceRef,
      planIdentity: { project: "x" },
      noteExists: makeHostileNoteExists({ secret: SECRET_POISON }),
    });
    const r = await port.build(validated, progress, BUILD_WS, identity, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("build_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a poisoned foreign-workspace-path cause never crosses", async () => {
    const port = createBuildSyncOutputsActivity({
      projection: unreachableProjection,
      sourceRef,
      planIdentity: { project: "x" },
      noteExists: makeHostileNoteExists({ path: PATH_POISON }),
    });
    const r = await port.build(validated, progress, BUILD_WS, identity, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("build_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a REAL Node fs error cause (stack + absolute path) never crosses — the reachable production shape", async () => {
    const port = createBuildSyncOutputsActivity({
      projection: unreachableProjection,
      sourceRef,
      planIdentity: { project: "x" },
      noteExists: makeHostileNoteExists(realFsPoison()),
    });
    const r = await port.build(validated, progress, BUILD_WS, identity, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("build_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });
});

// ===========================================================================
// (B) dashboardUpdate.ts — createDashboardUpdateActivity
// ===========================================================================

describe("createDashboardUpdateActivity — SAFETY RULE 7: the store's thrown value never crosses (F5)", () => {
  it("a poisoned plain-object throw never crosses — code+message stay fixed", async () => {
    const store: DashboardReadModelStore = {
      put: () => {
        throw { secret: SECRET_POISON };
      },
    };
    const r = await createDashboardUpdateActivity({ store }).update({ some: "payload" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("dashboard_failed");
      expect(r.error.message).toBe("dashboard read-model update failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a poisoned foreign-workspace-path throw never crosses", async () => {
    const store: DashboardReadModelStore = {
      put: () => {
        throw { path: PATH_POISON };
      },
    };
    const r = await createDashboardUpdateActivity({ store }).update({ some: "payload" });
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });

  it("a REAL Node fs error throw (stack + absolute path) never crosses", async () => {
    const store: DashboardReadModelStore = {
      put: () => {
        throw realFsPoison();
      },
    };
    const r = await createDashboardUpdateActivity({ store }).update({ some: "payload" });
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });
});

// ===========================================================================
// (C) refreshConnectors.ts — createRefreshConnectorsActivity
// ===========================================================================

describe("createRefreshConnectorsActivity — SAFETY RULE 7: the refresher's cause+message never cross (F5)", () => {
  it("connector_unreachable: a poisoned message+cause never cross — the code still crosses unchanged", async () => {
    const refresher: ConnectorRefresher = {
      refresh: () =>
        Promise.resolve(
          err({
            code: "connector_unreachable",
            message: `raw provider detail: ${SECRET_POISON} at ${PATH_POISON}`,
            cause: { secret: SECRET_POISON },
          }),
        ),
    };
    const r = await createRefreshConnectorsActivity({ connectorIds: ["conn-1"], refresher }).refresh(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("connector_unreachable");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("connector_stale: a poisoned message+cause never cross — the code still crosses unchanged", async () => {
    const refresher: ConnectorRefresher = {
      refresh: () =>
        Promise.resolve(
          err({
            code: "connector_stale",
            message: `raw provider detail: ${SECRET_POISON} at ${PATH_POISON}`,
            cause: { path: PATH_POISON },
          }),
        ),
    };
    const r = await createRefreshConnectorsActivity({ connectorIds: ["conn-1"], refresher }).refresh(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("connector_stale");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a REAL Node fs error cause from the refresher never crosses", async () => {
    const refresher: ConnectorRefresher = {
      refresh: () => Promise.resolve(err({ code: "connector_unreachable", message: "raw", cause: realFsPoison() })),
    };
    const r = await createRefreshConnectorsActivity({ connectorIds: ["conn-1"], refresher }).refresh(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });
});

// ===========================================================================
// (D) gatherAvailability.ts — createGatherAvailabilityActivity
// ===========================================================================

const GATHER_WS = workspaceId("ws-f5-gather");

function makeGatherCtx(): CrossCalendarSchedulingContext {
  return { sources: [{ sourceId: "cal-1", workspaceId: GATHER_WS }], organizerWorkspaceId: GATHER_WS };
}

// R3 (24.73 restore round, 2026-08-27): the two suites below were REWRITTEN.
// This file's own header framed BOTH the query-failure and gate-rejection
// branches as "poison must never cross" — but this file's header comment on
// gatherAvailability.ts itself names two very different, actionably-distinct
// gate-rejection causes (an unauthorized cross-workspace read vs raw content
// present), and the query is THIS PACKAGE's own typed `AvailabilitySourceQuery`
// port, not a raw provider/driver. Collapsing both to one fixed generic string
// cost the operator the ability to tell which failure occurred and what to do
// about it, for a diagnostic that (per the owner directive) is an acceptable
// cost to restore. `message`/`reason` now cross verbatim; `cause` is a
// DIFFERENT field — it is never read by this activity at all (defense in
// depth: even a real fs error attached as `cause` cannot cross, because
// nothing here ever forwards it).
describe("createGatherAvailabilityActivity — SAFETY RULE 7 / Flow 3 (R3 restore): message/reason RESTORED, cause stays dropped (never read)", () => {
  it("a query failure's own message crosses verbatim (RESTORED diagnostic) — `cause` never crosses (never read)", async () => {
    const poisonedError: GatherAvailabilityError = {
      code: "calendar_unreachable",
      message: "calendar down: auth token expired, re-authenticate the connector",
      cause: realFsPoison(),
    };
    const query: AvailabilitySourceQuery = { query: () => Promise.resolve(err(poisonedError)) };
    const gate: AvailabilityGate = {
      admit: () => Promise.resolve(ok({ sourceId: "cal-1", start: "2026-08-24T09:00:00.000Z", end: "2026-08-24T10:00:00.000Z" })),
    };
    const r = await createGatherAvailabilityActivity({ query, gate }).gather(makeGatherCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("calendar_unreachable");
      // RESTORED: the query's own diagnostic message crosses (mutation-proof — a
      // re-added redaction would replace this with a fixed literal).
      expect(r.error.message).toBe(
        "availability source cal-1 unreachable: calendar down: auth token expired, re-authenticate the connector",
      );
      // KEPT: `cause` is a different field this activity never reads — the fs
      // poison (stack + absolute path) it carries never crosses.
      expect(r.error.cause).toBeUndefined();
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a gate rejection's own reason crosses verbatim (RESTORED — two actionably-different failures must not collapse to one string)", async () => {
    const query: AvailabilitySourceQuery = {
      query: (source) =>
        Promise.resolve(
          ok([
            {
              sourceId: source.sourceId,
              workspaceId: GATHER_WS,
              start: "2026-08-24T09:00:00.000Z",
              end: "2026-08-24T10:00:00.000Z",
            },
          ]),
        ),
    };
    const gate: AvailabilityGate = {
      admit: () => Promise.resolve(err({ reason: "unauthorized cross-workspace read: no approved link" })),
    };
    const r = await createGatherAvailabilityActivity({ query, gate }).gather(makeGatherCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("gate_rejected");
      // RESTORED: the gate's own reason crosses (mutation-proof pin) — an operator
      // can now tell "get an approved link" apart from "raw content present, fix
      // the source" instead of one collapsed generic sentence.
      expect(r.error.message).toBe(
        "availability source cal-1 rejected by the visibility gate: unauthorized cross-workspace read: no approved link",
      );
    }
  });
});
