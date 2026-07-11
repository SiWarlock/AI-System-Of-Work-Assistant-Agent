// @sow/integrations — Phase-13 §13.2 web-article source extractor (emit-only).
//
// The governed-inheritance seam for an `obsidian-second-brain` web/readability extractor: a real
// WebFetch runs behind an INJECTED `WebFetchTransport` (a fake in tests — NO network) and the adapter
// turns its output into a CANDIDATE `RegisterSourceInput` — it EMITS candidate data and NEVER writes
// the vault. The proof that governance holds: the emitted candidate must pass the REAL
// `registerSource()` gate end-to-end (extractor → candidate → gate), and every failure is a typed
// `Result` err, never a throw across the boundary. Mirrors `youtube-source.test.ts`.
import { describe, it, expect } from "vitest";
import {
  extractWebSource,
  type WebFetchTransport,
  type ExtractWebInput,
} from "../src/connectors/adapters/web-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A fake WebFetch transport standing in for the real readability extraction (no network in tests).
function fakeTransport(text = "The article body. Candidate data flows to the gate, never the vault."): WebFetchTransport {
  return async () => ({
    ok: true,
    page: {
      url: "https://example.com/how-the-gate-works",
      title: "How the candidate-data gate works",
      byline: "A. Writer",
      publishedAt: "2026-07-01",
      text,
    },
  });
}

function input(partial: Partial<ExtractWebInput> = {}): ExtractWebInput {
  return {
    sourceId: "src_web_1",
    workspaceId: "employer-work",
    url: "https://example.com/how-the-gate-works",
    sensitivity: "normal",
    ...partial,
  };
}

describe("Phase-13 §13.2 — extractWebSource (emit-only web-article source adapter)", () => {
  it("maps a web extract → a candidate RegisterSourceInput (type web_article, workspace/sensitivity passed through, NOT invented)", async () => {
    const res = await extractWebSource(input(), fakeTransport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("web_article");
    expect(c.origin).toBe("https://example.com/how-the-gate-works");
    expect(c.workspaceId).toBe("employer-work"); // passed through, scoped-before-durable
    expect(c.sensitivity).toBe("normal"); // passed through, never inferred
    expect(c.sourceId).toBe("src_web_1");
    expect(c.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // routingHints from metadata ONLY.
    expect(c.routingHints).toMatchObject({
      title: "How the candidate-data gate works",
      byline: "A. Writer",
      publishedAt: "2026-07-01",
    });
    // the body text is NOT a routing hint (dedupe key only); no invented scope fields.
    expect(c.routingHints).not.toHaveProperty("text");
    expect(c.routingHints).not.toHaveProperty("workspaceId");
  });

  it("no-inference: workspace + sensitivity come from the input; absent optional metadata is OMITTED, never fabricated", async () => {
    const res = await extractWebSource(
      input({ workspaceId: "personal-business", sensitivity: "confidential" }),
      // a page with NO byline / publishedAt — the optional hints must be ABSENT, not invented.
      async () => ({ ok: true, page: { url: "https://x.test/a", title: "Bare", text: "some body" } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workspaceId).toBe("personal-business");
    expect(res.value.sensitivity).toBe("confidential");
    expect(res.value.routingHints).toEqual({ title: "Bare" }); // byline/publishedAt absent, not fabricated
  });

  it("derives a deterministic, replay-stable contentHash over {url, text} (sha256)", async () => {
    const a = await extractWebSource(input(), fakeTransport("same body"));
    const b = await extractWebSource(input(), fakeTransport("same body"));
    const c = await extractWebSource(input(), fakeTransport("DIFFERENT body"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.value.contentHash).toBe(b.value.contentHash); // same content → same key
    expect(a.value.contentHash).not.toBe(c.value.contentHash); // different content → different key
  });

  it("GOVERNANCE PROOF: the emitted candidate passes the REAL registerSource() gate (extractor → candidate → gate)", async () => {
    const extracted = await extractWebSource(input(), fakeTransport());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const registered = await registerSource(extracted.value, { seenContentHash: neverSeen });
    expect(registered.outcome).toBe("registered");
    if (registered.outcome !== "registered") return;
    expect(registered.envelope.type).toBe("web_article");
    expect(registered.envelope.workspaceId).toBe("employer-work");
  });

  it("re-registering the same {url,text} is a NO-OP dedupe hit (Flow-4), never a duplicate source", async () => {
    const extracted = await extractWebSource(input(), fakeTransport("dedupe me"));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(extracted.value, { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
  });

  it("fails CLOSED to a typed err when the transport reports unreachable — no candidate, nothing thrown", async () => {
    const unreachable: WebFetchTransport = async () => ({ ok: false, code: "unreachable", message: "DNS failure" });
    const res = await extractWebSource(input(), unreachable);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unreachable");
  });

  it("fails CLOSED on an EMPTY / whitespace-only body — never emits a contentless candidate (safety rules 2/6)", async () => {
    for (const empty of ["", "   \n  "]) {
      const res = await extractWebSource(
        input(),
        async () => ({ ok: true, page: { url: "https://x.test/a", title: "T", text: empty } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a MALFORMED body — a transport that resolves ok with a null/missing text ⇒ typed err, never a throw (§16)", async () => {
    // The real (deferred) WebFetch is untrusted: a readability parse of a non-article page commonly
    // yields ok with no usable body (e.g. { url, title, text: null }). This must NOT throw across the
    // seam — it fails closed to a typed err, exactly like an empty string body.
    const nullText = (async () => ({ ok: true, page: { url: "https://x.test/a", title: "T", text: null } })) as unknown as WebFetchTransport;
    const missingText = (async () => ({ ok: true, page: { url: "https://x.test/a", title: "T" } })) as unknown as WebFetchTransport;
    for (const t of [nullText, missingText]) {
      const res = await extractWebSource(input(), t);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("the contentHash includes the URL — the SAME text at a DIFFERENT url is a DIFFERENT source (not a false dedupe)", async () => {
    const a = await extractWebSource(input({ url: "https://a.test/x" }), async () => ({
      ok: true,
      page: { url: "https://a.test/x", title: "T", text: "identical body" },
    }));
    const b = await extractWebSource(input({ url: "https://b.test/y" }), async () => ({
      ok: true,
      page: { url: "https://b.test/y", title: "T", text: "identical body" },
    }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.contentHash).not.toBe(b.value.contentHash); // url participates in the dedupe key
  });

  it("never throws across the boundary — a transport that throws becomes a typed 'unknown' err", async () => {
    const throwing: WebFetchTransport = async () => {
      throw new Error("fetch exploded");
    };
    const res = await extractWebSource(input(), throwing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
  });

  it("does not mutate its input (pure, emit-only — no hidden side effect, no clock/network of its own)", async () => {
    const original = input();
    const frozen = Object.freeze({ ...original });
    const res = await extractWebSource(frozen, fakeTransport());
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(original);
  });
});
