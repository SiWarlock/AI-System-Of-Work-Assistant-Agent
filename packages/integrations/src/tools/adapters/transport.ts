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
  /**
   * The workspace this write is made on behalf of — the rule-4 scoping input for the write
   * credential (`writeSecretRef(target, workspaceId)`), threaded from `DispatchOptions.workspaceId`.
   *
   * ⛔ OPTIONAL IN THE TYPE, FAIL-CLOSED IN EFFECT. Optional so existing request builders still
   * compile; but a transport that needs a credential and has no workspace REFUSES rather than
   * resolving an unscoped one. Absence can only deny a write, never widen one.
   */
  readonly workspaceId?: string;
}

/**
 * The closed transport fault set. Deliberately mirrors the port's `AdapterError`
 * codes so the mapping is 1:1.
 *
 *   `unreachable` — the write COULD NOT BE DELIVERED NOW, BUT MAY SUCCEED LATER.
 *     This is the ONLY retryable fault: gateway.ts routes it, and only it, to
 *     `{status:"held"}` (the outbox-hold signal). Membership is therefore defined
 *     by that DISPOSITION, not by whether a packet arrived — a network-level
 *     outage, a 5xx, AND a vendor that explicitly said "later" (408/425/429 —
 *     write-http-transport.ts's `RETRYABLE_4XX`) all belong here. A 429 does
 *     reach the vendor; classifying it `rejected` on that basis made the single
 *     most common real-world external-write failure permanent.
 *   `conflict` — a precondition/version clash (a stale `update`, NEVER overwrite).
 *   `rejected` — the vendor refused, and re-sending the same bytes cannot help:
 *     auth (401/403), validation, an SSRF-blocked host, an unresolvable write
 *     credential. TERMINAL — never retried.
 *   `unknown` — unclassified.
 *
 * A `sourceRef`-free, redaction-safe `detail` only.
 */
export type TransportFault = "unreachable" | "conflict" | "rejected" | "unknown";

/**
 * The CLOSED sub-reason set for a STATUSLESS fault — one that carries no usable
 * `httpStatus` to distinguish it, because either no HTTP response was ever
 * received or the response's status was not an integer.
 *
 * WHY IT EXISTS. The §S fix (adapter-core.ts's `faultToError`) closed a real
 * leak channel — a transport's free-text `detail` reaching
 * `AdapterError.message` — with an instrument broader than the channel. With
 * `detail` barred and no status to fall back on, the ELEVEN statusless faults
 * the real write-side HTTP transport can return (write-http-transport.ts)
 * collapsed into THREE strings: six `rejected` faults (an SSRF/allowlist block, a
 * throwing credential accessor, and a missing / locked / denied / empty
 * credential) ALL rendered byte-identically as `"request rejected"`; four
 * `unknown` faults (a throwing `buildRequest`, a non-integer status, a malformed
 * 2xx body, a throwing `mapResponse`) as `"unclassified adapter fault"`; and the
 * network-outage fault alone as `"target system unreachable"`. "Your Keychain is
 * locked" and "an SSRF guard blocked this host" became the same sentence for the
 * operator.
 *
 * WHAT MAKES THE DISTINCTION REAL — A PRODUCER, NOT THE UNION. A token here only
 * separates anything if a transport actually SETS it. `createWriteHttpTransport`
 * (write-http-transport.ts) — the real write-side HTTP transport, and the
 * producer of all eleven faults above — sets one at EVERY statusless fault
 * return, which is what makes the eleven distinguishable end-to-end. COUNT THE
 * TWO SEPARATELY: there are NINE such `return` sites, and they yield ELEVEN
 * tokens, because the credential-unavailable return fans out over the three
 * `WriteSecretUnavailableReason` values. That is pinned by test, not asserted
 * here: write-http-transport.test.ts drives each of the eleven through
 * `makeTargetWriteAdapter` and requires eleven distinct `AdapterError.message`
 * strings. The claim is scoped to that transport — the field stays OPTIONAL, and
 * a test fake or a per-vendor `mapResponse` that omits it renders exactly as it
 * did before the field existed.
 *
 * WHY THIS DOES NOT REOPEN THE LEAK CHANNEL. These are module-local literals,
 * not transport-supplied text. A per-vendor `mapResponse` (the ONE genuinely
 * untrusted `TransportResponse` producer) can SELECT one of these tokens; it
 * cannot contribute a byte of its own. So `AdapterError.message` is still built
 * from CLOSED inputs only — there are now three of them (`fault`, `httpStatus`,
 * `faultDetail`) rather than two.
 */
export const TransportFaultDetail = [
  "request_build_error",
  "ssrf_blocked",
  "credential_fault",
  "credential_missing",
  "credential_locked",
  "credential_denied",
  "credential_empty",
  "transport_error",
  "malformed_status",
  "malformed_body",
  "map_error",
] as const;
export type TransportFaultDetail = (typeof TransportFaultDetail)[number];

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
 *
 * `httpStatus` — set ONLY when the fault came from an actual HTTP response AND
 * that response's status was an INTEGER (e.g. `404`); a caller
 * (`adapter-core.ts`'s `faultToError`, `drive.ts`'s 404→`not_found` promotion)
 * branches on THIS numeric field, never on `detail`'s string shape (§S — a prior
 * round matched `detail === "HTTP 404"` and silently broke when the format
 * changed). Absent when no HTTP response was ever received (an SSRF-block, a
 * credential fault, a network-level outage) and when the response carried a
 * non-integer status — neither has a vendor status worth branching on.
 *
 * `faultDetail` — the CLOSED sub-reason for exactly those statusless faults (see
 * `TransportFaultDetail`). It is what an operator reads to tell a locked Keychain
 * apart from an SSRF-blocked host, both of which are `fault:"rejected"` with no
 * `httpStatus`. That reading only works where a transport SETS the field:
 * `createWriteHttpTransport` sets it at every one of its nine statusless fault
 * returns (eleven tokens — the credential-unavailable return fans out over the
 * three unavailability reasons), so for the real HTTP write path the distinction
 * holds; for any other transport it holds exactly as far as that transport
 * populates it. OPTIONAL by design — a transport that omits it renders exactly as
 * before the field existed. `detail` is unchanged and still never reaches
 * `AdapterError.message`.
 */
export type TransportResponse =
  | { readonly ok: true; readonly object: TransportObject | null; readonly deduped?: boolean }
  | {
      readonly ok: false;
      readonly fault: TransportFault;
      readonly detail: string;
      readonly httpStatus?: number;
      readonly faultDetail?: TransportFaultDetail;
    };

/**
 * The injected transport seam. ONE async fn drives all three ops. No real
 * network lives in the adapter module — the fake/real client is injected here.
 */
export type AdapterTransport = (req: AdapterTransportRequest) => Promise<TransportResponse>;
