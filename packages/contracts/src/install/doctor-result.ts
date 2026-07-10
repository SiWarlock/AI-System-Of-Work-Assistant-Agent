// Install-doctor result contract (task 11.5, §13 install/packaging — the doctor/repair command).
//
// A LOCAL `install/` operational result — additive, NOT an Appendix-A frozen seam (like `api/ui-safe.ts` /
// `config/config-schema.ts`): no `__snapshots__`, no ajv registry, no cross-doc round. Zod-as-source (the TS
// types are `z.infer`); a producer that hand-builds a report can `.safeParse` it to enforce the contract.
//
// The doctor runs a fixed set of prerequisite checks (§13) and reports, per check, a typed status + — on any
// non-`ok` — a DISTINCT typed `failureVariant` and a concrete `repair` step. The overall roll-up is DERIVED
// worst-of (never independently settable). The three write-through one-writer POSTURE checks (vault-ACL /
// gbrain-readonly-mount / stray-gbrain-process, REQ-S-NEW-008 / safety rule 1) fail CLOSED to `finding` — a
// writable/mispointed mount or a stray gbrain writer re-opens GO #1 and must never resolve to a silent `ok`.
//
// PURE — imports only `zod` (no branded fields, no downstream imports; §2.5 import-direction root).
import { z } from "zod";

/** The fixed set of prerequisite checks the install doctor runs (§13). A CLOSED enum — order is the report order. */
export const DOCTOR_CHECK_IDS = [
  "node_pnpm",
  "filevault",
  "keychain",
  "temporal_startable",
  "gbrain_startable",
  "loopback_ports",
  "git_remotes",
  // ── write-through one-writer POSTURE (REQ-S-NEW-008 / safety rule 1) ──
  "vault_acl",
  "gbrain_readonly_mount",
  "stray_gbrain_process",
] as const;
export const doctorCheckIdSchema = z.enum(DOCTOR_CHECK_IDS);
export type DoctorCheckId = z.infer<typeof doctorCheckIdSchema>;

/**
 * A check's status. `ok` (prereq met) < `degraded` (a tolerated first-class degraded mode — the app still runs,
 * e.g. Temporal/GBrain unavailable, §9/§16) < `finding` (a prereq to fix, incl. every fail-closed posture
 * defect). The ordering is the worst-of roll-up severity.
 */
export const doctorStatusSchema = z.enum(["ok", "degraded", "finding"]);
export type DoctorStatus = z.infer<typeof doctorStatusSchema>;

/** Severity order for the worst-of roll-up: ok < degraded < finding. */
export const DOCTOR_STATUS_SEVERITY: Readonly<Record<DoctorStatus, number>> = {
  ok: 0,
  degraded: 1,
  finding: 2,
};

/** The typed failure variant on a non-`ok` check — DISTINCT per variant (no catch-all). */
export const doctorFailureVariantSchema = z.enum([
  "node_or_pnpm_unsatisfied",
  "filevault_off",
  "keychain_unreachable",
  "temporal_not_startable",
  "gbrain_not_startable",
  "loopback_port_occupied",
  "git_remote_missing",
  // ── posture (fail-closed) ──
  "vault_acl_not_worker_exclusive",
  "gbrain_mount_writable_or_mispointed",
  "stray_gbrain_writer_detected",
  // ── §16: a diagnoser threw over a malformed probe → folded fail-closed ──
  "probe_error",
]);
export type DoctorFailureVariant = z.infer<typeof doctorFailureVariantSchema>;

// The FULL Unicode newline family a single-line `detail` must not contain: CR, LF, VT (U+000B), FF (U+000C),
// NEL (U+0085), LS (U+2028), PS (U+2029). A charCode Set — NEVER a regex literal — so no line terminator ever
// sits in this source (a literal U+2028/U+2029 would itself terminate a line; the trap LESSONS §-normalizer
// pins). Posture details name only closed op labels; this is a defense-in-depth structural bound.
const NEWLINE_FAMILY = new Set([0x0d, 0x0a, 0x0b, 0x0c, 0x85, 0x2028, 0x2029]);
function isSingleLine(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (NEWLINE_FAMILY.has(s.charCodeAt(i))) return false;
  }
  return true;
}

// A redaction-safe, single-line, bounded detail string (≤256).
const doctorDetail = z
  .string()
  .min(1)
  .max(256)
  .refine(isSingleLine, { message: "detail must be single-line" });

/**
 * One check's result. INVARIANT (refine): a non-`ok` status MUST carry a `failureVariant` + a concrete `repair`
 * (the doctor's entire value is a distinct repair per failing prereq); an `ok` status carries NEITHER. `.strict()`
 * so a producer cannot smuggle an extra field.
 */
export const doctorCheckResultSchema = z
  .object({
    check: doctorCheckIdSchema,
    status: doctorStatusSchema,
    failureVariant: doctorFailureVariantSchema.optional(),
    repair: z.string().min(1).optional(),
    detail: doctorDetail.optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.status === "ok"
        ? r.failureVariant === undefined && r.repair === undefined
        : r.failureVariant !== undefined && r.repair !== undefined,
    { message: "a non-ok check MUST carry a failureVariant + repair; an ok check carries neither" },
  );
export type DoctorCheckResult = z.infer<typeof doctorCheckResultSchema>;

/** The full doctor report: the ordered per-check results + a DERIVED worst-of roll-up. */
export const doctorReportSchema = z
  .object({
    checks: z.array(doctorCheckResultSchema),
    overall: doctorStatusSchema,
  })
  .strict();
export type DoctorReport = z.infer<typeof doctorReportSchema>;

/** Roll up a set of check statuses to the WORST-of (ok < degraded < finding). Empty ⇒ ok. Pure. */
export function rollUpStatus(statuses: readonly DoctorStatus[]): DoctorStatus {
  return statuses.reduce<DoctorStatus>(
    (worst, s) => (DOCTOR_STATUS_SEVERITY[s] > DOCTOR_STATUS_SEVERITY[worst] ? s : worst),
    "ok",
  );
}
