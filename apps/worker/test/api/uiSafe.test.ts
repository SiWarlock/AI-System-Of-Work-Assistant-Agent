// Task 8.2 — UI-safe projection / redaction boundary (WS-8 / §10 leakage gate)
// + the tRPC server bootstrap's typed-error posture. TDD RED-first spec.
//
// SECURITY-CRITICAL. The projectors in `src/api/projections/uiSafe.ts` are the
// SINGLE boundary where a frozen domain record becomes a renderer-visible shape.
// They MUST copy ONLY the field names in the checked-in `UI_SAFE_ALLOWLIST`
// (from @sow/contracts) — never a secret, a Keychain ref, raw Employer-Work
// content, a provider prompt, an `AgentResult.logs`, or ANY non-allowlisted
// field. A field that is present on the domain record but absent from the
// allowlist must NOT appear on the projected object, even when an ADVERSARIAL
// caller injects an extra sensitive key onto the input.
//
// The second half pins the §16 tRPC posture: a procedure surfaces a typed
// `Result<T, FailureVariant>` as its DATA (an err carries the failure; the call
// does not throw across the API boundary), and an unauthenticated call is
// rejected pre-resolver by the 8.1 interceptor without leaking why.
import { describe, it, expect } from "vitest";
import {
  UI_SAFE_ALLOWLIST,
  isErr,
  isOk,
  type Approval,
  type HealthItem,
  type WorkflowRunRef,
  type GclProjection,
  type FailureVariant,
  type Result,
} from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import {
  toUiSafeApproval,
  toUiSafeHealthItem,
  toUiSafeWorkflowRunRef,
  toUiSafeDashboardCard,
  toUiSafeGclProjection,
  type DashboardCardSource,
} from "../../src/api/projections/uiSafe";
import { createApiServer } from "../../src/api/server";
import { createFixtureRetrieval, createStubSynthesis } from "../../src/api/procedures/copilot";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";

// The SORTED field-name set actually present on a projected object.
function fieldSet(obj: object): string[] {
  return Object.keys(obj).sort();
}

// Read an arbitrary (possibly-absent) key off a projected object — through
// `unknown` so strict TS does not object to inspecting a non-declared name (the
// WHOLE point of these tests is to assert non-allowlisted names are ABSENT).
function asRecord(obj: object): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

// A base VALID Approval (all frozen fields present).
function baseApproval(): Approval {
  return {
    id: "apr_1" as Approval["id"],
    actionRef: "act_1" as Approval["actionRef"],
    status: "pending",
    actor: "user:alice", // DROPPED — approving-principal identity
    channel: "mac",
    payloadHash: "sha256:deadbeef", // DROPPED — content-derived hash
    snoozeUntil: undefined,
    expiresAt: "2026-07-02T12:00:00.000Z",
  };
}

function baseHealthItem(): HealthItem {
  return {
    id: "hi_1",
    failureClass: "connector_unreachable",
    severity: "warn",
    message: "raw provider stderr: secret-token=hunter2", // DROPPED — may echo raw content/secret
    auditRef: "aud_1" as HealthItem["auditRef"],
    openedAt: "2026-07-02T10:00:00.000Z",
    state: "open",
    resolvedAt: undefined,
    parityReportRef: undefined,
    factIdentity: undefined,
  };
}

function baseWorkflowRunRef(): WorkflowRunRef {
  return {
    workflowId: "wf_1" as WorkflowRunRef["workflowId"],
    trigger: "manual",
    state: "running",
    idempotencyKey: "idem_1",
    auditRefs: ["aud_1" as WorkflowRunRef["auditRefs"][number]], // DROPPED — internal audit trail
  };
}

function baseDashboardCard(): DashboardCardSource {
  return {
    cardId: "card_1",
    kind: "approvals",
    title: "Pending approvals",
    status: "warn",
    count: 3,
    updatedAt: "2026-07-02T11:00:00.000Z",
  };
}

describe("toUiSafeApproval — WS-8 field allowlist", () => {
  it("projects EXACTLY the allowlisted Approval field set", () => {
    const out = toUiSafeApproval(baseApproval());
    // Optional undefined fields are omitted, so compare against the subset that
    // is a SUBSET of the allowlist — never a SUPERSET.
    const allowed: readonly string[] = UI_SAFE_ALLOWLIST.approval;
    expect(fieldSet(out).every((k) => allowed.includes(k))).toBe(true);
    // Every REQUIRED allowlisted field is present.
    for (const req of ["id", "actionRef", "status", "channel"]) {
      expect(out).toHaveProperty(req);
    }
  });

  it("does NOT leak the dropped sensitive fields (actor, payloadHash)", () => {
    const out = asRecord(toUiSafeApproval(baseApproval()));
    expect(out).not.toHaveProperty("actor");
    expect(out).not.toHaveProperty("payloadHash");
  });

  it("does NOT leak an ADVERSARIALLY-injected extra key (secret)", () => {
    // A malicious/over-broad upstream record carries an EXTRA sensitive field.
    // The projector copies only allowlisted names, so the secret cannot ride out.
    const tainted = {
      ...baseApproval(),
      secret: "kc-ref://keychain/session-token",
      __proto_leak: "raw employer content",
    } as unknown as Approval;
    const out = asRecord(toUiSafeApproval(tainted));
    expect(out).not.toHaveProperty("secret");
    expect(out).not.toHaveProperty("__proto_leak");
    // Field set is still a subset of the allowlist — nothing extra leaked.
    const allowed: readonly string[] = UI_SAFE_ALLOWLIST.approval;
    expect(fieldSet(out).every((k) => allowed.includes(k))).toBe(true);
  });
});

describe("toUiSafeHealthItem — WS-8 field allowlist", () => {
  it("projects a subset of the allowlisted HealthItem field set", () => {
    const out = toUiSafeHealthItem(baseHealthItem());
    const allowed: readonly string[] = UI_SAFE_ALLOWLIST.healthItem;
    expect(fieldSet(out).every((k) => allowed.includes(k))).toBe(true);
    for (const req of ["id", "failureClass", "severity", "state", "openedAt"]) {
      expect(out).toHaveProperty(req);
    }
  });

  it("does NOT leak `message` (raw content), auditRef, or refs", () => {
    const out = asRecord(toUiSafeHealthItem(baseHealthItem()));
    expect(out).not.toHaveProperty("message");
    expect(out).not.toHaveProperty("auditRef");
    expect(out).not.toHaveProperty("parityReportRef");
    expect(out).not.toHaveProperty("factIdentity");
  });

  it("does NOT leak an ADVERSARIALLY-injected raw message/prompt field", () => {
    const tainted = {
      ...baseHealthItem(),
      rawPrompt: "You are a helpful assistant. Secret system prompt...",
      logs: ["provider log line with token"],
    } as unknown as HealthItem;
    const out = asRecord(toUiSafeHealthItem(tainted));
    expect(out).not.toHaveProperty("rawPrompt");
    expect(out).not.toHaveProperty("logs");
    const allowed: readonly string[] = UI_SAFE_ALLOWLIST.healthItem;
    expect(fieldSet(out).every((k) => allowed.includes(k))).toBe(true);
  });
});

describe("toUiSafeWorkflowRunRef — WS-8 field allowlist", () => {
  it("projects EXACTLY the allowlisted WorkflowRunRef field set", () => {
    const out = toUiSafeWorkflowRunRef(baseWorkflowRunRef());
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.workflowRunRef].sort());
  });

  it("does NOT leak the internal audit trail (auditRefs)", () => {
    const out = asRecord(toUiSafeWorkflowRunRef(baseWorkflowRunRef()));
    expect(out).not.toHaveProperty("auditRefs");
  });

  it("does NOT leak an ADVERSARIALLY-injected extra key", () => {
    const tainted = {
      ...baseWorkflowRunRef(),
      internalNotes: "raw employer content",
    } as unknown as WorkflowRunRef;
    const out = asRecord(toUiSafeWorkflowRunRef(tainted));
    expect(out).not.toHaveProperty("internalNotes");
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.workflowRunRef].sort());
  });
});

describe("toUiSafeDashboardCard — WS-8 field allowlist", () => {
  it("projects EXACTLY the allowlisted DashboardCard field set", () => {
    const out = toUiSafeDashboardCard(baseDashboardCard());
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.dashboardCard].sort());
  });

  it("does NOT leak an ADVERSARIALLY-injected extra key", () => {
    const tainted = {
      ...baseDashboardCard(),
      secretPayload: "kc-ref://...",
    } as unknown as DashboardCardSource;
    const out = asRecord(toUiSafeDashboardCard(tainted));
    expect(out).not.toHaveProperty("secretPayload");
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.dashboardCard].sort());
  });
});

// ── tRPC server bootstrap — typed-error posture (§16) ────────────────────────

function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
const WRONG: SessionToken = mintSessionToken(fixedRng(0xcd));
const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173"],
  hosts: ["localhost:5173"],
};

// The MOUNT wave extended `ApiServerDeps` with the query/command/systemHealth
// router ports. These bootstrap tests exercise ONLY `health.ping` + the auth
// boundary, so the router ports are empty no-op fakes — the mounted routers are
// present (proving composition) but never called by these cases. A typed `err`
// keeps every fake §16-safe if a resolver ever did reach one.
const emptyErr: Result<never, FailureVariant> = {
  ok: false,
  error: { kind: "validation_rejected", message: "unwired-in-test", retryable: false },
};
function makeServerDeps(over: { expectedToken?: SessionToken } = {}) {
  return {
    expectedToken: over.expectedToken ?? EXPECTED,
    allowlist: ALLOWLIST,
    readModel: {
      dashboardCards: () => emptyErr,
      workspaceCards: () => emptyErr,
      projectCards: () => emptyErr,
      ingestionInbox: () => emptyErr,
      approvalInbox: () => emptyErr,
      copilotSurface: () => emptyErr,
      globalSurface: () => emptyErr,
      recentChanges: () => emptyErr,
      projectDashboards: () => emptyErr,
    },
    // Copilot ask backend — never exercised by these serving tests; empty fixtures fail closed.
    copilot: {
      retrieval: createFixtureRetrieval({}),
      synthesis: createStubSynthesis(),
    },
    systemHealth: {
      healthItems: () => emptyErr,
      egressStatus: () => emptyErr,
    },
    approvals: {
      get: () => Promise.resolve({ ok: false, error: { code: "not_found", message: "unwired" } } as never),
      applyTransition: () =>
        Promise.resolve({ ok: false, error: { code: "not_found", message: "unwired" } } as never),
    },
    dispatchApproval: () => Promise.resolve({ ok: true, value: undefined } as never),
    triage: {
      reenterIngestion: (input: { idempotencyKey: string }) =>
        Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } } as never),
    },
    now: () => "2026-07-02T00:00:00.000Z",
  };
}

function baseGclProjection(over: Record<string, unknown> = {}): GclProjection {
  return {
    workspaceId: "ws-employer",
    visibilityLevel: "sanitized",
    projectionType: "deadlines",
    sanitizedPayload: { headline: "2 deadlines this week", count: 2 },
    sourceRefs: [{ sourceId: "src-1" }],
    ...over,
  } as unknown as GclProjection;
}

describe("toUiSafeGclProjection — WS-8 field allowlist + drill gate", () => {
  it("projects EXACTLY the allowlisted GclProjection field set", () => {
    const out = toUiSafeGclProjection(baseGclProjection());
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.gclProjection].sort());
  });

  it("NEVER leaks sanitizedPayload (open record) or sourceRefs (internal refs), even with an adversarial extra key", () => {
    // Adversarial: a secret-shaped extra key injected onto the source record.
    const tainted = baseGclProjection({ secretToken: "sk-DEADBEEF" });
    const out = asRecord(toUiSafeGclProjection(tainted));
    expect(fieldSet(out)).toEqual([...UI_SAFE_ALLOWLIST.gclProjection].sort());
    expect(out["sanitizedPayload"]).toBeUndefined();
    expect(out["sourceRefs"]).toBeUndefined();
    expect(out["secretToken"]).toBeUndefined();
  });

  it("derives `drillable` from the shared visibility gate — true ONLY at 'full'", () => {
    expect(toUiSafeGclProjection(baseGclProjection({ visibilityLevel: "full" })).drillable).toBe(true);
    expect(toUiSafeGclProjection(baseGclProjection({ visibilityLevel: "sanitized" })).drillable).toBe(false);
    expect(toUiSafeGclProjection(baseGclProjection({ visibilityLevel: "coordination" })).drillable).toBe(false);
    expect(toUiSafeGclProjection(baseGclProjection({ visibilityLevel: "isolated" })).drillable).toBe(false);
  });

  it("builds a NON-EMPTY SINGLE-LINE summary; falls back to projectionType when the payload has no scalar", () => {
    const s1 = toUiSafeGclProjection(baseGclProjection()).summary;
    expect(s1.length).toBeGreaterThan(0);
    expect(/[\r\n]/.test(s1)).toBe(false);
    // An empty payload must NOT yield an empty summary (the UI-safe schema requires min 1).
    expect(toUiSafeGclProjection(baseGclProjection({ sanitizedPayload: {} })).summary).toBe("deadlines");
  });
});

describe("createApiServer — typed-error boundary (§16)", () => {
  it("exposes a caller factory + the composed appRouter", () => {
    const server = createApiServer(makeServerDeps());
    expect(typeof server.createCaller).toBe("function");
    expect(server.appRouter).toBeDefined();
  });

  it("a health-probe procedure returns a typed Result ok, never throwing", async () => {
    const server = createApiServer(makeServerDeps());
    const caller = server.createCaller({
      token: EXPECTED.value,
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    const r: Result<{ ready: true }, FailureVariant> = await caller.health.ping();
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.ready).toBe(true);
  });

  it("an unauthenticated call is rejected as a typed err(FailureVariant), NOT a raw throw", async () => {
    const server = createApiServer(makeServerDeps());
    const caller = server.createCaller({
      token: WRONG.value, // wrong token ⇒ interceptor rejects pre-resolver
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    // The call must resolve (not reject/throw across the boundary) with a typed err.
    const r: Result<unknown, FailureVariant> = await caller.health.ping();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.message).toBe("unauthenticated");
      // Redaction-safe: the presented/expected secret never enters the failure.
      expect(JSON.stringify(r.error)).not.toContain(WRONG.value);
      expect(JSON.stringify(r.error)).not.toContain(EXPECTED.value);
    }
  });

  it("a wrong-Origin call is rejected as a typed err (FORBIDDEN-equivalent), not a throw", async () => {
    const server = createApiServer(makeServerDeps());
    const caller = server.createCaller({
      token: EXPECTED.value,
      origin: "http://evil.com",
      host: "localhost:5173",
    });
    const r: Result<unknown, FailureVariant> = await caller.health.ping();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });
});
