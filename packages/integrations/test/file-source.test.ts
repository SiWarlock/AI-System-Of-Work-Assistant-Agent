// @sow/integrations — Phase-13 §13.2 file/PDF source extractor (emit-only).
//
// The governed-inheritance seam for an `obsidian-second-brain` file/PDF extractor: a real file read +
// PDF/doc text-extraction runs behind an INJECTED `FileExtractTransport` (a fake in tests — NO fs I/O)
// and the adapter turns its output into a CANDIDATE `RegisterSourceInput` — it EMITS candidate data and
// NEVER writes the vault. The proof that governance holds: the emitted candidate must pass the REAL
// `registerSource()` gate end-to-end (extractor → candidate → gate), and every failure is a typed
// `Result` err, never a throw across the boundary. Mirrors `web-source.test.ts`/`podcast-source.test.ts`
// (Lesson 11). Completes the 4-extractor set (YouTube/web/podcast/file).
import { describe, it, expect } from "vitest";
import {
  extractFileSource,
  type FileExtractTransport,
  type ExtractFileInput,
} from "../src/connectors/adapters/file-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;

// A fake extractor transport standing in for the real file read + PDF/doc text-extraction (no fs in tests).
function fakeTransport(
  text = "The extracted document text. Candidate data flows to the gate, never the vault.",
): FileExtractTransport {
  return async () => ({
    ok: true,
    file: {
      path: "/vault/inbox/report.pdf",
      filename: "report.pdf",
      mime: "application/pdf",
      text,
    },
  });
}

function input(partial: Partial<ExtractFileInput> = {}): ExtractFileInput {
  return {
    sourceId: "src_file_1",
    workspaceId: "employer-work",
    path: "/vault/inbox/report.pdf",
    sensitivity: "normal",
    ...partial,
  };
}

describe("Phase-13 §13.2 — extractFileSource (emit-only file/PDF source adapter)", () => {
  it("maps a file extract → a candidate RegisterSourceInput (type file, origin=path, workspace/sensitivity passed through, NOT invented)", async () => {
    const res = await extractFileSource(input(), fakeTransport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.value;
    expect(c.type).toBe("file");
    expect(c.origin).toBe("/vault/inbox/report.pdf"); // path is the guaranteed locator
    expect(c.workspaceId).toBe("employer-work"); // passed through, scoped-before-durable
    expect(c.sensitivity).toBe("normal"); // passed through, never inferred
    expect(c.sourceId).toBe("src_file_1");
    expect(c.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // routingHints from metadata ONLY — pinned EXACTLY (toEqual), so a stray key (the extracted
    // text, the path already carried as origin, an invented scope field) would fail the test.
    expect(c.routingHints).toEqual({
      filename: "report.pdf",
      mime: "application/pdf",
    });
  });

  it("no-inference: workspace + sensitivity come from the input; absent filename/mime is OMITTED — routingHints is {} when neither is present, never fabricated", async () => {
    const res = await extractFileSource(
      input({ workspaceId: "personal-business", sensitivity: "confidential" }),
      // a file with NO filename / mime — the optional hints must be ABSENT, not invented.
      async () => ({ ok: true, file: { path: "/vault/inbox/note.txt", text: "some body" } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workspaceId).toBe("personal-business");
    expect(res.value.sensitivity).toBe("confidential");
    expect(res.value.routingHints).toEqual({}); // filename/mime absent, not fabricated
  });

  it("routingHints carries EXACTLY the present optional metadata — filename only ⇒ {filename}, the absent mime is not fabricated", async () => {
    const res = await extractFileSource(
      input(),
      async () => ({ ok: true, file: { path: "/vault/inbox/x.md", filename: "x.md", text: "some body" } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.routingHints).toEqual({ filename: "x.md" }); // mime absent, not fabricated
  });

  it("threads the caller's path + optional mime hint to the transport (a policy hint for parser selection, never content-derived)", async () => {
    let seen: { path: string; mime?: string } | undefined;
    const capturing: FileExtractTransport = async (req) => {
      seen = req;
      return { ok: true, file: { path: req.path, text: "body" } };
    };
    await extractFileSource(input({ path: "/vault/a.pdf", mime: "application/pdf" }), capturing);
    expect(seen).toEqual({ path: "/vault/a.pdf", mime: "application/pdf" });
    // absent hint ⇒ the caller passes no mime (undefined), never an invented one.
    await extractFileSource(input({ path: "/vault/b.txt" }), capturing);
    expect(seen).toEqual({ path: "/vault/b.txt" });
  });

  it("derives a deterministic, replay-stable contentHash over {path, text} (sha256)", async () => {
    const a = await extractFileSource(input(), fakeTransport("same body"));
    const b = await extractFileSource(input(), fakeTransport("same body"));
    const c = await extractFileSource(input(), fakeTransport("DIFFERENT body"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.value.contentHash).toBe(b.value.contentHash); // same content → same key
    expect(a.value.contentHash).not.toBe(c.value.contentHash); // different content → different key
  });

  it("GOVERNANCE PROOF: the emitted candidate passes the REAL registerSource() gate (extractor → candidate → gate)", async () => {
    const extracted = await extractFileSource(input(), fakeTransport());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const registered = await registerSource(extracted.value, { seenContentHash: neverSeen });
    expect(registered.outcome).toBe("registered");
    if (registered.outcome !== "registered") return;
    expect(registered.envelope.type).toBe("file");
    expect(registered.envelope.workspaceId).toBe("employer-work");
  });

  it("re-registering the same {path,text} is a NO-OP dedupe hit (Flow-4), never a duplicate source", async () => {
    const extracted = await extractFileSource(input(), fakeTransport("dedupe me"));
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const alwaysSeen: RegisterSourceDeps["seenContentHash"] = async () => true;
    const res = await registerSource(extracted.value, { seenContentHash: alwaysSeen });
    expect(res.outcome).toBe("dedupe_hit");
  });

  it("the contentHash includes the path — the SAME text at a DIFFERENT path is a DIFFERENT source (not a false dedupe)", async () => {
    const a = await extractFileSource(input({ path: "/vault/a/doc.txt" }), async () => ({
      ok: true,
      file: { path: "/vault/a/doc.txt", text: "identical body" },
    }));
    const b = await extractFileSource(input({ path: "/vault/b/doc.txt" }), async () => ({
      ok: true,
      file: { path: "/vault/b/doc.txt", text: "identical body" },
    }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.contentHash).not.toBe(b.value.contentHash); // path participates in the dedupe key
  });

  it("fails CLOSED to a typed err when the transport reports unreachable — no candidate, nothing thrown", async () => {
    const unreachable: FileExtractTransport = async () => ({ ok: false, code: "unreachable", message: "file not found" });
    const res = await extractFileSource(input(), unreachable);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unreachable");
  });

  it("never throws across the boundary — a transport that throws becomes a typed 'unknown' err", async () => {
    const throwing: FileExtractTransport = async () => {
      throw new Error("pdf parse exploded");
    };
    const res = await extractFileSource(input(), throwing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
  });

  it("fails CLOSED on an EMPTY / whitespace-only extracted text — never emits a contentless candidate (safety rules 2/6)", async () => {
    for (const empty of ["", "   \n  "]) {
      const res = await extractFileSource(
        input(),
        async () => ({ ok: true, file: { path: "/vault/x.txt", text: empty } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a MALFORMED extract — a transport resolving ok with a null/missing text ⇒ typed err, never a throw (§16, Lesson 11)", async () => {
    // The real (deferred) file transport is untrusted: an unextractable / image-only PDF commonly yields
    // ok with no usable text (e.g. { path, text: null }). This must NOT throw across the seam — it fails
    // closed to a typed err, exactly like an empty string text.
    const nullText = (async () => ({ ok: true, file: { path: "/vault/x.txt", text: null } })) as unknown as FileExtractTransport;
    const missingText = (async () => ({ ok: true, file: { path: "/vault/x.txt" } })) as unknown as FileExtractTransport;
    for (const t of [nullText, missingText]) {
      const res = await extractFileSource(input(), t);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("empty_content");
    }
  });

  it("fails CLOSED on a pathological file shape — a null file ⇒ empty_content, a field read that THROWS ⇒ 'unknown'; never a throw across the seam (Lesson 11, whole map under one try)", async () => {
    // (a) a null/absent file — the graceful `file?.text` guard classifies it as empty_content.
    const nullFile = (async () => ({ ok: true, file: null })) as unknown as FileExtractTransport;
    const resNull = await extractFileSource(input(), nullFile);
    expect(resNull.ok).toBe(false);
    if (resNull.ok) return;
    expect(resNull.error.code).toBe("empty_content");

    // (b) a file whose field access THROWS during the map (a hostile getter) — proves the WHOLE
    //     post-transport map is under the one try: the throw is caught → typed unknown, never propagated.
    const throwingGetter = (async () => {
      const file = { path: "/vault/x.txt" };
      Object.defineProperty(file, "text", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return { ok: true, file };
    }) as unknown as FileExtractTransport;
    const resThrow = await extractFileSource(input(), throwingGetter);
    expect(resThrow.ok).toBe(false);
    if (resThrow.ok) return;
    expect(resThrow.error.code).toBe("unknown");
  });

  it("does not mutate its input (pure, emit-only — no hidden side effect, no clock/fs of its own)", async () => {
    const original = input();
    const frozen = Object.freeze({ ...original });
    const res = await extractFileSource(frozen, fakeTransport());
    expect(res.ok).toBe(true);
    expect(frozen).toEqual(original);
  });
});
