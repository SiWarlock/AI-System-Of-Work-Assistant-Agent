// @sow/integrations — 6.4 DRIVE write adapter (doc upsert).
//
// arch_gap: §8 names no per-target identity contract for a Drive doc — we adopt
// {docKey} keyed off the canonicalObjectKey so the existence probe matches by
// canonical key (safety invariant 2, no duplicate create). Drive upsert flows
// through create (new doc) or update (existing doc under a precondition/etag; a
// stale etag → 'conflict', never a blind overwrite — enforced by the core).
//
// R1 FIX — DRIVE-SPECIFIC 404 PROMOTION: the shared adapter core's transport
// fault set (`TransportFault`, transport.ts) has no `not_found` member — every
// vendor fault the transport reports collapses to `unreachable` / `conflict` /
// `rejected` / `unknown`. The real write-HTTP transport template
// (write-http-transport.ts's `statusToFault`) folds EVERY 4xx into the generic
// `rejected` fault, but rides the actual status through as a STRUCTURED
// `httpStatus` number (transport.ts, §S) alongside the fault code. A Drive 404
// means "the managed doc — or its containing folder — is missing or
// unlinked", which notebooklm-sync.ts (the sole caller) must treat as a
// per-slot REATTACH signal, never a hard failure that fails the whole
// five-slot sync closed. This wrapper promotes exactly that ONE structured
// status to the port's `not_found` code; every other 4xx (401/403/etc.), and
// every other fault kind, passes through byte-unchanged and still fails
// closed.
//
// §S FIX (this defect's 4th surfacing of the same bug — see CLAUDE.md "THE ONE
// PATTERN BEHIND ALL FOUR BREAKS"): this used to branch on
// `error.message === "HTTP 404"`, an exact string comparison over a message
// FORMAT that `adapter-core.ts`'s `faultToError` owns. That format changed
// (faultToError now builds `message` from `{fault, httpStatus}` — see that
// file) and would have silently broken this comparison were it still string-
// based. It now branches on `error.httpStatus === 404`, the typed field the
// transport sets alongside the fault — never on `message`'s prose.
import { err } from "@sow/contracts";
import type { Result, WriteReceipt, ExternalWriteEnvelope } from "@sow/contracts";
import type { TargetWriteAdapter, AdapterError, ExistingObject } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

// Promote a structured 404 `rejected` fault to the port's `not_found` code, by
// branching on the typed `httpStatus` field — NEVER on `message`'s prose (see
// module header §S FIX). Every other fault (a different 4xx, a conflict, an
// outage, unknown) passes through unchanged.
function promoteNotFound(error: AdapterError): AdapterError {
  return error.code === "rejected" && error.httpStatus === 404
    ? { code: "not_found", message: error.message, httpStatus: error.httpStatus }
    : error;
}

/**
 * Factory: a Drive `TargetWriteAdapter` over the injected transport + clock.
 * Upsert a doc; existence-probe by the doc's canonical identity. Wraps the
 * shared core to promote a structured Drive 404 to the port's `not_found` code
 * on every op (see module header) — every other fault passes through
 * unchanged.
 */
export function createDriveWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  const base = makeTargetWriteAdapter(
    {
      targetSystem: "drive",
      deriveIdentity: (env) => ({ docKey: env.canonicalObjectKey }),
    },
    deps,
  );

  return {
    targetSystem: base.targetSystem,

    async existenceCheck(
      canonicalObjectKey: string,
      env: ExternalWriteEnvelope,
    ): Promise<Result<ExistingObject | null, AdapterError>> {
      const result = await base.existenceCheck(canonicalObjectKey, env);
      return result.ok ? result : err(promoteNotFound(result.error));
    },

    async create(
      env: ExternalWriteEnvelope,
      payload: Record<string, unknown>,
    ): Promise<Result<WriteReceipt, AdapterError>> {
      const result = await base.create(env, payload);
      return result.ok ? result : err(promoteNotFound(result.error));
    },

    async update(
      env: ExternalWriteEnvelope,
      payload: Record<string, unknown>,
      expectedPrecondition?: string,
    ): Promise<Result<WriteReceipt, AdapterError>> {
      const result = await base.update(env, payload, expectedPrecondition);
      return result.ok ? result : err(promoteNotFound(result.error));
    },
  };
}
