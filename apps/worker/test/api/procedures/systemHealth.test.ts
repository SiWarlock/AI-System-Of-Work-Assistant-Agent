// Task 8.3 — System Health query surface (OBS-2 typed HealthItems as UiSafeHealthItem,
// audit-linked ref only; REQ-S-002 Employer-Work egress status). TDD RED-first.
//
// The System Health query surfaces the OBS-2 typed HealthItems (open / acknowledged
// / resolved) as UiSafeHealthItem — audit-linked but ref-only, NEVER raw: the
// projection DROPS `message`, `auditRef`, `parityReportRef`, `factIdentity`. The
// Employer-Work egress status (REQ-S-002) is surfaced here / via workspace settings.
import { describe, it, expect } from "vitest";
import {
  UI_SAFE_ALLOWLIST,
  isErr,
  isOk,
  ok,
  err,
  failure,
  type Result,
  type FailureVariant,
  type HealthItem,
} from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";
import {
  buildSystemHealthRouter,
  type SystemHealthQueryPort,
} from "../../../src/api/procedures/systemHealth";

function fieldSet(obj: object): string[] {
  return Object.keys(obj).sort();
}
function asRecord(obj: object): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

const AUTHED_CTX: ApiContext = {
  auth: ok<AuthedContext>({ authenticated: true }),
};

function fakeHealthItem(state: HealthItem["state"], resolvedAt?: string): HealthItem {
  return {
    id: `hi_${state}`,
    failureClass: "connector_unreachable",
    severity: "warn",
    message: "raw provider error text — must never reach the renderer", // DROPPED
    auditRef: "aud_1" as HealthItem["auditRef"], // DROPPED (ref only, never inlined)
    openedAt: "2026-06-30T00:00:00.000Z",
    state,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    parityReportRef: "rep_1" as HealthItem["parityReportRef"], // DROPPED
    factIdentity: "fact_1" as HealthItem["factIdentity"], // DROPPED
  };
}

const KNOWN_WORKSPACE = "ws_employer";
const UNKNOWN_WORKSPACE = "ws_missing";

function fakePort(overrides: Partial<SystemHealthQueryPort> = {}): SystemHealthQueryPort {
  const base: SystemHealthQueryPort = {
    healthItems: (): Result<readonly HealthItem[], FailureVariant> =>
      ok([
        fakeHealthItem("open"),
        fakeHealthItem("acknowledged"),
        fakeHealthItem("resolved", "2026-06-30T01:00:00.000Z"),
      ]),
    egressStatus: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok({
            workspaceId,
            employerRawEgressAcknowledged: false,
            zeroEgressOnly: true,
          })
        : err(
            failure("validation_rejected", "workspace not found", {
              cause: { code: "WORKSPACE_NOT_FOUND" },
            }),
          ),
  };
  return { ...base, ...overrides };
}

function makeCaller(port: SystemHealthQueryPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ health: buildSystemHealthRouter({ systemHealth: port }) });
  const factory = createCallerFactory(appRouter);
  return factory(ctx);
}

describe("buildSystemHealthRouter — OBS-2 typed HealthItems as UiSafeHealthItem", () => {
  it("returns typed health items across open / acknowledged / resolved states", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.map((h) => h.state).sort()).toEqual([
        "acknowledged",
        "open",
        "resolved",
      ]);
    }
  });

  it("projects each item to UI-safe fields ONLY (message / auditRef / parityReportRef / factIdentity dropped)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      for (const item of res.value) {
        // A resolved item carries the optional `resolvedAt`; open/acknowledged do
        // not — so the field set is a SUBSET of the allowlist, never a superset.
        const allowed = new Set<string>(UI_SAFE_ALLOWLIST.healthItem);
        for (const name of fieldSet(item)) {
          expect(allowed.has(name)).toBe(true);
        }
        // The audit link is ref-only — the raw internal refs never inline.
        expect(asRecord(item).auditRef).toBeUndefined();
        expect(asRecord(item).parityReportRef).toBeUndefined();
        expect(asRecord(item).factIdentity).toBeUndefined();
        // The raw message (may echo content/secret) never crosses.
        expect(asRecord(item).message).toBeUndefined();
      }
    }
  });

  it("a resolved item carries resolvedAt; an open item omits it", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    if (isOk(res)) {
      const open = res.value.find((h) => h.state === "open")!;
      const resolved = res.value.find((h) => h.state === "resolved")!;
      expect(asRecord(open).resolvedAt).toBeUndefined();
      expect(resolved.resolvedAt).toBeDefined();
    }
  });
});

describe("buildSystemHealthRouter — Employer-Work egress status (REQ-S-002)", () => {
  it("surfaces the egress-acknowledgment status for a KNOWN workspace", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.egressStatus({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(KNOWN_WORKSPACE);
      expect(res.value.employerRawEgressAcknowledged).toBe(false);
      expect(res.value.zeroEgressOnly).toBe(true);
    }
  });

  it("an UNKNOWN workspace returns a typed not-found err, never a partial leak", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.egressStatus({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("validation_rejected");
      expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("an over-broad port result cannot leak extra fields — only the allowlisted egress fields cross", async () => {
    // A port (or a future @sow/db binding) that returns an OVER-BROAD object with
    // an extra, non-UI-safe key must not ride that key out to the renderer. The
    // procedure reconstructs the egress status from ONLY the allowlisted fields.
    const leakyValue = {
      workspaceId: KNOWN_WORKSPACE,
      employerRawEgressAcknowledged: true,
      zeroEgressOnly: false,
      // Adversarial extra keys the port must NOT be able to leak through.
      rawEmployerContent: "secret quarterly numbers",
      keychainRef: "kc-ref://keychain/session-token",
    };
    const leakyPort = fakePort({
      egressStatus: () =>
        ok(leakyValue) as ReturnType<SystemHealthQueryPort["egressStatus"]>,
    });
    const caller = makeCaller(leakyPort);
    const res = await caller.health.egressStatus({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // Only the three allowlisted fields cross — the injected keys are gone.
      expect(fieldSet(res.value)).toEqual([
        "employerRawEgressAcknowledged",
        "workspaceId",
        "zeroEgressOnly",
      ]);
      expect(asRecord(res.value).rawEmployerContent).toBeUndefined();
      expect(asRecord(res.value).keychainRef).toBeUndefined();
      // The allowlisted values are preserved verbatim.
      expect(res.value.workspaceId).toBe(KNOWN_WORKSPACE);
      expect(res.value.employerRawEgressAcknowledged).toBe(true);
      expect(res.value.zeroEgressOnly).toBe(false);
    }
  });
});

describe("buildSystemHealthRouter — §16 boundary", () => {
  it("a port that THROWS is converted to a typed degraded err, never crossing the boundary", async () => {
    const caller = makeCaller(
      fakePort({
        healthItems: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await caller.health.items();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("degraded_unavailable");
      expect(res.error.message).not.toContain("boom");
    }
  });
});
