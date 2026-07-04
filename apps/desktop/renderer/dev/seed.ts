import { failureClassSchema, healthStateSchema } from "@sow/contracts/models/shared-enums";
import type { StreamEvent } from "@sow/contracts/api/events";
import type { Store, UiSafeStoreState } from "../store";
import { applyStreamEvent, withConnection } from "../store/projections";

// DEV-ONLY seed. Hydrates the store with sample UI-safe projections so the Today
// surface renders populated BEFORE the live worker is wired (9.4b). App gates this
// on `import.meta.env.DEV`, so it never runs in a production build. The shapes are
// exactly what the §10 push stream delivers — swapping in the live stream is a
// drop-in (same store, same reducer).
const ISO = "2026-07-03T09:12:00.000Z";
const failureClass = failureClassSchema.options[0];
const healthState = healthStateSchema.options[0];

const SEED_EVENTS: readonly StreamEvent[] = [
  {
    name: "read_model.change",
    seq: 1,
    eventId: "seed-1",
    payload: { cardId: "approvals", kind: "approvals", title: "Approvals", status: "warn", count: 3, updatedAt: ISO },
  },
  {
    name: "read_model.change",
    seq: 2,
    eventId: "seed-2",
    payload: { cardId: "triage", kind: "ingestion", title: "To triage", status: "ok", count: 5, updatedAt: ISO },
  },
  {
    name: "system.health",
    seq: 3,
    eventId: "seed-3",
    payload: { id: "granola", failureClass, severity: "warning", state: healthState, openedAt: ISO },
  },
  // §9.8: sample pending approvals so the Approval-inbox surface renders populated in
  // dev-without-worker (UI-safe shape — the same `approval.update` payload the stream
  // carries: ids + status + channel + timing only, no raw content).
  {
    name: "approval.update",
    seq: 4,
    eventId: "seed-4",
    payload: { id: "apr-cal-1", actionRef: "calendar.create:team-sync", status: "pending", channel: "mac" },
  },
  {
    name: "approval.update",
    seq: 5,
    eventId: "seed-5",
    payload: { id: "apr-mail-1", actionRef: "gmail.send:draft-4c2", status: "pending", channel: "mac" },
  },
  {
    name: "approval.update",
    seq: 6,
    eventId: "seed-6",
    payload: {
      id: "apr-linear-1",
      actionRef: "linear.create:ENG-311",
      status: "deferred",
      channel: "telegram",
      snoozeUntil: "2026-07-05T09:00:00.000Z",
      expiresAt: "2026-07-10T09:00:00.000Z",
    },
  },
];

export function seedDevStore(store: Store<UiSafeStoreState>): void {
  for (const event of SEED_EVENTS) {
    store.dispatch((s) => applyStreamEvent(s, event));
  }
  store.dispatch((s) => withConnection(s, "live"));
}
