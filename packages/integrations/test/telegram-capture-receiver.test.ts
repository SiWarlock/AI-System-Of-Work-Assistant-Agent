// @sow/integrations — 23.6: the Telegram capture RECEIVER — maps a raw Telegram
// `getUpdates` Update (the connector's emit-only `TransportItem.raw`, Context7
// `/websites/core_telegram_bots_api`) into a `TelegramCapture`, the shape
// `capture-source.ts`'s `buildCaptureSource` consumes to build a CANDIDATE
// `RegisterSourceInput`.
//
// PREMISE: the getUpdates long-poll CONNECTOR (createTelegramCaptureConnector +
// createTelegramCaptureHttpTransport, task 21.3) already exists — this file
// tests ONLY the missing piece: interpreting the connector's raw, type-agnostic
// Update payload into the capture shape (chatId/sender/messageKind/content) the
// telegram-capture.ts header comment names as "the downstream extraction
// [that] filters by type." Everything here is PURE (no I/O) and dormant — no
// bot token, no live poll, zero production callers.
import { describe, it, expect } from "vitest";
import { buildTelegramCapture, type TelegramReceiveError } from "../src/connectors/adapters/telegram-capture";
import {
  buildCaptureSource,
  type CaptureDeps,
} from "../src/connectors/adapters/capture-source";
import { registerSource, type RegisterSourceDeps } from "../src/connectors/source-register";

const neverSeen: RegisterSourceDeps["seenContentHash"] = async () => false;
const allowSender: CaptureDeps["isAllowedTelegramSender"] = (s) => s === "42";
const denySender: CaptureDeps["isAllowedTelegramSender"] = () => false;

/** A well-formed inbound text-message Update. */
function textUpdate(overrides: Partial<{ chatId: number; senderId: number; text: string }> = {}): unknown {
  return {
    update_id: 100,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: overrides.chatId ?? 555, type: "private" },
      from: { id: overrides.senderId ?? 42, is_bot: false, first_name: "Owner" },
      text: overrides.text ?? "remember to check the retrieval eval before shipping",
    },
  };
}

describe("23.6 — buildTelegramCapture (pure receiver, no clock/fs/network)", () => {
  it("1. a well-formed text message yields a telegram capture: chatId/sender stringified, messageKind text, content=text", () => {
    const res = buildTelegramCapture(textUpdate());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe("telegram");
    expect(res.value.chatId).toBe("555");
    expect(res.value.sender).toBe("42");
    expect(res.value.messageKind).toBe("text");
    expect(res.value.content).toBe("remember to check the retrieval eval before shipping");
  });

  it("2. a message with a `url`-type entity is classified as a LINK, content = the extracted URL substring", () => {
    const text = "see https://example.com/notes for context";
    const url = "https://example.com/notes";
    const offset = text.indexOf(url);
    const raw = textUpdate({ text });
    (raw as { message: Record<string, unknown> }).message["entities"] = [
      { type: "url", offset, length: url.length },
    ];
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("link");
    expect(res.value.content).toBe(url);
  });

  it("2b. a `text_link` entity's own `url` field is used verbatim (no offset/length slicing needed)", () => {
    const raw = textUpdate({ text: "click here for the doc" });
    (raw as { message: Record<string, unknown> }).message["entities"] = [
      { type: "text_link", offset: 0, length: 5, url: "https://example.com/doc" },
    ];
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("link");
    expect(res.value.content).toBe("https://example.com/doc");
  });

  it("3. a voice message yields messageKind voice, content = the voice file_id", () => {
    const raw = {
      update_id: 101,
      message: {
        message_id: 2,
        date: 1_700_000_001,
        chat: { id: 555, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        voice: { file_id: "AwADBAADbXXXXXX", file_unique_id: "u1", duration: 12 },
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("voice");
    expect(res.value.content).toBe("AwADBAADbXXXXXX");
  });

  it("4a. a photo message with NO caption yields messageKind photo, content = the LARGEST size's file_id (by area, not array position)", () => {
    const raw = {
      update_id: 102,
      message: {
        message_id: 3,
        date: 1_700_000_002,
        chat: { id: 555, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        // deliberately OUT OF ORDER — the largest (by width*height) is first,
        // not last, proving the classifier picks by AREA not array position.
        photo: [
          { file_id: "big", file_unique_id: "b", width: 1200, height: 1200 },
          { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
        ],
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("photo");
    expect(res.value.content).toBe("big");
  });

  it("4b. a photo message WITH a caption prefers the caption as content over the file_id", () => {
    const raw = {
      update_id: 103,
      message: {
        message_id: 4,
        date: 1_700_000_003,
        chat: { id: 555, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        photo: [{ file_id: "p1", file_unique_id: "u", width: 800, height: 600 }],
        caption: "whiteboard sketch from the design review",
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("photo");
    expect(res.value.content).toBe("whiteboard sketch from the design review");
  });

  it("5a. a document message yields messageKind pdf; content prefers caption, then filename, then file_id", () => {
    const base = {
      update_id: 104,
      message: {
        message_id: 5,
        date: 1_700_000_004,
        chat: { id: 555, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        document: { file_id: "doc1", file_unique_id: "u", file_name: "spec.pdf" },
      },
    };
    const res = buildTelegramCapture(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageKind).toBe("pdf");
    expect(res.value.content).toBe("spec.pdf"); // no caption -> filename

    const withCaption = { ...base, message: { ...base.message, caption: "the finalized spec" } };
    const res2 = buildTelegramCapture(withCaption);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.value.content).toBe("the finalized spec"); // caption wins over filename
  });

  it("5b. a document with neither caption nor file_name falls back to the file_id", () => {
    const raw = {
      update_id: 105,
      message: {
        message_id: 6,
        date: 1_700_000_005,
        chat: { id: 555, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        document: { file_id: "doc-bare", file_unique_id: "u" },
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.content).toBe("doc-bare");
  });

  it("6. an update carrying NO message (e.g. only edited_message) fails closed as not_a_message", () => {
    const res = buildTelegramCapture({ update_id: 200, edited_message: { text: "edited" } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as TelegramReceiveError).code).toBe("not_a_message");
  });

  it("7a. a message with no chat object fails closed as malformed", () => {
    const raw = { update_id: 201, message: { message_id: 1, from: { id: 42 }, text: "hi" } };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("malformed");
  });

  it("7b. a message with a non-numeric/non-string chat.id fails closed as malformed", () => {
    const raw = { update_id: 202, message: { message_id: 1, chat: { id: null }, from: { id: 42 }, text: "hi" } };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("malformed");
  });

  it("8. a message with no verifiable sender (e.g. an anonymous channel post) fails closed as anonymous_sender", () => {
    const raw = { update_id: 203, message: { message_id: 1, chat: { id: 555 }, text: "hi" } };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("anonymous_sender");
  });

  it("9. a message carrying none of the supported content kinds (e.g. only a sticker) fails closed as unsupported_kind", () => {
    const raw = {
      update_id: 204,
      message: {
        message_id: 1,
        chat: { id: 555 },
        from: { id: 42 },
        sticker: { file_id: "sticker1" },
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unsupported_kind");
  });

  it("10a. NEVER THROWS on hostile/garbage raw input (null, array, primitives)", () => {
    for (const hostile of [null, undefined, 42, "x", [], true]) {
      expect(() => buildTelegramCapture(hostile)).not.toThrow();
      expect(buildTelegramCapture(hostile).ok).toBe(false);
    }
  });

  it("10b. a message whose text is whitespace-only is not treated as text (falls through to unsupported_kind)", () => {
    const raw = textUpdate({ text: "   " });
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unsupported_kind");
  });

  it("11. sender identity is derived from from.id (a stable numeric id), never from a possibly-absent username", () => {
    // `from` has no `username` at all — sender must still resolve via `id`.
    const raw = {
      update_id: 300,
      message: {
        message_id: 1,
        chat: { id: 555 },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "no username on this account",
      },
    };
    const res = buildTelegramCapture(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sender).toBe("42");
  });
});

describe("23.6 end-to-end — the REAL receiver + the REAL sender-allowlist gate through the unchanged capture-source spine", () => {
  it("an allowlisted sender's text message clears buildCaptureSource + registerSource end-to-end (untrusted, ING-7)", async () => {
    const built = buildTelegramCapture(textUpdate());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const deps: CaptureDeps = { isAllowedTelegramSender: allowSender, verifyCodingSessionOrigin: () => true };
    const source = buildCaptureSource(
      { sourceId: "tg:1", workspaceId: "personal-life", sensitivity: "normal", capture: built.value },
      deps,
    );
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.routingHints).toMatchObject({ trigger: "telegram", trustLevel: "untrusted" });

    const reg = await registerSource(source.value, { seenContentHash: neverSeen });
    expect(reg.outcome).toBe("registered");
  });

  it("a NON-allowlisted sender's real Update FAILS CLOSED at the sender-allowlist gate — the receiver alone cannot bypass it", () => {
    const built = buildTelegramCapture(textUpdate({ senderId: 999 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const deps: CaptureDeps = { isAllowedTelegramSender: denySender, verifyCodingSessionOrigin: () => true };
    const source = buildCaptureSource(
      { sourceId: "tg:2", workspaceId: "personal-life", sensitivity: "normal", capture: built.value },
      deps,
    );
    expect(source.ok).toBe(false);
    if (source.ok) return;
    expect(source.error.code).toBe("sender_not_allowed");
  });
});
