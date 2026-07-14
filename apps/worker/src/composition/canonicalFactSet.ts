// Task 13.10 (reconcile-TRIGGER arc, piece C) — the committed-vault → CanonicalFactSet composition. spec(§6) spec(§12)
//
// buildCanonicalFactSet is the thin worker-side composition that produces piece A's `req.canonicalSet`: it reads
// the committed vault @ head via the injected `CommittedVaultReader`, runs the pure `deriveCanonicalFacts` over
// the resulting `CanonicalVaultSnapshot`, and returns a 3-WAY fail-closed outcome that DISTINGUISHES a benign
// absence from a real derive error (so piece D can route the error to health while skipping on an absence):
//   • { kind: "derived", set }        — a readable vault derived cleanly (the canonical "what SHOULD exist" set);
//   • { kind: "absent" }              — no/empty vault (reader `undefined`) OR a contract-violating reader
//                                        throw/reject — a BENIGN skip (no canonical reference ⇒ don't reconcile);
//   • { kind: "derive_error", error } — a structurally-broken vault (`duplicate_fact_identity` / `invalid_page_path`
//                                        / `schema_invalid`) — a real defect, NOT collapsed into `absent`.
//
// Never throws (§16): the `CommittedVaultReader` contract is never-throw, but a belt-and-suspenders try/catch maps
// a (contract-violating) throw/reject to `absent`; `deriveCanonicalFacts` is total. Owns COMPOSITION only.
//
// NAMED GAP (Step-2.5 #2, owner-gated follow-up — NOT silently owned here): `createCommittedVaultReader` collapses
// an EMPTY vault (zero committed `.md`) to `undefined` with no head revision, so this helper returns `absent` for
// it — indistinguishable from "no vault mapped". Consequence: an empty vault + a POPULATED DB projection (whose
// facts would ALL be `db_only` HARD parity defects, safety rule 1) is SKIPPED, not caught, by piece D. Catching it
// needs a `CommittedVaultReader` change to surface an empty snapshot WITH a head revision (piece C can't synthesize
// a `CanonicalFactSet` without a revision) — reachable only once real corpora exist at the owner-gated arming.
//
// DORMANT + reachability-waivered: no production caller (piece D wires this helper's output as
// runReconcilePass's req.canonicalSet); LOCAL-fs only (the reader is injected — a fake in tests, NOT a gbrain line).
import { isErr } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalFactSet,
  type CanonicalVaultSnapshot,
  type DeriveError,
} from "@sow/knowledge";
import type { CommittedVaultReader } from "../api/procedures/servingContextLoader";

/** The 3-way fail-closed outcome of one canonical-snapshot read + derive (Step-2.5 #1). */
export type CanonicalSnapshotOutcome =
  | { readonly kind: "derived"; readonly set: CanonicalFactSet }
  | { readonly kind: "absent" }
  | { readonly kind: "derive_error"; readonly error: DeriveError };

/**
 * Read the committed vault @ head via the injected reader and derive the `CanonicalFactSet`, or return a typed
 * `absent` / `derive_error`. Never throws — a reader that (against its contract) throws/rejects degrades to
 * `absent`. `deriveCanonicalFacts` is pure + gbrain-independent (the trusted reference side of the parity diff).
 */
export async function buildCanonicalFactSet(
  reader: CommittedVaultReader,
  workspaceId: string,
): Promise<CanonicalSnapshotOutcome> {
  let snapshot: CanonicalVaultSnapshot | undefined;
  try {
    // The reader is SYNC-or-ASYNC; `await` handles both (a no-op on a non-Promise). The try wraps the CALL so a
    // synchronous throw is caught too, not just an async rejection.
    snapshot = await reader(workspaceId);
  } catch {
    return { kind: "absent" }; // a contract-violating reader throw/reject ⇒ benign absence, never propagated
  }
  if (snapshot === undefined) {
    return { kind: "absent" }; // unmapped / empty vault / reader fault — no canonical reference to reconcile
  }
  // WS-8 read-back identity re-gate (Lesson 12): the reader is the enumeration-confinement boundary, but we do
  // NOT trust it to have returned the REQUESTED workspace — a snapshot stamped for a different workspace is never
  // fed into the parity diff (a cross-workspace canonical reference would corrupt the verdict). A contract-abiding
  // reader always matches, so this fires only on a reader defect ⇒ benign skip. (Piece D may add a distinct
  // ws-mismatch health signal on top if desired; re-gating at the read-back point here is strictly safer.)
  if ((snapshot.workspaceId as string) !== workspaceId) {
    return { kind: "absent" };
  }
  const derived = deriveCanonicalFacts(snapshot);
  if (isErr(derived)) {
    return { kind: "derive_error", error: derived.error }; // a broken vault — a real defect, distinct from absence
  }
  return { kind: "derived", set: derived.value };
}
