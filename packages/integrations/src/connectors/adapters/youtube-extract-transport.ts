// @sow/integrations — task 13.2c: the DORMANT YouTube real-extract transport (the third
// source-extractor real-parse leg; web is 13.2a, podcast is 13.2b, file is landed). Implements the
// `YouTubeExtractTransport` seam already declared in `youtube-source.ts` (UNCHANGED) with:
//
//   • `createYouTubeExtractTransport({run, allowedHosts})` — a thin transport over an INJECTED
//     `run` (an `argv → {code, stdout, stderr}` runner; a real subprocess spawn in production, a
//     fake in tests — NEVER a real spawn in the shipped default). It SSRF-guards the watch url via
//     the single vetted `isAllowedRemoteEndpoint` (REUSED, never re-mirrored, L4) BEFORE invoking
//     `run` at all. `run` is called with a PINNED, fixed argv vector
//     (`YOUTUBE_EXTRACT_ARGV_PREFIX` + the watch url as its OWN trailing element) — the watch url is
//     NEVER string-concatenated into a shell command (no injection surface: the injected `run`
//     receives an argv ARRAY, exactly like `child_process.execFile`, never a shell string).
//   • The pinned `youtube_extract.py --emit-json` candidate stdout is `{videoId, watchUrl, title,
//     channel, publishedAt?, segments:[{text,…}]}` (mirrors the youtube-source.ts docstring's
//     `[{text,start,duration}]` per-segment shape). The transcript is the segments' `.text` joined
//     in DOCUMENT ORDER (never sorted, never deduped — `payloadHash` replay-stability depends on
//     this, per the youtube-source.ts docstring's load-bearing note).
//   • TOTAL never-throws (the whole post-guard body under one try, L11): a throwing runner, a
//     non-zero exit code, or unparseable/malformed stdout all fold to a typed fault whose `message`
//     is a FIXED SAFE LITERAL — `stderr` is NEVER echoed into any message (rule 7). An empty /
//     whitespace-only / absent transcript resolves the CLOSED `"no_transcript"` code (captions
//     unavailable — fetched-but-empty, fail-closed, never a silent success).
//
// EMIT-ONLY (rule 1): the transport feeds `youtube-source.ts`'s UNCHANGED `extractYouTubeSource` →
// `registerSource()` candidate path; it NEVER writes Markdown and imports no `@sow/knowledge`/fs-write.
// DORMANT: the real subprocess `run` is UNBOUND at boot (no production caller binds a real spawn) —
// the real bind is the owner's §ARM-23 HARD LINE. Tests inject a fake.
import { isAllowedRemoteEndpoint } from "@sow/policy";
import type { YouTubeExtract, YouTubeExtractResult, YouTubeExtractTransport } from "./youtube-source";

/** The injected runner's raw result — an exit code + raw stdout/stderr strings (no interpretation). */
export interface YouTubeRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The DEPENDENCY-INJECTED subprocess runner (a real `execFile`-style spawn at §ARM-23; a fake in
 *  tests). Takes an argv ARRAY (never a shell string — no injection surface). MAY reject (spawn
 *  fault) — the transport classifies a throw into a redacted fault. */
export type YouTubeRunner = (argv: readonly string[]) => Promise<YouTubeRunResult>;

/** Deps for the youtube-extract transport: the injected runner + the governed host allowlist
 *  (bound at construction, mirroring the web/podcast transports' `allowedHosts`; the ingestion
 *  policy supplies it at §ARM-23 — the watch url is allowlist-GOVERNED, never arbitrary). */
export interface YouTubeExtractTransportDeps {
  readonly run: YouTubeRunner;
  readonly allowedHosts: readonly string[];
}

/** The PINNED, fixed argv prefix (candidate — the exact interpreter/path binds at §ARM-23; the watch
 *  url is ALWAYS appended as its own trailing element, never concatenated into any of these). */
const YOUTUBE_EXTRACT_ARGV_PREFIX: readonly string[] = ["youtube_extract.py", "--emit-json"];

/** The candidate `--emit-json` stdout envelope (untrusted — every field is validated, arch_gap). */
interface YouTubeExtractStdout {
  readonly videoId?: unknown;
  readonly watchUrl?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly publishedAt?: unknown;
  readonly segments?: unknown;
}

/**
 * Flatten `segments[].text` in ARRAY (document) order — NEVER sorted by `start`, never deduped. A
 * non-array `segments`, or any segment whose `text` is not a string, is malformed ⇒ `undefined`
 * (fail-closed, never a partial join). An empty array joins to `""` (the caller's empty-transcript
 * gate handles that as `no_transcript`).
 */
function flattenSegmentsInOrder(segments: unknown): string | undefined {
  if (!Array.isArray(segments)) return undefined;
  const texts: string[] = [];
  for (const seg of segments) {
    if (typeof seg !== "object" || seg === null) return undefined;
    const text = (seg as { text?: unknown }).text;
    if (typeof text !== "string") return undefined;
    texts.push(text);
  }
  return texts.join(" ");
}

/**
 * Build the youtube-extract transport over the injected `run` + governed host allowlist.
 * SSRF-guards the watch url BEFORE invoking `run`; TOTAL never-throws; every fault message is a
 * fixed safe literal — `stderr` is NEVER echoed (rule 7).
 */
export function createYouTubeExtractTransport(deps: YouTubeExtractTransportDeps): YouTubeExtractTransport {
  return async (req: { readonly watchUrl: string }): Promise<YouTubeExtractResult> => {
    // SSRF guard FIRST — before ANY subprocess invocation (L4 vetted predicate, reused verbatim). A
    // rejected / loopback / private / non-allowlisted / non-https url ⇒ ZERO `run` calls.
    if (!isAllowedRemoteEndpoint(req.watchUrl, deps.allowedHosts)) {
      return { ok: false, code: "unreachable", message: "endpoint not allowed (SSRF/allowlist)" };
    }
    // TOTAL never-throws (L11): the WHOLE spawn + parse runs under one try. A throwing runner (raw
    // cause DISCARDED), a non-zero exit, or unparseable/malformed stdout all fold to a typed
    // YouTubeExtractResult fault with a FIXED SAFE LITERAL message; `stderr` NEVER appears (rule 7).
    try {
      // PINNED argv — the watch url is its OWN trailing element, never string-concatenated (no
      // shell-injection surface; `run` receives an array, exactly like `execFile`).
      const result = await deps.run([...YOUTUBE_EXTRACT_ARGV_PREFIX, req.watchUrl]);
      const code = typeof result?.code === "number" ? result.code : -1;
      if (!Number.isInteger(code) || code !== 0) {
        return { ok: false, code: "unreachable", message: "youtube extract process exited non-zero" };
      }
      const stdout = typeof result?.stdout === "string" ? result.stdout : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout) as unknown;
      } catch {
        return { ok: false, code: "unreachable", message: "youtube extract: unparseable output" };
      }
      if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, code: "unreachable", message: "youtube extract: unparseable output" };
      }
      const p = parsed as YouTubeExtractStdout;
      const videoId = typeof p.videoId === "string" ? p.videoId : undefined;
      const watchUrl = typeof p.watchUrl === "string" ? p.watchUrl : undefined;
      const title = typeof p.title === "string" ? p.title : undefined;
      const channel = typeof p.channel === "string" ? p.channel : undefined;
      const publishedAt = typeof p.publishedAt === "string" ? p.publishedAt : undefined;
      if (videoId === undefined || watchUrl === undefined || title === undefined || channel === undefined) {
        return { ok: false, code: "unreachable", message: "youtube extract: malformed output" };
      }
      const transcript = flattenSegmentsInOrder(p.segments);
      if (transcript === undefined || transcript.trim().length === 0) {
        // Captions unavailable / no segments ⇒ fetched-but-empty, fail-closed (never a silent
        // success). Distinct from `unreachable` — mirrors youtube-source.ts's own `no_transcript`.
        return { ok: false, code: "no_transcript", message: "youtube extract: no transcript available" };
      }
      const video: YouTubeExtract = {
        videoId,
        watchUrl,
        title,
        channel,
        transcript,
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      };
      return { ok: true, video };
    } catch {
      return { ok: false, code: "unknown", message: "youtube extract faulted" };
    }
  };
}
