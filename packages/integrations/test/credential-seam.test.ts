// Task 21.10 (core) — the external-write CREDENTIAL SEAM. The Tool Gateway write
// path resolves each vendor's auth token at DISPATCH-time through an INJECTED
// WriteSecretsAccessor (the 17.4 `keychain://<service>/<account>` ref convention) and
// FAILS CLOSED on an unavailable/throwing accessor — NO unauthenticated write, and
// the token is NEVER read into a log/fault (safety rule 7). DORMANT: the accessor is
// injected (a mock here); ABSENT ⇒ byte-equivalent (the stub write path is unchanged;
// the real accessor + real transport arm together at §ARM-21 / 21.6).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, AuditRecord, TargetSystem } from "@sow/contracts";
import type { TargetWriteAdapter, AdapterError } from "../src/tools/adapter-port";
import type { SafeToolWriteLog } from "../src/redaction/gateway-log-redaction";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../src/tools/gateway";
import { writeSecretRef, type WriteSecretsAccessor, type WriteSecretUnavailable } from "../src/tools/adapters/adapter-core";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import { InMemoryReceiptStore, makeProposedAction, makeWriteReceipt } from "./support/fakes";

const CLOCK = (): string => "2026-07-01T00:00:00.000Z";

function makeAdapter() {
  const create = vi.fn(async () => ok(makeWriteReceipt({ externalObjectId: "ext_created" })));
  const existenceCheck = vi.fn(async () => ok(null));
  const adapter: TargetWriteAdapter = {
    targetSystem: "asana",
    existenceCheck,
    create,
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
  return { adapter, createCalls: () => create.mock.calls.length, existenceCalls: () => existenceCheck.mock.calls.length };
}

function makeDeps(secrets?: WriteSecretsAccessor) {
  const spies = makeAdapter();
  const store = new InMemoryReceiptStore();
  const audits: AuditRecord[] = [];
  const logs: SafeToolWriteLog[] = [];
  const deps: ExternalWriteDeps = {
    adapter: spies.adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }), // auto-allow ⇒ reach the write path
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async (rec: AuditRecord) => { audits.push(rec); },
    clock: CLOCK,
    logSink: (rec: SafeToolWriteLog) => { logs.push(rec); },
    ...(secrets !== undefined ? { secrets } : {}),
  };
  return { deps, spies, audits, logs };
}

function envFor(targetSystem: TargetSystem = "drive") {
  const action = makeProposedAction({
    targetSystem,
    canonicalObjectKey: `${targetSystem}:obj:1`,
    idempotencyKey: `idem-${targetSystem}`,
  });
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return { action, env: built.value };
}

const returning = (token: string): WriteSecretsAccessor => ({ getSecret: async () => ok(token) });
const unavailable = (reason: WriteSecretUnavailable["reason"]): WriteSecretsAccessor => ({ getSecret: async () => err({ reason }) });
const throwing = (): WriteSecretsAccessor => ({ getSecret: async () => { throw new Error("keychain backend fault"); } });

describe("writeSecretRef — the 17.4 keychain ref convention per vendor", () => {
  it("derives connector-write:<vendor> for object targets and telegram-bot:* for telegram", () => {
    expect(writeSecretRef("asana")).toBe("keychain://connector-write/asana");
    expect(writeSecretRef("calendar")).toBe("keychain://connector-write/calendar");
    expect(writeSecretRef("todoist")).toBe("keychain://connector-write/todoist");
    expect(writeSecretRef("linear")).toBe("keychain://connector-write/linear");
    expect(writeSecretRef("drive")).toBe("keychain://connector-write/drive");
    expect(writeSecretRef("github")).toBe("keychain://connector-write/github");
    expect(writeSecretRef("telegram")).toBe("keychain://telegram-bot/*");
  });
});

describe("credential seam — resolve at dispatch, fail closed, token never logged (rule 7)", () => {
  it("resolves the write token via the injected accessor with the derived ref, then writes", async () => {
    const getSecret = vi.fn(async (_ref: string): Promise<Result<string, WriteSecretUnavailable>> => ok("faketoken-xyz"));
    const { deps, spies } = makeDeps({ getSecret });
    const { action, env } = envFor("drive");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(getSecret).toHaveBeenCalledWith("keychain://connector-write/drive");
    expect(out.status).toBe("created");
    expect(spies.createCalls()).toBe(1);
  });

  it("the telegram-bot ref resolves via the same seam", async () => {
    const getSecret = vi.fn(async (_ref: string): Promise<Result<string, WriteSecretUnavailable>> => ok("t"));
    const { deps } = makeDeps({ getSecret });
    const { action, env } = envFor("telegram");
    await dispatchExternalWrite(env, action, deps);
    expect(getSecret).toHaveBeenCalledWith("keychain://telegram-bot/*");
  });

  // ⛔ WHY THIS SPLIT — the previous single case asserted `held` for ALL THREE
  // reasons, conflating two different properties under the phrase "fails closed":
  //   • FAIL CLOSED  = do not proceed to a vendor call. True for all three, and
  //                    still asserted below for all three.
  //   • `held`       = enqueue for outbox retry WITH BACKOFF. That is a claim that
  //                    RETRYING CAN HELP, and it is false for `missing`/`denied`.
  // Measured consequence of the old behaviour: twelve drain passes over a
  // permanently-denied credential left the entry `retry_queued`, and it can never
  // leave that state (`outbox-drain.ts` returns `backoffCfg.maxMs` on EXHAUSTED),
  // so a credential the owner must fix retried silently until someone looked.
  it("a LOCKED keychain is HELD — retrying can help once it is unlocked", async () => {
    const { deps, spies } = makeDeps(unavailable("locked"));
    const { action, env } = envFor("asana");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("held");
    expect(spies.existenceCalls()).toBe(0); // the gate runs BEFORE the vendor existence probe
    expect(spies.createCalls()).toBe(0); // no unauthenticated write
  });

  it.each(["missing", "denied"] as const)(
    "an unavailable accessor (%s) is TERMINAL — no retry can provision a credential",
    async (reason) => {
      const { deps, spies } = makeDeps(unavailable(reason));
      const { action, env } = envFor("asana");
      const out = await dispatchExternalWrite(env, action, deps);
      expect(out.status).toBe("rejected");
      // Unchanged and still load-bearing: fail-closed means no vendor call at all.
      expect(spies.existenceCalls()).toBe(0);
      expect(spies.createCalls()).toBe(0);
    },
  );

  it("a THROWING accessor fails closed (held) and never throws, NO create", async () => {
    const { deps, spies } = makeDeps(throwing());
    const { action, env } = envFor("asana");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("held");
    expect(spies.createCalls()).toBe(0);
  });

  it("the resolved token NEVER appears in any log / audit / outcome (rule 7)", async () => {
    const TOKEN = "SUPER-SECRET-TOKEN-abc123XYZ";
    const { deps, logs, audits } = makeDeps(returning(TOKEN));
    const { action, env } = envFor("drive");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("created");
    const serialized = JSON.stringify({ out, logs, audits });
    expect(serialized.includes(TOKEN)).toBe(false);
  });

  it("a blank / whitespace-only token is TERMINAL (empty ≠ authenticated, and a retry cannot fill it)", async () => {
    for (const blank of ["", "   "]) {
      const { deps, spies } = makeDeps(returning(blank));
      const { action, env } = envFor("asana");
      const out = await dispatchExternalWrite(env, action, deps);
      // Was `held`. A blank token is a provisioning defect an owner must fix —
      // parking it in the retry outbox hid it behind an endless backoff.
      expect(out.status).toBe("rejected");
      expect(spies.createCalls()).toBe(0); // a blank token is not proof of auth
    }
  });

  it("an approval-PENDING action returns BEFORE the credential seam (accessor not consulted)", async () => {
    const getSecret = vi.fn(async (): Promise<Result<string, WriteSecretUnavailable>> => ok("t"));
    const spies = makeAdapter();
    const deps: ExternalWriteDeps = {
      adapter: spies.adapter,
      receiptStore: new InMemoryReceiptStore(),
      requireApproval: () => ({ requiresApproval: true }), // approval required
      recordPendingApproval: async () => ok(undefined),
      isApproved: async () => false, // not yet approved
      audit: async () => {},
      clock: CLOCK,
      secrets: { getSecret },
    };
    const { action, env } = envFor("asana");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("approval_pending");
    expect(getSecret).not.toHaveBeenCalled(); // the seam sits AFTER approval
  });

  it("the held reason is code-only — never echoes the token or the raw keychain ref", async () => {
    const { deps } = makeDeps(unavailable("locked"));
    const { action, env } = envFor("asana");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("held");
    if (out.status === "held") {
      expect(out.reason.includes("locked")).toBe(true); // the closed-set code is fine
      expect(out.reason.includes("keychain://")).toBe(false); // the raw ref is NOT leaked
    }
  });
});

describe("credential seam — dormant (byte-equivalent when the accessor is absent)", () => {
  it("ABSENT accessor ⇒ the existing dispatch behavior is unchanged (writes proceed to the stub)", async () => {
    const { deps, spies } = makeDeps(); // no secrets
    const { action, env } = envFor("drive");
    const out = await dispatchExternalWrite(env, action, deps);
    expect(out.status).toBe("created");
    expect(spies.createCalls()).toBe(1);
  });

  it("no real token provisioned — the write path constructs no keychain/exec backend", () => {
    for (const rel of ["../src/tools/gateway.ts", "../src/tools/adapters/adapter-core.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const forbidden of ["child_process", "execFile", "spawn(", "security find-generic-password", "execSync"]) {
        expect(src.includes(forbidden)).toBe(false);
      }
    }
  });
});
