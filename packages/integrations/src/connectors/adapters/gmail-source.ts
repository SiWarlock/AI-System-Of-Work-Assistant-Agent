// @sow/integrations — Gmail ingestion source adapter (Phase-13 §13.10c, on the §13.2 emit-only pattern).
//
// The governed-inheritance seam for a Gmail message extraction. A real message
// hydration (§13.10a — PKG-INT-5's `createGmailHydrator`, if/when it lands) runs
// behind an INJECTED `GmailSourceTransport` — tests inject a fake, a LATER slice
// wires a real hydrator at the marked REAL-EXTRACTOR INJECTION POINT (out of scope
// here — no network/vendor I/O in this adapter or its tests; do not import
// `createGmailHydrator` or bind a transport from this module). This adapter's ONLY
// job is to map one hydrated message → a CANDIDATE `RegisterSourceInput`:
//
//   • EMIT-ONLY — it returns candidate data; it NEVER writes the vault. Every
//     durable effect is downstream of `registerSource()` (the candidate gate) and,
//     ultimately, `KnowledgeWriter` (the sole writer). (safety rule 1)
//   • NO INFERENCE — `workspaceId`/`sourceId`/`sensitivity` are passed through from
//     the caller's policy, never invented from content (REQ-F-017). The adapter
//     derives only the dedupe key + routing hints that ARE in the fetched message.
//   • ING-7 — email is UNTRUSTED external content read-only/emit-only; `routingHints`
//     carries `trustLevel: "untrusted"` UNCONDITIONALLY (no code path here can ever
//     produce "trusted") so the downstream extraction agent is tool-stripped to
//     read-only (safety rule 6).
//   • PURE + TOTAL (§16) — no clock, no randomness, no I/O of its own; it NEVER
//     throws across the boundary — a transport fault (typed OR thrown) becomes a
//     typed `Result` err so the caller classifies deterministically.
//
// This adapter does not fetch, parse, or transcribe anything itself — that is the
// injected transport's job (production-bound elsewhere). It is not the Gmail
// `ConnectorPort` (`./gmail.ts`, owned by PKG-INT-5) and it does not add a second
// Gmail HTTP client; it only carries an already-hydrated message forward as a
// candidate. An empty/malformed body fails closed (`empty_content`); it is never
// silently registered.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/**
 * The structured message a real Gmail hydration (`messages.get`) yields for one
 * message. `bodyText` is the required content; `threadId`/`receivedAt` are
 * optional routing metadata that MAY be absent (never defaulted when missing).
 */
export interface GmailMessage {
  readonly messageId: string;
  readonly threadId?: string;
  readonly subject: string;
  readonly from: string;
  readonly receivedAt?: string;
  readonly bodyText: string;
}

/**
 * The injected extractor transport (a real Gmail message hydration in production,
 * a fake in tests). Closed result: a fetched message OR a typed failure — the
 * caller never re-throws. Emptiness is NOT signalled here (unlike a captions-style
 * transport): the transport returns the fetched `bodyText`, so a contentless /
 * malformed body is detected + rejected at the adapter (`empty_content`).
 */
export type GmailSourceResult =
  | { readonly ok: true; readonly message: GmailMessage }
  | { readonly ok: false; readonly code: "unreachable" | "not_found" | "unknown"; readonly message: string };

/** The transport an adapter hands the extractor: the message to fetch. */
export type GmailSourceTransport = (req: { readonly messageId: string }) => Promise<GmailSourceResult>;

/**
 * The caller-supplied policy fields. `workspaceId`/`sensitivity` come from the
 * ingestion policy (scoped-before-durable, REQ-F-002) — the adapter does NOT infer
 * them from the message (REQ-F-017). `messageId` locates the message to fetch.
 */
export interface ExtractGmailSourceInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly sensitivity: string;
}

/** The CLOSED extraction failure set (§16 — enumerable). */
export interface GmailSourceError {
  readonly code: "unreachable" | "not_found" | "empty_content" | "unknown";
  readonly message: string;
}

/**
 * Extract a Gmail message into a CANDIDATE `RegisterSourceInput` — emit-only,
 * never writes, never throws. On success the returned candidate is exactly the
 * surface `registerSource()` (the candidate gate) consumes; on any transport
 * fault, or an empty/malformed body, a typed `Result` err. The `contentHash` is a
 * deterministic, workspace-scoped, replay-stable digest over the message identity
 * + body (Flow-4 dedupe key), matching `capture-source.ts`'s shape.
 */
export async function extractGmailSource(
  input: ExtractGmailSourceInput,
  transport: GmailSourceTransport,
): Promise<Result<RegisterSourceInput, GmailSourceError>> {
  // Defend the boundary TOTALLY (§16 — nothing throws across this seam): the WHOLE
  // transport call + mapping runs under one try. The real (deferred) transport is
  // UNTRUSTED — it can throw OR resolve `ok` with a pathological shape (a null/
  // non-string bodyText, a null message, a hostile getter) — and every such fault
  // becomes a typed err, never an uncaught throw (Lesson 11).
  try {
    const result = await transport({ messageId: input.messageId });

    if (!result.ok) {
      return err({ code: result.code, message: result.message });
    }

    const { message } = result;

    // Fail-closed on an empty / whitespace-only / MALFORMED body — never emit a
    // contentless candidate (safety rules 2/6). This is defense-in-depth matching
    // podcast-source.ts / youtube-source.ts.
    if (typeof message?.bodyText !== "string" || message.bodyText.trim().length === 0) {
      return err({ code: "empty_content", message: "gmail extraction returned an empty or malformed body" });
    }

    // The stable message locator — becomes the SourceEnvelope `origin`.
    const origin = `gmail://message/${message.messageId}`;

    // Dedupe key over the WORKSPACE-SCOPED content (type + workspace + origin +
    // body) — the same capture-source.ts:148 shape, so identical content in two
    // different workspaces never false-dedupes. Deterministic + replay-stable
    // (payloadHash is key-sorted SHA-256).
    const contentHash = payloadHash({
      type: "gmail_message",
      workspaceId: input.workspaceId,
      origin,
      bodyText: message.bodyText,
    });

    // Routing hints carry ONLY what is IN the fetched message (metadata) — used by
    // the ingestion router for correlation. No invented workspace/owner/date;
    // absent optional metadata is OMITTED, never fabricated.
    //
    // ING-7 (safety rule 6): mail is UNTRUSTED external content — trustLevel is
    // "untrusted" UNCONDITIONALLY, with no branch that can ever set "trusted", so
    // the downstream extraction agent is tool-stripped to read-only.
    const routingHints: Record<string, unknown> = {
      subject: message.subject,
      from: message.from,
      ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
      ...(message.receivedAt !== undefined ? { receivedAt: message.receivedAt } : {}),
      trustLevel: "untrusted",
    };

    // The candidate — passed through the gate next. Scoped fields come from the
    // caller's policy verbatim (no inference); the type is the open source-taxonomy
    // value `gmail_message`; the origin is the guaranteed message locator.
    const candidate: RegisterSourceInput = {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      origin,
      contentHash,
      type: "gmail_message",
      sensitivity: input.sensitivity,
      routingHints,
    };

    return ok(candidate);
  } catch (e) {
    return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
  }
}
