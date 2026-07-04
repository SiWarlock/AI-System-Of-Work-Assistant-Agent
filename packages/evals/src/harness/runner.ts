// spec(§12/§20.1) — EVAL-1 runner (task 12.1, REQ-T-001).
//
// Scores a measurement against a criterion's EXPLICIT threshold and enforces
// DoD honesty: a `requiresRealIntegration` criterion measured from a mock is
// functionally-passing but NOT DoD-passing (`dodValid=false`). A criterion with
// no resolvable threshold, or an unknown criterion id, is a hard config error
// (throws `EvalConfigError`) — never a silent pass.
//
// Pure + deterministic — no clock, no network, no randomness.
import {
  EVAL_CRITERIA,
  criterionById,
  type EvalCriterion,
  type Threshold,
} from "./criteria-registry";

/** A configuration defect in the harness itself (missing threshold / unknown id). */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}

/** A single measured result for a criterion, tagged by its provenance. */
export interface EvalMeasurement {
  readonly criterionId: string;
  /** Measured value: a number for `min`/`max` thresholds, boolean for `gate`. */
  readonly value: number | boolean;
  /** True if produced by a real integration (not a mock/fixture). */
  readonly fromRealIntegration: boolean;
}

export interface EvalOutcome {
  readonly criterionId: string;
  readonly prdTest: string;
  /** Threshold satisfied by the measured value. */
  readonly functionalPass: boolean;
  /** DoD-honesty: not real-required, OR the measurement came from a real integration. */
  readonly dodValid: boolean;
  /** The reportable verdict: `functionalPass && dodValid`. */
  readonly dodPass: boolean;
  readonly threshold: Threshold;
  readonly measured: number | boolean;
  readonly reason: string;
}

/**
 * Evaluate a measured value against a threshold. Never throws on a value/type
 * mismatch — a mismatched value simply does not pass (with a reason). Pure.
 */
export function evaluateThreshold(
  threshold: Threshold,
  value: number | boolean,
): { pass: boolean; reason: string } {
  switch (threshold.kind) {
    case "gate":
      if (typeof value !== "boolean") {
        return { pass: false, reason: `gate expects a boolean, got ${typeof value}` };
      }
      return value
        ? { pass: true, reason: "gate: true" }
        : { pass: false, reason: "gate: false" };
    case "min":
      if (typeof value !== "number") {
        return { pass: false, reason: `min expects a number, got ${typeof value}` };
      }
      return value >= threshold.value
        ? { pass: true, reason: `${value} >= ${threshold.value}${threshold.unit}` }
        : { pass: false, reason: `${value} < ${threshold.value}${threshold.unit}` };
    case "max":
      if (typeof value !== "number") {
        return { pass: false, reason: `max expects a number, got ${typeof value}` };
      }
      return value <= threshold.value
        ? { pass: true, reason: `${value} <= ${threshold.value}${threshold.unit}` }
        : { pass: false, reason: `${value} > ${threshold.value}${threshold.unit}` };
  }
}

/**
 * Score a measurement against an explicit criterion. Throws `EvalConfigError`
 * if the criterion carries no threshold (never silently defaults).
 */
export function scoreMeasurement(criterion: EvalCriterion, measurement: EvalMeasurement): EvalOutcome {
  const threshold = criterion.threshold;
  if (threshold === undefined || threshold === null) {
    throw new EvalConfigError(
      `criterion ${criterion.id} has no threshold — refusing to score (would silently default)`,
    );
  }
  const { pass: functionalPass, reason } = evaluateThreshold(threshold, measurement.value);
  const dodValid = !criterion.requiresRealIntegration || measurement.fromRealIntegration;
  const dodPass = functionalPass && dodValid;
  const dodNote = dodValid
    ? ""
    : " · DoD-INVALID: real integration required but measured from a mock";
  return {
    criterionId: criterion.id,
    prdTest: criterion.prdTest,
    functionalPass,
    dodValid,
    dodPass,
    threshold,
    measured: measurement.value,
    reason: `${reason}${dodNote}`,
  };
}

/**
 * Score a measurement, resolving the criterion from the registry by id. Throws
 * `EvalConfigError` if the id is unknown.
 */
export function scoreById(measurement: EvalMeasurement): EvalOutcome {
  const criterion = criterionById(measurement.criterionId);
  if (criterion === undefined) {
    throw new EvalConfigError(`unknown criterion id: ${measurement.criterionId}`);
  }
  return scoreMeasurement(criterion, measurement);
}

/** Score a batch of measurements by id (each resolved from the registry). */
export function scoreAll(measurements: readonly EvalMeasurement[]): readonly EvalOutcome[] {
  return measurements.map((m) => scoreById(m));
}

/** All criterion ids currently registered — for exhaustive-coverage checks. */
export function allCriterionIds(): readonly string[] {
  return EVAL_CRITERIA.map((c) => c.id);
}
