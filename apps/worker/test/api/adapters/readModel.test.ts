// Task 8.3 (integrator step) — the @sow/db read-model query-port adapter, over a
// REAL genesis-migrated in-memory sqlite. The load-bearing behaviors:
//   • an ABSENT read-model is an EMPTY ok list (never an error) — dashboard, cards,
//     copilot, and the global surface each return ok([]) when no row exists yet;
//   • a SEEDED read-model projects `data` into the DashboardCardSource superset (the
//     UI-safe redaction still lives in queries.ts — the adapter hands back the source);
//   • a workspace-scoped read for an UNKNOWN / out-of-scope workspace fails closed
//     with a typed err (WORKSPACE_NOT_FOUND) — NEVER a partial raw leak;
//   • the ingestion + approval inboxes list PENDING approvals for a KNOWN workspace,
//     and fail closed (typed err, no approvals) for an unknown one;
//   • a malformed read-model payload is treated as EMPTY (never a crash / raw leak).
import { describe, it, expect, afterEach } from "vitest";
import { isErr, isOk, ok } from "@sow/contracts";
import type { Approval, WorkspaceId } from "@sow/contracts";
import type { AuditRepository } from "@sow/db";
import { openDatabase, type OpenDatabase } from "../../../src/composition/backends";
import { RECENT_CHANGES_AUDIT_SCAN_BOUND } from "../../../src/api/projections/recentChanges";
import {
  createDbReadModelQueryPort,
  READ_MODEL_KEYS,
} from "../../../src/api/adapters/readModel";

// --- real migrated in-memory sqlite (genesis-migrated repos) ----------------
const opened: OpenDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.conn.close();
});
async function freshDb(): Promise<OpenDatabase> {
  const o = await openDatabase({ dbPath: ":memory:" });
  opened.push(o);
  return o;
}

const KNOWN_WS = "ws-known";
const UNKNOWN_WS = "ws-unknown";
const REBUILT_AT = "2026-07-02T00:00:00.000Z";

/** Seed the workspace registry so `KNOWN_WS` is an in-scope workspace. */
async function seedRegistry(o: OpenDatabase, workspaceIds: string[]): Promise<void> {
  const r = await o.repos.readModels.put({
    readModelKey: READ_MODEL_KEYS.registry,
    workspaceId: undefined,
    data: { workspaceIds },
    rebuiltAt: REBUILT_AT,
  });
  if (isErr(r)) throw new Error(`seed registry failed: ${JSON.stringify(r.error)}`);
}

/** Seed a read-model row with a raw `data` JSON payload. */
async function seedReadModel(
  o: OpenDatabase,
  readModelKey: string,
  workspaceId: string | undefined,
  data: unknown,
): Promise<void> {
  const r = await o.repos.readModels.put({
    readModelKey,
    workspaceId,
    data,
    rebuiltAt: REBUILT_AT,
  });
  if (isErr(r)) throw new Error(`seed read-model failed: ${JSON.stringify(r.error)}`);
}

function pendingApproval(id: string, workspaceId: string = KNOWN_WS): Approval {
  return {
    id: id as Approval["id"],
    actionRef: `act-${id}` as Approval["actionRef"],
    subjectKind: "external_action", // §13.10a — external-write card (actionRef only)
    workspaceId: workspaceId as Approval["workspaceId"],
    status: "pending",
    actor: "user:cody",
    channel: "mac",
    payloadHash: "sha256:pending",
  };
}

// ── dashboard / global surfaces (global read-models — no workspace gate) ──────

describe("createDbReadModelQueryPort — global card + GCL surfaces", () => {
  it("an ABSENT dashboard read-model returns an EMPTY ok list (not an error)", async () => {
    const o = await freshDb();
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.dashboardCards();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("a SEEDED dashboard read-model projects `data.cards` into DashboardCardSource[]", async () => {
    const o = await freshDb();
    await seedReadModel(o, READ_MODEL_KEYS.dashboard, undefined, {
      cards: [
        {
          cardId: "card_today",
          kind: "global_today",
          title: "Today",
          status: "ok",
          count: 3,
          updatedAt: REBUILT_AT,
          // adversarial extra key on the stored row — must NOT ride out.
          secretField: "should never cross",
        },
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.dashboardCards();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      const card = res.value[0]!;
      expect(card.cardId).toBe("card_today");
      expect(card.count).toBe(3);
      // The structural guard copies only the named fields — no smuggled key.
      expect((card as unknown as Record<string, unknown>).secretField).toBeUndefined();
    }
  });

  it("24.91 — a `dashboard_cards` row carrying cross-workspace-attributable content (workspaceId + a marker sourced from workspace A) never rides out to ANY caller — the FULL key set is proven, not one sampled field [safety rule 4]", async () => {
    const o = await freshDb();
    const MARKER = "ws-a-only-secret-marker-9f3c";
    await seedReadModel(o, READ_MODEL_KEYS.dashboard, undefined, {
      cards: [
        {
          cardId: "card_today",
          kind: "global_today",
          title: "Today",
          status: "ok",
          count: 1,
          updatedAt: REBUILT_AT,
          // Adversarial: a stored row carrying workspace attribution + a workspace-A-sourced marker
          // — exactly the shape a future producer bug or a tampered row could carry.
          workspaceId: "ws-a",
          sourceWorkspaceId: "ws-a",
          marker: MARKER,
        },
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    // "query as workspace B": `dashboardCards()` takes NO caller-scoped input at all — every caller,
    // including a hypothetical workspace-B reader, gets the IDENTICAL output (see the header
    // comment on `dashboardCards` in readModel.ts — there is no per-caller parameter to scope on).
    const res = await port.dashboardCards();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      const card = res.value[0]!;
      // STRUCTURAL, not sampled: the FULL key set is exactly the six-field DashboardCardSource
      // allowlist — `workspaceId` (or any other adversarial key) cannot appear, by construction.
      expect(Object.keys(card).sort()).toEqual(["cardId", "count", "kind", "status", "title", "updatedAt"]);
      expect((card as unknown as Record<string, unknown>)["workspaceId"]).toBeUndefined();
      expect((card as unknown as Record<string, unknown>)["sourceWorkspaceId"]).toBeUndefined();
      // The marker itself never rides out in ANY form — not merely absent under an expected key name.
      const serialized = JSON.stringify(res.value);
      expect(serialized).not.toContain(MARKER);
      expect(serialized).not.toContain("ws-a");
    }
  });

  it("an ABSENT global surface read-model returns an EMPTY ok list", async () => {
    const o = await freshDb();
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.globalSurface();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("a SEEDED global surface projects `data.projections` into GclProjection[]", async () => {
    const o = await freshDb();
    await seedReadModel(o, READ_MODEL_KEYS.global, undefined, {
      projections: [
        {
          workspaceId: KNOWN_WS,
          visibilityLevel: "sanitized",
          projectionType: "calendar_busy",
          sanitizedPayload: { busySlots: "3" },
          sourceRefs: [{ sourceId: "src-1" }],
        },
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.globalSurface();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]!.visibilityLevel).toBe("sanitized");
      expect(res.value[0]!.projectionType).toBe("calendar_busy");
    }
  });

  it("a MALFORMED dashboard payload is treated as EMPTY (never a crash / raw leak)", async () => {
    const o = await freshDb();
    // `cards` is not an array, and one entry is missing required fields.
    await seedReadModel(o, READ_MODEL_KEYS.dashboard, undefined, { cards: "not-an-array" });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.dashboardCards();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("an ABSENT calendar schedule read-model returns an EMPTY ok list (§9.9 empty-until-producer)", async () => {
    const o = await freshDb();
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.calendar();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("a SEEDED schedule projects `data.entries` field-copy → UiSafeScheduleEntry[]; a malformed row + a stray raw key are DROPPED (WS-8)", async () => {
    const o = await freshDb();
    await seedReadModel(o, READ_MODEL_KEYS.schedule, undefined, {
      entries: [
        { start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", busy: true, conflictExplanation: "busy", sourceId: "employer-cal" },
        { start: "2026-07-25T11:00:00.000Z", busy: true }, // missing `end` → DROPPED
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.calendar();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      // Field-copy: ONLY start/end/busy/conflictExplanation cross — `sourceId` (attribution) is dropped.
      expect(res.value[0]).toEqual({ start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", busy: true, conflictExplanation: "busy" });
      expect((res.value[0] as unknown as Record<string, unknown>)["sourceId"]).toBeUndefined();
    }
  });
});

// ── workspace-scoped surfaces (fail-closed on unknown workspace) ──────────────

describe("createDbReadModelQueryPort — workspace-scoped card + copilot surfaces", () => {
  it("a KNOWN workspace with NO read-model returns an EMPTY ok list", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.workspaceCards(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("a KNOWN workspace with a SEEDED workspace read-model projects its cards", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    await seedReadModel(o, READ_MODEL_KEYS.workspace, KNOWN_WS, {
      cards: [
        {
          cardId: "card_ws",
          kind: "workspace",
          title: "Personal",
          status: "ok",
          count: 1,
          updatedAt: REBUILT_AT,
        },
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.workspaceCards(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]!.cardId).toBe("card_ws");
    }
  });

  it("an UNKNOWN workspace fails closed with a typed err (WORKSPACE_NOT_FOUND) — no raw leak", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    // Even seed a workspace read-model FOR the unknown ws — it must NOT surface.
    await seedReadModel(o, READ_MODEL_KEYS.workspace, UNKNOWN_WS, {
      cards: [
        { cardId: "leak", kind: "workspace", title: "SECRET", status: "ok", count: 9, updatedAt: REBUILT_AT },
      ],
    });
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.workspaceCards(UNKNOWN_WS);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("validation_rejected");
      expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("project surface fails closed for an UNKNOWN workspace", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.projectCards(UNKNOWN_WS, "proj-1");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("an ABSENT registry fails closed for EVERY workspace (no known workspace yet)", async () => {
    const o = await freshDb();
    // No registry seeded — nothing is known; a workspace-scoped read fails closed.
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.workspaceCards(KNOWN_WS);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("copilot surface: KNOWN ws with a seeded read-model projects run refs; absent → empty", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    // absent first
    let port = createDbReadModelQueryPort(o.repos);
    let res = await port.copilotSurface(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);

    await seedReadModel(o, READ_MODEL_KEYS.copilot, KNOWN_WS, {
      runs: [
        {
          workflowId: "wf-1",
          trigger: "manual",
          state: "running",
          idempotencyKey: "idem-1",
          auditRefs: ["aud-1"],
        },
      ],
    });
    port = createDbReadModelQueryPort(o.repos);
    res = await port.copilotSurface(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]!.workflowId).toBe("wf-1");
      expect(res.value[0]!.idempotencyKey).toBe("idem-1");
    }
  });

  it("recentChanges: KNOWN ws reads seeded rows (malformed dropped); absent → empty; UNKNOWN → fail-closed", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    let port = createDbReadModelQueryPort(o.repos);
    // absent → empty ok
    let res = await port.recentChanges(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);

    await seedReadModel(o, READ_MODEL_KEYS.recentChanges, KNOWN_WS, {
      changes: [
        { changeId: "chg-1", kind: "commit", summary: "committed a.md rev 0c4", occurredAt: "2026-07-03T00:00:00.000Z" },
        // A structurally malformed row (missing occurredAt) is dropped by the transport guard.
        { changeId: "chg-bad", kind: "commit", summary: "no timestamp" },
      ],
    });
    port = createDbReadModelQueryPort(o.repos);
    res = await port.recentChanges(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1); // malformed row dropped
      expect(res.value[0]!.changeId).toBe("chg-1");
    }

    const unknown = await port.recentChanges(UNKNOWN_WS);
    // 24.101 — cause code, not bare falsity: discriminates the WS-8 unknown-workspace path
    // (unknownWorkspace()) from a genuine store fault (storeFault()) — this file's own two typed
    // failure codes.
    expect(isErr(unknown)).toBe(true); // fail-closed (WS-8)
    if (isErr(unknown)) expect(unknown.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("projectDashboards: KNOWN ws reads seeded projects; absent → empty; UNKNOWN → fail-closed", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    let port = createDbReadModelQueryPort(o.repos);
    let res = await port.projectDashboards(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]); // absent → empty

    await seedReadModel(o, READ_MODEL_KEYS.projectDashboards, KNOWN_WS, {
      projects: [
        {
          projectId: "prj-1",
          title: "Auth redesign",
          status: "on-track",
          progress: { completedCount: 2, totalCount: 5, percentComplete: 40 },
          blockers: [],
          waitingItems: [],
          nextActions: [],
          evidenceRefs: [],
          updatedAt: "2026-07-04T00:00:00.000Z",
        },
        "not-an-object", // a non-object row is dropped by the transport guard
      ],
    });
    port = createDbReadModelQueryPort(o.repos);
    res = await port.projectDashboards(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1); // malformed row dropped
      expect(res.value[0]!.projectId).toBe("prj-1");
    }

    const unknown = await port.projectDashboards(UNKNOWN_WS);
    // 24.101 — cause code, not bare falsity (see recentChanges' identical pin above for rationale).
    expect(isErr(unknown)).toBe(true); // fail-closed (WS-8)
    if (isErr(unknown)) expect(unknown.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

// ── inbox surfaces (pending approvals; fail-closed on unknown workspace) ──────

describe("createDbReadModelQueryPort — ingestion + approval inboxes", () => {
  it("approvalInbox lists PENDING approvals for a KNOWN workspace", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    // Seed one pending + one non-pending approval; only pending surfaces.
    const cr1 = await o.repos.approvals.create(pendingApproval("apr-1"));
    if (isErr(cr1)) throw new Error("seed approval failed");
    const cr2 = await o.repos.approvals.create({
      ...pendingApproval("apr-2"),
      status: "approved",
    });
    if (isErr(cr2)) throw new Error("seed approval2 failed");

    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.approvalInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]!.id).toBe("apr-1");
      expect(res.value[0]!.status).toBe("pending");
    }
  });

  it("ingestionInbox reads the DEDICATED ingestion read-model (NOT approvals): absent → empty; malformed dropped; UNKNOWN → fail-closed", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    // A pending approval EXISTS — it must NOT surface on the ingestion path (the alias is removed).
    if (isErr(await o.repos.approvals.create(pendingApproval("apr-1")))) throw new Error("seed approval failed");

    let port = createDbReadModelQueryPort(o.repos);
    // Absent ingestion read-model row → empty ok (NOT the pending approval).
    let res = await port.ingestionInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);

    await seedReadModel(o, READ_MODEL_KEYS.ingestion, KNOWN_WS, {
      items: [
        { sourceId: "src-1", type: "youtube_video", sensitivity: "personal", summary: "youtube_video" },
        // A structurally malformed row (missing summary) is dropped by the transport guard.
        { sourceId: "src-bad", type: "podcast", sensitivity: "personal" },
      ],
    });
    port = createDbReadModelQueryPort(o.repos);
    res = await port.ingestionInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1); // malformed row dropped; the pending approval did NOT surface
      expect(res.value[0]!.sourceId).toBe("src-1");
    }

    const unknown = await port.ingestionInbox(UNKNOWN_WS);
    // 24.101 — cause code, not bare falsity (see recentChanges' identical pin above for rationale).
    expect(isErr(unknown)).toBe(true); // fail-closed (WS-8)
    if (isErr(unknown)) expect(unknown.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("taskRollup reads the workspace-scoped task_rollup read-model: absent → empty; field-copy drops a smuggled workspaceId + a malformed row; UNKNOWN → fail-closed (WS-8)", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    let port = createDbReadModelQueryPort(o.repos);
    // Absent row → empty ok (§13.16 empty-until-producer).
    let res = await port.taskRollup(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);

    await seedReadModel(o, READ_MODEL_KEYS.taskRollup, KNOWN_WS, {
      items: [
        { taskId: "t1", title: "Ship it", status: "todo", priority: "p0", dueDate: "2026-07-25T00:00:00.000Z", projectRef: "prj-1", workspaceId: "smuggled" },
        { taskId: "t-bad", status: "todo" }, // missing title → dropped by the transport guard
      ],
    });
    port = createDbReadModelQueryPort(o.repos);
    res = await port.taskRollup(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1); // malformed row dropped
      expect(res.value[0]!.taskId).toBe("t1");
      // Field-copy: a smuggled `workspaceId` on the stored row NEVER rides through (WS-8).
      expect((res.value[0]! as unknown as Record<string, unknown>)["workspaceId"]).toBeUndefined();
    }

    const unknownTr = await port.taskRollup(UNKNOWN_WS);
    // 24.101 — cause code, not bare falsity (see recentChanges' identical pin above for rationale).
    expect(isErr(unknownTr)).toBe(true); // fail-closed (WS-8)
    if (isErr(unknownTr)) expect(unknownTr.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("ingestionInbox is WORKSPACE-SCOPED: workspace A's rows NEVER surface for workspace B (WS-8 shared-global-key guard — safety rule 4)", async () => {
    const o = await freshDb();
    const A = KNOWN_WS;
    const B = "ws-B";
    await seedRegistry(o, [A, B]); // BOTH are known/in-scope (so B is not merely fail-closed-on-unknown)
    // Seed ONLY workspace A's ingestion read-model with a recognizable row.
    await seedReadModel(o, READ_MODEL_KEYS.ingestion, A, {
      items: [{ sourceId: "A-src-secret-1", type: "youtube_video", sensitivity: "personal", summary: "A only" }],
    });

    const port = createDbReadModelQueryPort(o.repos);
    // B has NO ingestion row of its own ⇒ empty; A's row must NOT bleed through a shared global key.
    const resB = await port.ingestionInbox(B);
    expect(isOk(resB)).toBe(true);
    if (isOk(resB)) {
      expect(resB.value).toEqual([]);
      expect(resB.value.some((r) => r.sourceId === "A-src-secret-1")).toBe(false);
    }
    // Non-vacuous positive anchor: A DOES read its own seeded row (the isolation isn't just "both empty").
    const resA = await port.ingestionInbox(A);
    expect(isOk(resA)).toBe(true);
    if (isOk(resA)) expect(resA.value.map((r) => r.sourceId)).toContain("A-src-secret-1");
  });

  it("the inbox is an EMPTY ok list for a KNOWN workspace with no pending approvals", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.approvalInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
  });

  it("WS-4 SCOPING (the fix): workspace A's inbox surfaces ONLY A's pending cards — never workspace B's", async () => {
    const A = "ws-alpha";
    const B = "ws-beta";
    const o = await freshDb();
    await seedRegistry(o, [A, B]);
    // one pending card in EACH workspace.
    if (isErr(await o.repos.approvals.create(pendingApproval("apr-A", A)))) throw new Error("seed A failed");
    if (isErr(await o.repos.approvals.create(pendingApproval("apr-B", B)))) throw new Error("seed B failed");
    const port = createDbReadModelQueryPort(o.repos);
    const inboxA = await port.approvalInbox(A);
    expect(isOk(inboxA)).toBe(true);
    if (!isOk(inboxA)) return;
    // A sees exactly its own card — B's card does NOT leak in (the pre-scoping global-inbox leak, closed).
    expect(inboxA.value.map((c) => c.id)).toEqual(["apr-A"]);
    const inboxB = await port.approvalInbox(B);
    expect(isOk(inboxB) && inboxB.value.map((c) => c.id)).toEqual(["apr-B"]);
  });

  it("WS-4 fail-closed: a legacy sentinel-workspace card surfaces in NO real workspace inbox", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    // simulate a legacy row backfilled to the sentinel (never a real workspace id).
    if (isErr(await o.repos.approvals.create(pendingApproval("apr-legacy", "__unassigned__"))))
      throw new Error("seed legacy failed");
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.approvalInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]); // the sentinel card leaks into no inbox
  });

  it("both inboxes fail closed (typed err, no approvals) for an UNKNOWN workspace", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const cr = await o.repos.approvals.create(pendingApproval("apr-secret"));
    if (isErr(cr)) throw new Error("seed approval failed");
    const port = createDbReadModelQueryPort(o.repos);
    const ing = await port.ingestionInbox(UNKNOWN_WS);
    const apr = await port.approvalInbox(UNKNOWN_WS);
    expect(isErr(ing)).toBe(true);
    expect(isErr(apr)).toBe(true);
    if (isErr(ing)) expect(ing.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

// ── auditEvents (9.41 leg B: real delegation to AuditRepository) ──────────────

describe("createDbReadModelQueryPort — auditEvents", () => {
  it("createDbReadModelQueryPort_auditEvents_delegates_to_the_injected_audit_repository", async () => {
    const calls: Array<{ filter: unknown; limit: number }> = [];
    const auditOk: AuditRepository = {
      append: async () => ok(undefined),
      query: async (filter, limit) => {
        calls.push({ filter, limit });
        return ok([]);
      },
    };
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort({ ...o.repos, audit: auditOk });
    const res = await port.auditEvents(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
    expect(calls).toEqual([{ filter: { workspaceId: KNOWN_WS }, limit: RECENT_CHANGES_AUDIT_SCAN_BOUND }]);
  });

  it("fails closed with WORKSPACE_NOT_FOUND for an unknown workspace — never reaches the repository (consistent with every sibling method in this file)", async () => {
    let calls = 0;
    const auditSpy: AuditRepository = {
      append: async () => ok(undefined),
      query: async () => {
        calls += 1;
        return ok([]);
      },
    };
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]); // registry exists, but UNKNOWN_WS is not in it
    const port = createDbReadModelQueryPort({ ...o.repos, audit: auditSpy });
    const res = await port.auditEvents(UNKNOWN_WS);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    expect(calls).toBe(0);
  });

  it("folds a THROWN AuditRepository.query call to a typed err — never-throws (§16)", async () => {
    const auditThrows: AuditRepository = {
      append: async () => ok(undefined),
      query: async () => {
        throw new Error("boom — raw driver detail must never cross");
      },
    };
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort({ ...o.repos, audit: auditThrows });
    const res = await port.auditEvents(KNOWN_WS);
    // 24.101 — cause code, not bare falsity: proves this SPECIFIC test exercises the caught-throw →
    // storeFault() branch, distinct from the WS-8 unknownWorkspace() branch pinned elsewhere in this
    // file (a bare `isErr` can't tell "the catch caught a thrown driver error" from "some other
    // failure entirely").
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("READ_MODEL_STORE_UNAVAILABLE");
  });
});

// Type-only guard: the branded WorkspaceId is not required at the port boundary
// (the port takes plain strings), but the seeded projection carries a branded id in
// its payload — this reference keeps the import meaningful and documents the seam.
const _brandedWs: WorkspaceId = KNOWN_WS as WorkspaceId;
void _brandedWs;
