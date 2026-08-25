// Task 9.10-B ⚠ rule-5 SAFETY — the owner-authorized egress-ack REVOKE command. `revokeEgressAck`
// flips a workspace's `EgressPolicy.employerRawEgressAcknowledged` → false AND clears `acknowledgedAt`
// (both together, per the model refine), through the 9.10-A store path (WorkspaceConfigRepository
// get→upsert with the L30 immutable-binding guard), audited (summaries-only), fail-closed. The fail-SAFE
// direction (turns employer cloud egress OFF). Non-vacuous visibility pin: egressStatus on-before/off-after.
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr, validWorkspace } from "@sow/contracts";
import type { Workspace, AuditRecord } from "@sow/contracts";
import type { WorkspaceConfigRepository, AuditRepository, DbResult, DbError, AuditQuery } from "@sow/db";
import { createEgressCommandPort } from "../../../src/composition/egressRevoke";
import { createSystemHealthQueryPort } from "../../../src/boot";
import type { ProofSpineBackends } from "../../../src/composition/backends";
import { buildEgressCommandRouter, type EgressCommandPort } from "../../../src/api/procedures/egressCommands";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";

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
  opts: { getFault?: boolean; getThrows?: boolean; upsertFault?: boolean; getStoredRowSchemaViolation?: boolean } = {},
): { repo: WorkspaceConfigRepository; upserts: Workspace[] } {
  let stored = seed;
  const upserts: Workspace[] = [];
  const repo: WorkspaceConfigRepository = {
    get: (id): DbResult<Workspace> => {
      if (opts.getThrows) throw new Error("boom — must be caught, never crosses");
      if (opts.getFault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } as DbError });
      // Task 9.36 — the repository read boundary re-gate; distinct from a generic store fault.
      if (opts.getStoredRowSchemaViolation) {
        return Promise.resolve({ ok: false, error: { code: "stored_row_schema_violation", message: "corrupt row" } as DbError });
      }
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
    // 9.30 — the revoke path never calls this; present to satisfy the interface.
    insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
    updateProvisioningFields: (): DbResult<Workspace> =>
      Promise.resolve({ ok: false, error: nf }),
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
      // 9.22 ⚠ SEMANTICS CHANGE (L69): this assertion used to read `zeroEgressOnly: true`, defending the
      // pre-9.22 `!acknowledged` coupling. `employerAcked` inherits `validWorkspace`'s own vacuous
      // providerMatrix (`capabilityDefaults: {}`), so the option-C predicate is NOT ESTABLISHED
      // (`false`) both before and after this revoke — the correct answer, not a regression.
      expect(r.value).toEqual({ workspaceId: WS_ID, employerRawEgressAcknowledged: false, zeroEgressOnly: false });
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

  it("revoke_classifies_stored_row_schema_violation_distinctly — task 9.36's new code is NOT collapsed into store_fault", async () => {
    const inconsistent = memConfig(employerAcked, { getStoredRowSchemaViolation: true });
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: inconsistent.repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("stored_row_schema_violation");
      expect(r.error.code).not.toBe("store_fault"); // classified, not collapsed
    }
    expect(inconsistent.upserts.length).toBe(0); // fail-closed — never upserts over a corrupt read
    expect(audit.appended.length).toBe(0);
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
    // 24.101 — cause code, not bare falsity: proves this is SPECIFICALLY the audit-append store_fault
    // (not, say, workspace_not_found or stored_row_schema_violation — the OTHER two codes this port
    // can return), discriminating it from every other RevokeEgressAckError variant.
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("store_fault");
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
      // 9.22 ⚠ SEMANTICS CHANGE (L69): was `zeroEgressOnly: true` — the tested false assurance this arc
      // exists to remove. `employerAcked`'s providerMatrix is vacuous (never provisioned with real
      // routes), so the option-C predicate reads NOT ESTABLISHED, not "local-only", pre- and post-revoke.
      expect(after.value.zeroEgressOnly).toBe(false);
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

// ── `### 24.112` — the wire-sink projector deliberately does NOT redact `workspaceId` (rule 5) ──
//
// The unresolved tension this file's `toUiSafeEgressStatus` fence names: copying `systemHealth.ts`'s
// sink redaction into THIS producer would make a LANDED revoke report FAILURE (the redacted id would
// diverge from the request, and `apps/desktop`'s `foldStatus` treats a divergence as "couldn't
// revoke"). This is the pin nothing before this task caught — RED-verified by mutation.
const AUTHED_CTX: ApiContext = { auth: ok<AuthedContext>({ authenticated: true }) };
function makeEgressCaller(port: EgressCommandPort) {
  const appRouter = router({ egress: buildEgressCommandRouter({ egressCommand: port }) });
  return createCallerFactory(appRouter)(AUTHED_CTX);
}

describe("§9.10-B / `### 24.112` — the wire-sink projector (rule 5: a landed revoke must report success)", () => {
  it("revoke_landed_reports_success_workspaceid_unredacted — a landed revoke's workspaceId crosses BYTE-IDENTICAL to the request, even for a credential/keyword-shaped id", async () => {
    // "client-secret-audit" is the SAME benign-but-keyword-bearing id `systemHealth.test.ts` pins as
    // getting dropped WHOLE by the canonical redactor (REDACTED_FIELD) — chosen here for the mirror
    // reason: it is exactly where a naive copy of that redaction would make the served value diverge
    // from the request, which is the failure mode this pin exists to catch.
    const landedId = "client-secret-audit";
    const landedPort: EgressCommandPort = {
      revokeEgressAck: (input) =>
        Promise.resolve(
          ok({
            workspaceId: input.workspaceId, // the port ECHOES the workspace it actually revoked
            employerRawEgressAcknowledged: false,
            zeroEgressOnly: false,
          }),
        ),
    };
    const res = await makeEgressCaller(landedPort).egress.revokeEgressAck({ workspaceId: landedId });
    // "reports success" = ok AND byte-identical to the request — the exact comparison
    // `apps/desktop`'s `foldStatus` performs to decide "landed" vs "posture unavailable" (out of this
    // package's territory; asserted directly here as the observable proxy).
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.workspaceId).toBe(landedId);
  });
});

// ── `### 24.112` — the DURABLE audit sink independently redaction-gates workspaceId (rule 7) ────
//
// The OTHER half of the resolution: rule 5 wins the wire sink above, and that is safe BECAUSE rule
// 7's real enforcement point for `workspaceId` is the DURABLE audit trail, one layer down
// (`composition/egressRevoke.ts`), which already runs `isRedactionSafe` (scanning `refs`, task
// 24.45) before `deps.audit.append`. This pin proves that gate actually fires for exactly the id
// shape the wire-sink test above deliberately serves unredacted.
describe("§9.10-B / `### 24.112` — the durable audit sink (rule 7: no un-redacted workspaceId reaches it)", () => {
  it("revoke_credential_shaped_workspaceid_never_reaches_the_durable_audit_sink — the store flip still lands durably, but the audit append is BLOCKED for a credential/keyword-shaped id", async () => {
    const credentialShapedId = "client-secret-audit";
    const credentialShapedWorkspace: Workspace = {
      ...employerAcked,
      id: credentialShapedId as Workspace["id"],
      egressPolicy: {
        ...employerAcked.egressPolicy,
        workspaceId: credentialShapedId as Workspace["egressPolicy"]["workspaceId"],
      },
    };
    const { repo, upserts } = memConfig(credentialShapedWorkspace);
    const audit = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: audit.repo, now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: credentialShapedId });
    // The COMMAND overall reports err (the audit gate blocked the trail) — but the fail-safe OFF
    // flip already landed DURABLY in the store (rule-5 direction preserved: employer raw egress IS
    // off, even though this specific call also reports the missing audit trail — mirrors
    // `revoke_audit_fault_fails_closed` above).
    expect(isErr(r)).toBe(true);
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.egressPolicy.employerRawEgressAcknowledged).toBe(false);
    // THE PIN: the raw credential-shaped id NEVER reached the durable audit sink.
    expect(audit.appended.length).toBe(0);
  });
});
