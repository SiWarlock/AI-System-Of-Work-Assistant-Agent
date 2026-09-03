// spec(§8, §20.1, LIFE-3) — slice 7.3 external-write-ENVELOPE REUSE on resume.
//
// The ACTIVITY re-drives an external side effect through the §8 Tool Gateway
// (dispatchExternalWrite from @sow/integrations) REUSING THE SAME
// ExternalWriteEnvelope (idempotencyKey + canonicalObjectKey + payloadHash). The
// gateway's stored-receipt replay gate + mandatory pre-write existence check
// guarantee a re-driven step performs NO duplicate external write: when a receipt
// for the envelope already exists the gateway returns `reused` and adapter.create
// is NEVER called again — mirroring the Phase-6 replay guarantee.
//
// This is an ACTIVITY (activities/**): it MAY use adapters. All gateway deps are
// INJECTED (a fake TargetWriteAdapter + an in-memory ReceiptStore) so the test
// needs no Temporal server and no network.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  WriteReceipt,
  TargetSystem,
} from "@sow/contracts";
import { reuseExternalWriteOnResume } from "../src/activities/envelopeReuse";
import type { EnvelopeReuseDeps } from "../src/activities/envelopeReuse";
import { createTodoistWriteAdapter } from "@sow/integrations";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
  WriteSecretsAccessor,
  AdapterTransport,
  TransportResponse,
  TransportFault,
  TransportOp,
} from "@sow/integrations";
import type { ReceiptStore, ReceiptRecord, ReceiptReservation } from "@sow/integrations";

const TS: TargetSystem = "todoist" as TargetSystem;

function makeEnvelope(): ExternalWriteEnvelope {
  return {
    actionId: "action-1" as ExternalWriteEnvelope["actionId"],
    targetSystem: TS,
    canonicalObjectKey: "todoist:task:resume-1",
    idempotencyKey: "idem-resume-1",
    preconditions: ["exists_check"],
    payloadHash: "hash-abc",
  };
}

function makeAction(): ProposedAction {
  return {
    actionId: "action-1" as ProposedAction["actionId"],
    targetSystem: TS,
    canonicalObjectKey: "todoist:task:resume-1",
    payload: { title: "resume me" },
    approvalPolicy: "auto_allow",
    idempotencyKey: "idem-resume-1",
  };
}

// A minimal in-memory ReceiptStore for the reuse path (mirrors the gateway fakes).
class FakeReceiptStore implements ReceiptStore {
  private byIdem = new Map<string, ReceiptRecord>();
  private byObj = new Map<string, ReceiptRecord>();
  seed(record: ReceiptRecord): void {
    this.byIdem.set(record.idempotencyKey, record);
    this.byObj.set(`${record.targetSystem}::${record.canonicalObjectKey}`, record);
  }
  getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined> {
    return Promise.resolve(this.byIdem.get(k));
  }
  getByCanonicalObjectKey(t: TargetSystem, k: string): Promise<ReceiptRecord | undefined> {
    return Promise.resolve(this.byObj.get(`${t}::${k}`));
  }
  reserve(t: TargetSystem, k: string): Promise<ReceiptReservation> {
    const existing = this.byObj.get(`${t}::${k}`);
    if (existing !== undefined) return Promise.resolve({ kind: "committed", record: existing });
    return Promise.resolve({ kind: "reserved" });
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
  put(r: ReceiptRecord): Promise<void> {
    this.seed(r);
    return Promise.resolve();
  }
}

function makeAdapter(overrides: Partial<TargetWriteAdapter> = {}): TargetWriteAdapter {
  return {
    targetSystem: TS,
    existenceCheck: vi.fn(
      (): Promise<ReturnType<typeof ok<ExistingObject | null>> | ReturnType<typeof err<AdapterError>>> =>
        Promise.resolve(ok<ExistingObject | null>(null)),
    ),
    create: vi.fn((): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-new", recordedAt: "2026-07-02T00:00:00.000Z" })),
    ),
    update: vi.fn((): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-upd", recordedAt: "2026-07-02T00:00:00.000Z" })),
    ),
    ...overrides,
  };
}

function makeDeps(
  adapter: TargetWriteAdapter,
  receiptStore: ReceiptStore,
  secrets?: WriteSecretsAccessor,
): EnvelopeReuseDeps {
  return {
    gatewayDeps: {
      adapter,
      receiptStore,
      requireApproval: () => ({ requiresApproval: false }),
      recordPendingApproval: () => Promise.resolve(ok(undefined)),
      isApproved: () => Promise.resolve(true),
      audit: () => Promise.resolve(),
      clock: () => "2026-07-02T00:00:00.000Z",
      ...(secrets !== undefined ? { secrets } : {}),
    },
  };
}

describe("spec(§20.1) reuseExternalWriteOnResume — stored receipt → reused, NO second create", () => {
  it("returns 'reused' and NEVER calls adapter.create when a receipt exists for the envelope", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const priorReceipt: WriteReceipt = { externalObjectId: "ext-prior", recordedAt: "2026-07-01T00:00:00.000Z" };
    store.seed({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: priorReceipt,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const adapter = makeAdapter();

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("reused");
    expect(res.value.receipt.externalObjectId).toBe("ext-prior");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("issues exactly one create when NO receipt exists yet (first drive)", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter();

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across TWO resume drives — second drive reuses the first receipt, create called once total", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, store);

    const first = await reuseExternalWriteOnResume(env, makeAction(), deps);
    const second = await reuseExternalWriteOnResume(env, makeAction(), deps);

    expect(first.ok && first.value.status).toBe("created");
    expect(second.ok && second.value.status).toBe("reused");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("returns a typed err (never throws) on a held gateway outcome (unreachable existence probe)", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter({
      existenceCheck: vi.fn(() =>
        Promise.resolve(err<AdapterError>({ code: "unreachable", message: "vendor down" })),
      ),
    });

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    // no create was attempted on a held (fail-closed) outcome
    expect(adapter.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §S SPEC CHANGE (owner directive, 2026-08-27) — THESE THREE TESTS WERE
// DELIBERATELY REWRITTEN. The reason matters more than the rewrite.
//
// THE OLD SPEC was blanket absence: NO adapter-authored text may reach the
// activity result. `reuseExternalWriteOnResume` satisfied it by collapsing every
// held/conflict/rejected `reason` to a fixed sentence. That collapse was a
// confirmed FUNCTIONAL BREAK — it also erased the §21.10 credential-fault token
// and made two genuinely different failures render identically to an operator.
// The owner ruled: "it's better to be a little looser than to break app
// functionality."
//
// THE SPEC IS NOW: a STRUCTURED, SoW-AUTHORED diagnostic DOES cross — a 401, a
// 403 and a 429 all carry `code: "rejected"`, so `reason` is the only thing that
// tells an operator which one happened — while the vendor's FREE TEXT never
// does. That property is established at the ADAPTER, not here:
// `makeTargetWriteAdapter`'s `faultToError`
// (packages/integrations/src/tools/adapters/adapter-core.ts) composes
// `AdapterError.message` from the closed 4-value `TransportFault` code plus the
// NUMERIC `httpStatus`, and never reads the transport's free-text `detail`.
//
// SO THE HARNESS CHANGED TOO. The old version hand-wrote an `AdapterError` with
// poisoned `message` directly — which BYPASSES `makeTargetWriteAdapter`, so it
// pinned a consumer-side redaction step rather than the mechanism that actually
// holds. These drive the REAL SHIPPED ADAPTER (`createTodoistWriteAdapter`) over
// a hostile transport whose `detail` carries a live-looking secret, through the
// REAL gateway, into this activity. Every test asserts BOTH directions, so each
// still FAILS if real vendor text starts crossing.
// ---------------------------------------------------------------------------

const POISON_MARKER = "PZN9F3A1BSECRET-leak";
const POISON_URL = `https://api.vendor.com/v1?token=${POISON_MARKER}`;
const POISON_BODY = `Bearer sk-${POISON_MARKER}`;
/** A hostile transport `detail` — exactly what a sloppy per-vendor `mapResponse` could hand back. */
const POISON_DETAIL = `vendor response: GET ${POISON_URL} -> 401 {"auth":"${POISON_BODY}"}`;

/**
 * The REAL shipped Todoist adapter (`makeTargetWriteAdapter` under the hood) over a
 * transport that faults on ONE op with poisoned free text. Non-faulting ops succeed so
 * the gateway pipeline reaches the op under test.
 */
function poisonedAdapter(
  faultOn: TransportOp,
  fault: TransportFault,
  httpStatus: number,
): TargetWriteAdapter {
  const transport: AdapterTransport = (req) => {
    const resp: TransportResponse =
      req.op === faultOn
        ? { ok: false, fault, detail: POISON_DETAIL, httpStatus }
        : req.op === "query"
          ? { ok: true, object: null }
          : { ok: true, object: { externalObjectId: "ext-ok" } };
    return Promise.resolve(resp);
  };
  return createTodoistWriteAdapter({ transport, clock: () => "2026-07-02T00:00:00.000Z" });
}

/** The free-text direction that must NEVER cross, whatever else changes. */
function expectNoVendorFreeText(serialized: string): void {
  expect(serialized).not.toContain(POISON_MARKER);
  expect(serialized).not.toContain("api.vendor.com");
  expect(serialized).not.toContain("Bearer sk-");
  expect(serialized).not.toContain(POISON_DETAIL);
}

describe("spec(§S) reuseExternalWriteOnResume — a structured diagnostic crosses; the vendor's free text does not", () => {
  it("status 'held' (existence-check fault): the transport's poisoned `detail` is absent, but the closed code + HTTP status still identify the fault", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = poisonedAdapter("query", "unreachable", 503);

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");

    expectNoVendorFreeText(JSON.stringify(res));
    // RESTORE direction — the operator-facing signal the blanket collapse destroyed.
    expect(res.error.reason).toContain("existence-check");
    expect(res.error.reason).toContain("unreachable");
    expect(res.error.reason).toContain("HTTP 503");
  });

  it("status 'conflict' (create fault): poisoned `detail` absent; the conflict is still identifiable as a 409", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = poisonedAdapter("create", "conflict", 409);

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("conflict");

    expectNoVendorFreeText(JSON.stringify(res));
    expect(res.error.reason).toContain("conflict");
    expect(res.error.reason).toContain("HTTP 409");
  });

  it("status 'rejected' (create fault): poisoned `detail` absent, AND a 401 does not render identically to a 403", async () => {
    const env = makeEnvelope();

    const unauthorized = await reuseExternalWriteOnResume(
      env,
      makeAction(),
      makeDeps(poisonedAdapter("create", "rejected", 401), new FakeReceiptStore()),
    );
    const forbidden = await reuseExternalWriteOnResume(
      env,
      makeAction(),
      makeDeps(poisonedAdapter("create", "rejected", 403), new FakeReceiptStore()),
    );

    expect(unauthorized.ok).toBe(false);
    expect(forbidden.ok).toBe(false);
    if (unauthorized.ok || forbidden.ok) return;
    expect(unauthorized.error.code).toBe("rejected");
    expect(forbidden.error.code).toBe("rejected");

    expectNoVendorFreeText(JSON.stringify(unauthorized));
    expectNoVendorFreeText(JSON.stringify(forbidden));

    // RESTORE direction — both share `code: "rejected"`, so `reason` is the ONLY thing
    // that distinguishes them. Two different failures rendering identically is the exact
    // regression class this round exists to undo.
    expect(unauthorized.error.reason).toContain("HTTP 401");
    expect(forbidden.error.reason).toContain("HTTP 403");
    expect(unauthorized.error.reason).not.toBe(forbidden.error.reason);
  });
});

// ---------------------------------------------------------------------------
// R2 — THE SAFE DIRECTION THAT REGRESSED. `reuseExternalWriteOnResume` used to
// collapse the gateway's `held` reason into a fixed `GENERIC_REUSE_REASON`
// sentence, destroying the §21.10 credential-fault token (`"locked"` /
// `"missing"` / `"denied"`) an operator needs to tell "your Mac Keychain is
// locked" apart from "the vendor rejected the write" (worker LESSONS §41).
// This drives the REAL gateway through a locked `WriteSecretsAccessor` (no
// adapter call ever happens — the credential seam holds BEFORE the existence
// probe) and pins that the closed token still crosses to this activity's
// caller.
// ---------------------------------------------------------------------------

describe("spec(safety rule 7 / §21.10) reuseExternalWriteOnResume — the credential-fault signal survives, not just the poison-absence", () => {
  it("a locked WriteSecretsAccessor holds the write closed; the returned reason still contains 'locked'", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter();
    const secrets: WriteSecretsAccessor = {
      getSecret: () => Promise.resolve(err({ reason: "locked" })),
    };

    // The credential seam is workspace-scoped (rule 4), so a resume must name its workspace or
    // the gateway refuses TERMINALLY (`workspace_unscoped`) and never reaches the `locked` hold
    // this case is about.
    const res = await reuseExternalWriteOnResume(env, makeAction(), {
      ...makeDeps(adapter, store, secrets),
      workspaceId: "personal-business",
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    expect(res.error.reason).toContain("locked");
    // no vendor call was ever attempted — the credential seam holds first
    expect(adapter.existenceCheck).not.toHaveBeenCalled();
    expect(adapter.create).not.toHaveBeenCalled();
  });
});

// ── C3 ORDERING on the RESUME path (the second re-drive) ─────────────────────
//
// A resume re-drives an envelope built on a PREVIOUS run. If a fresher payload
// landed on the same object meanwhile, re-driving writes the old bytes back — a
// content revert. `reuseExternalWriteOnResume` now forwards the original intent's
// age so the gateway can drop the stale step instead.
describe("reuseExternalWriteOnResume — C3 ordering (a stale resumed step never reverts)", () => {
  it("a resumed step whose intent PREDATES the applied payload is dropped, and NOTHING is written", async () => {
    const store = new FakeReceiptStore();
    const env = makeEnvelope();
    // The object already carries a NEWER payload, applied after this step's intent.
    store.seed({
      idempotencyKey: "idem-newer",
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: "sha256:NEWER",
      receipt: { externalObjectId: "ext-obj", recordedAt: "2026-07-02T00:00:00.000Z" },
      recordedAt: "2026-07-02T00:00:00.000Z",
    });
    const adapter = makeAdapter();

    const res = await reuseExternalWriteOnResume(
      env,
      makeAction(),
      makeDeps(adapter, store),
      "2026-07-01T00:00:00.000Z", // this step's intent — OLDER than the applied write
    );

    // Terminal, surfaced, and NOT `held`: re-driving cannot make a stale intent
    // fresher, and re-holding it would spin forever.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rejected");
    expect(res.error.reason).toContain("predates");
  });

  it("omitting the intent time keeps the pre-C3 behaviour exactly", async () => {
    const store = new FakeReceiptStore();
    const env = makeEnvelope();
    store.seed({
      idempotencyKey: "idem-newer",
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: "sha256:NEWER",
      receipt: { externalObjectId: "ext-obj", recordedAt: "2026-07-02T00:00:00.000Z" },
      recordedAt: "2026-07-02T00:00:00.000Z",
    });
    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(makeAdapter(), store));
    // No ordering check ⇒ it proceeds down the update path as before.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).not.toContain("predates");
  });
});
