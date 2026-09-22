// A vendor spec may declare a specific 4xx reply RETRYABLE — Linear's rate limit is HTTP 400.
//
// ⛔ THE DEFECT (found 2026-09-21 by the Linear grounding pass, confirmed against Linear's docs): Linear
// signals a rate limit as HTTP **400** with `errors[].extensions.code = "RATELIMITED"`, not 429. The
// write transport's status gate runs BEFORE any vendor mapper and maps every 4xx outside
// {408, 425, 429} to the terminal `rejected`. So a rate-limited Linear write would be dropped for good
// instead of held for retry. Nothing is duplicated — but the write is lost, and rate limiting is the
// single most common real-world write failure.
//
// ⭐ THE FIX IS DELIBERATELY NARROW (rule 3 — never retry forever): a spec's `retryableBody` may only
// turn a would-be `rejected` 4xx into `unreachable` (held, retried with bounded backoff). It can never:
//   • touch 401/403 — "retrying cannot fix a credential; retrying forever hides it";
//   • touch 409/412 — those are `conflict`, never a blind overwrite;
//   • downgrade anything (a 5xx stays retryable whatever it says).
// And a throwing or confused classifier falls back to the default, which is terminal: fail safe.
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import {
  createWriteHttpTransport,
  type WriteHttpSpec,
  type HttpTransport,
} from "../src/tools/adapters/write-http-transport";
import type { AdapterTransportRequest } from "../src/tools/adapters/transport";

const RATELIMITED = JSON.stringify({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] });
const INVALID = JSON.stringify({ errors: [{ message: "Argument Validation Error", extensions: { code: "INVALID_INPUT" } }] });

const BASE: WriteHttpSpec = {
  baseUrl: "https://api.vendor.test",
  allowedHosts: ["api.vendor.test"],
  buildRequest: () => ({ method: "POST", path: "/graphql", body: "{}" }),
  mapResponse: () => ({ ok: true, object: { externalObjectId: "x" } }),
};

const WITH_CLASSIFIER: WriteHttpSpec = {
  ...BASE,
  retryableBody: (_status, json) =>
    Array.isArray((json as { errors?: unknown })?.errors) &&
    ((json as { errors: { extensions?: { code?: string } }[] }).errors).some((e) => e.extensions?.code === "RATELIMITED"),
};

const REQ: AdapterTransportRequest = {
  op: "create",
  targetSystem: "linear",
  canonicalObjectKey: "cok",
  idempotencyKey: "idem",
  identity: {},
  payload: {},
  workspaceId: "employer-work",
};

function send(spec: WriteHttpSpec, status: number, body: string) {
  const http: HttpTransport = { async send() { return { status, body }; } };
  return createWriteHttpTransport(spec, { http, secrets: { getSecret: async () => ok("k") } })(REQ);
}

describe("retryableBody — a vendor may mark a specific 4xx reply as 'try again later'", () => {
  it("⛔ Linear's rate limit (HTTP 400 + RATELIMITED) is HELD for retry, not dropped", async () => {
    const res = await send(WITH_CLASSIFIER, 400, RATELIMITED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fault).toBe("unreachable");
    expect(res.httpStatus).toBe(400);
  });

  it("the SAME status with any other body stays terminal — only the declared signal retries", async () => {
    const res = await send(WITH_CLASSIFIER, 400, INVALID);
    expect(!res.ok && res.fault).toBe("rejected");
  });

  it("a spec WITHOUT a classifier is byte-for-byte unchanged: 400 is terminal", async () => {
    const res = await send(BASE, 400, RATELIMITED);
    expect(!res.ok && res.fault).toBe("rejected");
  });

  it("⛔ 401 and 403 stay terminal even if the body claims a rate limit — a credential cannot be retried into working", async () => {
    for (const status of [401, 403]) {
      const res = await send(WITH_CLASSIFIER, status, RATELIMITED);
      expect(!res.ok && res.fault, String(status)).toBe("rejected");
    }
  });

  it("409/412 stay conflict — a classifier can never turn a stale precondition into a retry", async () => {
    for (const status of [409, 412]) {
      const res = await send(WITH_CLASSIFIER, status, RATELIMITED);
      expect(!res.ok && res.fault, String(status)).toBe("conflict");
    }
  });

  it("a THROWING classifier or a non-JSON body falls back to the terminal default — fail safe", async () => {
    const throwing: WriteHttpSpec = { ...BASE, retryableBody: () => { throw new Error("boom"); } };
    expect(await send(throwing, 400, RATELIMITED).then((r) => !r.ok && r.fault)).toBe("rejected");
    expect(await send(WITH_CLASSIFIER, 400, "<html>not json</html>").then((r) => !r.ok && r.fault)).toBe("rejected");
  });

  it("5xx stays retryable regardless — the classifier can only relax, never tighten", async () => {
    const never: WriteHttpSpec = { ...BASE, retryableBody: () => false };
    expect(await send(never, 503, "{}").then((r) => !r.ok && r.fault)).toBe("unreachable");
  });
});
