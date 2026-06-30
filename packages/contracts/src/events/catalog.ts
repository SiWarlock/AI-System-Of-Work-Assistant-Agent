// Event-name catalog (1.1) — the single const-union source of truth for the §10
// push stream (workflow status, approval update, System Health, read-model change).
// Renderer-importable; carries no secrets/raw data (names only).

export const EventName = [
  "workflow.status",
  "approval.update",
  "system.health",
  "read_model.change",
] as const;
export type EventName = (typeof EventName)[number];

export const isEventName = (v: unknown): v is EventName =>
  typeof v === "string" && (EventName as readonly string[]).includes(v);
