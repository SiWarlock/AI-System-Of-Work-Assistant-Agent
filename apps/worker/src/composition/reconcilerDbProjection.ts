// Task 13.10 (reconcile-TRIGGER arc, piece B) — the gbrain-read → ReconcilerDbProjection builder. spec(§6) spec(§12)
//
// buildReconcilerDbProjection reads the injected read-only GbrainReadAdapter (the grant-verified, op-gated,
// structurally write-free gbrain read surface — safety rule 1) and produces the ReconcilerDbProjection that
// piece A's runReconcilePass consumes as `req.dbProjection`:
//   • the semantic fact set from the `graph` read → DbFact[] (a pointer/metadata view; never a byte source);
//   • the index schema version from the `schemaRead`.
//
// FAIL-CLOSED ON COVERAGE (§12) — POSITIVE completeness token (Item 2b): `complete=true` ONLY on a clean,
// fully-consumed, well-formed read that carries an EXPLICIT positive completeness token (`env.complete === true`,
// STRICT) AND signals no more-results AND (if a stated total is present) returns exactly that many rows AND has a
// readable schema version. DEFAULT-INCOMPLETE otherwise — this is the FLIP from the old fail-OPEN negative default
// (which claimed coverage whenever a couple of specific pagination fields happened to be absent, so an omitted-
// pagination or unknown-field response was a FALSE-complete). ANY of { a read `err`, an adapter rejection, an
// ABSENT/non-`true` completeness token, a more-results signal, a stated-total mismatch, a malformed row, a
// malformed envelope, an absent/unreadable schema version } ⇒ `complete=false`. NEVER a false-complete (a
// trust-gate defeat). TYPE-ROBUST (Lesson 19): a truthy-non-boolean paging signal still degrades — the dangerous
// value on the coverage axis is a MISSED "more results" signal, so we require the exact positive token but treat
// ANY present more-results signal (across the widened set) as incomplete.
//
// arch_gap (Lesson 21): the positive completeness token + the widened more-results field set
// (truncated/cursor/hasMore/nextPageToken/nextOffset/pageInfo.hasNextPage) + the stated-total field
// (total/totalCount) are a DOCUMENTED CANDIDATE — part of the Item-2a `gbrain serve --http` wire shape. The exact
// real fields + per-field benign/degrade semantics (e.g. `nextOffset:0`) are confirmed at the owner's arming
// binding; do NOT treat as final. A wrong-shaped envelope degrades (never false-completes).
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

/** Parse the `graph` read into DbFacts + a fail-closed completeness flag. Coverage is claimed ONLY on a clean,
 *  well-formed read that carries the POSITIVE completeness token AND signals no more-results AND (if a stated
 *  total is present) returns exactly that many rows. Default-INCOMPLETE otherwise (err/malformed/absent-token/
 *  any-more-results-signal/total-mismatch ⇒ `factsComplete=false`). */
function parseGraphRead(res: GbrainReadResult): { facts: DbFact[]; factsComplete: boolean } {
  if (!isOk(res)) return { facts: [], factsComplete: false }; // a read err can't claim coverage
  const env = res.value;
  if (!isRecord(env) || !Array.isArray(env.facts)) {
    return { facts: [], factsComplete: false }; // a malformed envelope can't claim coverage
  }
  const rawCount = env.facts.length; // the RAW returned row count (before dropping malformed rows), for the total check
  const parsed = env.facts.map(parseRow);
  const facts = parsed.filter((f): f is DbFact => f !== undefined);
  const allRowsWellFormed = facts.length === parsed.length; // a dropped (malformed) row ⇒ not fully well-formed

  // POSITIVE completeness token (candidate arch_gap, Lesson 21): coverage is claimed ONLY on an explicit
  // `complete === true` — default-INCOMPLETE when the token is absent/ambiguous (the FLIP from the old fail-OPEN
  // negative default, which claimed coverage whenever a couple of specific pagination fields happened to be absent).
  // STRICT `=== true` (mirror `stamped`): a truthy-non-`true` value does NOT claim coverage — the dangerous value on
  // the coverage axis is a FALSE-complete, so require the exact positive signal.
  const positivelyComplete = env.complete === true;

  return {
    facts,
    factsComplete:
      allRowsWellFormed &&
      positivelyComplete &&
      !hasMoreResultsSignal(env) &&
      !rowCountMismatchesStatedTotal(env, rawCount),
  };
}

/** True iff ANY present "more-results" paging signal is set ⇒ more rows exist server-side ⇒ this read is not the
 *  full set. TYPE-ROBUST (Lesson 19 — a missed "more" signal is the dangerous value, so a truthy-non-boolean still
 *  degrades). The field NAMES + per-field benign/degrade semantics are a DOCUMENTED CANDIDATE (arch_gap — part of
 *  the Item-2a wire shape), confirmed at the arming binding. Per-field reading (each fail-closed by kind):
 *    • `truncated` — a boolean FLAG: any present, non-`false` value (INCLUDING `null`/`0`) ⇒ signal (an ambiguous
 *      truncation flag reads as truncated); only an explicit `false` (or absence) is benign.
 *    • `cursor` / `nextPageToken` — an opaque HANDLE: present + non-null + non-empty-string of any type ⇒ signal
 *      (a `null`/`""`/absent handle carries none).
 *    • `nextOffset` — a numeric OFFSET: present + non-null (any value INCL. `0`) ⇒ signal (fail-closed — an offer
 *      of a next offset means more; `null`/absent carries none).
 *    • `hasMore` / `pageInfo.hasNextPage` — a boolean SIGNAL: truthy ⇒ signal (an explicit `false`/absent is the
 *      benign "no more" read). */
function hasMoreResultsSignal(env: Record<string, unknown>): boolean {
  const { truncated, cursor, hasMore, nextPageToken, nextOffset, pageInfo } = env;
  if (truncated !== undefined && truncated !== false) return true; // FLAG: non-`false` (incl. null/0) ⇒ truncated
  if (isPresentNonEmpty(cursor)) return true; // HANDLE: present non-empty cursor of any type
  if (isPresentNonEmpty(nextPageToken)) return true; // HANDLE: present non-empty next-page token
  if (nextOffset !== undefined && nextOffset !== null) return true; // OFFSET: present (any value incl. 0 — fail-closed)
  if (Boolean(hasMore)) return true; // SIGNAL: truthy hasMore (explicit `false`/absent is benign)
  if (isRecord(pageInfo) && Boolean(pageInfo.hasNextPage)) return true; // SIGNAL: truthy pageInfo.hasNextPage
  return false;
}

/** True iff the RAW returned row count does NOT match ANY present finite stated total (`total` / `totalCount`) ⇒
 *  the returned set is not the exact full set ⇒ incomplete. Degrading on a mismatch of ANY present finite total
 *  (not just a first-finite pick) means a self-CONTRADICTORY pair — e.g. `total:1, totalCount:100` — can't
 *  false-complete by trusting the field that happens to match (anti-false-green). An absent / non-numeric total
 *  imposes NO constraint (a dropped malformed row is caught separately by `allRowsWellFormed`, so the total is
 *  compared against the RAW count). */
function rowCountMismatchesStatedTotal(env: Record<string, unknown>, rawCount: number): boolean {
  const totals = [env.total, env.totalCount].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return totals.some((t) => rawCount !== t);
}

/** Present + non-null + non-empty-string (an opaque cursor/token signal of any type; null/undefined ⇒ absent). */
function isPresentNonEmpty(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
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
