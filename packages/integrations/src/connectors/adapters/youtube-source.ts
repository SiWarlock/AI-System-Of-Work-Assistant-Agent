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

/** The structured extract the vendored `youtube_extract.py --emit-json` returns. */
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

/** The CLOSED extraction failure set (§16 — enumerable). */
export interface YouTubeExtractError {
  readonly code: "unreachable" | "no_transcript" | "unknown";
  readonly message: string;
}

/**
 * Extract a YouTube source into a CANDIDATE `RegisterSourceInput` — emit-only,
 * never writes, never throws. On success the returned candidate is exactly the
 * surface `registerSource()` (the candidate gate) consumes; on any transport fault
 * a typed `Result` err. The `contentHash` is a deterministic, replay-stable digest
 * over the video identity + transcript (Flow-4 dedupe key).
 */
export async function extractYouTubeSource(
  input: ExtractYouTubeInput,
  transport: YouTubeExtractTransport,
): Promise<Result<RegisterSourceInput, YouTubeExtractError>> {
  // Defend the boundary: a transport that THROWS is mapped to a typed err, never
  // propagated (§16 — nothing throws across this seam).
  let result: YouTubeExtractResult;
  try {
    result = await transport({ watchUrl: input.watchUrl });
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }

  if (!result.ok) {
    return err({ code: result.code, message: result.message });
  }

  const { video } = result;

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
}
