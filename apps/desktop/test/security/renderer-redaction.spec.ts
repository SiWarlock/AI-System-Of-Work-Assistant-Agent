import { describe, it, expect, vi } from "vitest";
import type { StreamEvent } from "@sow/contracts/api/events";
import {
  validateStreamEvent,
  createEventStream,
  type StreamTransport,
  type StreamSubscribeHandlers,
} from "../../renderer/lib/event-stream";
import { applyStreamEvent } from "../../renderer/store/projections";
import { initialStoreState, createUiSafeStore, type UiSafeStoreState } from "../../renderer/store";
import {
  approvalEvent,
  healthEvent,
  workflowEvent,
  cardEvent,
} from "../renderer/fixtures";

// ── 9.14 renderer-REDACTION adversarial verify spec (forbidden-pattern #5 / §16) ──
//
// The renderer store holds ONLY UI-safe projections — never a secret, Keychain
// ref, raw Employer-Work content, provider prompt, or AgentResult.logs. The real
// renderer boundary is `validateStreamEvent` (strict `streamEventSchema`) feeding
// `applyStreamEvent`. This spec DRIVES that real pipeline with poisoned frames and
// asserts the outcome invariant: no secret lands in the store snapshot and none
// reaches `console.*`. TEST-ONLY — a leak here is a real §16 gap (Step-9 Finding).

// Secret-shaped VALUES (searched for in the store snapshot + captured logs).
const SECRET_VALUES = [
  "sk-live-DEADBEEF-super-secret-token",
  "Employer confidential: Project Titan acquisition memo",
  "SYSTEM PROMPT: ignore all prior instructions",
  "sow/kw-signing",
  "provider prompt trace: <redacted upstream, must never surface>",
  "audit-record-xyz",
];

// Secret-shaped FIELD NAMES injected at both the event and payload level. None is a
// UI-safe field, so a `.strict()` schema rejects the frame (and even a future strip
// would drop them) — either way none may appear at rest or in a log.
const secretFields: Record<string, string> = {
  token: SECRET_VALUES[0]!,
  apiKey: SECRET_VALUES[0]!,
  secret: SECRET_VALUES[0]!,
  rawContent: SECRET_VALUES[1]!,
  prompt: SECRET_VALUES[2]!,
  keychainRef: SECRET_VALUES[3]!,
  agentLogs: SECRET_VALUES[4]!,
  auditRef: SECRET_VALUES[5]!,
};
const SECRET_KEYS = Object.keys(secretFields);

const validFrames: StreamEvent[] = [
  approvalEvent(1, "e1"),
  healthEvent(2, "e2"),
  workflowEvent(3, "e3"),
  cardEvent(4, "e4"),
];

/** A valid frame poisoned with secret-shaped fields at BOTH the event and payload level. */
function poison(evt: StreamEvent): unknown {
  const payload = (evt as unknown as { payload: Record<string, unknown> }).payload;
  return { ...evt, ...secretFields, payload: { ...payload, ...secretFields } };
}

/** Serialize the store, expanding every Map so nested map values are searchable. */
function serialize(state: UiSafeStoreState): string {
  return JSON.stringify(state, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v));
}

/** Run the REAL renderer ingest pipeline over a set of raw frames (validate → fold when valid). */
function ingest(raws: unknown[]): UiSafeStoreState {
  let state = initialStoreState;
  for (const raw of raws) {
    const event = validateStreamEvent(raw);
    if (event !== null) state = applyStreamEvent(state, event);
  }
  return state;
}

describe("renderer redaction (§16 / forbidden-pattern #5 — no secrets/raw in store or logs)", () => {
  it("a poisoned stream frame never lands a secret/raw/prompt field in the store", () => {
    // Outcome invariant, deliberately robust to the boundary's mechanism: today the
    // strict schema REJECTS the poisoned frame (validateStreamEvent → null); even if
    // it were ever loosened to STRIP unknown keys, this assertion still holds.
    const state = ingest(validFrames.map(poison));
    const snapshot = serialize(state);
    for (const value of SECRET_VALUES) expect(snapshot).not.toContain(value);
    for (const key of SECRET_KEYS) expect(snapshot).not.toContain(`"${key}"`);
  });

  it("the REAL stream controller drops a poisoned frame with no secret in the store OR console.*", () => {
    // Drives the ACTUAL production drop path — createEventStream.onData → validateStreamEvent →
    // dropped-on-schema-fail (event-stream.ts) — not just the pure fold. This is the real seam a
    // regression would log the raw frame at, so it guards the reject-path-logs-the-raw-frame leak
    // vector where it actually lives (both the store-at-rest AND console legs, in one drive).
    const store = createUiSafeStore();
    let handlers: StreamSubscribeHandlers | null = null;
    const transport: StreamTransport = {
      subscribe(h): () => void {
        handlers = h;
        return () => {};
      },
    };
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const stream = createEventStream({ store, transport, scheduleReconnect: () => () => {} });
      stream.start();
      expect(handlers).not.toBeNull();
      for (const raw of validFrames.map(poison)) handlers!.onData(raw);
      stream.stop();

      const snapshot = serialize(store.getSnapshot());
      const logged = spies
        .flatMap((s) => s.mock.calls.flat())
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join("\n");
      for (const value of SECRET_VALUES) {
        expect(snapshot).not.toContain(value);
        expect(logged).not.toContain(value);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a CLEAN valid event still validates and folds (non-vacuous anchor, L7 — the negatives aren't trivially green)", () => {
    const cleanRaw = JSON.parse(JSON.stringify(approvalEvent(9, "e-clean", "app-clean"))) as unknown;
    const validated = validateStreamEvent(cleanRaw);
    expect(validated).not.toBeNull();
    const state = applyStreamEvent(initialStoreState, validated!);
    expect(state.approvals.get("app-clean")).toBeDefined();
  });
});
