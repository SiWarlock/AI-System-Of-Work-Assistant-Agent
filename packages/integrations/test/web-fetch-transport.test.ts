// Task 13.2a — the DORMANT web source real-parse transport (the first source-extractor
// real-parse leg). A PURE deterministic `parseReadabilityHtml(html,url)` (tag-strip →
// tag-free plain text, `<title>`→title, empty→`empty_content`; NO DOM lib) + a thin
// SSRF-guarded `createWebFetchTransport({httpGet,allowedHosts})` over an INJECTED
// httpGet. Emit-only (rule 1), TOTAL never-throws (L11), fail-closed. Real network fetch
// binds ONLY at §ARM-23 — every test injects a fake httpGet (no real I/O).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { WebFetchResult } from "../src/connectors/adapters/web-source";
import {
  parseReadabilityHtml,
  createWebFetchTransport,
  type WebHttpGet,
} from "../src/connectors/adapters/web-fetch-transport";

const ARTICLE_URL = "https://example.com/article";

// ── parseReadabilityHtml — pure, deterministic, tag-free text ─────────────────
describe("parseReadabilityHtml — text ← tag-stripped plain text, never raw markup", () => {
  it("maps a fixture HTML → WebPage with tag-free text + title; no markup/script leaks", () => {
    const html =
      "<html><head><title>My Title</title></head><body><article><h1>Head</h1>" +
      '<p>Hello <b>world</b> &amp; more.</p><script>evil("<x>")</script>' +
      "<style>.a{color:red}</style></article></body></html>";
    const res = parseReadabilityHtml(html, ARTICLE_URL);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.url).toBe(ARTICLE_URL);
    expect(res.value.title).toBe("My Title");
    // Tag-free plain text: content preserved, entities decoded, NO markup / script / style leaks.
    expect(res.value.text).toContain("Head");
    expect(res.value.text).toContain("Hello world");
    expect(res.value.text).toContain("& more");
    expect(res.value.text).not.toContain("<"); // no raw markup
    expect(res.value.text).not.toContain("evil"); // script content stripped
    expect(res.value.text).not.toContain("color:red"); // style content stripped
    // byline/publishedAt are HONESTLY omitted (not fabricated — REQ-F-017; real readability at §ARM-23).
    expect(res.value.byline).toBeUndefined();
    expect(res.value.publishedAt).toBeUndefined();
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only body", "<html><body>   </body></html>"],
    ["tags-only (no text)", "<div><span></span></div>"],
    ["script/style only", "<script>x()</script><style>.a{}</style>"],
  ])("empty/whitespace readability (%s) ⇒ empty_content fault, never a contentless WebPage", (_label, html) => {
    const res = parseReadabilityHtml(html, ARTICLE_URL);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("empty_content");
  });

  it("a whitespace-only ENTITY body (&nbsp;) ⇒ empty_content (doesn't slip past the empty check)", () => {
    const res = parseReadabilityHtml("<html><body>&nbsp;&nbsp;&nbsp;</body></html>", ARTICLE_URL);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("empty_content");
  });

  it("an UNTERMINATED trailing tag is stripped — no raw markup / attribute (token) leak into text", () => {
    // Truncated/malformed page (or the length-cap slicing mid-tag): the unterminated tag must NOT
    // survive into the candidate text — no raw `<`, no attribute-borne token.
    const res = parseReadabilityHtml("Read this <a href=https://leak.example/?tok=SECRET", ARTICLE_URL);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.text).not.toContain("<");
      expect(res.value.text.includes("SECRET")).toBe(false);
      expect(res.value.text).toContain("Read this");
    }
  });

  it("is LINEAR (no O(n²)) on a pathological `<`-run — completes fast + leaks no markup (L9)", () => {
    // A 2M-char run of `<` with no `>` — the O(n²) bait for a naive /<[^>]*>/. A linear scan
    // finishes in ms; the default vitest timeout fails a quadratic/hung regex. (Text BEFORE the
    // run survives; the unterminated `<`-run to end-of-string is stripped as one tag.)
    const bomb = "visible text " + "<".repeat(2_000_000);
    const res = parseReadabilityHtml(bomb, ARTICLE_URL);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.text).not.toContain("<"); // the whole `<`-run stripped
      expect(res.value.text).toContain("visible text");
    }
  });
});

// ── createWebFetchTransport — SSRF-guard-before-fetch + fail-closed ────────────
const ALLOWED = ["example.com"] as const;

function spyGet(impl: WebHttpGet): { httpGet: WebHttpGet; calls: () => number } {
  const fn = vi.fn(impl);
  return { httpGet: fn, calls: () => fn.mock.calls.length };
}

describe("createWebFetchTransport — SSRF guard BEFORE fetch (rule 5 / L4)", () => {
  it.each([
    ["loopback", "https://127.0.0.1/x"],
    ["localhost", "https://localhost/x"],
    ["private RFC-1918", "https://192.168.1.10/x"],
    ["non-https", "http://example.com/x"],
    ["non-allowlisted host", "https://evil.com/x"],
  ])("a %s url ⇒ typed fault with ZERO bytes fetched (guard-before-fetch)", async (_label, url) => {
    const { httpGet, calls } = spyGet(async () => ({ status: 200, body: "<p>x</p>" }));
    const transport = createWebFetchTransport({ httpGet, allowedHosts: [...ALLOWED] });
    const res = await transport({ url });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
    expect(calls()).toBe(0); // NOTHING fetched — the SSRF guard ran first
  });

  it("an allowlisted https host ⇒ fetch proceeds and parses to a WebPage", async () => {
    const { httpGet, calls } = spyGet(async () => ({
      status: 200,
      body: "<html><head><title>T</title></head><body><p>Real article body.</p></body></html>",
    }));
    const transport = createWebFetchTransport({ httpGet, allowedHosts: [...ALLOWED] });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.page.url).toBe(ARTICLE_URL);
      expect(res.page.text).toContain("Real article body");
    }
    expect(calls()).toBe(1);
  });
});

describe("createWebFetchTransport — TOTAL never-throws + rule-7 safe messages", () => {
  it("a THROWING httpGet ⇒ redacted 'unknown' fault, never throws (raw cause discarded)", async () => {
    const transport = createWebFetchTransport({
      httpGet: async () => { throw new Error("SECRET-in-error boom https://internal/x"); },
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unknown");
      expect(res.message.includes("SECRET")).toBe(false); // raw cause NOT echoed (rule 7)
    }
  });

  it("a non-2xx status ⇒ 'unreachable' carrying ONLY the safe status (no body echo)", async () => {
    const transport = createWebFetchTransport({
      httpGet: async () => ({ status: 503, body: "<secret>internal error page</secret>" }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unreachable");
      expect(res.message.includes("secret")).toBe(false);
      expect(res.message.includes("internal error page")).toBe(false);
    }
  });

  it("a 2xx with an empty/contentless body ⇒ 'unknown' with a FIXED SAFE LITERAL (never echoes the body)", async () => {
    const transport = createWebFetchTransport({
      httpGet: async () => ({ status: 200, body: "<html><body><!-- SENSITIVE-MARKER --></body></html>" }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unknown");
      expect(res.message.includes("SENSITIVE-MARKER")).toBe(false); // fixed literal, no body echo
    }
  });

  it("a pathological non-string body ⇒ typed fault, never throws", async () => {
    const transport = createWebFetchTransport({
      httpGet: async () => ({ status: 200, body: null as unknown as string }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(false); // degrades (no throw)
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["undefined", undefined as unknown as number],
  ])("a non-integer status (%s) fails CLOSED — the untrusted body is NOT parsed as 2xx success", async (_label, status) => {
    const transport = createWebFetchTransport({
      httpGet: async () => ({ status, body: "<html><body><p>malicious success body</p></body></html>" }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ url: ARTICLE_URL });
    expect(res.ok).toBe(false); // NEVER a parsed WebPage on a non-integer status
    if (!res.ok) expect(res.code).toBe("unreachable");
  });
});

// ── emit-only + dormant (source-scans) ────────────────────────────────────────
describe("web-fetch-transport — emit-only (rule 1) + dormant (§ARM-23)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/adapters/web-fetch-transport.ts", import.meta.url)),
    "utf8",
  );

  it("emit-only — no @sow/knowledge / fs-write import (L12 write-surface scan — import-anchored, not prose)", () => {
    // Anchor to IMPORT PATHS / CALL sites, not bare symbols — a doc-comment naming
    // `@sow/knowledge` (the sole writer) must not false-positive the scan (L12).
    for (const forbidden of ['from "@sow/knowledge"', 'from "node:fs"', 'from "fs"', "writeFile(", "createFsVault(", "copyFile("]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — the module constructs NO real HTTP client (injected httpGet is the sole seam)", () => {
    for (const forbidden of ["node:https", "node:http", "undici", "axios", "fetch(", "XMLHttpRequest"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — no production caller CONSTRUCTS the transport (unbound seam; real bind = §ARM-23)", () => {
    // The transport is EXPORTED but UNBOUND: only the test constructs it (with a fake httpGet).
    // The barrel RE-EXPORTS the name (`export { createWebFetchTransport }`) but never CALLS it —
    // a production caller wiring a real fetch would be the §ARM-23 arming bind (not this slice).
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("web-fetch-transport.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createWebFetchTransport("));
    expect(callers).toEqual([]); // zero production callers
  });
});
