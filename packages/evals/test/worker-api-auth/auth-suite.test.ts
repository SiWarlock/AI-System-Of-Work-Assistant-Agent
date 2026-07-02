// spec(§12) — AUTH §12 named suite runner spec (Task 8.7). Runs the AUTH suite
// against the REAL 8.1 worker auth modules and asserts the DoD gate: every reject
// vector (no-token / wrong-token / wrong-Origin / wrong-Host) is refused at BOTH
// the tRPC command/query boundary AND the WS handshake BEFORE any handler/
// subscription, and loopback-only bind (REQ-NF-004) holds. A single failing case
// fails the gate.
import { describe, it, expect } from "vitest";
import { runAuthSuite, AUTH_SUITE_NAME } from "../../src/worker-api-auth/auth-suite";

describe("§12 AUTH suite — worker-api-auth.auth", () => {
  it("passes every case (the DoD gate for phase-exit 8)", async () => {
    const result = await runAuthSuite();
    // Surface the first failing case ids so a regression is legible in CI output.
    const failed = result.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail ?? ""}`);
    expect(failed, `failing cases:\n${failed.join("\n")}`).toEqual([]);
    expect(result.allPassed).toBe(true);
    expect(result.suite).toBe(AUTH_SUITE_NAME);
  });

  it("exercises BOTH the tRPC boundary AND the WS handshake for all reject vectors", async () => {
    const result = await runAuthSuite();
    const ids = new Set(result.cases.map((c) => c.id));
    for (const v of ["no-token", "wrong-token", "wrong-origin", "wrong-host"]) {
      // tRPC command/query boundary.
      expect(ids.has(`auth.query.${v}`)).toBe(true);
      expect(ids.has(`auth.command.${v}`)).toBe(true);
      // WS stream handshake + subscription.
      expect(ids.has(`auth.stream.handshake.${v}`)).toBe(true);
      expect(ids.has(`auth.stream.subscribe.${v}`)).toBe(true);
    }
  });

  it("asserts loopback-only bind (REQ-NF-004): non-loopback refused, loopback admitted", async () => {
    const result = await runAuthSuite();
    const byId = new Map(result.cases.map((c) => [c.id, c] as const));
    // A representative non-loopback bind is refused (case passes ⇒ refusal held).
    expect(byId.get("auth.bind.refuse.0.0.0.0")?.passed).toBe(true);
    expect(byId.get("auth.bind.refuse.127.0.0.1.evil.com")?.passed).toBe(true);
    // Loopback is admitted.
    expect(byId.get("auth.bind.admit.127.0.0.1")?.passed).toBe(true);
    expect(byId.get("auth.bind.admit.::1")?.passed).toBe(true);
  });

  it("proves the command handler NEVER runs pre-auth (the port trip-wire stays clean)", async () => {
    // The auth.command.* cases fail if the injected port was touched on a rejected
    // vector — so their collective pass is the pre-handler proof.
    const result = await runAuthSuite();
    const commandRejectCases = result.cases.filter((c) => c.id.startsWith("auth.command."));
    expect(commandRejectCases.every((c) => c.passed)).toBe(true);
  });
});
