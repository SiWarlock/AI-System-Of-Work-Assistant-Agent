// Task 14.7 (worker leg) / 24.17 (this file's fix). THE cross-workspace READ GATE. HIGHEST safety bar
// (safety rule 4 / WS-8).
//
// `resolveApprovedCrossWorkspaceSlice(readerWorkspaceId)` is the ONLY path by which reader-workspace
// A sees any of source-workspace B's content — and only the APPROVED, DIRECTIONAL, SCOPED, SANITIZED
// slice, re-gated against B's LIVE visibility ceiling. Fail-closed by construction:
//   - absent any approved link ⇒ zero projections (ZERO cross-workspace bleed — WS-8 stays isolating).
//   - only B rows matching the link's OWN approved scope (projectionType + visibilityLevel, frozen at
//     approval time — an owner-specific grant that must not silently widen) cross.
//   - every crossing row ALSO passes the real @sow/knowledge GCL Visibility Gate (`serveProjection`) —
//     ajv + Zod (a raw-content-shaped value fails CLOSED, `sanitization_rejected`, withholding the
//     WHOLE read) PLUS the §5 ceiling: the row's visibilityLevel must not exceed the SOURCE
//     workspace's CURRENT `defaultVisibility`, fetched fresh per link (24.17 — the link's own scope
//     and the workspace's live ceiling are TWO INDEPENDENT gates that must both pass; neither replaces
//     the other, so tightening a workspace's default now actually moves what crosses).
//   - a row that clears its link's scope but exceeds the live ceiling is withheld PER ROW (not a
//     whole-read abort — other rows within ceiling still cross) and COUNTED (`visibilityExceededCount`)
//     rather than silently dropped: a legitimately-tightened ceiling and a row admitted before
//     enforcement was live (the tampered-row case this gate exists to catch) are indistinguishable
//     from here — the count is the signal to investigate, never a verdict (rule 7: a count only, never
//     the row's content/path/slug).
//   - a link whose source workspace's live ceiling cannot be evaluated (store fault, not-found, a
//     RETURNED workspace whose own id doesn't match the requested one — worker Lesson 55, never trust
//     an unread id — or a malformed `defaultVisibility`) withholds THAT LINK's rows and is COUNTED
//     separately (`workspaceCeilingUnavailableCount`) — so "could not evaluate" is never silently
//     indistinguishable from "nothing qualified" (both read as zero projections without this counter).
//   - a degenerate (empty) persisted scope crosses NOTHING (never all-of-B).
//   - any store fault ⇒ `store_fault` (never a partial / leaky read). Never throws.
//
// REACHABILITY (Lesson 11): the consumers that BLEND this slice into a coordination/global brief are
// Phase 25.2/25.4 (deferred). This gate is the reachable unit they will call — it is deliberately NOT
// wired into the empty aggregate global producer (`queries.ts globalSurface`, workspaceId=null), which
// is a different (aggregate, non-directional) concept. Ships behind a reachability waiver until 25.2/25.4.
import { ok, err, isErr, type Result } from "@sow/contracts";
import { isVisibilityLevel, type GclProjection, type WorkspaceId } from "@sow/contracts";
import type { CrossWorkspaceLinkRepository, GclProjectionRepository, WorkspaceConfigRepository } from "@sow/db";
import { serveProjection, type GclAuditPersistPort } from "@sow/knowledge";

/**
 * Task 24.52 — bound `serveProjection`'s optional audit-persist write BEFORE any real
 * `GclAuditPersistPort` binds (today it is unbound — see the module header; `auditPersist` below
 * is dormant/reachability-waived, same as the rest of this gate).
 *
 * `persistDenialAudit` (`@sow/knowledge`, out of this package's layer) `await`s
 * `auditPersist.persistDenial(...)` directly, and this file's own read loop `await`s
 * `serveProjection` PER ROW, serially. Left unbound, once a real port lands: N denials cost N
 * serial write-latencies, and a port that never resolves hangs the WHOLE read forever — a
 * regression on the denial's own fail-closed guarantee (24.33), which must never depend on the
 * audit write landing.
 *
 * `boundAuditPersist` wraps a real port so its `persistDenial` returns to its OWN caller
 * (`persistDenialAudit`, awaited by `serveProjection`, awaited by this file's loop) as soon as the
 * call is ACCEPTED — never once the real write actually lands. The real write proceeds
 * fire-and-forget, capped at `maxConcurrent` in-flight writes and `perWriteTimeoutMs` each:
 *   - queue full (⇒ maxConcurrent already in flight)  ⇒ the call is DROPPED — the real port's
 *     `persistDenial` is never even invoked for it.
 *   - a write that outlives `perWriteTimeoutMs`        ⇒ counted as DROPPED and its slot is freed
 *     (the underlying promise cannot be cancelled — this stops ACCOUNTING it as in-flight, it does
 *     not abort it) so one hung write cannot permanently shrink the queue's capacity.
 * Every drop calls `onDrop()` — audits dropped by this bound are COUNTED, never silent (a silently
 * dropped audit re-creates task 24.53's defect through this very fix). `onDrop` never throws by
 * contract (a caller-supplied counter increment); this wrapper never surfaces a real-port throw or
 * rejection either — `persistDenialAudit`'s never-throw contract on ITS caller is preserved.
 */
export interface BoundAuditPersistOptions {
  /** Max concurrent in-flight real writes; a call beyond this is dropped immediately. */
  readonly maxConcurrent?: number;
  /** Per-write ceiling; a write outliving this is counted dropped and its slot freed. */
  readonly perWriteTimeoutMs?: number;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_PER_WRITE_TIMEOUT_MS = 2000;

export function boundAuditPersist(
  port: GclAuditPersistPort,
  onDrop: () => void,
  opts: BoundAuditPersistOptions = {},
): GclAuditPersistPort {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const perWriteTimeoutMs = opts.perWriteTimeoutMs ?? DEFAULT_PER_WRITE_TIMEOUT_MS;
  let inFlight = 0;
  return {
    // NOTE: an `async` function with no `await` before its (implicit) return resolves on the NEXT
    // microtask — i.e. this returns to `persistDenialAudit` WITHOUT waiting on the real write.
    async persistDenial(signal, workspaceId): Promise<void> {
      if (inFlight >= maxConcurrent) {
        onDrop(); // queue full — the real port is never invoked for this call.
        return;
      }
      inFlight += 1;
      let freed = false;
      const free = (): void => {
        if (freed) return;
        freed = true;
        inFlight -= 1;
      };
      const timer = setTimeout(() => {
        onDrop(); // outlived the per-write bound — counted, slot freed (write left running, unawaited).
        free();
      }, perWriteTimeoutMs);
      // Fire-and-forget: NOT awaited by this function's own return.
      void Promise.resolve(port.persistDenial(signal, workspaceId))
        .catch(() => undefined) // a real-port throw/rejection never surfaces here (never-throw, §16).
        .finally(() => {
          clearTimeout(timer);
          free();
        });
    },
    onRefused: port.onRefused,
  };
}

/** Deps for the read gate — the link store, the GCL projection store, and (24.17) the LIVE workspace
 *  config store the §5 ceiling re-derivation reads the source workspace's CURRENT defaultVisibility
 *  from (never a value frozen on the link). `auditPersist` (24.52) is OPTIONAL and UNBOUND in
 *  production today (see the module header) — when a caller does inject one, `resolveApprovedCrossWorkspaceSlice`
 *  wraps it in {@link boundAuditPersist} before handing it to `serveProjection`, so the bound is in
 *  place BEFORE the port composition-root wiring that would otherwise need to remember it. */
export interface CrossWorkspaceReadDeps {
  readonly links: CrossWorkspaceLinkRepository;
  readonly gclProjections: GclProjectionRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly auditPersist?: GclAuditPersistPort;
  /** 24.52 bound tuning; defaults apply when omitted. Test-only in practice today (`auditPersist`
   *  is unbound in production), kept on the same deps object rather than a module-level constant. */
  readonly auditPersistBound?: BoundAuditPersistOptions;
}

/** Typed, redaction-safe read failures. */
export type CrossWorkspaceReadError =
  | { readonly code: "store_fault"; readonly message: string }
  // A B projection carried a raw-content-shaped value — withhold the WHOLE read (never raw bytes).
  | { readonly code: "sanitization_rejected"; readonly message: string };

/**
 * The APPROVED, SCOPED, gate-re-validated cross-workspace slice a reader workspace may blend, plus
 * (24.17) the two withheld-and-counted signals so a caller can tell "the ceiling could not be
 * evaluated" and "a row exceeded the live ceiling" apart from a genuine empty result — never a path,
 * slug, or projection content (rule 7), just counts.
 */
export interface CrossWorkspaceReadOutcome {
  readonly projections: readonly GclProjection[];
  /** Rows that matched their link's own scope but were withheld because their visibilityLevel
   *  exceeded the source workspace's CURRENT defaultVisibility ceiling. */
  readonly visibilityExceededCount: number;
  /** Approved links whose source workspace's live ceiling could not be evaluated (store fault,
   *  not-found, a returned workspace whose own id didn't match the requested one, or a malformed
   *  defaultVisibility) — that link's rows were withheld defensively. */
  readonly workspaceCeilingUnavailableCount: number;
  /** 24.52 — denial-audit writes DROPPED by {@link boundAuditPersist} (queue-full or per-write
   *  timeout). Zero when `deps.auditPersist` is unbound (today's production default) or when every
   *  write completed within the bound. A drop never withholds a projection or alters a verdict — it
   *  only means the OPERATIONAL audit trail for that denial did not land; never silent (24.53's class). */
  readonly auditPersistDroppedCount: number;
}

const EMPTY_OUTCOME: CrossWorkspaceReadOutcome = {
  projections: [],
  visibilityExceededCount: 0,
  workspaceCeilingUnavailableCount: 0,
  auditPersistDroppedCount: 0,
};

/**
 * Resolve the APPROVED, SCOPED, gate-re-validated cross-workspace slice a reader workspace may blend.
 * The single sanctioned WS-8 cross-workspace read. Fail-closed everywhere; never throws.
 */
export async function resolveApprovedCrossWorkspaceSlice(
  deps: CrossWorkspaceReadDeps,
  readerWorkspaceId: string,
): Promise<Result<CrossWorkspaceReadOutcome, CrossWorkspaceReadError>> {
  try {
    const approved = await deps.links.listApprovedForReader(readerWorkspaceId as WorkspaceId);
    if (isErr(approved)) return err({ code: "store_fault", message: "cross-workspace link list failed" });
    // ZERO bleed — the fail-closed default. WS-8 stays fully isolating absent an approved link.
    if (approved.value.length === 0) return ok(EMPTY_OUTCOME);

    const out: GclProjection[] = [];
    let visibilityExceededCount = 0;
    let workspaceCeilingUnavailableCount = 0;
    // 24.52 — wrap `deps.auditPersist` (unbound in production today) ONCE per call so the
    // concurrency cap spans the WHOLE read, not per-link/per-row. `undefined` deps.auditPersist
    // ⇒ `wrappedAuditPersist` stays `undefined` ⇒ `serveProjection` is called exactly as before
    // this fix (byte-equivalent on the dormant, unbound production path).
    let auditPersistDroppedCount = 0;
    const wrappedAuditPersist =
      deps.auditPersist === undefined
        ? undefined
        : boundAuditPersist(
            deps.auditPersist,
            () => {
              auditPersistDroppedCount += 1;
            },
            deps.auditPersistBound,
          );
    for (const link of approved.value) {
      // Defense-in-depth: the store already filters status + reader, re-assert both here so a
      // looser store binding can never widen the gate.
      if (link.status !== "approved") continue;
      if (link.fromWorkspaceId !== readerWorkspaceId) continue; // directional (A→B ≠ B→A)
      if (link.scopeProjectionType.length === 0) continue; // degenerate scope ⇒ cross nothing

      // 24.17 — fetch the SOURCE workspace FRESH, per link, so a post-approval tightening of its
      // defaultVisibility is honored (never the link's own frozen scope, checked separately below).
      // Worker Lesson 55: verify the RETURNED id equals the REQUESTED one — a validated-but-unused id
      // is the tell of a per-workspace read that trusts an unread field. A fault, a mismatched id, or
      // a malformed defaultVisibility all withhold this LINK's rows the same way (defensively counted,
      // never silently folded into "nothing qualified").
      const sourceWorkspace = await deps.workspaceConfig.get(link.toWorkspaceId);
      if (
        isErr(sourceWorkspace) ||
        sourceWorkspace.value.id !== link.toWorkspaceId ||
        !isVisibilityLevel(sourceWorkspace.value.defaultVisibility)
      ) {
        workspaceCeilingUnavailableCount += 1;
        continue;
      }

      const projections = await deps.gclProjections.listByWorkspace(link.toWorkspaceId);
      if (isErr(projections)) return err({ code: "store_fault", message: "gcl projection list failed" });

      for (const projection of projections.value) {
        // Read-back identity re-gate (worker Lesson 12): the crossing row MUST belong to the link's
        // SOURCE workspace (B). WS-8 source correctness must not rest on `listByWorkspace`'s filter
        // alone — a mis-filtered / tampered store row from another workspace never crosses to A.
        if (projection.workspaceId !== link.toWorkspaceId) continue;
        // The link's OWN approved scope — an owner-specific grant, frozen by design (must not
        // silently widen just because the workspace default moves). Independent of, and required IN
        // ADDITION to, the live ceiling gate below — two gates, neither replaces the other.
        if (projection.projectionType !== link.scopeProjectionType) continue;
        if (projection.visibilityLevel !== link.scopeVisibilityLevel) continue;

        // THE FIX (24.17): route through the REAL GCL Visibility Gate — never a bare schema parse.
        // `serveProjection` = ajv + Zod (raw-content-shaped-key rejection, a superset of the previous
        // safeParse) + the §5 ceiling (visibilityLevel <= sourceWorkspace.defaultVisibility). The
        // `malformed_policy_input` branch is unreachable here BY CONSTRUCTION: the workspaceId-mismatch
        // case is already excluded by the read-back re-gate above (sourceWorkspace.value.id ===
        // link.toWorkspaceId === projection.workspaceId), and the malformed-defaultVisibility case is
        // already excluded by the `isVisibilityLevel` pre-check above — so only the two reachable cases
        // are handled explicitly below.
        // 24.52 — the 5th arg is the BOUNDED port (or `undefined`, byte-equivalent to before this
        // fix). Passing it here, not changing `persistDenialAudit`/`serveProjection` themselves
        // (out of this package's layer), is what bounds the audit-persist wait for THIS caller.
        const admitted = await serveProjection(
          projection,
          sourceWorkspace.value,
          undefined,
          undefined,
          wrappedAuditPersist,
        );
        if (isErr(admitted)) {
          if (admitted.error.code === "visibility_exceeds_source") {
            visibilityExceededCount += 1;
            continue; // per-row: other in-ceiling rows from this link still cross.
          }
          // raw_content_present / schema_rejected (and the unreachable malformed_policy_input,
          // handled the same defensively) — unchanged from before this fix: a poisoned row withholds
          // the WHOLE read (never raw bytes cross, safety rule 4).
          return err({ code: "sanitization_rejected", message: "cross-workspace projection failed sanitization" });
        }
        out.push(admitted.value);
      }
    }
    return ok({ projections: out, visibilityExceededCount, workspaceCeilingUnavailableCount, auditPersistDroppedCount });
  } catch {
    return err({ code: "store_fault", message: "cross-workspace read failed" });
  }
}
