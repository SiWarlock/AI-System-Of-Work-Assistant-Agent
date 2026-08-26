// @sow/integrations — 13.9 NotebookLM GROUNDING port (upload → synthesize →
// force-delete). Types + the closed result/error union only; see
// `notebooklm-ground.ts` for the implementation.
//
// This is the OPPOSITE direction of 6.6 notebooklm.sync (notebook-port.ts /
// notebooklm-sync.ts push vault-derived Markdown OUT to Drive-backed managed
// docs). This port uploads a caller-scoped set of notes into an EPHEMERAL
// NotebookLM store, asks a grounding question against that store, and returns
// the synthesis.
//
// KnowledgeWriter is the ONLY autonomous writer of canonical Markdown (safety
// rule 1). The value `ground()` resolves to is CANDIDATE DATA ONLY (safety
// rule 2) — never written by this port or its implementation; the caller
// routes it through the JSON-Schema gate + validator before anything reaches
// KnowledgeWriter.
//
// §16: `ground` returns a typed Result; nothing throws across the boundary.
// The failure set is closed + enumerable; every `message` is a FIXED safe
// literal (rule 7) — never note content, question text, or a credential.
import type { AgentJob, DataOwner, EgressPolicy, Result, WorkspaceType } from "@sow/contracts";

/**
 * One caller-supplied note admitted to the grounding upload. Each note carries
 * its OWN `workspaceId` — the implementation filters to the target workspace
 * only, BEFORE upload (safety rule 4 / WS-8: no raw cross-workspace
 * retrieval).
 */
export interface NotebookGroundNote {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly body: string;
}

/**
 * The grounding request. `workspaceId` is the TARGET workspace being grounded
 * — any note in `notes` from a different workspace is excluded before upload.
 * `project` (+ the implementation's fixed operation label) build the stable
 * canonicalObjectKey / idempotencyKey the upload dispatches under.
 *
 * `job`/`egress`/`workspace` are the REAL rule-5 `egressVeto` inputs (13.9 —
 * mirrors `free-source-aggregator.ts`'s `ResearchContext`): NotebookLM is a
 * cloud processor, so every grounding call self-runs the real `@sow/policy`
 * veto over these caller-supplied facts BEFORE any upload/transport call.
 */
export interface NotebookGroundRequest {
  readonly workspaceId: string;
  readonly project: string;
  readonly question: string;
  readonly notes: readonly NotebookGroundNote[];
  readonly job: AgentJob;
  readonly egress: EgressPolicy;
  readonly workspace: { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
}

/**
 * The raw transport-side synthesis shape, BEFORE the implementation wraps it
 * as candidate data. `answer` — the grounded synthesis text. `citations` —
 * the store-relative references the transport attributes the answer to.
 */
export interface GroundResult {
  readonly answer: string;
  readonly citations: readonly string[];
}

/**
 * The returned CANDIDATE payload (safety rules 1 + 2). `kind` is a fixed
 * discriminator so a downstream schema gate can recognize the shape; never
 * written by this port — the caller owns routing it to KnowledgeWriter.
 */
export interface NotebookGroundCandidate {
  readonly kind: "notebooklm_ground_candidate";
  readonly answer: string;
  readonly citations: readonly string[];
}

/**
 * The injected grounding transport (NOTHING ARMS — no real client/key/network
 * is bound anywhere in this package; the real Gemini/NotebookLM egress bind is
 * the owner's arming crossing and is explicitly out of scope here). `ground`
 * runs the synthesis question against an already-uploaded ephemeral store.
 * `deleteStore` force-removes that store. Either member MAY THROW (a vendor
 * SDK boundary) — the implementation wraps every call so nothing throws
 * across the port boundary (§16).
 */
export interface NotebookGroundTransport {
  ground(req: { storeRef: string; question: string }): Promise<GroundResult>;
  deleteStore(storeRef: string): Promise<Result<void, { readonly message: string }>>;
}

/**
 * The closed, enumerable failure set (§16).
 *
 * - `egress_denied` — the real rule-5 `@sow/policy` `egressVeto` denied the
 *   request's `{job, egress, workspace}` over the NotebookLM cloud-processor
 *   route (safety rule 5). Fail-closed: zero transport calls, zero dispatch
 *   calls, no cloud fallback, no retry.
 * - `gate_rejected` — the upload's envelope failed the candidate gate before
 *   any external call was issued.
 * - `dispatch_failed` — the upload's `dispatchExternalWrite` returned neither
 *   `created` nor `reused` (approval-pending / conflict / held / rejected).
 * - `transport_fault` — the grounding transport threw, rejected, or returned
 *   a malformed synthesis shape.
 * - `cleanup_failed` — the ephemeral store's delete hop failed or threw AFTER
 *   a successful synthesis. `storeRef` names the residual store (an opaque
 *   id, never content) so the caller can retry/alert. NEVER folded into a
 *   silent `ok` — a leaked ephemeral store is always surfaced.
 *
 * Every `message` is a FIXED safe literal (rule 7) — never note content,
 * question text, or a credential.
 */
export type NotebookGroundError =
  | { readonly code: "egress_denied"; readonly message: string }
  | { readonly code: "gate_rejected"; readonly message: string }
  | { readonly code: "dispatch_failed"; readonly message: string }
  | { readonly code: "transport_fault"; readonly message: string }
  | { readonly code: "cleanup_failed"; readonly message: string; readonly storeRef: string };

/**
 * The NotebookLM grounding port. `ground` is total + never throws; see
 * `notebooklm-ground.ts` for the factory that builds one from injected deps,
 * the envelope wiring, and the dormant default (no production caller binds
 * this port).
 */
export interface NotebookGroundPort {
  ground(
    req: NotebookGroundRequest,
  ): Promise<Result<NotebookGroundCandidate, NotebookGroundError>>;
}
