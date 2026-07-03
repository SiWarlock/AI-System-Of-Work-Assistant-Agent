import { describe, it, expect } from "vitest";
import {
  WORKER_LOOPBACK_HOST,
  WORKER_LOOPBACK_PORT,
  rendererOrigin,
  buildWorkerAllowlist,
  workerConnection,
} from "../../main/worker-launch";

// The worker binds a FIXED loopback port so the allowlist (a bootWorker INPUT) and
// the client URLs are deterministic BEFORE the child reports ready — the ephemeral
// port would be a chicken/egg (the allowlist must name the port up front). The
// single-instance lock prevents a self-collision.
describe("worker-launch — deterministic loopback bind + client URLs", () => {
  it("pins a fixed, non-privileged loopback port + host", () => {
    expect(WORKER_LOOPBACK_HOST).toBe("127.0.0.1");
    expect(Number.isInteger(WORKER_LOOPBACK_PORT)).toBe(true);
    expect(WORKER_LOOPBACK_PORT).toBeGreaterThan(1023); // non-privileged
    expect(WORKER_LOOPBACK_PORT).toBeLessThan(65536);
  });

  it("builds both loopback transport URLs for the renderer", () => {
    expect(workerConnection(47100)).toEqual({
      httpUrl: "http://127.0.0.1:47100",
      wsUrl: "ws://127.0.0.1:47100",
    });
  });
});

// The renderer is a DISTINCT origin from the worker; main decides which per launch
// mode and hands the worker an allowlist naming ONLY that origin.
describe("rendererOrigin — the page's origin per launch mode", () => {
  it("prod → the packaged app:// scheme origin", () => {
    expect(rendererOrigin("prod")).toBe("app://sow");
  });

  it("dev → the Vite dev-server ORIGIN (scheme+host+port, path stripped)", () => {
    expect(rendererOrigin("dev", "http://localhost:5173")).toBe("http://localhost:5173");
    expect(rendererOrigin("dev", "http://localhost:5173/index.html")).toBe("http://localhost:5173");
  });

  it("dev without a dev URL fails closed (cannot name an origin it doesn't know)", () => {
    expect(() => rendererOrigin("dev")).toThrow();
  });
});

// The anti-DNS-rebind guarantee now rests ENTIRELY on this allowlist's tightness
// (the worker's Origin==Host equality backstop was removed in 9.4b). So the builder
// enforces the security-reviewer Q4 discipline: exact port pinned in every host,
// no bare-host entry, one scheme-exact origin, dev/prod NEVER merged.
describe("buildWorkerAllowlist — tight, mode-isolated, port-pinned", () => {
  it("prod → exactly [app://sow] origin + [127.0.0.1:<port>] host", () => {
    expect(buildWorkerAllowlist("prod", 47100)).toEqual({
      origins: ["app://sow"],
      hosts: ["127.0.0.1:47100"],
    });
  });

  it("dev → exactly the Vite origin + the pinned loopback host", () => {
    expect(buildWorkerAllowlist("dev", 47100, "http://localhost:5173")).toEqual({
      origins: ["http://localhost:5173"],
      hosts: ["127.0.0.1:47100"],
    });
  });

  it("Q4: every host entry carries the EXACT port — never a bare host", () => {
    const { hosts } = buildWorkerAllowlist("prod", 51234);
    expect(hosts).toEqual(["127.0.0.1:51234"]);
    for (const h of hosts) expect(h).toMatch(/:\d+$/);
  });

  it("Q4: NEVER merges dev+prod — exactly one origin and one host per launch", () => {
    const prod = buildWorkerAllowlist("prod", 47100);
    const dev = buildWorkerAllowlist("dev", 47100, "http://localhost:5173");
    expect(prod.origins).toHaveLength(1);
    expect(dev.origins).toHaveLength(1);
    expect(prod.origins).not.toContain("http://localhost:5173");
    expect(dev.origins).not.toContain("app://sow");
  });

  it("dev without a dev origin throws (no lax fallback that could widen the surface)", () => {
    expect(() => buildWorkerAllowlist("dev", 47100)).toThrow();
  });

  it("rejects a non-integer / out-of-range port (fail-closed)", () => {
    expect(() => buildWorkerAllowlist("prod", 0)).toThrow();
    expect(() => buildWorkerAllowlist("prod", 70000)).toThrow();
    expect(() => buildWorkerAllowlist("prod", 47100.5)).toThrow();
  });
});
