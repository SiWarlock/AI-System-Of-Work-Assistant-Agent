// @sow/integrations — Telegram capture read connector + its real read-only HTTP transport (slice 6.3 · §21.3).
//
// Read-only inbound-message capture (the ingest side of the Telegram channel; the approval/notify WRITE side is
// the Tool Gateway `telegram` target, a SEPARATE path — untouched). Auth is scoped to the least-privilege READ
// scope `messages:read` — never a send/write scope. The injected `ConnectorTransport` performs the fetch; no
// real network / clock here. Fail-closed behavior from the shared base (§16). Captured message content is
// candidate data — redacted downstream.
//
// `createTelegramCaptureHttpTransport` specializes the reusable `createConnectorHttpTransport` template with the
// Telegram Bot API `getUpdates` wire shape. ⚠ Unlike the Bearer-header connectors, the Telegram token rides the
// URL PATH (`/bot<token>/getUpdates`) — the template's `pathAuth` mode injects it into the path (validated
// against a safe-path allowlist, never logged, rule 7). DORMANT: the real HttpTransport + Telegram token stay
// UNBOUND (a fake in tests); binding a real transport is the owner's §ARM-23 arming crossing (HARD LINE).
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { makeConnector } from "./base";
import {
  createConnectorHttpTransport,
  transportFailure,
  type ConnectorHttpSpec,
  type ConnectorHttpTransportDeps,
} from "./http-transport";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport, ConnectorTransportResult, TransportItem, TransportRequest } from "../transport";
import { payloadHash } from "../../hash/payload-hash";
import type { TelegramCapture } from "./capture-source";

/** Build the Telegram capture read connector over an injected transport. */
export function createTelegramCaptureConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "telegram-capture", readScope: "messages:read" }, transport);
}

// ── Telegram Bot API getUpdates read-only transport (candidate wire shape — arch_gap, Lesson 21) ─────────────
// CONTEXT7-GROUNDED (`/websites/core_telegram_bots_api` — `getUpdates`): a DOCUMENTED CANDIDATE, re-confirmed at
// the owner arming binding. `GET https://api.telegram.org/bot<TOKEN>/getUpdates?offset=&limit=` (token IN PATH,
// no Bearer header — the template's `pathAuth` mode); envelope:
//   { ok: true, result: Update[] },  Update = { update_id: number, message?: {…}, … }
// Offset long-poll: the client advances `offset = max(update_id) + 1` until an empty batch (Telegram returns NO
// `next_cursor`). Parsed FAIL-CLOSED: `ok !== true` / missing `result` / a non-number `update_id` ⇒ a
// `TransportFailure`, never a false page. Updates are emitted TYPE-AGNOSTIC (one item per Update, raw preserved)
// — the connector never interprets/filters; the downstream extraction filters by type (emit-only, rule 1).
const TELEGRAM_BASE_URL = "https://api.telegram.org";
const TELEGRAM_ALLOWED_HOSTS: readonly string[] = ["api.telegram.org"];
const TELEGRAM_RESOURCE_PATH = "/bot{token}/getUpdates"; // pathAuth: `{token}` substituted by the template
const TELEGRAM_PAGE_LIMIT = 100; // Context7: limit 1..100.

/**
 * Cursor→query: `?limit=<n>` on the first poll, `&offset=<cursor>` when resuming (the client-computed
 * `max(update_id)+1`). The cursor is percent-encoded so a tampered / persisted cursor can never inject a query
 * param or smuggle an authority (defense-in-depth — the template also SSRF-guards the final url).
 */
function telegramBuildQuery(request: TransportRequest): string {
  const base = `?limit=${TELEGRAM_PAGE_LIMIT}`;
  return request.cursor !== undefined ? `${base}&offset=${encodeURIComponent(request.cursor)}` : base;
}

/** Map the candidate `getUpdates` envelope → a `TransportPage`, fail-closed on any malformed / renamed field. */
function telegramMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "telegram: response is not an envelope object");
  }
  if ((json as { ok?: unknown }).ok !== true) {
    return transportFailure("unknown", "telegram: envelope ok is not true");
  }
  const result = (json as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    return transportFailure("unknown", "telegram: missing result[]");
  }
  const items: TransportItem[] = [];
  let maxUpdateId = -1;
  for (const entry of result) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "telegram: malformed update entry");
    }
    const updateId = (entry as { update_id?: unknown }).update_id;
    if (typeof updateId !== "number" || !Number.isFinite(updateId)) {
      return transportFailure("unknown", "telegram: update missing update_id");
    }
    if (updateId > maxUpdateId) maxUpdateId = updateId;
    // The change token IS update_id (unique + monotonic per bot; an edit is a distinct update_id).
    items.push({ id: String(updateId), hash: payloadHash({ update_id: updateId }), raw: entry });
  }
  // Telegram returns no `next_cursor`: advance `offset = max(update_id)+1` until an empty batch ⇒ done.
  if (items.length === 0) {
    return { ok: true, items: [], done: true };
  }
  return { ok: true, items, done: false, nextCursor: String(maxUpdateId + 1) };
}

/** The Telegram connector-HTTP spec (candidate wire shape — arch_gap). Token-in-PATH via `pathAuth`. */
const TELEGRAM_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: TELEGRAM_BASE_URL,
  allowedHosts: TELEGRAM_ALLOWED_HOSTS,
  resourcePath: TELEGRAM_RESOURCE_PATH,
  buildQuery: telegramBuildQuery,
  mapPage: telegramMapPage,
  pathAuth: true,
};

/**
 * Build the Telegram capture read-only HTTP transport. DORMANT — the real HttpTransport + Telegram token
 * SecretsAccessor stay UNBOUND (a fake in tests); binding a real transport is the owner's §ARM-23 arming
 * crossing (HARD LINE).
 */
export function createTelegramCaptureHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(TELEGRAM_HTTP_SPEC, deps);
}

// ── Update → TelegramCapture RECEIVER (23.6 — the Telegram CapturePayload producer) ────────────
//
// The connector above emits every fetched Update TYPE-AGNOSTIC (its own header comment: "the
// downstream extraction filters by type") — `buildTelegramCapture` IS that downstream extraction.
// It maps ONE raw Telegram `getUpdates` Update (a `TransportItem.raw`, UNVALIDATED wire content,
// Context7-grounded `/websites/core_telegram_bots_api` Update/Message shape — arch_gap) into a
// `TelegramCapture`, the shape `capture-source.ts`'s `buildCaptureSource` consumes (sender
// allowlist + untrusted trustLevel, ING-7). PURE (no I/O), TOTAL (never throws, §16), fail-closed
// on anything not a capturable, well-formed inbound message. DORMANT: no production caller.

/** The CLOSED Telegram receiver failure set (§16 — enumerable). */
export interface TelegramReceiveError {
  readonly code: "not_a_message" | "malformed" | "anonymous_sender" | "unsupported_kind";
  readonly message: string;
}

type TelegramMessageKind = TelegramCapture["messageKind"];

/**
 * Extract a URL from a message's `entities` (Context7 `MessageEntity`): a `text_link` entity's
 * own `url` field is used verbatim; a `url` entity slices `[offset, offset+length)` out of the
 * message text. Returns the FIRST recognized link entity, or undefined if none matches.
 */
function extractLinkFromEntities(text: string, entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  for (const entity of entities) {
    if (typeof entity !== "object" || entity === null) continue;
    const type = (entity as { type?: unknown }).type;
    if (type === "text_link") {
      const url = (entity as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) return url;
    }
    if (type === "url") {
      const offset = (entity as { offset?: unknown }).offset;
      const length = (entity as { length?: unknown }).length;
      if (typeof offset === "number" && typeof length === "number" && offset >= 0 && length > 0) {
        const extracted = text.slice(offset, offset + length);
        if (extracted.length > 0) return extracted;
      }
    }
  }
  return undefined;
}

/**
 * Pick the LARGEST photo size by `width*height` (never array position — Telegram documents
 * ascending order, but a hostile/reordered array must not silently pick the wrong file_id).
 */
function largestPhotoFileId(photo: readonly unknown[]): string | undefined {
  let bestFileId: string | undefined;
  let bestArea = -1;
  for (const size of photo) {
    if (typeof size !== "object" || size === null) continue;
    const fileId = (size as { file_id?: unknown }).file_id;
    if (typeof fileId !== "string" || fileId.length === 0) continue;
    const width = (size as { width?: unknown }).width;
    const height = (size as { height?: unknown }).height;
    const area = typeof width === "number" && typeof height === "number" ? width * height : 0;
    if (area >= bestArea) {
      bestArea = area;
      bestFileId = fileId;
    }
  }
  return bestFileId;
}

/**
 * Classify ONE well-formed Message body into a `(messageKind, content)` pair. Order is fixed +
 * documented (never re-derived per call): text/link, then voice, then photo, then document
 * (pdf) — a message carrying more than one kind (never expected from a real client) picks the
 * first. Returns `undefined` messageKind when nothing supported is present.
 */
function classifyTelegramMessage(
  message: Record<string, unknown>,
): { readonly messageKind: TelegramMessageKind; readonly content: string } | undefined {
  const text = message["text"];
  if (typeof text === "string" && text.trim().length > 0) {
    const link = extractLinkFromEntities(text, message["entities"]);
    if (link !== undefined) return { messageKind: "link", content: link };
    return { messageKind: "text", content: text };
  }

  const voice = message["voice"];
  if (typeof voice === "object" && voice !== null) {
    const fileId = (voice as { file_id?: unknown }).file_id;
    if (typeof fileId === "string" && fileId.length > 0) return { messageKind: "voice", content: fileId };
  }

  const caption = message["caption"];
  const hasCaption = typeof caption === "string" && caption.trim().length > 0;

  const photo = message["photo"];
  if (Array.isArray(photo) && photo.length > 0) {
    if (hasCaption) return { messageKind: "photo", content: caption as string };
    const fileId = largestPhotoFileId(photo);
    if (fileId !== undefined) return { messageKind: "photo", content: fileId };
  }

  const document = message["document"];
  if (typeof document === "object" && document !== null) {
    if (hasCaption) return { messageKind: "pdf", content: caption as string };
    const fileName = (document as { file_name?: unknown }).file_name;
    if (typeof fileName === "string" && fileName.length > 0) return { messageKind: "pdf", content: fileName };
    const fileId = (document as { file_id?: unknown }).file_id;
    if (typeof fileId === "string" && fileId.length > 0) return { messageKind: "pdf", content: fileId };
  }

  return undefined;
}

/**
 * Map a raw Telegram `getUpdates` Update → a `TelegramCapture`. Fails closed on: a non-object
 * raw value; an update carrying no fresh inbound `message` (an `edited_message`/`channel_post`/…
 * is not capturable — `not_a_message`); a missing/malformed `chat.id` (`malformed`); a missing
 * verifiable `from.id` (an anonymous/channel post can never clear the sender allowlist —
 * `anonymous_sender`); and a message carrying none of the supported content kinds
 * (`unsupported_kind`). Sender identity is the numeric Telegram user id (`from.id`), never the
 * possibly-absent/mutable `username`. Never throws (§16); pure (no I/O).
 */
export function buildTelegramCapture(raw: unknown): Result<TelegramCapture, TelegramReceiveError> {
  if (typeof raw !== "object" || raw === null) {
    return err({ code: "malformed", message: "telegram update is not an object" });
  }

  const message = (raw as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return err({ code: "not_a_message", message: "telegram update carries no fresh inbound message" });
  }
  const msg = message as Record<string, unknown>;

  const chat = msg["chat"];
  const chatId = typeof chat === "object" && chat !== null ? (chat as { id?: unknown }).id : undefined;
  if (typeof chatId !== "number" && typeof chatId !== "string") {
    return err({ code: "malformed", message: "telegram message has no chat id" });
  }

  const from = msg["from"];
  const senderId = typeof from === "object" && from !== null ? (from as { id?: unknown }).id : undefined;
  if (typeof senderId !== "number" && typeof senderId !== "string") {
    return err({ code: "anonymous_sender", message: "telegram message has no verifiable sender id" });
  }

  const classified = classifyTelegramMessage(msg);
  if (classified === undefined) {
    return err({ code: "unsupported_kind", message: "telegram message carries no supported content" });
  }

  return ok({
    kind: "telegram",
    chatId: String(chatId),
    sender: String(senderId),
    messageKind: classified.messageKind,
    content: classified.content,
  });
}
