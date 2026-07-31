// 13.8d — the living-vault rewrite adapter: the composition-root half of §6 KN-10 ("the vault rewrites
// itself" around an ingested source). It adapts `@sow/knowledge`'s `rewriteVaultForSource` onto the
// workflow-layer `SourceLivingVaultPort` and — the load-bearing part — REALPATH-CONTAINS every note path
// the derived plans touch before any of them can reach KnowledgeWriter.
//
// dormancy-waiver(13.8d): arming runs through boot.ts `gateLivingVaultRewrite` (strict `=== true` + a
// non-empty vaultRoot). The strict check lives at the composition root rather than in this file —
// "logic-in-package, wire-at-boot" — which is why this module carries the waiver marker instead of an
// `=== true` of its own.
//
// ⚠ STATE OF THE WIRING (do not read the line above as "already live"): `gateLivingVaultRewrite` has NO
// call site in `bootWorker` yet, and nothing constructs the `IngestRewriteDeps` the real rewrite needs.
// So `ProofSpineParams.livingVault` is never populated, `createLivingVaultActivity(undefined)` returns an
// empty plan set, and the capability is inert by ABSENCE as well as by flag. Completing that call site
// (plus the `linkCandidates` threading below) is the arming follow-up.
//
// WHY CONTAINMENT LIVES HERE. The note paths in a rewrite plan are derived from SYNTHESIZED entity
// content, and the KnowledgeWriter commit gate does not itself verify that a note path lies inside the
// workspace tree (the vault does `join(root, note.path)` verbatim) — so this adapter is the enforcer, the
// same role `projections/noteSlug.ts` plays for the meeting/project paths. It cannot live in
// `runSourceIngestion`: that driver is Temporal workflow-sandbox code, where an `fs` call is a
// determinism violation as well as a layering one.
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ok, err, isOk } from "@sow/contracts";
import type { KnowledgeMutationPlan, Result, WorkspaceId } from "@sow/contracts";
import { rewriteVaultForSource } from "@sow/knowledge";
import type { IngestRewriteDeps, GroundedPathRefusal } from "@sow/knowledge";
import type {
  SourceLivingVaultPort,
  LivingVaultFailure,
  SourceNoteIdentity,
  ValidatedExtraction,
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
} from "@sow/workflows/ports/sourceIngestion";
import type { CopilotKnowledgeProposeSink } from "../api/procedures/copilotProposeKnowledgeSink";

/**
 * Derives the plan set for one ingested source. Production binds {@link createIngestRewriteAdapter}.
 *
 * `refusals` is OPTIONAL here for FAKE COMPATIBILITY ONLY (13.8m-B) — a hand-rolled test fake may omit
 * it and degrades to `[]` (L11-style byte-equivalent silence: an old-shaped fake never fires the audit
 * sink). The GUARANTEE that a refusal is ever observed rests entirely on
 * {@link createIngestRewriteAdapter} always forwarding the producer's REQUIRED
 * `IngestRewriteReceipt.refusals` field verbatim (pinned by `adapter_forwards_refusals_verbatim`) — a
 * second producer bound to this seam MUST forward its own refusals the same way, or refusals from that
 * producer silently never reach the sink. Scoped the way 13.8k's module header scoped its invariant:
 * a statement about THIS producer, not an unqualified "refusals are surfaced".
 */
export type LivingVaultRewrite = (
  validated: ValidatedExtraction,
  workspaceId: WorkspaceId,
  source: SourceNoteIdentity,
) => Promise<{
  readonly plans: readonly KnowledgeMutationPlan[];
  readonly refusals?: readonly GroundedPathRefusal[];
}>;

/** Code-only refusal-audit payload (rule 7) — reason codes + workspace only, never a path/title/entity name. */
export interface RefusalAudit {
  readonly workspaceId: WorkspaceId;
  readonly codes: readonly GroundedPathRefusal[];
}

export interface LivingVaultAdapterDeps {
  /** The configured vault root. Containment is enforced against its REAL path. */
  readonly vaultRoot: string;
  readonly rewrite: LivingVaultRewrite;
  /**
   * 13.8m-B — optional best-effort audit sink (§6 KN-7 "rejected AND audited"). Fired ONCE per run,
   * ONLY when the receipt's refusals are non-empty — a benign empty run invokes it zero times,
   * preserving the empty-vs-refused distinction 13.8m-A exists to create. Never alters the returned
   * `Result` and never escapes as an unhandled rejection, whether the sink throws sync or rejects
   * async (L25/L53 best-effort). Unbound (the shipped default — nothing constructs this dep in
   * production today) ⇒ zero invocations (L11 byte-equivalent). The concrete HealthItem/HealthFailure
   * mint is deferred to the 13.8d arming follow-up, where boot.ts already binds the OTHER
   * `IngestRewriteDeps` — constructing one here would wire a clock/id pair for a path nothing reaches.
   */
  readonly recordRefusals?: (audit: RefusalAudit) => Promise<unknown>;
}

/** Best-effort, fire-and-forget: never throws, never awaited, never alters the caller's Result (L25/L53). */
function emitRefusalAudit(
  sink: LivingVaultAdapterDeps["recordRefusals"],
  workspaceId: WorkspaceId,
  refusals: readonly GroundedPathRefusal[],
): void {
  if (refusals.length === 0 || typeof sink !== "function") return;
  try {
    void sink({ workspaceId, codes: refusals }).catch(() => {});
  } catch {
    /* best-effort — a throwing sink must never alter the primary Result. */
  }
}

/**
 * Every note path a plan touches — creates, patches, link sources, frontmatter targets. A non-string or
 * empty path is returned as the sentinel `""`, which containment rejects (fail-closed: an unreadable
 * path is never treated as "nothing to check").
 */
function touchedPaths(plan: KnowledgeMutationPlan): readonly string[] {
  const out: string[] = [];
  const add = (path: unknown): void => {
    out.push(typeof path === "string" && path.length > 0 ? path : "");
  };
  for (const c of plan.creates ?? []) add(c.path);
  for (const p of plan.patches ?? []) add(p.path);
  for (const l of plan.linkMutations ?? []) add(l.srcPath);
  for (const f of plan.frontmatterUpdates ?? []) add(f.path);
  return out;
}

/**
 * Is `rel` contained by `rootReal` (an already-realpath'd vault root)?
 *
 * Two layers, mirroring `copilotVaultRead.ts:104`:
 *  1. LEXICAL — `resolve` collapses `..` and makes an absolute `rel` escape visibly; anything not strictly
 *     under the root is rejected without touching the filesystem.
 *  2. REAL — the lexical result is resolved to its REAL path so a symlinked directory inside the vault
 *     that points outside it is caught. A plan's note usually does NOT exist yet (it is a CREATE), so we
 *     resolve the DEEPEST EXISTING ANCESTOR: that is where a symlink could be hiding, and it is equivalent
 *     to realpathing the file itself once the file exists.
 *
 * Fail-closed throughout: an unresolvable root, an empty path, or a walk that runs out of ancestors is
 * NOT contained.
 */
function isContained(rootReal: string, rel: string): boolean {
  if (rel.length === 0) return false;
  const lexical = resolve(rootReal, rel);
  if (lexical === rootReal || !lexical.startsWith(rootReal + sep)) return false;

  let probe = lexical;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return real === rootReal || real.startsWith(rootReal + sep);
    } catch (cause) {
      // ONLY "this component does not exist yet" justifies climbing to the parent — that is the CREATE
      // case. Any other fault (EACCES, ELOOP, ENAMETOOLONG) means we could not VERIFY this component,
      // and climbing past it would report "contained" for a path we never actually resolved.
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
      const parent = dirname(probe);
      if (parent === probe) return false; // walked past the filesystem root — nothing resolvable
      probe = parent;
    }
  }
}

/**
 * Build the {@link SourceLivingVaultPort}: derive the plan set, then admit it ONLY if EVERY path in EVERY
 * plan is contained. Rejection is ALL-OR-NOTHING — admitting the contained subset of a plan set whose
 * sibling escaped is precisely the partial-write the pipeline forbids.
 *
 * Never throws (§16): a throwing/rejecting rewrite folds onto `rewrite_failed`. Faults carry NO path and
 * NO content (safety rule 7) — the operator sees the class of problem, the health sink never sees the
 * vault layout.
 */
export function createLivingVaultPort(deps: LivingVaultAdapterDeps): SourceLivingVaultPort {
  return {
    async rewrite(
      validated: ValidatedExtraction,
      workspaceId: WorkspaceId,
      source: SourceNoteIdentity,
    ): Promise<Result<readonly KnowledgeMutationPlan[], LivingVaultFailure>> {
      let plans: readonly KnowledgeMutationPlan[];
      try {
        const receipt = await deps.rewrite(validated, workspaceId, source);
        plans = receipt?.plans ?? [];
        // Fired here, BEFORE root resolution / containment below, so a refusal is reported on EVERY
        // subsequent exit path — including one that later rejects (13.8m-B's highest-value guarantee).
        emitRefusalAudit(deps.recordRefusals, workspaceId, receipt?.refusals ?? []);
      } catch {
        return err({ code: "rewrite_failed", message: "living-vault rewrite failed" });
      }

      let rootReal: string;
      try {
        rootReal = realpathSync(resolve(deps.vaultRoot));
      } catch {
        // An unresolvable vault root cannot contain anything — refuse rather than write blind.
        return err({ code: "path_escape", message: "vault root could not be resolved" });
      }

      for (const plan of plans) {
        // WS-8 re-gate at the last chokepoint before these plans cross into the commit path. Today the
        // adapter stamps the workspace itself (content cannot redirect it), so this can only fire on a
        // future adapter that derives it — which is exactly when a silent cross-workspace write would
        // otherwise become possible (the read-back re-gate discipline of worker L12/L32).
        if (String(plan.workspaceId) !== String(workspaceId)) {
          return err({
            code: "path_escape",
            message: "a derived plan targeted a different workspace than the routing-bound one",
          });
        }
        for (const path of touchedPaths(plan)) {
          if (!isContained(rootReal, path)) {
            return err({
              code: "path_escape",
              message: "a derived note path resolved outside the vault root",
            });
          }
        }
      }
      return ok(plans);
    },
  };
}

/**
 * The ARMING gate as an activity delegate. The Temporal wrapper is the ONLY production entry into
 * `runSourceIngestion`, and the workflow sandbox cannot read boot config — so it always binds this
 * delegate and the arming decision is made HERE, where the composition root's gate result is visible.
 *
 * UNARMED (`port` undefined — the shipped default) ⇒ `ok([])`: an EMPTY plan set, deliberately NOT a
 * failure. An empty set adds no commit and routes no health item, so every observable outcome of the
 * dormant pipeline is identical to pre-13.8d; returning a failure instead would surface a spurious
 * degrade on every ingest. ARMED ⇒ the contained, realpath-checked plan set from {@link createLivingVaultPort}.
 */
export function createLivingVaultActivity(
  port: SourceLivingVaultPort | undefined,
): SourceLivingVaultPort["rewrite"] {
  return (
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    source: SourceNoteIdentity,
  ): Promise<Result<readonly KnowledgeMutationPlan[], LivingVaultFailure>> =>
    port === undefined
      ? Promise.resolve(ok([]))
      : port.rewrite(validated, workspaceId, source);
}

/**
 * Adapt the real `rewriteVaultForSource` onto {@link LivingVaultRewrite}. The knowledge-side deps
 * (gbrain / reason / sections / structural / id minters) are supplied by the caller at arming time — this
 * module only maps the port's arguments onto `IngestRewriteInput`, so it stays free of provider wiring.
 *
 * `provenanceOrigin` + `sourceRefs` are stamped from the ROUTING-BOUND workspace + the per-file source
 * identity — never from extracted content (WS-2/WS-8: content can never redirect which workspace or
 * source a rewrite is attributed to).
 *
 * ⚠ DELIBERATELY MINIMAL, and NOT yet the full adapter. `IngestRewriteInput` also accepts
 * `linkCandidates` (the entity context the synthesis planner links against), `confidence`, and `date`;
 * deriving those from the validated extraction is its own piece of work, so `validated` is intentionally
 * unread here. Consequence while it stays this way: an ARMED run synthesizes against NO entity
 * candidates and will mostly produce a thin or empty plan set. That is acceptable only because this
 * ships DORMANT — it must be completed before the capability is armed (Step-9 follow-up).
 */
export function createIngestRewriteAdapter(knowledgeDeps: IngestRewriteDeps): LivingVaultRewrite {
  return async (
    _validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    source: SourceNoteIdentity,
  ): Promise<{
    readonly plans: readonly KnowledgeMutationPlan[];
    readonly refusals: readonly GroundedPathRefusal[];
  }> => {
    const receipt = await rewriteVaultForSource(
      {
        workspaceId,
        // `ingestion` is the ProvenanceOrigin member for this path (shared-enums.ts). It must be a real
        // member: `rewriteVaultForSource` is TOTAL (any internal fault yields an EMPTY receipt), so an
        // invalid origin would fail the plan schema INSIDE the planner and surface as "armed, spends,
        // produces nothing" rather than as an error — the L64 failure class.
        provenanceOrigin: "ingestion",
        sourceRefs: [{ sourceId: String(source.sourceId) }],
      },
      knowledgeDeps,
    );
    return { plans: receipt.plans, refusals: receipt.refusals };
  };
}

/**
 * 13.8i — the composition-root adapter that lets `runSourceIngestion` (Temporal workflow-sandbox code,
 * cannot import @sow/db/worker adapters) route a withheld PROPOSE-tier living-vault plan into a PENDING
 * §9.8 Approval, by REUSING the EXISTING `CopilotKnowledgeProposeSink` (apps/worker/src/api/procedures/
 * copilotProposeKnowledgeSink.ts, `createApprovalsKnowledgeProposeSink`) — never a second minting site
 * (contracts L39/L61). A THIN wrapper only: it does not re-implement any of the sink's own security
 * contracts (workspace provenance re-check, payload-swap TOCTOU, planId-keyed idempotency) — those are
 * pinned exhaustively in copilotProposeKnowledgeSink.test.ts; this module's own test
 * (living-vault-propose-approval.test.ts) verifies only the mapping: delegates verbatim, folds the
 * sink's `FailureVariant` (or a thrown error) onto the closed `mint_failed` port error — never leaking
 * the raw detail (rule 7) — and never throws (§16).
 */
export function createProposeKnowledgeApprovalPort(
  sink: CopilotKnowledgeProposeSink,
): ProposeKnowledgeApprovalPort {
  return {
    async propose(
      plan: KnowledgeMutationPlan,
      workspaceId: WorkspaceId,
    ): Promise<Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError>> {
      try {
        const recorded = await sink.record({ plan, workspaceId });
        if (!isOk(recorded)) {
          return err({
            code: "mint_failed",
            message: "propose-knowledge-approval: the sink rejected the plan",
          });
        }
        return ok({
          approvalRef: recorded.value.approvalRef,
          created: recorded.value.created,
        });
      } catch {
        return err({
          code: "mint_failed",
          message: "propose-knowledge-approval: the sink threw",
        });
      }
    },
  };
}
