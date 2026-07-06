// Task 8.5 — single authenticated push stream: handshake + four event classes.
// TDD RED-first spec.
//
// This module builds the §10 worker→renderer push stream on the Phase-0 API
// spike (docs/spikes/0.5-api-stream.md): a tRPC v11 subscription over WebSocket
// that yields `tracked(eventId, uiSafePayload)`, backed by a bounded server-side
// replay log so a resume from `input.lastEventId` is LOSSLESS. Auth runs via the
// SAME 8.1 `makeAuthInterceptor` BEFORE any event flows (token from the first-
// message connectionParams, never a URL; Origin/Host from the upgrade).
//
// SECURITY-CRITICAL invariants pinned here:
//   1. `seq` is monotonic per stream (Phase-0 spike cursor).
//   2. A resume from `lastEventId` replays EXACTLY the missed events — none
//      dropped, none duplicated (the lossless-resume contract).
//   3. A non-UI-safe payload can NEVER be emitted — every event payload's field
//      set is a subset of UI_SAFE_ALLOWLIST (WS-8 / §10 leakage gate).
//   4. The handshake rejects no-token / wrong-token / wrong-Origin / wrong-Host
//      BEFORE any event flows (UNAUTHORIZED / FORBIDDEN pre-subscription).
//   5. An approval.update replay is idempotent by eventId / the approval
//      transition identity — a replayed/resumed workflow produces NO duplicate
//      approval event (exactly-once consistent with the 8.4 transition).
//
// Deterministic unit tests — no real socket needed (per the brief). The tRPC
// subscription procedure yields from the publisher's in-memory replay log; we
// drive the publisher directly and assert the log + resume semantics.
import { describe, it, expect } from "vitest";
import {
  UI_SAFE_ALLOWLIST,
  isOk,
  isErr,
  streamEventSchema,
  type Approval,
  type HealthItem,
  type WorkflowRunRef,
  type StreamEvent,
  type UiSafeDashboardCard,
} from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import { makeAuthInterceptor } from "../../../src/api/auth/interceptor";
import type { WorkerOriginAllowlist } from "../../../src/api/auth/originAllowlist";
import {
  createStreamPublisher,
  type StreamPublisher,
} from "../../../src/api/stream/eventClasses";
import { runStreamHandshake } from "../../../src/api/stream/handshake";
import {
  createPushStream,
  isResyncControl,
  type DashboardCardSourceInput,
  type TrackedItem,
} from "../../../src/api/stream/pushStream";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
const WRONG: SessionToken = mintSessionToken(fixedRng(0xcd));
const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173", "app://sow"],
  hosts: ["localhost:5173", "127.0.0.1:5173"],
};
const INTERCEPTOR = makeAuthInterceptor({ expectedToken: EXPECTED, allowlist: ALLOWLIST });

function baseWorkflowRunRef(overrides: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    workflowId: "wf_1" as WorkflowRunRef["workflowId"],
    trigger: "manual",
    state: "running",
    idempotencyKey: "idem_1",
    auditRefs: ["aud_1" as WorkflowRunRef["auditRefs"][number]], // DROPPED in projection
    ...overrides,
  };
}

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1" as Approval["id"],
    actionRef: "act_1" as Approval["actionRef"],
    workspaceId: "ws-001" as Approval["workspaceId"],
    status: "pending",
    actor: "user:alice", // DROPPED — approving-principal identity
    channel: "mac",
    payloadHash: "sha256:deadbeef", // DROPPED — content-derived hash
    expiresAt: "2026-07-02T12:00:00.000Z",
    ...overrides,
  };
}

function baseHealthItem(overrides: Partial<HealthItem> = {}): HealthItem {
  return {
    id: "hi_1",
    failureClass: "connector_unreachable",
    severity: "warn",
    message: "raw provider stderr: secret-token=hunter2", // DROPPED — raw content/secret
    auditRef: "aud_1" as HealthItem["auditRef"],
    openedAt: "2026-07-02T10:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

function baseCard(overrides: Partial<DashboardCardSourceInput> = {}): DashboardCardSourceInput {
  return {
    cardId: "card_1",
    kind: "approvals",
    title: "Pending approvals",
    status: "warn",
    count: 3,
    updatedAt: "2026-07-02T11:00:00.000Z",
    ...overrides,
  };
}

function fieldSet(o: object): string[] {
  return Object.keys(o).sort();
}
// The union of ALL allowlisted names across the 4 UI-safe shapes — a payload's
// field set must be a subset of its class's allowlist (asserted per-event below),
// but this is the coarse "no field outside ANY allowlist" backstop.
const ALLOWLIST_FOR = {
  "workflow.status": UI_SAFE_ALLOWLIST.workflowRunRef,
  "approval.update": UI_SAFE_ALLOWLIST.approval,
  "system.health": UI_SAFE_ALLOWLIST.healthItem,
  "read_model.change": UI_SAFE_ALLOWLIST.dashboardCard,
} as const;

function assertUiSafe(ev: StreamEvent): void {
  const allowed: readonly string[] = ALLOWLIST_FOR[ev.name];
  expect(fieldSet(ev.payload as object).every((k) => allowed.includes(k))).toBe(true);
  // And the frozen runtime schema accepts it (discriminated union + .strict()).
  expect(streamEventSchema.safeParse(ev).success).toBe(true);
}

// ── (a) eventClasses — the event SOURCE (monotonic seq + UI-safe projection) ──

describe("createStreamPublisher — the in-process event source", () => {
  it("assigns a MONOTONIC per-stream seq across all four classes", () => {
    const pub: StreamPublisher = createStreamPublisher();
    const e0 = pub.publishWorkflowStatus(baseWorkflowRunRef());
    const e1 = pub.publishApproval(baseApproval());
    const e2 = pub.publishHealth(baseHealthItem());
    const e3 = pub.publishReadModelChange(baseCard());
    expect(e0?.seq).toBe(0);
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    expect(e3?.seq).toBe(3);
    // eventId is derived from the monotonic seq (the tracked() resume id).
    expect(e0?.eventId).toBe("0");
    expect(e3?.eventId).toBe("3");
    // seq never decreases and never repeats.
    const seqs = [e0, e1, e2, e3].map((e) => e?.seq ?? -1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("carries the discriminant name + the seq on every event", () => {
    const pub = createStreamPublisher();
    expect(pub.publishWorkflowStatus(baseWorkflowRunRef())?.name).toBe("workflow.status");
    expect(pub.publishApproval(baseApproval())?.name).toBe("approval.update");
    expect(pub.publishHealth(baseHealthItem())?.name).toBe("system.health");
    expect(pub.publishReadModelChange(baseCard())?.name).toBe("read_model.change");
  });

  it("emits UI-safe payloads ONLY — no secret / raw content / dropped field crosses", () => {
    const pub = createStreamPublisher();
    // Adversarially taint each domain record with an extra sensitive key. The
    // `as unknown as X` cast (matching uiSafe.test.ts) models a caller that
    // smuggles a non-contract field onto the record — the projector must NEVER
    // read it, so it can never ride out onto the UI-safe stream payload.
    const wf = pub.publishWorkflowStatus({
      ...baseWorkflowRunRef(),
      internalNotes: "kc-ref://keychain/session-token",
    } as unknown as WorkflowRunRef);
    const ap = pub.publishApproval({
      ...baseApproval(),
      secret: "kc-ref://keychain/session-token",
    } as unknown as Approval);
    const hi = pub.publishHealth({
      ...baseHealthItem(),
      rawPrompt: "You are a helpful assistant. Secret system prompt...",
    } as unknown as HealthItem);
    const rm = pub.publishReadModelChange({
      ...baseCard(),
      secretPayload: "kc-ref://...",
    } as unknown as DashboardCardSourceInput);

    for (const ev of [wf, ap, hi, rm]) {
      expect(ev).toBeDefined();
      if (ev) assertUiSafe(ev);
    }
    // Explicit: the dropped/injected fields never appear on the payload.
    expect(wf?.payload).not.toHaveProperty("auditRefs");
    expect(wf?.payload).not.toHaveProperty("internalNotes");
    expect(ap?.payload).not.toHaveProperty("actor");
    expect(ap?.payload).not.toHaveProperty("payloadHash");
    expect(ap?.payload).not.toHaveProperty("secret");
    expect(hi?.payload).not.toHaveProperty("message");
    expect(hi?.payload).not.toHaveProperty("auditRef");
    expect(hi?.payload).not.toHaveProperty("rawPrompt");
    expect(rm?.payload).not.toHaveProperty("secretPayload");
  });

  it("carries a correlation/workflowRunId on the workflow.status event", () => {
    const pub = createStreamPublisher();
    const ev = pub.publishWorkflowStatus(baseWorkflowRunRef({ workflowId: "wf_42" as WorkflowRunRef["workflowId"] }));
    // The workflowId (correlation id) survives the projection onto the payload.
    expect(ev?.payload && (ev.payload as { workflowId: string }).workflowId).toBe("wf_42");
  });
});

// ── (a) eventClasses — publish-boundary schema gate (defense-in-depth) ────────

describe("createStreamPublisher — the frozen streamEventSchema gate at PUBLISH", () => {
  it("re-validates each published event against streamEventSchema (in-band happy path)", () => {
    // Every well-formed publish yields an event that the frozen strict schema
    // accepts — the gate is transparent to correct projector output.
    const pub = createStreamPublisher();
    for (const ev of [
      pub.publishWorkflowStatus(baseWorkflowRunRef()),
      pub.publishApproval(baseApproval()),
      pub.publishHealth(baseHealthItem()),
      pub.publishReadModelChange(baseCard()),
    ]) {
      expect(ev).toBeDefined();
      if (ev) expect(streamEventSchema.safeParse(ev).success).toBe(true);
    }
    // All four rode through into the replay log.
    expect(pub.replayFrom(undefined).length).toBe(4);
  });

  it("FAILS CLOSED: a projector regression that emits a non-UI-safe payload is DROPPED at publish (never reaches a subscriber)", () => {
    // Model a projector regression: a dashboard-card projector that leaks an
    // extra, non-allowlisted key onto the UI-safe payload. The frozen `.strict()`
    // schema rejects it; the publish boundary must DROP it (return undefined, no
    // record, no emit) rather than ride a leaked payload out to the wire.
    const pub = createStreamPublisher({
      // Test seam: override the read-model projector to smuggle an extra key.
      unsafeProjectorOverrides: {
        dashboardCard: (card) =>
          ({
            cardId: card.cardId,
            kind: card.kind,
            title: card.title,
            status: card.status,
            count: card.count,
            updatedAt: card.updatedAt,
            leakedSecret: "kc-ref://keychain/session-token",
          }) as unknown as UiSafeDashboardCard,
      },
    });

    const live: StreamEvent[] = [];
    const off = pub.onEvent((ev) => live.push(ev));
    const emitted = pub.publishReadModelChange(baseCard());
    off();

    // The malformed event was dropped: no return, no emit, no log entry.
    expect(emitted).toBeUndefined();
    expect(live).toEqual([]);
    expect(pub.replayFrom(undefined)).toEqual([]);
  });

  it("a valid event AFTER a dropped one still publishes (the gate drops only the bad event)", () => {
    const pub = createStreamPublisher({
      unsafeProjectorOverrides: {
        // A read-model projector regression that omits required fields + leaks an
        // extra key ⇒ the frozen schema rejects the whole event ⇒ publish dropped.
        dashboardCard: () =>
          ({ cardId: "card_bad", extraKey: "leak" }) as unknown as UiSafeDashboardCard,
      },
    });
    // A malformed read-model publish is dropped...
    expect(pub.publishReadModelChange(baseCard())).toBeUndefined();
    // ...then a well-formed workflow publish still succeeds and lands in the log.
    const ok = pub.publishWorkflowStatus(baseWorkflowRunRef());
    expect(ok).toBeDefined();
    expect(pub.replayFrom(undefined).map((e) => e.name)).toEqual(["workflow.status"]);
  });
});

// ── (a) eventClasses — bounded replay log + lossless resume ───────────────────

describe("StreamPublisher.replayFrom — lossless resume from lastEventId", () => {
  it("replays EXACTLY the events after lastEventId (none dropped, none duplicated)", () => {
    const pub = createStreamPublisher();
    const emitted: StreamEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const ev = pub.publishWorkflowStatus(baseWorkflowRunRef({ idempotencyKey: `idem_${i}` }));
      if (ev) emitted.push(ev);
    }
    // Resume from eventId "2" ⇒ exactly events 3,4,5 (the missed ones after 2).
    const missed = pub.replayFrom("2");
    expect(missed.map((e) => e.eventId)).toEqual(["3", "4", "5"]);
    // No gap, no dup: the seqs are contiguous and unique.
    expect(missed.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("replays the WHOLE stream when no lastEventId is supplied (fresh subscribe)", () => {
    const pub = createStreamPublisher();
    for (let i = 0; i < 3; i++) pub.publishWorkflowStatus(baseWorkflowRunRef());
    const all = pub.replayFrom(undefined);
    expect(all.map((e) => e.eventId)).toEqual(["0", "1", "2"]);
  });

  it("returns nothing when lastEventId is already the head (fully caught up)", () => {
    const pub = createStreamPublisher();
    for (let i = 0; i < 3; i++) pub.publishWorkflowStatus(baseWorkflowRunRef());
    expect(pub.replayFrom("2")).toEqual([]);
  });

  it("bounds the replay window (over-horizon lastEventId ⇒ resync signal, never a silent drop)", () => {
    const pub = createStreamPublisher({ replayWindow: 3 });
    for (let i = 0; i < 8; i++) pub.publishWorkflowStatus(baseWorkflowRunRef());
    // Only the last 3 events are retained (eventIds 5,6,7). A resume from "1"
    // is over-horizon — its successors 2,3,4 are gone. The publisher must NOT
    // silently drop: it signals a resync-from-snapshot rather than a partial log.
    const res = pub.resumeOrResync("1");
    expect(res.kind).toBe("resync");
  });

  it("resumes normally when lastEventId is still inside the window", () => {
    const pub = createStreamPublisher({ replayWindow: 3 });
    for (let i = 0; i < 8; i++) pub.publishWorkflowStatus(baseWorkflowRunRef());
    const res = pub.resumeOrResync("6");
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") expect(res.events.map((e) => e.eventId)).toEqual(["7"]);
  });
});

// ── (a) eventClasses — approval exactly-once (dedupe by transition identity) ──

describe("StreamPublisher.publishApproval — exactly-once by transition identity", () => {
  it("does NOT emit a duplicate approval event for the SAME transition (id+status)", () => {
    const pub = createStreamPublisher();
    const first = pub.publishApproval(baseApproval({ id: "apr_9" as Approval["id"], status: "approved" }));
    // The 8.4 transition may be re-driven on a replayed/resumed workflow — the
    // SAME (id, status) transition must NOT produce a second stream event.
    const dup = pub.publishApproval(baseApproval({ id: "apr_9" as Approval["id"], status: "approved" }));
    expect(first).toBeDefined();
    expect(dup).toBeUndefined();
    // Exactly one approval event landed in the log.
    const approvals = pub.replayFrom(undefined).filter((e) => e.name === "approval.update");
    expect(approvals.length).toBe(1);
  });

  it("DOES emit for a genuine NEXT transition of the same approval (pending → approved)", () => {
    const pub = createStreamPublisher();
    const a = pub.publishApproval(baseApproval({ id: "apr_7" as Approval["id"], status: "pending" }));
    const b = pub.publishApproval(baseApproval({ id: "apr_7" as Approval["id"], status: "approved" }));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.eventId).not.toBe(b?.eventId);
  });

  it("a replay of the log carries NO duplicate approval eventIds", () => {
    const pub = createStreamPublisher();
    pub.publishApproval(baseApproval({ id: "apr_1" as Approval["id"], status: "pending" }));
    pub.publishApproval(baseApproval({ id: "apr_1" as Approval["id"], status: "pending" })); // dup transition — dropped
    pub.publishApproval(baseApproval({ id: "apr_2" as Approval["id"], status: "pending" }));
    const ids = pub.replayFrom(undefined).map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate eventIds
    const approvals = pub.replayFrom(undefined).filter((e) => e.name === "approval.update");
    expect(approvals.length).toBe(2);
  });
});

// ── (b) handshake — auth BEFORE any event flows ──────────────────────────────

describe("runStreamHandshake — the 8.1 interceptor runs pre-subscription", () => {
  it("admits a valid token (from connectionParams) + allowlisted Origin/Host", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.authenticated).toBe(true);
  });

  it("rejects a MISSING token (no connectionParams) BEFORE any event (UNAUTHORIZED)", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: null,
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.message).toBe("unauthenticated");
    }
  });

  it("rejects an absent token key on connectionParams (fail-closed)", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: {},
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("rejects a WRONG (equal-length) token BEFORE any event (UNAUTHORIZED)", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: WRONG.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("rejects a wrong ORIGIN with a valid token (FORBIDDEN, pre-subscription)", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://evil.com",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects a wrong HOST (DNS-rebind) with a valid token + origin", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "evil.com",
    });
    expect(isErr(r)).toBe(true);
  });

  it("checks the token BEFORE the origin (auth precedes authorization)", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: WRONG.value },
      origin: "http://evil.com",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("NEVER pulls the token from a URL — a token-in-URL-only handshake is unauthenticated", () => {
    // The token rides connectionParams (first WS message), NOT the URL. If a
    // caller only puts it in a URL query, connectionParams has no token ⇒ reject.
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { url: `ws://localhost:5173/?token=${EXPECTED.value}` },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("never leaks the presented/expected secret into the failure", () => {
    const r = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: WRONG.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    if (isErr(r)) {
      expect(JSON.stringify(r.error)).not.toContain(WRONG.value);
      expect(JSON.stringify(r.error)).not.toContain(EXPECTED.value);
    }
  });
});

// ── (c) pushStream — the tRPC subscription (auth-gated, tracked, resumable) ───

describe("createPushStream — the tRPC v11 subscription procedure", () => {
  it("exposes a publisher handle + a mountable router", () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    expect(ps.publisher).toBeDefined();
    expect(typeof ps.publisher.publishWorkflowStatus).toBe("function");
    expect(ps.router).toBeDefined();
  });

  it("does NOT flow any event when the handshake fails (auth before events)", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    // Feed an event, then subscribe with a failed-auth context.
    ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    const failedAuth = runStreamHandshake(INTERCEPTOR, {
      connectionParams: null,
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    // The subscription generator, given a rejected auth outcome, yields NOTHING
    // and completes (no events cross to an unauthenticated consumer).
    const seen: unknown[] = [];
    for await (const item of ps.subscribe(failedAuth, { lastEventId: undefined })) {
      seen.push(item);
    }
    expect(seen).toEqual([]);
  });

  it("yields tracked(eventId, uiSafePayload) for each buffered event on an authed subscribe", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    ps.publisher.publishApproval(baseApproval());
    const authed = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    const seen: Array<{ id: string; data: unknown }> = [];
    for await (const tr of ps.subscribe(authed, { lastEventId: undefined })) {
      // tracked() envelope is [id, data, symbol]; the module surfaces {id,data}.
      seen.push({ id: tr.id, data: tr.data });
    }
    expect(seen.map((s) => s.id)).toEqual(["0", "1"]);
    // The data is the UI-safe payload — never a secret / dropped field.
    expect(seen[1]?.data).not.toHaveProperty("actor");
    expect(seen[1]?.data).not.toHaveProperty("payloadHash");
  });

  it("resumes losslessly from lastEventId (no missed events dropped, none duplicated)", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    for (let i = 0; i < 5; i++) ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    const authed = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    const seen: string[] = [];
    for await (const tr of ps.subscribe(authed, { lastEventId: "1" })) {
      seen.push(tr.id);
    }
    expect(seen).toEqual(["2", "3", "4"]);
  });

  it("an approval.update replay is idempotent by eventId (no dup across a resumed workflow)", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    ps.publisher.publishApproval(baseApproval({ id: "apr_5" as Approval["id"], status: "approved" }));
    // A resumed/replayed workflow re-drives the SAME transition — no new event.
    ps.publisher.publishApproval(baseApproval({ id: "apr_5" as Approval["id"], status: "approved" }));
    const authed = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    const ids: string[] = [];
    for await (const tr of ps.subscribe(authed, { lastEventId: undefined })) {
      ids.push(tr.id);
    }
    // Exactly one approval event, one eventId — the replay carries no duplicate.
    expect(ids).toEqual(["0"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── (c) pushStream — over-horizon resume on the WIRE path yields a resync frame ─
//
// FINDING 1: `runSubscription` (the on-wire `onEvent` subscription) must route
// its resume through `planResume` so an aged-out `lastEventId` gets the EXPLICIT
// resync-from-snapshot control frame, not a silently-gapped partial replay.

describe("createPushStream.subscribe — fail-closed over-horizon resume on the WIRE path", () => {
  const authed = () =>
    runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });

  it("an OVER-HORIZON lastEventId yields ONE resync control frame, not a silent partial replay", async () => {
    // Window of 3 retains only the last 3 events; a resume from "1" is aged out.
    const ps = createPushStream({ interceptor: INTERCEPTOR, publisherOptions: { replayWindow: 3 } });
    for (let i = 0; i < 8; i++) ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());

    const items: TrackedItem[] = [];
    for await (const tr of ps.subscribe(authed(), { lastEventId: "1" })) {
      items.push(tr);
    }
    // Exactly one item, and it is the distinguished resync control frame — NOT a
    // partial slice of the retained log (which would silently drop events 2,3,4).
    expect(items.length).toBe(1);
    expect(isResyncControl(items[0]!)).toBe(true);
    // The control frame carries the typed marker and NO raw/secret payload data.
    expect(items[0]!.data).toEqual({ __control: "resync" });
    // It is unambiguous vs a normal event: no numeric eventId, no UI-safe payload.
    expect(items.filter((i) => !isResyncControl(i))).toEqual([]);
  });

  it("an IN-WINDOW lastEventId still replays EXACTLY the missed events (no resync, no regression)", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR, publisherOptions: { replayWindow: 3 } });
    for (let i = 0; i < 8; i++) ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    const items: TrackedItem[] = [];
    for await (const tr of ps.subscribe(authed(), { lastEventId: "6" })) {
      items.push(tr);
    }
    // Only event 7 was missed and still in the window — replayed, no control frame.
    expect(items.map((i) => i.id)).toEqual(["7"]);
    expect(items.some((i) => isResyncControl(i))).toBe(false);
  });

  it("a fresh subscribe (no lastEventId, in-window) replays normally — no resync frame", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    for (let i = 0; i < 3; i++) ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    const items: TrackedItem[] = [];
    for await (const tr of ps.subscribe(authed(), { lastEventId: undefined })) {
      items.push(tr);
    }
    expect(items.map((i) => i.id)).toEqual(["0", "1", "2"]);
    expect(items.some((i) => isResyncControl(i))).toBe(false);
  });

  it("a resync frame is emitted BEFORE any live tail so the client refetches then re-establishes", async () => {
    const ps = createPushStream({ interceptor: INTERCEPTOR, publisherOptions: { replayWindow: 2 } });
    for (let i = 0; i < 5; i++) ps.publisher.publishWorkflowStatus(baseWorkflowRunRef()); // aged out "0"
    const ctrl = new AbortController();
    const items: TrackedItem[] = [];
    let sawResync = false;
    const pump = (async () => {
      for await (const tr of ps.subscribe(authed(), { lastEventId: "0", signal: ctrl.signal })) {
        items.push(tr);
        if (isResyncControl(tr)) sawResync = true;
        else ctrl.abort(); // got the post-resync live event — stop.
      }
    })();
    // Give the generator time to yield the resync frame + attach its live-tail
    // listener, THEN publish a fresh committed change on the live tail.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(sawResync).toBe(true); // resync frame arrived FIRST, before any live event.
    ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    await pump;
    // Frame 0 is the resync control frame; the live event follows it (re-establish).
    expect(isResyncControl(items[0]!)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(isResyncControl(items[1]!)).toBe(false);
  });
});
