// Slice 6.1 — Connector Gateway core read engine (RED first).
//
// runConnectorSync(port, deps) drives ONE sync pass. Load-bearing invariants:
//   REQ-I-005 NO SILENT DROP — cursor advances ONLY after onRecords for that page
//     succeeds; a mid-stream failure NEVER advances past unprocessed records.
//   Transient ('unreachable'/'rate_limited') → bounded backoff; exhausted →
//     degraded + OBS-2 health signal (connector_unreachable). Never a silent fail.
//   'auth_locked' → degraded, reads HELD retryable, cursor unchanged.
//   Reconnect drain idempotent — a record whose contentHash was already seen
//     (seenContentHash) is not re-emitted.
//   Every diagnostic routes through foundation redaction — raw payload never logged.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, type Result } from "@sow/contracts";
import {
  runConnectorSync,
  type ConnectorSyncDeps,
  type ConnectorSyncResult,
} from "../src/connectors/gateway";
import type {
  ConnectorPort,
  ConnectorFetchPage,
  ConnectorRecord,
  ConnectorError,
} from "../src/connectors/port";
import type { SafeConnectorLog } from "../src/redaction/gateway-log-redaction";
import { InMemoryConnectorCursors } from "./support/fakes";

const CLOCK = (): string => "2026-07-01T00:00:00.000Z";
const CFG = { baseMs: 1, maxMs: 4, maxAttempts: 3 };
const WS = "employer-work";

const rec = (recordId: string, contentHash: string, payload: unknown = { raw: "x" }): ConnectorRecord => ({
  recordId,
  contentHash,
  payload,
});

// A scripted port that returns a queued sequence of fetch results, keyed by the
// cursor it is called with (undefined = first page).
function scriptedPort(
  connectorId: string,
  pages: Array<Result<ConnectorFetchPage, ConnectorError>>,
): ConnectorPort & { calls: Array<string | undefined> } {
  let i = 0;
  const calls: Array<string | undefined> = [];
  return {
    connectorId,
    calls,
    async fetch(cursor?: string): Promise<Result<ConnectorFetchPage, ConnectorError>> {
      calls.push(cursor);
      const page = pages[i] ?? err({ code: "unknown", message: "out of script" });
      i += 1;
      return page;
    },
  };
}

// A sink that collects safe logs.
function collectSink(): { logs: SafeConnectorLog[]; sink: (l: SafeConnectorLog) => void } {
  const logs: SafeConnectorLog[] = [];
  return { logs, sink: (l): void => void logs.push(l) };
}

function baseDeps(
  cursors: InMemoryConnectorCursors,
  onRecords: ConnectorSyncDeps["onRecords"],
  extra: Partial<ConnectorSyncDeps> = {},
): ConnectorSyncDeps {
  return {
    cursors,
    workspaceId: WS,
    onRecords,
    backoffCfg: CFG,
    clock: CLOCK,
    ...extra,
  };
}

describe("runConnectorSync — NO SILENT DROP on reads (REQ-I-005)", () => {
  it("does NOT advance the cursor past a page whose onRecords fails mid-stream", async () => {
    const cursors = new InMemoryConnectorCursors();
    const port = scriptedPort("todoist", [
      ok({ records: [rec("r1", "h1")], nextCursor: "cur-after-p1", done: false }),
      ok({ records: [rec("r2", "h2")], nextCursor: "cur-after-p2", done: false }),
    ]);
    // onRecords succeeds for page 1, FAILS for page 2.
    let call = 0;
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => {
      call += 1;
      return call === 1 ? ok(undefined) : err({ code: "downstream_rejected", message: "boom" });
    };

    const res = await runConnectorSync(port, baseDeps(cursors, onRecords));

    expect(res.status).toBe<ConnectorSyncResult["status"]>("held");
    // cursor is at the page-1 boundary, NOT advanced past page 2.
    const stored = await cursors.get("todoist", WS);
    expect(isOk(stored)).toBe(true);
    if (isOk(stored)) expect(stored.value.cursor).toBe("cur-after-p1");
    expect(res.cursor).toBe("cur-after-p1");
    // page 1's single record was processed; page 2's was not.
    expect(res.processed).toBe(1);
  });

  it("advances the cursor to the final page boundary when every page's onRecords succeeds", async () => {
    const cursors = new InMemoryConnectorCursors();
    const port = scriptedPort("todoist", [
      ok({ records: [rec("r1", "h1")], nextCursor: "c1", done: false }),
      ok({ records: [rec("r2", "h2")], nextCursor: "c2", done: true }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);

    const res = await runConnectorSync(port, baseDeps(cursors, onRecords));

    expect(res.status).toBe<ConnectorSyncResult["status"]>("advanced");
    expect(res.cursor).toBe("c2");
    expect(res.processed).toBe(2);
    const stored = await cursors.get("todoist", WS);
    if (isOk(stored)) expect(stored.value.cursor).toBe("c2");
  });

  it("starts from the persisted cursor and passes it to the first fetch", async () => {
    const cursors = new InMemoryConnectorCursors();
    await cursors.upsert({
      connectorId: "todoist",
      workspaceId: WS,
      cursor: "resume-here",
      status: "idle",
      updatedAt: CLOCK(),
    });
    const port = scriptedPort("todoist", [
      ok({ records: [], nextCursor: "resume-here", done: true }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);

    await runConnectorSync(port, baseDeps(cursors, onRecords));
    expect(port.calls[0]).toBe("resume-here");
  });
});

describe("runConnectorSync — transient errors + bounded backoff", () => {
  it("retries an 'unreachable' fetch with bounded backoff, then succeeds", async () => {
    const cursors = new InMemoryConnectorCursors();
    const port = scriptedPort("todoist", [
      err({ code: "unreachable", message: "net down" }),
      err({ code: "unreachable", message: "net down" }),
      ok({ records: [rec("r1", "h1")], nextCursor: "c1", done: true }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);

    const res = await runConnectorSync(port, baseDeps(cursors, onRecords));
    expect(res.status).toBe<ConnectorSyncResult["status"]>("advanced");
    expect(res.health).toBe("reachable");
    expect(res.processed).toBe(1);
    // fetched 3 times (2 failures + 1 success).
    expect(port.calls.length).toBe(3);
  });

  it("exhausts retries → degraded + emits OBS-2 health signal (connector_unreachable), cursor unchanged", async () => {
    const cursors = new InMemoryConnectorCursors();
    await cursors.upsert({
      connectorId: "todoist",
      workspaceId: WS,
      cursor: "before",
      status: "idle",
      updatedAt: CLOCK(),
    });
    const port = scriptedPort("todoist", [
      err({ code: "unreachable", message: "net down" }),
      err({ code: "unreachable", message: "net down" }),
      err({ code: "unreachable", message: "net down" }),
      err({ code: "unreachable", message: "net down" }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);
    const { logs, sink } = collectSink();

    const res = await runConnectorSync(
      port,
      baseDeps(cursors, onRecords, { logSink: sink }),
    );

    expect(res.status).toBe<ConnectorSyncResult["status"]>("degraded");
    expect(res.health).toBe("unreachable");
    expect(res.healthSignal?.failureClass).toBe("connector_unreachable");
    // cursor is untouched.
    const stored = await cursors.get("todoist", WS);
    if (isOk(stored)) expect(stored.value.cursor).toBe("before");
    // never a silent failure — a diagnostic was logged.
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("runConnectorSync — auth_locked held retryable", () => {
  it("holds reads (degraded), cursor unchanged, NOT dropped, on auth_locked", async () => {
    const cursors = new InMemoryConnectorCursors();
    await cursors.upsert({
      connectorId: "todoist",
      workspaceId: WS,
      cursor: "held-at",
      status: "idle",
      updatedAt: CLOCK(),
    });
    const port = scriptedPort("todoist", [
      err({ code: "auth_locked", message: "keychain locked" }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);

    const res = await runConnectorSync(port, baseDeps(cursors, onRecords));

    expect(res.status).toBe<ConnectorSyncResult["status"]>("held");
    expect(res.health).toBe("degraded");
    expect(res.processed).toBe(0);
    // auth_locked is NOT retried in-pass (Keychain won't unlock synchronously) —
    // a single fetch, held for a later pass.
    expect(port.calls.length).toBe(1);
    const stored = await cursors.get("todoist", WS);
    if (isOk(stored)) expect(stored.value.cursor).toBe("held-at");
  });
});

describe("runConnectorSync — reconnect drain dedupe", () => {
  it("does not re-emit a record whose contentHash was already seen", async () => {
    const cursors = new InMemoryConnectorCursors();
    const port = scriptedPort("todoist", [
      ok({ records: [rec("r1", "seen-hash"), rec("r2", "fresh-hash")], nextCursor: "c1", done: true }),
    ]);
    const emitted: string[] = [];
    const onRecords: ConnectorSyncDeps["onRecords"] = async (records) => {
      for (const r of records) emitted.push(r.contentHash);
      return ok(undefined);
    };
    const seenContentHash = async (h: string): Promise<boolean> => h === "seen-hash";

    const res = await runConnectorSync(
      port,
      baseDeps(cursors, onRecords, { seenContentHash }),
    );

    // only the fresh record is emitted; the already-seen one is deduped.
    expect(emitted).toEqual(["fresh-hash"]);
    expect(res.processed).toBe(1);
    expect(res.status).toBe<ConnectorSyncResult["status"]>("advanced");
  });
});

describe("runConnectorSync — redaction (§16, safety rule 5)", () => {
  it("never puts a raw record payload into an emitted safe log", async () => {
    const cursors = new InMemoryConnectorCursors();
    const SECRET = "sk-live-0123456789abcdefSECRET";
    const port = scriptedPort("todoist", [
      err({ code: "unreachable", message: `fetch failed carrying ${SECRET}` }),
      err({ code: "unreachable", message: `fetch failed carrying ${SECRET}` }),
      err({ code: "unreachable", message: `fetch failed carrying ${SECRET}` }),
      err({ code: "unreachable", message: `fetch failed carrying ${SECRET}` }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () => ok(undefined);
    const { logs, sink } = collectSink();

    await runConnectorSync(port, baseDeps(cursors, onRecords, { logSink: sink }));

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SECRET);
    // and no raw content field leaked structurally.
    for (const l of logs) {
      expect(l).not.toHaveProperty("rawContent");
      expect(l).not.toHaveProperty("payload");
    }
  });

  it("propagates a fatal onRecords failure as held without throwing", async () => {
    const cursors = new InMemoryConnectorCursors();
    const port = scriptedPort("todoist", [
      ok({ records: [rec("r1", "h1")], nextCursor: "c1", done: true }),
    ]);
    const onRecords: ConnectorSyncDeps["onRecords"] = async () =>
      err({ code: "downstream_rejected", message: "sink refused" });

    const res = await runConnectorSync(port, baseDeps(cursors, onRecords));
    expect(isErr).toBeTypeOf("function"); // sanity — helper is imported
    expect(res.status).toBe<ConnectorSyncResult["status"]>("held");
    expect(res.processed).toBe(0);
  });
});
