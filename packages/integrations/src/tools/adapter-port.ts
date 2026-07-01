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
 * `unknown` — an unclassified fault. `message` is a redaction-safe diagnostic.
 */
export interface AdapterError {
  readonly code: "unreachable" | "conflict" | "rejected" | "unknown";
  readonly message: string;
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
