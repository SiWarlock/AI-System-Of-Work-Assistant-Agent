// @sow/integrations — the §8 Tool-Gateway target-write adapter PORT.
//
// The interface the per-vendor write adapters (slice 6.4: calendar / todoist /
// linear / asana / drive / github / telegram) implement. The Tool Gateway
// (gateway.ts) is the ONLY caller — safety invariant 1: NO create/update happens
// without an ExternalWriteEnvelope + a passing candidate-gate, and every create
// is preceded by the mandatory pre-write existence check (safety invariant 2).
//
// §16 ERROR CONVENTION: an adapter NEVER throws across this boundary — every
// method returns a typed `Result<T, AdapterError>` with an ENUMERABLE closed
// failure set (`AdapterError.code`). A transport/vendor fault is a typed
// `unreachable`/`conflict`/`rejected`/`unknown`, never an exception. The adapter
// takes injected transport deps (no real network in the module); tests inject
// fakes.
import type {
  Result,
  TargetSystem,
  WriteReceipt,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import type { TransportFaultDetail } from "./adapters/transport";

/**
 * A vendor object that already exists for a given `canonicalObjectKey` — the
 * result of a live `existenceCheck` hit. `externalObjectId` is the vendor
 * identity (reused, NEVER a second create). `externalUrl` / `rawRef` are
 * redaction-safe pointers (never raw content/secrets inline, safety rule 7).
 */
export interface ExistingObject {
  readonly externalObjectId: string;
  readonly externalUrl?: string;
  readonly rawRef?: string;
}

/**
 * The closed, enumerable adapter failure set (§16). `unreachable` — the write
 * could not be delivered NOW but may succeed LATER (the outbox-hold signal for
 * 6.5, and the ONLY retryable code). Its membership is defined by that
 * disposition, not by whether a packet arrived: a network outage, a 5xx, and a
 * vendor that explicitly said "later" (408/425/429 — write-http-transport.ts's
 * `RETRYABLE_4XX`) are all `unreachable`. `conflict` — the vendor rejected the
 * write on a precondition/version clash (NEVER a blind overwrite). `rejected` —
 * the vendor refused and re-sending the same bytes cannot help (auth,
 * validation, an SSRF-blocked host, an unresolvable write credential); TERMINAL.
 * `not_found` — the target object (or its containing scope, e.g. a Drive
 * folder) does not exist / is unlinked at the vendor. This is a PER-OBJECT
 * signal, distinct from `unreachable` (the transport could not reach the
 * vendor AT ALL) — a caller must NOT treat `not_found` as an outbox-hold
 * candidate (that is `unreachable`'s job); it means "re-add/re-link this one
 * object", never "retry later". `unknown` — an unclassified fault.
 *
 * That `not_found` rule is now TRUE OF THE ONLY CALLER, not merely asserted at
 * it. Both of the Tool Gateway's adapter-fault arms — the existence-probe arm
 * and the create arm (gateway.ts) — run the SAME closed switch over this `code`,
 * and only `unreachable` maps to `{status:'held'}`, the outbox-hold signal.
 * Until this round the existence-probe arm mapped EVERY code to `held`, so a
 * `not_found` from a live probe was handed to `outbox-drain.ts` — whose
 * `computeNextAttemptAt` deliberately never expires an entry — and re-held
 * forever: literally "retry later", the one disposition this paragraph forbids.
 *
 * `message` is a REQUIRED, redaction-safe diagnostic — not an optional nicety.
 * The Tool Gateway (gateway.ts) forwards this string into `ExternalWriteResult
 * .reason` VERBATIM (see that type's doc comment): it does NOT re-sanitize it,
 * because sanitizing vendor-originated text is THIS boundary's job, the one
 * place raw vendor content enters the system. CONSEQUENCE of violating this:
 * the message crosses the Tool Gateway unchanged, rides `ExternalWriteResult
 * .reason` across a Temporal activity boundary into durable, replayed workflow
 * history (ARCHITECTURE.md:155/157), and is read verbatim by a human operator
 * — an adapter that embeds raw vendor/secret text here leaks it for every
 * caller of that adapter, not just this one call.
 *
 * THIS IS NOW ENFORCED BY CONSTRUCTION for every adapter built via
 * `makeTargetWriteAdapter` (adapter-core.ts — every shipped vendor adapter:
 * calendar/todoist/linear/asana/drive/github/telegram, verified 2026-08-27):
 * its `faultToError` builds `message` ONLY from THREE closed inputs — the
 * `fault` code, the structured `httpStatus` below, and the closed
 * `faultDetail` token below (transport.ts's `TransportFaultDetail`, a
 * module-local literal union). It never reads a transport's free-text
 * `detail`, so a misbehaving transport (a bad per-vendor `mapResponse`, a test
 * fake) cannot get arbitrary text into `message` even by accident: it can
 * SELECT a `faultDetail` token, never author one. Do not overclaim beyond that
 * mechanism: `TargetWriteAdapter` is a plain interface, so a hand-written
 * implementation that bypasses `makeTargetWriteAdapter` could still construct
 * an `AdapterError` with an unsafe `message` directly — the guarantee holds
 * for adapters built on the shared core, not for the type alone.
 *
 * `httpStatus` — the vendor's HTTP status code, when the fault came from an
 * actual HTTP response (§S), as a real optional field. This is the field a
 * caller must branch machine logic on (e.g. `drive.ts`'s 404→`not_found`
 * promotion) — NEVER `message`'s prose. A prior round matched
 * `message === "HTTP 404"` and silently broke the first time the message
 * format changed; a typed field cannot drift out from under a string match
 * the same way.
 *
 * `faultDetail` — the closed sub-reason for a STATUSLESS fault (one with no
 * usable `httpStatus`, because no HTTP response arrived or its status was not an
 * integer): an SSRF/allowlist block, a missing/locked/denied/empty write
 * credential, a throwing credential accessor, a network-level outage, a throwing
 * `buildRequest`, a non-integer status, a malformed body, a throwing
 * `mapResponse`.
 *
 * It is what separates the SIX statusless failures that all carry
 * `code:"rejected"` (the SSRF block, the throwing accessor, and the four
 * credential reasons) and would otherwise render one identical sentence — and
 * likewise the four that share `code:"unknown"`. STATE THAT PRECISELY: the
 * separation is a property of the TRANSPORT that fills the field, not of this
 * type. `createWriteHttpTransport` sets it at every one of its NINE statusless
 * fault returns — which yield ELEVEN distinct tokens, the credential-unavailable
 * return fanning out over its three reasons — so on the real HTTP write path a
 * locked Keychain and an SSRF-blocked host do not read alike (pinned end-to-end
 * by write-http-transport.test.ts).
 * A transport that omits it — a test fake, a hand-rolled per-vendor
 * `mapResponse` — renders as it did before the field existed, and this comment
 * claims nothing about it.
 *
 * It rides its own field for exactly the reason `httpStatus` does: `message`
 * embeds the token as prose for a human, and a caller that must BRANCH reads
 * the field instead of parsing that prose. Present only when the transport
 * supplied one.
 */
export interface AdapterError {
  readonly code: "unreachable" | "conflict" | "rejected" | "unknown" | "not_found";
  readonly message: string;
  readonly httpStatus?: number;
  readonly faultDetail?: TransportFaultDetail;
}

/**
 * The per-vendor external-write adapter port (implemented by slice 6.4). Every
 * method is async + returns a typed `Result` (never throws). `existenceCheck`
 * powers the mandatory pre-write existence probe; `create` / `update` perform
 * the actual external side effect and return a `WriteReceipt` proof-of-write.
 */
export interface TargetWriteAdapter {
  readonly targetSystem: TargetSystem;
  existenceCheck(
    canonicalObjectKey: string,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ExistingObject | null, AdapterError>>;
  create(
    env: ExternalWriteEnvelope,
    payload: Record<string, unknown>,
  ): Promise<Result<WriteReceipt, AdapterError>>;
  update(
    env: ExternalWriteEnvelope,
    payload: Record<string, unknown>,
    expectedPrecondition?: string,
  ): Promise<Result<WriteReceipt, AdapterError>>;
}
