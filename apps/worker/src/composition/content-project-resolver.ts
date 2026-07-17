// 18.6 + 18.5 — the content→workspace/project CLASSIFIER (18.6) + the correlation-signal
// PRODUCER (18.5), both fail-to-PARK per REQ-F-017 (the ROUTING surface: below-threshold /
// no-match / ambiguous ⇒ park to the Ingestion Inbox, NEVER a guessed projectId / invented
// binding). WS-8: the resolved workspace + project come from the registry ENTRY, never a
// smuggled caller field.
//
// These build the `classify` fn injected into `createRouteSourceActivity` and the
// `resolveSignals` fn injected into `createCorrelateActivity` (the threshold→bind-or-park
// machinery already lives in those activities; this module supplies the real resolution +
// the REQ-F-017 park CALL). The threshold VALUE is single-sourced (DEFAULT_THRESHOLD) and
// passed to BOTH the classify (its recordPark decision) and the activity (its outcome), so
// the two `>= threshold` compares can never split-brain (pinned at the exact boundary).
//
// SAFE-BUILD: resolution is through an INJECTED `ResolveRegistryPort` and scoring through an
// INJECTED `CorrelationScorerPort` — no real model/endpoint/key/spend. The SHIPPED boot
// default (`createBootWorkspaceContentResolver` + `createBootCorrelationScorer`) binds the
// single boot workspace confidently (BYTE-EQUIVALENT to the pre-18.6/18.5 spine — never
// parks); the real registry/inbox repo backing + a model scorer are a reachability follow-up.
import { ok, err, isErr } from "@sow/contracts";
import type { SourceEnvelope, WorkspaceId, Result } from "@sow/contracts";
import type {
  RouteSignals,
  RouteError,
  SourceIngestionContext,
  CorrelationSignals,
  CorrelateError,
  MeetingCloseoutContext,
  ResolveRegistryPort,
  ProjectSyncContext,
} from "@sow/workflows";
import type { IngestionInboxProjectionPort } from "../api/projections/ingestionInboxProjection";

/** The bind threshold — single-sourced with the route/correlate activities' DEFAULT_THRESHOLD. */
export const DEFAULT_THRESHOLD = 0.7;
/** The boot correlation confidence — byte-equivalent to the pre-18.5 fixed `params.correlationSignals`. */
const BOOT_CORRELATION_CONFIDENCE = 0.95;

/** The project-routing key the content classifier reads from `SourceEnvelope.routingHints`
 *  (Q3 convention; routingHints is an open arch_gap Record). An absent/blank key ⇒ no
 *  deterministic resolution ⇒ park (never inferred). */
const PROJECT_REF_KEY = "projectRef";

// ── the injected seams ──────────────────────────────────────────────────────────

/** Resolves a source's content to routing signals (registry-backed real impl, or the
 *  byte-equivalent boot-workspace default). Returns a low signal (never an err) on a benign
 *  no-match so the classify parks; reserves err for a genuine fault (§16). */
export interface ContentResolver {
  resolve(ctx: SourceIngestionContext): Promise<Result<RouteSignals, RouteError>>;
}

/** The correlation SCORER seam (18.5): scores a meeting's content to a confidence + best-guess
 *  binding. Injected — deterministic fake in tests; the real model-via-broker scorer binds at
 *  the crossing (eval-tested). No real model call here. */
export interface CorrelationScore {
  readonly confidence: number;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: string;
  readonly reason?: string;
}
export interface CorrelationScorerPort {
  score(ctx: MeetingCloseoutContext): Promise<Result<CorrelationScore, CorrelateError>>;
}

// ── 18.6 — the registry-backed content resolver ─────────────────────────────────

/** Extract the `routingHints.projectRef` project-routing key (string, non-blank) or undefined. */
function projectRefOf(source: SourceEnvelope): string | undefined {
  const hints = source.routingHints as Record<string, unknown> | undefined;
  const ref = hints?.[PROJECT_REF_KEY];
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

/**
 * A real content resolver over the 14.6 {@link ResolveRegistryPort}. Deterministic lookup —
 * NO model inference: the source's `routingHints.projectRef` builds a `ProjectSyncContext`;
 * a confident registry entry yields `{confidence: 1, workspaceId, projectId}` FROM THE ENTRY
 * (WS-8 — never a caller field); an absent projectRef or a `project_unknown`/`provider_unmapped`
 * resolution yields a low signal (confidence 0) so the classify parks (REQ-F-017, no guess).
 */
export function createRegistryContentResolver(deps: {
  readonly resolve: ResolveRegistryPort;
}): ContentResolver {
  return {
    async resolve(ctx: SourceIngestionContext): Promise<Result<RouteSignals, RouteError>> {
      const projectRef = projectRefOf(ctx.source);
      if (projectRef === undefined) {
        // No deterministic routing key ⇒ cannot resolve without inference ⇒ park.
        return ok({ confidence: 0, reason: "no routingHints.projectRef" });
      }
      const syncCtx: ProjectSyncContext = { projectRef };
      const resolved = await deps.resolve.resolve(syncCtx);
      if (isErr(resolved)) {
        // project_unknown / provider_unmapped ⇒ park (never a guessed binding).
        return ok({ confidence: 0, reason: resolved.error.code });
      }
      const entry = resolved.value;
      // WS-8: workspace + project are the REGISTRY ENTRY's, never a caller/hint field.
      return ok({ confidence: 1, workspaceId: entry.workspaceId, projectId: entry.projectId });
    },
  };
}

/**
 * The BYTE-EQUIVALENT boot default: bind the single boot workspace confidently (no project,
 * no registry, no content read) — matching the pre-18.6 `confidence:1` classify for the
 * single-workspace-per-worker topology. Never parks; the project-level resolution + the park
 * stay dormant behind this default until the real registry resolver is wired.
 */
export function createBootWorkspaceContentResolver(workspaceId: WorkspaceId): ContentResolver {
  return {
    resolve: (): Promise<Result<RouteSignals, RouteError>> =>
      Promise.resolve(ok({ confidence: 1, workspaceId })),
  };
}

// ── 18.6 — the classify fn (resolve → bind or record-park) ──────────────────────

/**
 * Build the `classify` fn for `createRouteSourceActivity`. Resolves through the injected
 * {@link ContentResolver}; BINDS when confidence clears the threshold AND a workspace was
 * resolved (`>=` — pinned at the exact boundary so it agrees with the activity's compare);
 * otherwise records the park to the Ingestion Inbox (§9.8 clarification surface, REQ-F-017)
 * and returns a low signal carrying NO guessed projectId / workspace. Total — never throws.
 */
export function createContentProjectClassify(deps: {
  readonly resolve: ContentResolver;
  readonly park: IngestionInboxProjectionPort;
  readonly threshold?: number;
}): (ctx: SourceIngestionContext) => Promise<Result<RouteSignals, RouteError>> {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  return async (ctx: SourceIngestionContext): Promise<Result<RouteSignals, RouteError>> => {
    try {
      const resolved = await deps.resolve.resolve(ctx);
      if (isErr(resolved)) return err(resolved.error);
      const signals = resolved.value;
      if (signals.confidence >= threshold && signals.workspaceId !== undefined) {
        return ok(signals); // BIND (>= boundary)
      }
      // REQ-F-017: park to the Ingestion Inbox + return a low signal (NO guessed projectId/ws).
      await recordParkBestEffort(deps.park, ctx.source);
      return ok({
        confidence: signals.confidence,
        ...(signals.reason !== undefined ? { reason: signals.reason } : {}),
      });
    } catch (cause) {
      return err({ code: "route_failed", message: "content classifier faulted", cause });
    }
  };
}

// ── 18.5 — the correlation producer (score → bind or record-park) ───────────────

/** The BYTE-EQUIVALENT boot correlation scorer: passes the fixed confident binding through
 *  (pre-18.5 `params.correlationSignals` — confidence defaults to 0.95). Never parks. */
export function createBootCorrelationScorer(signals: {
  readonly workspaceId?: WorkspaceId;
  readonly confidence?: number;
  readonly projectId?: string;
}): CorrelationScorerPort {
  const confidence = signals.confidence ?? BOOT_CORRELATION_CONFIDENCE;
  return {
    score: (): Promise<Result<CorrelationScore, CorrelateError>> =>
      Promise.resolve(
        ok({
          confidence,
          ...(signals.workspaceId !== undefined ? { workspaceId: signals.workspaceId } : {}),
          ...(signals.projectId !== undefined ? { projectId: signals.projectId } : {}),
        }),
      ),
  };
}

/**
 * Build the `resolveSignals` fn for `createCorrelateActivity`. Scores through the injected
 * {@link CorrelationScorerPort}; above-threshold WITH a workspace ⇒ a confidence-scored
 * binding; below-threshold / no workspace ⇒ record the park clarification (REQ-F-017) + a low
 * signal with NO invented binding. Total — never throws.
 */
export function createCorrelationSignalProducer(deps: {
  readonly scorer: CorrelationScorerPort;
  readonly park: IngestionInboxProjectionPort;
  readonly threshold?: number;
}): (ctx: MeetingCloseoutContext) => Promise<Result<CorrelationSignals, CorrelateError>> {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  return async (ctx: MeetingCloseoutContext): Promise<Result<CorrelationSignals, CorrelateError>> => {
    try {
      const scored = await deps.scorer.score(ctx);
      if (isErr(scored)) return err(scored.error);
      const s = scored.value;
      if (s.confidence >= threshold && s.workspaceId !== undefined) {
        return ok({
          confidence: s.confidence,
          workspaceId: s.workspaceId,
          ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
        });
      }
      await recordParkBestEffort(deps.park, ctx.source);
      return ok({
        confidence: s.confidence,
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      });
    } catch (cause) {
      return err({ code: "correlation_failed", message: "correlation producer faulted", cause });
    }
  };
}

// ── shared park helper ──────────────────────────────────────────────────────────

/**
 * Record the park to the Ingestion Inbox (WS-8: the source's OWN workspaceId — recordPark's
 * guard requires `source.workspaceId === input.workspaceId`). Best-effort: a park-store fault
 * must never crash the routing decision (the activity parks regardless); swallowed here (§16).
 */
async function recordParkBestEffort(
  park: IngestionInboxProjectionPort,
  source: SourceEnvelope,
): Promise<void> {
  try {
    await park.recordPark({ workspaceId: source.workspaceId, source });
  } catch {
    /* best-effort — never crash the routing decision on an inbox-write fault */
  }
}
