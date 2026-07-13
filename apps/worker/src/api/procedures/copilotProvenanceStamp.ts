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
//   (1) CONTENT INTEGRITY — ✅ HANDLED (C5.4b slice 1): the gated verdict carries each admitted citation's
//       REHYDRATED `AdmittedFact.content` + `mdContentSha` (the `admitted` map value), and `stampFromVerdict`
//       REBUILDS `RetrievedContext.blocks` from those proven bytes POSITIONALLY (index-aligned to `sources`,
//       which the prompt builder pairs 1:1): proven bytes at admitted slots, "" at unadmitted slots; a
//       gated-but-EMPTY admission leaves the inner blocks UNTOUCHED. So a trusted `provenance` label can no
//       longer sit over unverified `blocks[]` bytes (the model synthesizes over `blocks`, a SEPARATE array
//       from `sources`), nor can a proven excerpt be misattributed to the wrong citation.
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
import type { Result, FailureVariant, RevisionId, WorkspaceId } from "@sow/contracts";
// The knowledge-layer serving gate + its input/output shapes. The real `admitForServing` is INJECTED as a seam
// (`AdmitForServingFn`) so the oracle-core stays pure + TDD-able against a fake gate; boot wires the real one.
import type {
  ServingRequest,
  ServingResult,
  ServingError,
  ServingCoverage,
  ServingDeps,
  RehydrateFn,
  CanonicalFactSet,
  QuarantineLedger,
  DbPointer,
} from "@sow/knowledge";
import { enforceRetrievalScope } from "./copilot";
import type { CopilotRetrievalPort, RetrievedContext, RetrievedSource, SourceProvenance } from "./copilot";

/**
 * Proven bytes for ONE admitted citation — the citation's REHYDRATED canonical Markdown `content` plus its
 * `mdContentSha`, both carried straight from the knowledge-layer gate's `AdmittedFact` (the gate already
 * proved content-hash + HMAC authorship; we never re-hash). `mdContentSha` is kept as a plain string here —
 * the worker-internal verdict has no need of the branded `MdContentSha`.
 */
export interface AdmittedBytes {
  readonly content: string;
  readonly mdContentSha: string;
}

/**
 * The serving-gate verdict for one retrieval, produced by a `CopilotServingOracle`. A discriminated union:
 * the `"gated"` arm carries a MAP from each ADMITTED citationId (proven KnowledgeWriter-authored) to its
 * proven bytes ({@link AdmittedBytes}) — so the decorator can both STAMP the source AND rebuild the block the
 * model reads from the SAME proven bytes (content integrity, C5.4b precondition 1). The
 * `"degraded_direct_markdown"` arm carries NO admitted map at all — so a trusted stamp is structurally
 * unrepresentable under degrade. Mirrors the knowledge layer's `ServingMode` (@sow/knowledge
 * `admitForServing`), which returns `degraded_direct_markdown` with `admitted: []` on ANY non-green
 * serving-coverage leg or an unresolvable signing key.
 */
export type CopilotServingVerdict =
  | { readonly mode: "gated"; readonly admitted: ReadonlyMap<string, AdmittedBytes> }
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
 * True iff every value of the admitted map is a well-formed {@link AdmittedBytes} ({content, mdContentSha}
 * both strings). A malformed value (e.g. a non-string `content` from a buggy/hostile oracle) must never reach
 * the model as a "proven" block — so a single malformed entry fails the WHOLE verdict closed (see caller).
 */
function admittedBytesWellFormed(admitted: ReadonlyMap<string, unknown>): boolean {
  for (const v of admitted.values()) {
    if (typeof v !== "object" || v === null) return false;
    const b = v as { content?: unknown; mdContentSha?: unknown };
    if (typeof b.content !== "string" || typeof b.mdContentSha !== "string") return false;
  }
  return true;
}

/**
 * Derive each source's provenance AND the block bytes the model reads from the verdict. Stamp knowledge_writer
 * IFF the verdict is EXPLICITLY gated (discriminated-union `mode === "gated"`, never a truthiness/`in` check)
 * AND the source's citationId is in the admitted map; AND — the content-integrity leg (C5.4b precondition 1) —
 * REBUILD `blocks` from the SAME proven bytes the gate admitted, so a knowledge_writer label can never sit
 * over an unverified `blocks[]` entry (the model synthesizes over `blocks`, a separate array from `sources`).
 *
 * Fail closed to fully-unstamped + blocks-UNTOUCHED (`stripAll`) when: the verdict is not gated; the admitted
 * value is not a real Map (a malformed verdict); a map value is not well-formed proven bytes; the admitted set
 * is not a subset of the retrieved citationIds (a foreign id means the oracle admitted against a DIFFERENT
 * context than we hold — a TOCTOU anomaly, distrust the whole verdict); OR the admitted map is EMPTY (an empty
 * gate result must not blank the read-only answer — leave the inner blocks as-is). Only a non-empty, well-formed,
 * subset-clean gated verdict rebuilds blocks.
 */
function stampFromVerdict(context: RetrievedContext, verdict: CopilotServingVerdict): RetrievedContext {
  if (verdict.mode !== "gated") return stripAll(context);
  const admitted = verdict.admitted;
  if (!(admitted instanceof Map)) return stripAll(context); // malformed gated verdict — fail closed
  if (!admittedBytesWellFormed(admitted)) return stripAll(context); // malformed proven bytes — fail closed
  // Subset-or-fail-closed (C3.4): the admitted keys MUST be ⊆ the retrieved citationIds. A stray/foreign id
  // signals the oracle saw a different retrieval than the one we hold — distrust the entire verdict.
  const retrievedIds = new Set(context.sources.map((s) => s.citationId));
  for (const id of admitted.keys()) {
    if (!retrievedIds.has(id)) return stripAll(context);
  }
  // Gated-but-EMPTY: nothing admitted ⇒ nothing to stamp AND nothing to rebuild — leave blocks untouched so
  // an empty gate result does not blank the read-only answer (equivalent to stripAll here).
  if (admitted.size === 0) return stripAll(context);
  // Rebuild blocks POSITIONALLY — one entry per source, index-aligned (`blocks.length === sources.length`).
  // The downstream prompt builder pairs `blocks[i]` to `sources[i]`, so an admitted source's slot carries its
  // PROVEN bytes and an UNadmitted source's slot carries "" (an empty/blank excerpt). This drops every
  // unverified byte (the model never reads unproven content) WITHOUT misattributing a proven excerpt to the
  // wrong citation. Length pinned to sources ⇒ a duplicated source cannot inflate the list.
  return {
    workspaceId: context.workspaceId,
    blocks: context.sources.map((s) => admitted.get(s.citationId)?.content ?? ""),
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

// ── the REAL admitForServing-backed serving oracle (gate 4 — oracle-core) ────────
//
// This is the deterministic CORE of the real serving oracle: a PURE adapter that turns a retrieval's
// `RetrievedContext` into a `CopilotServingVerdict` by consulting the knowledge-layer serving gate
// (`admitForServing`). It satisfies GO-LIVE PRECONDITIONS 1–5 (see the module header):
//   • (1) CONTENT INTEGRITY — each admitted citation carries its REHYDRATED proven bytes
//         (`AdmittedFact.content` + `.mdContentSha`) into the verdict's admitted MAP, so the decorator rebuilds
//         `blocks` from the SAME bytes the gate proved (no re-hash — the gate is authoritative).
//   • (5) CITATION UNIQUENESS — a citationId appearing more than once in the context is fail-closed EXCLUDED
//         (the verdict's admitted map is keyed by citationId; a single admission would otherwise stamp all its duplicates).
//   • (2/3) RESOLVER INJECTIVITY / all-or-nothing — each candidate citationId resolves (via the injected,
//         workspace-scoped resolver) to the SET of factIdentities reachable through it; a non-uniquely-
//         resolvable citationId (resolver → null / empty) is EXCLUDED, and if two candidates claim the SAME
//         factIdentity the resolver was not injective for this context → BOTH are excluded (a slug-collision
//         anomaly). A page is admitted ALL-OR-NOTHING: only if EVERY factIdentity reachable via its citationId
//         is admitted by the gate.
//   • (4) SERVING-ERROR MAPPING — a hard `ServingError` (workspace/revision mismatch) maps to an oracle `err`,
//         NEVER swallowed into an ok verdict, so the decorator's fail-closed passthrough fires.
//
// DORMANT: this oracle is NOT wired in boot — the interim degraded oracle stays the default. Wiring it requires
// (a) stamp-minting activated in the KnowledgeWriter commit path, (b) real KnowledgeWriter-authored corpora to
// stamp, and (c) the worker-side `ServingContextLoader` that assembles a real allow-set / ledger / coverage /
// rehydrate / signing-key per workspace — each a security-review-gated go-live step, never a flag flip.

/** The knowledge-layer serving gate as an injected seam (the real `admitForServing` fits this shape). */
export type AdmitForServingFn = (
  req: ServingRequest,
  deps: ServingDeps,
) => Promise<Result<ServingResult, ServingError>>;

/**
 * Everything the oracle needs to serve ONE workspace at its current revision: the trusted allow-set, the
 * coverage legs, the quarantine ledger, the Markdown rehydrator, the signing-key access, and an INJECTIVE
 * citationId → factIdentities resolver (built from the same allow-set). All are assembled by the injected
 * {@link ServingContextLoader} (the real one is a later worker-wiring slice).
 */
export interface WorkspaceServingContext {
  readonly revisionId: RevisionId;
  readonly allowSet: CanonicalFactSet;
  readonly rehydrate: RehydrateFn;
  readonly quarantine: QuarantineLedger;
  readonly coverage: ServingCoverage;
  readonly servingDeps: ServingDeps;
  /**
   * Resolve a citationId to the SET of factIdentities reachable through it (a page's facts), or `null` when it
   * is not uniquely resolvable to a served page. MUST be injective (distinct citationIds → disjoint factId
   * sets) and MUST withhold (return null) rather than guess; the oracle additionally cross-checks injectivity
   * for the specific context and fails closed on any overlap.
   */
  readonly resolveCitation: (citationId: string) => readonly string[] | null;
}

/** Loading a workspace's serving context: `ready` with the context, `degraded` (no gated serving), or a fault. */
export type ServingContextResolution =
  | { readonly mode: "ready"; readonly context: WorkspaceServingContext }
  | { readonly mode: "degraded" };

/**
 * Loads the per-workspace serving context at the current committed revision. Returns `degraded` when the
 * workspace cannot be gated-served (never indexed, no allow-set, no signing key) — a NORMAL state, not a fault
 * — and a typed `err` only on an actual load failure. Never throws (the oracle wraps it regardless).
 */
export type ServingContextLoader = (
  workspaceId: string,
) => Promise<Result<ServingContextResolution, FailureVariant>>;

/** Dependencies for the real serving oracle: the gate seam + the per-workspace context loader. */
export interface ServingGateOracleDeps {
  readonly admitForServing: AdmitForServingFn;
  readonly loadContext: ServingContextLoader;
}

/** A constant DB-ranking score for gate pointers — the oracle has no DB ranking; admission ignores score. */
const ORACLE_POINTER_SCORE = 1;

/** Sentinel marking a factIdentity claimed by >1 citationId (injectivity violated for a context). */
const CONFLICT = Symbol("citation-fact-conflict");

/**
 * Build the REAL serving oracle over the injected gate seam + context loader. Never throws (§16): a loader/gate
 * fault, a rejection, or any unexpected throw folds to a typed `err` (⇒ the decorator strips ⇒ untrusted).
 * Every decision is fail-closed — the DEFAULT is "not admitted".
 */
export function createServingGateOracle(deps: ServingGateOracleDeps): CopilotServingOracle {
  return {
    admit: async (
      workspaceId: string,
      context: RetrievedContext,
    ): Promise<Result<CopilotServingVerdict, FailureVariant>> => {
      try {
        // 1) Load the workspace serving context. A load fault → err (decorator strips); `degraded` → degraded
        //    verdict WITHOUT consulting the gate (no allow-set to build a request against).
        const loaded = await deps.loadContext(workspaceId);
        if (!isOk(loaded)) return loaded;
        if (loaded.value.mode !== "ready") return ok({ mode: "degraded_direct_markdown" });
        const ctx = loaded.value.context;

        // 2) PRECONDITION 5 — citation uniqueness. Only citationIds appearing EXACTLY once are candidates; a
        //    duplicated one is fail-closed excluded (a Set-based admission cannot distinguish its copies).
        const counts = new Map<string, number>();
        for (const s of context.sources) counts.set(s.citationId, (counts.get(s.citationId) ?? 0) + 1);
        const candidates = [...counts.entries()].filter(([, n]) => n === 1).map(([id]) => id);

        // 3) PRECONDITIONS 2/3 — resolve each candidate → its factIdentities. Withhold on null / empty (a
        //    citation resolving to nothing must NEVER be admitted). Track fact ownership to enforce injectivity
        //    for THIS context: a factIdentity claimed by two candidates is an anomaly → exclude BOTH.
        const resolved = new Map<string, readonly string[]>();
        const factOwner = new Map<string, string | typeof CONFLICT>();
        for (const cid of candidates) {
          const factIds = ctx.resolveCitation(cid);
          if (factIds === null || factIds.length === 0) continue;
          // Dedup WITHIN a citation before the ownership pass — a resolver repeating a factId for one page must
          // not self-CONFLICT (drop its own legit page). CONFLICT is reserved for a factId claimed by TWO
          // DISTINCT citationIds (the real injectivity violation).
          const uniqueFactIds = [...new Set(factIds)];
          resolved.set(cid, uniqueFactIds);
          for (const fid of uniqueFactIds) factOwner.set(fid, factOwner.has(fid) ? CONFLICT : cid);
        }
        for (const [cid, factIds] of [...resolved]) {
          if (factIds.some((fid) => factOwner.get(fid) === CONFLICT)) resolved.delete(cid);
        }
        // Nothing resolvable → a gated verdict admitting nothing (honest: the gate found no provable source).
        if (resolved.size === 0) return ok({ mode: "gated", admitted: new Map<string, AdmittedBytes>() });

        // 4) Build the ServingRequest over the UNION of resolved factIdentities. `workspaceId` is the REQUESTED
        //    one (cast to the brand) — the gate re-checks it against the loaded allow-set's workspace, so a
        //    context loaded for the wrong workspace is caught as a hard error (not silently served).
        const factIds = new Set<string>();
        for (const ids of resolved.values()) for (const fid of ids) factIds.add(fid);
        const pointers: DbPointer[] = [...factIds].map((factIdentity) => ({
          factIdentity,
          score: ORACLE_POINTER_SCORE,
        }));
        const req: ServingRequest = {
          workspaceId: workspaceId as WorkspaceId,
          revisionId: ctx.revisionId,
          pointers,
          allowSet: ctx.allowSet,
          rehydrate: ctx.rehydrate,
          quarantine: ctx.quarantine,
          coverage: ctx.coverage,
        };

        // 5) PRECONDITION 4 — call the gate; a hard ServingError maps to `err` (never an ok verdict).
        const served = await deps.admitForServing(req, ctx.servingDeps);
        if (!isOk(served)) {
          return err(
            failure("validation_rejected", "serving gate rejected the request", {
              cause: { code: `SERVING_${served.error.code.toUpperCase()}` },
            }),
          );
        }
        if (served.value.mode !== "gated") return ok({ mode: "degraded_direct_markdown" });

        // 6) ALL-OR-NOTHING per page: a citationId is admitted IFF EVERY factIdentity reachable through it is in
        //    the gate's admitted set. A partially-admitted page stays UNSTAMPED. For each admitted citation,
        //    carry the PROVEN bytes (content integrity, precondition 1) of the PAGE fact = the FIRST resolved
        //    fact. The production `buildCitationResolver` is page-only (resolves to exactly [page:<slug>]), so
        //    `ids[0]` IS the page fact AND the only fact — multi-fact resolution is not reachable under today's
        //    resolver; a future multi-fact-resolver author must revisit this "first == the page fact" assumption.
        const admittedFacts = new Map(served.value.admitted.map((f) => [f.factIdentity, f]));
        const admitted = new Map<string, AdmittedBytes>();
        for (const [cid, ids] of resolved) {
          if (!ids.every((fid) => admittedFacts.has(fid))) continue;
          const pageFactId = ids[0];
          const pageFact = pageFactId === undefined ? undefined : admittedFacts.get(pageFactId);
          if (pageFact === undefined) continue; // unreachable (all ids admitted, ids non-empty) — fail closed
          admitted.set(cid, { content: pageFact.content, mdContentSha: pageFact.mdContentSha });
        }
        return ok({ mode: "gated", admitted });
      } catch {
        // §16 — a throwing/rejecting loader or gate never crosses the boundary; fail closed (⇒ untrusted).
        return err(
          failure("degraded_unavailable", "serving gate oracle faulted", {
            cause: { code: "SERVING_ORACLE_FAULT" },
          }),
        );
      }
    },
  };
}
