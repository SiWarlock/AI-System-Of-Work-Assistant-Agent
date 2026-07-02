// spec(§5) — SINGLE-SOURCE URL-authority isolator (root CLAUDE.md Lesson 4).
//
// converge-url-authority: the vetted Lesson-4-safe authority isolator + the
// loopback-host predicate were module-PRIVATE in processors.ts, so Phase-8.1
// (worker auth gate) RE-IMPLEMENTED them. Lesson 4's meta-lesson is that the
// ORDER of stripping (isolate authority — scheme + path/query/fragment/backslash
// — BEFORE the last-@ userinfo strip) is a SECURITY BOUNDARY, and two copies can
// drift. This suite pins the now-PUBLIC single source (@sow/policy exports
// extractAuthority, extractHost, isLoopbackHost) with the adversarial vectors
// BOTH the policy egress veto and the worker auth gate depend on, so the one
// copy stays adversarially covered.
import { describe, it, expect } from "vitest";
import { extractAuthority, extractHost, isLoopbackHost } from "../src/processors";

describe("extractAuthority — Lesson-4-safe authority isolation, PORT PRESERVED", () => {
  // The authority token keeps host[:port] (lowercased) — this is what the worker
  // Origin/Host allowlist matches against (its entries carry the port, e.g.
  // `localhost:5173`, so an off-port caller must not collapse onto an on-port entry).
  it.each([
    ["http://localhost:5173", "localhost:5173"],
    ["http://LOCALHOST:5173", "localhost:5173"],
    ["app://sow", "sow"],
    ["localhost:5173", "localhost:5173"],
    ["http://127.0.0.1:11434/v1", "127.0.0.1:11434"],
    ["//localhost:5173", "localhost:5173"],
  ])("extractAuthority(%s) === %s", (raw, expected) => {
    expect(extractAuthority(raw)).toBe(expected);
  });

  // ORDER-OF-STRIPPING boundary (Lesson 4): an `@` AFTER the first `/ ? # \` is
  // in the PATH/QUERY/FRAGMENT, NOT userinfo — the authority (evil.com) must be
  // isolated FIRST, so the loopback literal in the path never becomes the host.
  it.each([
    ["http://evil.com/@localhost:5173", "evil.com"],
    ["http://evil.com?@localhost:5173", "evil.com"],
    ["http://evil.com#@localhost:5173", "evil.com"],
    ["http://evil.com\\@localhost:5173", "evil.com"],
    ["http://user@evil.com", "evil.com"],
    ["http://user:pass@evil.com:8080", "evil.com:8080"],
  ])("extractAuthority(%s) isolates authority to %s (order-of-stripping)", (raw, expected) => {
    expect(extractAuthority(raw)).toBe(expected);
  });

  it("returns null for empty / whitespace-only input (fail-closed)", () => {
    expect(extractAuthority("")).toBeNull();
    expect(extractAuthority("   ")).toBeNull();
  });
});

describe("extractHost — authority isolation THEN port strip (host only)", () => {
  // extractHost is extractAuthority reduced to the bare host (port stripped,
  // IPv6 brackets removed) — the form the loopback PROOF (isLoopbackEndpoint)
  // and the redaction-safe endpointHostRef consume.
  it.each([
    ["http://localhost:5173", "localhost"],
    ["127.0.0.1:11434", "127.0.0.1"],
    ["http://[::1]:8080", "::1"],
    ["::1", "::1"],
    ["http://evil.com/@127.0.0.1", "evil.com"],
    ["http://user:pass@host.example:443/x", "host.example"],
  ])("extractHost(%s) === %s", (raw, expected) => {
    expect(extractHost(raw)).toBe(expected);
  });

  it("returns null for empty input (fail-closed)", () => {
    expect(extractHost("")).toBeNull();
  });
});

describe("isLoopbackHost — exact loopback predicate (spoof-resistant)", () => {
  it.each(["localhost", "127.0.0.1", "127.255.255.254", "127.0.0.0", "::1", "0:0:0:0:0:0:0:1"])(
    "true for genuine loopback host %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  // The EXACT four-octet 127-range + exact localhost/::1 reject the suffix/prefix
  // spoofs the worker loopback-bind assertion also depends on.
  it.each([
    "127.0.0.1.attacker.com",
    "localhost.evil.com",
    "0.0.0.0",
    "192.168.1.10",
    "10.0.0.5",
    "::",
    "example.com",
    "127.0.0.256",
    "",
  ])("false for non-loopback / spoofed host %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
