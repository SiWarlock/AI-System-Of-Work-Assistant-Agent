// Task 13.10 (reconcile-TRIGGER arc, piece B) — the gbrain-read → ReconcilerDbProjection builder. spec(§6) spec(§12)
//
// buildReconcilerDbProjection reads the injected read-only GbrainReadAdapter (the grant-verified, op-gated,
// structurally write-free gbrain read surface — safety rule 1) and produces the ReconcilerDbProjection that
// piece A's runReconcilePass consumes as `req.dbProjection`:
//   • the semantic fact set from the `graph` read → DbFact[] (a pointer/metadata view; never a byte source);
//   • the index schema version from the `schemaRead`.
//
// FAIL-CLOSED ON COVERAGE (§12): `complete=true` ONLY on a clean, fully-consumed, well-formed read with a
// readable schema version. ANY of { a read `err`, an adapter rejection, a truncation / open-cursor signal, a
// malformed row, a malformed envelope, an absent/unreadable schema version } ⇒ `complete=false` — the
// reconciler then cannot claim full coverage, so serving degrades. NEVER a false-complete (which would be a
// trust-gate defeat), and the incompleteness detection is TYPE-ROBUST: a truthy-non-boolean `truncated` or a
// non-string / object cursor still degrades (the dangerous value on the coverage axis is a MISSED "more
// results" signal, so — unlike `stamped` — we do NOT require the signal to be a specific type).
//
// NEVER throws: every gbrain payload is typed `unknown` and parsed defensively; a Result `err` is a value; and
// the two adapter reads are wrapped so even a port-contract-violating adapter that REJECTS degrades (never
// propagates) — the never-throws posture holds regardless of the injected adapter.
//
// `stamped` is CONSERVATIVE: `stamped=true` ONLY on an explicit `stamped===true` row signal; absent/ambiguous
// ⇒ false — a false `stamped=true` would hide an unstamped `db_only` HARD parity defect from quarantine
// (safety rule 1: a DB-only / unstamped semantic fact is a hidden-brain defect the reconciler MUST see).
//
// DORMANT + reachability-waivered: no production caller (piece D wires this builder's output as
// runReconcilePass's req.dbProjection); the REAL live `GbrainReadGrant` HTTP transport stays OWNER-GATED and
// unbound the whole arc — the injected adapter is a fake in tests. The expected read-response shapes below are
// the minimal contract the real transport must satisfy (mirroring gbrain's read-op output); pinning that
// contract (esp. a POSITIVE completeness token + the exact paging signal) is the piece-D binding slice's job.
import { isOk, err, factKindSchema } from "@sow/contracts";
import type {
  GbrainReadAdapter,
  GbrainReadResult,
  GbrainAllowedOp,
  DbFact,
  ReconcilerDbProjection,
} from "@sow/knowledge";

/** Optional opaque payloads forwarded to the gbrain reads (revision/paging filter). Real shapes owner-gated. */
export interface ReconcilerReadParams {
  readonly graphPayload?: unknown;
  readonly schemaPayload?: unknown;
}

/** Degrade sentinel emitted for `gbrainSchemaVersion` ONLY when the version is unreadable — always paired with
 *  `complete=false` (a readable version is a positive number `> 0`, so this never collides with a real
 *  version, and the reconciler's coverageComplete ANDs `complete`). NEVER treat 0 as a real index version. */
const UNKNOWN_SCHEMA_VERSION = 0;

/**
 * Build the fail-closed `ReconcilerDbProjection` from the injected read-only adapter. Never throws; degrades to
 * `complete=false` on any coverage gap. `workspaceId` is sourced from the grant-bound `adapter.workspaceId`
 * (NOT a caller param) so the projection's workspace can never disagree with the read grant (WS-8).
 */
export async function buildReconcilerDbProjection(
  adapter: GbrainReadAdapter,
  params: ReconcilerReadParams = {},
): Promise<ReconcilerDbProjection> {
  const workspaceId = adapter.workspaceId as string;

  // ── the fact set: the `graph` read ────────────────────────────────────────────
  const graphRes = await safeRead(() => adapter.graph(params.graphPayload), "graph");
  const { facts, factsComplete } = parseGraphRead(graphRes);

  // ── the index schema version: the `schemaRead` ────────────────────────────────
  const schemaRes = await safeRead(() => adapter.schemaRead(params.schemaPayload), "schema_read");
  const version = parseSchemaVersion(schemaRes);

  const complete = factsComplete && version !== undefined;
  return {
    workspaceId,
    gbrainSchemaVersion: version ?? UNKNOWN_SCHEMA_VERSION,
    facts,
    complete,
  };
}

/** Await a read, converting a sync-throw / async-rejection / non-Result resolution from a port-violating adapter
 *  into a typed read err (so the never-throws + fail-closed posture holds even if the injected adapter breaks
 *  its Result contract — a rejecting OR a resolve-to-garbage adapter both degrade, never propagate/throw). */
async function safeRead(read: () => Promise<GbrainReadResult>, op: GbrainAllowedOp): Promise<GbrainReadResult> {
  try {
    const res = await read();
    // A resolved value must be Result-shaped — else `isOk`/`isErr` would throw downstream. Degrade if not.
    return isResult(res) ? res : err({ code: "transport_fault", op, cause: "adapter returned a non-Result value" });
  } catch (cause) {
    return err({ code: "transport_fault", op, cause });
  }
}

/** Parse the `graph` read into DbFacts + a fail-closed completeness flag (err/malformed/truncated ⇒ incomplete). */
function parseGraphRead(res: GbrainReadResult): { facts: DbFact[]; factsComplete: boolean } {
  if (!isOk(res)) return { facts: [], factsComplete: false }; // a read err can't claim coverage
  const env = res.value;
  if (!isRecord(env) || !Array.isArray(env.facts)) {
    return { facts: [], factsComplete: false }; // a malformed envelope can't claim coverage
  }
  const parsed = env.facts.map(parseRow);
  const facts = parsed.filter((f): f is DbFact => f !== undefined);
  const allRowsWellFormed = facts.length === parsed.length; // a dropped (malformed) row ⇒ not fully well-formed
  // TYPE-ROBUST incompleteness: any present, non-`false` truncation flag OR any present, non-empty cursor of
  // ANY type ⇒ more rows exist ⇒ this read is not the full set. (A missed "more" signal is the dangerous value.)
  const { truncated, cursor } = env;
  const incomplete =
    (truncated !== undefined && truncated !== false) ||
    (cursor !== undefined && cursor !== null && cursor !== "");
  return { facts, factsComplete: allRowsWellFormed && !incomplete };
}

/** Parse one gbrain graph row into a DbFact, or `undefined` if it does not satisfy the DbFact contract. */
function parseRow(raw: unknown): DbFact | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.factIdentity !== "string" || raw.factIdentity.length === 0) return undefined;
  const kind = factKindSchema.safeParse(raw.factKind);
  if (!kind.success) return undefined;
  if (typeof raw.contentHash !== "string" || raw.contentHash.length === 0) return undefined;
  if (typeof raw.revisionId !== "string" || raw.revisionId.length === 0) return undefined;
  return {
    factIdentity: raw.factIdentity,
    factKind: kind.data,
    dbContentHash: raw.contentHash, // gbrain-side content_hash → the DbFact's dbContentHash
    stamped: raw.stamped === true, // conservative: absent/non-boolean ⇒ false (keep unstamped defects visible)
    revisionId: raw.revisionId,
  };
}

/** Parse the `schemaRead` into a readable schema version (a positive number), or `undefined` (⇒ degrade). A
 *  non-number / NaN / Infinity / `0` / negative version is unreadable — 0/negative can't be a real index version. */
function parseSchemaVersion(res: GbrainReadResult): number | undefined {
  if (!isOk(res)) return undefined;
  const body = res.value;
  if (!isRecord(body)) return undefined;
  const v = body.schemaVersion;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A resolved read value is Result-shaped iff it has a boolean `ok` discriminant (so isOk/isErr are safe). */
function isResult(value: unknown): value is GbrainReadResult {
  return isRecord(value) && typeof value.ok === "boolean";
}
