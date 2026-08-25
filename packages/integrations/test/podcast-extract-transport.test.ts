// Task 13.2b — the DORMANT podcast real-extract transport (the second source-extractor real-parse
// leg). A PURE deterministic `parseRssFeed(xml, episodeId)` (RSS-2.0 item ← guid match → episodeId/
// title/showTitle/publishedAt/audioUrl; transcript ALWAYS "" — RSS never carries inline transcript
// text, Context7-verified) + a thin SSRF-guarded `createPodcastExtractTransport({httpGet,
// allowedHosts})` over an INJECTED httpGet that fails an audio-only episode CLOSED (never reaches
// podcast-source.ts's `empty_content` guard with a fabricated transcript). Emit-only (rule 1), TOTAL
// never-throws (L11), fail-closed. Real network fetch binds ONLY at §ARM-23 — every test injects a
// fake httpGet (no real I/O).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  parseRssFeed,
  createPodcastExtractTransport,
  type PodcastHttpGet,
} from "../src/connectors/adapters/podcast-extract-transport";

const FEED_URL = "https://example.com/feed.xml";
const ALLOWED = ["example.com"] as const;

function rss(items: string, channelTitle = "Show Title"): string {
  return `<?xml version="1.0"?><rss><channel><title>${channelTitle}</title>${items}</channel></rss>`;
}

const WELL_FORMED_ITEM =
  "<item>" +
  "<guid>guid-abc123</guid>" +
  "<title>Episode One</title>" +
  "<pubDate>Fri, 01 Jul 2026 00:00:00 GMT</pubDate>" +
  '<enclosure url="https://cdn.example.com/ep/abc123.mp3" type="audio/mpeg"/>' +
  "</item>";

// ── parseRssFeed — pure, deterministic RSS-2.0 → PodcastEpisode ───────────────
describe("parseRssFeed — well-formed item ← guid match, never a fabricated transcript", () => {
  it("maps a well-formed RSS 2.0 item → PodcastEpisode (guid/title/showTitle/pubDate/enclosure); transcript NEVER fabricated", () => {
    const res = parseRssFeed(rss(WELL_FORMED_ITEM), "guid-abc123");
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.episodeId).toBe("guid-abc123");
    expect(res.value.title).toBe("Episode One");
    expect(res.value.showTitle).toBe("Show Title");
    expect(res.value.publishedAt).toBe("Fri, 01 Jul 2026 00:00:00 GMT");
    expect(res.value.audioUrl).toBe("https://cdn.example.com/ep/abc123.mp3");
    // RSS 2.0 / Podcasting-2.0 `<podcast:transcript>` is URL-only (Context7-verified) — the parse
    // NEVER invents/fetches transcript text; a real transcript is a downstream concern.
    expect(res.value.transcript).toBe("");
  });

  it("a CDATA-wrapped title decodes to plain text (no raw markup / CDATA markers leak)", () => {
    const item =
      "<item><guid>guid-cdata</guid><title><![CDATA[<b>Bold</b> Ep]]></title>" +
      '<enclosure url="https://cdn.example.com/e.mp3"/></item>';
    const res = parseRssFeed(rss(item), "guid-cdata");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.title).toContain("Bold Ep");
      expect(res.value.title).not.toContain("<");
      expect(res.value.title).not.toContain("CDATA");
    }
  });

  it("a non-string body ⇒ a typed fault, never a partial episode", () => {
    const res = parseRssFeed(123 as unknown as string, "guid-abc123");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("unknown");
  });

  it("a missing item (no <item> at all in the feed) ⇒ a typed fault, never a partial episode", () => {
    const res = parseRssFeed(rss(""), "guid-abc123");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("unknown");
  });

  it("a missing <guid> (item present but has NO guid — can never match) ⇒ a typed fault, never a partial episode", () => {
    const itemNoGuid =
      "<item><title>Untitled</title>" + '<enclosure url="https://cdn.example.com/e.mp3"/></item>';
    const res = parseRssFeed(rss(itemNoGuid), "guid-abc123");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("unknown");
  });

  it("items present but NONE match the requested episodeId ⇒ a typed fault (episode not found)", () => {
    const res = parseRssFeed(rss(WELL_FORMED_ITEM), "guid-DOES-NOT-EXIST");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("unknown");
  });

  it("is LINEAR (no O(n²)) on a pathological `<`-run item — completes fast, still finds a LATER matching item (L9)", () => {
    // A 2M-char run of `<` inside a NON-matching item's title — the O(n²) bait for a naive scan. A
    // linear item-block + tag scan finishes in ms; the default vitest timeout fails a hung regex.
    const bomb = "<".repeat(2_000_000);
    const bombItem = `<item><guid>other-episode</guid><title>${bomb}</title></item>`;
    const xml = rss(bombItem + WELL_FORMED_ITEM);
    const res = parseRssFeed(xml, "guid-abc123");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.episodeId).toBe("guid-abc123");
      expect(res.value.title).toBe("Episode One");
    }
  });
});

// ── createPodcastExtractTransport — SSRF-guard-before-fetch + fail-closed ─────
function spyGet(impl: PodcastHttpGet): { httpGet: PodcastHttpGet; calls: () => number } {
  const fn = vi.fn(impl);
  return { httpGet: fn, calls: () => fn.mock.calls.length };
}

describe("createPodcastExtractTransport — SSRF guard BEFORE fetch (rule 5 / L4)", () => {
  it.each([
    ["loopback", "https://127.0.0.1/feed.xml"],
    ["localhost", "https://localhost/feed.xml"],
    ["private RFC-1918", "https://192.168.1.10/feed.xml"],
    ["non-https", "http://example.com/feed.xml"],
    ["non-allowlisted host", "https://evil.com/feed.xml"],
  ])("a %s feed url ⇒ typed fault with ZERO bytes fetched (guard-before-fetch)", async (_label, feedUrl) => {
    const { httpGet, calls } = spyGet(async () => ({ status: 200, body: rss(WELL_FORMED_ITEM) }));
    const transport = createPodcastExtractTransport({ httpGet, allowedHosts: [...ALLOWED] });
    const res = await transport({ feedUrl, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
    expect(calls()).toBe(0); // NOTHING fetched — the SSRF guard ran first
  });

  it("an absent feedUrl ⇒ typed fault with ZERO bytes fetched (guard treats absence as inadmissible)", async () => {
    const { httpGet, calls } = spyGet(async () => ({ status: 200, body: rss(WELL_FORMED_ITEM) }));
    const transport = createPodcastExtractTransport({ httpGet, allowedHosts: [...ALLOWED] });
    const res = await transport({ episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    expect(calls()).toBe(0);
  });
});

// ── AUDIO-ONLY episode: the transport-level fail-closed (never reaches empty_content) ─────────────
describe("createPodcastExtractTransport — audio-only episode fails CLOSED before the adapter guard", () => {
  it("an item with an <enclosure> but no fetched transcript ⇒ ok:false code 'unknown', FIXED safe message", async () => {
    const { httpGet } = spyGet(async () => ({ status: 200, body: rss(WELL_FORMED_ITEM) }));
    const transport = createPodcastExtractTransport({ httpGet, allowedHosts: [...ALLOWED] });
    const res = await transport({ feedUrl: FEED_URL, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unknown");
      // FIXED safe literal — never the feed body / audioUrl echoed.
      expect(res.message.includes("cdn.example.com")).toBe(false);
      expect(res.message.length).toBeGreaterThan(0);
    }
  });
});

// ── TOTAL never-throws + rule-7 safe messages ──────────────────────────────────
describe("createPodcastExtractTransport — TOTAL never-throws + rule-7 safe messages", () => {
  it("a THROWING httpGet ⇒ redacted 'unknown' fault, never throws (raw cause discarded)", async () => {
    const transport = createPodcastExtractTransport({
      httpGet: async () => {
        throw new Error("SECRET-in-error boom https://internal/x");
      },
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ feedUrl: FEED_URL, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unknown");
      expect(res.message.includes("SECRET")).toBe(false); // raw cause NOT echoed (rule 7)
    }
  });

  it("a non-2xx status ⇒ 'unreachable' carrying ONLY the safe status (no body echo)", async () => {
    const transport = createPodcastExtractTransport({
      httpGet: async () => ({ status: 503, body: "<secret>internal error page</secret>" }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ feedUrl: FEED_URL, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unreachable");
      expect(res.message.includes("secret")).toBe(false);
      expect(res.message.includes("internal error page")).toBe(false);
    }
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["undefined", undefined as unknown as number],
  ])("a non-integer status (%s) fails CLOSED — the untrusted body is NOT parsed as 2xx success", async (_label, status) => {
    const transport = createPodcastExtractTransport({
      httpGet: async () => ({ status, body: rss(WELL_FORMED_ITEM) }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ feedUrl: FEED_URL, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
  });

  it("a pathological non-string body ⇒ typed fault, never throws", async () => {
    const transport = createPodcastExtractTransport({
      httpGet: async () => ({ status: 200, body: null as unknown as string }),
      allowedHosts: [...ALLOWED],
    });
    const res = await transport({ feedUrl: FEED_URL, episodeId: "guid-abc123" });
    expect(res.ok).toBe(false); // degrades (no throw)
    if (!res.ok) expect(res.code).toBe("unknown");
  });
});

// ── emit-only + dormant (source-scans) ────────────────────────────────────────
describe("podcast-extract-transport — emit-only (rule 1) + dormant (§ARM-23)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/adapters/podcast-extract-transport.ts", import.meta.url)),
    "utf8",
  );

  it("emit-only — no @sow/knowledge / fs-write import (L12 write-surface scan — import-anchored, not prose)", () => {
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
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("podcast-extract-transport.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createPodcastExtractTransport("));
    expect(callers).toEqual([]); // zero production callers
  });
});
