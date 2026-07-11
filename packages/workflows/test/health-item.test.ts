// spec(§9 / §16 OBS-2) — slice 7.5 System-Health MATERIALIZER (activities/healthItem.ts).
//
// This discharges the Phase-6 carry-forward: a GatewayHealthSignal is turned into
// a PERSISTED HealthItem here (§9 owns materialization — state, timestamps,
// persistence). The materializer is an ACTIVITY (it may touch adapters), but its
// LOGIC is exercised here with an in-memory HealthItemStore fake + an injected
// clock — no Temporal server, no real DB, no Date.now().
//
// Invariants pinned (§9.11 / §16):
//   • ONE DISTINCT item per (failureClass, subjectRef) — dedupe identity.
//   • A RECURRING failure UPDATES the existing item, never spawns a duplicate.
//   • lifecycle open → acknowledged | resolved (resolved terminal; resolvedAt IFF
//     resolved). An item AUTO-RESOLVES when its underlying condition clears.
//   • openedAt from the INJECTED clock (no Date.now()); severity default 'warn'.
//   • §16 error convention: never throws — returns a typed Result with an
//     ENUMERABLE closed failure set.
import { describe, it, expect } from "vitest";
import { isOk, isErr, auditId } from "@sow/contracts";
import type { HealthItem } from "@sow/contracts";
import {
  materializeHealthItem,
  resolveHealthItem,
  acknowledgeHealthItem,
  healthItemDedupeKey,
  HEALTH_ITEM_DEFAULT_SEVERITY,
  defaultSeverityForFailureClass,
} from "../src/activities/healthItem";
import { FakeClock, InMemoryHealthItemStore } from "./support/fakes";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T01:00:00.000Z";
const T2 = "2026-07-01T02:00:00.000Z";

describe("spec(§9) healthItemDedupeKey — dedupe identity is (failureClass, subjectRef)", () => {
  it("is stable + independent of message/severity/audit", () => {
    const a = healthItemDedupeKey("connector_unreachable", "connector-gmail");
    const b = healthItemDedupeKey("connector_unreachable", "connector-gmail");
    expect(a).toBe(b);
  });

  it("distinguishes different failure classes for the same subject", () => {
    const a = healthItemDedupeKey("connector_unreachable", "x");
    const b = healthItemDedupeKey("write_through_failed", "x");
    expect(a).not.toBe(b);
  });

  it("distinguishes different subjects for the same failure class", () => {
    const a = healthItemDedupeKey("connector_unreachable", "connector-gmail");
    const b = healthItemDedupeKey("connector_unreachable", "connector-slack");
    expect(a).not.toBe(b);
  });
});

describe("spec(§9) materializeHealthItem — distinct-per-class + open lifecycle", () => {
  it("creates ONE distinct persisted item per OBS-2 failure class", async () => {
    const store = new InMemoryHealthItemStore();
    const clock = new FakeClock({ now: T0 });

    const classes = [
      "connector_unreachable",
      "write_through_failed",
      "budget_breach",
      "missed_or_late_schedule",
      "schema_rejection",
    ] as const;
    for (const failureClass of classes) {
      const res = await materializeHealthItem(
        {
          failureClass,
          subjectRef: "subject-1",
          message: `${failureClass} occurred`,
          auditRef: auditId("audit-1"),
          now: clock.now(),
        },
        store,
      );
      expect(isOk(res)).toBe(true);
    }

    const items = await store.list();
    expect(items).toHaveLength(classes.length);
    // Every distinct class present exactly once.
    const seen = new Set(items.map((i) => i.failureClass));
    expect(seen.size).toBe(classes.length);
  });

  it("stamps openedAt from the injected clock (never Date.now()) + defaults severity to 'warn'", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await materializeHealthItem(
      {
        failureClass: "budget_breach",
        subjectRef: "job-42",
        message: "budget breached",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.openedAt).toBe(T0);
    expect(res.value.state).toBe("open");
    expect(res.value.resolvedAt).toBeUndefined();
    expect(res.value.severity).toBe(HEALTH_ITEM_DEFAULT_SEVERITY);
    expect(HEALTH_ITEM_DEFAULT_SEVERITY).toBe("warn");
  });

  it("honors an explicit severity when provided", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await materializeHealthItem(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        severity: "error",
        message: "worker down",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.severity).toBe("error");
  });
});

describe("spec(§9) materializeHealthItem — recurring failure UPDATES, never duplicates", () => {
  it("a second failure of the SAME (class, subject) updates the existing item in place", async () => {
    const store = new InMemoryHealthItemStore();

    const first = await materializeHealthItem(
      {
        failureClass: "connector_unreachable",
        subjectRef: "connector-gmail",
        message: "unreachable: timeout",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const second = await materializeHealthItem(
      {
        failureClass: "connector_unreachable",
        subjectRef: "connector-gmail",
        message: "unreachable: connection refused",
        auditRef: auditId("audit-2"),
        now: T1,
      },
      store,
    );
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;

    // Exactly ONE item — no duplicate spawned.
    const items = await store.list();
    expect(items).toHaveLength(1);
    // openedAt is preserved from the FIRST occurrence; id is stable.
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.openedAt).toBe(T0);
    // The latest message + audit are reflected.
    expect(second.value.message).toContain("connection refused");
    expect(second.value.auditRef).toBe(auditId("audit-2"));
    // Still open (recurrence does not resolve).
    expect(second.value.state).toBe("open");
  });

  it("a recurrence of an ACKNOWLEDGED item keeps it acknowledged (does not reopen to 'open')", async () => {
    const store = new InMemoryHealthItemStore();
    const opened = await materializeHealthItem(
      {
        failureClass: "missed_or_late_schedule",
        subjectRef: "sched-daily",
        message: "late",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    expect(isOk(opened)).toBe(true);

    const ackd = await acknowledgeHealthItem(
      { failureClass: "missed_or_late_schedule", subjectRef: "sched-daily" },
      store,
    );
    expect(isOk(ackd)).toBe(true);
    if (!isOk(ackd)) return;
    expect(ackd.value?.state).toBe("acknowledged");

    const recur = await materializeHealthItem(
      {
        failureClass: "missed_or_late_schedule",
        subjectRef: "sched-daily",
        message: "late again",
        auditRef: auditId("audit-3"),
        now: T2,
      },
      store,
    );
    expect(isOk(recur)).toBe(true);
    if (!isOk(recur)) return;
    expect(recur.value.state).toBe("acknowledged");
    expect((await store.list())).toHaveLength(1);
  });

  it("a NEW failure after the item RESOLVED re-opens a fresh open item (resolved is terminal)", async () => {
    const store = new InMemoryHealthItemStore();
    await materializeHealthItem(
      {
        failureClass: "connector_unreachable",
        subjectRef: "connector-gmail",
        message: "down",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    const resolved = await resolveHealthItem(
      { failureClass: "connector_unreachable", subjectRef: "connector-gmail", now: T1 },
      store,
    );
    expect(isOk(resolved)).toBe(true);

    const reopened = await materializeHealthItem(
      {
        failureClass: "connector_unreachable",
        subjectRef: "connector-gmail",
        message: "down again",
        auditRef: auditId("audit-3"),
        now: T2,
      },
      store,
    );
    expect(isOk(reopened)).toBe(true);
    if (!isOk(reopened)) return;
    expect(reopened.value.state).toBe("open");
    // openedAt tracks the NEW occurrence (the prior item was terminal).
    expect(reopened.value.openedAt).toBe(T2);
    expect(reopened.value.resolvedAt).toBeUndefined();
    // Still one distinct item under the dedupe key (the resolved one was upserted).
    expect((await store.list())).toHaveLength(1);
  });
});

describe("spec(§9) resolveHealthItem — auto-resolve on clear (resolvedAt IFF resolved)", () => {
  it("resolves an open item: state=resolved + resolvedAt set from the injected clock", async () => {
    const store = new InMemoryHealthItemStore();
    await materializeHealthItem(
      {
        failureClass: "write_through_failed",
        subjectRef: "obj-key-1",
        message: "blocked",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );

    const resolved = await resolveHealthItem(
      { failureClass: "write_through_failed", subjectRef: "obj-key-1", now: T1 },
      store,
    );
    expect(isOk(resolved)).toBe(true);
    if (!isOk(resolved)) return;
    const item = resolved.value;
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.state).toBe("resolved");
    expect(item.resolvedAt).toBe(T1);
    // Contract invariant: resolvedAt present IFF resolved.
    expect(item.resolvedAt !== undefined).toBe(item.state === "resolved");
    expect((await store.list())).toHaveLength(1);
  });

  it("resolving when NO item exists is an idempotent no-op success (auto-resolve on a clear condition that never opened)", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await resolveHealthItem(
      { failureClass: "connector_unreachable", subjectRef: "never-opened", now: T1 },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value).toBeUndefined();
    expect((await store.list())).toHaveLength(0);
  });

  it("resolving an already-resolved item is an idempotent no-op (resolved is terminal)", async () => {
    const store = new InMemoryHealthItemStore();
    await materializeHealthItem(
      {
        failureClass: "budget_breach",
        subjectRef: "job-9",
        message: "over budget",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    const first = await resolveHealthItem(
      { failureClass: "budget_breach", subjectRef: "job-9", now: T1 },
      store,
    );
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const second = await resolveHealthItem(
      { failureClass: "budget_breach", subjectRef: "job-9", now: T2 },
      store,
    );
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    // Terminal: the resolvedAt is NOT overwritten by the second resolve.
    const items = await store.list();
    expect(items).toHaveLength(1);
    const only = items[0] as HealthItem;
    expect(only.state).toBe("resolved");
    expect(only.resolvedAt).toBe(T1);
  });

  it("every materialized item is schema-valid: resolvedAt present IFF state === 'resolved'", async () => {
    const store = new InMemoryHealthItemStore();
    await materializeHealthItem(
      {
        failureClass: "schema_rejection",
        subjectRef: "candidate-1",
        message: "rejected by gate",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      store,
    );
    await resolveHealthItem(
      { failureClass: "schema_rejection", subjectRef: "candidate-1", now: T1 },
      store,
    );
    for (const item of await store.list()) {
      expect((item.resolvedAt !== undefined)).toBe(item.state === "resolved");
    }
  });
});

describe("spec(§16) materializeHealthItem — typed failure, never throws", () => {
  it("returns a typed err (not a throw) when the store rejects the write", async () => {
    // A store whose put rejects — the materializer must convert it to a typed err.
    const failingStore = {
      getByDedupeKey(): Promise<HealthItem | undefined> {
        return Promise.resolve(undefined);
      },
      put(): Promise<void> {
        return Promise.reject(new Error("db down"));
      },
      list(): Promise<HealthItem[]> {
        return Promise.resolve([]);
      },
    };
    const res = await materializeHealthItem(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
        now: T0,
      },
      failingStore,
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("persist_failed");
  });
});

// --- C-enum: per-class default severity (elevate security/isolation) --------

describe("defaultSeverityForFailureClass + the materializer severity default (§16)", () => {
  it("elevates security/isolation → critical, policy/egress → error; every existing class stays warn — spec(§16)", () => {
    expect(defaultSeverityForFailureClass("security_violation")).toBe("critical");
    expect(defaultSeverityForFailureClass("isolation_breach")).toBe("critical");
    expect(defaultSeverityForFailureClass("policy_denial")).toBe("error");
    expect(defaultSeverityForFailureClass("egress_denied")).toBe("error");
    for (const fc of [
      "connector_unreachable",
      "write_through_failed",
      "budget_breach",
      "missed_or_late_schedule",
      "schema_rejection",
      "worker_down",
      "parity_defect",
      "conflict_review",
      "sync_lagging",
      "rebuild_divergence",
    ] as const) {
      expect(defaultSeverityForFailureClass(fc)).toBe(HEALTH_ITEM_DEFAULT_SEVERITY);
    }
  });

  it("a security_violation health item surfaces at critical when the producer omits severity — spec(§16)", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await materializeHealthItem(
      { failureClass: "security_violation", subjectRef: "src-1", message: "injection detected", auditRef: auditId("audit-1"), now: T0 },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.severity).toBe("critical");
  });

  it("a producer-supplied severity WINS over the class default — spec(§16)", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await materializeHealthItem(
      { failureClass: "security_violation", subjectRef: "src-2", severity: "warn", message: "x", auditRef: auditId("audit-1"), now: T0 },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.severity).toBe("warn");
  });

  it("an existing class with no severity keeps warn (no regression) — spec(§16)", async () => {
    const store = new InMemoryHealthItemStore();
    const res = await materializeHealthItem(
      { failureClass: "connector_unreachable", subjectRef: "conn-1", message: "x", auditRef: auditId("audit-1"), now: T0 },
      store,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.severity).toBe(HEALTH_ITEM_DEFAULT_SEVERITY);
  });
});
