// 18.21 — the REAL ExtractionContentResolver (the seam 18.20 left unbound). Derefs an extraction
// AgentJob to the parked sourceId + reads SourceEnvelope.body via the EXISTING durable ParkedSourceReader
// (createDurableParkedReader, dispositionDurable.ts) — the inline text the 18.20 subscription runner
// sends as `userPrompt`. The ref path is deliberately marker-only (refsToPromptText emits `[refKind:ref]`
// markers, not content), so this is the `AgentJob → sourceId` bridge + the durable read.
//
// The sourceId is carried on a `contextRefs` entry whose `refKind` is SOURCE_CONTEXT_REF_KIND — one
// concrete member of the OPEN ContextRef `refKind` taxonomy (an arch_gap; `refKind` is `z.string().min(1)`).
// The ENABLE wiring (owner flip, step 6) populates `{refKind:"source", ref:<sourceId>}` when it assembles
// the extraction job — a documented #13 ENABLE precondition (today the job assembly passes empty contextRefs).
//
// SAFETY:
//   • WS-8 read-back re-gate (rule 4 / L12/L20/L32): `read(sourceId)` is NOT workspace-scoped and the
//     sourceId comes from externally-populated contextRefs, so the parked envelope's workspace is re-gated
//     against the job — foreign-workspace content NEVER crosses.
//   • Fail-closed, CODE-ONLY faults (rule 7 — never the content/sourceId): unresolvable ref ⇒
//     `source_ref_unresolved`; reader err ⇒ `source_unavailable`; a foreign workspace ⇒ `workspace_mismatch`;
//     an absent/empty body ⇒ `no_body` — NEVER `ok("")` (the runner would send an empty prompt).
//   • TOTAL (§16): a reader throw / malformed job folds to a typed err; no throw escapes.
//   • Reads ONLY the parked body — no vault read, no network, no `contextRefs`-marker re-inlining.
//
// DORMANT: no production caller — bound at the owner ENABLE flip (step 6, HARD STOP) as
// RealProviderRunnerDeps.subscription.content. Reachability-WAIVERED (L11).
import { ok, err, isErr } from "@sow/contracts";
import type { AgentJob, ContextRef, Result, SourceEnvelope } from "@sow/contracts";
import type { ParkedSourceReader } from "@sow/workflows";
import type {
  ExtractionContentResolver,
  ContentResolutionFault,
} from "./subscription-extraction-runner";

/**
 * The ContextRef `refKind` an extraction job uses to carry the parked source id — one concrete member of
 * the OPEN `refKind` taxonomy (arch_gap). The ENABLE caller populates `{refKind: SOURCE_CONTEXT_REF_KIND,
 * ref: <sourceId>}`; this resolver derefs it.
 */
export const SOURCE_CONTEXT_REF_KIND = "source" as const;

// ── 18.25 step-6 — the reader-holder late-bind (the eager-consumption ordering fix) ──────────────
//
// `config.providerTransport` is consumed EAGERLY inside `assembleBackends` (backends.ts:809 —
// `selectProviderRunner` → `gate.make()` builds the run leg), but the durable `ParkedSourceReader`
// (`createDurableParkedReader(backends.repos.sourceDisposition)`) exists only AFTER `assembleBackends`
// returns. So the content resolver is constructed over a LATE-BOUND reader whose backing `reader` is a
// mutable holder filled POST-assembly. This is sound because `resolve()` runs per-job (long after boot),
// so the holder is always filled by the time any real job reads it; PRE-fill (the pre-arm / build window)
// fails CLOSED — never `ok("")` — so a mis-ordered wiring can never send an empty prompt or leak content.

/** A mutable holder for the durable parked reader, filled POST-`assembleBackends` (the late-bind seam). */
export interface ReaderHolder {
  reader?: ParkedSourceReader;
}

/** Build an empty {@link ReaderHolder} (the arm wiring fills `.reader` after `assembleBackends`). */
export function createReaderHolder(): ReaderHolder {
  return { reader: undefined };
}

/**
 * A {@link ParkedSourceReader} that delegates to `holder.reader` at READ time (per-job), not construction.
 * An unfilled holder fails CLOSED (`source_unavailable`) — never throws, never a real read — so the resolver
 * built over it is byte-safe before the post-assembly fill. Total.
 */
export function createLateBoundParkedReader(holder: ReaderHolder): ParkedSourceReader {
  return {
    read(
      sourceId: string,
    ): Promise<Result<SourceEnvelope, { code: "source_unavailable"; message: string }>> {
      const bound = holder.reader;
      if (bound === undefined) {
        // Fail-closed: the holder isn't filled yet (pre-arm / pre-assembly). The resolver maps this to its
        // own code-only `source_unavailable` (rule 7) — never ok(""), never a throw.
        return Promise.resolve(
          err({ code: "source_unavailable" as const, message: "parked reader not bound (pre-arm)" }),
        );
      }
      return bound.read(sourceId);
    },
  };
}

/** Injected deps: the durable parked-source reader (a fake in tests; the real `createDurableParkedReader`
 *  is already boot-wired and is bound here at the owner ENABLE). */
export interface RealExtractionContentResolverDeps {
  readonly reader: ParkedSourceReader;
}

/** Deref the job → the parked sourceId (the `contextRefs` entry whose refKind is the source kind).
 *  EXACTLY-ONE (WS-8 / no-inference — never guess): zero ⇒ unresolvable, MULTIPLE ⇒ ambiguous (the
 *  ENABLE caller populates exactly one source ref), an empty `ref` ⇒ unresolvable — all return `undefined`
 *  (fail-closed at the caller). Never guess-first among competing source refs. */
function sourceIdFromJob(job: AgentJob): string | undefined {
  const sourceRefs = job.contextRefs.filter((r: ContextRef) => r.refKind === SOURCE_CONTEXT_REF_KIND);
  if (sourceRefs.length !== 1) return undefined;
  const ref = sourceRefs[0]!.ref;
  return ref.length === 0 ? undefined : ref;
}

/**
 * Build the real {@link ExtractionContentResolver}. UNIFORM across meeting + source — both park a
 * `SourceEnvelope` keyed by `sourceId`, so there is no `job.capability` branch. Total; never throws.
 */
export function createRealExtractionContentResolver(
  deps: RealExtractionContentResolverDeps,
): ExtractionContentResolver {
  return {
    // `signal` is intentionally NOT propagated — the parked read is a fast LOCAL durable-store read and
    // `ParkedSourceReader.read(sourceId)` takes no signal. If a cancellable reader lands, wire it here.
    async resolve(job: AgentJob): Promise<Result<string, ContentResolutionFault>> {
      try {
        const sourceId = sourceIdFromJob(job);
        if (sourceId === undefined) {
          return err({ code: "source_ref_unresolved" });
        }

        const read = await deps.reader.read(sourceId);
        // A reader err folds to the port's single code — the reader's own message (which carries the
        // sourceId) is DROPPED (rule 7). Fault↔absence is preserved at the reader's Result, not surfaced here.
        if (isErr(read)) return err({ code: "source_unavailable" });
        const envelope = read.value;

        // WS-8 read-back re-gate (rule 4 / L12/L20/L32): the parked envelope's workspace MUST match the
        // job's — else a smuggled/mis-populated ref returned another workspace's content. Fail closed;
        // the foreign body NEVER crosses (it would else reach the model + commit to the wrong ws's notes).
        if (String(envelope.workspaceId) !== String(job.workspaceId)) {
          return err({ code: "workspace_mismatch" });
        }

        // Never `ok("")` — an absent OR empty body is a fail-closed `no_body` (the runner must not send an
        // empty prompt; the downstream candidate gate + no-inference are separate concerns).
        const body = envelope.body;
        if (body === undefined || body.length === 0) {
          return err({ code: "no_body" });
        }
        return ok(body);
      } catch {
        // §16 totality: a reader throw / malformed job folds to a typed, code-only err (rule 7 — no cause
        // echoed). The runner's outer catch is a second backstop, but the resolver is total on its own.
        return err({ code: "source_unavailable" });
      }
    },
  };
}
