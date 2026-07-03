import { describe, it, expect } from "vitest";
import { resolveCors, CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "../../../src/api/auth/cors";

// The renderer is a distinct origin (app://sow / http://localhost:5173) calling
// the loopback worker cross-origin with a custom `Authorization` header. That
// triggers a CORS preflight, and the browser blocks the response unless the
// worker reflects an EXACT allowlisted Origin. `resolveCors` is the pure decision
// the transport applies; it NEVER emits `*` and NEVER reflects an off-list Origin.
const ORIGINS = ["app://sow", "http://localhost:5173"] as const;

describe("resolveCors — strict single-origin CORS for the native renderer", () => {
  it("answers a preflight (OPTIONS) from an allowlisted Origin with exact-Origin CORS headers", () => {
    const out = resolveCors("OPTIONS", "app://sow", ORIGINS);
    expect(out.shortCircuitStatus).toBe(204);
    expect(out.headers["Access-Control-Allow-Origin"]).toBe("app://sow");
    expect(out.headers["Access-Control-Allow-Headers"]).toBe(CORS_ALLOW_HEADERS);
    expect(out.headers["Access-Control-Allow-Methods"]).toBe(CORS_ALLOW_METHODS);
    // Caches must not serve one origin's ACAO to another.
    expect(out.headers["Vary"]).toBe("Origin");
  });

  it("NEVER reflects `*` and NEVER sends Allow-Credentials (token is a header, not a cookie)", () => {
    const out = resolveCors("OPTIONS", "app://sow", ORIGINS);
    expect(out.headers["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(out.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("answers a preflight from a FOREIGN Origin with 204 but NO ACAO (browser blocks it)", () => {
    const out = resolveCors("OPTIONS", "http://evil.com", ORIGINS);
    expect(out.shortCircuitStatus).toBe(204);
    expect(out.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("sets exact-Origin ACAO on an actual request (POST) from an allowlisted Origin, no short-circuit", () => {
    const out = resolveCors("POST", "http://localhost:5173", ORIGINS);
    expect(out.shortCircuitStatus).toBeUndefined();
    expect(out.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  it("sets NO ACAO on an actual request from a foreign Origin (browser blocks the read)", () => {
    const out = resolveCors("GET", "http://evil.com", ORIGINS);
    expect(out.shortCircuitStatus).toBeUndefined();
    expect(out.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("is exact-match strict — a near-miss Origin variant gets no ACAO", () => {
    expect(resolveCors("POST", "app://sow/", ORIGINS).headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(resolveCors("POST", "APP://SOW", ORIGINS).headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("fails safe on a missing Origin (no header → no ACAO)", () => {
    expect(resolveCors("POST", undefined, ORIGINS).headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(resolveCors("OPTIONS", undefined, ORIGINS).shortCircuitStatus).toBe(204);
  });
});
