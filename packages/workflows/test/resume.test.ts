// spec(§9, LIFE-3) — slice 7.3 in-flight workflow RESUME decision.
//
// PURE decision over a durable step-ledger (no @temporalio, no node:crypto, no
// Date.now() — an injected FakeClock supplies the health-item timestamp). Given
// the steps a re-entered run ALREADY committed (each with its write receipt) and
// the run's ordered pending steps, `planResume` decides — per step — SKIP
// (already committed, receipt present) vs RE-DRIVE (no committed receipt), WITHOUT
// re-running committed work.
//
// Invariants pinned:
//   • LIFE-3 — a committed step (its id appears in the ledger with a receipt) is
//     SKIPPED; committed work is never re-run.
//   • §6 ordering — pending KnowledgeWriter writes are applied BEFORE queued
//     GBrain index jobs; an index job re-derives from current Markdown by
//     revisionId and NEVER rolls back a commit.
//   • Unrecoverable ledger state (a committed KnowledgeWriter step whose receipt
//     is missing — a torn commit that cannot be safely re-derived) → a typed
//     recovery outcome that surfaces a System Health item (write_through_failed),
//     never a silently dropped run.
import { describe, it, expect } from "vitest";
import {
  planResume,
  type ResumeStep,
  type ResumeLedgerEntry,
} from "../src/runtime/resume";
import { FakeClock, InMemoryHealthItemStore } from "./support/fakes";

// Mutating steps (knowledge_write / external_write) MUST carry an idempotencyKey
// to be safely re-drivable — the helpers default one so ordinary cases build a
// re-drivable step; the no-key unrecoverable path is exercised explicitly below.
function kwStep(id: string, revisionId: string): ResumeStep {
  return { stepId: id, kind: "knowledge_write", revisionId, idempotencyKey: `idem:${id}` };
}
function gbrainStep(id: string, revisionId: string): ResumeStep {
  return { stepId: id, kind: "gbrain_index", revisionId };
}
function externalStep(id: string): ResumeStep {
  return { stepId: id, kind: "external_write", idempotencyKey: `idem:${id}` };
}

function committed(stepId: string): ResumeLedgerEntry {
  return { stepId, receipt: { kind: "committed", ref: `receipt:${stepId}` } };
}

describe("spec(§9, LIFE-3) planResume — skip committed, re-drive pending", () => {
  it("SKIPS a step whose ledger entry carries a receipt; RE-DRIVES the rest", () => {
    const clock = new FakeClock();
    const steps: ResumeStep[] = [
      kwStep("s1", "rev-1"),
      externalStep("s2"),
      gbrainStep("s3", "rev-1"),
    ];
    const ledger: ResumeLedgerEntry[] = [committed("s1")];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;

    const skipped = res.plan.filter((p) => p.disposition === "skip").map((p) => p.step.stepId);
    const redrive = res.plan.filter((p) => p.disposition === "redrive").map((p) => p.step.stepId);
    expect(skipped).toEqual(["s1"]);
    // §6 orders the whole plan: gbrain (s3, pri 1) drains before external (s2, pri 2).
    expect(redrive).toEqual(["s3", "s2"]);
  });

  it("re-drives NOTHING when every step is already committed", () => {
    const clock = new FakeClock();
    const steps: ResumeStep[] = [kwStep("s1", "rev-1"), gbrainStep("s2", "rev-1")];
    const ledger: ResumeLedgerEntry[] = [committed("s1"), committed("s2")];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.plan.every((p) => p.disposition === "skip")).toBe(true);
  });
});

describe("spec(§6) planResume — KnowledgeWriter writes ordered BEFORE GBrain index jobs", () => {
  it("orders pending KW writes ahead of pending GBrain index jobs regardless of input order", () => {
    const clock = new FakeClock();
    // Input deliberately interleaves GBrain before KW.
    const steps: ResumeStep[] = [
      gbrainStep("g1", "rev-9"),
      kwStep("k1", "rev-9"),
      gbrainStep("g2", "rev-9"),
      externalStep("x1"),
      kwStep("k2", "rev-9"),
    ];
    const res = planResume({ steps, ledger: [] }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;

    const redrive = res.plan.filter((p) => p.disposition === "redrive");
    const lastKwIdx = redrive.map((p) => p.step.kind).lastIndexOf("knowledge_write");
    const firstGbrainIdx = redrive.map((p) => p.step.kind).indexOf("gbrain_index");
    // Every KW write precedes every GBrain index job.
    expect(lastKwIdx).toBeLessThan(firstGbrainIdx);
    // The re-drive set is the same steps, just reordered.
    expect(redrive.map((p) => p.step.stepId).sort()).toEqual(
      ["g1", "g2", "k1", "k2", "x1"].sort(),
    );
  });

  it("keeps a committed GBrain index job SKIPPED — never rolls it back before a pending KW write", () => {
    const clock = new FakeClock();
    const steps: ResumeStep[] = [gbrainStep("g1", "rev-1"), kwStep("k1", "rev-2")];
    const ledger: ResumeLedgerEntry[] = [committed("g1")];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    const g1 = res.plan.find((p) => p.step.stepId === "g1");
    expect(g1?.disposition).toBe("skip");
  });
});

describe("spec(§9, OBS-1) planResume — unrecoverable → System Health item", () => {
  it("returns a typed unrecoverable outcome + a write_through_failed HealthItem when a committed KW step has no receipt", async () => {
    const clock = new FakeClock({ now: "2026-07-02T08:00:00.000Z" });
    const steps: ResumeStep[] = [kwStep("s1", "rev-1")];
    // Ledger marks s1 committed but WITHOUT a receipt — a torn commit.
    const ledger: ResumeLedgerEntry[] = [{ stepId: "s1", receipt: { kind: "missing" } }];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("unrecoverable");
    if (res.kind !== "unrecoverable") return;
    expect(res.health.failureClass).toBe("write_through_failed");
    expect(res.health.state).toBe("open");
    expect(res.health.openedAt).toBe("2026-07-02T08:00:00.000Z");

    // The recovery outcome surfaces the item via the injected store (7.5 seam).
    const store = new InMemoryHealthItemStore();
    await store.put(res.health);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.failureClass).toBe("write_through_failed");
  });

  it("does NOT surface a health item on a clean resume", () => {
    const clock = new FakeClock();
    const res = planResume({ steps: [kwStep("s1", "rev-1")], ledger: [] }, clock);
    expect(res.kind).toBe("resume");
  });
});

describe("spec(§9, LIFE-3) planResume — mutating re-drive requires its dedup key", () => {
  it("a REDRIVABLE knowledge_write WITHOUT idempotencyKey is UNRECOVERABLE (would re-commit Markdown)", () => {
    const clock = new FakeClock({ now: "2026-07-02T09:00:00.000Z" });
    // Pending KW step carrying NO idempotencyKey — re-driving it would defeat the
    // KnowledgeWriter replay guard and re-commit the canonical Markdown.
    const step: ResumeStep = { stepId: "kw-no-key", kind: "knowledge_write", revisionId: "rev-1" };
    const res = planResume({ steps: [step], ledger: [] }, clock);
    expect(res.kind).toBe("unrecoverable");
    if (res.kind !== "unrecoverable") return;
    expect(res.tornStepId).toBe("kw-no-key");
    expect(res.health.failureClass).toBe("write_through_failed");
    expect(res.health.state).toBe("open");
    expect(res.health.openedAt).toBe("2026-07-02T09:00:00.000Z");
  });

  it("a REDRIVABLE external_write WITHOUT idempotencyKey is UNRECOVERABLE", () => {
    const clock = new FakeClock();
    const step: ResumeStep = { stepId: "ext-no-key", kind: "external_write" };
    const res = planResume({ steps: [step], ledger: [] }, clock);
    expect(res.kind).toBe("unrecoverable");
    if (res.kind !== "unrecoverable") return;
    expect(res.tornStepId).toBe("ext-no-key");
  });

  it("a REDRIVABLE knowledge_write WITH idempotencyKey re-drives, and the plan step CARRIES the key downstream", () => {
    const clock = new FakeClock();
    const step: ResumeStep = {
      stepId: "kw-keyed",
      kind: "knowledge_write",
      revisionId: "rev-1",
      idempotencyKey: "idem-kw-keyed",
    };
    const res = planResume({ steps: [step], ledger: [] }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    const planned = res.plan.find((p) => p.step.stepId === "kw-keyed");
    expect(planned?.disposition).toBe("redrive");
    // The re-drive plan carries the step (with its dedup key) so the executor
    // passes it to KnowledgeWriter / the Tool Gateway.
    expect(planned?.step.idempotencyKey).toBe("idem-kw-keyed");
  });

  it("a COMMITTED knowledge_write WITHOUT idempotencyKey is fine (skipped, never re-driven)", () => {
    const clock = new FakeClock();
    // No key, but committed → skipped, so the no-key rule must NOT fire.
    const step: ResumeStep = { stepId: "kw-committed", kind: "knowledge_write", revisionId: "rev-1" };
    const res = planResume({ steps: [step], ledger: [committed("kw-committed")] }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.plan.find((p) => p.step.stepId === "kw-committed")?.disposition).toBe("skip");
  });
});

describe("spec(§6) planResume — §6 order holds ACROSS skips (whole-plan ordering)", () => {
  it("a SKIPPED gbrain_index never precedes a PENDING knowledge_write in the emitted plan", () => {
    const clock = new FakeClock();
    // Input puts the committed gbrain first; the pending KW must still emit ahead.
    const steps: ResumeStep[] = [gbrainStep("g1", "rev-1"), kwStep("k1", "rev-2")];
    const ledger: ResumeLedgerEntry[] = [committed("g1")];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;

    const order = res.plan.map((p) => p.step.stepId);
    const kwIdx = order.indexOf("k1");
    const gbrainIdx = order.indexOf("g1");
    expect(kwIdx).toBeLessThan(gbrainIdx); // KW before GBrain regardless of disposition.
    // g1 stays a no-op skip; k1 re-drives.
    expect(res.plan.find((p) => p.step.stepId === "g1")?.disposition).toBe("skip");
    expect(res.plan.find((p) => p.step.stepId === "k1")?.disposition).toBe("redrive");
  });

  it("§6 priority is knowledge_write < gbrain_index < external_write across the plan", () => {
    const clock = new FakeClock();
    // Input order deliberately reversed vs §6 priority.
    const steps: ResumeStep[] = [
      externalStep("x1"),
      gbrainStep("g1", "rev-1"),
      kwStep("k1", "rev-1"),
    ];
    const res = planResume({ steps, ledger: [] }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.plan.map((p) => p.step.stepId)).toEqual(["k1", "g1", "x1"]);
  });
});

describe("spec(§9, LIFE-3) planResume — torn-commit detection scoped to THIS run's steps", () => {
  it("a 'missing' ledger entry for a step NOT in input.steps does NOT abort the resume", () => {
    const clock = new FakeClock();
    // The ledger carries a torn commit for 'other-run-step' that this run never
    // owned; scanning the whole ledger would false-abort. Scoped detection must
    // resume cleanly.
    const steps: ResumeStep[] = [kwStep("s1", "rev-1")];
    const ledger: ResumeLedgerEntry[] = [
      { stepId: "other-run-step", receipt: { kind: "missing" } },
    ];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.plan.map((p) => p.step.stepId)).toEqual(["s1"]);
    expect(res.plan[0]?.disposition).toBe("redrive");
  });

  it("STILL aborts when the 'missing' entry IS one of this run's own steps", () => {
    const clock = new FakeClock();
    const steps: ResumeStep[] = [kwStep("s1", "rev-1")];
    const ledger: ResumeLedgerEntry[] = [{ stepId: "s1", receipt: { kind: "missing" } }];

    const res = planResume({ steps, ledger }, clock);
    expect(res.kind).toBe("unrecoverable");
    if (res.kind !== "unrecoverable") return;
    expect(res.tornStepId).toBe("s1");
  });
});
