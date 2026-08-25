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
  EgressClass,
  EgressPolicy,
  ProcessorId,
  ProviderId,
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
import { processorOfRoute, endpointHostRef, MALFORMED_ROUTE_PROCESSOR } from "./processors";

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

  // ── 2b. UNCLASSIFIABLE route ⇒ deny (never allowlist-satisfiable) ──────────
  // `MALFORMED_ROUTE` is a SENTINEL meaning "this route could not be identified",
  // not a destination — so it must not reach step 3, where it would be compared
  // against `allowedProcessors` like any real processor id and ALLOWED by an entry
  // naming it. That entry is reachable: `boot.ts` brands operator-supplied strings
  // into the allowlist. Denying here keeps "we could not classify it" from ever
  // being satisfiable by configuration.
  if (proc === MALFORMED_ROUTE_PROCESSOR) {
    return deny(
      "MALFORMED_POLICY_INPUT",
      "route identity could not be classified; an unidentifiable route is never eligible to egress",
      refs,
    );
  }

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

// ─── §19 embedding-backend egress predicate (safety rule 5, the gbrain-layer
// gap) ───────────────────────────────────────────────────────────────────────
//
// `packages/knowledge/src/gbrain/local-embed.ts:220-231` records the exact gap
// this predicate closes: an `EmbeddingBackend` descriptor carries NO endpoint,
// so there is no loopback-endpoint PROOF the way `egressVeto` has one
// (`route.endpoint` + `isLoopbackEndpoint`). `embeddingEgressVeto` is
// therefore WEAKER than `egressVeto` — it cannot close the tunneled-local hole
// by endpoint proof, because there is no endpoint to check. The compensating
// requirement is that BOTH the declared `egressClass` AND the provider
// identity must be local: a cloud provider id claiming `egressClass: 'local'`
// still denies (mirrors `processorOfRoute`'s "the named provider identity
// wins" rule — reused via `processorOfRoute` itself below, never re-declared
// as a second copy of the local-provider set). Never describe this predicate
// as "endpoint-verified" — it is not.
//
// Scope: this predicate implements ONLY the hard veto (rule 5), not a general
// allowlist — an `EmbeddingBackend` descriptor carries no configured
// `allowedProcessors` the way `EgressPolicy` does, so there is nothing to
// allowlist against here. Outside the veto condition (ack ON, non-employer
// workspace, or non-raw content) ANY backend is permitted — mirroring
// `egressVeto`'s own escape hatch once the veto condition no longer holds.

/** A fixed loopback proof endpoint — see {@link isGenuinelyLocalEmbeddingProvider}. */
const EMBED_PROOF_ENDPOINT = "http://127.0.0.1" as const;

/**
 * True IFF `providerId` is a genuinely local (zero-egress) provider identity.
 * REUSES `processorOfRoute`'s proof rather than re-declaring the local-
 * provider set in this module: a synthetic route claiming `egressClass:
 * 'local'` on a FIXED loopback endpoint classifies as non-egress (`null`)
 * ONLY for a provider identity `processorOfRoute` itself treats as genuinely
 * local (ollama / lm_studio today) — a cloud provider id (claude / openai /
 * openrouter / …) never launders through a claimed-loopback route, by that
 * function's own design (the named provider identity wins). The endpoint is a
 * fixed PROOF value, not evidence about the real backend — the real backend
 * carries none (see the module note above). Pure; never throws (totality is
 * inherited from `processorOfRoute`, including its blank-identity handling).
 */
function isGenuinelyLocalEmbeddingProvider(providerId: ProviderId): boolean {
  return (
    processorOfRoute({
      provider: providerId,
      model: "embedding-proof",
      endpoint: EMBED_PROOF_ENDPOINT,
      egressClass: "local",
    }) === null
  );
}

/**
 * Embedding-backend egress VETO (§19, safety rule 5). Mirrors `egressVeto`'s
 * employer-raw-unacked veto shape exactly, adapted to the no-endpoint
 * `EmbeddingBackend` seam (`RetrievalEgressGate.check`,
 * `local-embed.ts:74-94`): raw Employer-Work content with the egress
 * acknowledgment OFF may use ONLY a genuinely local backend —
 * `egressClass === 'local'` AND a genuinely local provider identity (never a
 * label alone). No cloud fallback. Every decision — allow AND deny — emits a
 * redaction-safe `AuditSignal` with `healthSignalClass` set, matching
 * `egressVeto`'s allow-and-deny visibility contract. Pure; never throws.
 */
export function embeddingEgressVeto(
  backend: { readonly providerId: ProviderId; readonly egressClass: EgressClass },
  workspace: {
    readonly type: WorkspaceType;
    readonly carriesRawContent: boolean;
    readonly employerRawEgressAcknowledged: boolean;
  },
): PolicyDecision<{ readonly backendPermitted: true }> {
  // ── 0. FAIL-CLOSED malformed guard (never fail-open) ───────────────────────
  if (
    backend == null ||
    typeof backend !== "object" ||
    typeof backend.providerId !== "string" ||
    typeof backend.egressClass !== "string" ||
    workspace == null ||
    typeof workspace !== "object" ||
    typeof workspace.type !== "string" ||
    typeof workspace.carriesRawContent !== "boolean" ||
    typeof workspace.employerRawEgressAcknowledged !== "boolean"
  ) {
    return embedDeny(
      "MALFORMED_POLICY_INPUT",
      "embedding-backend egress evaluation received missing or malformed backend/workspace input",
      ["ref:embedding-egress:malformed-input"],
    );
  }

  const genuinelyLocal =
    backend.egressClass === "local" && isGenuinelyLocalEmbeddingProvider(backend.providerId);

  const refs: readonly string[] = [
    `ref:provider:${backend.providerId}`,
    `ref:egress-class:${backend.egressClass}`,
  ];

  const employerRawUnacked =
    workspace.type === "employer_work" &&
    workspace.carriesRawContent === true &&
    workspace.employerRawEgressAcknowledged === false;

  if (employerRawUnacked && !genuinelyLocal) {
    return embedDeny(
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "raw Employer-Work content may not embed with acknowledgment OFF; only a genuinely local embedding backend is eligible (no cloud fallback)",
      refs,
    );
  }

  return embedAllow(refs, "embedding backend permitted");
}

function embedAllow(
  refs: readonly string[],
  afterSummary: string,
): PolicyDecision<{ readonly backendPermitted: true }> {
  const audit: AuditSignal = buildAuditSignal({
    actor: EGRESS_ACTOR,
    event: "embedding-egress.allowed",
    refs,
    payloadHash: EGRESS_PAYLOAD_MARKER,
    beforeSummary: "embedding egress not evaluated",
    afterSummary,
    healthSignalClass: EGRESS_STATUS_HEALTH_CLASS,
  });
  return allowDecision({ backendPermitted: true }, audit);
}

function embedDeny(
  reason: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED" | "MALFORMED_POLICY_INPUT",
  message: string,
  refs: readonly string[],
): PolicyDecision<{ readonly backendPermitted: true }> {
  const audit: AuditSignal = buildAuditSignal({
    actor: EGRESS_ACTOR,
    event: "embedding-egress.denied",
    refs,
    payloadHash: EGRESS_PAYLOAD_MARKER,
    beforeSummary: "embedding egress not evaluated",
    afterSummary: message,
    denialCode: reason,
    healthSignalClass: EGRESS_STATUS_HEALTH_CLASS,
  });
  return denyDecision(reason, message, audit);
}
