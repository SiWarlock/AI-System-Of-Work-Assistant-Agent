// §5 EgressPolicy enforcement + the Employer-Work raw-content egress VETO —
// HARD DENIAL #1, safety rule 5 (REQ-S-002 / REQ-S-005 / REQ-F-001). This is the
// most safety-critical predicate in the phase: raw Employer-Work content with the
// egress acknowledgment OFF may go ONLY to a genuine loopback-local (zero-egress)
// provider; any egress processor — including a tunneled-'local' route — FAILS
// CLOSED. There is NO cloud fallback.
//
// The veto runs AFTER provider selection (3.3) and can only NARROW or DENY, never
// widen. PURE — no clock, network, or randomness; every outcome is a typed
// PolicyDecision, never a thrown error (§16). FAIL-CLOSED: missing / malformed
// input ⇒ DENY. REDACTION-SAFE: audit signals carry the processor id + refs /
// codes only — never raw content, prompts, credentials, or tokens.
import type {
  AgentJob,
  DataOwner,
  EgressPolicy,
  ProcessorId,
  ProviderRoute,
  WorkspaceType,
} from "@sow/contracts";
import {
  allowDecision,
  denyDecision,
  type PolicyDecision,
} from "./decision";
import {
  buildAuditSignal,
  type AuditSignal,
} from "./audit-signal";
import { processorOfRoute, endpointHostRef } from "./processors";

const EGRESS_ACTOR = "policy:egress" as const;

// A payloadHash-shaped decision marker (policy is pure — no hasher outside
// session-auth). Redaction-safe fixed constant; the routing identity rides the
// refs. Mirrors provider-matrix.ts's ROUTE_PAYLOAD_MARKER convention.
const EGRESS_PAYLOAD_MARKER = "policy:egress-decision" as const;

// ARCH_GAP / task-flag: the egress veto sets healthSignalClass on EVERY decision
// (allow AND deny) — REQ-S-002 requires the FULL allow/deny egress stream to be
// visible to System Health, not only denials. So we do NOT reuse
// POLICY_DENIAL_HEALTH_CLASS (which would mislabel allows as denials); we use a
// dedicated egress-status class. Like healthSignalClass generally, it is a
// policy-internal field dropped at the AuditRecord boundary (the frozen
// AuditRecordSchema is `.strict()` and names it nowhere).
export const EGRESS_STATUS_HEALTH_CLASS = "egress_status" as const;

/** A `ref:processor:*` tag; a genuine loopback-local (null processor) is tagged distinctly. */
function processorRef(proc: ProcessorId | null): string {
  return proc === null ? "ref:processor:LOCAL_NONE" : `ref:processor:${proc}`;
}

/**
 * Employer-Work raw-content egress VETO + normal egress allowlist enforcement.
 *
 * Order (order matters — the veto has precedence over the allowlist):
 *   0. FAIL-CLOSED guard: malformed job/route/egress/workspace ⇒ MALFORMED_POLICY_INPUT.
 *   1. proc = processorOfRoute(route). proc===null ⇒ a genuine loopback-local
 *      (non-egress) route.
 *   2. VETO: workspace.type==='employer_work' AND job.carriesRawContent AND
 *      egress.employerRawEgressAcknowledged===false ⇒ the ONLY eligible route is
 *      loopback-local (proc===null). Any egress processor (proc!==null, incl. a
 *      tunneled-'local') ⇒ deny EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED (no cloud
 *      fallback). ack ON re-opens the allowlist path below; because this is a
 *      pure function it re-evaluates per job with no cached allow.
 *   3. Normal allowlist (egress routes, proc!==null): proc ∈ allowedProcessors,
 *      AND — when the job carries raw content — proc ∈ rawContentAllowedProcessors;
 *      else deny PROCESSOR_NOT_ALLOWED.
 *   4. A genuine loopback-local route (proc===null) is always egress-safe (allow).
 *
 * Every decision — allow AND deny — emits a redaction-safe AuditSignal carrying
 * healthSignalClass (egress System-Health visibility). Pure; never throws.
 */
export function egressVeto(
  job: AgentJob,
  route: ProviderRoute,
  egress: EgressPolicy,
  workspace: { type: WorkspaceType; dataOwner: DataOwner },
): PolicyDecision<ProviderRoute> {
  // ── 0. FAIL-CLOSED malformed guard (never fail-open) ───────────────────────
  // Frozen contract shapes SHOULD arrive well-formed; a null/degenerate input is
  // treated as a default-deny, never silently allowed.
  if (
    job == null ||
    typeof job !== "object" ||
    route == null ||
    typeof route !== "object" ||
    typeof route.endpoint !== "string" ||
    typeof route.egressClass !== "string" ||
    egress == null ||
    typeof egress !== "object" ||
    !Array.isArray(egress.allowedProcessors) ||
    !Array.isArray(egress.rawContentAllowedProcessors) ||
    typeof egress.employerRawEgressAcknowledged !== "boolean" ||
    workspace == null ||
    typeof workspace !== "object" ||
    typeof workspace.type !== "string" ||
    typeof job.carriesRawContent !== "boolean"
  ) {
    return deny(
      "MALFORMED_POLICY_INPUT",
      "egress evaluation received missing or malformed job/route/egress/workspace input",
      ["ref:egress:malformed-input"],
    );
  }

  const proc = processorOfRoute(route);
  const refs: readonly string[] = [
    `ref:job:${job.id}`,
    `ref:workspace:${job.workspaceId}`,
    `ref:workspace-type:${workspace.type}`,
    `ref:data-owner:${workspace.dataOwner}`,
    // Host only — a `user:pass@host` endpoint must not leak its credential here.
    endpointHostRef(route.endpoint),
    `ref:egress-class:${route.egressClass}`,
    processorRef(proc),
  ];

  // ── 2. EMPLOYER-WORK RAW-EGRESS VETO (hard denial #1) ──────────────────────
  const employerRawUnacked =
    workspace.type === "employer_work" &&
    job.carriesRawContent === true &&
    egress.employerRawEgressAcknowledged === false;

  if (employerRawUnacked && proc !== null) {
    // Any egress processor — including a tunneled-'local' route whose endpoint is
    // remote — is refused. NO cloud fallback. The ONLY survivor is a genuine
    // loopback-local route (proc===null), handled by the fall-through allow.
    return deny(
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "raw Employer-Work content may not egress with acknowledgment OFF; only a loopback-local provider is eligible (no cloud fallback)",
      refs,
    );
  }
  // employerRawUnacked && proc===null falls through to (4) — loopback-local allow.

  // ── 3. Normal allowlist (egress routes only, proc!==null) ──────────────────
  if (proc !== null) {
    if (!egress.allowedProcessors.includes(proc)) {
      return deny(
        "PROCESSOR_NOT_ALLOWED",
        "resolved egress processor is not in the workspace allowedProcessors",
        refs,
      );
    }
    if (job.carriesRawContent === true && !egress.rawContentAllowedProcessors.includes(proc)) {
      return deny(
        "PROCESSOR_NOT_ALLOWED",
        "job carries raw content but the processor is not in rawContentAllowedProcessors",
        refs,
      );
    }
    return allow(route, refs, "egress processor allowlisted");
  }

  // ── 4. Genuine loopback-local (proc===null) — always egress-safe ───────────
  return allow(route, refs, "genuine loopback-local route (non-egress)");
}

// ── decision constructors (every decision is auditable + health-visible) ──────

function allow(
  route: ProviderRoute,
  refs: readonly string[],
  afterSummary: string,
): PolicyDecision<ProviderRoute> {
  const audit: AuditSignal = buildAuditSignal({
    actor: EGRESS_ACTOR,
    event: "egress.allowed",
    refs,
    payloadHash: EGRESS_PAYLOAD_MARKER,
    beforeSummary: "egress not evaluated",
    afterSummary,
    healthSignalClass: EGRESS_STATUS_HEALTH_CLASS,
  });
  return allowDecision(route, audit);
}

function deny(
  reason:
    | "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED"
    | "PROCESSOR_NOT_ALLOWED"
    | "MALFORMED_POLICY_INPUT",
  message: string,
  refs: readonly string[],
): PolicyDecision<ProviderRoute> {
  const audit: AuditSignal = buildAuditSignal({
    actor: EGRESS_ACTOR,
    event: "egress.denied",
    refs,
    payloadHash: EGRESS_PAYLOAD_MARKER,
    beforeSummary: "egress not evaluated",
    afterSummary: message,
    denialCode: reason,
    healthSignalClass: EGRESS_STATUS_HEALTH_CLASS,
  });
  return denyDecision(reason, message, audit);
}
