// @sow/integrations — slice 6.5 WRITE OUTBOX: replay-safe drain (test-first).
//
// On reconnect/wake, `drainOutbox` lists due entries (OutboxRepository.listDue)
// and re-drives each through the SAME 6.2 dispatchExternalWrite pipeline — so the
// mandatory pre-write existence check + stored-receipt replay gate make a re-driven
// held write produce NO duplicate external action (§20.1). The drain:
//   • REPLAY-SAFE — an entry whose receipt already exists ⇒ reused; adapter.create
//     is NEVER called a second time.
//   • CRASH MID-DRAIN — re-running the drain over a partially-drained set
//     double-applies nothing (an already-receipt_recorded entry is a no-op).
//   • BOUNDED BACKOFF — a still-unreachable entry is re-held with a bumped attempt
//     count + a nextAttemptAt computed from the injected backoff (never spins).
//   • Returns { drained, reused, held, failed, skipped } counts.
//   • Is callable as the §9 workflow entry-point (a clean deps-injected signature).
//   • SINGLE-WORKSPACE-SCOPED (task 24.50) — see the last describe block: every
//     `DrainDeps` caller now states the workspace its bound posture resolves for,
//     and an entry from any OTHER workspace is skipped rather than mis-evaluated.
import { describe, it, expect } from "vitest";
import type { Result, WriteReceipt, ProposedAction } from "@sow/contracts";
import { ok, err, isOk, defaultWorkspace } from "@sow/contracts";
import { drainOutbox } from "../src/tools/outbox-drain";
import { holdWrite } from "../src/tools/outbox";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import { requiresApproval, resolveWorkspacePolicy, isAllow } from "@sow/policy";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import {
  InMemoryOutbox,
  InMemoryReceiptStore,
  makeEnvelope,
  makeProposedAction,
  makeWriteReceipt,
  makeReceiptRecord,
  makeOutboxEntry,
} from "./support/fakes";

const clock = (): string => "2026-07-01T00:00:00.000Z";
const backoffCfg = { baseMs: 1000, maxMs: 60000, maxAttempts: 5 };

// A configurable fake adapter that records how many times create() is invoked.
function makeAdapter(opts: {
  existence?: Result<ExistingObject | null, AdapterError>;
  create?: Result<WriteReceipt, AdapterError>;
  createCalls: { n: number };
}): TargetWriteAdapter {
  return {
    targetSystem: "drive",
    async existenceCheck(): Promise<Result<ExistingObject | null, AdapterError>> {
      return opts.existence ?? ok(null);
    },
    async create(): Promise<Result<WriteReceipt, AdapterError>> {
      opts.createCalls.n += 1;
      return opts.create ?? ok(makeWriteReceipt({ externalObjectId: "ext_created" }));
    },
    async update(): Promise<Result<WriteReceipt, AdapterError>> {
      return ok(makeWriteReceipt());
    },
  };
}

// Build the gateway deps the drain re-drives each entry through. Auto-allow (no
// approval) so the drain reaches the existence/create stage.
function makeGatewayDeps(
  adapter: TargetWriteAdapter,
  receiptStore: InMemoryReceiptStore,
): ExternalWriteDeps {
  return {
    adapter,
    receiptStore,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock,
  };
}

async function seedHeld(
  outbox: InMemoryOutbox,
  idempotencyKey: string,
  outboxId: string,
): Promise<void> {
  await holdWrite(
    {
      env: makeEnvelope({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}` }),
      action: makeProposedAction({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}` }),
      reason: "unreachable",
      workspaceId: "employer-work",
    },
    outbox,
    { clock, outboxId: () => outboxId },
  );
}

describe("drainOutbox — reconnect drain", () => {
  it("drains a held entry back online: create is issued once, receipt recorded, entry terminal", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_drain", "outbox_drain");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(createCalls.n).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.reused).toBe(0);

    // The entry advanced to a terminal receipt_recorded status.
    const entry = await outbox.get("outbox_drain");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
    expect(entry.value.writeReceipt).toBeDefined();
  });

  it("REPLAY-SAFE: draining an entry whose receipt already exists → reused, adapter.create NEVER called", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_replay", "outbox_replay");

    // A receipt already exists under this idempotencyKey (a prior successful write).
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_replay",
        canonicalObjectKey: "cok_idem_replay",
        receipt: makeWriteReceipt({ externalObjectId: "ext_prior" }),
      }),
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(createCalls.n).toBe(0); // NO duplicate external action
    expect(result.reused).toBe(1);
    expect(result.drained).toBe(0);

    const entry = await outbox.get("outbox_replay");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });

  it("CRASH MID-DRAIN: re-running drain over a partially-drained set double-applies nothing", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_c1", "outbox_c1");
    await seedHeld(outbox, "idem_c2", "outbox_c2");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const deps = {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    };

    // First drain: both go online, 2 creates.
    const first = await drainOutbox(outbox, deps);
    expect(createCalls.n).toBe(2);
    expect(first.drained).toBe(2);

    // Simulate a crash-and-restart: re-run the SAME drain. The two entries are now
    // terminal (receipt_recorded) → listDue excludes them → zero re-drive, zero
    // new creates. Nothing is double-applied.
    const second = await drainOutbox(outbox, deps);
    expect(createCalls.n).toBe(2); // unchanged
    expect(second.drained).toBe(0);
    expect(second.reused).toBe(0);
  });

  it("CRASH MID-DRAIN (receipt landed, entry not yet advanced): re-drive reuses receipt, no second create", async () => {
    // Model a crash AFTER the external create + receipt persist but BEFORE the
    // outbox entry was marked terminal. The entry is still due; re-driving it must
    // hit the stored receipt (replay gate) → reused, never a second create.
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_partial", "outbox_partial");
    // Receipt persisted under the entry's idempotencyKey (the create already ran).
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_partial",
        canonicalObjectKey: "cok_idem_partial",
        receipt: makeWriteReceipt({ externalObjectId: "ext_committed" }),
      }),
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(createCalls.n).toBe(0);
    expect(result.reused).toBe(1);
    const entry = await outbox.get("outbox_partial");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });

  it("STILL UNREACHABLE: a held entry that stays down is re-held (non-terminal) with bumped attempts + backoff, never dropped", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_down", "outbox_down");

    const createCalls = { n: 0 };
    // existenceCheck faults 'unreachable' → dispatch returns { status:'held' }.
    const adapter = makeAdapter({
      existence: err<AdapterError>({ code: "unreachable", message: "still down" }),
      createCalls,
    });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(createCalls.n).toBe(0);
    expect(result.held).toBe(1);
    expect(result.drained).toBe(0);

    const entry = await outbox.get("outbox_down");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    // Still non-terminal (never expired/dropped), attempts bumped, backoff set.
    expect(["proposed", "retry_queued"]).toContain(entry.value.status);
    expect(entry.value.attempts).toBe(1);
    expect(entry.value.nextAttemptAt).toBeDefined();
    // Still due on a future listDue (once its backoff elapses) — not silently lost.
    const due = await outbox.listDue("2026-07-01T10:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (!isOk(due)) return;
    expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_down");
  });

  it("REJECTED: a vendor-rejected re-drive marks the entry terminal-rejected (typed, never a silent drop)", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_rej", "outbox_rej");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({
      create: err<AdapterError>({ code: "rejected", message: "vendor refused" }),
      createCalls,
    });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(result.failed).toBe(1);
    const entry = await outbox.get("outbox_rej");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("rejected");
  });

  // task 24.15 (§8/§16): the redrive reconstruction hardcoded approvalPolicy as a
  // fixed "queued" literal, over-gating an entry held for an UNRELATED transport
  // failure whose original action was auto-eligible. Fixed by persisting the
  // original approvalPolicy (outbox.test.ts pins the write half) and reading it
  // back here (`rebuildAction`) instead of the neutral stand-in.
  //
  // WHAT THIS FAKE IS AND ISN'T: it mirrors the ONE gating condition
  // `@sow/policy`'s real `requiresApproval` uses that this slice's fix can affect
  // (`action.approvalPolicy === "auto_private"`) — narrower than the full
  // 5-conjunct predicate ON PURPOSE. The predicate's own logic (including the
  // other 4 conjuncts: resolved-posture, dataOwner, target allow-list, visibility)
  // is exhaustively pinned in `packages/policy/test/approval-policy.test.ts`; this
  // slice's job is proving `rebuildAction`/`holdWrite` correctly THREAD the
  // persisted field to that predicate, not re-verifying the predicate itself. The
  // fake is NOT the authority on gating — packages/policy is. It agrees with the
  // real predicate on the fixtures below (targetSystem: "calendar", the sole
  // AUTO_ALLOW_ELIGIBLE_TARGETS member today, and a non-employer workspaceId) —
  // if that target set ever grows past one member, the fake's blindness to
  // targetSystem becomes a real gap; this is recorded, not guarded against.
  function makeApprovalPolicyGatedDeps(
    adapter: TargetWriteAdapter,
    receiptStore: InMemoryReceiptStore,
  ): ExternalWriteDeps {
    return {
      adapter,
      receiptStore,
      requireApproval: (action) => ({ requiresApproval: action.approvalPolicy !== "auto_private" }),
      recordPendingApproval: async () => ok(undefined),
      isApproved: async () => false, // never pre-approved — a gated entry must surface as pending
      audit: async () => undefined,
      clock,
    };
  }

  it("redrive_restores_auto_eligible_entry_without_approval_gate — an auto_private entry redrives without approval", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await holdWrite(
      {
        // targetSystem: "calendar" + a non-employer workspaceId — see the fake's
        // own docblock above for why the fixture must agree with the real
        // predicate's other conjuncts, not just the one this fake reads.
        env: makeEnvelope({
          idempotencyKey: "idem_auto",
          canonicalObjectKey: "cok_auto",
          targetSystem: "calendar",
        }),
        action: makeProposedAction({
          idempotencyKey: "idem_auto",
          canonicalObjectKey: "cok_auto",
          targetSystem: "calendar",
          approvalPolicy: "auto_private",
        }),
        reason: "unreachable",
        workspaceId: "personal-life",
      },
      outbox,
      { clock, outboxId: () => "outbox_auto" },
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeApprovalPolicyGatedDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "personal-life",
    });

    // Drained straight through — no approval_pending detour, no held bucket.
    expect(createCalls.n).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.held).toBe(0);
  });

  it("redrive_still_gates_an_action_that_genuinely_needed_approval — a non-auto_private entry still requires approval on redrive", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await holdWrite(
      {
        // makeProposedAction defaults approvalPolicy to "requires_approval".
        env: makeEnvelope({ idempotencyKey: "idem_needs", canonicalObjectKey: "cok_needs" }),
        action: makeProposedAction({ idempotencyKey: "idem_needs", canonicalObjectKey: "cok_needs" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_needs" },
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeApprovalPolicyGatedDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    // Regression pin: the fix must not over-correct into under-gating (rule-3).
    expect(createCalls.n).toBe(0);
    expect(result.held).toBe(1);
    const entry = await outbox.get("outbox_needs");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("proposed");
  });

  it("redrive_gates_a_pre_migration_entry_with_no_persisted_approval_policy — an absent approvalPolicy fails safe (gate, never skip)", async () => {
    // Simulates a row written BEFORE this migration: enqueued directly (bypassing
    // holdWrite) with no approvalPolicy at all — the field is optional/nullable.
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await outbox.enqueue(
      makeOutboxEntry({
        outboxId: "outbox_legacy",
        idempotencyKey: "idem_legacy",
        canonicalObjectKey: "cok_legacy",
        status: "retry_queued",
        // approvalPolicy intentionally omitted.
      }),
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeApprovalPolicyGatedDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      // makeOutboxEntry defaults workspaceId to "employer-work" — see fakes.ts.
      workspaceId: "employer-work",
    });

    // Fail-safe default: an absent original policy must gate, never auto-allow.
    expect(createCalls.n).toBe(0);
    expect(result.held).toBe(1);
  });

  it("returns { drained, reused, held, failed, skipped } and drives entries through the SAME dispatch pipeline", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_mix_ok", "outbox_mix_ok");
    await seedHeld(outbox, "idem_mix_reused", "outbox_mix_reused");
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_mix_reused",
        canonicalObjectKey: "cok_idem_mix_reused",
      }),
    );

    const createCalls = { n: 0 };
    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async () => ok(null),
      create: async () => {
        createCalls.n += 1;
        return ok(makeWriteReceipt({ externalObjectId: "ext_ok" }));
      },
      update: async () => ok(makeWriteReceipt()),
    };

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(result.drained).toBe(1);
    expect(result.reused).toBe(1);
    expect(result.held).toBe(0);
    expect(result.failed).toBe(0);
    // REGRESSION PIN (task 24.50): an all-in-workspace batch skips nothing — the
    // four pre-existing counters are unaffected by the new counter's existence.
    expect(result.skipped).toBe(0);
    expect(createCalls.n).toBe(1); // only the novel one hit create
  });
});

// task 24.50 (§8/§9/§20.1, safety rule 4): `rebuildAction`/`rebuildEnvelope`
// carried NO workspaceId, and `listDue` does not filter by workspace — so a drain
// pass over a MIXED-WORKSPACE outbox evaluated every entry against ONE bound
// posture (`deps.gatewayDeps.requireApproval`, captured once at bind time —
// apps/worker/src/composition/backends.ts:567's "resolved workspace posture is
// captured at bind time"). An entry from workspace A, redriven under workspace
// B's posture, could be auto-allowed (or wrongly gated) by the WRONG workspace's
// rules — safety rule 4's "no raw cross-workspace retrieval" / "0 raw
// Employer-Work content surfaces in Personal outputs absent an approved link" is
// about DATA; this is the analogous hole on the WRITE side: a workspace's own
// posture governing a write it never actually owns.
//
// Fix is STRUCTURAL, not a threading fix: `DrainDeps.workspaceId` (required) now
// names the workspace `gatewayDeps` was bound for, and `drainOutbox` skips (never
// evaluates, never mutates) any due entry whose OWN `workspaceId` disagrees —
// making a cross-workspace mix unrepresentable at the drain rather than trusting
// every caller to thread a workspace argument through
// `ExternalWriteDeps.requireApproval` (out of this package's ownership — see the
// brief). A mixed outbox is drained by ONE PASS PER WORKSPACE.
//
// This suite binds the REAL `@sow/policy` predicate (`requiresApproval` +
// `resolveWorkspacePolicy`), wrapped exactly as the composition root's
// `makeRequireApproval` does — not a fake that merely happens to agree with it.
describe("drainOutbox — cross-workspace redrive is structurally unrepresentable (task 24.50)", () => {
  // A real, schema-validated Workspace (§3/§6) — NOT a hand-rolled policy object.
  // `defaultWorkspace` (personal_life, no override) yields the exact posture the
  // real `requiresApproval` auto-allow narrow-allow-list requires alongside the
  // action's own two conjuncts: dataOwner "user", defaultVisibility "isolated"
  // (packages/policy/src/approval-policy.ts:169-174).
  function resolvedPolicyFor(workspaceId: string): ResolvedWorkspacePolicy {
    const workspace = defaultWorkspace({
      id: workspaceId,
      name: `workspace ${workspaceId}`,
      type: "personal_life",
      markdownRepoPath: `/workspaces/${workspaceId}`,
      gbrainBrainId: `brain_${workspaceId}`,
    });
    return resolveWorkspacePolicy(workspace);
  }

  // Wraps @sow/policy's REAL `requiresApproval` exactly as the composition root
  // does (apps/worker/src/composition/backends.ts:562-567's `makeRequireApproval`)
  // — a policy DENY fails closed to requiresApproval:true, never an auto-apply.
  function makeRealRequireApproval(
    resolved: ResolvedWorkspacePolicy,
  ): (action: ProposedAction) => { requiresApproval: boolean; card?: unknown } {
    return (action: ProposedAction) => {
      const d = requiresApproval(action, resolved);
      return isAllow(d) ? d.value : { requiresApproval: true };
    };
  }

  // `targetSystem: "calendar"` is the SOLE AUTO_ALLOW_ELIGIBLE target and
  // `approvalPolicy: "auto_private"` the SOLE auto-eligible token — combined with
  // `resolvedPolicyFor`'s posture, the REAL `requiresApproval` auto-allows this
  // fixture with NO approval detour, so a wrongly-bound pass would dispatch it
  // straight through rather than merely mis-classifying it into a held/approval
  // bucket — the sharpest possible demonstration of the mis-binding.
  async function seedAutoEligible(
    outbox: InMemoryOutbox,
    workspaceId: string,
    idempotencyKey: string,
    outboxId: string,
  ): Promise<void> {
    await holdWrite(
      {
        env: makeEnvelope({
          idempotencyKey,
          canonicalObjectKey: `cok_${idempotencyKey}`,
          targetSystem: "calendar",
        }),
        action: makeProposedAction({
          idempotencyKey,
          canonicalObjectKey: `cok_${idempotencyKey}`,
          targetSystem: "calendar",
          approvalPolicy: "auto_private",
        }),
        reason: "unreachable",
        workspaceId,
      },
      outbox,
      { clock, outboxId: () => outboxId },
    );
  }

  it("MIS-BOUND POSTURE: an entry from a DIFFERENT workspace than the bound posture is skipped — zero adapter.create, zero store mutation, no attempts bump", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedAutoEligible(outbox, "ws-employer", "idem_mixed", "outbox_mixed");

    const before = await outbox.get("outbox_mixed");
    expect(isOk(before)).toBe(true);
    if (!isOk(before)) return;

    const resolved = resolvedPolicyFor("ws-personal");
    // The mis-binding is REAL, not merely asserted by construction (the exact gap
    // task 24.15 left open): the entry's own workspace differs from the posture
    // this drain pass is bound to.
    expect(resolved.workspaceId).not.toBe(before.value.workspaceId);

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const gatewayDeps: ExternalWriteDeps = {
      adapter,
      receiptStore,
      requireApproval: makeRealRequireApproval(resolved),
      recordPendingApproval: async () => ok(undefined),
      isApproved: async () => true,
      audit: async () => undefined,
      clock,
    };

    const result = await drainOutbox(outbox, {
      gatewayDeps,
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "ws-personal",
    });

    // Never reached the (mis-bound) real predicate or the gateway at all — this
    // is what "structurally unrepresentable" means: no dispatch, not a dispatch
    // that happens to come back gated.
    expect(createCalls.n).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.drained).toBe(0);
    expect(result.reused).toBe(0);
    expect(result.held).toBe(0);
    expect(result.failed).toBe(0);

    // Untouched: a skip is not an attempt and must not consume backoff, so a
    // later CORRECTLY-scoped pass still drains it exactly as if this pass never
    // ran.
    const after = await outbox.get("outbox_mixed");
    expect(isOk(after)).toBe(true);
    if (!isOk(after)) return;
    expect(after.value.status).toBe(before.value.status);
    expect(after.value.attempts).toBe(before.value.attempts);
    expect(after.value.attempts).toBe(0);
    expect(after.value.nextAttemptAt).toBeUndefined();
    expect(after.value.updatedAt).toBe(before.value.updatedAt);
  });

  it("POSITIVE CONTROL: a matching-workspace entry under the SAME real predicate DOES dispatch and drains", async () => {
    // Without this control, the MIS-BOUND test above would pass equally for a
    // drain that skips EVERYTHING regardless of workspace — a construction-side
    // assertion alone cannot distinguish a mis-bound posture from a correctly-
    // bound one (precisely why 24.15's construction-side check was insufficient).
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedAutoEligible(outbox, "ws-personal", "idem_matched", "outbox_matched");

    const resolved = resolvedPolicyFor("ws-personal");
    expect(resolved.workspaceId).toBe("ws-personal");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const gatewayDeps: ExternalWriteDeps = {
      adapter,
      receiptStore,
      requireApproval: makeRealRequireApproval(resolved),
      recordPendingApproval: async () => ok(undefined),
      isApproved: async () => true,
      audit: async () => undefined,
      clock,
    };

    const result = await drainOutbox(outbox, {
      gatewayDeps,
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "ws-personal",
    });

    expect(createCalls.n).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.drained).toBe(1);

    const entry = await outbox.get("outbox_matched");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });
});

// F4 (this round) — the drain's blindness to the closed adapter code, seen from the
// consumer end. `applyOutcome` switches on `outcome.status` ONLY; `adapterCode`
// appears nowhere in outbox-drain.ts. That is CORRECT and stays correct — the fix
// belongs at the SOURCE (the gateway's existence-fault arm), because three other
// consumers (envelopeReuse.ts, proposeExternalActions.ts, approvalFlow.ts) read the
// same wrong `status` and a local patch here would fix one of four.
//
// What these pins guard: a PERMANENT existence-probe fault must reach the drain as
// a terminal status and go terminal on the FIRST pass. Before the gateway fix it
// arrived as `held`, and since `computeNextAttemptAt` never expires an entry (an
// EXHAUSTED backoff still returns a bounded `maxMs`), the drain re-held it pass
// after pass, forever, without ever calling create.
describe("drainOutbox — a PERMANENT existence-probe fault is terminal on the first pass, never an infinite re-hold", () => {
  const permanent: ReadonlyArray<AdapterError["code"]> = ["not_found", "rejected", "unknown"];

  for (const code of permanent) {
    it(`an existence-probe '${code}' fault goes terminal (failed) on pass 1 — no re-hold, no create`, async () => {
      const outbox = new InMemoryOutbox();
      const receiptStore = new InMemoryReceiptStore();
      await seedHeld(outbox, `idem_perm_${code}`, `outbox_perm_${code}`);

      const createCalls = { n: 0 };
      const adapter = makeAdapter({
        existence: err<AdapterError>({ code, message: "permanent vendor fault" }),
        createCalls,
      });
      const result = await drainOutbox(outbox, {
        gatewayDeps: makeGatewayDeps(adapter, receiptStore),
        now: clock(),
        limit: 100,
        backoffCfg,
        clock,
        workspaceId: "employer-work",
      });

      expect(result.failed).toBe(1);
      expect(result.held).toBe(0);
      // Fail-closed is preserved: an unconfirmed existence probe still never creates.
      expect(createCalls.n).toBe(0);

      const entry = await outbox.get(`outbox_perm_${code}`);
      expect(isOk(entry)).toBe(true);
      if (!isOk(entry)) return;
      expect(entry.value.status).toBe("rejected");
      // Terminal ⇒ excluded from every future listDue: the retry loop is CLOSED.
      const due = await outbox.listDue("2100-01-01T00:00:00.000Z", 100);
      expect(isOk(due)).toBe(true);
      if (!isOk(due)) return;
      expect(due.value.map((e) => e.idempotencyKey)).not.toContain(`idem_perm_${code}`);
    });
  }

  it("REGRESSION PIN: a genuinely unreachable probe is STILL re-held, not terminalised", async () => {
    // The fix must not over-correct. `unreachable` is the one adapter code that
    // means "the transport could not reach the vendor AT ALL" — the outbox-hold
    // signal the whole 6.5 path exists to serve.
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_still_down", "outbox_still_down");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({
      existence: err<AdapterError>({ code: "unreachable", message: "still down" }),
      createCalls,
    });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      workspaceId: "employer-work",
    });

    expect(result.held).toBe(1);
    expect(result.failed).toBe(0);
    expect(createCalls.n).toBe(0);
    const due = await outbox.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (isOk(due)) expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_still_down");
  });
});
