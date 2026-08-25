// Write-through enablement — REAL LEG PRODUCERS (task 11.3b, §13 GBrain upgrade & write-through
// enablement). `decideWriteThroughEnablement` (decide-enablement.ts) is the PURE flip-precondition
// gate; this module supplies the FOUR boolean-producing legs its header deferred as "bucket B":
// the conformance-suite result, the full-reindex completion, the embedding-key PRESENCE probe, and
// the no-stray-writer probe (the sibling of `apps/worker/src/install/checks/posture.ts`'s
// `diagnoseStrayGbrainProcess`). The remaining two legs (`pin`, `parityReport`) are NOT booleans —
// the gate consumes the ACTUAL `GbrainPin`/`ParityReport` objects directly, so they need no producer
// here; the caller reads them from wherever they already live (config / the ParityReport store).
//
// PURE functions over INJECTED READERS (dependency injection, no I/O of their own — this package
// cannot depend on `apps/worker`'s real probes, layer-direction rule): each producer takes a reader
// (sync or async — normalized via `Promise.resolve`) and FAILS CLOSED on an absent reader, an
// unreadable/`undefined` result, a malformed shape, or a THROWING/rejecting reader — mirroring the
// gate's own fail-closed-on-omission contract (decide-enablement.ts:~93, `legSatisfied`'s try/catch).
// NEVER throws across the boundary (§16); every producer resolves to a plain `boolean`.
/** A reader may be sync or async — every producer normalizes via `Promise.resolve`. */
export type LegReader<T> = () => T | Promise<T>;

/** Await a reader, folding an absent reader, a `throw`, or a rejection to `undefined` (fail-closed). */
async function readSafely<T>(reader: LegReader<T> | undefined): Promise<T | undefined> {
  if (reader === undefined) return undefined;
  try {
    return await reader();
  } catch {
    return undefined;
  }
}

// ── conformance-suite result reader ────────────────────────────────────────────

/**
 * The read-token-rejects-write conformance run's result. Reads a pre-computed pass/fail (the run
 * itself — the §12 conformance suite against the pinned SHA — is out of scope here, task 11.3b
 * supplies ONLY the composition). `true` iff the reader resolves EXPLICITLY to `true`; any other
 * outcome (absent reader, `undefined`/`false`, a non-boolean, a throw/rejection) is UNSATISFIED.
 */
export async function readConformanceGreen(reader: LegReader<boolean | undefined> | undefined): Promise<boolean> {
  return (await readSafely(reader)) === true;
}

// ── reindex-completion reader ───────────────────────────────────────────────────

/**
 * The full re-index against the pinned build's completion state. Same fail-closed contract as
 * {@link readConformanceGreen} — `true` iff EXPLICITLY `true`.
 */
export async function readReindexComplete(reader: LegReader<boolean | undefined> | undefined): Promise<boolean> {
  return (await readSafely(reader)) === true;
}

// ── embedding-key PRESENCE probe ────────────────────────────────────────────────

/**
 * The embedding key's PRESENCE — never the key VALUE, never a value in any message (rule 7). The
 * reader itself must already return presence-only information (a boolean); this producer adds no
 * new I/O, only the fail-closed fold. `true` iff EXPLICITLY `true`.
 */
export async function readEmbeddingKeyPresent(reader: LegReader<boolean | undefined> | undefined): Promise<boolean> {
  return (await readSafely(reader)) === true;
}

// ── stray-gbrain-writer probe (modelled on posture.ts's diagnoseStrayGbrainProcess) ───────────────

/**
 * Structural subset of `apps/worker/src/install/checks/posture.ts`'s `StrayGbrainProcessProbe` —
 * declared LOCALLY (not imported — the layer-direction rule forbids `packages/knowledge` depending
 * on `apps/worker`) so the real worker-level probe object satisfies this type structurally without
 * either side importing the other. Redaction-safe by construction: this module never reads anything
 * off an individual process entry beyond checking the array's own shape/length (rule 7 — no raw
 * arg/secret ever crosses into this producer's return value, which is a bare boolean).
 */
export interface StrayGbrainProcessProbeLike {
  readonly strayProcesses: readonly unknown[];
}

/**
 * No-stray-writer leg: `true` ONLY when the probe is present, well-formed (`strayProcesses` is an
 * array), AND that array is EMPTY — mirroring `diagnoseStrayGbrainProcess`'s own fail-closed logic
 * (posture.ts:51-59: "we cannot confirm 'no stray writer', so we must assume one"). An absent probe,
 * a malformed probe, a throw, or ANY detected stray process ⇒ `false` (the leg refuses).
 */
export async function readNoStrayWriter(
  reader: LegReader<StrayGbrainProcessProbeLike | undefined> | undefined,
): Promise<boolean> {
  const probe = await readSafely(reader);
  if (probe === undefined || !Array.isArray(probe.strayProcesses)) return false;
  return probe.strayProcesses.length === 0;
}

// ── composition helper — build the four producer-backed legs in one pass ──────────────────────────

/** Injected readers for the four boolean-producing legs (the `pin`/`parityReport` legs are NOT here — see module header). */
export interface EnablementLegReaders {
  readonly conformanceGreen?: LegReader<boolean | undefined>;
  readonly reindexComplete?: LegReader<boolean | undefined>;
  readonly embeddingKeyPresent?: LegReader<boolean | undefined>;
  readonly noStrayWriter?: LegReader<StrayGbrainProcessProbeLike | undefined>;
}

/** The four produced booleans — a direct subset of `WriteThroughEnablementInputs`. */
export interface ProducedEnablementLegs {
  readonly conformanceGreen: boolean;
  readonly reindexComplete: boolean;
  readonly embeddingKeyPresent: boolean;
  readonly noStrayWriter: boolean;
}

/**
 * Run all four leg producers over their injected readers in one pass. PURE composition (no I/O of
 * its own beyond invoking the readers); never throws — every producer already folds its own reader's
 * throw/rejection to fail-closed. An entirely-empty `readers` object (every reader absent) produces
 * all-`false` — the caller composing this into `WriteThroughEnablementInputs` then sees every one of
 * the four legs refuse (matches `decideWriteThroughEnablement`'s fail-closed-on-omission contract).
 */
export async function produceEnablementLegs(readers: EnablementLegReaders): Promise<ProducedEnablementLegs> {
  const [conformanceGreen, reindexComplete, embeddingKeyPresent, noStrayWriter] = await Promise.all([
    readConformanceGreen(readers.conformanceGreen),
    readReindexComplete(readers.reindexComplete),
    readEmbeddingKeyPresent(readers.embeddingKeyPresent),
    readNoStrayWriter(readers.noStrayWriter),
  ]);
  return { conformanceGreen, reindexComplete, embeddingKeyPresent, noStrayWriter };
}
