// spec(§9) — task 7.8 INGESTION-INBOX TRIAGE — the PURE orchestration driver.
//
// These tests drive `runIngestionTriage` (the pure driver) over the triage
// activity-port FAKES (test/support/triage-fakes.ts) + the foundation FakeClock +
// InMemoryWorkflowRunRepo. The driver imports NEITHER @temporalio NOR node:crypto and
// calls NO Date.now()/Math.random(), so it runs entirely in-memory with no Temporal
// server (root CLAUDE.md ★ two-layer split).
//
// Triage resolves the ING-4 dead-end (ARCHITECTURE.md §9 workflow 5): an owner
// disposition of a parked SourceEnvelope (Mac OR Telegram) re-classifies
// workspace/project + sets sensitivity + applies a routing override, then RE-ENTERS
// the 7.7 ingestion pipeline REUSING THE SAME idempotencyKey.
//
// The suite pins the 7.8 safety invariants:
//   • inv-A  a disposition is recorded EXACTLY ONCE with an audit ref; a re-submitted
//     IDENTICAL disposition is a NO-OP (idempotent) — no second record, no 2nd write.
//   • inv-B  Mac + Telegram dispositions CONVERGE on a SINGLE transition (no divergent
//     inbox state across channels).
//   • inv-C  a routing override RE-SCOPES the source (workspace/project/sensitivity)
//     BEFORE re-processing — the re-entered pipeline sees the OVERRIDDEN source.
//   • inv-D  re-entry REUSES the SAME idempotencyKey → no duplicate run / commit /
//     external write across a re-drive.
//   • inv-5  EVERY failure branch surfaces a 7.5 health item (nothing silent).
import { describe, it, expect } from "vitest";
import { workflowId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { runIngestionTriage } from "../src/workflows/ingestionTriage";
import type {
  IngestionTriageInput,
  IngestionTriageDeps,
} from "../src/workflows/ingestionTriage";
import {
  FakeRecordDispositionPort,
  FakeRescopeSourcePort,
  FakeReenterIngestionPort,
  FakeTriageHealthSink,
  makeDisposition,
} from "./support/triage-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";
import type {
  RecordDispositionErrorCode,
  RescopeErrorCode,
  ReenterErrorCode,
} from "../src/ports/ingestionTriage";
import { ok, auditId, sourceId, workspaceId } from "@sow/contracts";
import type { Result, SourceEnvelope, AuditId } from "@sow/contracts";
import {
  dispositionKey,
  createRecordDispositionActivity,
  createRescopeSourceActivity,
} from "../src/activities/disposition";
import type {
  DispositionStore,
  ParkedSourceReader,
} from "../src/activities/disposition";
import { makeParkedSource } from "./support/triage-fakes";

// --- fixtures --------------------------------------------------------------

const WS = "ws-employer" as WorkspaceId;
/** The idempotencyKey the PARKED source was first submitted under (7.7). Reused on re-entry. */
const PARKED_IDEM_KEY = "idem-run-parked-1";

/** The happy-path input: the run submission + the owner disposition. */
function makeInput(partial: Partial<IngestionTriageInput> = {}): IngestionTriageInput {
  return {
    run: {
      workflowId: workflowId("wf-triage-1"),
      trigger: "owner_action",
      idempotencyKey: PARKED_IDEM_KEY,
      workspaceId: WS,
    },
    disposition: makeDisposition({ workspaceId: WS }),
    ...partial,
  };
}

/** Build a fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<IngestionTriageDeps> = {}): IngestionTriageDeps {
  return {
    record: new FakeRecordDispositionPort(),
    rescope: new FakeRescopeSourcePort(),
    reenter: new FakeReenterIngestionPort(),
    health: new FakeTriageHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// --- happy path ------------------------------------------------------------

describe("runIngestionTriage — happy path", () => {
  it("records the disposition once, re-scopes, and re-enters the 7.7 pipeline (reaching applied)", async () => {
    const record = new FakeRecordDispositionPort();
    const rescope = new FakeRescopeSourcePort();
    const reenter = new FakeReenterIngestionPort();
    const deps = makeDeps({ record, rescope, reenter });

    const outcome = await runIngestionTriage(makeInput(), deps);

    expect(outcome.resolved).toBe(true);
    // exactly-once record with an audit ref (inv-A).
    expect(record.recordCount).toBe(1);
    expect(outcome.context.auditRef).toBeDefined();
    expect(outcome.context.dispositionNoop).toBe(false);
    // the override re-scoped the source before re-processing (inv-C).
    expect(rescope.calls).toHaveLength(1);
    expect(outcome.context.reScopedSource?.workspaceId).toBe(WS);
    // re-entry reached the 7.7 terminal `applied`.
    expect(outcome.context.reenter?.state).toBe("applied");
  });

  it("re-enters 7.7 REUSING the parked source's idempotencyKey (inv-D)", async () => {
    const reenter = new FakeReenterIngestionPort();
    const deps = makeDeps({ reenter });

    await runIngestionTriage(makeInput(), deps);

    expect(reenter.calls).toHaveLength(1);
    // The SAME idempotencyKey the parked source was first submitted under is reused.
    expect(reenter.calls[0]?.idempotencyKey).toBe(PARKED_IDEM_KEY);
  });
});

// --- inv-C: routing override re-scopes the source ---------------------------

describe("runIngestionTriage — routing override re-scopes the source (inv-C)", () => {
  it("re-scopes workspace/project/sensitivity before re-entry, preserving contentHash", async () => {
    const boundWs = "ws-personal-business" as WorkspaceId;
    const rescope = new FakeRescopeSourcePort();
    const reenter = new FakeReenterIngestionPort();
    const deps = makeDeps({ rescope, reenter });

    const disposition = makeDisposition({
      workspaceId: boundWs,
      projectId: "proj-42",
      sensitivity: "confidential",
    });
    await runIngestionTriage(makeInput({ disposition }), deps);

    // The re-scoped source the pipeline re-entered on carries the OWNER override.
    const reScoped = reenter.calls[0]?.source;
    expect(reScoped?.workspaceId).toBe(boundWs);
    expect(reScoped?.sensitivity).toBe("confidential");
    expect(reScoped?.routingHints.projectId).toBe("proj-42");
    // inv-D: the re-entry is the SAME logical source — contentHash preserved.
    expect(reScoped?.contentHash).toBe("hash-parked-1");
  });
});

// --- inv-A: idempotent re-submit is a no-op --------------------------------

describe("runIngestionTriage — duplicate disposition is a no-op (inv-A)", () => {
  it("a re-submitted IDENTICAL disposition records NO second time and drives NO duplicate downstream write", async () => {
    // Shared, DURABLE fakes survive the "re-submit": the record port keeps its key
    // map and the reenter port keeps its idempotency set across both drives.
    const record = new FakeRecordDispositionPort();
    const reenter = new FakeReenterIngestionPort();
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runIngestionTriage(
      makeInput(),
      makeDeps({ record, reenter, runs }),
    );
    expect(first.context.dispositionNoop).toBe(false);
    expect(record.recordCount).toBe(1);
    expect(reenter.commitCount).toBe(1);

    // Re-submit the SAME disposition (fresh rescope fake, same durable record/reenter).
    const second = await runIngestionTriage(
      makeInput(),
      makeDeps({ record, reenter, runs }),
    );

    // NO second record — the disposition was recorded exactly once (inv-A).
    expect(record.recordCount).toBe(1);
    expect(second.context.dispositionNoop).toBe(true);
    // The prior auditRef is reused (still cited, nothing silent).
    expect(second.context.auditRef).toBe(first.context.auditRef);
    // NO duplicate downstream write on re-entry (same idempotencyKey, inv-D).
    expect(reenter.commitCount).toBe(1);
    expect(second.context.reenter?.runReused).toBe(true);
  });
});

// --- inv-B: Mac + Telegram converge on a single transition -----------------

describe("runIngestionTriage — Mac + Telegram converge (inv-B)", () => {
  it("the same disposition from BOTH channels records ONCE (no divergent inbox state)", async () => {
    // A SHARED, durable record port models the single operational inbox row.
    const record = new FakeRecordDispositionPort();
    const reenter = new FakeReenterIngestionPort();
    const runs = new InMemoryWorkflowRunRepo();

    // Owner dispositions from Mac.
    const fromMac = await runIngestionTriage(
      makeInput({ disposition: makeDisposition({ workspaceId: WS, channel: "mac" }) }),
      makeDeps({ record, reenter, runs }),
    );
    // …and the SAME disposition arrives from Telegram (parity).
    const fromTelegram = await runIngestionTriage(
      makeInput({ disposition: makeDisposition({ workspaceId: WS, channel: "telegram" }) }),
      makeDeps({ record, reenter, runs }),
    );

    // Both channels were consulted, but exactly ONE record + ONE transition (inv-B).
    expect(record.calls.map((c) => c.channel)).toEqual(["mac", "telegram"]);
    expect(record.recordCount).toBe(1);
    // The second (converging) channel is a no-op reusing the same auditRef.
    expect(fromMac.context.dispositionNoop).toBe(false);
    expect(fromTelegram.context.dispositionNoop).toBe(true);
    expect(fromTelegram.context.auditRef).toBe(fromMac.context.auditRef);
    // NO divergent downstream: one durable re-entry across both channels (inv-D).
    expect(reenter.commitCount).toBe(1);
  });
});

// --- failure branches: nothing silent (inv-5) ------------------------------

describe("runIngestionTriage — record failure", () => {
  it("a not_parked disposition fails closed with a health item and NO re-scope / re-entry", async () => {
    const rescope = new FakeRescopeSourcePort();
    const reenter = new FakeReenterIngestionPort();
    const health = new FakeTriageHealthSink();
    const failWith: RecordDispositionErrorCode = "not_parked";
    const deps = makeDeps({
      record: new FakeRecordDispositionPort({ failWith }),
      rescope,
      reenter,
      health,
    });

    const outcome = await runIngestionTriage(makeInput(), deps);

    expect(outcome.resolved).toBe(false);
    // No downstream effects when the disposition can't be recorded.
    expect(rescope.calls).toHaveLength(0);
    expect(reenter.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runIngestionTriage — re-scope failure", () => {
  it("a re-scope failure fails closed with a health item and NO re-entry", async () => {
    const reenter = new FakeReenterIngestionPort();
    const health = new FakeTriageHealthSink();
    const failWith: RescopeErrorCode = "source_unavailable";
    const deps = makeDeps({
      rescope: new FakeRescopeSourcePort({ failWith }),
      reenter,
      health,
    });

    const outcome = await runIngestionTriage(makeInput(), deps);

    expect(outcome.resolved).toBe(false);
    expect(reenter.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runIngestionTriage — re-entry failure", () => {
  it("a re-entry failure surfaces a health item (nothing silent), disposition already recorded", async () => {
    const record = new FakeRecordDispositionPort();
    const health = new FakeTriageHealthSink();
    const failWith: ReenterErrorCode = "reentry_failed";
    const deps = makeDeps({
      record,
      reenter: new FakeReenterIngestionPort({ failWith }),
      health,
    });

    const outcome = await runIngestionTriage(makeInput(), deps);

    expect(outcome.resolved).toBe(false);
    // The disposition was still recorded exactly once (with its audit ref).
    expect(record.recordCount).toBe(1);
    expect(outcome.context.auditRef).toBeDefined();
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runIngestionTriage — nothing fails silently (inv-5)", () => {
  it("every failure branch routes through the health sink", async () => {
    const scenarios: Array<Partial<IngestionTriageDeps>> = [
      { record: new FakeRecordDispositionPort({ failWith: "not_parked" }) },
      { record: new FakeRecordDispositionPort({ failWith: "record_failed" }) },
      { rescope: new FakeRescopeSourcePort({ failWith: "rescope_failed" }) },
      { reenter: new FakeReenterIngestionPort({ failWith: "reentry_failed" }) },
    ];
    for (const scenario of scenarios) {
      const health = new FakeTriageHealthSink();
      await runIngestionTriage(makeInput(), makeDeps({ ...scenario, health }));
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// --- ACTIVITY-LAYER: the disposition activity (node:crypto key + derivation) ---
//
// The activity is deterministic code (a stable key + a pure re-scope projection), so
// TDD applies. A tiny in-memory DispositionStore models the operational store's
// CAS-insert + unique-key idempotency.

/** A minimal in-memory {@link DispositionStore} for the activity tests. */
class MemoryDispositionStore implements DispositionStore {
  private readonly records = new Map<string, AuditId>();
  private n = 0;
  constructor(private readonly parked: boolean = true) {}
  isParked(
    _sourceId: string,
  ): Promise<Result<boolean, { code: "record_failed"; message: string }>> {
    return Promise.resolve(ok(this.parked));
  }
  getByKey(key: string): Promise<AuditId | undefined> {
    return Promise.resolve(this.records.get(key));
  }
  insert(
    key: string,
  ): Promise<Result<AuditId, { code: "record_failed"; message: string }>> {
    this.n += 1;
    const ref = auditId(`audit-mem-${this.n}`);
    this.records.set(key, ref);
    return Promise.resolve(ok(ref));
  }
}

describe("disposition activity — stable channel-free key (inv-A/inv-B)", () => {
  const d = makeDisposition({ workspaceId: WS, projectId: "proj-x", sensitivity: "high" });

  it("the key is IDENTICAL across channels (channel excluded → Mac/Telegram converge)", () => {
    const fromMac = dispositionKey({ ...d, channel: "mac" });
    const fromTelegram = dispositionKey({ ...d, channel: "telegram" });
    expect(fromMac).toBe(fromTelegram);
  });

  it("a DIFFERENT routing decision yields a DIFFERENT key", () => {
    const base = dispositionKey(d);
    const otherWs = dispositionKey({ ...d, workspaceId: "ws-other" as WorkspaceId });
    const otherProj = dispositionKey({ ...d, projectId: "proj-y" });
    expect(otherWs).not.toBe(base);
    expect(otherProj).not.toBe(base);
  });

  it("records once then no-ops the converging channel, reusing the auditRef", async () => {
    const store = new MemoryDispositionStore(true);
    const port = createRecordDispositionActivity({ store });

    const mac = await port.record({ ...d, channel: "mac" });
    const tg = await port.record({ ...d, channel: "telegram" });

    expect(mac.ok && mac.value.outcome).toBe("recorded");
    expect(tg.ok && tg.value.outcome).toBe("noop");
    if (mac.ok && tg.ok) {
      expect(tg.value.auditRef).toBe(mac.value.auditRef);
    }
  });

  it("a non-parked source is rejected not_parked (fail-closed)", async () => {
    const store = new MemoryDispositionStore(false);
    const port = createRecordDispositionActivity({ store });
    const outcome = await port.record(d);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_parked");
  });
});

describe("disposition activity — re-scope preserves contentHash + applies override (inv-C/inv-D)", () => {
  it("stamps the owner workspace/project/sensitivity and preserves contentHash", async () => {
    const parked = makeParkedSource({
      sourceId: sourceId("src-parked-9"),
      workspaceId: workspaceId("ws-inbox"),
      contentHash: "hash-keep-me",
      sensitivity: "normal",
    });
    const reader: ParkedSourceReader = {
      read: (_id: string) => Promise.resolve(ok(parked)),
    };
    const port = createRescopeSourceActivity({ reader });

    const boundWs = "ws-personal-life" as WorkspaceId;
    const result = await port.rescope(
      makeDisposition({
        sourceId: "src-parked-9",
        workspaceId: boundWs,
        projectId: "proj-77",
        sensitivity: "confidential",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const re: SourceEnvelope = result.value;
      expect(re.workspaceId).toBe(boundWs);
      expect(re.sensitivity).toBe("confidential");
      expect(re.routingHints.projectId).toBe("proj-77");
      // inv-D: same logical source — contentHash unchanged.
      expect(re.contentHash).toBe("hash-keep-me");
    }
  });
});
