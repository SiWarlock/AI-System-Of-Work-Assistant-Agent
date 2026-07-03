import { describe, it, expect } from "vitest";
import { authHeaders } from "../../renderer/lib/trpc";

describe("worker client auth headers (9.2 — matches worker api/mount bearerFromHeader)", () => {
  it("attaches the token as an Authorization: Bearer value", () => {
    expect(authHeaders("tok_abc123")).toEqual({ authorization: "Bearer tok_abc123" });
  });

  it("carries the token verbatim (no transform that would fail constant-time verify)", () => {
    const token = "AZ-az-09_deadbeef";
    expect(authHeaders(token).authorization).toBe(`Bearer ${token}`);
  });

  it("exposes ONLY the authorization header (Origin is the ambient page origin, not forged here)", () => {
    expect(Object.keys(authHeaders("x"))).toEqual(["authorization"]);
  });
});
