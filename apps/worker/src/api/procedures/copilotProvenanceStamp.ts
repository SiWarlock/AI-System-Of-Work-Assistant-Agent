// §9.6 Phase-C C5.4b — the provenance-stamping retrieval DECORATOR (the LAST contentTrust go-live gate).
//
// PROBLEM (from C5.4a): `deriveCopilotContentTrust` grants a propose-capable Copilot job only when EVERY
// retrieved source carries provenance === "knowledge_writer". No retrieval adapter sets it, so every live
// ask is untrusted and propose is OFF. C5.4b builds the SOUND mechanism that stamps a source
// knowledge_writer ONLY when it is proven KnowledgeWriter-authored canonical Markdown — bound to the
// knowledge-layer serving gate (`admitForServing` in @sow/knowledge), which HMAC-verifies a
// `SignedProvenanceStamp` against a tuple RE-DERIVED from committed Markdown (unforgeable authorship).
//
// SAFETY (hard rule): a BLANKET stamp on all gbrain hits re-opens the ING-7 untrusted-content bypass — the
// C4 job-admission backstop (`admitCopilotAgentJob`) cannot catch a job that was already marked trusted.
// So provenance is stamped PER-SOURCE, from an EXPLICIT gated admission verdict, and defaults to no-stamp
// on every other axis (degraded coverage, any error, a foreign-id anomaly, a malformed verdict/context).
//
// DESIGN — a thin DECORATOR over any `CopilotRetrievalPort`, composing a `CopilotServingOracle` verdict:
//   • The oracle is the `admitForServing` SEAM, kept OUT of the decorator so the decorator stays PURE
//     (join = mode + set membership) and TDD-able against fakes. The real admitForServing-backed oracle
//     (which resolves each source's slug/originPath → factIdentity, rehydrates committed Markdown, checks
//     the CanonicalFactSet allow-set + QuarantineLedger + ParityReport coverage, and verifies the HMAC
//     stamp via the Keychain SecretsPort) is a SEPARATE future sub-slice — see GO-LIVE PRECONDITIONS below.
//   • `createInterimDegradedServingOracle` is the honest-interim input: it ALWAYS degrades, so wired
//     through the decorator TODAY nothing is stamped ⇒ every live ask is untrusted ⇒ propose stays
//     structurally OFF (the C5.4a pattern: a REAL mechanism kept OFF by its INPUT, never a flag-only override).
//
// The decorator ALWAYS derives each source's provenance from the verdict (it never trusts an inner adapter's
// self-reported provenance — that would let a future inner GBrain adapter self-stamp and bypass the gate).
//
// ── GO-LIVE PRECONDITIONS (the real admitForServing-backed oracle sub-slice — NOT this slice) ────────────
// Before ANY non-interim oracle is wired (a security-review-gated event — safety rules 4/6, ING-7):
//   (1) CONTENT INTEGRITY — the gated verdict must carry each admitted citation's REHYDRATED
//       `AdmittedFact.content` + `mdContentSha`, and the go-live path must REBUILD `RetrievedContext.blocks`
//       from those proven bytes. Otherwise a trusted `provenance` label sits over unverified `blocks[]` bytes
//       (the model synthesizes over `blocks`, a SEPARATE array from `sources`).
//   (2) GRANULARITY — a `citationId` is per-SLUG/PAGE, an `AdmittedFact.factIdentity` is per-FACT (a page
//       has many: page + link + tag + timeline facts). Stamp a citationId knowledge_writer ONLY if EVERY
//       fact reachable via that citationId is admitted (all-or-nothing); a partially-admitted page must be
//       UNSTAMPED. Prefer moving citationId to per-fact granularity (gbrain:<slug>:<factIdentity>).
//   (3) RESOLVER INJECTIVITY — the slug/originPath → factIdentity resolver must WITHHOLD on any originPath
//       not uniquely resolvable, and the factIdentity → citationId back-map must be injective, so an
//       attacker-controlled ingest slug colliding onto a real KW page's originPath cannot inherit its stamp.
//   (4) SERVING-ERROR MAPPING — the oracle must convert `admitForServing`'s hard `ServingError`
//       (workspace_mismatch / revision_mismatch) into an oracle `err`, never swallow it into an `ok` verdict,
//       so the decorator's fail-closed passthrough fires.
//   (5) CITATION UNIQUENESS — a `citationId` must be UNIQUE within a `RetrievedContext` (retrieval-side
//       dedup). The decorator's join stamps EVERY source whose citationId is in the admitted set, so a
//       DUPLICATED citationId (e.g. two gbrain chunks from one slug both mapping to `gbrain:<slug>`) would
//       let a single admission stamp all its duplicates. Either dedup at retrieval, or move to per-fact
//       citationIds (precondition 2), or have the go-live oracle reject/strip a duplicated citationId.
import { ok, err, isOk, failure } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import { enforceRetrievalScope } from "./copilot";
import type { CopilotRetrievalPort, RetrievedContext, RetrievedSource, SourceProvenance } from "./copilot";

/**
 * The serving-gate verdict for one retrieval, produced by a `CopilotServingOracle`. A discriminated union:
 * the `"gated"` arm carries the set of citationIds whose bytes the gate ADMITTED (each proven
 * KnowledgeWriter-authored); the `"degraded_direct_markdown"` arm carries NO admitted set at all — so a
 * trusted stamp is structurally unrepresentable under degrade. Mirrors the knowledge layer's `ServingMode`
 * (@sow/knowledge `admitForServing`), which returns `degraded_direct_markdown` with `admitted: []` on ANY
 * non-green serving-coverage leg or an unresolvable signing key.
 */
export type CopilotServingVerdict =
  | { readonly mode: "gated"; readonly admittedCitationIds: ReadonlySet<string> }
  | { readonly mode: "degraded_direct_markdown" };

/**
 * The seam to the knowledge-layer serving gate. Given the retrieval's workspace + context, returns which
 * citationIds are ADMITTED (proven KnowledgeWriter-authored) under a gated verdict, or a degraded verdict.
 * A typed `err` ⇒ the decorator fails closed (unstamped passthrough). MUST fail closed on its own faults —
 * it is the sole source of trust, so it never fabricates admission (see GO-LIVE PRECONDITIONS).
 */
export interface CopilotServingOracle {
  readonly admit: (
    workspaceId: string,
    context: RetrievedContext,
  ) => Promise<Result<CopilotServingVerdict, FailureVariant>>;
}

/** Dependencies for the decorator: the inner retrieval + the serving oracle. */
export interface ProvenanceStampingDeps {
  readonly inner: CopilotRetrievalPort;
  readonly oracle: CopilotServingOracle;
}

/**
 * Project a source to EXACTLY {citationId, title[, provenance]} — dropping any other field the inner adapter
 * may carry (incl. a self-reported `provenance`, which we ALWAYS overwrite from the verdict). Passing
 * `undefined` omits provenance ⇒ the source is treated `unknown` (untrusted) downstream.
 */
function projectSource(source: RetrievedSource, provenance: SourceProvenance | undefined): RetrievedSource {
  return provenance === undefined
    ? { citationId: source.citationId, title: source.title }
    : { citationId: source.citationId, title: source.title, provenance };
}

/** Rebuild the context with every source's provenance STRIPPED (untrusted) — blocks + workspaceId preserved. */
function stripAll(context: RetrievedContext): RetrievedContext {
  return {
    workspaceId: context.workspaceId,
    blocks: context.blocks,
    sources: context.sources.map((s) => projectSource(s, undefined)),
  };
}

/**
 * Derive each source's provenance from the verdict. Stamp knowledge_writer IFF the verdict is EXPLICITLY
 * gated (discriminated-union `mode === "gated"`, never a truthiness/`in` check) AND the source's citationId
 * is in the admitted set. Fail closed to fully-unstamped when: the verdict is not gated; the admitted set is
 * not a real Set (a malformed verdict); or the admitted set is not a subset of the retrieved citationIds — a
 * foreign admitted id means the oracle admitted against a DIFFERENT context than we are stamping (a TOCTOU
 * anomaly), so the whole verdict is distrusted rather than partially honored.
 */
function stampFromVerdict(context: RetrievedContext, verdict: CopilotServingVerdict): RetrievedContext {
  if (verdict.mode !== "gated") return stripAll(context);
  const admitted = verdict.admittedCitationIds;
  if (!(admitted instanceof Set)) return stripAll(context); // malformed gated verdict — fail closed
  // Subset-or-fail-closed (C3.4): the admitted set MUST be ⊆ the retrieved citationIds. A stray/foreign id
  // signals the oracle saw a different retrieval than the one we hold — distrust the entire verdict.
  const retrievedIds = new Set(context.sources.map((s) => s.citationId));
  for (const id of admitted) {
    if (!retrievedIds.has(id)) return stripAll(context);
  }
  return {
    workspaceId: context.workspaceId,
    blocks: context.blocks,
    sources: context.sources.map((s) =>
      admitted.has(s.citationId) ? projectSource(s, "knowledge_writer") : projectSource(s, undefined),
    ),
  };
}

/** True iff `sources` is a well-formed array of {citationId:string, title:string} objects. */
function sourcesWellFormed(context: RetrievedContext): boolean {
  if (!Array.isArray(context.sources)) return false;
  return context.sources.every(
    (s) => typeof s === "object" && s !== null && typeof s.citationId === "string" && typeof s.title === "string",
  );
}

/**
 * Decorate a `CopilotRetrievalPort` so its `RetrievedSource`s carry a SOUND provenance stamp derived from the
 * serving oracle. Fail-closed on every axis (§16 no-throw): an inner `err` propagates unchanged (the oracle
 * is never consulted); a cross-workspace context is rejected BEFORE the oracle (WS-8); a malformed context
 * fails closed with a typed `err`; an oracle `err` (or any thrown/rejected fault) degrades to an unstamped
 * passthrough (read-only Q&A survives, propose stays off); and provenance is ALWAYS derived from the verdict
 * (an inner adapter can never self-stamp its way to trusted). The result is `Promise<Result<...>>` — a valid
 * `MaybeAsyncResult`; the sole `retrieve` consumer (`answerCopilotQuestion`) awaits.
 */
export function createProvenanceStampingRetrieval(deps: ProvenanceStampingDeps): CopilotRetrievalPort {
  return {
    retrieve: async (workspaceId, question): Promise<Result<RetrievedContext, FailureVariant>> => {
      try {
        const retrieved = await deps.inner.retrieve(workspaceId, question);
        if (!isOk(retrieved)) return retrieved; // inner err ⇒ propagate; oracle never consulted

        // WS-8 (defense-in-depth over any adapter): the context MUST be for the requested workspace — a
        // mismatch fails closed BEFORE the oracle sees any cross-workspace content.
        const scoped = enforceRetrievalScope(workspaceId, retrieved.value);
        if (!isOk(scoped)) return scoped;
        const context = scoped.value;

        // Malformed sources would throw in the map below — fail closed with a typed err instead (§16).
        if (!sourcesWellFormed(context)) {
          return err(
            failure("validation_rejected", "retrieval context sources are malformed", {
              cause: { code: "RETRIEVAL_CONTEXT_MALFORMED" },
            }),
          );
        }

        const verdict = await deps.oracle.admit(workspaceId, context);
        // Oracle err ⇒ cannot prove authorship ⇒ unstamped passthrough (honestly "unknown", never trusted).
        if (!isOk(verdict)) return ok(stripAll(context));

        return ok(stampFromVerdict(context, verdict.value));
      } catch {
        // Any thrown/rejected fault (a buggy inner/oracle) ⇒ a typed err, never a throw across the boundary.
        return err(
          failure("degraded_unavailable", "provenance-stamping retrieval faulted", {
            cause: { code: "PROVENANCE_STAMP_FAULT" },
          }),
        );
      }
    },
  };
}

/**
 * The honest-interim serving oracle: ALWAYS returns a degraded verdict for any workspace/context, so the
 * decorator stamps NOTHING and every live ask is untrusted ⇒ propose stays structurally OFF today. This is
 * the C5.4a pattern — the real deterministic mechanism ships, but its INPUT keeps it OFF until the real
 * admitForServing-backed oracle lands (see GO-LIVE PRECONDITIONS in the module header). Wiring any
 * non-interim oracle is a security-review-gated go-live event, never a flag flip.
 */
export function createInterimDegradedServingOracle(): CopilotServingOracle {
  return {
    admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> =>
      Promise.resolve(ok({ mode: "degraded_direct_markdown" })),
  };
}
