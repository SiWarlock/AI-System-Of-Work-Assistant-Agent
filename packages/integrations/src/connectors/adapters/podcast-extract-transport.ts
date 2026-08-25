// @sow/integrations — task 13.2b: the DORMANT podcast real-extract transport (the second
// source-extractor real-parse leg; web is 13.2a, youtube is 13.2c, file is landed). Implements
// the `PodcastExtractTransport` seam already declared in `podcast-source.ts` (UNCHANGED) with:
//
//   • `parseRssFeed(xml, episodeId)` — a PURE, deterministic RSS-2.0 → `PodcastEpisode` mapper:
//     scans `<item>` blocks for the one whose `<guid>` matches `episodeId`, then reads `<title>`
//     (channel-level → `showTitle`, item-level → `title`), `<pubDate>` → `publishedAt`, and the
//     `<enclosure url="…">` attribute → `audioUrl`. A non-string body, no `<item>` at all, or no
//     item whose `<guid>` matches `episodeId` (which also covers an item with NO `<guid>` — it can
//     never match) all fold to a typed fault — NEVER a partial episode.
//     CONTEXT7-GROUNDED (`/podcastindex-org/podcast-namespace`, the `<podcast:transcript>` tag):
//     the tag is URL-ONLY (`url` + `type` attrs) — RSS 2.0 / Podcasting-2.0 NEVER carries inline
//     transcript text. So `parseRssFeed` correct-by-design never invents/fetches a transcript —
//     `transcript` is always `""` off this parse; a second fetch of the transcript file, and any
//     audio transcription, are downstream `ModelProviderPort` concerns (out of scope here, never
//     called). The regex scan is LINEAR / ReDoS-safe (input-capped, bounded attribute scans, large-
//     input pinned, L9) — no DOM/XML library is vendored (mirrors 13.2a's no-DOM-lib posture).
//   • `createPodcastExtractTransport({httpGet, allowedHosts})` — a thin transport over an INJECTED
//     `httpGet`. It SSRF-guards the FINAL feed url via the single vetted `isAllowedRemoteEndpoint`
//     (REUSED, never re-mirrored, L4) BEFORE any fetch. After a successful parse, an episode whose
//     transcript is empty (audio-only — every real RSS parse, since the feed never carries transcript
//     text) resolves `ok:false` with the CLOSED `"unknown"` code — so `extractPodcastSource`'s
//     `empty_content` guard (podcast-source.ts:126-128) is never reached with a transport-fabricated
//     transcript. TOTAL never-throws (the whole post-guard body under one try, L11) — a throwing /
//     non-2xx / NaN-status / pathological-body httpGet all fold to a typed fault whose `message` is a
//     FIXED SAFE LITERAL (never the feed body, never the raw cause, rule 7).
//
// EMIT-ONLY (rule 1): the transport feeds `podcast-source.ts`'s UNCHANGED `extractPodcastSource` →
// `registerSource()` candidate path; it NEVER writes Markdown and imports no `@sow/knowledge`/fs-write.
// DORMANT: the real network `httpGet` is UNBOUND at boot (no production caller binds a real fetch) —
// the real bind is the owner's §ARM-23 HARD LINE. Tests inject a fake.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isAllowedRemoteEndpoint } from "@sow/policy";
import type { PodcastEpisode, PodcastExtractResult, PodcastExtractTransport } from "./podcast-source";

/** The transport's raw HTTP response (a status + a raw body string; no interpretation). */
export interface PodcastHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The DEPENDENCY-INJECTED read-only GET (a real Node client at §ARM-23; a fake in tests).
 *  MAY reject (network fault) — the transport classifies a throw into a redacted fault. */
export type PodcastHttpGet = (url: string) => Promise<PodcastHttpResponse>;

/** Deps for the podcast-extract transport: the injected fetch + the governed host allowlist
 *  (bound at construction, like the web-fetch transport's `allowedHosts`; the ingestion policy
 *  supplies it at §ARM-23 — the fetch is allowlist-GOVERNED, never arbitrary-URL). */
export interface PodcastExtractTransportDeps {
  readonly httpGet: PodcastHttpGet;
  readonly allowedHosts: readonly string[];
}

/** A `parseRssFeed` parse fault. `code` is always `"unknown"` (a malformed/absent feed — never a
 *  network condition, which belongs to the transport's own `"unreachable"` branch). */
export interface PodcastRssParseError {
  readonly code: "unknown";
  readonly message: string;
}

/** Input length cap (UTF-16 code units) — a DoS guard on the untrusted feed body before any scan. */
const MAX_XML_LENGTH = 5_000_000;

// Strip ALL tags. The `(?:>|$)` alternation makes this LINEAR: an unterminated `<` run (or one the
// length cap sliced mid-tag) is consumed to end-of-string in ONE match — no per-start rescan, no raw
// markup leaks. `[^>]*` has no adjacent nullable quantifier ⇒ no catastrophic backtracking (L9).
function stripTags(s: string): string {
  return s.replace(/<[^>]*(?:>|$)/g, " ");
}

// Collapse whitespace runs to a single space + trim. Linear.
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Unwrap a `<![CDATA[ … ]]>` payload (RSS text fields are commonly CDATA-wrapped); an unterminated
// CDATA (no `]]>`) is left AS-IS (falls through to stripTags, never hangs — bounded `[\s\S]*?` with a
// fixed literal terminator, same linear shape as the item-block scan below).
function unwrapCdata(s: string): string {
  const m = /^<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/.exec(s.trim());
  return m ? (m[1] ?? "") : s;
}

// Minimal, safe entity decode (mirrors 13.2a's web-fetch-transport decodeEntities — `&amp;` LAST so
// a decode can never re-introduce another entity).
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Extract one tag's text content (bounded attribute scan `{0,256}`, same linear shape as 13.2a's
// `extractTitle`). `tag` is always one of this module's OWN fixed literals (never caller/untrusted
// input) — the dynamic RegExp construction carries no injection surface.
function extractTagText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]{0,256}>([\\s\\S]*?)(?:<\\/${tag}>|$)`, "i");
  const m = re.exec(xml);
  if (!m) return undefined;
  const text = collapseWs(decodeEntities(stripTags(unwrapCdata(m[1] ?? ""))));
  return text.length > 0 ? text : undefined;
}

// Extract the `<enclosure url="…">` attribute (bounded attribute scan, same linear shape).
function extractEnclosureUrl(itemXml: string): string | undefined {
  const m = /<enclosure\b[^>]{0,1024}\burl="([^"]{0,2048})"/i.exec(itemXml);
  return m ? m[1] : undefined;
}

// Scan `<item>` blocks. LINEAR: the lazy `[\s\S]*?` terminates at the FIRST `</item>` (or
// end-of-string via the `$` alternation) — same bounded/lazy shape 13.2a's `stripBlocks` uses for
// `<script>`/`<style>`, already reviewed ReDoS-safe (L9): a single forward scan per item, no nested
// nullable quantifier.
const ITEM_RE = /<item\b[\s\S]*?(?:<\/item>|$)/gi;

/**
 * Pure deterministic RSS-2.0 parse: `xml` + the target `episodeId` → the matching `PodcastEpisode`,
 * or a typed `"unknown"` fault. Zero network, never throws. `transcript` is ALWAYS `""` off this
 * parse (see the module header — RSS never carries inline transcript text); the transport layer
 * decides whether an empty transcript is an "audio-only" fault. See the module header for the
 * candidate/arch_gap posture.
 */
export function parseRssFeed(xml: string, episodeId: string): Result<PodcastEpisode, PodcastRssParseError> {
  const fault = (message: string): Result<PodcastEpisode, PodcastRssParseError> =>
    err({ code: "unknown", message });
  // Defensive runtime check (mirrors 13.2a's `parseReadabilityHtml`) even though the declared
  // signature is `string` — a caller / transport can still hand a non-string at the JS boundary.
  if (typeof xml !== "string") return fault("podcast rss: malformed feed body");
  const capped = xml.length > MAX_XML_LENGTH ? xml.slice(0, MAX_XML_LENGTH) : xml;

  const itemStart = capped.search(/<item\b/i);
  if (itemStart === -1) return fault("podcast rss: no items in feed");

  const channelTitle = extractTagText(capped.slice(0, itemStart), "title");
  const itemBlocks = capped.slice(itemStart).match(ITEM_RE) ?? [];

  for (const block of itemBlocks) {
    const guid = extractTagText(block, "guid");
    if (guid === undefined || guid !== episodeId) continue; // no match ⇒ try the next item
    const title = extractTagText(block, "title");
    if (title === undefined) return fault("podcast rss: episode missing required title");
    const publishedAt = extractTagText(block, "pubDate");
    const audioUrl = extractEnclosureUrl(block);
    const episode: PodcastEpisode = {
      episodeId: guid,
      title,
      ...(channelTitle !== undefined ? { showTitle: channelTitle } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(audioUrl !== undefined ? { audioUrl } : {}),
      // RSS 2.0 / Podcasting-2.0 `<podcast:transcript>` is URL-only (Context7-verified) — never
      // inline text. Never fabricated, never fetched here (rules 2/6); the transport layer folds
      // this into an "audio-only" fault rather than pass an empty transcript downstream.
      transcript: "",
    };
    return ok(episode);
  }
  return fault("podcast rss: episode not found in feed"); // covers "no item" AND "no matching guid"
}

/**
 * Build the podcast-extract transport over the injected `httpGet` + governed host allowlist.
 * SSRF-guards the FINAL feed url BEFORE any fetch; TOTAL never-throws; every fault message is a
 * fixed safe literal (or a bare status number) — never the untrusted feed body/cause (rule 7).
 */
export function createPodcastExtractTransport(deps: PodcastExtractTransportDeps): PodcastExtractTransport {
  return async (req: { readonly feedUrl?: string; readonly episodeId: string }): Promise<PodcastExtractResult> => {
    const feedUrl = req.feedUrl ?? "";
    // SSRF guard FIRST — before ANY fetch (L4 vetted predicate, reused verbatim). A rejected /
    // loopback / private / non-allowlisted / non-https / absent url ⇒ ZERO bytes fetched.
    if (!isAllowedRemoteEndpoint(feedUrl, deps.allowedHosts)) {
      return { ok: false, code: "unreachable", message: "endpoint not allowed (SSRF/allowlist)" };
    }
    // TOTAL never-throws (L11): the WHOLE fetch + parse runs under one try. A throwing httpGet (raw
    // cause DISCARDED), a non-2xx status, or a pathological body all fold to a typed
    // PodcastExtractResult fault with a FIXED SAFE LITERAL message (rule 7).
    try {
      const resp = await deps.httpGet(feedUrl);
      const status = typeof resp?.status === "number" ? resp.status : -1;
      // A non-integer status (NaN/Infinity, or undefined coerced to -1) fails CLOSED — mirrors the
      // vetted http-transport.ts 2xx gate.
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        return { ok: false, code: "unreachable", message: `non-2xx status ${Number.isInteger(status) ? status : -1}` };
      }
      const body = typeof resp?.body === "string" ? resp.body : "";
      const parsed = parseRssFeed(body, req.episodeId);
      if (!parsed.ok) {
        return { ok: false, code: "unknown", message: "podcast feed parse failed" };
      }
      // Audio-only episode (every real RSS parse — the feed never carries transcript text, see the
      // module header): fail CLOSED here so `extractPodcastSource`'s `empty_content` guard is never
      // reached with a fabricated/empty transcript (rules 2/6) — never invent one, never call a model.
      if (parsed.value.transcript.trim().length === 0) {
        return { ok: false, code: "unknown", message: "podcast extract: no transcript available (audio-only)" };
      }
      return { ok: true, episode: parsed.value };
    } catch {
      return { ok: false, code: "unknown", message: "podcast extract faulted" };
    }
  };
}
