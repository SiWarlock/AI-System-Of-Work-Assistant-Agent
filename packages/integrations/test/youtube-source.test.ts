// @sow/integrations — PROTOTYPE (Phase-13 §13.2 proof-of-pattern).
//
// The governed-inheritance seam for an `obsidian-second-brain` extractor: the
// vendored, pinned YouTube fetch lib (transcript via youtube-transcript-api) runs
// behind an INJECTED `YouTubeExtractTransport` and the adapter turns its output
// into a CANDIDATE `RegisterSourceInput` — it EMITS candidate data and NEVER
// writes the vault. The proof that governance holds: the emitted candidate must
// pass the REAL `registerSource()` gate end-to-end (extractor → candidate → gate),
// and every failure is a typed `Result` err, never a throw across the boundary.
import { describe, it, expect } from "vitest";
import {
  extractYouTubeSource,
  type YouTubeExtractTransport,
  type ExtractYouTubeInput,
} from "../src/connectors/adapters/youtube-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A fake extractor transport standing in for the vendored `youtube_extract.py
// --emit-json` subprocess (SoW convention: no real transport in tests).
function fakeTransport(transcript = "hello world, this is the transcript"): YouTubeExtractTransport {
  return async () => ({
    ok: true,
    video: {
      videoId: "abc123",
      watchUrl: "https://www.youtube.com/watch?v=abc123",
      title: "How the candidate-data gate works",
      channel: "System of Work",
      transcript,
      publishedAt: "2026-07-01",
    },
  });
}

function input(partial: Partial<ExtractYouTubeInput> = {}): ExtractYouTubeInput {
  return {
    sourceId: "src_yt_1",
    workspaceId: "employer-work",
    watchUrl: "https://www.youtube.com/watch?v=abc123",
    sensitivity: "normal",
    ...partial,
  };
}

describe("Phase-13 §13.2 — extractYouTubeSource (emit-only source adapter)", () => {
  it("maps an extract → a candidate RegisterSourceInput (type youtube_video, workspace passed through, NOT invented)", async () => {
    const res = await extractYouTubeSource(input(), fakeTransport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const candidate = res.value;
    expect(candidate.type).toBe("youtube_video");
    expect(candidate.origin).toBe("https://www.youtube.com/watch?v=abc123");
    expect(candidate.workspaceId).toBe("employer-work"); // passed through, scoped-before-durable
    expect(candidate.sourceId).toBe("src_yt_1");
    expect(candidate.routingHints).toMatchObject({
      videoId: "abc123",
      title: "How the candidate-data gate works",
      channel: "System of Work",
    });
  });

  it("derives a deterministic, replay-stable contentHash over the content (sha256)", async () => {
    const a = await extractYouTubeSource(input(), fakeTransport("same transcript"));
    const b = await extractYouTubeSource(input(), fakeTransport("same transcript"));
    const c = await extractYouTubeSource(input(), fakeTransport("DIFFERENT transcript"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.value.contentHash).toBe(b.value.contentHash); // same content → same key
    expect(a.value.contentHash).not.toBe(c.value.contentHash); // different content → different key
  });

  it("GOVERNANCE PROOF: the emitted candidate passes the REAL registerSource() gate (extractor → candidate → gate)", async () => {
    const extracted = await extractYouTubeSource(input(), fakeTransport());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const registered = await registerSource(extracted.value, { seenContentHash: neverSeen });
    expect(registered.outcome).toBe("registered");
    if (registered.outcome !== "registered") return;
    expect(registered.envelope.type).toBe("youtube_video");
    expect(registered.envelope.workspaceId).toBe("employer-work");
  });

  it("re-registering the same video content is a NO-OP dedupe hit (Flow-4), never a duplicate source", async () => {
    const extracted = await extractYouTubeSource(input(), fakeTransport("dedupe me"));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(extracted.value, { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
  });

  it("fails CLOSED to a typed err when the transport reports no transcript — no candidate, nothing thrown", async () => {
    const noTranscript: YouTubeExtractTransport = async () => ({
      ok: false,
      code: "no_transcript",
      message: "captions disabled for this video",
    });
    const res = await extractYouTubeSource(input(), noTranscript);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("no_transcript");
  });

  it("never throws across the boundary — a transport that throws becomes a typed 'unknown' err", async () => {
    const throwing: YouTubeExtractTransport = async () => {
      throw new Error("yt-dlp exploded");
    };
    const res = await extractYouTubeSource(input(), throwing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
  });

  // ── Lesson-11 hardening: adapter-level empty guard + whole-map-under-one-try (parity with web/podcast) ──

  it("fails CLOSED on an EMPTY / whitespace / null / missing transcript on an ok result — adapter-level guard, never a contentless candidate (safety rules 2/6)", async () => {
    // The transport resolves ok:true but the transcript is unusable WITHOUT signalling no_transcript.
    // Today youtube relies only on the transport's no_transcript code, so these slip through as a
    // contentless candidate; the adapter-level guard fails them closed (empty_content), like web/podcast.
    const base = { videoId: "v", watchUrl: "https://www.youtube.com/watch?v=v", title: "T", channel: "C" };
    const emptyString = fakeTransport("");
    const whitespace = fakeTransport("   \n  ");
    const nullTranscript = (async () => ({ ok: true, video: { ...base, transcript: null } })) as unknown as YouTubeExtractTransport;
    const missingTranscript = (async () => ({ ok: true, video: base })) as unknown as YouTubeExtractTransport;
    for (const t of [emptyString, whitespace, nullTranscript, missingTranscript]) {
      const res = await extractYouTubeSource(input(), t);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a pathological ok-shape — a null video ⇒ empty_content, a field read that THROWS ⇒ 'unknown'; never a throw across the seam (Lesson 11, whole map under one try)", async () => {
    // (a) a null/absent video — the graceful `video?.transcript` guard classifies it as empty_content.
    const nullVideo = (async () => ({ ok: true, video: null })) as unknown as YouTubeExtractTransport;
    const resNull = await extractYouTubeSource(input(), nullVideo);
    expect(resNull.ok).toBe(false);
    if (resNull.ok) return;
    expect(resNull.error.code).toBe("empty_content");

    // (b) a hostile getter that THROWS on field access during the map — proves the WHOLE post-transport
    //     map (not just the transport call) is under the one try: the throw is caught → typed unknown,
    //     never propagated across the seam. This is the youtube gap this slice closes.
    const throwingGetter = (async () => {
      const video = { videoId: "v", watchUrl: "https://www.youtube.com/watch?v=v", title: "T", channel: "C" };
      Object.defineProperty(video, "transcript", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return { ok: true, video };
    }) as unknown as YouTubeExtractTransport;
    const resThrow = await extractYouTubeSource(input(), throwingGetter);
    expect(resThrow.ok).toBe(false);
    if (resThrow.ok) return;
    expect(resThrow.error.code).toBe("unknown");
  });

  it("does not mutate its input (pure, emit-only — no hidden side effect)", async () => {
    const original = input();
    const frozen = Object.freeze({ ...original });
    const res = await extractYouTubeSource(frozen, fakeTransport());
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(original);
  });
});
