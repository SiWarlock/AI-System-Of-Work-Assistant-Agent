// spec(§8, §9, REQ-I-004 / NLM-2) — task 7.16 NotebookLM Managed-Doc Sync.
//
// The scheduled/wake-triggered notebooklm.sync workflow ASSEMBLES the five managed-doc
// bodies (00 Brief / 01 Decisions / 02 Meeting Digest / 03 Research / 04 Open Questions)
// from COMMITTED Markdown (the canonical, already-validated truth — NEVER caller-supplied
// bodies) and idempotently UPSERTS each slot per NotebookMapping THROUGH the Tool Gateway
// / NotebookPort. It enforces:
//   • REQ-I-004 / NLM-2 IDEMPOTENT UPSERT: each of the five slots upserts by canonical
//     key (pre-write existence check); a replay/retry reuses the receipt = NO duplicate
//     Drive doc. The driver re-drives the SAME sync; the NotebookPort / Tool Gateway is
//     the idempotency backstop.
//   • REATTACH SURFACING (never silent): a missing/unlinked managed source (blank mapping
//     id or adapter-404) yields a reattach_required state surfaced via the 7.5 health
//     sink — the operator re-adds/refreshes the NotebookLM source, never a silent failure.
//   • OUTAGE → OUTBOX HOLD (never dropped): a Drive/connector outage HOLDS the slot's
//     upsert in the write outbox (holdWrite, inside the NotebookPort) and retries on
//     reconnect; the driver surfaces the hold via the 7.5 sink — held, not dropped.
//   • Every failure/park class routes through the 7.5 health sink (nothing silent).
//
// The DRIVER is pure (no @temporalio, no node:crypto, no Date.now) — all time + I/O
// arrive through injected ports + Clock, so this is Vitest-unit-testable with no Temporal
// server and no real Drive transport.
import { describe, it, expect, vi } from "vitest";
import { ok, err, workflowId } from "@sow/contracts";
import type { Result, NotebookMapping } from "@sow/contracts";
import {
  runNotebookLmSync,
  notebookLmSyncMachine,
  NOTEBOOK_SLOTS_ORDER,
} from "../src/workflows/notebookLmSync";
import type {
  NotebookLmSyncInput,
  NotebookLmSyncDeps,
  AssembleDocsPort,
  AssembleDocsResult,
  AssembleDocsError,
  NotebookSyncPort,
  NotebookLmHealthSink,
  NotebookLmSyncFailure,
} from "../src/workflows/notebookLmSync";
import { createAssembleNotebookDocsActivity } from "../src/activities/assembleNotebookDocs";
import type {
  ManagedDocBodies,
  NotebookSyncResult,
  NotebookError,
  NotebookSlot,
} from "@sow/integrations";
import type { Clock, WorkflowRunRefRepository } from "../src/ports/operational";
import type { WorkflowRunRef } from "@sow/contracts";
import type { DbResult } from "../src/ports/operational";

// --- fixed clock ------------------------------------------------------------

const NOW = "2026-07-02T12:00:00.000Z";
function makeClock(now: string = NOW): Clock {
  return { now: () => now };
}

// --- workflow-run repo fake (novel key → create) ----------------------------

function makeRuns(): WorkflowRunRefRepository {
  const store = new Map<string, WorkflowRunRef>();
  const notFound = { ok: false as const, error: { code: "not_found" as const, message: "nf" } };
  return {
    getByIdempotencyKey: vi.fn((k: string): DbResult<WorkflowRunRef> => {
      const hit = store.get(k);
      return Promise.resolve(hit ? ok(hit) : notFound);
    }),
    create: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => {
      store.set(r.idempotencyKey, r);
      return Promise.resolve(ok(r));
    }),
    get: vi.fn((): DbResult<WorkflowRunRef> => Promise.resolve(notFound)),
    update: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => Promise.resolve(ok(r))),
  } as unknown as WorkflowRunRefRepository;
}

// --- health sink fake -------------------------------------------------------

function makeHealthSink(): {
  sink: NotebookLmHealthSink;
  surfaced: NotebookLmSyncFailure[];
} {
  const surfaced: NotebookLmSyncFailure[] = [];
  const sink: NotebookLmHealthSink = {
    surface: vi.fn((f: NotebookLmSyncFailure) => {
      surfaced.push(f);
      return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
    }),
  };
  return { sink, surfaced };
}

// --- fixtures ---------------------------------------------------------------

const MAPPING: NotebookMapping = {
  projectId: "proj-001",
  notebookKey: "nb-acme",
  driveFolderId: "drive-folder-1",
  managedDocIds: {
    "00_brief": "doc-00",
    "01_decisions": "doc-01",
    "02_meetings": "doc-02",
    "03_research": "doc-03",
    "04_open_questions": "doc-04",
  },
};

const BODIES: ManagedDocBodies = {
  "00_brief": "# Brief\nbody",
  "01_decisions": "# Decisions\nbody",
  "02_meetings": "# Meeting Digest\nbody",
  "03_research": "# Research\nbody",
  "04_open_questions": "# Open Questions\nbody",
};

const ALL_SLOTS: readonly NotebookSlot[] = [
  "00_brief",
  "01_decisions",
  "02_meetings",
  "03_research",
  "04_open_questions",
];

// --- assemble port fake -----------------------------------------------------

function assembleReturning(
  result: Result<AssembleDocsResult, AssembleDocsError> = ok({ mapping: MAPPING, bodies: BODIES }),
): { port: AssembleDocsPort; calls: string[] } {
  const calls: string[] = [];
  const port: AssembleDocsPort = {
    assemble: vi.fn((workspaceId: string, projectId: string) => {
      calls.push(`${workspaceId}:${projectId}`);
      return Promise.resolve(result);
    }),
  };
  return { port, calls };
}

// --- notebook sync port fake ------------------------------------------------

function syncReturning(
  result: Result<NotebookSyncResult, NotebookError> = ok({
    upserted: [...ALL_SLOTS],
    reattachRequired: [],
    heldForRetry: [],
  }),
): { port: NotebookSyncPort; received: Array<{ mapping: NotebookMapping; bodies: ManagedDocBodies }> } {
  const received: Array<{ mapping: NotebookMapping; bodies: ManagedDocBodies }> = [];
  const port: NotebookSyncPort = {
    sync: vi.fn((mapping: NotebookMapping, bodies: ManagedDocBodies) => {
      received.push({ mapping, bodies });
      return Promise.resolve(result);
    }),
  };
  return { port, received };
}

function baseInput(overrides: Partial<NotebookLmSyncInput> = {}): NotebookLmSyncInput {
  return {
    run: {
      workflowId: workflowId("wf-notebook-sync-1"),
      trigger: "schedule",
      workspaceId: "ws-1",
      idempotencyKey: "idem-notebook-1",
    },
    workspaceId: "ws-1",
    projectId: "proj-001",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<NotebookLmSyncDeps> = {}): NotebookLmSyncDeps {
  return {
    assemble: assembleReturning().port,
    notebook: syncReturning().port,
    health: makeHealthSink().sink,
    runs: makeRuns(),
    clock: makeClock(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the local state machine — pure + total
// ---------------------------------------------------------------------------

describe("spec(§9) notebookLmSyncMachine — pure + total", () => {
  it("walks the happy edge scheduled → assembling → syncing → synced → done", () => {
    let s = notebookLmSyncMachine.transition("scheduled", "assembling");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = notebookLmSyncMachine.transition(s.value, "syncing");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = notebookLmSyncMachine.transition(s.value, "synced");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = notebookLmSyncMachine.transition(s.value, "done");
    expect(s.ok).toBe(true);
  });

  it("rejects the forbidden edge scheduled → done (assemble+sync cannot be skipped)", () => {
    const s = notebookLmSyncMachine.transition("scheduled", "done");
    expect(s.ok).toBe(false);
  });

  it("exposes the five 00→04 slots in canonical order", () => {
    expect(NOTEBOOK_SLOTS_ORDER).toEqual([
      "00_brief",
      "01_decisions",
      "02_meetings",
      "03_research",
      "04_open_questions",
    ]);
  });
});

// ---------------------------------------------------------------------------
// happy path — five slots upsert idempotently
// ---------------------------------------------------------------------------

describe("spec(REQ-I-004, NLM-2) happy path — five slots upsert idempotently", () => {
  it("assembles bodies from committed Markdown and upserts all five slots, reaching done with no health item", async () => {
    const assembled = assembleReturning();
    const synced = syncReturning();
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(
      baseInput(),
      makeDeps({ assemble: assembled.port, notebook: synced.port, health: sink }),
    );

    expect(out.state).toBe("done");
    expect(out.upserted).toEqual([...ALL_SLOTS]);
    expect(out.reattachRequired).toEqual([]);
    expect(out.heldForRetry).toEqual([]);
    expect(surfaced).toHaveLength(0);
    // The sync ran against the ASSEMBLED bodies + mapping (derived from committed
    // Markdown), NOT caller-supplied — the driver has no bodies input at all.
    expect(assembled.calls).toEqual(["ws-1:proj-001"]);
    expect(synced.received).toHaveLength(1);
    expect(synced.received[0]?.bodies).toBe(BODIES);
    expect(synced.received[0]?.mapping).toBe(MAPPING);
  });

  it("re-driving the same run reuses the run (idempotent replay) — receipt reuse is the NotebookPort's job", async () => {
    const runs = makeRuns();
    const first = await runNotebookLmSync(baseInput(), makeDeps({ runs }));
    expect(first.runReused).toBe(false);
    const second = await runNotebookLmSync(baseInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });

  it("a replay reusing every receipt (all 'reused') is still a clean upsert — no duplicate Drive doc, no health item", async () => {
    // The NotebookPort returns every slot as upserted (created OR reused, indistinguishable
    // to the driver — receipt reuse = zero duplicate Drive doc, safety invariant 2/3).
    const synced = syncReturning(
      ok({ upserted: [...ALL_SLOTS], reattachRequired: [], heldForRetry: [] }),
    );
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));
    expect(out.state).toBe("done");
    expect(out.upserted).toEqual([...ALL_SLOTS]);
    expect(surfaced).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reattach — missing/unlinked managed source is SURFACED, never silent
// ---------------------------------------------------------------------------

describe("spec(NLM-2) reattach — a missing/unlinked source surfaces reattach_required", () => {
  it("parks in reattach_required and surfaces a health item naming the reattach slots", async () => {
    const synced = syncReturning(
      ok({ upserted: ["00_brief", "01_decisions", "03_research", "04_open_questions"], reattachRequired: ["02_meetings"], heldForRetry: [] }),
    );
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));

    expect(out.state).toBe("reattach_required");
    expect(out.reattachRequired).toEqual(["02_meetings"]);
    // Surfaced (not silent) — one distinct health item.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("sync_lagging");
    expect(surfaced[0]?.message).toContain("02_meetings");
  });
});

// ---------------------------------------------------------------------------
// outage — a held slot is HELD in the outbox, surfaced, not dropped
// ---------------------------------------------------------------------------

describe("spec(§8) outage — a Drive outage HOLDS the upsert in the outbox (not dropped)", () => {
  it("parks in outbox_held and surfaces a health item naming the held slots (held, not dropped)", async () => {
    const synced = syncReturning(
      ok({ upserted: ["00_brief", "01_decisions", "02_meetings", "03_research"], reattachRequired: [], heldForRetry: ["04_open_questions"] }),
    );
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));

    expect(out.state).toBe("outbox_held");
    expect(out.heldForRetry).toEqual(["04_open_questions"]);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("write_through_failed");
    expect(surfaced[0]?.message).toContain("04_open_questions");
  });

  it("reattach takes precedence over outbox-hold when BOTH occur (reattach needs operator action)", async () => {
    const synced = syncReturning(
      ok({ upserted: ["00_brief", "01_decisions", "02_meetings"], reattachRequired: ["03_research"], heldForRetry: ["04_open_questions"] }),
    );
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));

    expect(out.state).toBe("reattach_required");
    // BOTH failure classes surface (nothing silent), reattach first.
    expect(surfaced.map((f) => f.failureClass)).toContain("sync_lagging");
    expect(surfaced.map((f) => f.failureClass)).toContain("write_through_failed");
  });
});

// ---------------------------------------------------------------------------
// failure branches — assemble failure, sync hard failure → distinct health item
// ---------------------------------------------------------------------------

describe("spec(§16) failure branches — every class surfaces a distinct 7.5 health item", () => {
  it("an assemble failure parks in sync_failed with NO upsert attempted", async () => {
    const assembled = assembleReturning(
      err<AssembleDocsError>({ code: "mapping_unavailable", message: "no notebook mapping for project" }),
    );
    const synced = syncReturning();
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(
      baseInput(),
      makeDeps({ assemble: assembled.port, notebook: synced.port, health: sink }),
    );

    expect(out.state).toBe("sync_failed");
    // No upsert ever attempted — the NotebookPort was never called.
    expect(synced.received).toHaveLength(0);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("write_through_failed");
    expect(surfaced[0]?.message).toContain("mapping_unavailable");
  });

  it("a hard NotebookPort failure (non-reattach dispatch fault) parks in sync_failed and surfaces", async () => {
    const synced = syncReturning(
      err<NotebookError>({ code: "dispatch_failed", slot: "02_meetings", message: "rejected: bad payload" }),
    );
    const { sink, surfaced } = makeHealthSink();
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));

    expect(out.state).toBe("sync_failed");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("write_through_failed");
    expect(surfaced[0]?.message).toContain("02_meetings");
  });

  it("the driver never throws even if the health sink itself errors (fail-closed)", async () => {
    const synced = syncReturning(
      err<NotebookError>({ code: "dispatch_failed", slot: "00_brief", message: "boom" }),
    );
    const sink: NotebookLmHealthSink = {
      surface: vi.fn(() => Promise.resolve(err({ code: "surface_failed" as const, message: "sink down" }))),
    };
    const out = await runNotebookLmSync(baseInput(), makeDeps({ notebook: synced.port, health: sink }));
    // Still returns the resting failure state (fail-closed) — never throws.
    expect(out.state).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// activity — assembleNotebookDocs derives bodies from committed Markdown
// ---------------------------------------------------------------------------

describe("spec(REQ-I-004) assembleNotebookDocs activity — bodies DERIVED from committed Markdown", () => {
  it("reads the mapping + renders the five bodies via the injected committed-Markdown reader", async () => {
    const readMarkdown = vi.fn((workspaceId: string, slot: NotebookSlot) =>
      Promise.resolve(ok(`# ${slot}\ncommitted body for ${workspaceId}`)),
    );
    const resolveMapping = vi.fn(() => Promise.resolve(ok(MAPPING)));
    const activity = createAssembleNotebookDocsActivity({ resolveMapping, readMarkdown });

    const out = await activity.assemble("ws-1", "proj-001");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.mapping).toBe(MAPPING);
    // Each of the five slots was rendered from the committed-Markdown reader — never
    // caller-supplied bodies.
    for (const slot of ALL_SLOTS) {
      expect(out.value.bodies[slot]).toContain(slot);
      expect(readMarkdown).toHaveBeenCalledWith("ws-1", slot);
    }
  });

  it("folds a missing mapping to mapping_unavailable (fail-closed, no bodies)", async () => {
    const resolveMapping = vi.fn(() =>
      Promise.resolve(err<AssembleDocsError>({ code: "mapping_unavailable", message: "no mapping" })),
    );
    const readMarkdown = vi.fn(() => Promise.resolve(ok("x")));
    const activity = createAssembleNotebookDocsActivity({ resolveMapping, readMarkdown });

    const out = await activity.assemble("ws-1", "proj-001");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("mapping_unavailable");
    // No slot was read once the mapping was unavailable.
    expect(readMarkdown).not.toHaveBeenCalled();
  });

  it("folds a committed-Markdown read failure to assemble_failed", async () => {
    const resolveMapping = vi.fn(() => Promise.resolve(ok(MAPPING)));
    const readMarkdown = vi.fn(() =>
      Promise.resolve(err<AssembleDocsError>({ code: "assemble_failed", message: "read error" })),
    );
    const activity = createAssembleNotebookDocsActivity({ resolveMapping, readMarkdown });

    const out = await activity.assemble("ws-1", "proj-001");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("assemble_failed");
  });
});
