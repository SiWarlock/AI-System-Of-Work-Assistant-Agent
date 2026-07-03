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
];

export function seedDevStore(store: Store<UiSafeStoreState>): void {
  for (const event of SEED_EVENTS) {
    store.dispatch((s) => applyStreamEvent(s, event));
  }
  store.dispatch((s) => withConnection(s, "live"));
}
