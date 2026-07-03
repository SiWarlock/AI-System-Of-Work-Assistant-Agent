import { describe, it, expect } from "vitest";
import { resolveAppRequest } from "../../main/app-protocol";

// In prod the renderer is served from a custom `app://sow` privileged scheme (NOT
// file:// — which has an opaque `null` origin and broad filesystem semantics). The
// protocol handler maps an `app://sow/<path>` request to a file UNDER the built
// renderer root. It MUST be traversal-safe: a request can never escape the root.
const ROOT = "/app/out/renderer";

describe("resolveAppRequest — traversal-safe static resolution for app://sow", () => {
  it("maps the app root to index.html", () => {
    expect(resolveAppRequest("app://sow/", ROOT)).toBe("/app/out/renderer/index.html");
    expect(resolveAppRequest("app://sow", ROOT)).toBe("/app/out/renderer/index.html");
  });

  it("maps a nested asset path under the root", () => {
    expect(resolveAppRequest("app://sow/assets/main-abc123.js", ROOT)).toBe(
      "/app/out/renderer/assets/main-abc123.js",
    );
  });

  it("maps a directory request to its index.html", () => {
    expect(resolveAppRequest("app://sow/sub/", ROOT)).toBe("/app/out/renderer/sub/index.html");
  });

  it("neutralizes a literal ../ via URL path normalization (cannot escape root)", () => {
    // `new URL()` collapses `..` relative to the host root, so a literal climb can
    // never rise above the root — it resolves to an in-root path (a 404 if absent),
    // NOT an escape. The defense-in-depth containment check below catches the vector
    // the URL layer does NOT normalize: the percent-encoded traversal.
    expect(resolveAppRequest("app://sow/../secret.txt", ROOT)).toBe("/app/out/renderer/secret.txt");
    expect(resolveAppRequest("app://sow/assets/../../secret.txt", ROOT)).toBe(
      "/app/out/renderer/secret.txt",
    );
  });

  it("REJECTS a percent-encoded traversal (..%2f) that the URL layer leaves opaque", () => {
    expect(resolveAppRequest("app://sow/..%2f..%2fetc/passwd", ROOT)).toBeNull();
  });

  it("REJECTS a NUL-byte injection", () => {
    expect(resolveAppRequest("app://sow/index.html%00.png", ROOT)).toBeNull();
  });

  it("returns null on a malformed URL / percent-encoding", () => {
    expect(resolveAppRequest("::::not a url", ROOT)).toBeNull();
    expect(resolveAppRequest("app://sow/%E0%A4%A", ROOT)).toBeNull();
  });

  it("does not admit a shared-prefix sibling via an encoded escape (the + sep guard)", () => {
    // An encoded `..%2f` climb that lands on `/app/out/renderer-evil` must NOT be
    // admitted just because it shares the root's string prefix — the `root + sep`
    // containment check rejects it.
    expect(resolveAppRequest("app://sow/..%2frenderer-evil/x", ROOT)).toBeNull();
  });
});
