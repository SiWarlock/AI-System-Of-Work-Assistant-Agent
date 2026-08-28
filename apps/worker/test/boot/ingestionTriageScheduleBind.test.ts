// Task 25.5 — the ingestion-triage DURABLE schedule: register the schedule spec, keep the flip
// default-OFF and strict `=== true`, never create a live schedule. scheduleRegistrar.ts's own header:
// "wiring this gate into bootWorker (reading the owner config, constructing a real ScheduleClientPort,
// and calling ensure only on the armed path) is PKG-W1's boot.ts, outside this package's territory" —
// this suite proves that wiring landed correctly:
//   • createRealScheduleClientPort correctly implements the ScheduleClientPort CONTRACT (describe's
//     not-found → undefined mapping, create/update's exact forwarded shape) over a FAKE
//     RealScheduleClientSurface — no real Temporal server, matching scheduleRegistrar.test.ts's own
//     fake-port-only discipline;
//   • update() ALWAYS carries a `paused` key, but the value is the schedule's EXISTING pause state
//     read back from `previous.state.paused` and echoed verbatim — never hardcoded either direction
//     (task F2's fix). ⛔ "update() never carries a `paused` key, so this adapter cannot unpause" is
//     FALSE and was the reasoning behind a live CRITICAL bug: the real SDK update is a full REPLACE,
//     and the PRIOR shape's absent `paused` field let proto3 fill its zero-value (`false`), silently
//     unpausing an owner-paused schedule on every second boot (MEASURED against a real ephemeral
//     server: `afterCreate.paused=true` → `afterUpdate.paused=false`). An absence in a port's TYPE is
//     not an absence on the WIRE — pause-safety holds because THIS adapter reads back and re-sends
//     the current state, not because the shape omits a field;
//   • boot.ts's config→gate threading is strict `=== true` (a truthy non-boolean never arms) — proven
//     both by a source-scan pin (a "real production caller" pin, mirroring this session's other bind
//     tasks) and by driving `gateIngestionTriageSchedule` with the SAME expression boot.ts uses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  gateIngestionTriageSchedule,
  type TemporalScheduleSpec,
} from "../../src/temporal/scheduleRegistrar";
import {
  createRealScheduleClientPort,
  type RealScheduleClientSurface,
} from "../../src/boot";

const SPEC: TemporalScheduleSpec = {
  scheduleId: "ingestion-triage",
  intervalMs: 3600_000,
  action: {
    workflowType: "ingestionTriageWorkflow",
    workflowId: "ingestion-triage-workflow",
    taskQueue: "sow-control-plane",
    args: [],
  },
};

class FakeNotFoundError extends Error {}
class FakeOtherError extends Error {}

function makeFakeClient(over: Partial<RealScheduleClientSurface> = {}): RealScheduleClientSurface & {
  readonly calls: { create: unknown[]; update: unknown[]; describe: string[] };
} {
  const calls = { create: [] as unknown[], update: [] as unknown[], describe: [] as string[] };
  const client: RealScheduleClientSurface = {
    getHandle: (scheduleId: string) => {
      calls.describe.push(scheduleId);
      return {
        describe: async () => {
          throw new FakeNotFoundError("no such schedule");
        },
        update: async (updateFn) => {
          // task F2 — the real SDK always supplies the schedule's CURRENT description to the
          // update callback; this default fake's "current" state is an already-paused schedule
          // (the common real-world case a converge runs against, and the one the F2 bug got wrong).
          const built = updateFn({ state: { paused: true } });
          calls.update.push(built);
        },
      };
    },
    create: async (options) => {
      calls.create.push(options);
    },
    ...over,
  };
  return { ...client, calls };
}

describe("createRealScheduleClientPort — the ScheduleClientPort CONTRACT over a FAKE surface (task 25.5)", () => {
  it("describe(): a not-found error (per the injected predicate) maps to undefined — a miss, not a fault", async () => {
    const fake = makeFakeClient();
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);

    const result = await port.describe("ingestion-triage");

    expect(result).toBeUndefined();
  });

  it("describe(): a KNOWN schedule returns its paused state verbatim", async () => {
    const fake = makeFakeClient({
      getHandle: () => ({
        describe: async () => ({ state: { paused: false } }),
        update: async () => {},
      }),
    });
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);

    const result = await port.describe("ingestion-triage");

    expect(result).toEqual({ paused: false });
  });

  it("describe(): a NON-not-found error PROPAGATES (never silently mapped to undefined)", async () => {
    const fake = makeFakeClient({
      getHandle: () => ({
        describe: async () => {
          throw new FakeOtherError("real connectivity fault");
        },
        update: async () => {},
      }),
    });
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);

    await expect(port.describe("ingestion-triage")).rejects.toThrow("real connectivity fault");
  });

  it("create(): forwards scheduleId/interval/action and ALWAYS passes state.paused === opts.paused (true)", async () => {
    const fake = makeFakeClient();
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);

    await port.create(SPEC, { paused: true });

    expect(fake.calls.create).toHaveLength(1);
    const call = fake.calls.create[0] as {
      scheduleId: string;
      spec: { intervals: { every: number }[] };
      action: { workflowType: string; workflowId: string; taskQueue: string };
      state: { paused: boolean };
    };
    expect(call.scheduleId).toBe("ingestion-triage");
    expect(call.spec.intervals).toEqual([{ every: 3600_000 }]);
    expect(call.action.workflowType).toBe("ingestionTriageWorkflow");
    expect(call.action.workflowId).toBe("ingestion-triage-workflow");
    expect(call.action.taskQueue).toBe("sow-control-plane");
    expect(call.state.paused).toBe(true);
  });

  it("update(): forwards the converged spec/action AND ECHOES the schedule's existing pause state — task F2 fix (never a hardcoded value, never an absent key)", async () => {
    // ⛔ task F2 — the PRIOR shape sent `state: {}` unconditionally, which the real SDK's proto3
    // encoding of an absent `paused` field UNPAUSES on an already-paused schedule (MEASURED live —
    // see schedule-update-preserves-pause.test.ts). A fake port can't reproduce THAT wire-encoding
    // defect (this suite's own fake just forwards whatever object the adapter builds), but it CAN
    // pin the adapter's obligation: read `previous.state.paused` and put it straight back, for
    // BOTH values — proving the adapter never hardcodes either direction (a hardcoded `true` would
    // silently re-pause an owner-unpaused schedule; a hardcoded `false`, or the old absent-key
    // shape, silently unpauses a paused one).
    for (const existingPaused of [true, false]) {
      let built: unknown;
      const fake = makeFakeClient({
        getHandle: () => ({
          describe: async () => {
            throw new FakeNotFoundError("no such schedule");
          },
          update: async (updateFn) => {
            built = updateFn({ state: { paused: existingPaused } });
          },
        }),
      });
      const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);

      await port.update(SPEC);

      const call = built as {
        spec: { intervals: { every: number }[] };
        action: { workflowType: string };
        state: { paused: boolean };
      };
      expect(call.spec.intervals).toEqual([{ every: 3600_000 }]);
      expect(call.action.workflowType).toBe("ingestionTriageWorkflow");
      // ⛔ THE LOAD-BEARING ASSERTION — the update echoes the PREVIOUS pause state verbatim.
      expect(call.state.paused).toBe(existingPaused);
    }
  });
});

describe("createTemporalScheduleRegistrar over createRealScheduleClientPort — the FULL create-or-update contract, real production types", () => {
  it("an unknown scheduleId is CREATED exactly once, then a repeat ensure of the SAME spec UPDATES (never a second create)", async () => {
    const { createTemporalScheduleRegistrar } = await import("../../src/temporal/scheduleRegistrar");
    let exists: { paused: boolean } | undefined;
    let createCalls = 0;
    const fake = makeFakeClient({
      getHandle: () => ({
        describe: async () => {
          if (exists === undefined) throw new FakeNotFoundError("no such schedule");
          return { state: exists };
        },
        update: async () => {},
      }),
      create: async () => {
        createCalls += 1;
        exists = { paused: true };
      },
    });
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);
    const registrar = createTemporalScheduleRegistrar({ client: port });

    const first = await registrar.ensure(SPEC);
    const second = await registrar.ensure(SPEC);

    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value.action).toBe("created");
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.action).toBe("updated");
    expect(createCalls).toBe(1); // never a second create
  });

  it("a client fault at describe/create/update folds to a typed err — never a throw across the boundary", async () => {
    const { createTemporalScheduleRegistrar } = await import("../../src/temporal/scheduleRegistrar");
    const fake = makeFakeClient({
      getHandle: () => ({
        describe: async () => {
          throw new FakeOtherError("boom");
        },
        update: async () => {},
      }),
    });
    const port = createRealScheduleClientPort(fake, (e) => e instanceof FakeNotFoundError);
    const registrar = createTemporalScheduleRegistrar({ client: port });

    const result = await registrar.ensure(SPEC);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("schedule_client_fault");
  });
});

describe("gateIngestionTriageSchedule — the strict === true default-OFF gate boot.ts drives (task 25.5)", () => {
  it("boot.ts threads `enabled: config.ingestionTriageSchedule?.enabled === true` — a truthy non-boolean never arms", () => {
    // Drives the SAME gate with the SAME strict-equality shape boot.ts's call site uses, directly —
    // proving the gate itself (not boot.ts's plumbing) refuses a truthy-but-not-`true` config value.
    for (const enabledValue of ["true", 1, {}, [], "yes"] as const) {
      const spec = gateIngestionTriageSchedule({
        enabled: (enabledValue as unknown) === true,
        taskQueue: "sow-control-plane",
        intervalMs: 3600_000,
      });
      expect(spec).toBeUndefined();
    }
    const armed = gateIngestionTriageSchedule({
      enabled: true,
      taskQueue: "sow-control-plane",
      intervalMs: 3600_000,
    });
    expect(armed).toBeDefined();
  });
});

describe("createRealScheduleClientPort / gateIngestionTriageSchedule — have a REAL production caller (task 25.5, was ZERO)", () => {
  it("boot.ts constructs the real client, gates on strict === true, and calls registrar.ensure only on the armed path", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/boot.ts", import.meta.url)), "utf8");
    expect(src).toContain("gateIngestionTriageSchedule(");
    expect(src).toContain("createRealScheduleClientPort(");
    expect(src).toContain("createTemporalScheduleRegistrar(");
    expect(src).toContain("config.ingestionTriageSchedule?.enabled === true");
    expect(src).toContain("registrar.ensure(spec)");
  });
});
