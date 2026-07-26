// Task 9.10-B ⚠ rule-5 SAFETY — the owner-authorized egress-ack REVOKE command. `revokeEgressAck`
// flips a workspace's `EgressPolicy.employerRawEgressAcknowledged` → false AND clears `acknowledgedAt`
// (both together, per the model refine), through the 9.10-A store path (WorkspaceConfigRepository
// get→upsert with the L30 immutable-binding guard), audited (summaries-only), fail-closed. The fail-SAFE
// direction (turns employer cloud egress OFF). Non-vacuous visibility pin: egressStatus on-before/off-after.
import { describe, it, expect } from "vitest";
import { isOk, isErr, validWorkspace } from "@sow/contracts";
import type { Workspace, AuditRecord } from "@sow/contracts";
import type { WorkspaceConfigRepository, AuditRepository, DbResult, DbError, AuditQuery } from "@sow/db";
import { createEgressCommandPort } from "../../../src/composition/egressRevoke";
import { createSystemHealthQueryPort } from "../../../src/boot";
import type { ProofSpineBackends } from "../../../src/composition/backends";

const NOW = "2026-07-26T00:00:00.000Z";
const nf: DbError = { code: "not_found", message: "nf" } as DbError;

/** An employer_work workspace with raw-egress ACK ON + a timestamp (the FLIP-seeded state #39 lands). */
const employerAcked: Workspace = {
  ...validWorkspace,
  type: "employer_work",
  dataOwner: "employer",
  egressPolicy: {
    ...validWorkspace.egressPolicy,
    employerRawEgressAcknowledged: true,
    acknowledgedAt: "2026-07-25T00:00:00.000Z",
  },
};
const WS_ID = String(employerAcked.id);

/** A mutable in-memory WorkspaceConfigRepository seeded with one workspace (absent ⇒ not_found). */
function memConfig(
  seed: Workspace | undefined,
  opts: { getFault?: boolean; getThrows?: boolean; upsertFault?: boolean } = {},
): { repo: WorkspaceConfigRepository; upserts: Workspace[] } {
  let stored = seed;
  const upserts: Workspace[] = [];
  const repo: WorkspaceConfigRepository = {
    get: (id): DbResult<Workspace> => {
      if (opts.getThrows) throw new Error("boom — must be caught, never crosses");
      if (opts.getFault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } as DbError });
      return stored !== undefined && String(id) === String(stored.id)
        ? Promise.resolve({ ok: true, value: stored })
        : Promise.resolve({ ok: false, error: nf });
    },
    list: (): DbResult<Workspace[]> => Promise.resolve({ ok: true, value: stored ? [stored] : [] }),
    upsert: (w: Workspace): DbResult<Workspace> => {
      if (opts.upsertFault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "upsert down" } as DbError });
      stored = w;
      upserts.push(w); // successful writes only
      return Promise.resolve({ ok: true, value: w });
    },
  };
  return { repo, upserts };
}

/** A capturing AuditRepository (optionally faulting on append). */
function memAudit(fault = false): { repo: AuditRepository; appended: AuditRecord[] } {
  const appended: AuditRecord[] = [];
  const repo: AuditRepository = {
    append: (rec: AuditRecord): DbResult<void> => {
      if (fault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "down" } as DbError });
      appended.push(rec);
      return Promise.resolve({ ok: true, value: undefined });
    },
    query: (_f: AuditQuery, _n: number): DbResult<AuditRecord[]> => Promise.resolve({ ok: true, value: [] }),
  };
  return { repo, appended };
}

/** Drive the real egressStatus visibility port over a workspaceConfig repo (only touches repos.workspaceConfig). */
function egressStatusOver(workspaceConfig: WorkspaceConfigRepository) {
  return createSystemHealthQueryPort({ repos: { workspaceConfig } } as unknown as ProofSpineBackends);
}

describe("§9.10-B egress-ack REVOKE command (⚠ rule-5 fail-safe OFF)", () => {
  it("revoke_flips_ack_and_clears_timestamp — ack true+acknowledgedAt → ack false + acknowledgedAt ABSENT (both together, refine-satisfying)", async () => {
    const { repo, upserts } = memConfig(employerAcked);
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ workspaceId: WS_ID, employerRawEgressAcknowledged: false, zeroEgressOnly: true });
    }
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.egressPolicy.employerRawEgressAcknowledged).toBe(false);
    expect(upserts[0]!.egressPolicy.acknowledgedAt).toBeUndefined();
    expect("acknowledgedAt" in upserts[0]!.egressPolicy).toBe(false); // cleared, not undefined-valued (refine)
  });

  it("revoke_get_before_upsert_immutable_binding — ONLY the ack fields change; id/type/name/rest untouched (L30)", async () => {
    const { repo, upserts } = memConfig(employerAcked);
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    await port.revokeEgressAck({ workspaceId: WS_ID });
    const w = upserts[0]!;
    expect(w.id).toBe(employerAcked.id);
    expect(w.type).toBe("employer_work");
    expect(w.dataOwner).toBe("employer");
    expect(w.name).toBe(employerAcked.name);
    expect(w.egressPolicy.workspaceId).toBe(employerAcked.egressPolicy.workspaceId); // binding anchor preserved
    expect(w.providerMatrix).toEqual(employerAcked.providerMatrix);
  });

  it("revoke_fail_closed_on_store_fault — a not_found AND a faulted workspace → typed err, ZERO upsert, ZERO audit (preserve-fault)", async () => {
    // (a) absent workspace → not_found → workspace_not_found; never upserts on unknown prior.
    const absent = memConfig(undefined);
    const auditA = memAudit();
    const portA = createEgressCommandPort({ workspaceConfig: absent.repo, audit: auditA.repo, now: () => NOW });
    const rA = await portA.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(rA)).toBe(true);
    if (isErr(rA)) expect(rA.error.code).toBe("workspace_not_found"); // not_found discriminated (no mapping swap)
    expect(absent.upserts.length).toBe(0);
    expect(auditA.appended.length).toBe(0);
    // (b) a genuine get fault → store_fault; still ZERO upsert + audit.
    const faulted = memConfig(employerAcked, { getFault: true });
    const auditB = memAudit();
    const portB = createEgressCommandPort({ workspaceConfig: faulted.repo, audit: auditB.repo, now: () => NOW });
    const rB = await portB.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(rB)).toBe(true);
    if (isErr(rB)) expect(rB.error.code).toBe("store_fault"); // a non-not_found fault discriminated
    expect(faulted.upserts.length).toBe(0);
    expect(auditB.appended.length).toBe(0);
  });

  it("revoke_fail_closed_on_upsert_fault — a durable-write (upsert) fault AFTER a good get → typed store_fault, ZERO audit (never records a write that didn't land)", async () => {
    const { repo, upserts } = memConfig(employerAcked, { upsertFault: true });
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("store_fault");
    expect(upserts.length).toBe(0); // the write faulted
    expect(audit.appended.length).toBe(0); // NO audit after a failed durable write (upsert-then-audit)
  });

  it("revoke_audits_summary_only — AuditRecord{event:egress_ack_revoked, actor:owner} with before/after SUMMARIES only (no raw policy dump, rule-7)", async () => {
    const { repo } = memConfig(employerAcked);
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(audit.appended.length).toBe(1);
    const rec = audit.appended[0]!;
    expect(rec.actor).toBe("owner");
    expect(rec.event).toBe("egress_ack_revoked");
    expect(rec.refs).toContain(WS_ID);
    expect(rec.beforeSummary.length).toBeGreaterThan(0);
    expect(rec.afterSummary.length).toBeGreaterThan(0);
    expect(rec.timestamps.occurredAt).toBe(NOW);
    // Summaries carry no raw policy blob (no provider/matrix/secret dump).
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("providerMatrix");
    expect(serialized).not.toContain("markdownRepoPath");
  });

  it("revoke_audit_fault_fails_closed — an audit-sink fault AFTER the upsert → typed err (fail-closed on the trail; idempotent retry completes it)", async () => {
    const { repo, upserts } = memConfig(employerAcked);
    const audit = memAudit(true); // append faults
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(r)).toBe(true);
    expect(upserts.length).toBe(1); // the fail-safe OFF is durable (egress already off); the err is the missing trail
  });

  it("visibility_reflects_revoke — egressStatus reads ACK ON before revoke, OFF after (non-vacuous, over the SHARED config)", async () => {
    const { repo } = memConfig(employerAcked);
    const health = egressStatusOver(repo);
    const before = await health.egressStatus(WS_ID);
    expect(isOk(before)).toBe(true);
    if (isOk(before)) expect(before.value.employerRawEgressAcknowledged).toBe(true); // POSITIVE control (acked→on)
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    expect(isOk(await port.revokeEgressAck({ workspaceId: WS_ID }))).toBe(true);
    const after = await health.egressStatus(WS_ID);
    expect(isOk(after)).toBe(true);
    if (isOk(after)) {
      expect(after.value.employerRawEgressAcknowledged).toBe(false); // NEGATIVE (revoked→off)
      expect(after.value.zeroEgressOnly).toBe(true);
    }
  });

  it("total_never_throws_no_leak — a THROWING workspaceConfig.get → typed err, NO throw, no secret/raw leak (rule-7 / §16)", async () => {
    const throwing = memConfig(employerAcked, { getThrows: true });
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: throwing.repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(typeof r.error.code).toBe("string");
      expect(JSON.stringify(r.error)).not.toContain("boom"); // the thrown cause never crosses
    }
    expect(throwing.upserts.length).toBe(0);
  });
});
