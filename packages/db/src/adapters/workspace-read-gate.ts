// Task 9.36 — the workspace REPOSITORY READ boundary re-gate (§4 / §5). Promotes contracts
// Lesson 76's rule ("an unchecked cast on a read path that feeds a write path is the last
// validation boundary you have left") from one pin to a repo-wide read contract for `Workspace`.
//
// THREAT MODEL — REWRITTEN task 24.97 leg (b). The PRIOR version of this block claimed the
// ONLY path to a WorkspaceSchema violation in a stored row was an out-of-band edit. That was
// true when written and is FALSE now: `WorkspaceIdSchema` (packages/contracts) was tightened
// (task 24.84) to a bounded slug shape, and re-validation on READ (this file) applies that
// tightened shape to rows a production writer put there BEFORE the tightening landed. Two
// distinct populations reach this gate's rejection branch, and only one of them is corruption:
//
//   (i) OUT-OF-BAND CORRUPTION — the original case. `defaultWorkspace()` wires both nested
//       `workspaceId`s from `id` and Zod-parses before any insert, and the narrowed
//       `updateProvisioningFields` write (task 9.30) never touches the posture columns at all —
//       so no IN-PROCESS production writer can originate this. The only route is a sqlite-CLI
//       hand-edit or a stale-snapshot restore (task 9.29's accepted residual).
//
//   (ii) A PRE-BRAND LEGACY ROW — an id an ordinary, in-contract production writer wrote BEFORE
//        task 24.84 landed, that the now-tightened `WorkspaceIdSchema` rejects. NAMED BY
//        PROPERTY, not by anecdote, so the definition outlives any task number: a stored
//        workspace id failing `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` or exceeding 64 characters. This
//        writer was never at fault — the row was valid under the schema that governed it at
//        write time.
//
// Population (ii) is NOT remediated by this file. Task 24.106 (open, owner-deprioritised on a
// zero-non-conforming-row measurement on one deployment at one moment — other installs
// unmeasured) owns making that population readable again, and must be RE-AUTHORISED before
// anyone builds a compatibility/coercion path here.
//
// Before task 9.36, every repository read cast the raw row (`row as Workspace`), so EITHER
// population's corruption was SERVED, not detected — including into `resolveWorkspacePolicy`
// (the §5 egress veto's input) and a subsequent WRITE (`egressRevoke.ts`'s get-before-upsert).
//
// DISPOSITION (task 24.97 leg (b)): the gate STAYS FAIL-CLOSED FOR BOTH POPULATIONS. A
// legacy-shaped row is REJECTED with `stored_row_schema_violation` — never coerced, never
// normalised, never silently rewritten to a conforming slug, exactly like out-of-band
// corruption. Silently rewriting an id would change workspace IDENTITY, and identity is what
// WS-8 cross-workspace isolation and the §5 egress veto KEY ON — a coerced id could graft
// another workspace's allowlist and acknowledgment onto this one, indistinguishable from
// legitimate to every later reader. Rejection is legible (a caller sees a typed failure and can
// escalate); coercion is not (a caller would see success over a value that silently changed
// meaning). The accepted cost: population (ii) can STRAND a get-before-upsert caller — see
// `egressRevoke.ts`'s `revokeEgressAck`, whose GET reads through this gate before its upsert —
// leaving that workspace's emergency egress-off control unusable until 24.106 lands. That is a
// safety-rule-5-adjacent consequence and is routed accordingly, not silently absorbed here.
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
 * likely to produce — but a malformed enum member, a blank required field, an unknown key
 * `.strict()` rejects, or a pre-brand `id` shape (module docblock population (ii)) all surface
 * under this same code. NOT every reachable failure here is out-of-band corruption — see the
 * module docblock above for the two-population account this naming section used to omit.
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
