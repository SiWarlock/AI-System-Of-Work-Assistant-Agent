// @sow/integrations — pure bounded-exponential-backoff for connector retries (§8).
//
// `nextDelayMs(attempt, cfg, jitter?)` computes the delay before the next retry of
// a transient connector fetch. PURE + DETERMINISTIC: no `Date.now`, no
// `Math.random` — any randomness is an INJECTED `jitter` fn the caller supplies
// (tests pass a deterministic one). The delay is doubly bounded: it grows
// exponentially from `baseMs` but is CLAMPED to `maxMs`, and once `attempt`
// exceeds `maxAttempts` the function returns the sentinel `'exhausted'` so the
// gateway stops retrying and fails-closed (degraded + a health signal) rather than
// spinning forever. Fail-closed: a non-positive attempt is `'exhausted'` (never a
// negative or zero-base delay).

/** Backoff bounds. `attempt` is 1-indexed; attempt 1 yields `baseMs`. */
export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
}

/** The sentinel returned once retries are exhausted. */
export const EXHAUSTED = "exhausted" as const;

/**
 * Delay (ms) before retry `attempt`, or `'exhausted'` once `attempt` exceeds
 * `maxAttempts`. Exponential (`baseMs * 2^(attempt-1)`) clamped to `maxMs`. An
 * optional injected `jitter` fn is applied to the clamped base and the result is
 * re-clamped to `maxMs` so jitter can never breach the ceiling. Deterministic for
 * a given `(attempt, cfg, jitter)`.
 */
export function nextDelayMs(
  attempt: number,
  cfg: BackoffConfig,
  jitter?: (baseDelayMs: number) => number,
): number | typeof EXHAUSTED {
  if (!Number.isFinite(attempt) || attempt < 1) return EXHAUSTED;
  if (attempt > cfg.maxAttempts) return EXHAUSTED;

  const growth = cfg.baseMs * 2 ** (attempt - 1);
  const clamped = Math.min(growth, cfg.maxMs);
  if (jitter === undefined) return clamped;
  // Jitter is applied then re-clamped: it may never breach maxMs, and never go
  // below 0 (a negative jitter is floored at 0).
  const jittered = jitter(clamped);
  return Math.min(Math.max(jittered, 0), cfg.maxMs);
}
