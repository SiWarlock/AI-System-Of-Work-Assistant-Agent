// Task 8.4 — Command procedures: approval transitions + ingestion-triage
// disposition (exactly-once / idempotent). TDD RED-first spec.
//
// SAFETY-CRITICAL. This spec pins the load-bearing exactly-once + one-writer
// properties of the command surface:
//
//   (a) APPROVAL COMMAND — approve/edit/reject/defer is a SINGLE idempotent
//       transition over pending -> approved|edited|rejected|deferred|expired.
//       Resubmitting the SAME decision is a no-op returning the same transition
//       (REQ-F-012). Mac + Telegram are parity channels: the same idempotent
//       transition regardless of channel, and a double-apply ACROSS channels
//       collapses to EXACTLY ONE durable state change (driven through
//       `decideApprovalCas` so the second-channel contender is an
//       `idempotent_noop`, never a 2nd apply). `defer` sets snoozeUntil/expiresAt.
//       approve/reject on an ALREADY-EXPIRED item is a typed rejection with NO
//       state change, audited.
//
//   (b) INGESTION-TRIAGE DISPOSITION re-enters the ingestion pipeline reusing the
//       SAME idempotencyKey (replay-safe), resolving ING-4.
//
//   (c) ONE-WRITER / TOOL-GATEWAY. A command DISPATCHES ONLY via the injected
//       Temporal / Tool-Gateway dispatch port — it NEVER writes an external system
//       or Markdown directly (§7/§8). This is asserted structurally: the only
//       side-effect a command may cause is a call on the injected dispatch port,
//       and a NO-OP contender (the losing second channel / a replay) causes NO
//       dispatch at all (only the genuine transitioner may drive the side effect).
//
// The command router is exercised through `createCallerFactory` (the real tRPC
// caller path, behind the 8.1 auth gate), with FAKE ports — the real port binding
// is the integrator step.
import { describe, it, expect } from "vitest";
import {
  isErr,
  isOk,
  type Approval,
  type ApprovalStatus,
  type Channel,
  type Result,
  type FailureVariant,
} from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import type {
  ApprovalTransitionOutcome,
  DbError,
} from "@sow/db";
import { createCallerFactory, router } from "../../src/api/trpc";
import {
  buildCommandRouter,
  type ApprovalCommandPort,
  type TriagePort,
  type CommandDeps,
  type TriageDisposition,
} from "../../src/api/procedures/commands";
import type { ApiContext } from "../../src/api/trpc";

// ── fixtures ────────────────────────────────────────────────────────────────

function approval(status: ApprovalStatus, over: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1" as Approval["id"],
    actionRef: "act_1" as Approval["actionRef"],
    workspaceId: "ws-001" as Approval["workspaceId"],
    status,
    actor: "user:alice",
    channel: "mac",
    payloadHash: "sha256:deadbeef",
    ...over,
  };
}

// An authed ApiContext (the 8.1 gate already passed) — command resolvers only
// ever run behind this, so we build the caller directly with the ok context.
const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: {
    ok: false,
    error: { kind: "validation_rejected", message: "unauthenticated", retryable: false },
  },
};

// A FAKE ApprovalCommandPort backed by a tiny in-memory store that drives the
// REAL `decideApprovalCas` semantics: apply | idempotent_noop | stale_conflict.
// It records every applyTransition call so a test can assert exactly-once.
class FakeApprovalStore implements ApprovalCommandPort {
  applyCalls: Array<{ id: string; expectedFrom: ApprovalStatus; next: ApprovalStatus }> = [];
  private record: Approval;
  constructor(initial: Approval) {
    this.record = initial;
  }
  async get(id: Approval["id"]): Promise<Result<Approval, DbError>> {
    if (id !== this.record.id) {
      return { ok: false, error: { code: "not_found", message: "no such approval" } };
    }
    return { ok: true, value: this.record };
  }
  async applyTransition(
    id: Approval["id"],
    expectedFrom: ApprovalStatus,
    next: Approval,
  ): Promise<Result<ApprovalTransitionOutcome, DbError>> {
    this.applyCalls.push({ id, expectedFrom, next: next.status });
    if (id !== this.record.id) {
      return { ok: false, error: { code: "not_found", message: "no such approval" } };
    }
    const current = this.record.status;
    // Exactly-once CAS, same three verdicts as decideApprovalCas.
    if (current === next.status) {
      // idempotent no-op: end-state already holds; NO durable write.
      return { ok: true, value: { approval: this.record, applied: false } };
    }
    const terminal = ["approved", "edited", "rejected", "expired"];
    if (terminal.includes(current)) {
      return { ok: false, error: { code: "conflict", message: "stale/tombstoned" } };
    }
    if (current === expectedFrom) {
      this.record = next;
      return { ok: true, value: { approval: next, applied: true } };
    }
    return { ok: false, error: { code: "conflict", message: "stale expectedFrom" } };
  }
  current(): Approval {
    return this.record;
  }
}

// A FAKE dispatch port — records dispatch calls so a test can assert that a
// command routes side effects ONLY through here (never a direct external write).
class FakeDispatch {
  approvalDispatches: Array<{ approval: Approval }> = [];
  async dispatchApproved(a: Approval): Promise<Result<void, FailureVariant>> {
    this.approvalDispatches.push({ approval: a });
    return { ok: true, value: undefined };
  }
}

// A FAKE TriagePort — records the re-enter call so a test can assert the SAME
// idempotencyKey is reused (replay-safe, ING-4).
class FakeTriage implements TriagePort {
  reenterCalls: Array<{ idempotencyKey: string; disposition: TriageDisposition; sourceId: string }> = [];
  async reenterIngestion(input: {
    sourceId: string;
    idempotencyKey: string;
    disposition: TriageDisposition;
  }): Promise<Result<{ idempotencyKey: string }, FailureVariant>> {
    this.reenterCalls.push({
      idempotencyKey: input.idempotencyKey,
      disposition: input.disposition,
      sourceId: input.sourceId,
    });
    return { ok: true, value: { idempotencyKey: input.idempotencyKey } };
  }
}

// A fixed clock so defer's snoozeUntil/expiresAt are deterministic.
const NOW = "2026-07-02T12:00:00.000Z";
const clock = (): string => NOW;

function makeDeps(over: Partial<CommandDeps> = {}): {
  deps: CommandDeps;
  store: FakeApprovalStore;
  dispatch: FakeDispatch;
  triage: FakeTriage;
} {
  const store = new FakeApprovalStore(approval("pending"));
  const dispatch = new FakeDispatch();
  const triage = new FakeTriage();
  const deps: CommandDeps = {
    approvals: store,
    triage,
    dispatchApproval: (a) => dispatch.dispatchApproved(a),
    now: clock,
    ...over,
  };
  return { deps, store, dispatch, triage };
}

function caller(deps: CommandDeps, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ command: buildCommandRouter(deps) });
  const factory = createCallerFactory(appRouter);
  return factory(ctx);
}

// ── (a) approval command: single idempotent transition ──────────────────────

describe("approval command — single idempotent transition (REQ-F-012)", () => {
  it("approve is ONE genuine transition pending -> approved (applied)", async () => {
    const { deps, store, dispatch } = makeDeps();
    const c = caller(deps);
    const r = await c.command.decideApproval({
      approvalId: "apr_1",
      decision: "approve",
      channel: "mac",
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.applied).toBe(true);
      expect(r.value.approval.status).toBe("approved");
    }
    expect(store.current().status).toBe("approved");
    // Genuine transitioner drives exactly one dispatch.
    expect(dispatch.approvalDispatches).toHaveLength(1);
  });

  it("re-approve the SAME decision is an idempotent no-op (same transition, NO 2nd apply, NO 2nd dispatch)", async () => {
    const { deps, store, dispatch } = makeDeps();
    const c = caller(deps);
    const first = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    const second = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      // Same terminal transition surfaced; but it did NOT re-apply.
      expect(second.value.applied).toBe(false);
      expect(second.value.approval.status).toBe("approved");
    }
    // Exactly one durable state change; exactly one dispatch.
    expect(store.current().status).toBe("approved");
    expect(dispatch.approvalDispatches).toHaveLength(1);
  });

  it("edit / reject map to their own transitions", async () => {
    for (const [decision, expected] of [
      ["edit", "edited"],
      ["reject", "rejected"],
    ] as const) {
      const { deps, store } = makeDeps();
      const c = caller(deps);
      const r = await c.command.decideApproval({ approvalId: "apr_1", decision, channel: "telegram" });
      expect(isOk(r)).toBe(true);
      if (isOk(r)) expect(r.value.approval.status).toBe(expected);
      expect(store.current().status).toBe(expected);
    }
  });
});

// ── (a) Mac + Telegram parity: cross-channel double-apply = exactly one ──────

describe("Mac + Telegram parity — cross-channel double-apply collapses to EXACTLY ONE state change", () => {
  it("Mac-then-Telegram approve yields exactly one apply + one dispatch", async () => {
    const { deps, store, dispatch } = makeDeps();
    const c = caller(deps);
    // First channel: Mac. Genuine transition.
    const mac = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    // Second channel: Telegram, SAME decision. Contends on the same target.
    const tg = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "telegram" });
    expect(isOk(mac)).toBe(true);
    expect(isOk(tg)).toBe(true);
    if (isOk(mac)) expect(mac.value.applied).toBe(true);
    if (isOk(tg)) expect(tg.value.applied).toBe(false); // idempotent_noop — never a 2nd apply
    // The SAFETY-CRITICAL assertion: exactly one durable state change, one dispatch.
    expect(store.current().status).toBe("approved");
    expect(dispatch.approvalDispatches).toHaveLength(1);
  });

  it("Telegram-first then Mac is symmetric — still exactly one", async () => {
    const { deps, store, dispatch } = makeDeps();
    const c = caller(deps);
    const tg = await c.command.decideApproval({ approvalId: "apr_1", decision: "reject", channel: "telegram" });
    const mac = await c.command.decideApproval({ approvalId: "apr_1", decision: "reject", channel: "mac" });
    expect(isOk(tg)).toBe(true);
    expect(isOk(mac)).toBe(true);
    if (isOk(tg)) expect(tg.value.applied).toBe(true);
    if (isOk(mac)) expect(mac.value.applied).toBe(false);
    expect(store.current().status).toBe("rejected");
    // reject dispatch is still routed through the port exactly once.
    expect(dispatch.approvalDispatches).toHaveLength(1);
  });
});

// ── (a) defer sets snoozeUntil/expiresAt; non-terminal ──────────────────────

describe("defer — sets snoozeUntil/expiresAt, non-terminal (deferred -> pending|expired)", () => {
  it("defer transitions pending -> deferred and stamps snoozeUntil + expiresAt from the clock", async () => {
    const { deps, store } = makeDeps();
    const c = caller(deps);
    const r = await c.command.decideApproval({ approvalId: "apr_1", decision: "defer", channel: "mac" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.approval.status).toBe("deferred");
      expect(typeof r.value.approval.snoozeUntil).toBe("string");
      expect(typeof r.value.approval.expiresAt).toBe("string");
      // snooze is AFTER now; expiry is after snooze.
      expect(new Date(r.value.approval.snoozeUntil as string).getTime()).toBeGreaterThan(
        new Date(NOW).getTime(),
      );
    }
    expect(store.current().status).toBe("deferred");
  });
});

// ── (a) approve/reject on an already-EXPIRED item ───────────────────────────

describe("approve/reject on an already-expired item — typed rejection, NO state change", () => {
  it("approve on expired is a typed err with no state change and no dispatch", async () => {
    const store = new FakeApprovalStore(approval("expired"));
    const dispatch = new FakeDispatch();
    const triage = new FakeTriage();
    const deps: CommandDeps = {
      approvals: store,
      triage,
      dispatchApproval: (a) => dispatch.dispatchApproved(a),
      now: clock,
    };
    const c = caller(deps);
    const r: Result<unknown, FailureVariant> = await c.command.decideApproval({
      approvalId: "apr_1",
      decision: "approve",
      channel: "mac",
    });
    expect(isErr(r)).toBe(true);
    // No durable transition; no side effect.
    expect(store.current().status).toBe("expired");
    expect(dispatch.approvalDispatches).toHaveLength(0);
  });
});

// ── (a) §9.8 renderer boundary — decideApproval returns a UI-SAFE approval ───

describe("§9.8 renderer boundary — decideApproval returns a UI-safe approval (no actor / payloadHash)", () => {
  it("the returned approval carries ONLY the UI-safe allowlist; actor + payloadHash are dropped", async () => {
    // The renderer receives ONLY UI-safe projections (desktop boundary; §10, REQ-S-004).
    // `decideApproval`'s result must be projected through `toUiSafeApproval` — the raw
    // Approval's `actor` (approving-principal identity) + `payloadHash` (content-derived hash)
    // must NEVER cross to the renderer. `defer` is used so the timing fields are populated.
    const { deps } = makeDeps();
    const c = caller(deps);
    const r = await c.command.decideApproval({ approvalId: "apr_1", decision: "defer", channel: "mac" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const a = r.value.approval;
      // The applied flag still crosses (exactly-once semantics for the caller).
      expect(r.value.applied).toBe(true);
      // UI-safe fields present + correct.
      expect(a.id).toBe("apr_1");
      expect(a.actionRef).toBe("act_1");
      expect(a.status).toBe("deferred");
      expect(a.channel).toBe("mac");
      expect(typeof a.snoozeUntil).toBe("string");
      expect(typeof a.expiresAt).toBe("string");
      // DROPPED domain fields — must NOT reach the renderer.
      expect("actor" in a).toBe(false);
      expect("payloadHash" in a).toBe(false);
      // The projected key set is EXACTLY the UI-safe allowlist — no extra key rides out.
      expect(Object.keys(a).sort()).toEqual([
        "actionRef",
        "channel",
        "expiresAt",
        "id",
        "snoozeUntil",
        "status",
      ]);
    }
  });

  it("the idempotent NO-OP path (applied:false) is projected too — a replay never leaks the raw record", async () => {
    // The one `ok({ approval: toUiSafeApproval(...), applied })` return is not branched on
    // `applied`, so the cross-channel no-op contender gets the SAME projection. Pin it so a
    // future refactor that special-cases the no-op return can't reintroduce the raw record.
    const { deps } = makeDeps();
    const c = caller(deps);
    await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    const noop = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "telegram" });
    expect(isOk(noop)).toBe(true);
    if (isOk(noop)) {
      expect(noop.value.applied).toBe(false); // idempotent no-op contender
      expect("actor" in noop.value.approval).toBe(false);
      expect("payloadHash" in noop.value.approval).toBe(false);
      expect(Object.keys(noop.value.approval).sort()).toEqual(["actionRef", "channel", "id", "status"]);
    }
  });

  it("a terminal decision (approve) returns a UI-safe approval with no snooze/expiry keys", async () => {
    // approve is terminal → nextRecord carries no snoozeUntil/expiresAt, so the optional
    // timing keys are OMITTED (not set to undefined) and actor/payloadHash still never cross.
    const { deps } = makeDeps();
    const c = caller(deps);
    const r = await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "telegram" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(Object.keys(r.value.approval).sort()).toEqual(["actionRef", "channel", "id", "status"]);
      expect(r.value.approval.status).toBe("approved");
    }
  });
});

// ── (b) ingestion-triage disposition — reuse idempotencyKey ─────────────────

describe("ingestion-triage disposition — re-enters ingestion reusing the SAME idempotencyKey (ING-4)", () => {
  it("dispatches the disposition to the triage port with the caller's idempotencyKey verbatim", async () => {
    const { deps, triage } = makeDeps();
    const c = caller(deps);
    const r = await c.command.disposeTriage({
      sourceId: "src_1",
      idempotencyKey: "idem-abc-123",
      disposition: "accept",
    });
    expect(isOk(r)).toBe(true);
    expect(triage.reenterCalls).toHaveLength(1);
    // The SAME idempotencyKey is reused — replay-safe re-entry.
    expect(triage.reenterCalls[0]?.idempotencyKey).toBe("idem-abc-123");
    expect(triage.reenterCalls[0]?.disposition).toBe("accept");
  });

  it("a replayed triage disposition reuses the SAME key (idempotent re-entry)", async () => {
    const { deps, triage } = makeDeps();
    const c = caller(deps);
    await c.command.disposeTriage({ sourceId: "src_1", idempotencyKey: "idem-x", disposition: "reject" });
    await c.command.disposeTriage({ sourceId: "src_1", idempotencyKey: "idem-x", disposition: "reject" });
    // Both re-entries carry the identical idempotency key — the pipeline dedupes.
    expect(triage.reenterCalls.map((k) => k.idempotencyKey)).toEqual(["idem-x", "idem-x"]);
  });
});

// ── (c) one-writer / Tool-Gateway — commands never write directly ────────────

describe("one-writer / Tool-Gateway — a command dispatches ONLY via injected ports", () => {
  it("the approval command's ONLY side effect is a call on the injected dispatch port", async () => {
    const { deps, dispatch, triage } = makeDeps();
    const c = caller(deps);
    await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    // A dispatch happened via the port; the triage port was untouched; no other sink exists.
    expect(dispatch.approvalDispatches).toHaveLength(1);
    expect(triage.reenterCalls).toHaveLength(0);
  });

  it("a no-op contender (idempotent_noop) causes ZERO dispatch — only the genuine transitioner drives a side effect", async () => {
    const { deps, dispatch } = makeDeps();
    const c = caller(deps);
    await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "mac" });
    const before = dispatch.approvalDispatches.length;
    await c.command.decideApproval({ approvalId: "apr_1", decision: "approve", channel: "telegram" });
    // The second-channel no-op MUST NOT dispatch again.
    expect(dispatch.approvalDispatches.length).toBe(before);
  });
});

// ── auth gate — command router is behind the 8.1 interceptor ─────────────────

describe("auth gate — a command from an unauthenticated context is a typed err, never a throw", () => {
  it("decideApproval on an unauth context returns err(FailureVariant) without touching the store", async () => {
    const { deps, store } = makeDeps();
    const c = caller(deps, UNAUTH_CTX);
    const r: Result<unknown, FailureVariant> = await c.command.decideApproval({
      approvalId: "apr_1",
      decision: "approve",
      channel: "mac",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
    // The store was never touched — the gate ran before the resolver body.
    expect(store.applyCalls).toHaveLength(0);
  });
});
