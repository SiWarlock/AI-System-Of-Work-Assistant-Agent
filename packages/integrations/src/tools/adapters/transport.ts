// @sow/integrations — the INJECTED transport contract for slice 6.4 per-target
// write adapters (behind the 6.2 envelope).
//
// A `TargetWriteAdapter` (adapter-port.ts) performs NO real network I/O in the
// module (§16: adapters take injected deps; no real network/clock/randomness).
// The single seam through which every adapter talks to a vendor is this
// `AdapterTransport` fn — the test injects a fake, the wiring layer injects the
// real vendor client. Modeling ALL three adapter operations (existence query /
// create / update) as ONE request/response union keeps every adapter a thin,
// pure translator: build an `AdapterTransportRequest`, call the transport, map the
// `TransportResponse` into the port's typed `Result<…, AdapterError>`.
//
// The transport MUST NOT throw for a normal vendor fault — it returns
// `{ ok:false, fault }`. A thrown transport (a truly unexpected client bug) is
// still caught by the shared adapter core and mapped to a typed `unknown`
// AdapterError, because §16 forbids a throw crossing the port boundary.
import type { TargetSystem } from "@sow/contracts";

/**
 * The three vendor operations an adapter drives. `query` — the pre-write
 * existence probe (match-by-identity; safety invariant 2). `create` — issue the
 * external create. `update` — mutate an existing object under an optional
 * precondition (a stale precondition is a `conflict`, never a blind overwrite).
 */
export type TransportOp = "query" | "create" | "update";

/**
 * A single transport request. Carries the identity binding the adapter derived
 * (`canonicalObjectKey` + `idempotencyKey`) plus the operation-specific fields.
 * `identity` is the per-target key/value map the canonicalObjectKey was built
 * from (so the fake/real transport can resolve the vendor object). `payload` is
 * the write body (absent on a `query`). `expectedPrecondition` rides an
 * `update`. The raw `payload` never reaches a log — diagnostics route through the
 * foundation redaction (safety rule 7).
 */
export interface AdapterTransportRequest {
  readonly op: TransportOp;
  readonly targetSystem: TargetSystem;
  readonly canonicalObjectKey: string;
  readonly idempotencyKey: string;
  readonly identity: Readonly<Record<string, string>>;
  readonly payload?: Record<string, unknown>;
  readonly expectedPrecondition?: string;
}

/**
 * The closed transport fault set. Deliberately mirrors the port's `AdapterError`
 * codes so the mapping is 1:1: `unreachable` (transport could not reach the
 * vendor — the outbox-hold signal), `conflict` (precondition/version clash — a
 * stale `update`, NEVER overwrite), `rejected` (vendor refused: validation/auth),
 * `unknown` (unclassified). A `sourceRef`-free, redaction-safe `detail` only.
 */
export type TransportFault = "unreachable" | "conflict" | "rejected" | "unknown";

/**
 * A vendor object surfaced by the transport — the identity the adapter turns into
 * an `ExistingObject` (on a query hit) or a `WriteReceipt` (on a create/update).
 * `externalObjectId` is the vendor identity; `externalUrl` / `rawRef` are
 * redaction-safe pointers (never raw content/secrets inline).
 */
export interface TransportObject {
  readonly externalObjectId: string;
  readonly externalUrl?: string;
  readonly rawRef?: string;
}

/**
 * A transport response. `ok:true` with `object` — a create/update wrote (or a
 * query hit). `ok:true` with `object:null` — a query MISS (no such object; the
 * gateway may proceed to create). `deduped:true` — an idempotent echo (telegram
 * send-once): the SAME object without a second real post. `ok:false` — a typed
 * vendor fault. Never throws for a normal fault.
 */
export type TransportResponse =
  | { readonly ok: true; readonly object: TransportObject | null; readonly deduped?: boolean }
  | { readonly ok: false; readonly fault: TransportFault; readonly detail: string };

/**
 * The injected transport seam. ONE async fn drives all three ops. No real
 * network lives in the adapter module — the fake/real client is injected here.
 */
export type AdapterTransport = (req: AdapterTransportRequest) => Promise<TransportResponse>;
