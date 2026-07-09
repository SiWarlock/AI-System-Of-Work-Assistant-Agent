// MarkdownRehydrationServingGate (task 4.17, §6; write-through amendment invariants
// (i) bytes-from-Markdown serving + (v) fail-closed/default-deny). THE load-bearing
// fix that makes GBrain write-through safe: the runtime never receives a DB-row
// byte as an answer.
//
// The GBrain DB is used ONLY for retrieval/ranking/pointers (slug + span + score) —
// NEVER as a byte source. Every candidate fact's bytes are re-hydrated from
// committed Markdown at serve time (the injected `rehydrate`, which reads the
// committed vault, never the DB), and a fact is ADMITTED only if ALL FOUR of these
// hold (DEFAULT-DENY — any single failure withholds the fact):
//
//   (A) rehydrated-hash == CanonicalFactDeriver.mdContentSha @ the current revision
//       (the trusted allow-set's hash) — a tampered / stale / DB-sourced span whose
//       bytes disagree with committed Markdown is withheld.
//   (B) the SignedProvenanceStamp verifies (4.15) — recomputed over the tuple
//       INDEPENDENTLY re-derived from the allow-set (workspaceId/factIdentity/
//       originPath/mdContentSha/kwRevision), NOT the stamp's or the rehydration's
//       self-reported fields. A borrowed stamp (a genuine stamp copied onto other
//       bytes) or a forged sig fails here (design doc GO #3 (c)).
//   (C) factIdentity ∈ the current-revision allow-set (`CanonicalFactSet`, 4.14) —
//       a DB-only fact is absent from Markdown, so it has no bytes to serve.
//   (D) the fact is not quarantined (QuarantineLedger, content-independent).
//
// DEGRADED COVERAGE (invariant (v)): if the latest ParityReport is dirty/incomplete,
// the GbrainPin mismatches, or the rebuild oracle failed to build, the workspace
// degrades to DIRECT committed-Markdown retrieval only — the gate admits NOTHING
// through the DB-pointer path and returns `mode = "degraded_direct_markdown"`. The
// same fail-closed degrade applies when the signing key cannot be resolved (no sig
// can be verified). think/synthesis therefore runs ONLY over the gated, admitted,
// Markdown-rehydrated context ({@link synthesisContext}) — never a store-wide read.
//
// Deterministic relative to its injected deps (SecretsPort + rehydrate). Returns a
// typed `Result`; NEVER throws across the boundary (§16).
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  RevisionId,
  MdContentSha,
  SignedProvenanceStamp,
} from "@sow/contracts";
import type { CanonicalFactSet, DerivedFact } from "../derive/canonical-fact-deriver";
import type { QuarantineLedger } from "./quarantine-ledger";
import {
  verifyProvenanceStamp,
  type SecretsPort,
  type SecretRef,
} from "../../knowledge-writer/provenance-stamp";

// ── inputs ─────────────────────────────────────────────────────────────────────

/**
 * A DB-sourced retrieval/ranking pointer — the ONLY thing the gate takes from the
 * GBrain DB. `dbBody` is the byte payload the DB *would* have served; it is carried
 * only so the gate can be proven to IGNORE it — it is never read or returned.
 */
export interface DbPointer {
  readonly factIdentity: string;
  /** Ranking score from the DB read; preserved onto the admitted fact. */
  readonly score: number;
  /** The DB-row bytes the gate must NEVER serve (present for the ignore-proof). */
  readonly dbBody?: string;
}

/**
 * A fact's bytes RE-HYDRATED from committed Markdown at serve time (produced by the
 * injected {@link RehydrateFn}, which reads the committed vault — never the DB).
 * `mdContentSha` is the hash of these rehydrated bytes; `stamp` is the
 * SignedProvenanceStamp read from the page's committed frontmatter.
 */
export interface RehydratedFact {
  readonly factIdentity: string;
  /** The committed-Markdown bytes to serve. */
  readonly content: string;
  readonly mdContentSha: MdContentSha;
  readonly stamp: SignedProvenanceStamp;
}

/** A per-candidate rehydration failure (page missing / no stamp / read fault). */
export interface RehydrateError {
  readonly code: "rehydrate_failed";
  readonly factIdentity: string;
  readonly reason: string;
}

/** Reads a fact's bytes from COMMITTED MARKDOWN. Total function — returns a Result. */
export type RehydrateFn = (factIdentity: string) => Result<RehydratedFact, RehydrateError>;

/**
 * The serving-coverage legs (from the latest revision-scoped `ParityReport` (4.16),
 * the `GbrainPin` (4.20), and the rebuild oracle). Any leg not green degrades the
 * whole workspace to direct committed-Markdown retrieval only.
 */
export interface ServingCoverage {
  /** ParityReport.cleanForServing — false ⇔ a HARD-floor (db_only/unstamped) defect. */
  readonly cleanForServing: boolean;
  /** ParityReport.coverageComplete — false ⇔ the pass did not cover the full set. */
  readonly coverageComplete: boolean;
  /** The installed GbrainPin matches the validated one (no pin mismatch). */
  readonly pinValid: boolean;
  /** The rebuild oracle built successfully (no oracle-build failure). */
  readonly oracleBuildOk: boolean;
}

/** True iff any coverage leg is not green (⇒ degrade to direct-Markdown serving). */
export function isDegradedCoverage(c: ServingCoverage): boolean {
  return !(c.cleanForServing && c.coverageComplete && c.pinValid && c.oracleBuildOk);
}

/** Injected signing-key access for serve-time stamp verification (safety rule 7). */
export interface ServingDeps {
  readonly secrets: SecretsPort;
  readonly signingKeyRef: SecretRef;
}

/** One serving request: DB pointers + the trusted allow-set + coverage + ledger. */
export interface ServingRequest {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: RevisionId;
  /** DB retrieval/ranking pointers (slug+span+score) — NEVER a byte source. */
  readonly pointers: readonly DbPointer[];
  /** The gbrain-INDEPENDENT `CanonicalFactSet` @ current revision = the allow-set. */
  readonly allowSet: CanonicalFactSet;
  /** Re-hydrates each candidate's bytes from committed Markdown at serve time. */
  readonly rehydrate: RehydrateFn;
  readonly quarantine: QuarantineLedger;
  readonly coverage: ServingCoverage;
}

// ── outputs ──────────────────────────────────────────────────────────────────

export type WithholdReason =
  | "not_in_allow_set" // (C) a DB-only fact — no bytes to serve
  | "quarantined" // (D) do-not-serve per the QuarantineLedger
  | "rehydrate_failed" // could not re-hydrate bytes from committed Markdown
  | "content_hash_mismatch" // (A) rehydrated hash != canonical mdContentSha
  | "origin_path_missing" // allow-set fact carries no originPath — cannot build the verify tuple
  | "signature_invalid" // (B) stamp did not verify (borrowed/forged/re-pointed)
  | "degraded_coverage" // fail-closed: coverage not green → direct-Markdown only
  | "signing_key_unresolved"; // fail-closed: no signing key → no sig can be verified

/** An admitted fact — MARKDOWN-rehydrated bytes only (never the DB row). */
export interface AdmittedFact {
  readonly factIdentity: string;
  readonly content: string;
  readonly mdContentSha: MdContentSha;
  /** The DB ranking score, preserved. */
  readonly score: number;
}

export interface WithheldFact {
  readonly factIdentity: string;
  readonly reason: WithholdReason;
}

export type ServingMode = "gated" | "degraded_direct_markdown";

export interface ServingResult {
  readonly mode: ServingMode;
  readonly admitted: readonly AdmittedFact[];
  readonly withheld: readonly WithheldFact[];
}

/** Hard wiring errors — the caller passed an allow-set for the wrong workspace/rev. */
export type ServingError =
  | { readonly code: "workspace_mismatch"; readonly request: string; readonly allowSet: string }
  | { readonly code: "revision_mismatch"; readonly request: string; readonly allowSet: string };

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * Run the default-deny serving admission over a batch of DB pointers. Returns a
 * typed `ServingResult` (gated or degraded), or a typed hard-wiring error; never
 * throws. Ranking order is preserved; a duplicate factIdentity keeps the first
 * (highest-ranked) pointer.
 */
export async function admitForServing(
  req: ServingRequest,
  deps: ServingDeps,
): Promise<Result<ServingResult, ServingError>> {
  // The allow-set MUST describe the same workspace + revision the request serves —
  // a mismatch is a wiring bug, never a silent cross-workspace/stale reconcile
  // (safety rule 4 + revision-scoped allow-set).
  const reqWs = req.workspaceId as string;
  const allowWs = req.allowSet.workspaceId as string;
  if (reqWs !== allowWs) {
    return err({ code: "workspace_mismatch", request: reqWs, allowSet: allowWs });
  }
  const reqRev = req.revisionId as string;
  const allowRev = req.allowSet.revisionId as string;
  if (reqRev !== allowRev) {
    return err({ code: "revision_mismatch", request: reqRev, allowSet: allowRev });
  }

  // Fail-closed: on any degraded coverage leg, serve NOTHING through the DB-pointer
  // path — the workspace falls back to direct committed-Markdown retrieval.
  if (isDegradedCoverage(req.coverage)) {
    return ok(degraded(req.pointers, "degraded_coverage"));
  }

  const index = new Map<string, DerivedFact>();
  for (const df of req.allowSet.facts) {
    index.set(df.fact.factIdentity as string, df);
  }

  const admitted: AdmittedFact[] = [];
  const withheld: WithheldFact[] = [];
  const seen = new Set<string>();

  for (const p of req.pointers) {
    const id = p.factIdentity;
    if (seen.has(id)) continue; // dedup — first (highest-ranked) pointer wins
    seen.add(id);

    // (C) allow-set membership — a DB-only fact has no committed bytes to serve.
    const df = index.get(id);
    if (df === undefined) {
      withheld.push({ factIdentity: id, reason: "not_in_allow_set" });
      continue;
    }

    // (D) not quarantined — content-independent, workspace-scoped do-not-serve.
    if (req.quarantine.isQuarantined(reqWs, id)) {
      withheld.push({ factIdentity: id, reason: "quarantined" });
      continue;
    }

    // Re-hydrate the bytes from committed Markdown (never the DB row).
    const r = req.rehydrate(id);
    if (!r.ok) {
      withheld.push({ factIdentity: id, reason: "rehydrate_failed" });
      continue;
    }
    const rf = r.value;

    // (A) rehydrated-hash == CanonicalFactDeriver.mdContentSha @ current revision.
    const canonicalSha = df.fact.mdContentSha;
    if ((rf.mdContentSha as string) !== (canonicalSha as string)) {
      withheld.push({ factIdentity: id, reason: "content_hash_mismatch" });
      continue;
    }

    // (B) signature verifies — over the tuple INDEPENDENTLY re-derived from the
    // trusted allow-set (never the stamp's / rehydration's self-reported fields).
    const originPath = df.provenance.originPath;
    if (originPath === undefined || originPath.length === 0) {
      withheld.push({ factIdentity: id, reason: "origin_path_missing" });
      continue;
    }
    const verified = await verifyProvenanceStamp(
      {
        // The v2 signed binding is CONTENT+LOCATION only — the volatile whole-vault revision is NOT bound
        // (a stamp must survive an unrelated commit; see provenance-stamp.ts header). Revision-freshness is
        // enforced by leg (A) above (rehydrated hash == allow-set hash @ current revision) + leg (C) membership.
        workspaceId: df.fact.workspaceId,
        factIdentity: df.fact.factIdentity,
        originPath,
        mdContentSha: df.fact.mdContentSha,
        stamp: rf.stamp,
      },
      { secrets: deps.secrets, signingKeyRef: deps.signingKeyRef },
    );
    if (!verified.ok) {
      // The signing key is unresolvable → NO sig can be verified → fail closed for
      // the whole request (direct committed-Markdown only), discarding any partial
      // admissions collected before this point.
      return ok(degraded(req.pointers, "signing_key_unresolved"));
    }
    if (!verified.value) {
      withheld.push({ factIdentity: id, reason: "signature_invalid" });
      continue;
    }

    // Admitted — serve the MARKDOWN-rehydrated bytes; the DB row bytes (p.dbBody)
    // are never touched.
    admitted.push({
      factIdentity: id,
      content: rf.content,
      mdContentSha: canonicalSha,
      score: p.score,
    });
  }

  return ok({ mode: "gated", admitted, withheld });
}

/** Build the degraded (direct-Markdown-only) result: nothing admitted through the gate. */
function degraded(pointers: readonly DbPointer[], reason: WithholdReason): ServingResult {
  return {
    mode: "degraded_direct_markdown",
    admitted: [],
    withheld: pointers.map((p) => ({ factIdentity: p.factIdentity, reason })),
  };
}

/**
 * The context think/synthesis is allowed to consume: the gated, admitted,
 * Markdown-rehydrated facts only. In degraded mode it is EMPTY — synthesis never
 * runs over a store-wide or degraded read.
 */
export function synthesisContext(result: ServingResult): readonly AdmittedFact[] {
  return result.mode === "gated" ? result.admitted : [];
}
