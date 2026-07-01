// GbrainWriteFence + OS-level one-writer lockdown (§6/§13, task 4.19; REQ-S-NEW-008).
//
// Makes safety rule 1 (one writer / no hidden brain) PREVENTIVE, not merely
// detective. The GBrain runtime is DB-first natively — `gbrain serve` (stdio),
// `sync --install-cron`, `autopilot`, `jobs work`, `dream`/`synthesize`, and a
// `frontmatter --fix` fs-write can all mutate the DB or the canonical `.md`. SoW
// inverts that by OS posture:
//
//   • The SoW worker is the SOLE OS principal with write access to the vault
//     directory (filesystem ACL).
//   • The SoW worker is the SOLE holder of the per-brain PGLite advisory lock.
//   • EVERY gbrain process (import/sync/extract/oracle/doctor/lint) runs against
//     a READ-ONLY mount / immutable revision snapshot — so a gbrain write to
//     canonical `.md` is physically impossible.
//   • A CONTINUOUS probe alarms on any stray write-capable gbrain process bound
//     to a canonical brain (the hard-alarm-by-construction backstop).
//
// This module is the IN-PACKAGE fence logic + the typed alarm. It is PURE
// decision logic: the caller injects the OS-level posture facts (the ACL bit,
// the advisory-lock holder) and the observed running-process set as a probe
// result — no fs/exec/clock of its own. Fails CLOSED and never throws across the
// boundary (§16): an intact fence is the `ok` branch, a breach the typed `err`
// branch, and every breach carries a §16 `HealthItem` alarm.
//
// ── Phase-7 deferment (apps/worker OS integration) ───────────────────────────
// The ACTUAL OS enforcement + probing is an apps/worker concern and is DEFERRED
// to Phase 7 (do NOT build apps/worker here). The worker install-doctor / repair
// path must, at Phase 7, WIRE this fence to real OS facts:
//   1. establish the vault filesystem ACL (worker-exclusive write) + mount every
//      gbrain subprocess read-only / against an immutable snapshot;
//   2. hold the single PGLite advisory lock per brain;
//   3. run a CONTINUOUS `ps`/lsof-style probe, feed each observed gbrain process
//      into {@link scanForStrayWriters} (or the whole set into
//      {@link evaluateWriteFence}), and route the returned alarms' HealthItems to
//      System Health (§10/§16).
// Until then this unit is fully exercised by injected posture + process fixtures.
import { ok, err } from "@sow/contracts";
import type { Result, HealthItem, AuditId, BrainId, FailureClass } from "@sow/contracts";

/** The vault mount mode a gbrain process sees. Anything other than `read_only`
 *  means the process CAN physically write the vault → a one-writer breach. */
export type VaultMountMode = "read_only" | "read_write";

/** Who holds the single per-brain PGLite advisory lock. Only `worker` is safe;
 *  every other value (incl. `unknown`) fails closed (default-deny). */
export type PgliteLockHolder = "worker" | "gbrain" | "none" | "unknown";

/** Capability class of a gbrain command as seen by the continuous probe. */
export type GbrainCommandClass = "read_only" | "write_capable";

/** The read-only gbrain command allow-set (§4.19): these run against a read-only
 *  mount / immutable snapshot and never write the DB or canonical `.md`. Any
 *  command outside this set — or any command carrying a write marker below — is
 *  treated as write-capable (default-deny). */
export const READ_ONLY_GBRAIN_COMMANDS = [
  "import",
  "sync",
  "extract",
  "oracle",
  "doctor",
  "lint",
] as const;

/** Substrings that mark a gbrain invocation as DB/vault-writing regardless of its
 *  base subcommand — e.g. `sync --install-cron` (a read-only base command turned
 *  into a DB-writing scheduler), `frontmatter --fix` (an fs-write), the stdio
 *  `serve` (no scope gate — fully write-capable in gbrain 0.35.1.0), and the
 *  hard-disabled generative/autopilot cycle. Matched case-insensitively. */
const WRITE_CAPABLE_MARKERS: readonly string[] = [
  "serve",
  "install-cron",
  "autopilot",
  "jobs work",
  "jobs-work",
  "jobs_work",
  "dream",
  "synthesize",
  "--fix",
  "put_page",
  "put-page",
  "put page",
  "add_link",
  "add-link",
  "writebrainpage",
];

/**
 * Classify a gbrain command line by capability. Write markers win first (a
 * marker on an otherwise read-only base command still classifies write-capable);
 * then the read-only allow-set; then default-deny — an UNKNOWN command is
 * treated as write-capable so an unrecognized stray still alarms.
 */
export function classifyGbrainCommand(command: string): GbrainCommandClass {
  const normalized = command.toLowerCase();
  if (WRITE_CAPABLE_MARKERS.some((m) => normalized.includes(m))) {
    return "write_capable";
  }
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);
  const isKnownReadOnly = tokens.some((t) =>
    (READ_ONLY_GBRAIN_COMMANDS as readonly string[]).includes(t),
  );
  return isKnownReadOnly ? "read_only" : "write_capable";
}

/** One observed running gbrain process, as reported by the worker's continuous
 *  probe (injected — no process introspection happens in this unit). */
export interface ObservedGbrainProcess {
  /** OS process identity (open — the format is the probe's, not pinned here). */
  readonly pid: string | number;
  /** The argv summary, e.g. `"gbrain sync --install-cron"`. */
  readonly command: string;
  /** Which brain's vault/PGLite this process is bound to. */
  readonly boundBrainId: BrainId;
  /** The vault mount mode this process sees. */
  readonly mount: VaultMountMode;
  /** Whether this process holds the PGLite advisory lock (only the worker may). */
  readonly holdsPgliteLock: boolean;
}

/** The closed set of one-writer / lockdown breach reasons. */
export type WriteFenceBreachReason =
  // ── posture-not-established (preventive layer absent) → write_through_failed ──
  | "vault_acl_not_worker_exclusive"
  | "pglite_lock_not_worker_held"
  // ── active stray writer detected (the continuous probe fires) → conflict_review ──
  | "stray_write_capable_process"
  | "gbrain_process_read_write_mounted"
  | "pglite_lock_held_by_gbrain";

/** A single fence alarm: a typed breach reason, the offending process (when
 *  process-scoped), and a ready-to-surface §16 System-Health item. */
export interface WriteFenceAlarm {
  readonly reason: WriteFenceBreachReason;
  readonly offendingPid?: string | number;
  readonly offendingCommand?: string;
  readonly healthItem: HealthItem;
}

/** Injected surroundings for building alarm HealthItems — no ambient clock/id. */
export interface WriteFenceContext {
  /** ISO-8601 clock for `HealthItem.openedAt`. */
  readonly now: () => string;
  /** AuditId of the fence-evaluation audit record recorded alongside. */
  readonly auditRef: string;
  /** Optional open-taxonomy severity override (arch_gap — §16 pins no closed
   *  set); defaults per reason (`conflict_review`→critical, posture→error). */
  readonly severity?: string;
  /** Optional HealthItem id prefix (dedupe id is (failureClass, subjectRef) per
   *  §10.3, not this field); defaults to `"gbrain-write-fence"`. */
  readonly healthItemIdPrefix?: string;
}

/** Top-level fence input: the OS-posture facts + the observed process set. */
export interface WriteFenceInput {
  /** The canonical brain this fence instance guards. */
  readonly canonicalBrainId: BrainId;
  /** Filesystem-ACL fact: is the worker the SOLE OS principal that can write the
   *  vault directory? (injected probe result) */
  readonly workerIsSoleVaultWriter: boolean;
  /** Who holds the per-brain PGLite advisory lock (must be exactly `worker`). */
  readonly pgliteLockHolder: PgliteLockHolder;
  /** The continuous probe's observed running gbrain processes. */
  readonly observedProcesses: readonly ObservedGbrainProcess[];
}

/** The fence holds: gbrain physically cannot write canonical `.md` — write-through
 *  is OS-safe for this brain. */
export interface WriteFenceIntact {
  readonly status: "intact";
  readonly canonicalBrainId: BrainId;
  readonly scannedProcessCount: number;
}

/** The fence is breached: one or more typed reasons, each with an alarm. Fails
 *  closed — the caller must NOT treat write-through as OS-safe for this brain. */
export interface WriteFenceBreached {
  readonly status: "breached";
  readonly reasons: readonly WriteFenceBreachReason[];
  readonly alarms: readonly WriteFenceAlarm[];
}

const REASON_FAILURE_CLASS: Record<WriteFenceBreachReason, FailureClass> = {
  // The OS lockdown posture that MAKES write-through safe is not established, so
  // the write-through layer must not run — degrade to read-only/index-only.
  vault_acl_not_worker_exclusive: "write_through_failed",
  pglite_lock_not_worker_held: "write_through_failed",
  // A write-capable gbrain process actually exists against a canonical brain —
  // an active one-writer breach; surfaced as a conflict-review hard alarm.
  stray_write_capable_process: "conflict_review",
  gbrain_process_read_write_mounted: "conflict_review",
  pglite_lock_held_by_gbrain: "conflict_review",
};

const REASON_SEVERITY: Record<WriteFenceBreachReason, string> = {
  vault_acl_not_worker_exclusive: "error",
  pglite_lock_not_worker_held: "error",
  stray_write_capable_process: "critical",
  gbrain_process_read_write_mounted: "critical",
  pglite_lock_held_by_gbrain: "critical",
};

const REASON_MESSAGE: Record<WriteFenceBreachReason, string> = {
  vault_acl_not_worker_exclusive:
    "the SoW worker is not the sole OS principal with vault write access; write-through OS-lockdown not established (degrade to read-only/index-only)",
  pglite_lock_not_worker_held:
    "the PGLite advisory lock is not held by the SoW worker; single-owner lockdown not established (degrade to read-only/index-only)",
  stray_write_capable_process:
    "a stray write-capable gbrain process is bound to a canonical brain (one-writer breach)",
  gbrain_process_read_write_mounted:
    "a gbrain process is running against a read-WRITE vault mount (one-writer breach — mount must be read-only/immutable-snapshot)",
  pglite_lock_held_by_gbrain:
    "a gbrain process holds the PGLite advisory lock (one-writer breach — the lock is the worker's alone)",
};

function buildAlarm(
  reason: WriteFenceBreachReason,
  ctx: WriteFenceContext,
  offending?: { readonly pid: string | number; readonly command: string },
): WriteFenceAlarm {
  const prefix = ctx.healthItemIdPrefix ?? "gbrain-write-fence";
  const idSuffix = offending !== undefined ? `:${String(offending.pid)}` : "";
  const message =
    offending !== undefined
      ? `${REASON_MESSAGE[reason]} — process '${offending.command}' (pid=${String(offending.pid)})`
      : REASON_MESSAGE[reason];
  const healthItem: HealthItem = {
    id: `${prefix}:${reason}${idSuffix}`,
    failureClass: REASON_FAILURE_CLASS[reason],
    severity: ctx.severity ?? REASON_SEVERITY[reason],
    message,
    auditRef: ctx.auditRef as AuditId,
    openedAt: ctx.now(),
    state: "open",
  };
  return {
    reason,
    ...(offending !== undefined
      ? { offendingPid: offending.pid, offendingCommand: offending.command }
      : {}),
    healthItem,
  };
}

/**
 * The CONTINUOUS probe. For every observed gbrain process bound to
 * `canonicalBrainId`, emit one typed alarm per breach it trips: a write-capable
 * command, a read-write mount, or a held PGLite lock. Processes bound to a
 * different brain are ignored (this fence is per-brain). Pure — returns the list
 * of alarms (empty = clean); never throws (§16).
 */
export function scanForStrayWriters(
  canonicalBrainId: BrainId,
  processes: readonly ObservedGbrainProcess[],
  ctx: WriteFenceContext,
): readonly WriteFenceAlarm[] {
  const alarms: WriteFenceAlarm[] = [];
  for (const p of processes) {
    if (p.boundBrainId !== canonicalBrainId) {
      continue;
    }
    const offending = { pid: p.pid, command: p.command };
    if (classifyGbrainCommand(p.command) === "write_capable") {
      alarms.push(buildAlarm("stray_write_capable_process", ctx, offending));
    }
    if (p.mount !== "read_only") {
      alarms.push(buildAlarm("gbrain_process_read_write_mounted", ctx, offending));
    }
    if (p.holdsPgliteLock) {
      alarms.push(buildAlarm("pglite_lock_held_by_gbrain", ctx, offending));
    }
  }
  return alarms;
}

/**
 * Evaluate the full OS-level one-writer lockdown for `canonicalBrainId`: the
 * worker-principal posture (sole vault writer + sole advisory-lock holder) plus
 * the continuous stray-writer scan. INTACT ⇒ `ok` (gbrain physically cannot
 * write canonical `.md`). Any breach ⇒ a fail-closed typed `err` aggregating
 * EVERY reason + its alarm. Never throws (§16).
 */
export function evaluateWriteFence(
  input: WriteFenceInput,
  ctx: WriteFenceContext,
): Result<WriteFenceIntact, WriteFenceBreached> {
  const alarms: WriteFenceAlarm[] = [];
  if (!input.workerIsSoleVaultWriter) {
    alarms.push(buildAlarm("vault_acl_not_worker_exclusive", ctx));
  }
  // Default-deny: only an explicit `worker` holder is safe (`none`/`gbrain`/
  // `unknown` all fail closed).
  if (input.pgliteLockHolder !== "worker") {
    alarms.push(buildAlarm("pglite_lock_not_worker_held", ctx));
  }
  alarms.push(...scanForStrayWriters(input.canonicalBrainId, input.observedProcesses, ctx));

  if (alarms.length > 0) {
    return err({
      status: "breached",
      reasons: alarms.map((a) => a.reason),
      alarms,
    });
  }
  return ok({
    status: "intact",
    canonicalBrainId: input.canonicalBrainId,
    scannedProcessCount: input.observedProcesses.length,
  });
}
