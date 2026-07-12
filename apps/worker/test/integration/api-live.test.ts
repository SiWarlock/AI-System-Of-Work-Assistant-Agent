// @sow/worker — the LIVE loopback-transport INTEGRATION test (SOW_API-gated).
//
// This stands up the REAL `startApiServer` (api/mount.ts) on an EPHEMERAL loopback
// port and drives it with a REAL @trpc/client (httpBatchLink for queries/commands +
// createWSClient/wsLink for the push-stream subscription) over actual sockets. It is
// the transport analog of the SOW_TEMPORAL proof-spine test: gated behind SOW_API=1
// so the default suite stays socket-free.
//
// It pins the load-bearing transport-boundary guarantees:
//   (a) a WRONG token is rejected PRE-HANDLER on BOTH the HTTP query path AND the WS
//       handshake — the HTTP query resolves to a typed `err` (never runs the work);
//       the WS subscription yields NOTHING and completes (no event to an unauthed peer).
//   (b) a WRONG Origin/Host (DNS-rebind) is rejected on both paths (FORBIDDEN-equiv).
//   (c) a VALID token gets a UI-safe query result — an empty read-model surfaces as
//       ok([]) and the payload carries NO secret / raw / internal-ref field.
//   (d) a stream event FLOWS to a valid subscriber and RESUMES from `lastEventId`
//       (the missed event replays; no gap, no dup).
//   (e) a NON-loopback bind is REFUSED at startup (REQ-NF-004).
//
// Fast + deterministic: no outage sim, no real @sow/db (the ports are in-memory
// fakes — this test exercises the TRANSPORT + auth + stream wiring, not the DB
// adapters, which the QA-stage adapter tests already cover). Each socket case tears
// its client + server down so no port leaks.
import { describe, it, expect } from "vitest";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  createTRPCClient,
  httpBatchLink,
  createWSClient,
  wsLink,
  splitLink,
} from "@trpc/client";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import type { Result, FailureVariant, HealthItem } from "@sow/contracts";

import { SOW_API } from "../support/apiGate";
import {
  startApiServer,
  LoopbackBindRefusedError,
  type RunningApiServer,
  type StartApiServerOptions,
} from "../../src/api/mount";
import type { AppRouter } from "../../src/api/server";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";
import type { ReadModelQueryPort } from "../../src/api/procedures/queries";
import {
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
} from "../../src/api/procedures/copilot";
import { createFixtureBriefingRetrieval } from "../../src/api/procedures/copilotBriefing";
import type { SystemHealthQueryPort } from "../../src/api/procedures/systemHealth";
import type {
  ApprovalCommandPort,
  DispatchApprovalFn,
  TriagePort,
} from "../../src/api/procedures/commands";

// ── deterministic fixtures ─────────────────────────────────────────────────────

/** A deterministic RNG so the token is fixed per test (mirrors the policy tests). */
function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xa1));
const WRONG: SessionToken = mintSessionToken(fixedRng(0xb2));

/** Reserve a free loopback port so the Origin/Host allowlist can name it BEFORE bind. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** An EMPTY read-model port — every surface returns ok([]) (an absent read-model). */
const emptyReadModel: ReadModelQueryPort = {
  dashboardCards: () => ({ ok: true, value: [] }),
  workspaceCards: () => ({ ok: true, value: [] }),
  projectCards: () => ({ ok: true, value: [] }),
  ingestionInbox: () => ({ ok: true, value: [] }),
  approvalInbox: () => ({ ok: true, value: [] }),
  copilotSurface: () => ({ ok: true, value: [] }),
  globalSurface: () => ({ ok: true, value: [] }),
  recentChanges: () => ({ ok: true, value: [] }),
  projectDashboards: () => ({ ok: true, value: [] }),
};

/** An empty System-Health port (no items; a fail-closed egress default). */
const emptySystemHealth: SystemHealthQueryPort = {
  healthItems: () => ({ ok: true, value: [] }),
  egressStatus: (workspaceId) => ({
    ok: true,
    value: { workspaceId, employerRawEgressAcknowledged: false, zeroEgressOnly: true },
  }),
};

/** A no-op approval command port (never reached by these transport cases). */
const noopApprovals: ApprovalCommandPort = {
  get: () => Promise.resolve({ ok: false, error: { code: "not_found", message: "unwired" } }),
  applyTransition: () =>
    Promise.resolve({ ok: false, error: { code: "not_found", message: "unwired" } }),
};
const noopDispatch: DispatchApprovalFn = () => Promise.resolve({ ok: true, value: undefined });
const noopTriage: TriagePort = {
  reenterIngestion: (input) =>
    Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } }),
};

/** Build the full server deps with the given token + allowlist + empty ports. */
function serverDeps(
  expectedToken: SessionToken,
  allowlist: WorkerOriginAllowlist,
  port: number,
): StartApiServerOptions {
  return {
    expectedToken,
    allowlist,
    readModel: emptyReadModel,
    copilot: {
      retrieval: createFixtureRetrieval({}),
      synthesis: createStubSynthesis(),
      workspacePosture: createLocalWorkspacePosture({}),
      routeSelector: createLocalRouteSelector(),
    },
    briefing: {
      retrieval: createFixtureBriefingRetrieval({}),
      synthesis: createStubSynthesis(),
      workspacePosture: createLocalWorkspacePosture({}),
      routeSelector: createLocalRouteSelector(),
    },
    systemHealth: emptySystemHealth,
    approvals: noopApprovals,
    dispatchApproval: noopDispatch,
    triage: noopTriage,
    now: () => "2026-07-02T00:00:00.000Z",
    host: "127.0.0.1",
    port,
  };
}

/** The origin the client presents (matches the loopback authority for the allowlist). */
function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}
function allowlistFor(port: number): WorkerOriginAllowlist {
  return { origins: [originFor(port)], hosts: [`127.0.0.1:${port}`] };
}

/** The native renderer's Origin (packaged app:// scheme) — a DISTINCT origin from the loopback worker. */
const RENDERER_ORIGIN = "app://sow";

/** A CROSS-ORIGIN allowlist: the renderer Origin admitted ALONGSIDE the loopback Host (9.4b). */
function crossOriginAllowlistFor(port: number): WorkerOriginAllowlist {
  return { origins: [RENDERER_ORIGIN], hosts: [`127.0.0.1:${port}`] };
}

/** Send a raw CORS preflight (OPTIONS) with an arbitrary Origin; capture status + reflected ACAO. */
function preflight(port: number, origin: string): Promise<{ status: number; acao: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "OPTIONS",
        path: "/",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      },
      (res) => {
        res.resume(); // drain the (empty) body
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            acao: res.headers["access-control-allow-origin"] as string | undefined,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

/** Build an HTTP tRPC client that presents `token` (bearer) + `origin`. */
function httpClient(port: number, token: string | undefined, origin: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${port}`,
        headers: () => {
          const h: Record<string, string> = { origin };
          if (token !== undefined) h.authorization = `Bearer ${token}`;
          return h;
        },
      }),
    ],
  });
}

/**
 * A `ws` WebSocket subclass that injects an `Origin` upgrade header — emulating the
 * real Electron renderer (a browser, which sends Origin on a WS upgrade). The Node
 * `ws` client does NOT set Origin by default, so a bare client would fail the
 * worker's Origin/Host allowlist even with a valid token. The worker's WS Origin
 * gate is CORRECT (a browser always sends Origin); the test just mirrors a browser.
 */
function originWebSocket(origin: string): typeof globalThis.WebSocket {
  class OriginWS extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { origin } });
    }
  }
  return OriginWS as unknown as typeof globalThis.WebSocket;
}

/** Build a combined client: HTTP for queries/mutations, WS for subscriptions. */
function fullClient(
  port: number,
  token: string | undefined,
  origin: string,
): { client: ReturnType<typeof createTRPCClient<AppRouter>>; wsClose: () => void } {
  const wsClient = createWSClient({
    url: `ws://127.0.0.1:${port}`,
    // The token rides the FIRST-message connectionParams — NEVER a URL.
    connectionParams: () => (token !== undefined ? { token } : {}),
    // Emulate the browser renderer: send the Origin header on the WS upgrade.
    WebSocket: originWebSocket(origin),
  });
  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({
          url: `http://127.0.0.1:${port}`,
          headers: () => {
            const h: Record<string, string> = { origin };
            if (token !== undefined) h.authorization = `Bearer ${token}`;
            return h;
          },
        }),
      }),
    ],
  });
  return { client, wsClose: () => wsClient.close() };
}

/** A minimal, schema-valid HealthItem to publish onto the stream. */
function healthItem(id: string): HealthItem {
  return {
    id,
    failureClass: "worker_down",
    severity: "error",
    message: "SECRET-SHOULD-NOT-CROSS the wire in a UI-safe payload",
    auditRef: "sha256:audit-ref-should-not-cross" as HealthItem["auditRef"],
    openedAt: "2026-07-02T00:00:00.000Z",
    state: "open",
  };
}

/** Collect subscription items until `count` arrive or `timeoutMs` elapses. */
function collectStream(
  client: ReturnType<typeof createTRPCClient<AppRouter>>,
  input: { lastEventId?: string },
  count: number,
  timeoutMs = 3000,
): Promise<Array<{ id: string; data: unknown }>> {
  return new Promise((resolve, reject) => {
    const out: Array<{ id: string; data: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (client as any).stream.onEvent.subscribe(input, {
      onData: (item: { id: string; data: unknown }) => {
        out.push(item);
        if (out.length >= count) {
          sub.unsubscribe();
          resolve(out);
        }
      },
      onError: (e: unknown) => {
        sub.unsubscribe();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    });
    setTimeout(() => {
      sub.unsubscribe();
      resolve(out);
    }, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SOW_API)("live loopback transport — auth + query + stream + bind", () => {
  it("(a) HTTP query — a WRONG token is rejected pre-handler as a typed err (never runs the work)", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      const client = httpClient(port, WRONG.value, originFor(port));
      const r: Result<unknown, FailureVariant> = await client.query.dashboard.query();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("validation_rejected");
        expect(r.error.message).toBe("unauthenticated");
        // Redaction-safe: neither secret ever enters the failure.
        expect(JSON.stringify(r.error)).not.toContain(WRONG.value);
        expect(JSON.stringify(r.error)).not.toContain(EXPECTED.value);
      }
    } finally {
      await server?.close();
    }
  });

  it("(a) WS handshake — a WRONG token yields NO stream event (subscription completes empty)", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    let wsClose: (() => void) | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      const { client, wsClose: close } = fullClient(port, WRONG.value, originFor(port));
      wsClose = close;
      // Publish an event; a wrong-token subscriber must receive NOTHING.
      server.publisher.publishHealth(healthItem("h-wrongtoken"));
      const items = await collectStream(client, {}, 1, 800);
      expect(items).toHaveLength(0);
    } finally {
      wsClose?.();
      await server?.close();
    }
  });

  it("(b) DNS-rebind — a VALID token but a FOREIGN Origin/Host is rejected on the HTTP path", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      // Right token, but the client presents a foreign Origin (an off-list rebind host).
      const client = httpClient(port, EXPECTED.value, "http://evil.example.com");
      const r: Result<unknown, FailureVariant> = await client.query.dashboard.query();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("validation_rejected");
    } finally {
      await server?.close();
    }
  });

  it("(b) DNS-rebind — a foreign Origin also blocks the WS stream (no event flows)", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    let wsClose: (() => void) | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      const { client, wsClose: close } = fullClient(port, EXPECTED.value, "http://evil.example.com");
      wsClose = close;
      server.publisher.publishHealth(healthItem("h-rebind"));
      const items = await collectStream(client, {}, 1, 800);
      expect(items).toHaveLength(0);
    } finally {
      wsClose?.();
      await server?.close();
    }
  });

  it("(c) VALID token — an empty read-model surfaces as ok([]) with NO secret/raw field", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      const client = httpClient(port, EXPECTED.value, originFor(port));
      const r: Result<readonly unknown[], FailureVariant> = await client.query.dashboard.query();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Array.isArray(r.value)).toBe(true);
        expect(r.value).toHaveLength(0); // empty read-model → ok([])
      }
      // A System-Health query is likewise ok([]) and carries no raw field.
      const health: Result<readonly unknown[], FailureVariant> =
        await client.systemHealth.items.query();
      expect(health.ok).toBe(true);
      if (health.ok) expect(health.value).toHaveLength(0);
    } finally {
      await server?.close();
    }
  });

  it("(d) stream — an event FLOWS to a valid subscriber and RESUMES from lastEventId", async () => {
    const port = await reserveLoopbackPort();
    const allowlist = allowlistFor(port);
    let server: RunningApiServer | undefined;
    let wsClose: (() => void) | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, allowlist, port));
      const { client, wsClose: close } = fullClient(port, EXPECTED.value, originFor(port));
      wsClose = close;

      // Pre-publish two events so a fresh subscribe replays them from the bounded log.
      const e1 = server.publisher.publishHealth(healthItem("h-1"));
      const e2 = server.publisher.publishHealth(healthItem("h-2"));
      expect(e1).toBeDefined();
      expect(e2).toBeDefined();

      // A fresh subscribe (no lastEventId) replays BOTH from the window.
      const all = await collectStream(client, {}, 2, 2500);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const ids = all.map((i) => i.id);
      expect(ids).toContain(e1?.eventId);
      expect(ids).toContain(e2?.eventId);
      // UI-safe payload: the health message / auditRef NEVER cross (projector drops them).
      const payloadJson = JSON.stringify(all.map((i) => i.data));
      expect(payloadJson).not.toContain("SECRET-SHOULD-NOT-CROSS");
      expect(payloadJson).not.toContain("audit-ref-should-not-cross");

      // Resume from the FIRST event id → only the SECOND (and any later) replays.
      const resumed = await collectStream(client, { lastEventId: e1?.eventId }, 1, 2500);
      const resumedIds = resumed.map((i) => i.id);
      expect(resumedIds).toContain(e2?.eventId);
      expect(resumedIds).not.toContain(e1?.eventId); // no dup of the resumed-past event
    } finally {
      wsClose?.();
      await server?.close();
    }
  });

  it("(e) a NON-loopback bind is REFUSED at startup (REQ-NF-004)", async () => {
    await expect(
      startApiServer(serverDeps(EXPECTED, allowlistFor(0), 0)).then((s) => s.close(), (e) => {
        throw e;
      }),
    ).resolves.toBeUndefined(); // a loopback bind (127.0.0.1) SUCCEEDS + closes cleanly.

    // A non-loopback host is refused with the typed error, no socket opened.
    const badDeps: StartApiServerOptions = { ...serverDeps(EXPECTED, allowlistFor(0), 0), host: "0.0.0.0" };
    await expect(startApiServer(badDeps)).rejects.toBeInstanceOf(LoopbackBindRefusedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.4b — the NATIVE cross-origin renderer (a distinct trusted client). The page
// Origin (app://sow) is never the loopback Host (127.0.0.1:<port>), so these pin
// that the REAL transport ADMITS that pairing over sockets AND answers the CORS
// preflight the browser sends — the same-origin cases above never exercised either.
describe.skipIf(!SOW_API)("live loopback transport — native cross-origin renderer (9.4b)", () => {
  it("ADMITS the renderer over HTTP: app://sow Origin + loopback Host + valid token → ok([])", async () => {
    const port = await reserveLoopbackPort();
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, crossOriginAllowlistFor(port), port));
      const client = httpClient(port, EXPECTED.value, RENDERER_ORIGIN);
      const r: Result<readonly unknown[], FailureVariant> = await client.query.dashboard.query();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toHaveLength(0);
    } finally {
      await server?.close();
    }
  });

  it("ADMITS the renderer WS stream: app://sow Origin + valid token → the event flows", async () => {
    const port = await reserveLoopbackPort();
    let server: RunningApiServer | undefined;
    let wsClose: (() => void) | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, crossOriginAllowlistFor(port), port));
      const { client, wsClose: close } = fullClient(port, EXPECTED.value, RENDERER_ORIGIN);
      wsClose = close;
      const ev = server.publisher.publishHealth(healthItem("h-xorigin"));
      const items = await collectStream(client, {}, 1, 2500);
      expect(items.map((i) => i.id)).toContain(ev?.eventId);
    } finally {
      wsClose?.();
      await server?.close();
    }
  });

  it("CORS preflight — an allowlisted Origin gets 204 + the EXACT ACAO (never *)", async () => {
    const port = await reserveLoopbackPort();
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, crossOriginAllowlistFor(port), port));
      const { status, acao } = await preflight(port, RENDERER_ORIGIN);
      expect(status).toBe(204);
      expect(acao).toBe(RENDERER_ORIGIN);
    } finally {
      await server?.close();
    }
  });

  it("CORS preflight — a FOREIGN Origin gets 204 but NO ACAO (the browser blocks it)", async () => {
    const port = await reserveLoopbackPort();
    let server: RunningApiServer | undefined;
    try {
      server = await startApiServer(serverDeps(EXPECTED, crossOriginAllowlistFor(port), port));
      const { status, acao } = await preflight(port, "http://evil.example.com");
      expect(status).toBe(204);
      expect(acao).toBeUndefined();
    } finally {
      await server?.close();
    }
  });
});
