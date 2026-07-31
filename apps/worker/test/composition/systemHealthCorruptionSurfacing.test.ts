// Task 9.38 — the unmet third of 9.36's Option-A refinement: a corrupt stored Workspace row
// (`stored_row_schema_violation`) is produced and correctly fail-closed, but NO diagnostic
// consumer could REPORT it — `boot.ts`'s `egressStatus` folded it into the SAME generic
// fail-closed value as `not_found` or a thrown outage (contracts L106 — a capability, not a
// guarantee). These pins prove the fix: a corrupt row now mints a distinct, code-only System-
// Health item — via the SAME `backends.healthItems` persistent store the degraded controller's
// surface already binds — while every policy/egress consumer's RETURNED posture stays
// byte-identical on every branch (the hard constraint: visibility must never trade for
// weakened fail-closed behaviour).
import { describe, it, expect, afterEach } from "vitest";
import { isOk, validWorkspace } from "@sow/contracts";
import type { Workspace } from "@sow/contracts";
import type { WorkspaceConfigRepository } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createSystemHealthQueryPort } from "../../src/boot";
import { router, createCallerFactory, type ApiContext } from "../../src/api/trpc";
import { buildSystemHealthRouter } from "../../src/api/procedures/systemHealth";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };

// Built by CAST, not the schema (which correctly refuses to construct it) — mirrors
// packages/db's own 9.36 read-gate fixture. `upsert` never re-gates on write (out of scope
// here; 9.29's residual), so this is the one way to get a corrupt row into a REAL store.
// `egressPolicyOverrides` lets a caller plant a marker INSIDE egressPolicy itself (not just a
// top-level field) — the highest-risk leak surface for safety rule 7, since the Zod violation
// causing the corruption is commonly IN that sub-object.
function corruptWorkspace(
  overrides: Partial<Workspace> = {},
  egressPolicyOverrides: Record<string, unknown> = {},
): Workspace {
  return {
    ...validWorkspace,
    ...overrides,
    egressPolicy: {
      ...validWorkspace.egressPolicy,
      workspaceId: "some-other-workspace",
      ...egressPolicyOverrides,
    },
  } as unknown as Workspace;
}

describe("9.38 — a corrupt stored workspace row surfaces to System Health, fail-closed unchanged", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("corrupt_row_is_distinguishable_from_absent: a corrupt row mints a System-Health item; an absent (not_found) workspace mints none [spec(§16)]", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const CORRUPT_WS = String(validWorkspace.id);
    const ABSENT_WS = "never-provisioned-ws";
    await backends.repos.workspaceConfig.upsert(corruptWorkspace());
    const port = createSystemHealthQueryPort(backends);

    const corruptStatus = await port.egressStatus(CORRUPT_WS);
    const absentStatus = await port.egressStatus(ABSENT_WS);
    expect(isOk(corruptStatus)).toBe(true);
    expect(isOk(absentStatus)).toBe(true);

    const itemsResult = await port.healthItems();
    expect(isOk(itemsResult)).toBe(true);
    if (!isOk(itemsResult)) return;
    // Non-vacuity: exactly one item exists, and it is the corrupt workspace's — the absent
    // workspace mints NOTHING, so the two states are distinguishable at this surface.
    expect(itemsResult.value).toHaveLength(1);
    expect(itemsResult.value[0]?.id).toContain(CORRUPT_WS);
    expect(itemsResult.value[0]?.id).not.toContain(ABSENT_WS);
    expect(itemsResult.value[0]?.failureClass).toBe("schema_rejection");
  });

  it("corrupt_row_is_distinguishable_from_outage: a thrown/transient store fault mints NO corruption item — only stored_row_schema_violation does [spec(§16)]", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const OUTAGE_WS = "outage-ws";
    const throwingConfig: WorkspaceConfigRepository = {
      ...backends.repos.workspaceConfig,
      get: (id: Workspace["id"]) => {
        if (String(id) === OUTAGE_WS) throw new Error("simulated store outage — must be caught, never crosses");
        return backends.repos.workspaceConfig.get(id);
      },
    };
    const port = createSystemHealthQueryPort({
      ...backends,
      repos: { ...backends.repos, workspaceConfig: throwingConfig },
    });

    const status = await port.egressStatus(OUTAGE_WS);
    expect(isOk(status)).toBe(true); // fail-closed, unchanged (re-asserted non-vacuously in the next test)

    const itemsResult = await port.healthItems();
    expect(isOk(itemsResult)).toBe(true);
    if (!isOk(itemsResult)) return;
    expect(itemsResult.value.find((i) => i.id.includes(OUTAGE_WS))).toBeUndefined();
  });

  it("fail_closed_is_unchanged_on_corruption: egressStatus's returned posture is BYTE-IDENTICAL to the fail-closed default on absent, corrupt, AND outage [⛔ safety rule 5 — the hard constraint]", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const CORRUPT_WS = String(validWorkspace.id);
    const ABSENT_WS = "never-provisioned-ws";
    const OUTAGE_WS = "outage-ws";
    await backends.repos.workspaceConfig.upsert(corruptWorkspace());
    const throwingConfig: WorkspaceConfigRepository = {
      ...backends.repos.workspaceConfig,
      get: (id: Workspace["id"]) => {
        if (String(id) === OUTAGE_WS) throw new Error("simulated store outage");
        return backends.repos.workspaceConfig.get(id);
      },
    };
    const port = createSystemHealthQueryPort({
      ...backends,
      repos: { ...backends.repos, workspaceConfig: throwingConfig },
    });

    const expected = (wsId: string): unknown => ({
      workspaceId: wsId,
      employerRawEgressAcknowledged: false,
      zeroEgressOnly: false,
    });
    const absent = await port.egressStatus(ABSENT_WS);
    const corrupt = await port.egressStatus(CORRUPT_WS);
    const outage = await port.egressStatus(OUTAGE_WS);
    expect(isOk(absent) && absent.value).toEqual(expected(ABSENT_WS));
    expect(isOk(corrupt) && corrupt.value).toEqual(expected(CORRUPT_WS));
    expect(isOk(outage) && outage.value).toEqual(expected(OUTAGE_WS));
  });

  it("surfaced_state_carries_no_policy_content: the corruption item's message + the UI-safe projection carry the code only — no raw workspace field values cross, INCLUDING a marker planted inside egressPolicy itself [safety rule 7]", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const MARKER = "SECRET-MARKER-workspace-9f21";
    // The highest-risk leak surface: a marker INSIDE egressPolicy (the sub-object whose Zod
    // violation is commonly what causes the corruption in the first place — a validation error
    // commonly embeds the failing path + value). A marker in `name` alone would only prove the
    // projection doesn't echo `name`, not that it doesn't echo POLICY content.
    const POLICY_MARKER = "SECRET-MARKER-egresspolicy-df8e2";
    const CORRUPT_WS = String(validWorkspace.id);
    await backends.repos.workspaceConfig.upsert(
      corruptWorkspace({ name: MARKER } as Partial<Workspace>, { acknowledgedAt: POLICY_MARKER }),
    );
    const port = createSystemHealthQueryPort(backends);
    await port.egressStatus(CORRUPT_WS);

    const itemsResult = await port.healthItems();
    expect(isOk(itemsResult)).toBe(true);
    if (!isOk(itemsResult)) return;
    const item = itemsResult.value.find((i) => i.id.includes(CORRUPT_WS));
    expect(item).toBeDefined();
    expect(JSON.stringify(item)).not.toContain(MARKER);
    expect(JSON.stringify(item)).not.toContain(POLICY_MARKER);

    // The UI-safe projection is what actually crosses the API boundary — assert there too.
    const appRouter = router({ systemHealth: buildSystemHealthRouter({ systemHealth: port }) });
    const caller = createCallerFactory(appRouter)(AUTHED_CTX);
    const uiSafeRes = await caller.systemHealth.items();
    expect(JSON.stringify(uiSafeRes)).not.toContain(MARKER);
    expect(JSON.stringify(uiSafeRes)).not.toContain(POLICY_MARKER);
  });

  it("corruption_poll_does_not_accumulate_unbounded_items: polling egressStatus on the SAME corrupt workspace twice mints exactly ONE item (keyed-upsert on subjectRef, never an append)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const CORRUPT_WS = String(validWorkspace.id);
    await backends.repos.workspaceConfig.upsert(corruptWorkspace());
    const port = createSystemHealthQueryPort(backends);

    await port.egressStatus(CORRUPT_WS);
    await port.egressStatus(CORRUPT_WS); // a second "poll" of the same corrupt row

    const itemsResult = await port.healthItems();
    expect(isOk(itemsResult)).toBe(true);
    if (!isOk(itemsResult)) return;
    const matching = itemsResult.value.filter((i) => i.id.includes(CORRUPT_WS));
    expect(matching).toHaveLength(1); // dedupe on (failureClass, subjectRef) — not one row per read
  });
});
