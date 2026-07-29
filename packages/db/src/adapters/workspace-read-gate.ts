// Task 9.36 — the workspace REPOSITORY READ boundary re-gate (§4 / §5). Promotes contracts
// Lesson 76's rule ("an unchecked cast on a read path that feeds a write path is the last
// validation boundary you have left") from one pin to a repo-wide read contract for `Workspace`.
//
// THREAT MODEL (recorded so a future reader doesn't re-derive it): no production writer can
// ORIGINATE a referentially-inconsistent row — `defaultWorkspace()` (packages/contracts) wires
// both nested `workspaceId`s from `id` and Zod-parses before any insert, and the narrowed
// `updateProvisioningFields` write (task 9.30) never touches the posture columns at all. The
// ONLY path to a foreign nested `workspaceId` (or any other WorkspaceSchema violation) is an
// out-of-band edit — a sqlite-CLI hand-edit or a stale-snapshot restore (task 9.29's accepted
// residual). Before this slice, every repository read cast the raw row (`row as Workspace`),
// so that corruption was SERVED, not detected — including into `resolveWorkspacePolicy` (the §5
// egress veto's input) and a subsequent WRITE (`egressRevoke.ts`'s get-before-upsert).
//
// SINGLE-SOURCED across both dialects (sqlite + postgres) deliberately: two independent copies of
// this parse would drift the moment one changed (contracts L75/L39). Reuses the EXISTING
// `WorkspaceSchema` (packages/contracts) rather than re-implementing the referential check by
// hand — the schema's `.refine()` already IS that check; a hand-rolled duplicate would drift.
import { err, ok, WorkspaceSchema, type Result, type Workspace } from "@sow/contracts";
import type { DbError } from "../repositories/interfaces";

/**
 * Re-gate a stored workspace row through the FULL `WorkspaceSchema` — structural validity AND the
 * `id ≡ egressPolicy.workspaceId ≡ providerMatrix.workspaceId` referential pin. FAILS CLOSED,
 * NEVER NORMALIZES: a mismatched/malformed row is REJECTED, never coerced or rewritten — silently
 * fixing a foreign `workspaceId` would graft another workspace's allowlist + ack onto this one,
 * stamped as if it always belonged (WS-8-adjacent, and indistinguishable from legitimate to every
 * later reader).
 *
 * NAMING (corrected once already — see history): the code is `stored_row_schema_violation`, named
 * for what the gate actually catches — ANY `WorkspaceSchema` violation in a stored row, not only a
 * foreign nested `workspaceId`. The referential pin (`id ≡ egressPolicy.workspaceId ≡
 * providerMatrix.workspaceId`) is the MOTIVATING case — the one an out-of-band hand-edit is most
 * likely to produce — but a malformed enum member, a blank required field, or an unknown key
 * `.strict()` rejects surfaces under this same code, because a production writer cannot produce
 * ANY WorkspaceSchema violation (every writer parses before it writes) — every reachable failure
 * here is the identical out-of-band-corruption class, whichever field it happens to violate.
 *
 * Never throws. The raw `ZodError` is kept OPAQUE in `cause` — a composition-layer consumer must
 * never surface it (§16 / safety rule 7); only the stable `code` crosses further boundaries.
 */
export function parseStoredWorkspace(row: unknown): Result<Workspace, DbError> {
  const parsed = WorkspaceSchema.safeParse(row);
  if (!parsed.success) {
    return err({
      code: "stored_row_schema_violation",
      message: "stored workspace row failed re-validation at the repository read boundary",
      cause: parsed.error,
    });
  }
  return ok(parsed.data);
}

/**
 * Re-gate a LIST of stored workspace rows. Rejects the WHOLE call on the first inconsistent row
 * (task 9.36 Step-2.5 design question 2) rather than silently dropping/flagging it — there is
 * ZERO production consumer of `WorkspaceConfigRepository.list()` today (verified repo-wide), so
 * there is no live behavior to weigh a per-row alternative against, and "drop the bad row" is not
 * a universal default (contracts L44): a caller counting the returned set would silently undercount.
 */
export function parseStoredWorkspaceList(rows: readonly unknown[]): Result<Workspace[], DbError> {
  const out: Workspace[] = [];
  for (const row of rows) {
    const parsed = parseStoredWorkspace(row);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
}
