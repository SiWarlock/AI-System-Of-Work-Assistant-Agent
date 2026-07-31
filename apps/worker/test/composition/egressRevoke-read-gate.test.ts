// Task #38, closed by 9.38 commit 2 — "does the revoke still need its own parse, given the
// read is now gated?" Established answer: NO. `egressRevoke.ts` performs no parse of its own —
// it never did — and its `deps.workspaceConfig.get()` call already flows through the 9.36
// read-boundary gate on both dialect adapters, which already classifies `stored_row_schema_
// violation` distinctly (`egressRevoke.ts:58-62`). This is the durable PIN that it STAYS gated
// (added coverage only — no behaviour change), not a prose note.
import { describe, it, expect, afterEach } from "vitest";
import { isErr, isOk, validWorkspace } from "@sow/contracts";
import type { Workspace, AuditRecord } from "@sow/contracts";
import type { WorkspaceConfigRepository, AuditRepository, DbResult } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createEgressCommandPort } from "../../src/composition/egressRevoke";

const NOW = "2026-07-30T00:00:00.000Z";
const WS_ID = String(validWorkspace.id);

// Built by CAST, not the schema (which correctly refuses to construct it) — the ONE way to get
// a corrupt row into a store. It is Workspace-SHAPED, so it "would only pass unparsed": an
// ungated read cannot tell it apart from a valid row (proven by the control test below).
const corruptWorkspace = {
  ...validWorkspace,
  egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: "some-other-workspace" },
} as unknown as Workspace;

describe("#38 — egressRevoke's workspace read stays gated through the 9.36 read-boundary", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("revoke_read_is_gated_control_an_ungated_read_would_have_passed_the_fixture_through: non-vacuity — an UNGATED read silently succeeds on the same corrupt fixture", async () => {
    // A fake repo that hands the corrupt row back UNPARSED (as if egressRevoke had its own
    // separate, ungated read) — proves the fixture is only wrong at the schema level, so the
    // real pin below is discriminating on the GATE, not on some other property of the fixture.
    const ungatedRepo: WorkspaceConfigRepository = {
      get: (): DbResult<Workspace> => Promise.resolve({ ok: true, value: corruptWorkspace }),
      list: (): DbResult<Workspace[]> => Promise.resolve({ ok: true, value: [corruptWorkspace] }),
      upsert: (w: Workspace): DbResult<Workspace> => Promise.resolve({ ok: true, value: w }),
      insertIfAbsent: () => Promise.resolve({ ok: true, value: false }),
      updateProvisioningFields: (): DbResult<Workspace> => Promise.resolve({ ok: true, value: corruptWorkspace }),
    };
    const noopAudit: AuditRepository = {
      append: (): DbResult<void> => Promise.resolve({ ok: true, value: undefined }),
      query: (): DbResult<AuditRecord[]> => Promise.resolve({ ok: true, value: [] }),
    };
    const port = createEgressCommandPort({
      workspaceConfig: ungatedRepo,
      audit: noopAudit,
      now: () => NOW,
    });
    const result = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isOk(result)).toBe(true); // silently "succeeds" — the ungated read never caught the corruption
  });

  it("revoke_read_is_gated: revokeEgressAck receives stored_row_schema_violation from the SAME corrupt fixture over the REAL dual-store adapter — never an unvalidated pass-through [pin #38]", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    // Out-of-band corruption — upsert never re-gates on write (9.36's own residual, out of
    // scope here); this models it, exactly as packages/db's own read-gate fixture does.
    await backends.repos.workspaceConfig.upsert(corruptWorkspace);

    const port = createEgressCommandPort({
      workspaceConfig: backends.repos.workspaceConfig,
      audit: backends.repos.audit,
      now: () => NOW,
    });
    const result = await port.revokeEgressAck({ workspaceId: WS_ID });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("stored_row_schema_violation");
  });
});
