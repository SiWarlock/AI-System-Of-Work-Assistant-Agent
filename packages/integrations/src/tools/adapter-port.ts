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
 * The closed, enumerable adapter failure set (§16). `unreachable` — transport
 * could not reach the vendor (the outbox-hold signal for 6.5). `conflict` — the
 * vendor rejected the write on a precondition/version clash (NEVER a blind
 * overwrite). `rejected` — the vendor refused the request (validation/auth).
 * `not_found` — the target object (or its containing scope, e.g. a Drive
 * folder) does not exist / is unlinked at the vendor. This is a PER-OBJECT
 * signal, distinct from `unreachable` (the transport could not reach the
 * vendor AT ALL) — a caller must NOT treat `not_found` as an outbox-hold
 * candidate (that is `unreachable`'s job); it means "re-add/re-link this one
 * object", never "retry later". `unknown` — an unclassified fault.
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
 * its `faultToError` builds `message` ONLY from the closed `fault` code plus
 * the structured `httpStatus` below — it never reads a transport's free-text
 * `detail`, so a misbehaving transport (a bad per-vendor `mapResponse`, a test
 * fake) cannot get arbitrary text into `message` even by accident. Do not
 * overclaim beyond that mechanism: `TargetWriteAdapter` is a plain interface,
 * so a hand-written implementation that bypasses `makeTargetWriteAdapter`
 * could still construct an `AdapterError` with an unsafe `message` directly —
 * the guarantee holds for adapters built on the shared core, not for the type
 * alone.
 *
 * `httpStatus` — the vendor's HTTP status code, when the fault came from an
 * actual HTTP response (§S), as a real optional field. This is the field a
 * caller must branch machine logic on (e.g. `drive.ts`'s 404→`not_found`
 * promotion) — NEVER `message`'s prose. A prior round matched
 * `message === "HTTP 404"` and silently broke the first time the message
 * format changed; a typed field cannot drift out from under a string match
 * the same way.
 */
export interface AdapterError {
  readonly code: "unreachable" | "conflict" | "rejected" | "unknown" | "not_found";
  readonly message: string;
  readonly httpStatus?: number;
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
