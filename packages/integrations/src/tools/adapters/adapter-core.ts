// @sow/integrations — the shared 6.4 adapter core.
//
// Every per-target write adapter (calendar / todoist / linear / asana / drive /
// github / telegram) is the SAME pure translator over the injected transport
// (transport.ts): build an `AdapterTransportRequest`, call the transport, map the
// `TransportResponse` into the port's typed `Result<…, AdapterError>`. What
// differs per target is ONLY (a) the `targetSystem` tag and (b) how the envelope
// is turned into the identity map that the canonicalObjectKey was built from
// (the `IdentityDeriver`). That per-target policy is injected; this core owns the
// invariant-bearing mechanics so no adapter re-implements them and drifts:
//
//   • §16 TOTALITY — the transport is awaited inside a try/catch; a thrown
//     transport (an unexpected client bug) is mapped to a typed `unknown`
//     AdapterError. NO throw ever crosses the port boundary.
//   • RECEIPT PROOF — a create/update receipt requires a NON-WHITESPACE
//     externalObjectId (mirrors WriteReceiptSchema); a whitespace-only vendor id
//     is not proof of a write → typed `unknown` fault (fail-closed).
//   • CLOCK PURITY — `recordedAt` comes from the injected `clock()` (ISO), never
//     Date.now() (no clock in the module).
//   • REDACTION — the raw payload NEVER reaches a log; the optional injected
//     `logSink` receives only a foundation-redacted `SafeToolWriteLog`.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  TargetSystem,
  WriteReceipt,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../adapter-port";
import {
  buildSafeToolWriteLog,
  type SafeToolWriteLog,
} from "../../redaction/gateway-log-redaction";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportResponse,
  TransportObject,
  TransportFault,
} from "./transport";

/**
 * Derive the per-target identity map (the key/value pairs the
 * canonicalObjectKey was built from via `buildCanonicalObjectKey`) for a given
 * envelope. Each adapter supplies its own — this is the ONE piece of per-target
 * knowledge the shared core cannot know. Pure.
 */
export type IdentityDeriver = (
  env: ExternalWriteEnvelope,
) => Readonly<Record<string, string>>;

/** The injected deps every 6.4 adapter factory takes. Clock is REQUIRED (purity). */
export interface AdapterDeps {
  readonly transport: AdapterTransport;
  /** Injected ISO clock — `recordedAt` source. NEVER Date.now() in the module. */
  readonly clock: () => string;
  /** Optional redaction-safe log sink; only ever receives a `SafeToolWriteLog`. */
  readonly logSink?: (rec: SafeToolWriteLog) => void;
}

/** The per-target spec the shared core is parameterized by. */
export interface AdapterSpec {
  readonly targetSystem: TargetSystem;
  readonly deriveIdentity: IdentityDeriver;
}

// A transport fault code maps 1:1 onto the port's AdapterError code.
function faultToError(fault: TransportFault, detail: string): AdapterError {
  return { code: fault, message: detail };
}

// A vendor id is proof of a write ONLY if it is non-empty AND non-whitespace
// (mirrors WriteReceiptSchema.externalObjectId.refine). A whitespace-only id is
// fail-closed: not a receipt.
function isRealVendorId(id: string): boolean {
  return id.trim().length > 0;
}

// Emit a redaction-safe diagnostic (never the raw payload — safety rule 7).
function emitSafeLog(
  deps: AdapterDeps,
  env: ExternalWriteEnvelope,
  status: string,
): void {
  if (deps.logSink === undefined) return;
  deps.logSink(
    buildSafeToolWriteLog({
      targetSystem: env.targetSystem,
      canonicalObjectKey: env.canonicalObjectKey,
      idempotencyKey: env.idempotencyKey,
      payloadHash: env.payloadHash,
      status,
    }),
  );
}

// Run the injected transport inside a §16 throw-guard. A thrown transport (an
// unexpected client bug) is mapped to a typed `unknown` — never propagated.
async function callTransport(
  deps: AdapterDeps,
  req: AdapterTransportRequest,
): Promise<Result<TransportResponse, AdapterError>> {
  try {
    return ok(await deps.transport(req));
  } catch {
    // The thrown value may embed raw content/secrets — do NOT include it in the
    // message (safety rule 7). A fixed, redaction-safe diagnostic only.
    return err<AdapterError>({ code: "unknown", message: "transport threw (non-Result)" });
  }
}

// Turn a successful create/update transport object into a WriteReceipt, applying
// the non-whitespace-id proof gate + the injected clock.
function toReceipt(
  deps: AdapterDeps,
  object: TransportObject,
): Result<WriteReceipt, AdapterError> {
  if (!isRealVendorId(object.externalObjectId)) {
    return err<AdapterError>({
      code: "unknown",
      message: "vendor returned an empty/whitespace externalObjectId (not proof of a write)",
    });
  }
  const receipt: WriteReceipt = {
    externalObjectId: object.externalObjectId,
    ...(object.externalUrl !== undefined ? { externalUrl: object.externalUrl } : {}),
    recordedAt: deps.clock(),
    ...(object.rawRef !== undefined ? { rawRef: object.rawRef } : {}),
  };
  return ok(receipt);
}

/**
 * Build a `TargetWriteAdapter` from a per-target `AdapterSpec` + injected
 * `AdapterDeps`. This is the ONLY place the invariant-bearing mechanics live;
 * each vendor adapter is a one-liner that calls this with its own spec.
 */
export function makeTargetWriteAdapter(
  spec: AdapterSpec,
  deps: AdapterDeps,
): TargetWriteAdapter {
  const baseReq = (
    env: ExternalWriteEnvelope,
  ): Pick<AdapterTransportRequest, "targetSystem" | "canonicalObjectKey" | "idempotencyKey" | "identity"> => ({
    targetSystem: spec.targetSystem,
    canonicalObjectKey: env.canonicalObjectKey,
    idempotencyKey: env.idempotencyKey,
    identity: spec.deriveIdentity(env),
  });

  return {
    targetSystem: spec.targetSystem,

    async existenceCheck(
      _canonicalObjectKey: string,
      env: ExternalWriteEnvelope,
    ): Promise<Result<ExistingObject | null, AdapterError>> {
      const called = await callTransport(deps, { op: "query", ...baseReq(env) });
      if (!called.ok) return called;
      const resp = called.value;
      if (!resp.ok) {
        // A live-probe FAULT is surfaced typed — NEVER collapsed to `null`, which
        // would risk a duplicate create (existence-check.ts holds fail-closed).
        emitSafeLog(deps, env, "existence_probe_fault");
        return err(faultToError(resp.fault, resp.detail));
      }
      if (resp.object === null) return ok(null);
      const existing: ExistingObject = {
        externalObjectId: resp.object.externalObjectId,
        ...(resp.object.externalUrl !== undefined ? { externalUrl: resp.object.externalUrl } : {}),
        ...(resp.object.rawRef !== undefined ? { rawRef: resp.object.rawRef } : {}),
      };
      return ok(existing);
    },

    async create(
      env: ExternalWriteEnvelope,
      payload: Record<string, unknown>,
    ): Promise<Result<WriteReceipt, AdapterError>> {
      const called = await callTransport(deps, { op: "create", ...baseReq(env), payload });
      if (!called.ok) return called;
      const resp = called.value;
      if (!resp.ok) {
        emitSafeLog(deps, env, "create_fault");
        return err(faultToError(resp.fault, resp.detail));
      }
      if (resp.object === null) {
        // A create that reports no object is not proof of a write (fail-closed).
        return err<AdapterError>({
          code: "unknown",
          message: "create returned no vendor object (not proof of a write)",
        });
      }
      const receipt = toReceipt(deps, resp.object);
      if (receipt.ok) emitSafeLog(deps, env, resp.deduped === true ? "created_deduped" : "created");
      return receipt;
    },

    async update(
      env: ExternalWriteEnvelope,
      payload: Record<string, unknown>,
      expectedPrecondition?: string,
    ): Promise<Result<WriteReceipt, AdapterError>> {
      const called = await callTransport(deps, {
        op: "update",
        ...baseReq(env),
        payload,
        ...(expectedPrecondition !== undefined ? { expectedPrecondition } : {}),
      });
      if (!called.ok) return called;
      const resp = called.value;
      if (!resp.ok) {
        // A stale precondition surfaces as `conflict` — NEVER a blind overwrite.
        emitSafeLog(deps, env, "update_fault");
        return err(faultToError(resp.fault, resp.detail));
      }
      if (resp.object === null) {
        return err<AdapterError>({
          code: "unknown",
          message: "update returned no vendor object (not proof of a write)",
        });
      }
      return toReceipt(deps, resp.object);
    },
  };
}
