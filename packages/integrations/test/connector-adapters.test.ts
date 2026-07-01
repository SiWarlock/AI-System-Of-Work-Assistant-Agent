// @sow/integrations — slice 6.3 connector read-adapter tests.
//
// Each concrete connector implements the 6.1 `ConnectorPort` seam:
//   • a transport page maps to `ConnectorRecord[]` (recordId/contentHash/payload);
//   • a transport network failure returns `ConnectorError { code:'unreachable' }`
//     (the 6.1 unreachable branch) — NEVER a local throw across the boundary (§16);
//   • the adapter scopes auth to LEAST-PRIVILEGE READ (asserted via the read-scope
//     the adapter hands the injected transport).
//
// Transport is INJECTED (no real network, no clock, no randomness) — every test
// hands the adapter a fake transport and asserts the mapping / failure branch.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  createCalendarConnector,
  createTodoistConnector,
  createLinearConnector,
  createAsanaConnector,
  createGranolaConnector,
  createDriveConnector,
  createGithubConnector,
  createTelegramCaptureConnector,
  createUrlSourceConnector,
} from "../src/connectors/adapters/index";
import type {
  ConnectorTransport,
  ConnectorTransportResult,
  TransportRequest,
} from "../src/connectors/transport";

// --- fake transports ---------------------------------------------------------

/** A transport that returns one scripted page; records the request it was given. */
function pageTransport(
  page: ConnectorTransportResult,
): ConnectorTransport & { readonly requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const transport: ConnectorTransport = async (req) => {
    requests.push(req);
    return page;
  };
  return Object.assign(transport, { requests });
}

/** A transport that REJECTS (throws) — models a network fault below the adapter. */
function throwingTransport(message = "ECONNREFUSED"): ConnectorTransport {
  return async () => {
    throw new Error(message);
  };
}

/** A transport that returns a typed failure result (vendor/MCP unreachable). */
function failingTransport(): ConnectorTransport {
  return async () => ({ ok: false, code: "unreachable", message: "vendor down" });
}

// A minimal successful transport page (two raw items).
const twoItemPage: ConnectorTransportResult = {
  ok: true,
  items: [
    { id: "a1", hash: "h_a1", raw: { title: "alpha", secret: "sk-live-xxxxxxxxxxxx" } },
    { id: "a2", hash: "h_a2", raw: { title: "beta" } },
  ],
  nextCursor: "cursor_2",
  done: false,
};

// The full V1 adapter set, each paired with its expected least-privilege read scope.
const ADAPTERS = [
  { name: "calendar", make: createCalendarConnector, scope: "calendar.readonly" },
  { name: "todoist", make: createTodoistConnector, scope: "data:read" },
  { name: "linear", make: createLinearConnector, scope: "read" },
  { name: "asana", make: createAsanaConnector, scope: "tasks:read" },
  { name: "granola", make: createGranolaConnector, scope: "meetings:read" },
  { name: "drive", make: createDriveConnector, scope: "drive.readonly" },
  { name: "github", make: createGithubConnector, scope: "repo:read" },
  { name: "telegram-capture", make: createTelegramCaptureConnector, scope: "messages:read" },
  { name: "url-source", make: createUrlSourceConnector, scope: "http:get" },
] as const;

describe("slice 6.3 — connector read adapters (V1 set)", () => {
  it("every adapter exposes its stable connectorId + implements ConnectorPort.fetch", () => {
    for (const { name, make } of ADAPTERS) {
      const port = make(pageTransport(twoItemPage));
      expect(port.connectorId).toBe(name);
      expect(typeof port.fetch).toBe("function");
    }
  });

  it("maps a transport page to ConnectorRecord[] (id/hash/raw payload preserved)", async () => {
    for (const { make } of ADAPTERS) {
      const port = make(pageTransport(twoItemPage));
      const res = await port.fetch();
      expect(isOk(res)).toBe(true);
      if (!isOk(res)) continue;
      const { records, nextCursor, done } = res.value;
      expect(records.map((r) => r.recordId)).toEqual(["a1", "a2"]);
      expect(records.map((r) => r.contentHash)).toEqual(["h_a1", "h_a2"]);
      // The RAW fetched content is carried on payload verbatim (candidate data —
      // it is the gateway/consumer that redacts before logging, not the adapter).
      expect(records[0]?.payload).toEqual({ title: "alpha", secret: "sk-live-xxxxxxxxxxxx" });
      expect(nextCursor).toBe("cursor_2");
      expect(done).toBe(false);
    }
  });

  it("passes the persisted cursor through to the transport request", async () => {
    const t = pageTransport(twoItemPage);
    const port = createTodoistConnector(t);
    await port.fetch("cursor_prev");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.cursor).toBe("cursor_prev");
  });

  it("a transport THROW is caught and returned as ConnectorError 'unreachable' (no throw across the boundary)", async () => {
    for (const { make } of ADAPTERS) {
      const port = make(throwingTransport());
      // Must resolve — never reject — even though the transport threw.
      const res: Result<unknown, { code: string }> = await port.fetch();
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.code).toBe("unreachable");
    }
  });

  it("a typed transport failure (remote MCP/vendor down) → ConnectorError 'unreachable'", async () => {
    // MCP connectors (linear/asana/granola) are REMOTE vendor services — a network
    // failure routes to the unreachable branch, NOT a local throw.
    for (const { make } of ADAPTERS) {
      const port = make(failingTransport());
      const res = await port.fetch();
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.code).toBe("unreachable");
    }
  });

  it("scopes auth to LEAST-PRIVILEGE READ — the adapter hands the transport a read-only scope", async () => {
    for (const { make, scope } of ADAPTERS) {
      const t = pageTransport(twoItemPage);
      const port = make(t);
      await port.fetch();
      expect(t.requests[0]?.readScope).toBe(scope);
      // Belt-and-suspenders: no scope names a write/mutate verb.
      expect(t.requests[0]?.readScope ?? "").not.toMatch(/write|create|update|delete|admin|mutat/i);
    }
  });

  it("a transport page with no nextCursor + done:true drains cleanly", async () => {
    const port = createGithubConnector(
      pageTransport({ ok: true, items: [], done: true }),
    );
    const res = await port.fetch();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.records).toEqual([]);
    expect(res.value.done).toBe(true);
    expect(res.value.nextCursor).toBeUndefined();
  });
});
