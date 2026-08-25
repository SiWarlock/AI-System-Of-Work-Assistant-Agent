// @sow/worker — 25.SCHED leg 3 / 25.5: the TWO ingestion-triage behaviours the
// Done-when names but nothing covers, over the REAL @sow/db SourceDisposition
// SQLite store in a tmpdir (an in-memory fake cannot prove restart survival):
//   (1) a RESOLVED item is not re-surfaced on the next occurrence — re-recording
//       the SAME owner disposition against an already-dispositioned parked
//       source is a `noop` reusing the PRIOR auditRef, never a second
//       `recorded` transition (inv-A, the exactly-once record).
//   (2) disposition state SURVIVES A RESTART — close the sqlite connection,
//       reopen a FRESH `createDurableDispositionStore` from the SAME on-disk
//       file, and the SAME re-submitted disposition is STILL a `noop` with the
//       IDENTICAL auditRef (the restart does not "forget" the resolution and
//       treat the parked item as fresh/actionable again).
//
// This exercises the REAL production seam a 25.5 schedule tick would drive
// (`createRecordDispositionActivity` over `createDurableDispositionStore` — the
// exact activities/composition pairing `buildActivities.ts`'s
// `triageRecordDisposition` binds), NOT a reimplementation of the CAS logic.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk } from "@sow/contracts";
import { workspaceId, workflowId } from "@sow/contracts";
import type { SourceEnvelope, WorkflowRunRef } from "@sow/contracts";
import { openDatabase } from "../../src/composition/backends";
import { createDurableDispositionStore } from "../../src/composition/dispositionDurable";
import { createRecordDispositionActivity } from "@sow/workflows/activities/disposition";
import type { TriageDisposition } from "@sow/workflows/ports/ingestionTriage";
import type { SourceDispositionRow } from "@sow/db";

const NOW = "2026-07-05T00:00:00.000Z";
const WS = workspaceId("ws-triage-durability");

const RUN_REF: WorkflowRunRef = {
  workflowId: workflowId("wf-triage-durability"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:triage:durability",
  auditRefs: [],
};

function parkedEnvelope(sourceId: string): SourceEnvelope {
  return {
    sourceId: sourceId as SourceEnvelope["sourceId"],
    workspaceId: WS,
    origin: "https://example.test/parked",
    contentHash: `hash:${sourceId}`,
    type: "document",
    sensitivity: "internal",
    routingHints: {},
  };
}

function parkedRow(sourceId: string): SourceDispositionRow {
  return {
    sourceId,
    sourceEnvelope: parkedEnvelope(sourceId),
    idempotencyKey: `idem:${sourceId}`,
    state: "queued_for_review",
    dispositionKey: null,
    auditRef: null,
    parkedAt: NOW,
    dispositionedAt: null,
  };
}

function disposition(sourceId: string): TriageDisposition {
  return { sourceId, workspaceId: WS, channel: "mac" };
}

function tempDbPath(): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sow-triagedurability-"));
  return {
    path: join(dir, "ops.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

describe("ingestion-triage disposition durability (25.SCHED leg 3 / 25.5)", () => {
  it("(1) a RESOLVED item is not re-surfaced on the next occurrence — a re-record is a noop reusing the prior auditRef", async () => {
    const { path: dbPath, cleanup } = tempDbPath();
    try {
      const db = await openDatabase({ dbPath });
      try {
        await db.repos.sourceDisposition.park(parkedRow("src:parked:resolve-1"));
        const store = createDurableDispositionStore({
          repo: db.repos.sourceDisposition,
          audit: db.repos.audit,
          now: () => NOW,
          runRef: RUN_REF,
        });
        const record = createRecordDispositionActivity({ store });

        const first = await record.record(disposition("src:parked:resolve-1"));
        expect(isOk(first)).toBe(true);
        if (!isOk(first)) return;
        expect(first.value.outcome).toBe("recorded");
        const auditRef1 = first.value.auditRef;

        // "The next occurrence" re-presents the SAME parked item to triage
        // (a schedule tick, or a converging second channel) — it must NOT
        // re-surface as a fresh, actionable disposition.
        const second = await record.record(disposition("src:parked:resolve-1"));
        expect(isOk(second)).toBe(true);
        if (!isOk(second)) return;
        expect(second.value.outcome).toBe("noop"); // NOT a second "recorded"
        expect(second.value.auditRef).toBe(auditRef1); // the SAME resolution, reused

        // The durable row reflects exactly one transition (state advanced once).
        const row = await db.repos.sourceDisposition.getBySourceId("src:parked:resolve-1");
        expect(row.ok).toBe(true);
        if (row.ok) {
          expect(row.value?.state).toBe("dispositioned");
          expect(row.value?.auditRef).toBe(String(auditRef1));
        }
      } finally {
        db.conn.close();
      }
    } finally {
      cleanup();
    }
  });

  it("(2) disposition state SURVIVES A RESTART — a fresh store over the SAME file still treats it as resolved", async () => {
    const { path: dbPath, cleanup } = tempDbPath();
    try {
      // ── worker run #1: park + record the disposition, then the worker exits ──
      const db1 = await openDatabase({ dbPath });
      await db1.repos.sourceDisposition.park(parkedRow("src:parked:restart-1"));
      const store1 = createDurableDispositionStore({
        repo: db1.repos.sourceDisposition,
        audit: db1.repos.audit,
        now: () => NOW,
        runRef: RUN_REF,
      });
      const record1 = createRecordDispositionActivity({ store: store1 });
      const first = await record1.record(disposition("src:parked:restart-1"));
      expect(isOk(first)).toBe(true);
      if (!isOk(first)) return;
      expect(first.value.outcome).toBe("recorded");
      const auditRef1 = first.value.auditRef;
      db1.conn.close(); // the worker exits — an in-memory disposition map would vanish here

      // ── worker run #2 (RESTART): a FRESH store over the SAME on-disk file ──
      const db2 = await openDatabase({ dbPath });
      try {
        // Durability check: the row itself persisted as dispositioned.
        const row = await db2.repos.sourceDisposition.getBySourceId("src:parked:restart-1");
        expect(row.ok).toBe(true);
        if (row.ok) expect(row.value?.state).toBe("dispositioned");

        const store2 = createDurableDispositionStore({
          repo: db2.repos.sourceDisposition,
          audit: db2.repos.audit,
          now: () => NOW,
          runRef: RUN_REF,
        });
        const record2 = createRecordDispositionActivity({ store: store2 });

        // The load-bearing assertion: post-restart, the SAME disposition is
        // STILL a noop reusing the ORIGINAL auditRef — the restart did not
        // reset the item to "never dispositioned" (which would re-surface it
        // as fresh/actionable and, worse, let a second re-entry duplicate the
        // downstream re-processing, inv-A/inv-D).
        const again = await record2.record(disposition("src:parked:restart-1"));
        expect(isOk(again)).toBe(true);
        if (!isOk(again)) return;
        expect(again.value.outcome).toBe("noop");
        expect(again.value.auditRef).toBe(auditRef1);
      } finally {
        db2.conn.close();
      }
    } finally {
      cleanup();
    }
  });
});
