import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";

// §9.7 triage-resolution disposition (renderer side). The renderer is UNTRUSTED: it only
// REQUESTS a disposition — the worker (`command.disposeTriage`) re-enters the ingestion
// pipeline REUSING the caller's `idempotencyKey` verbatim (the pipeline, via TriagePort, is
// the ONLY writer; ING-4). `UiSafeIngestionItem` carries NO idempotencyKey (only `sourceId`),
// so this wrapper MINTS one deterministically per (sourceId, disposition) — a double-click /
// retry / cross-channel replay lands the SAME key → the pipeline dedupes to one effect. It
// folds a typed err OR any transport error to `{ ok: false }` (fail closed — a failed
// disposition surfaces nothing; §16 never-throw at the UI boundary), mirroring
// `approval-decision.ts`.

/**
 * The dispositions the inbox offers per card. Defined locally (a UI-level concept — the
 * action buttons); the worker's `disposeTriage` takes an OPEN string + the pipeline owns the
 * real taxonomy, so this union is a convenience, never the authority.
 */
export type TriageDisposition = "accept" | "reject";

export type DispositionResult =
  | { readonly ok: true; readonly idempotencyKey: string }
  | { readonly ok: false };

/**
 * Mint the STABLE idempotency key for a (sourceId, disposition). Deterministic — a double-click
 * / retry reuses the SAME key so the worker's verbatim-key re-entry dedupes to one effect (ING-4).
 * NOT a fresh-per-click value.
 */
export function triageIdempotencyKey(sourceId: string, disposition: TriageDisposition): string {
  return `${sourceId}:${disposition}`;
}

/** Build the triage-disposition caller over a live tRPC client. */
export function createTriageDisposition(
  client: CreateTRPCClient<AppRouter>,
): (sourceId: string, disposition: TriageDisposition) => Promise<DispositionResult> {
  return async (sourceId: string, disposition: TriageDisposition): Promise<DispositionResult> => {
    try {
      const idempotencyKey = triageIdempotencyKey(sourceId, disposition);
      const res = await client.command.disposeTriage.mutate({ sourceId, idempotencyKey, disposition });
      // Accept only a well-formed ok result carrying a non-empty string idempotencyKey. Defense-in-depth
      // mirroring approval-decision's schema re-validation: a malformed/leaky result from a future
      // server-projector regression folds to `{ ok: false }`, never a partial drain.
      if (
        res.ok === true &&
        res.value != null &&
        typeof res.value === "object" &&
        typeof res.value.idempotencyKey === "string" &&
        res.value.idempotencyKey.length > 0
      ) {
        return { ok: true, idempotencyKey: res.value.idempotencyKey };
      }
      // A typed err (degraded / not-found) or a malformed result → fail closed.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / stale disposition).
      return { ok: false };
    }
  };
}
