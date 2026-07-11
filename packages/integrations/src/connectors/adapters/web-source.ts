// @sow/integrations — web-article source-extraction adapter (Phase-13 §13.2).
//
// The governed-inheritance seam for an `obsidian-second-brain` web/readability
// extractor. A real WebFetch (a readability parse of the fetched page) runs behind
// an INJECTED `WebFetchTransport` — tests inject a fake, production wires the real
// fetch at the marked REAL-EXTRACTOR INJECTION POINT (out of scope here — no
// network/vendor I/O in this adapter or its tests). This adapter's ONLY job is to
// map that extract → a CANDIDATE `RegisterSourceInput`:
//
//   • EMIT-ONLY — it returns candidate data; it NEVER writes the vault. Every
//     durable effect is downstream of `registerSource()` (the candidate gate) and,
//     ultimately, `KnowledgeWriter` (the sole writer). (safety rule 1)
//   • NO INFERENCE — `workspaceId`/`sourceId`/`sensitivity` are passed through from
//     the caller's policy, never invented from content (REQ-F-017). The adapter
//     derives only the dedupe key + routing hints that ARE in the fetched content.
//   • ING-7 — the adapter consumes UNTRUSTED web content read-only/emit-only; it
//     has no mutating path (safety rule 6).
//   • PURE + TOTAL (§16) — no clock, no randomness, no I/O of its own; it NEVER
//     throws across the boundary — a transport fault (typed OR thrown) becomes a
//     typed `Result` err so the caller classifies deterministically.
//
// The summarize/enrichment cloud calls osb bakes in are NOT here: they belong to a
// downstream read-only extraction agent routed through `ModelProviderPort` under the
// egress veto. This adapter only carries the fetched content forward as a candidate.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/** The structured extract a readability WebFetch yields for one article. */
export interface WebPage {
  /** The canonical article URL — becomes the SourceEnvelope `origin` (locator). */
  readonly url: string;
  readonly title: string;
  readonly byline?: string;
  readonly publishedAt?: string;
  /** The extracted article body. The dedupe key is hashed over this (+ the url). */
  readonly text: string;
}

/**
 * The injected fetch transport (a real readability fetch in production, a fake in
 * tests). Closed result: a fetched page OR a typed failure — the caller never
 * re-throws. Emptiness is NOT signalled here (unlike youtube's `no_transcript`): the
 * transport returns the fetched `text`, so a contentless body is detected + rejected
 * at the adapter (a successful fetch of an empty article is still fail-closed).
 */
export type WebFetchResult =
  | { readonly ok: true; readonly page: WebPage }
  | { readonly ok: false; readonly code: "unreachable" | "unknown"; readonly message: string };

/** The transport an adapter hands the extractor: the article URL to fetch. */
export type WebFetchTransport = (req: { readonly url: string }) => Promise<WebFetchResult>;

/**
 * The caller-supplied policy fields. `workspaceId`/`sensitivity` come from the
 * ingestion policy (scoped-before-durable, REQ-F-002) — the adapter does NOT infer
 * them from the page (REQ-F-017). `url` is the source to extract.
 */
export interface ExtractWebInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly sensitivity: string;
}

/** The CLOSED extraction failure set (§16 — enumerable). */
export interface WebExtractError {
  readonly code: "unreachable" | "empty_content" | "unknown";
  readonly message: string;
}

/**
 * Extract a web article into a CANDIDATE `RegisterSourceInput` — emit-only, never
 * writes, never throws. On success the returned candidate is exactly the surface
 * `registerSource()` (the candidate gate) consumes; on any transport fault, or an
 * empty body, a typed `Result` err. The `contentHash` is a deterministic, replay-
 * stable digest over the article identity + body (Flow-4 dedupe key).
 */
export async function extractWebSource(
  input: ExtractWebInput,
  transport: WebFetchTransport,
): Promise<Result<RegisterSourceInput, WebExtractError>> {
  // Defend the boundary TOTALLY (§16 — nothing throws across this seam): the WHOLE
  // transport call + mapping runs under one try. The real (deferred) transport is
  // UNTRUSTED — it can throw OR resolve `ok` with a pathological shape (a null/
  // non-string body, a circular value) — and every such fault becomes a typed err,
  // never an uncaught throw.
  try {
    const result = await transport({ url: input.url });

    if (!result.ok) {
      return err({ code: result.code, message: result.message });
    }

    const { page } = result;

    // Fail-closed on an empty / whitespace-only / MALFORMED body — never emit a
    // contentless candidate (safety rules 2/6). A readability parse of a non-article
    // page commonly resolves `ok` with a null/absent `text`; that is a fault, not a
    // silent success, so the shape check lives alongside the emptiness check.
    if (typeof page?.text !== "string" || page.text.trim().length === 0) {
      return err({ code: "empty_content", message: "web extraction returned an empty or malformed body" });
    }

    // Dedupe key over the CONTENT (url + body) — deterministic + replay-stable
    // (payloadHash is key-sorted SHA-256). The same article re-extracted yields the
    // same key → a Flow-4 `dedupe_hit` at the gate, never a duplicate source.
    const contentHash = payloadHash({ url: page.url, text: page.text });

    // Routing hints carry ONLY what is IN the fetched content (metadata) — used by
    // the ingestion router for correlation. No invented workspace/owner/date; absent
    // optional metadata is OMITTED, never fabricated.
    const routingHints: Record<string, unknown> = {
      title: page.title,
      ...(page.byline !== undefined ? { byline: page.byline } : {}),
      ...(page.publishedAt !== undefined ? { publishedAt: page.publishedAt } : {}),
    };

    // The candidate — passed through the gate next. Scoped fields come from the
    // caller's policy verbatim (no inference); the type is the open source-taxonomy
    // value `web_article`.
    const candidate: RegisterSourceInput = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      origin: page.url,
      contentHash,
      type: "web_article",
      sensitivity: input.sensitivity,
      routingHints,
    };

    return ok(candidate);
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }
}
