// Task 24.64 (worker leg B) — gate the direct `audit.append` producer at `egressRevoke.ts`
// against `isRedactionSafe` (rule 7). `egressRevoke.ts` builds an audit record inline and calls
// `deps.audit.append` directly (never through `buildAuditSignal`), so the pre-24.64 coverage
// claim on `isRedactionSafe`'s producer census never reached it — see
// `packages/policy/src/audit-signal.ts:205-211`'s own retraction, which names this file.
//
// SCOPE: this file pins the redaction gate ONLY. The rest of `revokeEgressAck`'s behavior
// (fail-closed get-before-upsert, L30 immutable-binding, rule-7 summaries-only shape, the UI-safe
// status derivation) is already pinned in `apps/worker/test/api/procedures/egressCommands.test.ts`
// — not duplicated here.
import { describe, it, expect } from "vitest";
import { isOk, isErr, validWorkspace } from "@sow/contracts";
import type { Workspace, AuditRecord } from "@sow/contracts";
import type { WorkspaceConfigRepository, AuditRepository, DbResult, DbError, AuditQuery } from "@sow/db";
import { createEgressCommandPort } from "../../src/composition/egressRevoke";

const NOW = "2026-08-24T00:00:00.000Z";

// Credential-shaped ON PURPOSE — matches `packages/policy/src/audit-signal.ts`'s
// `CREDENTIAL_PREFIX` (`\bsk-[a-z0-9]`), the same fixture shape
// `packages/knowledge/test/gcl-visibility-gate.test.ts:363-368` reasons about. A neutral
// sentinel would make the gate assertions decorative (contracts LESSONS.md #192): `isRedactionSafe`
// is a credential-SHAPE heuristic, not a content allowlist, so only a value that actually trips
// one of its three regexes proves the gate is load-bearing.
const CREDENTIAL_WS_ID = "sk-hunter2echo";

/**
 * A workspace whose `id` (and `egressPolicy.workspaceId`) is the credential-shaped string above.
 * Cast past the brand (`as unknown as Workspace`) — `makeId`'s schema correctly refuses to
 * construct an adversarial id via the real `workspaceId(...)` factory; this is the standing
 * defense-in-depth convention for a test that must reach the DOWNSTREAM `isRedactionSafe` gate,
 * not a workaround of it.
 */
const credentialWorkspace: Workspace = {
  ...validWorkspace,
  id: CREDENTIAL_WS_ID,
  egressPolicy: {
    ...validWorkspace.egressPolicy,
    workspaceId: CREDENTIAL_WS_ID,
    employerRawEgressAcknowledged: true,
    acknowledgedAt: "2026-08-01T00:00:00.000Z",
  },
} as unknown as Workspace;

/** A benign (non-credential-shaped) acked workspace, for the positive control. */
const benignWorkspace: Workspace = {
  ...validWorkspace,
  egressPolicy: {
    ...validWorkspace.egressPolicy,
    employerRawEgressAcknowledged: true,
    acknowledgedAt: "2026-08-01T00:00:00.000Z",
  },
};

/** A mutable in-memory WorkspaceConfigRepository seeded with one workspace. */
function memConfig(seed: Workspace, opts: { upsertFault?: boolean } = {}): { repo: WorkspaceConfigRepository; upserts: Workspace[] } {
  const upserts: Workspace[] = [];
  const repo: WorkspaceConfigRepository = {
    get: (): DbResult<Workspace> => Promise.resolve({ ok: true, value: seed }),
    list: (): DbResult<Workspace[]> => Promise.resolve({ ok: true, value: [seed] }),
    upsert: (w: Workspace): DbResult<Workspace> => {
      if (opts.upsertFault) {
        return Promise.resolve({ ok: false, error: { code: "unavailable", message: "upsert down" } as DbError });
      }
      upserts.push(w);
      return Promise.resolve({ ok: true, value: w });
    },
    // The revoke path never calls this; present only to satisfy the interface.
    insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
    updateProvisioningFields: (): DbResult<Workspace> =>
      Promise.resolve({ ok: false, error: { code: "not_found", message: "nf" } as DbError }),
  };
  return { repo, upserts };
}

/** A capturing AuditRepository. */
function memAudit(): { repo: AuditRepository; appended: AuditRecord[] } {
  const appended: AuditRecord[] = [];
  const repo: AuditRepository = {
    append: (rec: AuditRecord): DbResult<void> => {
      appended.push(rec);
      return Promise.resolve({ ok: true, value: undefined });
    },
    query: (_f: AuditQuery, _n: number): DbResult<AuditRecord[]> => Promise.resolve({ ok: true, value: [] }),
  };
  return { repo, appended };
}

describe("#24.64 (worker leg B) — egressRevoke's direct audit.append producer is redaction-gated", () => {
  it("revoke_audit_is_redaction_gated: a credential-shaped workspaceId trips isRedactionSafe ⇒ err(store_fault), ZERO audit appends, the error message excludes the offending value — and the durable OFF write (step 3) already landed before the gate (step 4), preserving the fail-safe ordering", async () => {
    const { repo, upserts } = memConfig(credentialWorkspace);
    const { repo: auditRepo, appended } = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: auditRepo, now: () => NOW });

    const r = await port.revokeEgressAck({ workspaceId: CREDENTIAL_WS_ID });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Matches the site's existing error contract (task 9.36's taxonomy) — a distinct MESSAGE,
      // never a new code, so the caller's fail-closed path is unchanged.
      expect(r.error.code).toBe("store_fault");
      // Rule 7 — the rejection must never echo the offending value (else the gate becomes the
      // exfiltration route it exists to close).
      expect(r.error.message).not.toContain(CREDENTIAL_WS_ID);
      expect(r.error.message).not.toContain("sk-");
    }
    expect(appended.length).toBe(0); // the gate rejects BEFORE audit.append is ever called
    // The durable fail-safe OFF write happens at step (3), BEFORE the audit at step (4) — a
    // redaction-gate rejection of the AUDIT must not roll back the already-landed OFF state.
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.egressPolicy.employerRawEgressAcknowledged).toBe(false);
  });

  it("benign_revoke_still_audits_and_returns_status: a normal workspaceId ⇒ exactly one append, the UI-safe status returned intact (non-vacuity control for the gate above)", async () => {
    const WS_ID = String(benignWorkspace.id);
    const { repo, upserts } = memConfig(benignWorkspace);
    const { repo: auditRepo, appended } = memAudit();
    const port = createEgressCommandPort({ workspaceConfig: repo, audit: auditRepo, now: () => NOW });

    const r = await port.revokeEgressAck({ workspaceId: WS_ID });

    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ workspaceId: WS_ID, employerRawEgressAcknowledged: false, zeroEgressOnly: false });
    }
    expect(appended.length).toBe(1);
    expect(upserts.length).toBe(1);
  });
});
