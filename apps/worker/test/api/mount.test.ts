// Task R10-a1 — converge the two WebSocket handshake implementations. `makeWsContext`
// (api/mount.ts) used to hand-roll its OWN token-extraction + interceptor call; it now
// delegates to `runStreamHandshake` (api/stream/handshake.ts) — the ONE handshake
// implementation, already comprehensively pinned by
// test/api/stream/pushStream.test.ts's `runStreamHandshake` describe block AND
// exercised end-to-end over a real socket by test/integration/api-live.test.ts
// (SOW_API-gated). This is the DIRECT unit-level pin on `makeWsContext` itself,
// proving the convergence at the exact call site that changed — a fake
// `CreateWSSContextFnOptions` in, the SAME typed auth Result out that
// `runStreamHandshake` would produce for the same inputs.
import { describe, it, expect } from "vitest";
import type { CreateWSSContextFnOptions } from "@trpc/server/adapters/ws";
import { isOk, isErr } from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import { makeAuthInterceptor } from "../../src/api/auth/interceptor";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";
import { runStreamHandshake } from "../../src/api/stream/handshake";
import { makeWsContext } from "../../src/api/mount";

function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xc7));
const WRONG: SessionToken = mintSessionToken(fixedRng(0xd8));
const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173"],
  hosts: ["localhost:5173"],
};
const INTERCEPTOR = makeAuthInterceptor({ expectedToken: EXPECTED, allowlist: ALLOWLIST });

/** A minimal fake matching exactly what `makeWsContext` destructures — `req.headers` +
 *  `info.connectionParams` — cast to the adapter's own option type at the call site. */
function fakeWsOpts(input: {
  readonly connectionParams: Record<string, string> | null;
  readonly origin?: string;
  readonly host?: string;
}): CreateWSSContextFnOptions {
  return {
    req: { headers: { origin: input.origin, host: input.host } },
    res: {},
    info: { connectionParams: input.connectionParams },
  } as unknown as CreateWSSContextFnOptions;
}

describe("makeWsContext — converged onto runStreamHandshake (R10-a1)", () => {
  it("a valid token + allowlisted Origin/Host admits — matches runStreamHandshake's own verdict for the same inputs", () => {
    const ctx = makeWsContext(INTERCEPTOR)(
      fakeWsOpts({ connectionParams: { token: EXPECTED.value }, origin: "http://localhost:5173", host: "localhost:5173" }),
    );
    expect(isOk(ctx.auth)).toBe(true);

    const direct = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(ctx.auth).toEqual(direct); // byte-identical to calling the surviving path directly
  });

  it("null connectionParams (no first message yet) rejects — UNAUTHORIZED, never a throw", () => {
    const ctx = makeWsContext(INTERCEPTOR)(
      fakeWsOpts({ connectionParams: null, origin: "http://localhost:5173", host: "localhost:5173" }),
    );
    expect(isErr(ctx.auth)).toBe(true);
    if (isErr(ctx.auth)) expect(ctx.auth.error.message).toBe("unauthenticated");
  });

  it("a WRONG token rejects — matches runStreamHandshake's own verdict", () => {
    const ctx = makeWsContext(INTERCEPTOR)(
      fakeWsOpts({ connectionParams: { token: WRONG.value }, origin: "http://localhost:5173", host: "localhost:5173" }),
    );
    expect(isErr(ctx.auth)).toBe(true);

    const direct = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: WRONG.value },
      origin: "http://localhost:5173",
      host: "localhost:5173",
    });
    expect(ctx.auth).toEqual(direct);
  });

  it("a valid token but a FOREIGN Origin rejects (DNS-rebind) — matches runStreamHandshake", () => {
    const ctx = makeWsContext(INTERCEPTOR)(
      fakeWsOpts({ connectionParams: { token: EXPECTED.value }, origin: "http://evil.com", host: "localhost:5173" }),
    );
    expect(isErr(ctx.auth)).toBe(true);

    const direct = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://evil.com",
      host: "localhost:5173",
    });
    expect(ctx.auth).toEqual(direct);
  });

  it("a token smuggled into a non-'token' connectionParams key is treated as absent — matches runStreamHandshake (token never from a URL/alt field)", () => {
    const ctx = makeWsContext(INTERCEPTOR)(
      fakeWsOpts({
        connectionParams: { url: `ws://localhost:5173/?token=${EXPECTED.value}` },
        origin: "http://localhost:5173",
        host: "localhost:5173",
      }),
    );
    expect(isErr(ctx.auth)).toBe(true);
    if (isErr(ctx.auth)) expect(ctx.auth.error.message).toBe("unauthenticated");
  });
});
