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
  TransportFaultDetail,
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

describe("6.4 drive — 404 promotion reads the STRUCTURED httpStatus, never message prose (§S)", () => {
  it("MUTATION PROOF: a 404 status promotes to 'not_found' even when the transport's free-text detail says nothing like '404'", async () => {
    const { transport } = makeTransport({
      create: async () => ({
        ok: false,
        fault: "rejected",
        detail: "totally different wording — not the old 'HTTP 404' shape at all",
        httpStatus: 404,
      }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_404_fmt" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("MUTATION PROOF: text that LOOKS like the old 'HTTP 404' shape does NOT promote when httpStatus says otherwise", async () => {
    const { transport } = makeTransport({
      create: async () => ({ ok: false, fault: "rejected", detail: "HTTP 404", httpStatus: 403 }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_403_fake404" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("rejected"); // NEVER promoted — the status, not the prose, governs.
  });

  it("a 404-ish message with NO httpStatus at all does not promote (no string fallback exists)", async () => {
    const { transport } = makeTransport({
      create: async () => ({ ok: false, fault: "rejected", detail: "blocked host, mentions 404 in passing" }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_no_status" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("rejected");
  });
});

describe("6.4 adapter-core — AdapterError.message is built from CLOSED inputs, never the transport's free-text detail (§S)", () => {
  it("a hostile free-text detail (a bearer token, a token-bearing URL) never reaches AdapterError.message", async () => {
    const hostileDetail = "Bearer sk-PZN9F3A1BSECRET-leak https://vendor.example/x?token=sk-PZN9F3A1BSECRET-leak";
    const { transport } = makeTransport({
      create: async () => ({ ok: false, fault: "rejected", detail: hostileDetail }),
    });
    const adapter = createGithubWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_github_hostile" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain("sk-PZN9F3A1BSECRET-leak");
      expect(res.error.message).not.toContain("Bearer");
      expect(res.error.message).not.toContain("token=");
    }
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

// F2 (this round) — the §S fix above closed a real leak channel with an instrument
// far broader than the channel. `faultToError` built `message` from the fault code
// alone whenever no `httpStatus` was present, so the statusless real-transport
// failures (an SSRF/allowlist block, a missing / locked / denied / empty
// credential, a throwing credential accessor, a request-build error, a
// non-integer status, a malformed body, a network outage, a map error) collapsed
// into THREE strings — six of them byte-identical. "Your Keychain is locked" and
// "an SSRF guard blocked this host" rendered the same. (For the exact count, the
// producer's own suite is authoritative: write-http-transport.test.ts.)
//
// The fix reopens the DISTINCTION without reopening the CHANNEL: `faultDetail` is a
// closed union of module-local literals in transport.ts. A hostile or buggy
// per-vendor `mapResponse` can only SELECT one of those tokens; it cannot
// contribute a byte. The §S guarantee holds verbatim — `message` is still built
// from closed inputs only, there are now three of them rather than two.
describe("6.4 adapter-core — a CLOSED faultDetail distinguishes statusless faults without reopening free text (F2)", () => {
  it("a statusless fault carrying faultDetail renders the sub-reason; the closed AdapterError.faultDetail field carries it typed", async () => {
    const { transport } = makeTransport({
      query: async () => ({
        ok: false,
        fault: "rejected",
        detail: "write credential unavailable: locked",
        faultDetail: "credential_locked",
      }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_locked" });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rejected");
    expect(res.error.message).toBe("request rejected (credential_locked)");
    // The typed twin, so a caller that must BRANCH never parses the prose — the
    // same reason `httpStatus` exists alongside the "HTTP <n>" message.
    expect(res.error.faultDetail).toBe("credential_locked");
  });

  it("MUTATION PROOF: two statusless faults that share a fault code now render DIFFERENTLY", async () => {
    const render = async (faultDetail: TransportFaultDetail): Promise<string> => {
      const { transport } = makeTransport({
        create: async () => ({
          ok: false,
          fault: "rejected",
          detail: "irrelevant",
          faultDetail,
        }),
      });
      const adapter = createGithubWriteAdapter({ transport, clock });
      const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_gh_distinct" });
      const res = await adapter.create(env, { title: "x" });
      if (res.ok) throw new Error("expected a fault");
      return res.error.message;
    };

    const locked = await render("credential_locked");
    const ssrf = await render("ssrf_blocked");
    expect(locked).not.toBe(ssrf);
    expect(locked).toContain("credential_locked");
    expect(ssrf).toContain("ssrf_blocked");
  });

  it("faultDetail is IGNORED when the fault carried a real httpStatus (the vendor status stays the diagnostic)", async () => {
    const { transport } = makeTransport({
      update: async () => ({
        ok: false,
        fault: "conflict",
        detail: "etag mismatch",
        httpStatus: 412,
        faultDetail: "map_error",
      }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_412" });

    const res = await adapter.update(env, { title: "x" }, "etag-stale");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toBe("HTTP 412");
    expect(res.error.httpStatus).toBe(412);
  });

  it("a hostile free-text detail STILL never reaches AdapterError.message when faultDetail is also present", async () => {
    const hostileDetail = "Bearer sk-PZN9F3A1BSECRET-leak https://vendor.example/x?token=sk-PZN9F3A1BSECRET-leak";
    const { transport } = makeTransport({
      create: async () => ({
        ok: false,
        fault: "unknown",
        detail: hostileDetail,
        faultDetail: "map_error",
      }),
    });
    const adapter = createGithubWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "github", canonicalObjectKey: "cok_github_hostile2" });

    const res = await adapter.create(env, { title: "x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toBe("unclassified adapter fault (map_error)");
    expect(res.error.message).not.toContain("sk-PZN9F3A1BSECRET-leak");
    expect(res.error.message).not.toContain("Bearer");
    expect(res.error.message).not.toContain("token=");
  });

  it("REGRESSION PIN: a statusless fault with NO faultDetail renders exactly as before", async () => {
    const { transport } = makeTransport({
      query: async () => ({ ok: false, fault: "unreachable", detail: "vendor 503" }),
    });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: "cok_drive_nodetail" });

    const res = await adapter.existenceCheck(env.canonicalObjectKey, env);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toBe("target system unreachable");
    expect(res.error.faultDetail).toBeUndefined();
  });
});

// ── drive.ts's `promoteNotFound` — a PASS-THROUGH wrapper, not a re-constructor.
//    It used to rebuild the promoted error as `{code, message, httpStatus}`, which
//    dropped `faultDetail` on the floor and would drop any field added to
//    `AdapterError` later. Inert on today's real transport (a 404 carries an
//    httpStatus, so it never carries a faultDetail), but a per-vendor
//    `mapResponse` can return both, and "a wrapper where new fields go to die" is
//    the built-but-unwired shape one layer down. Spreading is the fix; these pin
//    it in BOTH directions — what the promotion changes, and what it must not. ──
describe("6.4 drive — promoteNotFound changes ONLY the code", () => {
  const notFoundFault: TransportResponse = {
    ok: false,
    fault: "rejected",
    detail: "HTTP 404",
    httpStatus: 404,
    faultDetail: "credential_locked",
  };

  it("promotes a 404 `rejected` to `not_found` while PRESERVING faultDetail, httpStatus and message", async () => {
    const { transport } = makeTransport({ create: async () => notFoundFault });
    const adapter = createDriveWriteAdapter({ transport, clock });
    const res = await adapter.create(makeEnvelope({ targetSystem: "drive" }), { title: "x" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found"); // the ONE intended change
    expect(res.error.httpStatus).toBe(404);
    expect(res.error.faultDetail).toBe("credential_locked");
    expect(res.error.message).toBe("HTTP 404");
  });

  it("the promotion is exactly a code swap — every other key is byte-identical to the unpromoted error", async () => {
    // Non-vacuity for the pin above: compare the promoted error against the SAME
    // fault run through an adapter with no promotion wrapper. Any field the
    // wrapper adds, drops or rewrites shows up here, including fields added to
    // AdapterError after this test was written.
    const { transport: promotingTransport } = makeTransport({ create: async () => notFoundFault });
    const { transport: plainTransport } = makeTransport({ create: async () => notFoundFault });
    const env = makeEnvelope({ targetSystem: "drive" });
    const promoted = await createDriveWriteAdapter({ transport: promotingTransport, clock }).create(env, { title: "x" });
    const plain = await createCalendarWriteAdapter({ transport: plainTransport, clock }).create(env, { title: "x" });

    if (promoted.ok || plain.ok) throw new Error("expected two faults");
    expect({ ...promoted.error, code: plain.error.code }).toEqual({ ...plain.error });
  });

  it("a NON-404 rejected fault is not promoted and is passed through untouched", async () => {
    const forbidden: TransportResponse = { ok: false, fault: "rejected", detail: "HTTP 403", httpStatus: 403 };
    const { transport } = makeTransport({ create: async () => forbidden });
    const res = await createDriveWriteAdapter({ transport, clock }).create(
      makeEnvelope({ targetSystem: "drive" }),
      { title: "x" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rejected");
    expect(res.error.httpStatus).toBe(403);
  });
});
