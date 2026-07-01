// RemediationRouter (task 4.18, §6/§7; write-through amendment). Drives every
// quarantined parity DIVERGENCE to a terminal remediation directive WITHOUT
// laundering DB content into canonical Markdown. It is the adjudicator the
// DivergenceClassifier (4.16) defers to when it emits `remediation: "review"`.
//
// The closed routing lattice (safety rule 1 — one writer / no hidden brain):
//
//   db_only | edge_db_only  (no Markdown counterpart) →
//       • materialize-via-plan — an INDEPENDENTLY-sourced `KnowledgeMutationPlan`
//         (NEVER the DB body) re-validated through the FULL candidate-data pipeline
//         (ajv gate + Zod parse + §3 universal scoped-mutation rule) and pinned to
//         provenanceOrigin='parity_remediation'; routed to KnowledgeWriter. OR
//       • purge — a DELETE/PURGE-ONLY token (see PurgeOnlyToken) that is
//         STRUCTURALLY incapable of a write (no put_page/add_link capability, even
//         local). Requires POSITIVE proof of non-derivability — an absent stamp is
//         NOT proof. OR
//       • defer → owner review.
//
//   content_mismatch | stale_revision | md_only | edge_md_only →
//       resync-FROM-Markdown ONLY (Markdown wins; the DB body is NEVER materialized
//       / never proposed as canonical). A materialize/purge decision on one of these
//       is an ILLEGAL attempt to canonicalize DB content → typed rejection.
//
//   unstamped →
//       owner review ONLY. The row is present in BOTH sides (so it is derivable
//       from Markdown); an absent stamp can never justify auto-purge, and the bytes
//       already live in Markdown so there is nothing to materialize.
//
// The DB body is NEVER the source of a materialization: the materialize plan must be
// supplied and independently sourced, and it is re-validated exactly as any candidate
// mutation is (Lesson §3: ajv alone is never the gate). PURE relative to its injected
// registry override; returns a typed Result — NEVER throws across the boundary (§16).
import {
  isOk,
  KnowledgeMutationPlanSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import type { Result, Divergence, KnowledgeMutationPlan, ProvenanceOrigin } from "@sow/contracts";
import { ruleSchemaValid, ruleScopedMutation } from "@sow/domain";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";

// ── the purge-ONLY token ─────────────────────────────────────────────────────────

/**
 * A DELETE/PURGE-ONLY authorization. This token is the ONLY thing the purge path
 * emits, and it is STRUCTURALLY incapable of a write: it carries a frozen
 * `capability: 'purge_only'` discriminant and `op: 'purge'`, and NO put/create/link
 * field exists on the type. A general `put_page`/`add_link` capability — even a
 * local (`ctx.remote=false`) one — is unrepresentable here by construction.
 */
export interface PurgeOnlyToken {
  readonly capability: "purge_only";
  readonly op: "purge";
  readonly workspaceId: string;
  readonly factIdentity: string;
  /** Human-readable reason recorded for audit. */
  readonly reason: string;
  /** Back-reference to the POSITIVE non-derivability proof that authorized the purge. */
  readonly nonDerivabilityProofRef: string;
}

/**
 * POSITIVE proof that a DB-only fact is NOT derivable from committed Markdown at
 * the pinned revision. `derivedAbsent` is the load-bearing bit: the gbrain-
 * INDEPENDENT CanonicalFactDeriver produced NO fact for this identity. A merely-
 * absent provenance stamp is explicitly NOT proof (that is the `unstamped` class,
 * which is present in both sides).
 */
export interface NonDerivabilityProof {
  /** The ParityReport that established the db_only classification. */
  readonly reportRef: string;
  /** TRUE iff the SoW deriver produced no fact for this identity (the positive proof). */
  readonly derivedAbsent: boolean;
  readonly attestedBy: string;
}

// ── request / decision / directive / error ────────────────────────────────────────

/** The operator/owner decision for the db_only fork. */
export type RemediationDecision =
  | { readonly action: "materialize"; readonly plan: unknown }
  | { readonly action: "purge"; readonly proof: NonDerivabilityProof }
  | { readonly action: "defer" };

export interface RemediationRequest {
  readonly divergence: Divergence;
  /** The workspace the divergence belongs to (Divergence carries only factIdentity). */
  readonly workspaceId: string;
  readonly decision: RemediationDecision;
}

export interface RemediationDeps {
  /** Schema-registry override (tests); defaults to the process registry. */
  readonly registry?: SchemaRegistry;
}

/** The closed terminal directive set — every defect drives to exactly one. */
export type RemediationDirective =
  | { readonly kind: "materialize"; readonly plan: KnowledgeMutationPlan }
  | { readonly kind: "resync"; readonly factIdentity: string; readonly mdContentSha?: string }
  | { readonly kind: "purge"; readonly token: PurgeOnlyToken }
  | { readonly kind: "review"; readonly factIdentity: string; readonly reason: string };

export type RemediationError =
  | { readonly code: "illegal_materialize_content_mismatch"; readonly divergenceClass: string }
  | { readonly code: "purge_requires_positive_proof"; readonly detail: string }
  | { readonly code: "plan_wrong_origin"; readonly origin: ProvenanceOrigin }
  | { readonly code: "workspace_mismatch"; readonly expected: string; readonly planWorkspace: string }
  | {
      readonly code: "plan_invalid";
      readonly stage: "ajv" | "zod" | "scoped";
      readonly issues: readonly { readonly path: string; readonly message: string }[];
    };

// Resync-class: Markdown ALWAYS wins; the DB body is never materialized/proposed.
const RESYNC_CLASSES: ReadonlySet<string> = new Set([
  "content_mismatch",
  "stale_revision",
  "md_only",
  "edge_md_only",
]);
// db_only fork: the only classes where materialize/purge are legal at all.
const DB_ONLY_CLASSES: ReadonlySet<string> = new Set(["db_only", "edge_db_only"]);

// ── the router ────────────────────────────────────────────────────────────────────

/**
 * Route one quarantined divergence to its terminal directive. Total function:
 * returns a typed directive or a typed error; never throws.
 */
export function routeRemediation(
  req: RemediationRequest,
  deps: RemediationDeps = {},
): Result<RemediationDirective, RemediationError> {
  const { divergence, workspaceId, decision } = req;
  const cls = divergence.divergenceClass as string;
  const factIdentity = divergence.factIdentity as string;

  // ── resync-class: Markdown wins; DB body NEVER materialized ─────────────────────
  if (RESYNC_CLASSES.has(cls)) {
    if (decision.action === "materialize") {
      return { ok: false, error: { code: "illegal_materialize_content_mismatch", divergenceClass: cls } };
    }
    if (decision.action === "purge") {
      // The fact IS in Markdown → non-derivability can never be proven → never purge.
      return {
        ok: false,
        error: {
          code: "purge_requires_positive_proof",
          detail: `divergence class ${cls} is present in Markdown (derivable) — purge is never legal`,
        },
      };
    }
    return {
      ok: true,
      value: {
        kind: "resync",
        factIdentity,
        ...(divergence.mdContentSha !== undefined ? { mdContentSha: divergence.mdContentSha as string } : {}),
      },
    };
  }

  // ── unstamped: owner review ONLY (absent stamp ≠ proof of non-derivability) ──────
  if (cls === "unstamped") {
    if (decision.action === "purge") {
      return {
        ok: false,
        error: {
          code: "purge_requires_positive_proof",
          detail: "unstamped is present in both sides — an absent stamp can never justify auto-purge",
        },
      };
    }
    if (decision.action === "materialize") {
      // The bytes already live in Markdown; materializing would launder the DB body.
      return { ok: false, error: { code: "illegal_materialize_content_mismatch", divergenceClass: cls } };
    }
    return { ok: true, value: { kind: "review", factIdentity, reason: "unstamped — re-stamp is KnowledgeWriter's job on re-commit; owner review" } };
  }

  // ── db_only | edge_db_only: materialize OR purge OR review ───────────────────────
  if (DB_ONLY_CLASSES.has(cls)) {
    switch (decision.action) {
      case "defer":
        return { ok: true, value: { kind: "review", factIdentity, reason: "deferred to owner review" } };
      case "purge": {
        if (!isPositiveProof(decision.proof)) {
          return {
            ok: false,
            error: {
              code: "purge_requires_positive_proof",
              detail: "auto-purge requires positive proof of non-derivability (derivedAbsent), not an absent stamp",
            },
          };
        }
        const token: PurgeOnlyToken = {
          capability: "purge_only",
          op: "purge",
          workspaceId,
          factIdentity,
          reason: `db_only fact non-derivable from Markdown (proof ${decision.proof.reportRef}, attested by ${decision.proof.attestedBy})`,
          nonDerivabilityProofRef: decision.proof.reportRef,
        };
        return { ok: true, value: { kind: "purge", token } };
      }
      case "materialize":
        return materialize(decision.plan, workspaceId, deps.registry);
    }
  }

  // Defensive default (structurally unreachable — the lattice above is closed): a
  // class we cannot route is deferred to owner review, never silently dropped.
  return { ok: true, value: { kind: "review", factIdentity, reason: `unroutable divergence class ${cls} — owner review` } };
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Positive proof: the deriver produced NO such fact AND the proof is attributed. */
function isPositiveProof(proof: NonDerivabilityProof): boolean {
  return (
    proof.derivedAbsent === true &&
    typeof proof.reportRef === "string" &&
    proof.reportRef.trim().length > 0 &&
    typeof proof.attestedBy === "string" &&
    proof.attestedBy.trim().length > 0
  );
}

/**
 * Re-validate a materialize plan through the FULL candidate-data pipeline and pin it
 * to provenanceOrigin='parity_remediation'. Composes the ajv gate + the model's Zod
 * parse + the §3 scoped-mutation rule — ajv alone is never the gate (Lesson §3).
 */
function materialize(
  plan: unknown,
  workspaceId: string,
  registry: SchemaRegistry | undefined,
): Result<RemediationDirective, RemediationError> {
  // 1 — ajv structural gate (REQ-S-006).
  const ajv = ruleSchemaValid(plan, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, registry);
  if (!ajv.ok) {
    return {
      ok: false,
      error: { code: "plan_invalid", stage: "ajv", issues: (ajv.error.errors ?? []).map((e) => ({ path: e.path, message: e.message })) },
    };
  }
  // 2 — Zod parse (catches the `.refine` REQ-F-006 + branded-id shape ajv can't).
  const parsed = KnowledgeMutationPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "plan_invalid",
        stage: "zod",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  const validated = parsed.data;
  // 3 — §3 universal scoped-mutation rule (workspaceId + ≥1 sourceRef).
  const scoped = ruleScopedMutation(validated);
  if (!isOk(scoped)) {
    return {
      ok: false,
      error: { code: "plan_invalid", stage: "scoped", issues: [{ path: (scoped.error.fields ?? []).join(","), message: scoped.error.code }] },
    };
  }
  // 4 — workspace isolation: the plan must target the divergence's workspace.
  if ((validated.workspaceId as string) !== workspaceId) {
    return { ok: false, error: { code: "workspace_mismatch", expected: workspaceId, planWorkspace: validated.workspaceId as string } };
  }
  // 5 — origin pin: a materialize plan is ALWAYS parity_remediation-originated — it
  // may never be laundered in as human/ingestion/meeting_close/gbrain_proposal.
  if (validated.provenanceOrigin !== "parity_remediation") {
    return { ok: false, error: { code: "plan_wrong_origin", origin: validated.provenanceOrigin } };
  }
  return { ok: true, value: { kind: "materialize", plan: validated } };
}
