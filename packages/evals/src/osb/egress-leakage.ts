// spec(§5 rule 5 · §6 · §8 · WS-8 rule 4) — task 13.1 gate (b): the OSB
// anti-corruption-layer egress-leakage eval.
//
// Gate (a) (`anti-corruption-guard.ts`) proves the OSB-inherited source-extraction
// family (packages/integrations/src/connectors/adapters/*-source.ts) never WRITES.
// This gate proves the complementary DYNAMIC property: a candidate that family
// admits through the REAL `registerSource()` boundary can still carry Employer-Work
// raw content, and once it reaches a cloud-capable DOWNSTREAM job (living-vault /
// Copilot synthesis, §6/§13.8 — the actual consumer of a registered Source), that
// content must be held by BOTH standing governance gates:
//   • rule 4 (WS-8): a direct cross-workspace RAW read is denied
//     (`denyDirectCrossWorkspaceRaw`) and a raw/full GCL projection exceeding the
//     source workspace's isolated default is refused (`validateProjectionVisibility`)
//     — the SAME `@sow/policy` primitives `suites/leakage/workspace-leakage.test.ts`
//     drives.
//   • rule 5: a job carrying it as raw content is VETOED off any cloud processor
//     while the workspace's egress acknowledgment is OFF (`vetoJobEgress`,
//     `@sow/providers/broker/egress-veto` — the SAME broker seam task 13.13r proved
//     the research-provider path through), with NO cloud fallback.
//
// Scored over `packages/evals/corpora/leakage` (task 12.3's project-owned corpus,
// previously consumed ONLY by the floor check in `test/corpora/corpora-floors.test.ts`
// — this gate is its first real consumer). Reuses the REAL, already-wired
// policy/broker primitives verbatim — no fixture provider, no fake gate — so this is
// a genuine, deterministic (no real integration required) re-proof scoped to the OSB
// inheritance, not a duplicate of the general §20.1 workspace-leakage suite: that
// suite proves rule 4 alone over a bare projection; this proves rule 4 AND rule 5
// hold for content shaped like what the OSB-inherited extractor family would emit
// into a synthesis job.
//
// `vendor/osb/` itself (real vendored code) is a SEPARATE, still-blocked leg (no
// upstream tree — owner-gated real-vendor I/O); this gate runs today against the
// project's own corpus and re-runs unchanged against real vendored content once
// vendoring lands.
//
// PURE: no clock/network/randomness. Never throws — every outcome is a typed
// `PolicyDecision`.

import type {
  AgentJob,
  EgressPolicy,
  ProviderRoute,
  WorkspaceType,
  DataOwner,
  Workspace,
  GclProjection,
} from "@sow/contracts";
import { processorId } from "@sow/contracts";
import { denyDirectCrossWorkspaceRaw, validateProjectionVisibility, isDeny, type PolicyDecision } from "@sow/policy";
import { vetoJobEgress } from "@sow/providers/broker/egress-veto";
import type { LeakageCorpusEntry } from "../harness/corpus-schemas";

/** The cloud synthesis route an OSB-sourced job resolves to absent a local backend
 *  (the rule-5 leg — mirrors `suites/egress-ack/egress-veto.test.ts`'s `cloudRoute`). */
export const OSB_SYNTHESIS_CLOUD_ROUTE: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

/**
 * Builds the downstream synthesis job a `registerSource()`-admitted OSB candidate
 * feeds (living-vault / Copilot synthesis, §6/§13.8) — carries the corpus entry's
 * raw content as `carriesRawContent: true` so the rule-5 veto sees it correctly.
 * Untrusted (ING-7: the extracted content is untrusted external input).
 */
export function buildOsbSynthesisJob(entry: LeakageCorpusEntry, over: Partial<AgentJob> = {}): AgentJob {
  return {
    id: `osb-job-${entry.id}` as AgentJob["id"],
    workflowRunId: "wf-osb-synthesis" as AgentJob["workflowRunId"],
    workspaceId: "ws-emp-osb-001" as AgentJob["workspaceId"],
    capability: "knowledge.synthesize" as AgentJob["capability"],
    contextRefs: [{ refKind: "source", ref: `src:${entry.id}` }],
    outputSchemaId: "sow:knowledge-mutation-plan",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    providerRoute: OSB_SYNTHESIS_CLOUD_ROUTE,
    trustLevel: "untrusted",
    carriesRawContent: true,
    maxRuntimeSeconds: 300,
    idempotencyKey: `idem-osb-${entry.id}`,
    ...over,
  };
}

function osbEgressPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    workspaceId: "ws-emp-osb-001" as EgressPolicy["workspaceId"],
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
    ...over,
  };
}

/** The source workspace for every corpus entry: Employer-Work, `isolated` default
 *  (the tightest level — nothing crosses by default). Mirrors
 *  `workspace-leakage.test.ts`'s `employerWorkspace` fixture. */
export const OSB_SOURCE_WORKSPACE: Workspace = {
  id: "ws-emp-osb-001" as Workspace["id"],
  name: "Employer Work (OSB source)",
  type: "employer_work",
  dataOwner: "employer",
  markdownRepoPath: "/vault/employer",
  gbrainBrainId: "brain-employer" as Workspace["gbrainBrainId"],
  defaultVisibility: "isolated",
  egressPolicy: osbEgressPolicy(),
  providerMatrix: {
    workspaceId: "ws-emp-osb-001" as Workspace["providerMatrix"]["workspaceId"],
    allowedProviders: ["claude"],
    capabilityDefaults: {},
    rawCloudEgressEnabled: false,
  },
};

const employerWs: { readonly type: WorkspaceType; readonly dataOwner: DataOwner } = {
  type: "employer_work",
  dataOwner: "employer",
};

/** The reader workspace id for a probe (mirrors `workspace-leakage.test.ts`). */
function readerWorkspaceId(target: LeakageCorpusEntry["targetWorkspace"]): string {
  return target === "global" ? "ws-global-scope" : `ws-${target}`;
}

/** A raw/full projection carrying THIS entry's employer content. */
function projectionFor(entry: LeakageCorpusEntry): GclProjection {
  return {
    workspaceId: OSB_SOURCE_WORKSPACE.id,
    visibilityLevel: "full",
    projectionType: "raw-context",
    sanitizedPayload: { rawEmployerContent: entry.rawEmployerContent },
    sourceRefs: [],
  };
}

const DIRECT_PROTECTIVE_DENY = "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL";
const PROJECTION_PROTECTIVE_DENY = "VISIBILITY_EXCEEDS_SOURCE";
const EGRESS_PROTECTIVE_DENY = "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED";

/** A denial that evidences the gate DECIDING (its protective reason), not a
 *  malformed-input deny masquerading as protection. Mirrors
 *  `workspace-leakage.test.ts`'s `deniedProtectively`. */
export function deniedProtectively<T>(d: PolicyDecision<T>, expectedReason: string): boolean {
  return isDeny(d) && d.reason === expectedReason;
}

/** rule 4 leg (a): the direct cross-brain raw read is denied. */
export function osbCrossWorkspaceRawDecision(entry: LeakageCorpusEntry): PolicyDecision<unknown> {
  return denyDirectCrossWorkspaceRaw({
    fromWorkspaceId: readerWorkspaceId(entry.targetWorkspace),
    toWorkspaceId: OSB_SOURCE_WORKSPACE.id,
  });
}

/** rule 4 leg (b): a raw/full projection of the entry's content is refused. */
export function osbProjectionDecision(entry: LeakageCorpusEntry): PolicyDecision<GclProjection> {
  return validateProjectionVisibility(projectionFor(entry), OSB_SOURCE_WORKSPACE);
}

/**
 * rule 5: the downstream synthesis job carrying this entry's raw content is vetoed
 * off the cloud route while `employerRawEgressAcknowledged` is OFF. Pass
 * `ack: true` to exercise the allow-side control (the deny is a decision, not a
 * wall).
 */
export function osbCloudEgressDecision(entry: LeakageCorpusEntry, ack = false): PolicyDecision<ProviderRoute> {
  const job = buildOsbSynthesisJob(entry);
  // ack ON also re-opens the normal allowlist path (§5 step 3) — pass the route's
  // own processor as allowlisted so the ALLOW control isolates the VETO decision
  // (ack OFF→ON) rather than tripping a separate PROCESSOR_NOT_ALLOWED deny.
  const policy = ack
    ? osbEgressPolicy({
        employerRawEgressAcknowledged: true,
        allowedProcessors: [processorId("claude")],
        rawContentAllowedProcessors: [processorId("claude")],
      })
    : osbEgressPolicy({ employerRawEgressAcknowledged: false });
  return vetoJobEgress(job, job.providerRoute, policy, employerWs);
}

/**
 * The measured metric: how many raw Employer sentences actually surface once ALL
 * THREE gates are consulted. A PROTECTIVE deny on any one of them means the raw
 * path never opens ⇒ 0 sentences leak. A deny for any OTHER reason (e.g. a
 * malformed-input default-deny) is NOT evidence and deliberately falls through to
 * the sentence count, so a broken fixture goes RED rather than certifying a false
 * pass (mirrors `workspace-leakage.test.ts`'s `leakedSentences`).
 */
export function osbLeakedSentences(entry: LeakageCorpusEntry): number {
  const direct = osbCrossWorkspaceRawDecision(entry);
  const projection = osbProjectionDecision(entry);
  const egress = osbCloudEgressDecision(entry);
  if (
    deniedProtectively(direct, DIRECT_PROTECTIVE_DENY) ||
    deniedProtectively(projection, PROJECTION_PROTECTIVE_DENY) ||
    deniedProtectively(egress, EGRESS_PROTECTIVE_DENY)
  ) {
    return 0;
  }
  // (Unreachable under the real gates — kept honest so a regression would surface.)
  return entry.rawEmployerContent.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0).length;
}

export interface OsbEgressLeakageReport {
  readonly cases: number;
  readonly totalLeakedSentences: number;
}

/** Scores the full corpus: total raw-sentence leakage across ALL three gates (must be 0). */
export function scoreOsbEgressLeakage(entries: readonly LeakageCorpusEntry[]): OsbEgressLeakageReport {
  return {
    cases: entries.length,
    totalLeakedSentences: entries.reduce((n, e) => n + osbLeakedSentences(e), 0),
  };
}
