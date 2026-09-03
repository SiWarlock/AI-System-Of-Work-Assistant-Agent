// The known connector vendors offered by the Connectors surface (a UI convenience list; the worker
// validates the id). Extracted from the surface so pure logic + tests can reference it without
// importing a `window`-coupled component (desktop LESSONS §3).
export const KNOWN_CONNECTORS = [
  "drive",
  "calendar",
  "linear",
  "granola",
  "github",
  "gmail",
  "asana",
  "todoist",
] as const;
export type KnownConnector = (typeof KNOWN_CONNECTORS)[number];
