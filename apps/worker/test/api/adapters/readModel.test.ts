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
import { isErr, isOk } from "@sow/contracts";
import type { Approval, WorkspaceId } from "@sow/contracts";
import { openDatabase, type OpenDatabase } from "../../../src/composition/backends";
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

function pendingApproval(id: string): Approval {
  return {
    id: id as Approval["id"],
    actionRef: `act-${id}` as Approval["actionRef"],
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
});

// ── inbox surfaces (pending approvals; fail-closed on unknown workspace) ──────

describe("createDbReadModelQueryPort — ingestion + approval inboxes", () => {
  it("lists PENDING approvals for a KNOWN workspace", async () => {
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
    for (const surface of [port.ingestionInbox, port.approvalInbox]) {
      const res = await surface(KNOWN_WS);
      expect(isOk(res)).toBe(true);
      if (isOk(res)) {
        expect(res.value.length).toBe(1);
        expect(res.value[0]!.id).toBe("apr-1");
        expect(res.value[0]!.status).toBe("pending");
      }
    }
  });

  it("the inbox is an EMPTY ok list for a KNOWN workspace with no pending approvals", async () => {
    const o = await freshDb();
    await seedRegistry(o, [KNOWN_WS]);
    const port = createDbReadModelQueryPort(o.repos);
    const res = await port.approvalInbox(KNOWN_WS);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual([]);
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

// Type-only guard: the branded WorkspaceId is not required at the port boundary
// (the port takes plain strings), but the seeded projection carries a branded id in
// its payload — this reference keeps the import meaningful and documents the seam.
const _brandedWs: WorkspaceId = KNOWN_WS as WorkspaceId;
void _brandedWs;
