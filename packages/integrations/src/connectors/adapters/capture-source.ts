// @sow/integrations — "capture as I work" source adapter (Phase-13 §13.6 PROTOTYPE, G4).
//
// The governed reimplementation of osb's bg-agent / telegram-journal CAPABILITY —
// discarding their mechanism (unattended skip-permissions cloud writers). ONE
// adapter, TWO triggers folded onto the same certified spine:
//
//   • coding_session (git-driven)  → trustLevel 'trusted'   — deterministic; a
//     downstream capture may auto-apply (§13.8 confined-auto tier).
//   • telegram_capture (mobile)    → trustLevel 'untrusted' — inbound, possibly
//     from a forwarded/malicious source: the DOWNSTREAM extraction agent MUST run
//     read-only (ING-7); and the bot is an always-on attack surface, so the SENDER
//     is allowlisted here (fail-closed on an unknown sender).
//
// EMIT-ONLY (safety rule 1): maps a capture → a CANDIDATE `RegisterSourceInput`;
// NEVER writes. NO INFERENCE (REQ-F-017): workspaceId/sensitivity are passed
// through from policy, never invented. PURE + TOTAL (§16): no clock/randomness/IO,
// never throws — a bad capture is a typed `Result` err. The next hop is the real
// `registerSource()` gate, then (downstream) KnowledgeWriter, the sole writer.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { payloadHash } from "../../hash/payload-hash";
import type { RegisterSourceInput } from "../source-register";

/** A git-derived capture — a coding session's summary + repo (+ optional commit). */
export interface CodingSessionCapture {
  readonly kind: "coding_session";
  readonly repo: string;
  readonly sessionSummary: string;
  readonly commit?: string;
}

/** A telegram mobile capture — inbound, UNTRUSTED, sender-checked. */
export interface TelegramCapture {
  readonly kind: "telegram";
  readonly chatId: string;
  readonly sender: string;
  readonly messageKind: "voice" | "text" | "photo" | "pdf" | "link";
  readonly content: string;
}

/** The captured payload (discriminated on `kind`). */
export type CapturePayload = CodingSessionCapture | TelegramCapture;

/**
 * Caller-supplied policy fields + the capture. `workspaceId`/`sensitivity` come
 * from the ingestion policy (scoped-before-durable) — never inferred from content.
 */
export interface BuildCaptureInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly sensitivity: string;
  readonly capture: CapturePayload;
}

/**
 * Injected admission deps. `isAllowedTelegramSender` is the bot's sender allowlist
 * (only YOUR telegram id may capture) — consulted ONLY for the telegram trigger.
 */
export interface CaptureDeps {
  readonly isAllowedTelegramSender: (sender: string) => boolean;
}

/** The CLOSED capture-build failure set (§16 — enumerable). */
export interface CaptureError {
  readonly code: "sender_not_allowed" | "empty_content" | "unknown";
  readonly message: string;
}

function fail(code: CaptureError["code"], message: string): Result<RegisterSourceInput, CaptureError> {
  return err({ code, message });
}

/**
 * Build a CANDIDATE `RegisterSourceInput` from a capture — emit-only, pure, never
 * throws. Telegram captures are sender-allowlisted (fail-closed) and marked
 * `untrusted` so downstream extraction runs read-only (ING-7); git captures are
 * `trusted`. The `contentHash` is a deterministic, workspace-scoped Flow-4 dedupe
 * key over the capture content.
 */
export function buildCaptureSource(
  input: BuildCaptureInput,
  deps: CaptureDeps,
): Result<RegisterSourceInput, CaptureError> {
  const cap = input.capture;

  // Resolve the per-trigger shape: type, origin, trust, routing hints, content.
  let type: string;
  let origin: string;
  let content: string;
  let routingHints: Record<string, unknown>;

  if (cap.kind === "coding_session") {
    type = "coding_session";
    origin = cap.repo;
    content = cap.sessionSummary;
    routingHints = {
      trigger: "git",
      trustLevel: "trusted",
      repo: cap.repo,
      ...(cap.commit !== undefined ? { commit: cap.commit } : {}),
    };
  } else {
    // Telegram: FAIL CLOSED on an unknown sender BEFORE building anything (the
    // always-on bot is an attack surface — only allowlisted senders may capture).
    if (!deps.isAllowedTelegramSender(cap.sender)) {
      return fail("sender_not_allowed", `telegram sender '${cap.sender}' is not on the capture allowlist`);
    }
    type = "telegram_capture";
    origin = `telegram://${cap.chatId}`;
    content = cap.content;
    routingHints = {
      trigger: "telegram",
      // UNTRUSTED inbound → the router sets AgentJob.trustLevel so downstream
      // extraction runs read-only (ING-7). The write path is never reached from
      // untrusted content directly.
      trustLevel: "untrusted",
      sender: cap.sender,
      messageKind: cap.messageKind,
    };
  }

  // No hollow sources: empty/whitespace content is a fail-closed rejection, not a
  // guessed placeholder (no inference).
  if (content.trim().length === 0) {
    return fail("empty_content", `${type} capture has no content`);
  }

  // Deterministic, replay-stable, WORKSPACE-SCOPED dedupe key (same content in two
  // workspaces is not a false dedupe). payloadHash is key-sorted SHA-256.
  const contentHash = payloadHash({ type, workspaceId: input.workspaceId, origin, content });

  const candidate: RegisterSourceInput = {
    sourceId: input.sourceId,
    workspaceId: input.workspaceId,
    origin,
    contentHash,
    type,
    sensitivity: input.sensitivity,
    routingHints,
  };

  return ok(candidate);
}
