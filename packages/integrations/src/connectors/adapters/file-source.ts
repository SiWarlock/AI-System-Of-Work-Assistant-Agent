// @sow/integrations — file/PDF source-extraction adapter (Phase-13 §13.2).
//
// The governed-inheritance seam for an `obsidian-second-brain` file/PDF extractor.
// A real file read + PDF/doc text-extraction runs behind an INJECTED
// `FileExtractTransport` — tests inject a fake, production wires the real fs read +
// text-extraction at the marked REAL-EXTRACTOR INJECTION POINT (out of scope here —
// no fs/vendor I/O in this adapter or its tests). This adapter's ONLY job is to map
// that extract → a CANDIDATE `RegisterSourceInput`:
//
//   • EMIT-ONLY — it returns candidate data; it NEVER writes the vault. Every
//     durable effect is downstream of `registerSource()` (the candidate gate) and,
//     ultimately, `KnowledgeWriter` (the sole writer). (safety rule 1)
//   • NO INFERENCE — `workspaceId`/`sourceId`/`sensitivity` are passed through from
//     the caller's policy, never invented from content (REQ-F-017). The adapter
//     derives only the dedupe key + routing hints that ARE in the extracted content.
//   • ING-7 — the adapter consumes UNTRUSTED file content read-only/emit-only; it
//     has no mutating path (safety rule 6).
//   • PURE + TOTAL (§16) — no clock, no randomness, no I/O of its own; it NEVER
//     throws across the boundary — a transport fault (typed OR thrown) becomes a
//     typed `Result` err so the caller classifies deterministically.
//
// The summarize/enrichment cloud calls osb bakes in are NOT here: they belong to a
// downstream read-only extraction agent routed through `ModelProviderPort` under the
// egress veto. This adapter only carries the extracted text forward as a candidate;
// an unextractable / image-only file (no usable text) fails closed (`empty_content`),
// it is not silently registered.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/** The structured extract a real file read + text-extraction yields for one file. */
export interface ExtractedFile {
  /**
   * The file path — always present, and the canonical locator, so it becomes the
   * SourceEnvelope `origin`. The dedupe key is hashed over this (+ the text), so the
   * same text at a different path is a distinct source. `filename`/`mime` are optional
   * metadata, so they can NOT be the guaranteed locator.
   */
  readonly path: string;
  readonly filename?: string;
  readonly mime?: string;
  /** The extracted document text. The required content; the dedupe key is hashed over it (+ the path). */
  readonly text: string;
}

/**
 * The injected extractor transport (a real fs read + PDF/doc text-extraction in
 * production, a fake in tests). Closed result: an extracted file OR a typed failure —
 * the caller never re-throws. Emptiness is NOT signalled here (unlike youtube's
 * `no_transcript`): the transport returns the extracted `text`, so an unextractable /
 * contentless file is detected + rejected at the adapter (`empty_content`).
 */
export type FileExtractResult =
  | { readonly ok: true; readonly file: ExtractedFile }
  | { readonly ok: false; readonly code: "unreachable" | "unknown"; readonly message: string };

/** The transport an adapter hands the extractor: the file path (+ optional mime hint) to read. */
export type FileExtractTransport = (req: {
  readonly path: string;
  readonly mime?: string;
}) => Promise<FileExtractResult>;

/**
 * The caller-supplied policy fields. `workspaceId`/`sensitivity` come from the
 * ingestion policy (scoped-before-durable, REQ-F-002) — the adapter does NOT infer
 * them from the file (REQ-F-017). `path` is the source to extract.
 */
export interface ExtractFileInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly path: string;
  /**
   * An OPTIONAL caller-supplied mime hint (the ingestion policy often already knows
   * the file's type, e.g. from its extension) — threaded to the transport for parser
   * selection at the real (deferred) injection point. A caller POLICY hint, NOT
   * content-inferred; omitted when the caller has none. Distinct from
   * `ExtractedFile.mime` (the mime the extractor DETERMINED, which rides routingHints).
   */
  readonly mime?: string;
  readonly sensitivity: string;
}

/** The CLOSED extraction failure set (§16 — enumerable). */
export interface FileExtractError {
  readonly code: "unreachable" | "empty_content" | "unknown";
  readonly message: string;
}

/**
 * Extract a file into a CANDIDATE `RegisterSourceInput` — emit-only, never writes,
 * never throws. On success the returned candidate is exactly the surface
 * `registerSource()` (the candidate gate) consumes; on any transport fault, or an
 * empty/malformed extracted text, a typed `Result` err. The `contentHash` is a
 * deterministic, replay-stable digest over the file identity + text (Flow-4 dedupe key).
 */
export async function extractFileSource(
  input: ExtractFileInput,
  transport: FileExtractTransport,
): Promise<Result<RegisterSourceInput, FileExtractError>> {
  // Defend the boundary TOTALLY (§16 — nothing throws across this seam): the WHOLE
  // transport call + mapping runs under one try. The real (deferred) transport is
  // UNTRUSTED — it can throw OR resolve `ok` with a pathological shape (a null/
  // non-string text, a null file, a hostile getter, a circular value) — and every
  // such fault becomes a typed err, never an uncaught throw (Lesson 11).
  try {
    // Thread the caller's path + optional mime hint (parser-selection hint for the
    // real injection point; a policy hint, never content-derived — mirrors podcast's
    // `feedUrl?`). Absent hint ⇒ `mime` is simply undefined in the request.
    const result = await transport({ path: input.path, mime: input.mime });

    if (!result.ok) {
      return err({ code: result.code, message: result.message });
    }

    const { file } = result;

    // Fail-closed on an empty / whitespace-only / MALFORMED extracted text — never emit
    // a contentless candidate (safety rules 2/6). An unextractable / image-only file
    // resolves `ok` with a null/absent text; that is a fault, not a silent success
    // (PDF/doc parsing is the downstream ModelProviderPort concern), so the shape check
    // lives alongside the emptiness check.
    if (typeof file?.text !== "string" || file.text.trim().length === 0) {
      return err({ code: "empty_content", message: "file extraction returned empty or malformed extracted text" });
    }

    // Dedupe key over the CONTENT (file identity + text) — deterministic + replay-stable
    // (payloadHash is key-sorted SHA-256). The same file re-extracted yields the same
    // key → a Flow-4 `dedupe_hit` at the gate, never a duplicate source; the same text
    // at a DIFFERENT path keys differently (path participates).
    const contentHash = payloadHash({ path: file.path, text: file.text });

    // Routing hints carry ONLY what is IN the extracted content (metadata) — used by the
    // ingestion router for correlation. No invented workspace/owner/date; absent
    // optional metadata is OMITTED, never fabricated. Both hints are optional, so an
    // extract with neither yields an EMPTY `{}` (an honest low-confidence source — the
    // ingestion inbox's concern — never a synthetic default). `path` is the `origin`,
    // not duplicated here; the text is the dedupe content, never a hint.
    const routingHints: Record<string, unknown> = {
      ...(file.filename !== undefined ? { filename: file.filename } : {}),
      ...(file.mime !== undefined ? { mime: file.mime } : {}),
    };

    // The candidate — passed through the gate next. Scoped fields come from the
    // caller's policy verbatim (no inference); the type is the open source-taxonomy
    // value `file`; the origin is the guaranteed file locator (the path).
    const candidate: RegisterSourceInput = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      origin: file.path,
      contentHash,
      type: "file",
      sensitivity: input.sensitivity,
      routingHints,
    };

    return ok(candidate);
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }
}
