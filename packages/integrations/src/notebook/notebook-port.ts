// @sow/integrations — 6.6 NotebookPort (the notebooklm.sync seam, §8/§15).
//
// NotebookLM's five managed docs (00 Brief / 01 Decisions / 02 Meeting Digest /
// 03 Research / 04 Open Questions) are kept in Drive and refreshed IN PLACE by
// `notebooklm.sync`. This port is the boundary the worker calls; the concrete
// implementation (`notebooklm-sync.ts`) upserts each slot THROUGH the Tool
// Gateway / Drive adapter so re-sync is idempotent — no duplicate Drive docs on
// replay (safety invariant 2).
//
// SCOPE (arch_gap / §15): the direct NotebookLM API is V1.1/spike-gated, so this
// port is Drive-backed ONLY — it never talks to NotebookLM directly. A slot whose
// managed source is missing/unlinked surfaces a typed `reattach_required` state
// (re-add/refresh the NotebookLM source), NEVER a silent failure.
//
// §16: `sync` returns a typed `Result<NotebookSyncResult, NotebookError>`; it
// never throws across the boundary. The failure set is closed + enumerable.
import type { Result, NotebookMapping } from "@sow/contracts";

/**
 * The five NotebookLM managed-doc slots, in canonical 00→04 order. This is the
 * exact key set of `NotebookMapping.managedDocIds` (frozen by the seam model's
 * `.strict()` schema); the sync iterates it so slot handling can never drift from
 * the mapping shape.
 */
export const NOTEBOOK_SLOTS = [
  "00_brief",
  "01_decisions",
  "02_meetings",
  "03_research",
  "04_open_questions",
] as const;

/** One of the five 00–04 managed-doc slots. */
export type NotebookSlot = (typeof NOTEBOOK_SLOTS)[number];

/**
 * The assembled Markdown body for each of the five slots. The assembly SOURCE is
 * upstream (committed Markdown → these strings); the port receives the bodies and
 * upserts them. Exactly the five 00–04 slots, mirroring `managedDocIds`.
 */
export type ManagedDocBodies = Readonly<Record<NotebookSlot, string>>;

/**
 * The outcome of a full five-slot sync. `upserted` — slots whose Drive doc was
 * created or already present (reused) through the gateway. `reattachRequired` —
 * slots whose managed source is missing/unlinked (a blank mapping id or an
 * adapter-404), which the operator must re-add/refresh in NotebookLM.
 * `heldForRetry` — slots whose Drive write could not proceed because the target
 * was unreachable (an outage) and which were therefore HELD in the write outbox
 * for a replay-safe drain later (only possible when the sync is wired with an
 * outbox; §8 hold-through-outage, never a dropped write). The three lists
 * partition the attempted slots; none hides a slot silently.
 */
export interface NotebookSyncResult {
  readonly upserted: NotebookSlot[];
  readonly reattachRequired: NotebookSlot[];
  readonly heldForRetry: NotebookSlot[];
}

/**
 * The closed, enumerable failure set for a sync (§16). `dispatch_failed` — a slot
 * upsert faulted in a way that is neither a successful upsert nor a reattach
 * signal (a hold/conflict/rejected from the gateway that is not a 404), so the
 * whole sync fails closed rather than reporting a partial success as clean.
 * `gate_rejected` — an envelope failed the candidate-gate (should not happen for
 * well-formed input; surfaced rather than swallowed).
 */
export interface NotebookError {
  readonly code: "dispatch_failed" | "gate_rejected";
  readonly slot: NotebookSlot;
  readonly message: string;
}

/**
 * The NotebookPort seam. `sync` upserts all five managed docs for `mapping`
 * from `bodies`, returning a typed Result. Deterministic apart from the injected
 * deps carried by the implementation (see `notebooklm-sync.ts`); never throws.
 */
export interface NotebookPort {
  sync(
    mapping: NotebookMapping,
    bodies: ManagedDocBodies,
  ): Promise<Result<NotebookSyncResult, NotebookError>>;
}
