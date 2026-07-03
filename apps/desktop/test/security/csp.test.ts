import { describe, it, expect } from "vitest";
import { cspHeader } from "../../main/security";

describe("renderer CSP (§5 — unprivileged renderer)", () => {
  const prod = cspHeader(false);

  it("production forbids inline/eval script and restricts to same-origin", () => {
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("script-src 'self'");
    expect(prod).not.toContain("unsafe-inline'; script"); // no inline in script-src
    expect(prod).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(prod).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("permits the loopback worker API over http + ws only", () => {
    expect(prod).toMatch(/connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
    expect(prod).toMatch(/connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);
  });

  it("locks down object/base/form/frame vectors", () => {
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("base-uri 'none'");
    expect(prod).toContain("form-action 'none'");
    expect(prod).toContain("frame-ancestors 'none'");
  });

  it("production does NOT reach out to a non-loopback origin", () => {
    expect(prod).not.toContain("localhost:*"); // dev-only Vite HMR origin
  });
});
