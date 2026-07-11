// @sow/integrations — Phase-13 §13.2 podcast source extractor (emit-only).
//
// The governed-inheritance seam for an `obsidian-second-brain` podcast extractor: a real RSS fetch +
// audio transcription runs behind an INJECTED `PodcastExtractTransport` (a fake in tests — NO network)
// and the adapter turns its output into a CANDIDATE `RegisterSourceInput` — it EMITS candidate data
// and NEVER writes the vault. The proof that governance holds: the emitted candidate must pass the
// REAL `registerSource()` gate end-to-end (extractor → candidate → gate), and every failure is a typed
// `Result` err, never a throw across the boundary. Mirrors `web-source.test.ts` (Lesson 11).
import { describe, it, expect } from "vitest";
import {
  extractPodcastSource,
  type PodcastExtractTransport,
  type ExtractPodcastInput,
} from "../src/connectors/adapters/podcast-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A fake extractor transport standing in for the real RSS fetch + transcription (no network in tests).
function fakeTransport(
  transcript = "The episode transcript. Candidate data flows to the gate, never the vault.",
): PodcastExtractTransport {
  return async () => ({
    ok: true,
    episode: {
      episodeId: "guid-abc123",
      title: "How the candidate-data gate works",
      showTitle: "System of Work",
      publishedAt: "2026-07-01",
      audioUrl: "https://cdn.example.com/ep/abc123.mp3",
      transcript,
    },
  });
}

function input(partial: Partial<ExtractPodcastInput> = {}): ExtractPodcastInput {
  return {
    sourceId: "src_pod_1",
    workspaceId: "employer-work",
    feedUrl: "https://example.com/feed.xml",
    episodeId: "guid-abc123",
    sensitivity: "normal",
    ...partial,
  };
}

describe("Phase-13 §13.2 — extractPodcastSource (emit-only podcast source adapter)", () => {
  it("maps a podcast extract → a candidate RegisterSourceInput (type podcast, origin=episodeId, workspace/sensitivity passed through, NOT invented)", async () => {
    const res = await extractPodcastSource(input(), fakeTransport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("podcast");
    expect(c.origin).toBe("guid-abc123"); // episodeId is the guaranteed locator
    expect(c.workspaceId).toBe("employer-work"); // passed through, scoped-before-durable
    expect(c.sensitivity).toBe("normal"); // passed through, never inferred
    expect(c.sourceId).toBe("src_pod_1");
    expect(c.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // routingHints from metadata ONLY.
    expect(c.routingHints).toMatchObject({
      title: "How the candidate-data gate works",
      showTitle: "System of Work",
      publishedAt: "2026-07-01",
      audioUrl: "https://cdn.example.com/ep/abc123.mp3",
    });
    // the transcript is NOT a routing hint (dedupe key only); episodeId is the origin, not duplicated;
    // no invented scope fields.
    expect(c.routingHints).not.toHaveProperty("transcript");
    expect(c.routingHints).not.toHaveProperty("episodeId");
    expect(c.routingHints).not.toHaveProperty("workspaceId");
  });

  it("no-inference: workspace + sensitivity come from the input; absent optional metadata is OMITTED, never fabricated", async () => {
    const res = await extractPodcastSource(
      input({ workspaceId: "personal-business", sensitivity: "confidential" }),
      // an episode with NO showTitle / publishedAt / audioUrl — the optional hints must be ABSENT.
      async () => ({ ok: true, episode: { episodeId: "guid-bare", title: "Bare", transcript: "some transcript" } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workspaceId).toBe("personal-business");
    expect(res.value.sensitivity).toBe("confidential");
    expect(res.value.routingHints).toEqual({ title: "Bare" }); // showTitle/publishedAt/audioUrl absent, not fabricated
  });

  it("derives a deterministic, replay-stable contentHash over {episodeId, transcript} (sha256)", async () => {
    const a = await extractPodcastSource(input(), fakeTransport("same transcript"));
    const b = await extractPodcastSource(input(), fakeTransport("same transcript"));
    const c = await extractPodcastSource(input(), fakeTransport("DIFFERENT transcript"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.value.contentHash).toBe(b.value.contentHash); // same content → same key
    expect(a.value.contentHash).not.toBe(c.value.contentHash); // different content → different key
  });

  it("GOVERNANCE PROOF: the emitted candidate passes the REAL registerSource() gate (extractor → candidate → gate)", async () => {
    const extracted = await extractPodcastSource(input(), fakeTransport());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const registered = await registerSource(extracted.value, { seenContentHash: neverSeen });
    expect(registered.outcome).toBe("registered");
    if (registered.outcome !== "registered") return;
    expect(registered.envelope.type).toBe("podcast");
    expect(registered.envelope.workspaceId).toBe("employer-work");
  });

  it("re-registering the same {episodeId,transcript} is a NO-OP dedupe hit (Flow-4), never a duplicate source", async () => {
    const extracted = await extractPodcastSource(input(), fakeTransport("dedupe me"));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(extracted.value, { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
  });

  it("fails CLOSED to a typed err when the transport reports unreachable — no candidate, nothing thrown", async () => {
    const unreachable: PodcastExtractTransport = async () => ({ ok: false, code: "unreachable", message: "feed 404" });
    const res = await extractPodcastSource(input(), unreachable);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unreachable");
  });

  it("fails CLOSED on an EMPTY / whitespace-only transcript — never emits a contentless candidate (safety rules 2/6)", async () => {
    for (const empty of ["", "   \n  "]) {
      const res = await extractPodcastSource(
        input(),
        async () => ({ ok: true, episode: { episodeId: "guid-x", title: "T", transcript: empty } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a MALFORMED transcript — a transport that resolves ok with a null/missing transcript ⇒ typed err, never a throw (§16, Lesson 11)", async () => {
    // The real (deferred) transport is untrusted: transcription of an audio-only episode commonly
    // yields ok with no usable transcript (e.g. { episodeId, title, transcript: null }). This must NOT
    // throw across the seam — it fails closed to a typed err, exactly like an empty string transcript.
    const nullTranscript = (async () => ({
      ok: true,
      episode: { episodeId: "guid-x", title: "T", transcript: null },
    })) as unknown as PodcastExtractTransport;
    const missingTranscript = (async () => ({
      ok: true,
      episode: { episodeId: "guid-x", title: "T" },
    })) as unknown as PodcastExtractTransport;
    for (const t of [nullTranscript, missingTranscript]) {
      const res = await extractPodcastSource(input(), t);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a pathological episode shape — a null episode ⇒ empty_content, a field read that THROWS ⇒ 'unknown'; never a throw across the seam (Lesson 11, whole map under one try)", async () => {
    // The untrusted transport can resolve ok with a wholly pathological shape. Two shapes, both must
    // fail closed WITHOUT throwing across the seam:
    //  (a) a null/absent episode — the graceful `episode?.transcript` guard classifies it as
    //      `empty_content` (no transcript), exactly like a missing transcript.
    const nullEpisode = (async () => ({ ok: true, episode: null })) as unknown as PodcastExtractTransport;
    const resNull = await extractPodcastSource(input(), nullEpisode);
    expect(resNull.ok).toBe(false);
    if (resNull.ok) return;
    expect(resNull.error.code).toBe("empty_content");

    //  (b) an episode whose field access THROWS during the map (a hostile getter) — this is the case
    //      that proves the WHOLE post-transport map (not just the transport call) is under the one try:
    //      the throw is caught → typed `unknown`, never propagated. (The youtube-source gap this closes.)
    const throwingGetter = (async () => {
      const episode = { title: "T" };
      Object.defineProperty(episode, "transcript", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return { ok: true, episode };
    }) as unknown as PodcastExtractTransport;
    const resThrow = await extractPodcastSource(input(), throwingGetter);
    expect(resThrow.ok).toBe(false);
    if (resThrow.ok) return;
    expect(resThrow.error.code).toBe("unknown");
  });

  it("the contentHash includes the episodeId — the SAME transcript for a DIFFERENT episode is a DIFFERENT source (not a false dedupe)", async () => {
    const a = await extractPodcastSource(input({ episodeId: "guid-a" }), async () => ({
      ok: true,
      episode: { episodeId: "guid-a", title: "T", transcript: "identical transcript" },
    }));
    const b = await extractPodcastSource(input({ episodeId: "guid-b" }), async () => ({
      ok: true,
      episode: { episodeId: "guid-b", title: "T", transcript: "identical transcript" },
    }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.contentHash).not.toBe(b.value.contentHash); // episodeId participates in the dedupe key
  });

  it("never throws across the boundary — a transport that throws becomes a typed 'unknown' err", async () => {
    const throwing: PodcastExtractTransport = async () => {
      throw new Error("transcription exploded");
    };
    const res = await extractPodcastSource(input(), throwing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
  });

  it("does not mutate its input (pure, emit-only — no hidden side effect, no clock/network of its own)", async () => {
    const original = input();
    const frozen = Object.freeze({ ...original });
    const res = await extractPodcastSource(frozen, fakeTransport());
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(original);
  });
});
