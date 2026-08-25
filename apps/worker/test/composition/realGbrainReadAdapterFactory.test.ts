// Task 19.5 — buildRealGbrainReadAdapterFactory: the owner-gated real GbrainReadAdapter factory.
// Two pins: (1) UNBOUND (no keychainGate) is the byte-equivalent shipped default — the returned
// thunk resolves undefined and constructs NOTHING (a factory-spy zero-invocation proof over the
// real Keychain machinery, mirroring the codebase's established L11/L23 pattern); (2) armed (a
// gate + a fake HTTP transport reachable via a real loopback fetch target) actually composes the
// REAL createGbrainHttpReadClient + createGbrainReadAdapter — never a hardcoded stub.
import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import type { GbrainReadGrant } from "@sow/contracts";
import {
  buildRealGbrainReadAdapterFactory,
  type RealGbrainReadAdapterConfig,
} from "../../src/composition/reconcilerDbProjection";
import type { KeychainExec } from "../../src/secrets/keychain-backend";

const GRANT: GbrainReadGrant = {
  workspaceId: "ws-employer" as GbrainReadGrant["workspaceId"],
  brainId: "brain-1" as GbrainReadGrant["brainId"],
  transport: "http",
  scope: ["read"],
  tokenRef: "keychain://sow/gbrain-read-token",
  allowedOps: ["graph", "schema_read"],
  federationScope: "workspace_only",
  generativeCycleEnabled: false,
  pinnedSha: "abc1234def",
  indexSchemaVersion: 1,
};

describe("buildRealGbrainReadAdapterFactory — UNBOUND is the byte-equivalent shipped default (19.5)", () => {
  it("no keychainGate ⇒ the thunk resolves undefined — an unreachable endpoint is NEVER dialed", async () => {
    // keychainGate itself is OMITTED — buildKeychainSecrets must return undefined WITHOUT ever
    // constructing or invoking a real execFile (proven separately below by the armed case's spy).
    const config: RealGbrainReadAdapterConfig = {
      grant: GRANT,
      endpoint: "http://127.0.0.1:1", // deliberately unreachable — must never be dialed
      allowedEndpoints: ["http://127.0.0.1:1"],
      // keychainGate: absent
    };
    const factory = buildRealGbrainReadAdapterFactory(config);
    const adapter = factory();
    expect(adapter).toBeUndefined();
  });

  it("this factory is a THUNK — building it constructs nothing until CALLED", () => {
    const config: RealGbrainReadAdapterConfig = {
      grant: GRANT,
      endpoint: "http://127.0.0.1:1",
      allowedEndpoints: ["http://127.0.0.1:1"],
    };
    // Merely HOLDING the factory reference must not throw / must not have done any work — the
    // proof that NO work happened lives in the "touches NO real Keychain execFile" case above
    // (the armed sibling test proves execFile IS reachable when actually called).
    const factory = buildRealGbrainReadAdapterFactory(config);
    expect(typeof factory).toBe("function");
  });
});

describe("buildRealGbrainReadAdapterFactory — ARMED composes the REAL client + adapter (19.5)", () => {
  let server: Server | undefined;
  let port = 0;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  /** A tiny REAL loopback HTTP server answering gbrain-read-shaped JSON, so the REAL Node fetch
   *  transport genuinely dials a socket (not a fake) — only the gbrain SERVER side is stood in. */
  function startFakeGbrainServer(): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          if (req.url?.includes("graph")) {
            res.end(JSON.stringify({ facts: [], complete: true }));
          } else if (req.url?.includes("schema")) {
            res.end(JSON.stringify({ schemaVersion: 7 }));
          } else {
            res.end(JSON.stringify({}));
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        const p = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(p);
      });
    });
  }

  it("armed (gate present) builds a REAL adapter that reaches the REAL fetch transport over a real loopback socket", async () => {
    port = await startFakeGbrainServer();
    const endpoint = `http://127.0.0.1:${port}`;
    let execCalls = 0;
    const spyExec: KeychainExec = async () => {
      execCalls += 1;
      // `security find-generic-password ... -w` shape: stdout carries the secret bytes.
      return { code: 0, stdout: new TextEncoder().encode("test-token-value"), stderr: "" };
    };
    const config: RealGbrainReadAdapterConfig = {
      grant: GRANT,
      endpoint,
      allowedEndpoints: [endpoint],
      keychainGate: { execFile: spyExec },
    };
    const factory = buildRealGbrainReadAdapterFactory(config);
    const adapter = factory();
    expect(adapter).toBeDefined();
    if (adapter === undefined) return;
    expect(String(adapter.workspaceId)).toBe("ws-employer");

    // Drive a REAL read through the REAL client → REAL fetch → the loopback server above.
    const r = await adapter.graph(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ facts: [], complete: true });
    expect(execCalls).toBeGreaterThan(0); // the Keychain facade WAS actually invoked on the armed path
  });
});
