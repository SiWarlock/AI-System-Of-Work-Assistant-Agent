// @sow/integrations — podcast source-extraction adapter (Phase-13 §13.2).
//
// The governed-inheritance seam for an `obsidian-second-brain` podcast extractor.
// A real RSS-feed fetch + audio transcription runs behind an INJECTED
// `PodcastExtractTransport` — tests inject a fake, production wires the real feed
// fetch + transcription at the marked REAL-EXTRACTOR INJECTION POINT (out of scope
// here — no network/vendor I/O in this adapter or its tests). This adapter's ONLY
// job is to map that extract → a CANDIDATE `RegisterSourceInput`:
//
//   • EMIT-ONLY — it returns candidate data; it NEVER writes the vault. Every
//     durable effect is downstream of `registerSource()` (the candidate gate) and,
//     ultimately, `KnowledgeWriter` (the sole writer). (safety rule 1)
//   • NO INFERENCE — `workspaceId`/`sourceId`/`sensitivity` are passed through from
//     the caller's policy, never invented from content (REQ-F-017). The adapter
//     derives only the dedupe key + routing hints that ARE in the fetched content.
//   • ING-7 — the adapter consumes UNTRUSTED podcast content read-only/emit-only; it
//     has no mutating path (safety rule 6).
//   • PURE + TOTAL (§16) — no clock, no randomness, no I/O of its own; it NEVER
//     throws across the boundary — a transport fault (typed OR thrown) becomes a
//     typed `Result` err so the caller classifies deterministically.
//
// The summarize/transcription cloud calls osb bakes in are NOT here: they belong to
// a downstream read-only extraction agent routed through `ModelProviderPort` under
// the egress veto. This adapter only carries the fetched transcript forward as a
// candidate; an audio-only episode not yet transcribed fails closed (`empty_content`),
// it is not silently registered.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/**
 * The structured extract a real RSS fetch + transcription yields for one episode.
 *
 * CONTEXT7-GROUNDED (round-8 verify — no clean Context7 lib; authoritative = the RSS 2.0 spec, rssboard.org):
 * VERIFIED CONFORMANT (no behavior change). RSS `<item>` → candidate: `episodeId ← <guid>` (the stable item id
 * — the `payloadHash({episodeId, transcript})` dedupe anchor + `origin`), `title` verbatim, `showTitle ← channel
 * <title>`, `audioUrl ← <enclosure @url>`, `publishedAt ← <pubDate>` (hint-only). The `transcript` is a downstream
 * transcription concern (NOT an RSS field) — correct-by-design. arch_gap: a documented candidate; the real RSS
 * parse binds at the SPINE/arming.
 */
export interface PodcastEpisode {
  /**
   * The stable episode GUID (RSS `<guid>`) — always present, and the canonical
   * locator, so it becomes the SourceEnvelope `origin`. The dedupe key is hashed
   * over this (+ the transcript). `audioUrl` is optional metadata, so it can NOT be
   * the guaranteed locator.
   */
  readonly episodeId: string;
  readonly title: string;
  readonly showTitle?: string;
  readonly publishedAt?: string;
  /** The audio enclosure URL — optional metadata (a routing hint), NOT fetched here. */
  readonly audioUrl?: string;
  /** The transcript. The required content; the dedupe key is hashed over it (+ the id). */
  readonly transcript: string;
}

/**
 * The injected extractor transport (a real RSS fetch + transcription in production,
 * a fake in tests). Closed result: a fetched episode OR a typed failure — the caller
 * never re-throws. Emptiness is NOT signalled here (unlike youtube's `no_transcript`):
 * the transport returns the fetched `transcript`, so a contentless / audio-only
 * episode is detected + rejected at the adapter (`empty_content`).
 */
export type PodcastExtractResult =
  | { readonly ok: true; readonly episode: PodcastEpisode }
  | { readonly ok: false; readonly code: "unreachable" | "unknown"; readonly message: string };

/** The transport an adapter hands the extractor: the feed + episode to fetch. */
export type PodcastExtractTransport = (req: {
  readonly feedUrl?: string;
  readonly episodeId: string;
}) => Promise<PodcastExtractResult>;

/**
 * The caller-supplied policy fields. `workspaceId`/`sensitivity` come from the
 * ingestion policy (scoped-before-durable, REQ-F-002) — the adapter does NOT infer
 * them from the episode (REQ-F-017). `feedUrl`/`episodeId` locate the source to fetch.
 */
export interface ExtractPodcastInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly feedUrl?: string;
  readonly episodeId: string;
  readonly sensitivity: string;
}

/** The CLOSED extraction failure set (§16 — enumerable). */
export interface PodcastExtractError {
  readonly code: "unreachable" | "empty_content" | "unknown";
  readonly message: string;
}

/**
 * Extract a podcast episode into a CANDIDATE `RegisterSourceInput` — emit-only, never
 * writes, never throws. On success the returned candidate is exactly the surface
 * `registerSource()` (the candidate gate) consumes; on any transport fault, or an
 * empty/malformed transcript, a typed `Result` err. The `contentHash` is a
 * deterministic, replay-stable digest over the episode identity + transcript (Flow-4
 * dedupe key).
 */
export async function extractPodcastSource(
  input: ExtractPodcastInput,
  transport: PodcastExtractTransport,
): Promise<Result<RegisterSourceInput, PodcastExtractError>> {
  // Defend the boundary TOTALLY (§16 — nothing throws across this seam): the WHOLE
  // transport call + mapping runs under one try. The real (deferred) transport is
  // UNTRUSTED — it can throw OR resolve `ok` with a pathological shape (a null/
  // non-string transcript, a null episode, a circular value) — and every such fault
  // becomes a typed err, never an uncaught throw (Lesson 11).
  try {
    const result = await transport({ feedUrl: input.feedUrl, episodeId: input.episodeId });

    if (!result.ok) {
      return err({ code: result.code, message: result.message });
    }

    const { episode } = result;

    // Fail-closed on an empty / whitespace-only / MALFORMED transcript — never emit a
    // contentless candidate (safety rules 2/6). An audio-only episode not yet
    // transcribed resolves `ok` with a null/absent transcript; that is a fault, not a
    // silent success (transcription is the downstream ModelProviderPort concern), so
    // the shape check lives alongside the emptiness check.
    if (typeof episode?.transcript !== "string" || episode.transcript.trim().length === 0) {
      return err({ code: "empty_content", message: "podcast extraction returned an empty or malformed transcript" });
    }

    // Dedupe key over the CONTENT (episode identity + transcript) — deterministic +
    // replay-stable (payloadHash is key-sorted SHA-256). The same episode re-extracted
    // yields the same key → a Flow-4 `dedupe_hit` at the gate, never a duplicate
    // source; a DIFFERENT episode with an identical transcript keys differently.
    const contentHash = payloadHash({ episodeId: episode.episodeId, transcript: episode.transcript });

    // Routing hints carry ONLY what is IN the fetched content (metadata) — used by the
    // ingestion router for correlation. No invented workspace/owner/date; absent
    // optional metadata is OMITTED, never fabricated. `episodeId` is the `origin`, not
    // duplicated here; the transcript is the dedupe content, never a hint.
    const routingHints: Record<string, unknown> = {
      title: episode.title,
      ...(episode.showTitle !== undefined ? { showTitle: episode.showTitle } : {}),
      ...(episode.publishedAt !== undefined ? { publishedAt: episode.publishedAt } : {}),
      ...(episode.audioUrl !== undefined ? { audioUrl: episode.audioUrl } : {}),
    };

    // The candidate — passed through the gate next. Scoped fields come from the
    // caller's policy verbatim (no inference); the type is the open source-taxonomy
    // value `podcast`; the origin is the guaranteed episode locator (the guid).
    const candidate: RegisterSourceInput = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      origin: episode.episodeId,
      contentHash,
      type: "podcast",
      sensitivity: input.sensitivity,
      routingHints,
    };

    return ok(candidate);
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }
}
