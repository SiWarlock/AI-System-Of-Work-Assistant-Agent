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
  TransportFaultDetail,
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

// ── external-write credential seam (21.10, safety rule 7 / §19.8) ──────────────

/** Why a write token could not be resolved (SecretsPort-shaped). A missing/locked/
 *  denied token FAILS the write CLOSED (no unauthenticated write) — never a throw of
 *  the raw reason, never the token value. (Named distinctly from the connector READ-auth
 *  `SecretUnavailable` — this is the external-WRITE seam.) */
export const WriteSecretUnavailableReason = ["missing", "locked", "denied"] as const;
export type WriteSecretUnavailableReason = (typeof WriteSecretUnavailableReason)[number];

export interface WriteSecretUnavailable {
  readonly reason: WriteSecretUnavailableReason;
}

/**
 * SecretsPort-shaped accessor for external-WRITE auth tokens: resolves a macOS
 * Keychain REFERENCE handle (never an inline token, REQ-S-003) to the token value as
 * a typed Result — a missing/locked/denied token is an Err, not a throw. The worker
 * binds the real KeychainSecretsAdapter at boot (a separate task); tests inject a
 * mock. The write path reads only the ok/err VERDICT — never the token value (rule 7).
 */
export interface WriteSecretsAccessor {
  getSecret(ref: string): Promise<Result<string, WriteSecretUnavailable>>;
}

/**
 * Derive the 17.4 `keychain://<service>/<account>` write-token ref for a target. Object
 * targets (calendar/todoist/linear/asana/drive/github) resolve a `connector-write:<vendor>`
 * token; telegram resolves the `telegram-bot:*` token (the concrete bot account is bound
 * at §ARM-21 arming). PURE — no I/O, no secret; the real Keychain resolution + ref parse
 * happen in the worker-bound accessor.
 */
export function writeSecretRef(targetSystem: TargetSystem): string {
  return targetSystem === "telegram"
    ? "keychain://telegram-bot/*"
    : `keychain://connector-write/${targetSystem}`;
}

// Fixed, closed-set diagnostic text for a fault that carried no `httpStatus`
// (no HTTP response was ever received — an SSRF-block, a credential fault, a
// network-level outage). Distinct per fault code so an operator can still tell
// these apart without any transport-supplied text.
const FAULT_MESSAGE: Readonly<Record<TransportFault, string>> = {
  unreachable: "target system unreachable",
  conflict: "write conflict (stale precondition)",
  rejected: "request rejected",
  unknown: "unclassified adapter fault",
};

// §S FIX — build `message` from CLOSED inputs only: the fault code (4 fixed
// values), the structured `httpStatus` (a real number, when the transport
// received one), and the closed `faultDetail` token (transport.ts's
// `TransportFaultDetail`, for a fault that never got an HTTP response). NEVER
// the transport's free-text `detail` — a per-vendor `mapResponse` builds
// `TransportResponse` directly and could put anything in `detail` (a raw vendor
// body, a token-bearing URL); forwarding it verbatim used to make that string
// cross the Tool Gateway into `ExternalWriteResult.reason` unredacted. Neither a
// number nor a member of a module-local literal union can carry that kind of
// payload — safe to fold into the diagnostic message.
//
// WHY THE THIRD INPUT EXISTS. Barring `detail` was correct, but on its own it
// made six distinct statusless failures render byte-identically as "request
// rejected" — a missing / locked / denied / empty credential, a throwing
// credential accessor, and an SSRF/allowlist block. Collapsing distinct failures
// into one string is a real operator cost, so the distinction is re-drawn with a
// CLOSED sub-reason rather than by reopening free text: a hostile `mapResponse`
// can SELECT a token, never author one.
//
// SCOPE OF THAT CLAIM — THIS FUNCTION RENDERS, IT DOES NOT PRODUCE. `faultToError`
// can only spend a `faultDetail` some TRANSPORT set; it cannot conjure one. So
// the six render distinctly exactly where the transport in play populates the
// field. `createWriteHttpTransport` (write-http-transport.ts, the real write-side
// HTTP transport) sets it at every statusless fault return, which is what makes
// the distinction hold on the real path — end-to-end, pinned by
// write-http-transport.test.ts. A transport that leaves it undefined still
// collapses onto the bare `FAULT_MESSAGE[fault]` string, exactly as before.
//
// `faultDetail` ALSO rides `AdapterError.faultDetail` as its own typed field, for
// the same reason `httpStatus` does: the moment a machine token is embedded in
// prose, a caller that must branch will parse the prose. It never has to.
function faultToError(
  fault: TransportFault,
  httpStatus?: number,
  faultDetail?: TransportFaultDetail,
): AdapterError {
  return {
    code: fault,
    message:
      httpStatus !== undefined
        ? `HTTP ${httpStatus}`
        : faultDetail !== undefined
          ? `${FAULT_MESSAGE[fault]} (${faultDetail})`
          : FAULT_MESSAGE[fault],
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(faultDetail !== undefined ? { faultDetail } : {}),
  };
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
        return err(faultToError(resp.fault, resp.httpStatus, resp.faultDetail));
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
        return err(faultToError(resp.fault, resp.httpStatus, resp.faultDetail));
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
        return err(faultToError(resp.fault, resp.httpStatus, resp.faultDetail));
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
