// @sow/integrations — pins the CORRECTED `reason`/`adapterCode` invariant on
// `ExternalWriteResult` (see its doc comment in `src/tools/gateway.ts`).
//
// HISTORY: a prior hardening round made `reason` code-only at every
// held/conflict/rejected construction site, on the theory that an adapter
// might embed vendor/secret-shaped text. A restore-biased audit then found
// this broke real diagnosability: a 401 (re-auth), a 403 (grant the scope), a
// 429 (back off), an SSRF/allowlist block (fix endpoint config), and a locked
// Keychain (unlock it) ALL rendered as the identical string `create fault
// (rejected)`. The fix moves the sanitization duty to where foreign text
// actually ENTERS the system — the adapter boundary (adapter-port.ts's
// `AdapterError.message` contract) — rather than re-stripping it downstream at
// the gateway. This suite now pins:
//   (a) the SAFE-BY-CONSTRUCTION sites (candidate-gate rejection, credential
//       fault) still build `reason` from closed codes / fixed literals only.
//   (b) the SAFE-BY-CONTRACT sites (existence-check fault, create fault)
//       forward the adapter's `AdapterError.message` VERBATIM alongside the
//       closed `code`, using REALISTIC SoW-authored adapter messages (an HTTP-
//       status literal, a host reference, a closed credential token) — never
//       an adversarial secret-shaped message, which is now out of scope for
//       this boundary (that duty belongs to the adapter / the concrete
//       transport, e.g. write-http-transport.test.ts).
//   (c) `adapterCode` carries the closed `AdapterError.code` as a real field
//       on every one of those sites, so a caller branches on the FIELD, never
//       by parsing `reason` (the failure mode that broke notebooklm-sync.ts
//       twice — see its module header).
//   (d) the ANTI-REGRESSION pin for the whole round: five distinct failures
//       (401 / 403 / 429 / SSRF-block / locked Keychain) render as five
//       DISTINCT, actionable reasons — never the same string.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WriteReceipt, AuditRecord } from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import type { SafeToolWriteLog } from "../src/redaction/gateway-log-redaction";
import {
  dispatchExternalWrite,
  type ExternalWriteDeps,
} from "../src/tools/gateway";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import type { WriteSecretsAccessor } from "../src/tools/adapters/adapter-core";
import { InMemoryReceiptStore, makeProposedAction, makeWriteReceipt } from "./support/fakes";

// --- harness (mirrors tool-gateway.test.ts's makeHarness) --------------------

function makeAdapter(opts: {
  existence?: () => Promise<Result<ExistingObject | null, AdapterError>>;
  create?: () => Promise<Result<WriteReceipt, AdapterError>>;
}) {
  const create = vi.fn(
    opts.create ?? (async () => ok(makeWriteReceipt({ externalObjectId: "ext_created" }))),
  );
  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: vi.fn(opts.existence ?? (async () => ok(null))),
    create,
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
  return { adapter, createCalls: () => create.mock.calls.length };
}

const CLOCK = (): string => "2026-07-01T00:00:00.000Z";

function makeHarness(overrides: {
  existence?: () => Promise<Result<ExistingObject | null, AdapterError>>;
  create?: () => Promise<Result<WriteReceipt, AdapterError>>;
  secrets?: WriteSecretsAccessor;
} = {}) {
  const spies = makeAdapter({ existence: overrides.existence, create: overrides.create });
  const store = new InMemoryReceiptStore();
  const audits: AuditRecord[] = [];
  const logs: SafeToolWriteLog[] = [];
  const deps: ExternalWriteDeps = {
    adapter: spies.adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async (rec: AuditRecord) => {
      audits.push(rec);
    },
    clock: CLOCK,
    logSink: (rec: SafeToolWriteLog) => {
      logs.push(rec);
    },
    ...(overrides.secrets !== undefined ? { secrets: overrides.secrets } : {}),
  };
  return { deps, spies, store, audits, logs };
}

function envFor(action = makeProposedAction()) {
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return built.value;
}

// --- (a) safe-by-construction sites -------------------------------------------

describe("dispatchExternalWrite — safe-BY-CONSTRUCTION reason sites", () => {
  it("candidate-gate rejection (linkage mismatch): reason is the gate's own fixed, safe-by-construction message", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    // A genuinely mismatched action (never mocked) — real admitExternalWriteEnvelope
    // rejects on the linkage pin with its own fixed literal.
    const mismatchedAction = { ...action, canonicalObjectKey: "cok_drive_OTHER" };
    const h = makeHarness();

    const res = await dispatchExternalWrite(env, mismatchedAction, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("expected rejected");
    expect(res.reason).toBe(
      "envelope does not match the originating ProposedAction (actionId/targetSystem/canonicalObjectKey/idempotencyKey)",
    );
    // No AdapterError was involved — adapterCode is absent, not a stray value.
    expect(res.adapterCode).toBeUndefined();
  });

  it("credential fault (locked Keychain): reason still names the closed 'locked' token — this is the SAFE direction, untouched", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const secrets: WriteSecretsAccessor = {
      getSecret: async () => err({ reason: "locked" }),
    };
    const h = makeHarness({ secrets });

    const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("held");
    if (res.status !== "held") throw new Error("expected held");
    expect(res.reason).toBe("write credential unavailable: locked");
    expect(res.reason).not.toContain("keychain://");
    // Not an AdapterError-originated fault — no adapterCode.
    expect(res.adapterCode).toBeUndefined();
  });
});

// --- (b) safe-by-contract sites: the adapter message is now FORWARDED --------

describe("dispatchExternalWrite — safe-BY-CONTRACT sites forward the adapter's structured message + adapterCode", () => {
  it("existence-check fault: reason carries the closed code AND the adapter's structured message; adapterCode is set", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      existence: async () => err<AdapterError>({ code: "unreachable", message: "HTTP 503" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("held");
    if (res.status !== "held") throw new Error("expected held");
    expect(res.reason).toBe("existence-check unreachable: HTTP 503");
    expect(res.adapterCode).toBe("unreachable");
  });

  it("create fault 'conflict': reason carries the code + message; adapterCode is set", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "conflict", message: "HTTP 409" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") throw new Error("expected conflict");
    expect(res.reason).toBe("create fault (conflict): HTTP 409");
    expect(res.adapterCode).toBe("conflict");
  });

  it("create fault 'unreachable': reason carries the code + message; adapterCode is set", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "unreachable", message: "HTTP 503" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("held");
    if (res.status !== "held") throw new Error("expected held");
    expect(res.reason).toBe("create fault (unreachable): HTTP 503");
    expect(res.adapterCode).toBe("unreachable");
  });

  it("create fault 'rejected': reason carries the code + message; adapterCode is set", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "rejected", message: "HTTP 400" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("expected rejected");
    expect(res.reason).toBe("create fault (rejected): HTTP 400");
    expect(res.adapterCode).toBe("rejected");
  });
});

// --- (d) THE anti-regression pin for the whole round --------------------------

describe("dispatchExternalWrite — five distinct failures render five DISTINCT, actionable reasons", () => {
  it("401 / 403 / 429 / SSRF-block / locked-Keychain never collapse to the same string", async () => {
    const action = makeProposedAction();

    async function dispatchWith(opts: {
      create?: () => Promise<Result<WriteReceipt, AdapterError>>;
      secrets?: WriteSecretsAccessor;
    }): Promise<{ status: string; reason?: string; adapterCode?: string }> {
      const env = envFor(action);
      const h = makeHarness(opts);
      const res = await dispatchExternalWrite(env, action, h.deps, { workspaceId: "personal-business" });
      return res as { status: string; reason?: string; adapterCode?: string };
    }

    // 401 — re-authenticate. 403 — grant the missing scope. 429 — back off and
    // retry later. All three share the transport's `statusToFault` mapping
    // (write-http-transport.ts): every non-409/412 4xx is `code: "rejected"`,
    // so `code` alone CANNOT distinguish them — only `message` can.
    const unauthorized = await dispatchWith({
      create: async () => err<AdapterError>({ code: "rejected", message: "HTTP 401" }),
    });
    const forbidden = await dispatchWith({
      create: async () => err<AdapterError>({ code: "rejected", message: "HTTP 403" }),
    });
    const rateLimited = await dispatchWith({
      create: async () => err<AdapterError>({ code: "rejected", message: "HTTP 429" }),
    });
    // SSRF/allowlist block — the write-http-transport's SSRF guard reports a
    // redaction-safe HOST REFERENCE (endpointHostRef), not an HTTP status, but
    // is still `code: "rejected"` (write-http-transport.ts step 1/2).
    const ssrfBlocked = await dispatchWith({
      create: async () => err<AdapterError>({ code: "rejected", message: "blocked-endpoint.example" }),
    });
    // Locked Keychain — a DIFFERENT status ("held", via the gateway's own
    // credential seam) but must still be distinguishable in prose from the
    // four "rejected" cases above.
    const lockedKeychain = await dispatchWith({
      secrets: { getSecret: async () => err({ reason: "locked" }) },
    });

    const reasons = [unauthorized, forbidden, rateLimited, ssrfBlocked, lockedKeychain].map(
      (r) => r.reason,
    );

    // All five reasons are distinct — MUTATION-PROVE: collapsing any one of
    // these back to a fixed code-keyed string (e.g. `create fault (rejected)`
    // for all four "rejected" cases) shrinks this Set below 5 and fails here.
    expect(new Set(reasons).size).toBe(5);

    // Each reason names the actionable detail an operator needs.
    expect(unauthorized.reason).toContain("401");
    expect(forbidden.reason).toContain("403");
    expect(rateLimited.reason).toContain("429");
    expect(ssrfBlocked.reason).toContain("blocked-endpoint.example");
    expect(lockedKeychain.reason).toContain("locked");

    // The four vendor-driven faults DO share the same adapterCode — proving
    // `code` alone is genuinely insufficient and `message` is load-bearing,
    // not incidental.
    expect(unauthorized.adapterCode).toBe("rejected");
    expect(forbidden.adapterCode).toBe("rejected");
    expect(rateLimited.adapterCode).toBe("rejected");
    expect(ssrfBlocked.adapterCode).toBe("rejected");
    // The locked-Keychain path never touches an AdapterError at all (it's
    // the gateway's own pre-dispatch credential seam) — no adapterCode.
    expect(lockedKeychain.adapterCode).toBeUndefined();
  });
});
