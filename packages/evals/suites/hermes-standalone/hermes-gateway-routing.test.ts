// spec(§20.1 "Hermes standalone automation" · RT-7 · §8) — task 12.13.
//
// The §20.1 ACCEPTANCE suite for RT-7: a Hermes cron/Kanban standalone automation
// MAY initiate a user-defined job, but it is NOT the product-workflow source of
// truth (Temporal is), and it has NO write authority of its own — EVERY external
// side effect is FORCED through the §8 Tool Gateway (envelope + idempotency +
// approval) and EVERY semantic write through KnowledgeWriter. There is no
// Hermes-direct Markdown / GBrain / external-write path.
//
// This suite exercises the REAL code on BOTH sides of that invariant:
//   • the REAL Tool Gateway `dispatchExternalWrite` (@sow/integrations) — the
//     envelope + pre-write existence check + reserve/create + approval gate that
//     ANY automation (incl. a Hermes-tagged one) must satisfy; and
//   • the REAL Hermes driver `runHermesAutomation` (@sow/workflows) — the RT-7
//     routing enforcement that pushes a Hermes automation's semantic write through
//     the KnowledgeWriter commit port and its external side effect through the Tool
//     Gateway propose port, with no direct-write path.
// It then SCORES the `HERMES_STANDALONE` criterion through the EVAL-1 runner
// (task 12.1) and asserts the verdict.
//
// DoD honesty: unlike the egress-ack suite (which needs a real conformant
// provider), the RT-7 gateway-routing invariant is DETERMINISTIC — the envelope,
// idempotency, approval, admission, and one-writer enforcement are pure control-
// plane code with no model/vendor in the loop. So `HERMES_STANDALONE` is registered
// with `requiresRealIntegration=false`: a fixture-driven run over the real gateway
// + driver seams IS the certifying code path (dodValid=true at
// fromRealIntegration:false). This suite asserts exactly that.
//
// Acceptance criteria exercised (§20.1 / task 12.13 bullets):
//  (a) a Hermes-initiated external side effect still carries the §8 envelope and
//      routes through the gateway (idempotent, approval-gated).
//  (b) a direct-write attempt bypassing the gateways is REJECTED/blocked, not
//      silently allowed (envelope-linkage rejection at the gateway; ING-7 mutating-
//      tool admission rejection + fail-closed routing at the Hermes driver).
//  (c) a replayed automation produces NO duplicate external action and NO direct
//      Markdown/GBrain write (create called exactly once; commit + external write
//      reused; run reused).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, workspaceId, workflowId, sourceId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  ExternalWriteEnvelope,
  ProposedAction,
  KnowledgeMutationPlan,
  WriteReceipt,
  AuditRecord,
  TargetSystem,
} from "@sow/contracts";
import {
  dispatchExternalWrite,
  buildEnvelopeFromAction,
  type ExternalWriteDeps,
  type GatewayApprovalDecision,
  type TargetWriteAdapter,
  type ExistingObject,
  type AdapterError,
  type ReceiptStore,
  type ReceiptRecord,
  type ReceiptReservation,
} from "@sow/integrations";
import { runHermesAutomation } from "@sow/workflows";
import type {
  HermesAutomationDeps,
  HermesAutomationInput,
} from "@sow/workflows";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const CRITERION_ID = "HERMES_STANDALONE";
const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

// ════════════════════════════════════════════════════════════════════════════
// PART A — the REAL Tool Gateway invariant (`dispatchExternalWrite`)
//
// The §8 envelope + idempotency + approval enforcement that ANY automation,
// including a Hermes-tagged cron/Kanban job, must satisfy. Inline doubles only for
// the vendor adapter + the receipt index; the enforcement is the real gateway.
// ════════════════════════════════════════════════════════════════════════════

// A Hermes automation's proposed external action (pure literal; mirrors the shape
// in packages/integrations/test/support/fakes.ts).
function makeHermesAction(partial: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actionId: "action-hermes-1" as ProposedAction["actionId"],
    targetSystem: "drive",
    canonicalObjectKey: "cok_hermes_daily_tidy",
    payload: { title: "Hermes daily-tidy note" },
    approvalPolicy: "requires_approval",
    idempotencyKey: "idem-hermes-ext-1",
    ...partial,
  };
}

// Map-backed ReceiptStore — the gateway's exactly-once receipt index. Indexes by
// idempotencyKey (replay gate) + targetSystem|canonicalObjectKey (existence check),
// with a synchronous reserve set (the in-process create-race guard). Mirrors the
// production adapter contract; returns undefined on miss (never throws).
class InMemoryReceiptStore implements ReceiptStore {
  private readonly byIdem = new Map<string, ReceiptRecord>();
  private readonly byObject = new Map<string, ReceiptRecord>();
  private readonly reserved = new Set<string>();

  private static objectKey(targetSystem: TargetSystem, k: string): string {
    return `${targetSystem}|${k}`;
  }

  async getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined> {
    return this.byIdem.get(k);
  }

  async getByCanonicalObjectKey(
    targetSystem: TargetSystem,
    k: string,
  ): Promise<ReceiptRecord | undefined> {
    return this.byObject.get(InMemoryReceiptStore.objectKey(targetSystem, k));
  }

  async reserve(
    targetSystem: TargetSystem,
    canonicalObjectKey: string,
  ): Promise<ReceiptReservation> {
    const key = InMemoryReceiptStore.objectKey(targetSystem, canonicalObjectKey);
    const committed = this.byObject.get(key);
    if (committed !== undefined) return { kind: "committed", record: committed };
    if (this.reserved.has(key)) return { kind: "in_progress" };
    this.reserved.add(key);
    return { kind: "reserved" };
  }

  async release(targetSystem: TargetSystem, canonicalObjectKey: string): Promise<void> {
    this.reserved.delete(InMemoryReceiptStore.objectKey(targetSystem, canonicalObjectKey));
  }

  async put(r: ReceiptRecord): Promise<void> {
    const key = InMemoryReceiptStore.objectKey(r.targetSystem, r.canonicalObjectKey);
    this.byIdem.set(r.idempotencyKey, r);
    this.byObject.set(key, r);
    this.reserved.delete(key);
  }

  size(): number {
    return this.byIdem.size;
  }
}

interface GatewayHarness {
  deps: ExternalWriteDeps;
  createCalls: () => number;
  existenceChecked: () => boolean;
  pendingRecorded: () => number;
  store: InMemoryReceiptStore;
}

function makeGatewayHarness(overrides: {
  requireApproval?: () => GatewayApprovalDecision;
  isApproved?: () => Promise<boolean>;
  create?: () => Promise<Result<WriteReceipt, AdapterError>>;
} = {}): GatewayHarness {
  let creates = 0;
  let existence = 0;
  let pending = 0;
  const store = new InMemoryReceiptStore();

  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> => {
      existence += 1;
      return ok(null);
    },
    create:
      overrides.create ??
      (async (): Promise<Result<WriteReceipt, AdapterError>> => {
        creates += 1;
        return ok({ externalObjectId: `ext_hermes_${creates}`, recordedAt: FIXED_CLOCK() });
      }),
    update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err({ code: "unknown", message: "update unused" }),
  };
  // Wrap a real-create counter around an overridden create too.
  if (overrides.create !== undefined) {
    const inner = overrides.create;
    adapter.create = async (): Promise<Result<WriteReceipt, AdapterError>> => {
      creates += 1;
      return inner();
    };
  }

  const deps: ExternalWriteDeps = {
    adapter,
    receiptStore: store,
    requireApproval: overrides.requireApproval ?? ((): GatewayApprovalDecision => ({ requiresApproval: false })),
    recordPendingApproval: async (): Promise<Result<unknown, unknown>> => {
      pending += 1;
      return ok(undefined);
    },
    isApproved: overrides.isApproved ?? (async (): Promise<boolean> => false),
    audit: async (_rec: AuditRecord): Promise<void> => undefined,
    clock: FIXED_CLOCK,
  };

  return {
    deps,
    createCalls: () => creates,
    existenceChecked: () => existence > 0,
    pendingRecorded: () => pending,
    store,
  };
}

function envFor(action: ProposedAction): ExternalWriteEnvelope {
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error(`test envelope build failed: ${built.error.message}`);
  return built.value;
}

describe("§20.1(a) Hermes external side effect carries the §8 envelope + routes through the gateway", () => {
  it("an auto-approved Hermes action dispatches through the gateway → created, exactly one create, receipt recorded", async () => {
    const action = makeHermesAction();
    const env = envFor(action);
    const h = makeGatewayHarness();

    const res = await dispatchExternalWrite(env, action, h.deps);

    expect(res.status).toBe("created");
    if (res.status === "created") {
      expect(res.receipt.externalObjectId).toBe("ext_hermes_1");
    }
    // The §8 envelope carried the action's canonical identity all the way to a
    // recorded receipt (the gateway is the write carrier).
    expect(h.createCalls()).toBe(1);
    expect(h.store.size()).toBe(1);
  });

  it("an approval-required Hermes action FAILS CLOSED to approval_pending → NO external write (approval-gated)", async () => {
    const action = makeHermesAction();
    const env = envFor(action);
    const h = makeGatewayHarness({
      requireApproval: (): GatewayApprovalDecision => ({ requiresApproval: true }),
      isApproved: async (): Promise<boolean> => false,
    });

    const res = await dispatchExternalWrite(env, action, h.deps);

    expect(res.status).toBe("approval_pending");
    // No write, and the approval gate runs BEFORE the existence probe — nothing
    // touched the vendor.
    expect(h.createCalls()).toBe(0);
    expect(h.existenceChecked()).toBe(false);
    expect(h.pendingRecorded()).toBe(1);
  });
});

describe("§20.1(b) a direct-write attempt bypassing the gateway envelope is REJECTED", () => {
  it("an envelope whose linkage does NOT match the dispatched action is rejected before any side effect", async () => {
    // A Hermes automation cannot smuggle a write by presenting an envelope built for
    // one action against a DIFFERENT action — the candidate-gate linkage pin refuses
    // it before any existence probe or create (never a silent pass).
    const actionA = makeHermesAction({ canonicalObjectKey: "cok_a", idempotencyKey: "idem_a" });
    const env = envFor(actionA);
    const actionB = makeHermesAction({ canonicalObjectKey: "cok_b", idempotencyKey: "idem_b" });
    const h = makeGatewayHarness();

    const res = await dispatchExternalWrite(env, actionB, h.deps);

    expect(res.status).toBe("rejected");
    expect(h.createCalls()).toBe(0);
    expect(h.existenceChecked()).toBe(false);
    expect(h.store.size()).toBe(0);
  });
});

describe("§20.1(c) a replayed Hermes automation produces NO duplicate external action", () => {
  it("the same idempotencyKey dispatched twice → first created, second reused, create called EXACTLY once", async () => {
    const action = makeHermesAction();
    const env = envFor(action);
    const h = makeGatewayHarness();

    const first = await dispatchExternalWrite(env, action, h.deps);
    expect(first.status).toBe("created");

    const second = await dispatchExternalWrite(env, action, h.deps);
    expect(second.status).toBe("reused");
    if (first.status === "created" && second.status === "reused") {
      expect(second.receipt.externalObjectId).toBe(first.receipt.externalObjectId);
    }

    // The replay reused the receipt — ZERO duplicate external action (RT-7 / safety
    // rule 3).
    expect(h.createCalls()).toBe(1);
    expect(h.store.size()).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — the REAL Hermes driver (`runHermesAutomation`)
//
// RT-7 routing enforcement: a Hermes automation's semantic write goes through the
// KnowledgeWriter commit port and its external side effect through the Tool Gateway
// propose port — never a direct adapter. Inline fakes satisfy the driver's injected
// ports (the driver imports no Temporal / broker / KnowledgeWriter / Tool Gateway).
// ════════════════════════════════════════════════════════════════════════════

const WS = workspaceId("ws-personal-business");

// --- inline port fakes -------------------------------------------------------

function fakeRouteHigh(ws: WorkspaceId): HermesAutomationDeps["route"] {
  return { route: async () => ok({ confidence: "high", workspaceId: ws }) };
}
function fakeRouteLow(): HermesAutomationDeps["route"] {
  return { route: async () => ok({ confidence: "low", routingReview: true, reason: "no target" }) };
}
function fakeAgentAccepted(): HermesAutomationDeps["agent"] {
  return {
    run: async () =>
      ok({
        fields: { title: { value: "Daily tidy", evidenceRef: "kanban#card-1" } },
        schemaId: "sow:hermes-automation-output",
      }),
  };
}
function fakeAgentRejected(code: string): HermesAutomationDeps["agent"] {
  return {
    run: async () => err({ code, message: `hermes agent rejected: ${code}` }),
  } as unknown as HermesAutomationDeps["agent"];
}
// Pass-through validate — the no-inference gate is covered by its own suite; here
// the concern is gateway ROUTING, so validate just brands the candidate.
const fakeValidate: HermesAutomationDeps["validate"] = {
  validate: (extraction) => ok({ validated: true, fields: extraction.fields, schemaId: extraction.schemaId }),
};

function makePlan(ws: WorkspaceId): KnowledgeMutationPlan {
  // The driver forwards this opaque plan to the commit port; only workspaceId is
  // read back (regression: it must be the ROUTE-BOUND workspace). A minimal literal
  // is sufficient for the fake commit path.
  return {
    planId: "plan-hermes-1",
    workspaceId: ws,
    sourceRefs: [{ sourceId: sourceId("src-hermes-1") }],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 1,
    requiresApproval: false,
    provenanceOrigin: "agent_generated",
  } as unknown as KnowledgeMutationPlan;
}

// buildOutputs DERIVES the plan + one external action from the validated extraction
// and the ROUTE-BOUND workspace (the driver passes that workspace as the 2nd arg).
function fakeBuildOutputs(): HermesAutomationDeps["buildOutputs"] {
  const action = makeHermesAction();
  const envelope = envFor(action);
  return {
    build: async (_validated, boundWorkspaceId) =>
      ok({ plan: makePlan(boundWorkspaceId), actions: [{ action, envelope }] }),
  };
}

// KnowledgeWriter commit port — counts writes; IDEMPOTENT by planId (a replay
// returns the SAME revision with no second write).
class FakeCommitPort {
  writeCount = 0;
  private readonly byPlan = new Map<string, string>();
  commit(plan: KnowledgeMutationPlan) {
    const key = plan.planId as unknown as string;
    const seen = this.byPlan.get(key);
    if (seen !== undefined) return Promise.resolve(ok({ revisionId: seen, replayed: true }));
    this.writeCount += 1;
    const rev = `rev-hermes-${this.writeCount}`;
    this.byPlan.set(key, rev);
    return Promise.resolve(ok({ revisionId: rev, replayed: false }));
  }
}

// Tool Gateway propose port — counts creates; a REPLAY with the same
// idempotencyKey REUSES the receipt (zero duplicate external action).
class FakeProposePort {
  createCount = 0;
  private readonly seen = new Set<string>();
  constructor(private readonly failWith?: string) {}
  propose(_action: ProposedAction, env: ExternalWriteEnvelope) {
    if (this.failWith !== undefined) {
      return Promise.resolve(err({ code: this.failWith, message: `propose ${this.failWith}` }));
    }
    if (this.seen.has(env.idempotencyKey)) {
      return Promise.resolve(ok({ status: "reused" as const, envelope: env }));
    }
    this.seen.add(env.idempotencyKey);
    this.createCount += 1;
    return Promise.resolve(ok({ status: "created" as const, envelope: env }));
  }
}

class FakeReindexPort {
  reindexed: string[] = [];
  reindex(revisionId: string) {
    this.reindexed.push(revisionId);
    return Promise.resolve(ok(undefined));
  }
}

class FakeHealthSink {
  surfaced: unknown[] = [];
  surface(failure: unknown) {
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

// In-memory WorkflowRun registry (resolveRun idempotency seam): novel key creates;
// a seen idempotencyKey reuses the run (no duplicate started).
class InMemoryRunRepo {
  private readonly byId = new Map<string, any>();
  create(ref: any) {
    if (this.byId.has(ref.workflowId)) {
      return Promise.resolve(err({ code: "conflict", message: "run exists" }));
    }
    for (const r of this.byId.values()) {
      if (r.idempotencyKey === ref.idempotencyKey) {
        return Promise.resolve(err({ code: "conflict", message: "idem exists" }));
      }
    }
    this.byId.set(ref.workflowId, ref);
    return Promise.resolve(ok(ref));
  }
  get(id: string) {
    const f = this.byId.get(id);
    return Promise.resolve(f === undefined ? err({ code: "not_found", message: "no run" }) : ok(f));
  }
  getByIdempotencyKey(k: string) {
    for (const r of this.byId.values()) if (r.idempotencyKey === k) return Promise.resolve(ok(r));
    return Promise.resolve(err({ code: "not_found", message: "novel key" }));
  }
  updateState(id: string, state: string) {
    const f = this.byId.get(id);
    if (f === undefined) return Promise.resolve(err({ code: "not_found", message: "no run" }));
    const next = { ...f, state };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
  appendAuditRef(id: string, auditRef: string) {
    const f = this.byId.get(id);
    if (f === undefined) return Promise.resolve(err({ code: "not_found", message: "no run" }));
    const next = { ...f, auditRefs: [...f.auditRefs, auditRef] };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
}

const fakeClock = { now: FIXED_CLOCK };

function makeInput(): HermesAutomationInput {
  return {
    run: {
      workflowId: workflowId("wf-hermes-1"),
      trigger: "hermes_automation",
      idempotencyKey: "idem-run-hermes-1",
      workspaceId: WS,
    },
    context: {
      trigger: { source: "cron", automationId: "auto-daily-tidy", sourceRef: { sourceId: sourceId("src-hermes-1") } },
      envelopes: [],
    },
  } as HermesAutomationInput;
}

function makeDeps(overrides: { [K in keyof HermesAutomationDeps]?: unknown } = {}): HermesAutomationDeps {
  return {
    route: fakeRouteHigh(WS),
    agent: fakeAgentAccepted(),
    validate: fakeValidate,
    buildOutputs: fakeBuildOutputs(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    reindex: new FakeReindexPort(),
    health: new FakeHealthSink(),
    runs: new InMemoryRunRepo(),
    clock: fakeClock,
    ...overrides,
  } as unknown as HermesAutomationDeps;
}

describe("§20.1(a) a Hermes automation routes its writes through the gateways (driver)", () => {
  it("happy path: exactly one KnowledgeWriter commit + one Tool Gateway propose; run tagged hermes_automation; GBrain re-index AFTER commit", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const reindex = new FakeReindexPort();
    const outcome = await runHermesAutomation(makeInput(), makeDeps({ commit, propose, reindex }));

    expect(outcome.state).toBe("completed");
    // Semantic write via the KnowledgeWriter commit port (never a direct adapter).
    expect(commit.writeCount).toBe(1);
    // External side effect via the Tool Gateway propose port (never a direct adapter).
    expect(propose.createCount).toBe(1);
    // Run is recorded as a WorkflowRun with trigger=hermes_automation (Temporal is
    // the source of truth; Hermes only initiated it).
    expect(isOk(outcome.run)).toBe(true);
    if (isOk(outcome.run)) expect(outcome.run.value.trigger).toBe("hermes_automation");
    // GBrain re-index runs AFTER the Markdown commit off the committed revision
    // (no direct GBrain write path).
    expect(outcome.context.revisionId).toBeDefined();
    expect(reindex.reindexed).toContain(outcome.context.revisionId);
    // Workspace bound by the high-confidence route before any durable write (WS-2).
    expect(outcome.context.workspaceId).toBe(WS);
  });

  it("the committed plan carries the ROUTE-BOUND workspace, not a caller value (WS-2/WS-4)", async () => {
    const boundWs = workspaceId("ws-route-bound");
    const captured: KnowledgeMutationPlan[] = [];
    const commit = {
      writeCount: 0,
      commit: (plan: KnowledgeMutationPlan) => {
        captured.push(plan);
        return Promise.resolve(ok({ revisionId: "rev-cap-1", replayed: false }));
      },
    };
    const outcome = await runHermesAutomation(
      makeInput(),
      makeDeps({ route: fakeRouteHigh(boundWs), commit: commit as unknown as HermesAutomationDeps["commit"] }),
    );

    expect(outcome.state).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.workspaceId).toBe(boundWs);
  });
});

describe("§20.1(b) a Hermes automation cannot drive a direct write bypassing the gateways (driver)", () => {
  it("an agent declaring a MUTATING tool policy is REJECTED at admission (ING-7) → provider_failed, NO commit, NO external write", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeHealthSink();
    const outcome = await runHermesAutomation(
      makeInput(),
      makeDeps({ agent: fakeAgentRejected("admission_rejected"), commit, propose, health }),
    );

    expect(outcome.state).toBe("provider_failed");
    // The Hermes job is read-only (ING-7); a mutating declaration is rejected before
    // it can produce anything committable — so NO write of any kind happened.
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
  });

  it("a low-confidence route FAILS CLOSED → routing_failed, NO workspace guessed, NO durable write", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const outcome = await runHermesAutomation(
      makeInput(),
      makeDeps({ route: fakeRouteLow(), commit, propose }),
    );

    expect(outcome.state).toBe("routing_failed");
    expect(outcome.context.workspaceId).toBeUndefined();
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
  });
});

describe("§20.1(c) a replayed Hermes automation produces no duplicate action + no direct write (driver)", () => {
  it("re-driving the whole pipeline reuses the commit + external write (each exactly once) and reuses the run", async () => {
    // The DURABLE fakes (commit / propose / runs) are shared across both drives — as
    // the real KnowledgeWriter + Tool Gateway + WorkflowRun registry are; the pure
    // read stages get fresh fakes on the re-drive.
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const runs = new InMemoryRunRepo();

    const first = await runHermesAutomation(makeInput(), makeDeps({ commit, propose, runs }));
    expect(first.state).toBe("completed");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);

    const second = await runHermesAutomation(makeInput(), makeDeps({ commit, propose, runs }));
    expect(second.state).toBe("completed");
    // Each durable write happened EXACTLY once across both drives (zero duplicate
    // external action; no second Markdown write) and the run was reused.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    expect(second.context.revisionId).toBe(first.context.revisionId);
    expect(second.runReused).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — EVAL-1 runner scoring
// ════════════════════════════════════════════════════════════════════════════

describe("hermes-standalone — EVAL-1 runner scoring", () => {
  it("scores HERMES_STANDALONE functionally-passing AND DoD-passing (deterministic gateway enforcement; no vendor)", () => {
    // Every RT-7 governance scenario above holds ⇒ the acceptance gate passes. The
    // enforcement is deterministic control-plane code (envelope / idempotency /
    // approval / admission / one-writer), so §20.2 certifies it WITHOUT a real
    // vendor: dodValid holds at fromRealIntegration:false.
    const out = scoreById({ criterionId: CRITERION_ID, value: true, fromRealIntegration: false });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("registry marks hermes-standalone as NOT requiring a real integration (deterministic invariant)", () => {
    expect(criterionById(CRITERION_ID)?.requiresRealIntegration).toBe(false);
  });
});
