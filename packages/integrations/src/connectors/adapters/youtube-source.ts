// @sow/integrations — YouTube source-extraction adapter (Phase-13 §13.2 PROTOTYPE).
//
// The governed-inheritance seam for the `obsidian-second-brain` YouTube extractor.
// The vendored, PINNED fetch lib (`youtube_extract.py --emit-json`: key-less
// transcript via youtube-transcript-api, metadata, comments) runs behind an
// INJECTED `YouTubeExtractTransport` — tests inject a fake, production wires the
// pinned subprocess at the marked REAL-EXTRACTOR INJECTION POINT. This adapter's
// ONLY job is to map that extract → a CANDIDATE `RegisterSourceInput`:
//
//   • EMIT-ONLY — it returns candidate data; it NEVER writes the vault. Every
//     durable effect is downstream of `registerSource()` (the candidate gate) and,
//     ultimately, `KnowledgeWriter` (the sole writer). (safety rule 1)
//   • NO INFERENCE — `workspaceId`/`sourceId`/`sensitivity` are passed through from
//     the caller's policy, never invented from content (REQ-F-017). The adapter
//     derives only the dedupe key + routing hints that ARE in the fetched content.
//   • ING-7 — the adapter consumes UNTRUSTED YouTube content read-only/emit-only; it
//     has no mutating path (safety rule 6).
//   • PURE + TOTAL (§16) — no clock, no randomness, no I/O of its own; it NEVER
//     throws across the boundary — a transport fault (typed OR thrown) becomes a
//     typed `Result` err so the caller classifies deterministically.
//
// The summarize/transcription cloud calls osb bakes in are NOT here: they belong to
// a downstream read-only extraction agent routed through `ModelProviderPort` under
// the egress veto. This adapter only carries the key-less fetched content forward.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/**
 * The structured extract the vendored `youtube_extract.py --emit-json` returns.
 *
 * CONTEXT7-GROUNDED (round-8 verify, `/jdepoix/youtube-transcript-api` for the transcript + the yt-metadata
 * wrapper for title/channel/publishDate): VERIFIED CONFORMANT (no behavior change). `videoId` (dedupe anchor) +
 * `watchUrl` (`origin`) present; `channel ← author`, `publishedAt ← publishDate` (hint-only). The upstream
 * per-segment transcript (`[{text, start, duration}]`) is flattened to one `transcript` string — cosmetic for
 * SoW (no timestamp-anchored retrieval) ⚠ PROVIDED the (deferred) real transport joins the segment `.text` in
 * DOCUMENT ORDER with a stable separator, else `payloadHash({videoId, transcript})` isn't replay-stable (the
 * load-bearing note carried to the SPINE/arming binding). arch_gap: a documented candidate.
 */
export interface YouTubeExtract {
  readonly videoId: string;
  /** The canonical watch URL — becomes the SourceEnvelope `origin` (locator). */
  readonly watchUrl: string;
  readonly title: string;
  readonly channel: string;
  /** Key-less transcript (youtube-transcript-api). The dedupe key is hashed over this. */
  readonly transcript: string;
  readonly publishedAt?: string;
}

/**
 * The injected extractor transport (the pinned Python subprocess in production, a
 * fake in tests). Closed result: a raw extract OR a typed failure — the caller
 * never re-throws. `no_transcript` = captions unavailable (a fetched-but-empty
 * source, fail-closed, NOT a silent success).
 */
export type YouTubeExtractResult =
  | { readonly ok: true; readonly video: YouTubeExtract }
  | { readonly ok: false; readonly code: "unreachable" | "no_transcript" | "unknown"; readonly message: string };

/** The transport an adapter hands the extractor: the watch URL to fetch. */
export type YouTubeExtractTransport = (req: { readonly watchUrl: string }) => Promise<YouTubeExtractResult>;

/**
 * The caller-supplied policy fields. `workspaceId`/`sensitivity` come from the
 * ingestion policy (scoped-before-durable, REQ-F-002) — the adapter does NOT infer
 * them from the video (REQ-F-017). `watchUrl` is the source to extract.
 */
export interface ExtractYouTubeInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly watchUrl: string;
  readonly sensitivity: string;
}

/**
 * The CLOSED extraction failure set (§16 — enumerable). `no_transcript` is the
 * TRANSPORT-signalled absence (captions unavailable, a `!ok` result); `empty_content`
 * is the ADAPTER-level guard (a transport resolved `ok` but the transcript is empty /
 * whitespace / non-string) — defense-in-depth on top of `no_transcript`, matching the
 * web/podcast siblings.
 */
export interface YouTubeExtractError {
  readonly code: "unreachable" | "no_transcript" | "empty_content" | "unknown";
  readonly message: string;
}

/**
 * Extract a YouTube source into a CANDIDATE `RegisterSourceInput` — emit-only, never
 * writes, never throws. On success the returned candidate is exactly the surface
 * `registerSource()` (the candidate gate) consumes; on any transport fault, or an
 * empty/malformed transcript, a typed `Result` err. The `contentHash` is a
 * deterministic, replay-stable digest over the video identity + transcript (Flow-4
 * dedupe key).
 */
export async function extractYouTubeSource(
  input: ExtractYouTubeInput,
  transport: YouTubeExtractTransport,
): Promise<Result<RegisterSourceInput, YouTubeExtractError>> {
  // Defend the boundary TOTALLY (§16 — nothing throws across this seam): the WHOLE
  // transport call + mapping runs under one try. The real (deferred) transport is
  // UNTRUSTED — it can throw OR resolve `ok` with a pathological shape (a null/
  // non-string transcript, a null video, a hostile getter) — and every such fault
  // becomes a typed err, never an uncaught throw (Lesson 11). A `!ok` result and the
  // empty guard `return` early; a `return` inside a `try` skips the `catch`, so the
  // typed transport-code errors pass through and the single catch only fires on a
  // genuine throw.
  try {
    const result = await transport({ watchUrl: input.watchUrl });

    if (!result.ok) {
      return err({ code: result.code, message: result.message });
    }

    const { video } = result;

    // Fail-closed on an empty / whitespace-only / MALFORMED transcript — never emit a
    // contentless candidate (safety rules 2/6). This is defense-in-depth ON TOP of the
    // transport's `no_transcript` signal: a transport that resolves `ok` with an empty /
    // non-string transcript (without signalling `no_transcript`) is still failed closed
    // here, exactly like web/podcast.
    if (typeof video?.transcript !== "string" || video.transcript.trim().length === 0) {
      return err({ code: "empty_content", message: "youtube extraction returned an empty or malformed transcript" });
    }

    // Dedupe key over the CONTENT (id + transcript) — deterministic + replay-stable
    // (payloadHash is key-sorted SHA-256). The same video re-extracted yields the
    // same key → a Flow-4 `dedupe_hit` at the gate, never a duplicate source.
    const contentHash = payloadHash({ videoId: video.videoId, transcript: video.transcript });

    // Routing hints carry ONLY what is IN the fetched content (metadata) — used by
    // the ingestion router for correlation. No invented workspace/owner/date.
    const routingHints: Record<string, unknown> = {
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      ...(video.publishedAt !== undefined ? { publishedAt: video.publishedAt } : {}),
    };

    // The candidate — passed through the gate next. Scoped fields come from the
    // caller's policy verbatim (no inference); the type is the frozen-open source
    // taxonomy value `youtube_video`.
    const candidate: RegisterSourceInput = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      origin: video.watchUrl,
      contentHash,
      type: "youtube_video",
      sensitivity: input.sensitivity,
      routingHints,
    };

    return ok(candidate);
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }
}
