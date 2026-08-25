// Task 19.4 — bind `createReconcileTrigger` (composition/reconcileTrigger.ts) at the composition root:
// `gateReconcile`'s ON path now assembles a `trigger` alongside `scheduler` (the SAME scheduler instance), and
// `reconcileNotifyForCapture` is the pure decision boot.ts's vault-watcher `onCapture` hook calls on every
// capture outcome — `undefined` on the shipped-default OFF path (`reconcile` unset) AND on any non-"dispatched"
// outcome, `trigger.notify(workspaceId, "fs_watch", outcome.workflowId)` on a fresh dispatch. Both pins stay
// entirely inside the EXISTING default-OFF gate (`config.reconcile` unset ⇒ `gateReconcile` returns undefined ⇒
// `reconcileNotifyForCapture` short-circuits before ever touching `.notify`) — nothing here flips a default.
import { describe, it, expect, vi } from "vitest";
import { WorkspaceIdSchema, RevisionIdSchema, type WorkspaceId, type RevisionId, type ParityReport } from "@sow/contracts";
import type { CanonicalVaultSnapshot } from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import type { RunReconcilePassDeps, ReconcileHealthSink } from "../../src/composition/parityReconcile";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import type { LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";
import type { CaptureOutcome } from "../../src/watch/vaultWatcher";
import { gateReconcile, reconcileNotifyForCapture, type ReconcileGateDeps, type ReconcileWiring } from "../../src/boot";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  return { workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) };
}

const reconcilerDeps = {
  newReportId: () => "report-1",
  newHealthItemId: () => "health-1",
  newAuditId: () => "audit-1",
  now: () => "2026-07-14T00:00:00.000Z",
};

function passDeps(recorder: ParityReportRecorder): RunReconcilePassDeps {
  const healthSink: ReconcileHealthSink = { record: () => Promise.resolve() };
  return { reconcilerDeps, recorder, healthSink };
}

function makeGateDeps(over: {
  reader?: CommittedVaultReader;
  recorder?: ParityReportRecorder;
  log?: (s: LoggedReconcileOutcome) => void;
} = {}) {
  const reader: CommittedVaultReader = over.reader ?? (() => undefined);
  const recorder: ParityReportRecorder = over.recorder ?? { record: () => Promise.resolve() };
  const log = over.log ?? ((_s: LoggedReconcileOutcome) => {});
  const deps: ReconcileGateDeps = {
    makeReader: () => reader,
    makeDbAdapter: () => undefined,
    makePassDeps: () => passDeps(recorder),
    makeLog: () => log,
  };
  return deps;
}

describe("gateReconcile — ON path now assembles a bound trigger too (task 19.4)", () => {
  it("wiring.trigger is defined and its notify() drives the SAME scheduler (a real report gets recorded)", async () => {
    const recorded: ParityReport[] = [];
    const recorder: ParityReportRecorder = { record: (r) => { recorded.push(r); return Promise.resolve(); } };
    const deps = makeGateDeps({ reader: () => snapshot({ "p.md": "hi" }), recorder });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    expect(wiring?.trigger).toBeDefined();
    expect(typeof wiring?.trigger.notify).toBe("function");

    // Drive the pass through trigger.notify() alone (never touching scheduler.enqueue/flush directly) — proves
    // the trigger is wired to the SAME scheduler this gate assembled, not a disconnected second instance.
    await wiring!.trigger.notify("ws-employer", "fs_watch", "rev:1");
    expect(recorded).toHaveLength(1);
  });

  it("off_path still constructs nothing — no trigger, no scheduler (byte-equivalent unchanged by the 19.4 addition)", () => {
    const deps = makeGateDeps({});
    expect(gateReconcile({ vaultRoot: "/vault" }, deps)).toBeUndefined();
  });
});

describe("reconcileNotifyForCapture — the pure vault-watcher → trigger decision (task 19.4)", () => {
  const dispatched: CaptureOutcome = { kind: "dispatched", workflowId: "wf-42", deduped: false };
  const ignored: CaptureOutcome = { kind: "ignored", reason: "not_markdown" };
  const extractFailed: CaptureOutcome = { kind: "extract_failed", code: "read_failed" as never };
  const dispatchFailed: CaptureOutcome = { kind: "dispatch_failed", code: "connect_failed" as never };
  const errored: CaptureOutcome = { kind: "error", message: "boom" };

  function fakeWiring(): { wiring: ReconcileWiring; notify: ReturnType<typeof vi.fn> } {
    const notify = vi.fn(() => Promise.resolve());
    const wiring = {
      scheduler: { enqueue: () => {}, flush: () => Promise.resolve() },
      trigger: { notify },
    } as unknown as ReconcileWiring;
    return { wiring, notify };
  }

  it("reconcile undefined (the shipped-default OFF path) ⇒ undefined, .notify is NEVER reached", () => {
    const { notify } = fakeWiring();
    const result = reconcileNotifyForCapture(undefined, "ws-employer", dispatched);
    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a dispatched outcome ⇒ calls trigger.notify(workspaceId, 'fs_watch', outcome.workflowId)", async () => {
    const { wiring, notify } = fakeWiring();
    const result = reconcileNotifyForCapture(wiring, "ws-employer", dispatched);
    expect(result).toBeDefined();
    await result;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("ws-employer", "fs_watch", "wf-42");
  });

  it.each([
    ["ignored", ignored],
    ["extract_failed", extractFailed],
    ["dispatch_failed", dispatchFailed],
    ["error", errored],
  ])("a non-dispatched outcome (%s) ⇒ undefined, .notify is NEVER called", (_label, outcome) => {
    const { wiring, notify } = fakeWiring();
    const result = reconcileNotifyForCapture(wiring, "ws-employer", outcome);
    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
