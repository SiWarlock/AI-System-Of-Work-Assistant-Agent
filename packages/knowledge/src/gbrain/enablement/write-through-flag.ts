// WriteThroughEnableFlag + typed config/gbrain.pin re-capture (task 4.20, §6/§13;
// write-through amendment invariant (vii) + §13 / the 12.22 enablement gate).
//
// `writeThroughEnabled` is a PER-WORKSPACE flag, DEFAULT OFF. Off is the §6
// read-only/index-only fallback AND the kill switch — never a fault. Write-through
// becomes ACTIVE for a workspace only when BOTH hold:
//
//   1. the 12.22 ENABLEMENT GATE is green — the four §12 GO conditions proven LIVE
//      against the ACTUAL pinned SHA (#1 one-writer, #2 no-lost-update, #3 parity
//      catches DB-only, #4 round-trip lossless) + the read grant rejects every write
//      op vs that SHA + the embedding key is GREEN (never a noEmbed-degraded index) +
//      no cron/autopilot is bound to a canonical brain + `config/gbrain.pin` is
//      promoted out of a PENDING_* sentinel; AND
//   2. the latest revision-scoped `ParityReport` proves CONTAINMENT — clean
//      (`cleanForServing`) AND complete (`coverageComplete`) for THIS workspace.
//
// A DIRTY / INCOMPLETE / ABSENT ParityReport — or any regressed enablement condition
// while the flag is still ON — AUTO-REVERTS the workspace to Markdown-provenanced-only
// serving (fail-closed, §12) and opens a `write_through_failed` System-Health item.
// Worst observable outcome is a withheld byte + a pending-review HealthItem, never a
// DB-sourced answer.
//
// This module is PURE decision logic + a PURE `config/gbrain.pin` text→typed-`GbrainPin`
// parser (the 4.20 "re-capture" verification, tying the config file to the frozen
// contract). No clock/network/fs of its own — the caller injects `now` + the audit
// ref. Returns typed values/Results and NEVER throws across the boundary (§16).
import { ok, err, GbrainPinSchema } from "@sow/contracts";
import type {
  Result,
  GbrainPin,
  ParityReport,
  HealthItem,
  WorkspaceId,
  AuditId,
} from "@sow/contracts";
import { isPendingSentinel } from "../version-pin";

// ── the 12.22 enablement gate ────────────────────────────────────────────────

/**
 * The LIVE inputs to the 12.22 enablement gate — each a proof obligation the
 * caller resolves against the ACTUAL installed/pinned gbrain (never a mock). Every
 * leg must be `true` for the flag to be promotable / stay active.
 */
export interface EnablementConditions {
  /** `config/gbrain.pin` promoted out of a PENDING_* sentinel (validatedOn is a real date). */
  readonly pinValidated: boolean;
  /** The running gbrain SHA == the pinned SHA (the gate ran vs the ACTUAL pinned build). */
  readonly pinShaMatchesRunning: boolean;
  /** §12 GO #1 — one-writer / no hidden brain proven LIVE (write fence + no stray writer). */
  readonly goOneWriter: boolean;
  /** §12 GO #2 — no lost update proven LIVE (monotonic apply, collapse=MAX). */
  readonly goNoLostUpdate: boolean;
  /** §12 GO #3 — parity catches DB-only / unstamped / borrowed-stamp / forged facts. */
  readonly goParityCatchesDbOnly: boolean;
  /** §12 GO #4 — KW→import→rebuild round-trip is semantically lossless. */
  readonly goRoundTripLossless: boolean;
  /** 12.22 — the issued read grant REJECTS every write op vs the pinned SHA. */
  readonly readTokenRejectsWrite: boolean;
  /** doctor embeddings/embedding_provider GREEN (parity never runs on a noEmbed index). */
  readonly embeddingKeyGreen: boolean;
  /** No cron/autopilot/dream cycle bound to a canonical brain (§13). */
  readonly noCronOrAutopilot: boolean;
}

/** The closed set of reasons the enablement gate blocks the flip (one per unmet leg). */
export type UnmetEnablementCondition =
  | "pin_pending_validation"
  | "pin_sha_mismatch"
  | "go1_one_writer_unproven"
  | "go2_lost_update_unproven"
  | "go3_parity_unproven"
  | "go4_round_trip_unproven"
  | "read_token_accepts_write"
  | "embedding_key_not_green"
  | "cron_or_autopilot_installed";

export interface EnablementGatePass {
  readonly allGreen: true;
}

export interface EnablementGateBlocked {
  readonly allGreen: false;
  /** Every unmet leg, in a stable evaluation order (deterministic). */
  readonly unmet: readonly UnmetEnablementCondition[];
}

// Ordered (condition-selector, reason) pairs — evaluated in this fixed order so the
// `unmet` list is deterministic.
const CONDITION_CHECKS: ReadonlyArray<
  readonly [(c: EnablementConditions) => boolean, UnmetEnablementCondition]
> = [
  [(c) => c.pinValidated, "pin_pending_validation"],
  [(c) => c.pinShaMatchesRunning, "pin_sha_mismatch"],
  [(c) => c.goOneWriter, "go1_one_writer_unproven"],
  [(c) => c.goNoLostUpdate, "go2_lost_update_unproven"],
  [(c) => c.goParityCatchesDbOnly, "go3_parity_unproven"],
  [(c) => c.goRoundTripLossless, "go4_round_trip_unproven"],
  [(c) => c.readTokenRejectsWrite, "read_token_accepts_write"],
  [(c) => c.embeddingKeyGreen, "embedding_key_not_green"],
  [(c) => c.noCronOrAutopilot, "cron_or_autopilot_installed"],
];

/**
 * Evaluate the 12.22 promotion gate. `ok` ⇒ `writeThroughEnabled` MAY be flipped ON
 * for the workspace; `err` ⇒ the flip is blocked, carrying every unmet leg. This is
 * the pure predicate the 12.22 suite asserts for the enablement flip. Never throws.
 */
export function evaluateEnablementGate(
  conditions: EnablementConditions,
): Result<EnablementGatePass, EnablementGateBlocked> {
  const unmet: UnmetEnablementCondition[] = [];
  for (const [selector, reason] of CONDITION_CHECKS) {
    if (!selector(conditions)) unmet.push(reason);
  }
  if (unmet.length > 0) {
    return err({ allGreen: false, unmet });
  }
  return ok({ allGreen: true });
}

// ── runtime resolution (default-off + auto-revert) ────────────────────────────

/** The effective write-through serving posture for a workspace at resolve time. */
export type WriteThroughMode =
  // Write-through is ACTIVE (bytes-from-Markdown serving via the gate).
  | "write_through_enabled"
  // Flag default OFF — the §6 read-only/index-only fallback + kill switch (NOT a fault).
  | "read_only_index_only"
  // Auto-reverted / regressed-condition degrade — serve Markdown-provenanced-only.
  | "markdown_provenanced_only";

export type WriteThroughReason =
  | "enabled_all_green"
  | "flag_default_off"
  | "enablement_conditions_unmet"
  | "parity_report_absent"
  | "parity_dirty"
  | "parity_incomplete";

/** Injected surroundings for building an auto-revert HealthItem — no ambient clock/id. */
export interface WriteThroughContext {
  /** ISO-8601 clock for `HealthItem.openedAt`. */
  readonly now: () => string;
  /** AuditId of the resolution audit record recorded alongside. */
  readonly auditRef: string;
  /** Optional stable HealthItem id (dedupe id is (failureClass, subjectRef) per §10.3). */
  readonly healthItemId?: string;
  /** Optional open-taxonomy severity override (§16 pins no closed set). */
  readonly severity?: string;
}

export interface WriteThroughResolveInput {
  readonly workspaceId: WorkspaceId;
  /** The persisted per-workspace intent (default false). */
  readonly flagEnabled: boolean;
  /** The LIVE 12.22 enablement conditions at resolve time. */
  readonly conditions: EnablementConditions;
  /** The latest revision-scoped ParityReport for this workspace (undefined ⇒ none yet). */
  readonly latestParityReport?: ParityReport;
}

export interface WriteThroughResolution {
  readonly workspaceId: WorkspaceId;
  /** True ⇔ write-through serving is live (bytes-from-Markdown via the gate). */
  readonly active: boolean;
  readonly mode: WriteThroughMode;
  readonly reason: WriteThroughReason;
  /** Present when `reason === 'enablement_conditions_unmet'`. */
  readonly unmet?: readonly UnmetEnablementCondition[];
  /** Present only on a fault degrade (auto-revert) — never on `flag_default_off`. */
  readonly healthItem?: HealthItem;
}

// Per-reason default severity (open taxonomy; overridable via ctx.severity).
const REASON_SEVERITY: Record<Exclude<WriteThroughReason, "enabled_all_green" | "flag_default_off">, string> = {
  enablement_conditions_unmet: "error",
  parity_report_absent: "error",
  parity_dirty: "critical",
  parity_incomplete: "warn",
};

const REASON_MESSAGE: Record<Exclude<WriteThroughReason, "enabled_all_green" | "flag_default_off">, string> = {
  enablement_conditions_unmet:
    "write-through auto-reverted: an enablement condition regressed while the flag was ON; serving Markdown-provenanced-only",
  parity_report_absent:
    "write-through auto-reverted: no ParityReport proves containment for this workspace; serving Markdown-provenanced-only",
  parity_dirty:
    "write-through auto-reverted: the latest ParityReport is dirty (cleanForServing=false — a HARD-floor parity defect); serving Markdown-provenanced-only",
  parity_incomplete:
    "write-through auto-reverted: the latest ParityReport did not cover the full set (coverageComplete=false); serving Markdown-provenanced-only",
};

function degrade(
  input: WriteThroughResolveInput,
  ctx: WriteThroughContext,
  reason: Exclude<WriteThroughReason, "enabled_all_green" | "flag_default_off">,
  unmet?: readonly UnmetEnablementCondition[],
): WriteThroughResolution {
  const healthItem: HealthItem = {
    id: ctx.healthItemId ?? `gbrain-write-through:${reason}`,
    failureClass: "write_through_failed",
    severity: ctx.severity ?? REASON_SEVERITY[reason],
    message: REASON_MESSAGE[reason],
    auditRef: ctx.auditRef as AuditId,
    openedAt: ctx.now(),
    state: "open",
  };
  return {
    workspaceId: input.workspaceId,
    active: false,
    mode: "markdown_provenanced_only",
    reason,
    ...(unmet !== undefined ? { unmet } : {}),
    healthItem,
  };
}

/**
 * Resolve the effective write-through posture for a workspace. Total function: a
 * degrade IS the fail-closed answer (not an error branch), so it returns a plain
 * `WriteThroughResolution`, never throws.
 *
 * Order: flag-off (default/kill-switch, no fault) → enablement gate (regressed ⇒
 * auto-revert) → parity containment (absent/dirty/incomplete ⇒ auto-revert) → ACTIVE.
 */
export function resolveWriteThrough(
  input: WriteThroughResolveInput,
  ctx: WriteThroughContext,
): WriteThroughResolution {
  // 1 — default OFF is the §6 fallback + kill switch. NOT a fault (no HealthItem),
  //     regardless of how green everything else is.
  if (!input.flagEnabled) {
    return {
      workspaceId: input.workspaceId,
      active: false,
      mode: "read_only_index_only",
      reason: "flag_default_off",
    };
  }

  // 2 — the flag is ON: the 12.22 gate must still be green. A regressed leg
  //     auto-reverts (fail-closed) — the flag should never outlive its conditions.
  const gate = evaluateEnablementGate(input.conditions);
  if (!gate.ok) {
    return degrade(input, ctx, "enablement_conditions_unmet", gate.error.unmet);
  }

  // 3 — containment must be PROVEN by the latest ParityReport FOR THIS WORKSPACE.
  const report = input.latestParityReport;
  if (report === undefined || (report.workspaceId as string) !== (input.workspaceId as string)) {
    return degrade(input, ctx, "parity_report_absent");
  }
  if (!report.cleanForServing) {
    return degrade(input, ctx, "parity_dirty");
  }
  if (!report.coverageComplete) {
    return degrade(input, ctx, "parity_incomplete");
  }

  // 4 — all green + clean/complete containment ⇒ write-through ACTIVE.
  return {
    workspaceId: input.workspaceId,
    active: true,
    mode: "write_through_enabled",
    reason: "enabled_all_green",
  };
}

/**
 * The pin leg of the enablement gate: a `GbrainPin` is enablement-eligible only once
 * `validatedOn` is promoted OUT of a PENDING_* sentinel (the LIVE four-condition
 * round-trip went green). A sentinel ⇒ validation still owed ⇒ not eligible.
 */
export function pinValidatedForEnablement(pin: GbrainPin): boolean {
  return !isPendingSentinel(pin.validatedOn);
}

// ── typed config/gbrain.pin re-capture parser ─────────────────────────────────

/** Enumerable failures of the `config/gbrain.pin` text parse — never thrown (§16). */
export type GbrainPinParseError =
  | { readonly code: "malformed_line"; readonly line: string }
  | { readonly code: "unknown_key"; readonly key: string }
  | { readonly code: "missing_key"; readonly key: string }
  | { readonly code: "schema_invalid"; readonly detail: string };

// snake_case file key → camelCase GbrainPin field (the config file's on-disk format).
const PIN_KEY_MAP: Readonly<Record<string, keyof GbrainPin>> = {
  gbrain_sha: "gbrainSha",
  gbrain_tag: "gbrainTag",
  gbrain_repo: "gbrainRepo",
  index_schema_ver: "indexSchemaVersion",
  write_through_enabled: "writeThroughEnabled",
  validated_on: "validatedOn",
  validation_ref: "validationRef",
};

const REQUIRED_FILE_KEYS = Object.keys(PIN_KEY_MAP);

/**
 * Parse the `config/gbrain.pin` text (parseable `key = value`; `#` comment; blank
 * lines ignored) into a contract-valid typed `GbrainPin`, mapping snake_case file
 * keys to camelCase fields and coercing `index_schema_ver`→number,
 * `write_through_enabled`→boolean. The result is validated through the frozen
 * `GbrainPinSchema` — this IS the executable "re-capture (typed GbrainPin)"
 * verification (task 4.20): it proves the file re-captured against 0.35.1.0 still
 * satisfies the contract. Returns a typed `Result`; never throws.
 */
export function parseGbrainPinFile(text: string): Result<GbrainPin, GbrainPinParseError> {
  const raw: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      return err({ code: "malformed_line", line: rawLine });
    }
    const fileKey = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (fileKey.length === 0) {
      return err({ code: "malformed_line", line: rawLine });
    }
    if (!(fileKey in PIN_KEY_MAP)) {
      return err({ code: "unknown_key", key: fileKey });
    }
    raw[fileKey] = value;
  }

  for (const k of REQUIRED_FILE_KEYS) {
    if (!(k in raw)) {
      return err({ code: "missing_key", key: k });
    }
  }

  // Coerce the two non-string fields; leave the rest as strings for the schema.
  const candidate: Record<string, unknown> = {
    gbrainSha: raw.gbrain_sha,
    gbrainTag: raw.gbrain_tag,
    gbrainRepo: raw.gbrain_repo,
    indexSchemaVersion: coerceInt(raw.index_schema_ver),
    writeThroughEnabled: coerceBool(raw.write_through_enabled),
    validatedOn: raw.validated_on,
    validationRef: raw.validation_ref,
  };

  const parsed = GbrainPinSchema.safeParse(candidate);
  if (!parsed.success) {
    return err({ code: "schema_invalid", detail: parsed.error.message });
  }
  return ok(parsed.data);
}

/** Parse an integer; NaN on a non-numeric/absent value so the schema's int check rejects it. */
function coerceInt(value: string | undefined): number {
  return value !== undefined && /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

/** "true"/"false" → boolean; anything else stays as-is so the schema rejects it. */
function coerceBool(value: string | undefined): unknown {
  const lower = value?.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return value;
}
