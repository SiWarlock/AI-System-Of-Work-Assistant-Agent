// @sow/integrations — task 13.2a: the DORMANT web source real-parse transport (the
// first source-extractor real-parse leg; podcast/youtube/file are sibling sub-rounds
// 13.2b/c/d). Implements the `WebFetchTransport` seam already declared in
// `web-source.ts` (UNCHANGED) with:
//
//   • `parseReadabilityHtml(html, url)` — a PURE, deterministic HTML → `WebPage`
//     parser: strip <script>/<style> blocks + comments + ALL tags → tag-free plain
//     `text` (mapped as readability's `textContent`, NEVER the raw HTML `content` —
//     hashing HTML would drift the dedupe key); `<title>` → title; empty ⇒ a typed
//     `empty_content` fault, never a contentless WebPage. NO DOM library is vendored
//     (Q3): the regexes are LINEAR / ReDoS-safe (input-capped, large-input pinned,
//     L9). `byline`/`publishedAt` are HONESTLY OMITTED (a deterministic parse can't
//     reliably extract them — never fabricated, REQ-F-017). The real
//     `@mozilla/readability` (boilerplate-aware extraction + byline/date) is a
//     documented-candidate parse-quality SWAP bound at §ARM-23 (arch_gap).
//   • `createWebFetchTransport({httpGet, allowedHosts})` — a thin transport over an
//     INJECTED `httpGet`. It SSRF-guards the FINAL url via the single vetted
//     `isAllowedRemoteEndpoint` (https + reject-loopback/private + exact-host allowlist —
//     REUSED, never re-mirrored, L4) BEFORE any fetch; a rejected endpoint ⇒ a typed
//     fault with ZERO bytes fetched. TOTAL never-throws (the whole post-guard body under
//     one try, L11) — a throwing / non-2xx / pathological-body httpGet ⇒ a redacted typed
//     `WebFetchResult` fault whose `message` is a FIXED SAFE LITERAL (never echoes the
//     untrusted body or the raw cause, rule 7).
//
// EMIT-ONLY (rule 1): the transport feeds `web-source.ts`'s UNCHANGED
// `extractWebSource` → `registerSource()` candidate path; it NEVER writes Markdown and
// imports no `@sow/knowledge`/fs-write (the L12 write-surface scan stays green).
// DORMANT: the real network `httpGet` is UNBOUND at boot (no production caller binds a
// real fetch) — the real bind is the owner's §ARM-23 HARD LINE. Tests inject a fake.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isAllowedRemoteEndpoint } from "@sow/policy";
import type { WebPage, WebFetchResult, WebFetchTransport, WebExtractError } from "./web-source";

/** The transport's raw HTTP response (a status + a raw body string; no interpretation). */
export interface WebHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The DEPENDENCY-INJECTED read-only GET (a real Node client at §ARM-23; a fake in tests).
 *  MAY reject (network fault) — the transport classifies a throw into a redacted fault. */
export type WebHttpGet = (url: string) => Promise<WebHttpResponse>;

/** Deps for the web-fetch transport: the injected fetch + the governed host allowlist
 *  (bound at construction, like a connector `spec.allowedHosts`; the ingestion policy
 *  supplies it at §ARM-23 — the fetch is allowlist-GOVERNED, never arbitrary-URL). */
export interface WebFetchTransportDeps {
  readonly httpGet: WebHttpGet;
  readonly allowedHosts: readonly string[];
}

/** Input length cap (UTF-16 code units) — a DoS guard on the untrusted body before any scan. */
const MAX_HTML_LENGTH = 5_000_000;

// Strip <script>/<style> BLOCKS (their content is not article text) + HTML comments.
// LINEAR: a lazy `[\s\S]*?` scans to the FIRST terminator (or end-of-string via the
// `$` alternation — so an UNTERMINATED block is removed to the end, no leaked script
// text), no adjacent nullable quantifiers ⇒ no catastrophic backtracking (L9).
function stripBlocks(html: string): string {
  return html
    .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, " ")
    .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
}

// Strip ALL remaining tags. The `(?:>|$)` alternation makes this LINEAR *and* leak-safe:
// a `<` with no following `>` (an unterminated trailing tag, incl. one the length cap sliced
// mid-tag) is consumed to end-of-string in ONE match — so no per-start rescan (no O(n²) on a
// `<`-run) and no raw markup/attribute text leaks into `text`. `[^>]*` has no adjacent nullable
// quantifier ⇒ no catastrophic backtracking (L9).
function stripTags(s: string): string {
  return s.replace(/<[^>]*(?:>|$)/g, " ");
}

// Collapse runs of whitespace to a single space + trim. Linear.
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Decode a MINIMAL, safe entity set. `&amp;` is decoded LAST so a decode can never
// re-introduce another entity (`&amp;lt;` → `&lt;`, NOT `<`). `&lt;`/`&gt;` are left
// ESCAPED on purpose — decoding them could re-introduce a raw `<`/`>` into the plain
// text; the real readability at §ARM-23 handles full entity decoding.
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Extract the <title> text (tag-free). The attribute scan is BOUNDED (`{0,512}`) so a
// `<title`-repeated-with-no-`>` body can't force a per-start O(n) rescan (linear). Decode
// BEFORE collapse/trim so a whitespace entity in the title trims away.
function extractTitle(html: string): string {
  const m = /<title[^>]{0,512}>([\s\S]*?)(?:<\/title>|$)/i.exec(html);
  return m ? collapseWs(decodeEntities(stripTags(m[1] ?? ""))) : "";
}

/**
 * Pure deterministic readability parse: HTML → a `WebPage` candidate (text ←
 * tag-free plain text; NEVER the raw HTML), or a typed `empty_content` fault. Zero
 * network, never throws. See the module header for the candidate/arch_gap posture.
 */
export function parseReadabilityHtml(html: string, url: string): Result<WebPage, WebExtractError> {
  const emptyFault: WebExtractError = { code: "empty_content", message: "empty_content: no extractable text" };
  if (typeof html !== "string") return err(emptyFault);
  const capped = html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
  const title = extractTitle(capped);
  // Decode BEFORE collapse/trim so a whitespace-only ENTITY body (e.g. `&nbsp;`) trims to
  // empty and faults `empty_content` — never a contentless ` ` WebPage.
  const text = collapseWs(decodeEntities(stripTags(stripBlocks(capped))));
  if (text.length === 0) return err(emptyFault);
  // byline/publishedAt honestly OMITTED (never fabricated, REQ-F-017).
  return ok({ url, title, text });
}

/**
 * Build the web-fetch transport over the injected `httpGet` + governed host allowlist.
 * SSRF-guards the FINAL url BEFORE any fetch; TOTAL never-throws; every fault message is
 * a fixed safe literal (or a bare status number) — never the untrusted body/cause (rule 7).
 */
export function createWebFetchTransport(deps: WebFetchTransportDeps): WebFetchTransport {
  return async (req: { readonly url: string }): Promise<WebFetchResult> => {
    // SSRF guard FIRST — before ANY fetch (L4 vetted predicate, reused verbatim). A
    // rejected / loopback / private / non-allowlisted / non-https url ⇒ ZERO bytes fetched.
    if (!isAllowedRemoteEndpoint(req.url, deps.allowedHosts)) {
      return { ok: false, code: "unreachable", message: "endpoint not allowed (SSRF/allowlist)" };
    }
    // TOTAL never-throws (L11): the WHOLE fetch + parse runs under one try. A throwing
    // httpGet (raw cause DISCARDED), a non-2xx status, or a pathological body all fold to
    // a typed WebFetchResult fault with a FIXED SAFE LITERAL message (rule 7).
    try {
      const resp = await deps.httpGet(req.url);
      const status = typeof resp?.status === "number" ? resp.status : -1;
      // A non-integer status (NaN/Infinity, or undefined coerced to -1) fails CLOSED — NEVER
      // treated as 2xx success (`typeof NaN === "number"`, so the coercion alone isn't enough;
      // mirrors the vetted http-transport.ts 2xx gate).
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        return { ok: false, code: "unreachable", message: `non-2xx status ${Number.isInteger(status) ? status : -1}` };
      }
      const body = typeof resp?.body === "string" ? resp.body : "";
      const parsed = parseReadabilityHtml(body, req.url);
      if (parsed.ok) return { ok: true, page: parsed.value };
      // The fixed WebFetchResult union can't carry `empty_content` (web-source.ts is
      // UNCHANGED) — degrade to `unknown` with a distinct fixed literal (no code/message
      // mismatch); the adapter's own empty-body check is the defense-in-depth (arch_gap, §ARM-23).
      return { ok: false, code: "unknown", message: "no extractable content" };
    } catch {
      return { ok: false, code: "unknown", message: "web fetch faulted" };
    }
  };
}
