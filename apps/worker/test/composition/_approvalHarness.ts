// Shared harness for the Linear slice 3+4 approval tests: REAL backends, the REAL propose sink, a fake vendor only.
import { workspaceId, actionId, defaultWorkspace } from "@sow/contracts";
import type { Approval, ProposedAction, ExternalWriteEnvelope, WorkspaceId } from "@sow/contracts";
import type { AdapterTransport, AdapterTransportRequest, TransportResponse } from "@sow/integrations";
import { assembleBackends, type ProofSpineBackends, type WriteTransportGate } from "../../src/composition/backends";
import { createApprovalsProposeSink } from "../../src/api/procedures/copilotProposeSink";

export const NOW = "2026-09-22T12:00:00.000Z";
export const WS: WorkspaceId = workspaceId("employer-work");
export const OTHER_WS: WorkspaceId = workspaceId("personal-life");

export function vendor(onCreate: "ok" | "unreachable" | "rejected" = "ok"): { transport: AdapterTransport; calls: AdapterTransportRequest[] } {
  const calls: AdapterTransportRequest[] = [];
  const transport: AdapterTransport = (req): Promise<TransportResponse> => {
    calls.push(req);
    if (req.op === "query") return Promise.resolve({ ok: true, object: null });
    if (onCreate === "ok") return Promise.resolve({ ok: true, object: { externalObjectId: "LIN-1" } });
    return Promise.resolve({ ok: false, fault: onCreate, detail: "vendor said no" });
  };
  return { transport, calls };
}

/** Real backends with both workspaces onboarded. `gate` absent ⇒ unarmed (the stub would be selected). */
export async function backends(open: ProofSpineBackends[], gate?: WriteTransportGate): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: ["http://127.0.0.1:11434"], ...(gate !== undefined ? { writeTransport: gate } : {}) },
    { candidateOutput: {} },
  );
  open.push(b);
  for (const id of [WS, OTHER_WS]) {
    const up = await b.repos.workspaceConfig.upsert(
      defaultWorkspace({ id, name: String(id), type: id === WS ? "employer_work" : "personal_life", markdownRepoPath: `/tmp/${id}`, gbrainBrainId: String(id) }),
    );
    if (!up.ok) throw new Error("workspace seed failed");
  }
  return b;
}

export function linearIssue(key: string, over: Partial<ProposedAction["payload"]> = {}): { action: ProposedAction; envelope: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId(`act-${key}`),
    targetSystem: "linear",
    canonicalObjectKey: `lin:${key}`,
    payload: { teamId: "team-1", title: `Issue ${key}`, description: `About ${key}`, ...over },
    approvalPolicy: "required",
    idempotencyKey: `idem:${key}`,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: action.targetSystem,
    canonicalObjectKey: action.canonicalObjectKey,
    idempotencyKey: action.idempotencyKey,
    preconditions: [],
    payloadHash: `hash:${key}`,
  };
  return { action, envelope };
}

/** Propose through the REAL sink, then move the card to `status` (default approved) as the Approvals screen does. */
export async function propose(
  b: ProofSpineBackends,
  key: string,
  opts: { ws?: WorkspaceId; status?: Approval["status"]; payload?: Partial<ProposedAction["payload"]> } = {},
): Promise<Approval> {
  const { action, envelope } = linearIssue(key, opts.payload ?? {});
  const sink = createApprovalsProposeSink({ approvals: b.repos.approvals, workspaceConfig: b.repos.workspaceConfig, outbox: b.repos.outbox, now: () => NOW });
  const rec = await sink.record({ action, envelope, workspaceId: opts.ws ?? WS });
  if (!rec.ok) throw new Error(`propose failed: ${rec.error.message}`);
  const card = await b.repos.approvals.get(rec.value.approvalRef as Approval["id"]);
  if (!card.ok) throw new Error("card missing");
  const status = opts.status ?? "approved";
  if (status === "pending") return card.value;
  const moved = await b.repos.approvals.applyTransition(card.value.id, "pending", { ...card.value, status });
  if (!moved.ok) throw new Error("transition failed");
  return { ...card.value, status };
}
