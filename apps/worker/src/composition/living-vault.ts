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
// call site in `bootWorker` yet. `buildIngestRewriteDeps` (ARM-RESEARCH-3, below) now EXPORTS a builder
// that constructs the real `IngestRewriteDeps`, but nothing calls it in `bootWorker` — `boot.ts` is a
// different package's territory (this is the worker-composable half only; the single boot call site is
// a hand-off). So `ProofSpineParams.livingVault` is never populated, `createLivingVaultActivity(undefined)`
// returns an empty plan set, and the capability is inert by ABSENCE as well as by flag. The
// `linkCandidates`/`confidence`/`date` threading (ARM-RESEARCH-2) is DONE — see `createIngestRewriteAdapter`
// below — so once the boot call site lands, an armed run synthesizes against REAL entity candidates
// rather than the prior "armed, spends, produces nothing" (L64) degenerate case.
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
import type { IngestRewriteDeps, GroundedPathRefusal, WithheldReason, EntityCandidate } from "@sow/knowledge";
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
 *
 * `entityRefsTruncated` / `entityRefsRejected` / `entityRefsWithheldByReason` (13.23 leg B consumer)
 * are OPTIONAL for the SAME fake-compatibility reason as `refusals` above: an old-shaped hand-rolled
 * fake that predates 13.23 may omit them and degrades to `0` / `0` / `{}` — a benign-looking run, never
 * a crash. The guarantee that a non-zero signal is ever observed rests entirely on
 * {@link createIngestRewriteAdapter} forwarding the producer's REQUIRED `IngestRewriteReceipt` fields
 * verbatim (pinned by `adapter_forwards_signal_counts_verbatim`).
 */
export type LivingVaultRewrite = (
  validated: ValidatedExtraction,
  workspaceId: WorkspaceId,
  source: SourceNoteIdentity,
) => Promise<{
  readonly plans: readonly KnowledgeMutationPlan[];
  readonly refusals?: readonly GroundedPathRefusal[];
  readonly entityRefsTruncated?: number;
  readonly entityRefsRejected?: number;
  readonly entityRefsWithheldByReason?: Readonly<Partial<Record<WithheldReason, number>>>;
}>;

/** Code-only refusal-audit payload (rule 7) — reason codes + workspace only, never a path/title/entity name. */
export interface RefusalAudit {
  readonly workspaceId: WorkspaceId;
  readonly codes: readonly GroundedPathRefusal[];
}

/**
 * Code-only entity-ref signal-count payload (rule 7) — the workspace id, the two drop counts, and a
 * per-reason-code map. `withheldByReason`'s key type is the closed `WithheldReason` literal union
 * (never a free string), so carrying an entity name/slug/path here is structurally impossible, the
 * same discipline {@link RefusalAudit} uses for its `codes` array.
 */
export interface SignalCountsHealth {
  readonly workspaceId: WorkspaceId;
  readonly truncated: number;
  readonly rejected: number;
  readonly withheldByReason: Readonly<Partial<Record<WithheldReason, number>>>;
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
  /**
   * 13.23 leg B (consumer) — optional best-effort HEALTH sink for CA-2's three entity-ref signal
   * counts, following the EXACT dormancy posture `recordRefusals` above already ships. Fired ONCE
   * per run, ONLY when at least one signal is non-zero/non-empty (`truncated !== 0 || rejected !== 0
   * || Object.keys(withheldByReason).length > 0`) — a benign run with all three at their zero/empty
   * default invokes it ZERO times, so a poisoned run is never byte-identical to a benign one and a
   * benign run never manufactures noise. Never alters the returned `Result` and never escapes as an
   * unhandled rejection, whether the sink throws sync or rejects async (L25/L53 best-effort).
   * Destination is HEALTH, not the audit trail — `toAuditRecordInput` has zero callers and building
   * it is task 24.7's scope, which this slice does not touch. Unbound (the shipped default — nothing
   * constructs this dep in production today) ⇒ zero invocations (L11 byte-equivalent). The concrete
   * `HealthItem` mint through `../health/surface` (`createHealthSurface`) is the deferred follow-up —
   * a NAMED dormant seam, not a silent one — where boot.ts already binds the OTHER
   * `IngestRewriteDeps`; constructing one here would wire a clock/id pair for a path nothing reaches.
   */
  readonly recordEntityRefSignals?: (health: SignalCountsHealth) => Promise<unknown>;
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
 * Best-effort, fire-and-forget: never throws, never awaited, never alters the caller's Result
 * (L25/L53) — a byte-for-byte structural twin of {@link emitRefusalAudit} above, over the 13.23
 * signal-count channel instead of the refusal channel.
 */
function emitEntityRefSignals(
  sink: LivingVaultAdapterDeps["recordEntityRefSignals"],
  workspaceId: WorkspaceId,
  truncated: number,
  rejected: number,
  withheldByReason: Readonly<Partial<Record<WithheldReason, number>>>,
): void {
  const hasSignal = truncated !== 0 || rejected !== 0 || Object.keys(withheldByReason).length > 0;
  if (!hasSignal || typeof sink !== "function") return;
  try {
    void sink({ workspaceId, truncated, rejected, withheldByReason }).catch(() => {});
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
        // Same placement reasoning as the refusal emit immediately above: a signal is reported on
        // EVERY subsequent exit path, including one that later rejects on containment.
        emitEntityRefSignals(
          deps.recordEntityRefSignals,
          workspaceId,
          receipt?.entityRefsTruncated ?? 0,
          receipt?.entityRefsRejected ?? 0,
          receipt?.entityRefsWithheldByReason ?? {},
        );
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
 * ✅ ARM-RESEARCH-2 (landed): `IngestRewriteInput` also accepts `linkCandidates` (the entity context
 * the synthesis planner links against), `confidence`, and `date` — {@link deriveLinkCandidates},
 * {@link deriveConfidence}, and {@link deriveDate} thread them from the VALIDATED extraction's `fields`
 * map (a `validated` extraction is the only thing this adapter is ever handed; there is nothing else to
 * derive them from). Prior consequence this closes: an ARMED run synthesized against NO entity
 * candidates and mostly produced a thin or empty plan set — the L64 "armed, spends, produces nothing"
 * class this file's own header names. Fail-safe throughout: an absent/malformed/wrong-typed field
 * degrades that ONE channel to `undefined` (never a crash, never a guessed value — REQ-F-017 posture
 * extended to this seam) rather than aborting the whole derivation.
 */

// ARM-RESEARCH-2 — the reserved field-name convention this adapter reads off a validated extraction's
// `fields` map to populate `IngestRewriteInput`'s entity-context inputs. This is a §9 arch_gap (the
// concrete extraction field catalog is undefined project-wide — `meeting-extraction.ts`'s own schema
// gate comment names the same gap) — rather than leave the channel permanently unread, this adapter
// pins a NARROW, documented convention. A field absent under these names, or present but the wrong
// shape, simply degrades that channel to `undefined` — never a crash, never a guess.
const LINK_CANDIDATES_FIELD = "linkCandidates";
const CONFIDENCE_FIELD = "confidence";
const DATE_FIELD = "date";

/** A value is a well-formed {@link EntityCandidate} iff it has non-empty string `path`/`slug`/
 *  `workspaceId` — the same three fields `entity-resolver.ts`'s own candidate filter checks. A
 *  malformed/hostile element (missing field, empty string, wrong type) is REJECTED, never repaired
 *  (REQ-F-017 no-inference — this adapter must never fabricate a path/slug for a bad candidate). */
function isEntityCandidateShape(v: unknown): v is EntityCandidate {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["path"] === "string" &&
    c["path"].length > 0 &&
    typeof c["slug"] === "string" &&
    c["slug"].length > 0 &&
    typeof c["workspaceId"] === "string" &&
    c["workspaceId"].length > 0
  );
}

/** Derive `IngestRewriteInput.linkCandidates` from `validated.fields[LINK_CANDIDATES_FIELD].value` — an
 *  array whose WELL-FORMED elements survive (a malformed element is dropped, never repaired); an absent
 *  field, a non-array value, or an array with zero surviving elements degrades to `undefined`
 *  (byte-equivalent to the pre-ARM-RESEARCH-2 shape — `rewriteVaultForSource` itself treats `undefined`
 *  and `[]` identically, see `ingest-rewrite.ts`'s `Array.isArray(input.linkCandidates)` guard). */
function deriveLinkCandidates(validated: ValidatedExtraction): readonly EntityCandidate[] | undefined {
  const raw = validated?.fields?.[LINK_CANDIDATES_FIELD]?.value;
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter(isEntityCandidateShape);
  return filtered.length > 0 ? filtered : undefined;
}

/** Derive `IngestRewriteInput.confidence` from `validated.fields[CONFIDENCE_FIELD].value` — a finite
 *  number, else `undefined` (never coerced from a string — no-inference posture: a malformed value is
 *  withheld, not guessed). */
function deriveConfidence(validated: ValidatedExtraction): number | undefined {
  const raw = validated?.fields?.[CONFIDENCE_FIELD]?.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Derive `IngestRewriteInput.date` from `validated.fields[DATE_FIELD].value` — a non-empty string,
 *  else `undefined` (the TBD sentinel is itself a non-empty string and threads through unchanged; the
 *  op-log date format is validated downstream by the structural-file writer, not here). */
function deriveDate(validated: ValidatedExtraction): string | undefined {
  const raw = validated?.fields?.[DATE_FIELD]?.value;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function createIngestRewriteAdapter(knowledgeDeps: IngestRewriteDeps): LivingVaultRewrite {
  return async (
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    source: SourceNoteIdentity,
  ): Promise<{
    readonly plans: readonly KnowledgeMutationPlan[];
    readonly refusals: readonly GroundedPathRefusal[];
    readonly entityRefsTruncated: number;
    readonly entityRefsRejected: number;
    readonly entityRefsWithheldByReason: Readonly<Partial<Record<WithheldReason, number>>>;
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
        // ARM-RESEARCH-2: the validated extraction's entity context — see the derive* helpers above.
        linkCandidates: deriveLinkCandidates(validated),
        confidence: deriveConfidence(validated),
        date: deriveDate(validated),
      },
      knowledgeDeps,
    );
    // Verbatim (13.23 leg B consumer): not re-mapped, not merged, not truncated further — the same
    // discipline `refusals` already gets, so `adapter_forwards_signal_counts_verbatim` proves the
    // three fields cross this boundary unmodified.
    return {
      plans: receipt.plans,
      refusals: receipt.refusals,
      entityRefsTruncated: receipt.entityRefsTruncated,
      entityRefsRejected: receipt.entityRefsRejected,
      entityRefsWithheldByReason: receipt.entityRefsWithheldByReason,
    };
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
/**
 * 13.8i-B — the ARMING gate as an activity delegate for propose-approval. Mirrors
 * {@link createLivingVaultActivity}'s SHAPE ONLY (a pure factory over `port | undefined`, dormancy
 * INSIDE the activity, per contracts L59) — NOT its `ok([])` identity return. `propose` has no natural
 * "nothing happened" success (a mint either happens or it does not): {@link ProposeKnowledgeApprovalResult}
 * is documented as "Proof a semantic proposal was recorded", so an `ok(...)` on the unarmed path would be
 * a FALSE PROOF of a durable write — the caller's `queuedForApproval` counter would then count Approvals
 * that do not exist. UNARMED (`port` undefined) therefore returns a typed `not_armed` err — never
 * `ok(...)`, never a throw (§16).
 *
 * ⛔ NOT DEAD CODE once 13.8i-B binds `proposeKnowledgeApproval` unconditionally at boot: `port` is
 * `undefined` here only if a FUTURE `ProofSpineParams` construction site omits it — precisely the
 * arming-transition misconfiguration an operator arming living-vault/meeting-vault rewrite needs
 * DISTINGUISHED from a genuine sink rejection (`mint_failed`), not folded into the same code.
 */
export function createProposeKnowledgeApprovalActivity(
  port: ProposeKnowledgeApprovalPort | undefined,
): ProposeKnowledgeApprovalPort["propose"] {
  return (
    plan: KnowledgeMutationPlan,
    workspaceId: WorkspaceId,
  ): Promise<Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError>> =>
    port === undefined
      ? Promise.resolve(
          err({
            code: "not_armed",
            message: "propose-knowledge-approval: no port bound at the composition root",
          }),
        )
      : port.propose(plan, workspaceId);
}

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
