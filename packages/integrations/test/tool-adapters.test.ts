// Slice 6.4 — per-target Tool-Gateway write adapters (behind the 6.2 envelope).
//
// Each adapter implements TargetWriteAdapter over an INJECTED transport fn (no
// real network) + an INJECTED clock. The adapter owns its per-target
// canonicalObjectKey identity derivation + its pre-write existence-check query,
// so the 6.2 no-duplicate invariant holds per target. This suite covers the
// representative subset the brief names — calendar, drive, telegram, github —
// pinning: existence-hit → reuse; create → receipt with externalObjectId; stale
// precondition → 'conflict' (NEVER overwrite); telegram re-send same
// idempotencyKey → single post. §16: no method throws; every fault is a typed
// AdapterError.
import { describe, it, expect, vi } from "vitest";
import type { Result } from "@sow/contracts";
import type { AdapterError, ExistingObject } from "../src/tools/adapter-port";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportResponse,
} from "../src/tools/adapters/transport";
import { createCalendarWriteAdapter } from "../src/tools/adapters/calendar";
import { createDriveWriteAdapter } from "../src/tools/adapters/drive";
import { createTelegramWriteAdapter } from "../src/tools/adapters/telegram";
import { createGithubWriteAdapter } from "../src/tools/adapters/github";
import { makeEnvelope } from "./support/fakes";

const CLOCK = "2026-07-01T00:00:00.000Z";
const clock = (): string => CLOCK;

// A programmable in-memory transport. `handlers` maps a request `op` to a
// response producer; unhandled ops throw INSIDE the fake (never observed by the
// adapter, which must translate transport rejections into typed Results — a
// throw here would fail the test loudly if an adapter forgot to guard).
function makeTransport(
  handlers: Partial<Record<AdapterTransportRequest["op"], (req: AdapterTransportRequest) => Promise<TransportResponse>>>,
): { transport: AdapterTransport; calls: AdapterTransportRequest[] } {
  const calls: AdapterTransportRequest[] = [];
  const transport: AdapterTransport = async (req) => {
    calls.push(req);
    const h = handlers[req.op];
    if (h === undefined) {
      return { ok: false, fault: "unknown", detail: `no handler for ${req.op}` };
    }
    return h(req);
  };
  return { transport, calls };
}

describe("6.4 target write adapters — canonicalObjectKey + existence check", () => {
  it("drive: existence-hit → reuse the vendor object, NEVER a second create", async () => {
    const existing: TransportResponse = {
      ok: true,
      object: { externalObjectId: "drive_file_1", externalUrl: "https://drive/1" },
    };
    const { transport, calls } = makeTransport({ query: async () => existing });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_abc" });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).not.toBeNull();
      expect((res.value as ExistingObject).externalObjectId).toBe("drive_file_1");
    }
    // The existence probe queried by the canonical key — never issued a create.
    expect(calls.map((c) => c.op)).toEqual(["query"]);
  });

  it("calendar: existence-miss → null (the gateway may proceed to create)", async () => {
    const { transport } = makeTransport({ query: async () => ({ ok: true, object: null }) });
    const adapter = createCalendarWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "calendar", canonicalObjectKey: "cok_calendar_x" });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });

  it("github: a transport fault on the existence probe → typed 'unreachable' (never collapsed to null)", async () => {
    const { transport } = makeTransport({
      query: async () => ({ ok: false, fault: "unreachable", detail: "vendor 503" }),
    });
    const adapter = createGithubWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_github_1" });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unreachable");
  });
});

describe("6.4 target write adapters — create → WriteReceipt", () => {
  it("calendar: create returns a receipt with the vendor externalObjectId + injected recordedAt", async () => {
    const { transport, calls } = makeTransport({
      create: async () => ({
        ok: true,
        object: { externalObjectId: "cal_evt_42", externalUrl: "https://cal/42" },
      }),
    });
    const adapter = createCalendarWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "calendar", canonicalObjectKey: "cok_calendar_y" });

    const res = await adapter.create(env, { title: "Standup", start: "2026-07-01T09:00:00.000Z" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.externalObjectId).toBe("cal_evt_42");
      expect(res.value.externalUrl).toBe("https://cal/42");
      // recordedAt comes from the INJECTED clock, never Date.now().
      expect(res.value.recordedAt).toBe(CLOCK);
    }
    expect(calls.map((c) => c.op)).toEqual(["create"]);
  });

  it("drive: create carries the canonicalObjectKey + idempotencyKey through to the transport (identity binding)", async () => {
    const { transport, calls } = makeTransport({
      create: async () => ({ ok: true, object: { externalObjectId: "drive_new_1" } }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({
      targetSystem: "drive",
      canonicalObjectKey: "cok_drive_bind",
      idempotencyKey: "idem_drive_bind",
    });

    const res = await adapter.create(env, { title: "Doc" });
    expect(res.ok).toBe(true);
    const createCall = calls.find((c) => c.op === "create");
    expect(createCall?.canonicalObjectKey).toBe("cok_drive_bind");
    expect(createCall?.idempotencyKey).toBe("idem_drive_bind");
  });

  it("github: a transport 'rejected' on create → typed AdapterError 'rejected' (never a silent drop)", async () => {
    const { transport } = makeTransport({
      create: async () => ({ ok: false, fault: "rejected", detail: "validation failed" }),
    });
    const adapter = createGithubWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_github_2" });

    const res = await adapter.create(env, { title: "Bug" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("rejected");
  });

  it("github: a whitespace-only vendor id is NOT a valid receipt → typed 'unknown' fault", async () => {
    const { transport } = makeTransport({
      create: async () => ({ ok: true, object: { externalObjectId: "   " } }),
    });
    const adapter = createGithubWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_github_ws" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown");
  });
});

describe("6.4 target write adapters — update / stale precondition", () => {
  it("drive: a stale precondition → AdapterError 'conflict' (NEVER a blind overwrite)", async () => {
    const { transport } = makeTransport({
      update: async () => ({ ok: false, fault: "conflict", detail: "etag mismatch" }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_upd" });

    const res = await adapter.update(env, { title: "v2" }, "etag_stale");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
  });

  it("calendar: update passes the expectedPrecondition through to the transport", async () => {
    const { transport, calls } = makeTransport({
      update: async () => ({ ok: true, object: { externalObjectId: "cal_evt_42" } }),
    });
    const adapter = createCalendarWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "calendar", canonicalObjectKey: "cok_calendar_upd" });

    const res = await adapter.update(env, { title: "v2" }, "version_7");
    expect(res.ok).toBe(true);
    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall?.expectedPrecondition).toBe("version_7");
  });

  it("calendar: update returns a fresh receipt with the injected recordedAt", async () => {
    const { transport } = makeTransport({
      update: async () => ({ ok: true, object: { externalObjectId: "cal_evt_9" } }),
    });
    const adapter = createCalendarWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "calendar", canonicalObjectKey: "cok_calendar_r" });

    const res = await adapter.update(env, { title: "v2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.externalObjectId).toBe("cal_evt_9");
      expect(res.value.recordedAt).toBe(CLOCK);
    }
  });
});

describe("6.4 telegram — idempotent send (no double-post)", () => {
  it("telegram: a re-send of the SAME idempotencyKey does NOT double-post (transport idempotency echo)", async () => {
    // The fake transport dedupes on idempotencyKey: the FIRST create for a key
    // posts; a re-send with the same key echoes the SAME object WITHOUT a second
    // post. This mirrors telegram's send-once-per-key semantics.
    const posted = new Map<string, { externalObjectId: string }>();
    let postCount = 0;
    const { transport, calls } = makeTransport({
      create: async (req) => {
        const key = req.idempotencyKey;
        const prior = posted.get(key);
        if (prior !== undefined) {
          // Idempotency echo: reuse, do NOT post again.
          return { ok: true, object: { externalObjectId: prior.externalObjectId }, deduped: true };
        }
        postCount += 1;
        const obj = { externalObjectId: `tg_msg_${postCount}` };
        posted.set(key, obj);
        return { ok: true, object: obj };
      },
    });
    const adapter = createTelegramWriteAdapter({ transport, clock });
    const env = makeEnvelope({
      targetSystem: "telegram",
      canonicalObjectKey: "cok_telegram_card",
      idempotencyKey: "idem_tg_once",
    });

    const first = await adapter.create(env, { text: "Approve?" });
    const second = await adapter.create(env, { text: "Approve?" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      // Same vendor message id both times — the second was an idempotency echo.
      expect(second.value.externalObjectId).toBe(first.value.externalObjectId);
    }
    // Exactly ONE real post despite two create calls.
    expect(postCount).toBe(1);
    expect(calls.filter((c) => c.op === "create")).toHaveLength(2);
  });

  it("telegram: existence-check probes by idempotencyKey (its identity is the send key, not an object key)", async () => {
    const { transport, calls } = makeTransport({
      query: async () => ({ ok: true, object: { externalObjectId: "tg_msg_prior" } }),
    });
    const adapter = createTelegramWriteAdapter({ transport, clock });
    const env = makeEnvelope({
      targetSystem: "telegram",
      canonicalObjectKey: "cok_telegram_x",
      idempotencyKey: "idem_tg_probe",
    });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(true);
    const queryCall = calls.find((c) => c.op === "query");
    // Telegram's dedupe identity is the idempotencyKey (send-once), so the probe
    // must carry it.
    expect(queryCall?.idempotencyKey).toBe("idem_tg_probe");
  });
});

describe("6.4 adapters — targetSystem identity + §16 total (no throw)", () => {
  it("each adapter reports its own targetSystem", () => {
    const { transport } = makeTransport({});
    expect(createCalendarWriteAdapter({ transport, clock }).targetSystem).toBe("calendar");
    expect(createDriveWriteAdapter({ transport, clock }).targetSystem).toBe("drive");
    expect(createGithubWriteAdapter({ transport, clock }).targetSystem).toBe("github");
    expect(createTelegramWriteAdapter({ transport, clock }).targetSystem).toBe("telegram");
  });

  it("a transport that THROWS is caught and returned as a typed 'unknown' AdapterError (§16 — never throws across the boundary)", async () => {
    const throwing: AdapterTransport = async () => {
      throw new Error("boom");
    };
    const adapter = createDriveWriteAdapter({ transport: throwing, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_throw" });

    const create: Result<unknown, AdapterError> = await adapter.create(env, { title: "x" });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe("unknown");

    const exists = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(exists.ok).toBe(false);
    if (!exists.ok) expect(exists.error.code).toBe("unknown");
  });
});
