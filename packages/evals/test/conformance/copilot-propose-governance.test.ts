// spec(§13.10a Copilot write-via-Approvals / §5 four hard denials / safety rules 3·4·6) — Copilot PROPOSE-PATH
// GOVERNANCE conformance (runbook copilot-propose-go-live.md §3, flip-procedure step 3).
//
// The propose-path half of the Copilot governance battery (sibling: `copilot-governance.test.ts`, the Q&A
// read-path). A DETERMINISTIC, EGRESS-FREE battery over the COMMITTED worker functions — NO real model /
// `query()` / boot / network. It pins the §13.10a "write-via-Approvals" invariants end-to-end:
//   • contentTrust FAIL-CLOSED (trusted IFF non-empty AND every source knowledge_writer; ABSENT provenance ⇒
//     untrusted — the by-omission TOCTOU) → capability read_only unless trusted (safety rule 6 / ING-7).
//   • NO AUTO-APPLY — a proposal ALWAYS records a PENDING §9.8 Approval; the human gate is STRUCTURAL, never a
//     branch on the decorative `approvalPolicy` string; the concrete sink NEVER dispatches/transitions (rule 3).
//   • PAYLOAD-SWAP TOCTOU — a divergent-payload re-proposal on the same object-key is REJECTED, never
//     overwriting an already-recorded (esp. approvable) card (rule 3).
//   • LEAKAGE / INJECTION — server-derived keys (model supplies none), strict intent shape (extra key ⇒
//     malformed), server-bound registry-validated workspace (rule 4 / WS-4), and NO raw content/secret in any
//     error surfaced to the model (asserted on the MODEL-FACING handler text, not just the internal error).
//
// COMPLEMENTS (does NOT re-run) the worker-track units: apps/worker/test/api/procedures/{copilotPropose,
// copilotProposeSink,copilotProvenanceStamp,copilotAgentSynthesis}.test.ts — it asserts the INVARIANTS
// cross-cuttingly. GREEN against committed code is the contract; a stubborn RED is a governance FINDING (surface
// it, never weaken the assertion). The real-SDK end-to-end case (real cloud query() → propose tool → pending
// card) spends real egress and is a DEFERRED-HITL item — RECORDED as an `it.todo` (assertion 5), never built.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Approval, ProposedAction, WorkspaceId, Workspace, ProviderRoute } from "@sow/contracts";
import type { ApprovalRepository, WorkspaceConfigRepository, DbError, DbResult } from "@sow/db";
import {
  deriveCopilotContentTrust,
  resolveCopilotAgentCapability,
  buildCopilotAgentJob,
} from "@sow/worker/api/procedures/copilotAgentSynthesis";
import {
  deriveCopilotProposedAction,
  routeCopilotProposal,
  proposeCopilotAction,
  handleCopilotProposeToolCall,
  type CopilotProposeSink,
} from "@sow/worker/api/procedures/copilotPropose";
import {
  createApprovalsProposeSink,
  COPILOT_PROPOSE_ACTOR,
} from "@sow/worker/api/procedures/copilotProposeSink";
import type { RetrievedContext, RetrievedSource } from "@sow/worker/api/procedures/copilot";

const WS = "personal-business" as WorkspaceId;
const NOW = "2026-07-05T12:00:00.000Z";
const runtimeRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

// ── retrieval-context + provenance fixtures ───────────────────────────────────
const ctx = (sources: readonly RetrievedSource[]): RetrievedContext => ({
  workspaceId: WS,
  blocks: ["RAW_BLOCK_should_never_surface"],
  sources,
});
const kwSource = (id: string): RetrievedSource => ({ citationId: id, title: "t", provenance: "knowledge_writer" });
const importedSource = (id: string): RetrievedSource => ({ citationId: id, title: "t", provenance: "imported" });
const unknownSource = (id: string): RetrievedSource => ({ citationId: id, title: "t", provenance: "unknown" });
const absentSource = (id: string): RetrievedSource => ({ citationId: id, title: "t" }); // provenance ABSENT

// ── model-supplied intent fixture ─────────────────────────────────────────────
type Intent = { targetSystem: string; operation: string; identity: Record<string, string>; payload: Record<string, unknown> };
const intent = (over: Partial<Intent> = {}): Intent => ({
  targetSystem: "todoist",
  operation: "todoist.create_task",
  identity: { title: "Draft the Q3 launch checklist" },
  payload: { title: "Draft the Q3 launch checklist" },
  ...over,
});

// ── fake repos (mirror copilotProposeSink.test.ts:44-98) ──────────────────────
function fakeApprovals(): { repo: ApprovalRepository; store: Map<string, Approval>; transitions: () => number } {
  const store = new Map<string, Approval>();
  let transitions = 0;
  const repo: ApprovalRepository = {
    create: (a: Approval): DbResult<Approval> => {
      if (store.has(String(a.id))) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
      store.set(String(a.id), a);
      return Promise.resolve(ok(a));
    },
    get: (id: Approval["id"]): DbResult<Approval> => {
      const found = store.get(String(id));
      return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
    },
    listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    listByStatusAndWorkspace: (status, workspaceId): DbResult<Approval[]> =>
      Promise.resolve(ok([...store.values()].filter((a) => a.status === status && a.workspaceId === workspaceId))),
    // The sink NEVER calls applyTransition (no auto-apply). It throws if ever invoked AND increments the counter
    // — either the count assertion (0) OR the loud throw fails the test; a silent transition cannot pass.
    applyTransition: () => {
      transitions += 1;
      throw new Error("sink must never applyTransition (no auto-apply)");
    },
  };
  return { repo, store, transitions: () => transitions };
}
const fakeWorkspaceConfig = (known: boolean): WorkspaceConfigRepository =>
  ({
    get: (id: Workspace["id"]): DbResult<Workspace> =>
      Promise.resolve(
        known ? ok({ id } as unknown as Workspace) : err({ code: "not_found", message: "unknown" } satisfies DbError),
      ),
  }) as WorkspaceConfigRepository;
const makeSink = (approvals: ApprovalRepository, known = true): CopilotProposeSink =>
  createApprovalsProposeSink({ approvals, workspaceConfig: fakeWorkspaceConfig(known), now: () => NOW });

/** A fake sink that captures what it was asked to record (for routing-invariance + derive-fails-first checks). */
function fakeSink(): { sink: CopilotProposeSink; recorded: Array<{ action: ProposedAction; workspaceId: WorkspaceId }> } {
  const recorded: Array<{ action: ProposedAction; workspaceId: WorkspaceId }> = [];
  const sink: CopilotProposeSink = {
    record: (input) => {
      recorded.push({ action: input.action, workspaceId: input.workspaceId });
      return Promise.resolve(ok({ approvalRef: "appr-fake", created: true }));
    },
  };
  return { sink, recorded };
}

// ── 1/2. contentTrust FAIL-CLOSED (safety rule 6 / §13.10a) ───────────────────
describe("propose governance — contentTrust fail-closed (safety rule 6)", () => {
  const TRUST_CASES: ReadonlyArray<{ name: string; context: RetrievedContext; trust: "trusted" | "untrusted" }> = [
    { name: "all sources knowledge_writer (non-empty) ⇒ trusted", context: ctx([kwSource("a"), kwSource("b")]), trust: "trusted" },
    { name: "ONE imported source ⇒ untrusted", context: ctx([kwSource("a"), importedSource("b")]), trust: "untrusted" },
    { name: "ONE unknown-provenance source ⇒ untrusted", context: ctx([kwSource("a"), unknownSource("b")]), trust: "untrusted" },
    { name: "ONE absent-provenance source ⇒ untrusted (TOCTOU: no trust by omission)", context: ctx([kwSource("a"), absentSource("b")]), trust: "untrusted" },
    { name: "empty sources ⇒ untrusted", context: ctx([]), trust: "untrusted" },
  ];
  for (const c of TRUST_CASES) {
    it(`trust_trusted_only_when_all_sources_knowledge_writer: ${c.name}`, () => {
      expect(deriveCopilotContentTrust(c.context)).toBe(c.trust);
    });
  }
  it("trust_absent_provenance_is_untrusted_toctou: a lone absent-provenance source cannot be rescued to trusted", () => {
    // A single un-provenanced source (the live-adapter default TODAY) collapses the whole verdict → untrusted.
    expect(deriveCopilotContentTrust(ctx([absentSource("only")]))).toBe("untrusted");
  });
});

// ── 3. capability read_only unless trusted (config fail-closed) ───────────────
describe("propose governance — capability read_only unless trusted", () => {
  const CAP_CASES: ReadonlyArray<{
    name: string;
    params: { contentTrust: "trusted" | "untrusted"; proposeEnabled: boolean; knowledgeProposeEnabled?: boolean };
    cap: "read_only" | "propose" | "propose_knowledge";
  }> = [
    { name: "untrusted + propose flag ⇒ read_only", params: { contentTrust: "untrusted", proposeEnabled: true }, cap: "read_only" },
    { name: "untrusted + knowledge flag ⇒ read_only", params: { contentTrust: "untrusted", proposeEnabled: false, knowledgeProposeEnabled: true }, cap: "read_only" },
    { name: "trusted + BOTH flags ⇒ read_only (config error fail-closed)", params: { contentTrust: "trusted", proposeEnabled: true, knowledgeProposeEnabled: true }, cap: "read_only" },
    { name: "trusted + neither flag ⇒ read_only", params: { contentTrust: "trusted", proposeEnabled: false }, cap: "read_only" },
    // Positive non-vacuousness anchors — prove the untrusted assertions above are NOT trivially always-true.
    { name: "trusted + propose only ⇒ propose", params: { contentTrust: "trusted", proposeEnabled: true }, cap: "propose" },
    { name: "trusted + knowledge only ⇒ propose_knowledge", params: { contentTrust: "trusted", proposeEnabled: false, knowledgeProposeEnabled: true }, cap: "propose_knowledge" },
  ];
  for (const c of CAP_CASES) {
    it(`capability_read_only_unless_trusted: ${c.name}`, () => {
      expect(resolveCopilotAgentCapability(c.params)).toBe(c.cap);
    });
  }

  it("capability_read_only_unless_trusted: buildCopilotAgentJob — untrusted ⇒ read_only policy + untrusted (propose NEVER granted)", () => {
    const jobA = buildCopilotAgentJob(WS, runtimeRoute, { contentTrust: "untrusted", proposeEnabled: true });
    expect(jobA.toolPolicy.mode).toBe("read_only");
    expect(jobA.toolPolicy.allowsMutating).toBe(false);
    expect(jobA.trustLevel).toBe("untrusted");
    // no trust arg at all ⇒ the safe default is also read_only/untrusted
    const jobDefault = buildCopilotAgentJob(WS, runtimeRoute);
    expect(jobDefault.toolPolicy.mode).toBe("read_only");
    expect(jobDefault.trustLevel).toBe("untrusted");
  });

  it("capability_read_only_unless_trusted: buildCopilotAgentJob — trusted+propose ⇒ scoped_write + trusted (atomic pair)", () => {
    const jobP = buildCopilotAgentJob(WS, runtimeRoute, { contentTrust: "trusted", proposeEnabled: true });
    expect(jobP.toolPolicy.mode).toBe("scoped_write");
    expect(jobP.trustLevel).toBe("trusted");
  });
});

// ── 4/5. NO AUTO-APPLY (safety rule 3) ────────────────────────────────────────
describe("propose governance — no auto-apply (safety rule 3)", () => {
  it("propose_records_pending_regardless_of_policy: routeCopilotProposal records via the sink for ANY approvalPolicy string", async () => {
    const base = deriveCopilotProposedAction(intent());
    expect(isOk(base)).toBe(true);
    if (!isOk(base)) return;
    // The `approvalPolicy` string is DECORATIVE — routing must never branch on it. Vary it; the route must
    // still record a pending card every time (unconditional human gate).
    for (const policy of ["requires_approval", "auto_apply", "immediate-apply"]) {
      const action = { ...base.value, approvalPolicy: policy } as ProposedAction;
      const fx = fakeSink();
      const r = await routeCopilotProposal({ action, workspaceId: WS, sink: fx.sink });
      expect(isOk(r), `policy=${policy}`).toBe(true);
      expect(fx.recorded).toHaveLength(1); // routed to the pending sink
      expect(fx.recorded[0]?.workspaceId).toBe(WS);
    }
  });

  it("concrete_sink_never_dispatches: createApprovalsProposeSink records ONE pending card, zero applyTransition", async () => {
    const a = fakeApprovals();
    const r = await proposeCopilotAction({ intent: intent(), workspaceId: WS, sink: makeSink(a.repo) });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(true);
    expect(a.store.size).toBe(1); // exactly one card
    const row = a.store.get(r.value.approvalRef);
    expect(row?.status).toBe("pending");
    expect(row?.actor).toBe(COPILOT_PROPOSE_ACTOR); // server actor, never a model value
    expect(a.transitions()).toBe(0); // NEVER auto-applied (no state transition)
  });
});

// ── 6. PAYLOAD-SWAP TOCTOU (safety rule 3) ────────────────────────────────────
describe("propose governance — payload-swap TOCTOU (safety rule 3)", () => {
  it("payload_swap_divergent_rejected: same object-key + DIVERGENT payload ⇒ CONFLICT, original card untouched", async () => {
    const a = fakeApprovals();
    const sink = makeSink(a.repo);
    // identity (⇒ object-key) is IDENTICAL across both; only the payload differs.
    const first = await proposeCopilotAction({ intent: intent({ payload: { body: "A" } }), workspaceId: WS, sink });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    const firstHash = a.store.get(first.value.approvalRef)?.payloadHash;
    const second = await proposeCopilotAction({ intent: intent({ payload: { body: "B-EVIL" } }), workspaceId: WS, sink });
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error.cause?.code).toBe("COPILOT_PROPOSE_PAYLOAD_CONFLICT");
    // the ALREADY-RECORDED card's payload was NOT overwritten (an owner who approves A never executes B-EVIL)
    expect(a.store.get(first.value.approvalRef)?.payloadHash).toBe(firstHash);
    expect(a.store.size).toBe(1);
  });

  it("payload_swap_divergent_rejected: IDENTICAL payload re-drive ⇒ idempotent no-op (created:false, no 2nd card)", async () => {
    const a = fakeApprovals();
    const sink = makeSink(a.repo);
    const first = await proposeCopilotAction({ intent: intent(), workspaceId: WS, sink });
    const second = await proposeCopilotAction({ intent: intent(), workspaceId: WS, sink });
    expect(isOk(first) && isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.created).toBe(false);
    expect(a.store.size).toBe(1);
  });
});

// ── 7/8/9/10. LEAKAGE / INJECTION (safety rule 4 / WS-4) ──────────────────────
describe("propose governance — leakage / injection fail-closed (safety rules 3·4)", () => {
  const MALFORMED_INTENTS: ReadonlyArray<{ name: string; raw: unknown }> = [
    { name: "extra smuggled workspaceId key", raw: { ...intent(), workspaceId: "ws-other" } },
    { name: "extra arbitrary key", raw: { ...intent(), evil: true } },
    { name: "non-object intent", raw: "not-an-object" },
    { name: "numeric identity value (wrong type)", raw: { ...intent(), identity: { title: 12345 } } },
  ];
  for (const c of MALFORMED_INTENTS) {
    it(`intent_rejects_extra_key_no_workspace_smuggle: ${c.name} ⇒ COPILOT_PROPOSE_MALFORMED`, () => {
      const r = deriveCopilotProposedAction(c.raw);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
    });
  }

  it("intent_rejects_extra_key_no_workspace_smuggle: keys are SERVER-derived (model supplies none)", () => {
    const r = deriveCopilotProposedAction(intent());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.canonicalObjectKey.length).toBeGreaterThan(0);
    expect(String(r.value.idempotencyKey).length).toBeGreaterThan(0);
    expect(String(r.value.actionId)).toBe(String(r.value.idempotencyKey)); // actionId IS the derived key
    // keys track the IDENTITY, not any model-supplied value — a different identity ⇒ a different canonical key
    const other = deriveCopilotProposedAction(intent({ identity: { title: "A DIFFERENT object" } }));
    if (isOk(other)) expect(other.value.canonicalObjectKey).not.toBe(r.value.canonicalObjectKey);
  });

  it("workspace_server_bound_unknown_fails_closed: an unregistered workspace ⇒ UNKNOWN_WORKSPACE, approvals UNTOUCHED", async () => {
    const a = fakeApprovals();
    const r = await proposeCopilotAction({ intent: intent(), workspaceId: WS, sink: makeSink(a.repo, false) });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_UNKNOWN_WORKSPACE");
    expect(a.store.size).toBe(0); // no card written — registry-validated BEFORE any approvals I/O
  });

  it("bad_target_and_oversized_payload_fail_closed", () => {
    const bad = deriveCopilotProposedAction(intent({ targetSystem: "not-a-real-system" }));
    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error.cause?.code).toBe("COPILOT_PROPOSE_BAD_TARGET");
    const big = deriveCopilotProposedAction(intent({ payload: { blob: "x".repeat(20 * 1024) } }));
    expect(isErr(big)).toBe(true);
    if (isErr(big)) expect(big.error.cause?.code).toBe("COPILOT_PROPOSE_PAYLOAD_TOO_LARGE");
  });

  const SECRET = "SUPER_SECRET_sk-abc123-EVIL";
  it("error_surface_carries_no_raw_content: the INTERNAL error object carries only a bounded code, never the secret", () => {
    const big = deriveCopilotProposedAction(intent({ payload: { blob: SECRET + "x".repeat(20 * 1024) } }));
    expect(isErr(big)).toBe(true);
    if (isErr(big)) {
      expect(big.error.cause?.code).toBe("COPILOT_PROPOSE_PAYLOAD_TOO_LARGE");
      expect(JSON.stringify(big.error)).not.toContain(SECRET);
    }
    const mal = deriveCopilotProposedAction({ ...intent(), secretField: SECRET });
    expect(isErr(mal)).toBe(true);
    if (isErr(mal)) {
      expect(mal.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
      expect(JSON.stringify(mal.error)).not.toContain(SECRET);
    }
  });

  it("error_surface_carries_no_raw_content: the MODEL-FACING handler text carries only a bounded code, never the secret", async () => {
    // The AC says "surfaced TO THE MODEL" — the model sees handleCopilotProposeToolCall's returned text, not the
    // internal error. Pin the actual surface: derivation fails BEFORE the sink, so any sink is inert here.
    const deps = { workspaceId: WS, sink: fakeSink().sink };
    const big = await handleCopilotProposeToolCall(intent({ payload: { blob: SECRET + "x".repeat(20 * 1024) } }), deps);
    expect(big.isError).toBe(true);
    const bigText = big.content.map((p) => p.text).join(" ");
    expect(bigText).toContain("COPILOT_PROPOSE_PAYLOAD_TOO_LARGE");
    expect(JSON.stringify(big)).not.toContain(SECRET); // no raw payload bytes reach the model
    const mal = await handleCopilotProposeToolCall({ ...intent(), secretField: SECRET }, deps);
    expect(mal.isError).toBe(true);
    expect(mal.content.map((p) => p.text).join(" ")).toContain("COPILOT_PROPOSE_MALFORMED");
    expect(JSON.stringify(mal)).not.toContain(SECRET);
  });
});

// ── 11. DEFERRED real-egress (runbook §3 assertion 5) — RECORDED, not built ────
describe("propose governance — DEFERRED real-egress (runbook §3 assertion 5)", () => {
  // requiresRealIntegration:true — a real cloud query() drives the propose tool to a pending card within
  // DEFAULT_MAX_TURNS. NOT built here: it spends REAL egress (a deferred-HITL go-live item). Visible gap, not a
  // silent cap. See docs/runbooks/copilot-propose-go-live.md §3.
  it.todo(
    "real_sdk_end_to_end: real query() → propose tool → pending card ≤ DEFAULT_MAX_TURNS (requiresRealIntegration:true, real-egress deferred-HITL)",
  );
});
