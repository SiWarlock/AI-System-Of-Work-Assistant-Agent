// 10.5(b) — Keychain-locked / denied as a FIRST-CLASS degraded state (LIFE-6,
// §16, 10.2 taxonomy + 10.3 surface, safety rules 3 & 7 adjacent). NOT an ad-hoc
// exception.
//
// When the macOS Keychain is locked (or a SecretsPort read is denied) the worker
// cannot resolve a provider/connector secret, so any job that needs that secret
// cannot run. The naive failure mode is to FAIL the job terminally — losing the
// work. This controller makes the lock a first-class, typed, recoverable state:
//
//   • onKeychainLocked — marks the affected provider/connector DEGRADED (via the
//     injected ProviderDegradationStore; ProviderProfile/connector state is the
//     integrator's real backing) and surfaces a DISTINCT `worker_down` System-
//     Health item (class taken from the 10.2 `routeFailure(degraded_unavailable)`
//     mapping, never invented).
//   • holdJob — HOLDS a dependent job as RETRYABLE — the 10.2 route for
//     `degraded_unavailable` is `retryable: true`, so a held job is explicitly
//     NOT `failed_terminal`. It stays in the held set until unlock; no work lost.
//   • onUnlock — wired to the LIFE-6 wake/power hook: re-attempts the held work by
//     draining the §8 write-outbox through the injected `wakeDrain` (which the
//     integrator binds to `runWakeDrain` / `drainOutbox`). Because the drain re-
//     drives every held entry through the Tool-Gateway existence-check + stored-
//     receipt replay gate, a lock-interrupted external write whose receipt already
//     landed returns `reused` (adapter.create is NEVER called again) — so the
//     re-attempt is IDEMPOTENT with ZERO duplicate side effect (safety rule 3).
//     On success the provider clears DEGRADED and the health item resolves.
//
// §16: never throws across the boundary. Every method returns a typed
// Result<T, DegradedModeError>; a health-surface persist fault folds to a typed
// err (fail-closed), never a throw. The re-attempt path never DISCARDS a held job
// — a still-held drain entry stays re-held by the drain itself (bumped backoff).
//
// WIRING (integrator step, NOT this module): the bootstrap binds
// `degradationStore` to the real ProviderProfile/connector state, and `wakeDrain`
// to `runWakeDrain(event, { outbox, drainDeps })` (the LIFE-6 hook over the §8
// drain). This module stays effect-injected + Vitest-unit-testable with fakes.

import { ok, err, failure } from "@sow/contracts";
import type { AuditId, HealthItem, ProviderId, Result } from "@sow/contracts";
import { routeFailure } from "@sow/domain";
import type { DrainResult } from "@sow/integrations";
import type { WakeReason } from "@sow/workflows";
import type { HealthSurface, HealthSurfaceError } from "../../health/surface";
import type { DegradedModeError } from "./temporal-unavailable";

/**
 * The port over the provider/connector DEGRADED state the integrator binds to the
 * real ProviderProfile / connector-state backing. Keyed by ProviderId — a locked
 * secret degrades exactly the provider(s)/connector(s) that need it. Idempotent:
 * marking an already-degraded provider is a no-op; clearing a healthy one is too.
 */
export interface ProviderDegradationStore {
  markDegraded(provider: ProviderId): Promise<void>;
  clearDegraded(provider: ProviderId): Promise<void>;
  isDegraded(provider: ProviderId): Promise<boolean>;
}

/** A Keychain-lock event scoped to the provider whose secret is unavailable. */
export interface KeychainLockedInput {
  /** The provider/connector whose secret cannot be resolved (the degraded subject). */
  readonly subjectRef: ProviderId;
  /** Injected wall-clock reading (ISO-8601) — never Date.now(). */
  readonly now: string;
}

/** The typed outcome of a Keychain-lock report. */
export interface KeychainLockedOutcome {
  /** The surfaced DISTINCT worker_down health item. */
  readonly healthItem: HealthItem;
  /** The provider marked degraded. */
  readonly degradedProvider: ProviderId;
}

/** 18.16/CP-6 — the outcome of surfacing a credential-unavailable (un-provisioned/unresolvable) item. */
export interface CredentialUnavailableOutcome {
  /** The surfaced DISTINCT credential-unavailable health item (observability only; not a lock). */
  readonly healthItem: HealthItem;
}

/** Which provider a held job depends on (so unlock knows what it was waiting on). */
export interface HoldJobInput {
  readonly subjectRef: ProviderId;
}

/** The disposition of a held job while the Keychain is locked. */
export type KeychainHoldDisposition = "held_retryable";

/** The typed outcome of holding a dependent job. */
export interface HoldJobOutcome {
  readonly disposition: KeychainHoldDisposition;
  /** ALWAYS true — a Keychain-held job is retryable, NEVER failed_terminal. */
  readonly retryable: boolean;
}

/** A LIFE-6 unlock/wake event (mirrors the wakeHooks WakeEvent shape). */
export interface KeychainUnlockInput {
  readonly reason: WakeReason;
  /** Injected wall-clock reading (ISO-8601) — never Date.now(). */
  readonly now: string;
}

/** The typed outcome of an unlock — the re-attempt drain counts + resume total. */
export interface KeychainUnlockOutcome {
  /** The §8 outbox-drain counts (reused ⇒ zero duplicate external write). */
  readonly drain: DrainResult;
  /** How many held jobs were released for re-attempt. */
  readonly releasedCount: number;
}

/** Injected effects for the controller (all fakeable; no Date.now(), no net). */
export interface KeychainLockDeps {
  /** The persistent System-Health surface (10.3). */
  readonly surface: HealthSurface;
  /** The provider/connector DEGRADED-state store. */
  readonly degradationStore: ProviderDegradationStore;
  /** The audit ref anchoring the surfaced health item. */
  readonly auditRef: AuditId;
  /**
   * The LIFE-6 wake drain — the integrator binds it to
   * `runWakeDrain({ reason, now }, { outbox, drainDeps })`. It re-drives the held
   * §8 outbox IDEMPOTENTLY (existence-check + stored-receipt replay gate → a
   * committed entry returns `reused`, never a duplicate create).
   */
  readonly wakeDrain: (event: KeychainUnlockInput) => Promise<DrainResult>;
}

/** The Keychain-lock degraded-mode controller (10.5(b)). */
export interface KeychainLockController {
  /** Report a Keychain lock: mark the provider degraded + surface the item. */
  onKeychainLocked(
    input: KeychainLockedInput,
  ): Promise<Result<KeychainLockedOutcome, DegradedModeError>>;
  /** 18.16/CP-6: surface a DISTINCT credential-unavailable item (un-provisioned/unresolvable secret) —
   *  observability for an otherwise-SILENT fail-closed HOLD; NOT a keychain lock (L41). Never throws. */
  onCredentialUnavailable(
    input: KeychainLockedInput,
  ): Promise<Result<CredentialUnavailableOutcome, DegradedModeError>>;
  /** Hold a dependent job as RETRYABLE (never terminal — no work lost). */
  holdJob(
    jobId: string,
    input: HoldJobInput,
  ): Promise<Result<HoldJobOutcome, DegradedModeError>>;
  /** Unlock (LIFE-6): re-attempt held work via the §8 drain (idempotent); clear. */
  onUnlock(
    input: KeychainUnlockInput,
  ): Promise<Result<KeychainUnlockOutcome, DegradedModeError>>;
  /** Inspect the held-job set (queued work never discarded). */
  heldJobs(): readonly string[];
}

/** Map a HealthSurfaceError into the shared degraded-mode error set (§16). */
function mapSurfaceError(e: HealthSurfaceError): DegradedModeError {
  return { code: "health_persist_failed", message: e.message, cause: e.cause };
}

/**
 * Build the Keychain-lock controller. Stateful (holds the degraded provider set +
 * the held-job set), effect-injected, never throws across the boundary (§16).
 */
export function createKeychainLockController(
  deps: KeychainLockDeps,
): KeychainLockController {
  const { surface, degradationStore, auditRef, wakeDrain } = deps;

  // The 10.2 route for a Keychain lock: degraded_unavailable → retryable + the
  // worker_down health class. Taken from HERE so the taxonomy is single-sourced;
  // `retryable` is what makes a held job explicitly NON-terminal.
  const route = routeFailure(failure("degraded_unavailable", "keychain locked", { retryable: true }));
  const healthClass = route.healthClass ?? "worker_down";
  const retryable = route.retryable;

  // The degraded provider(s) whose secret is unavailable, and the jobs held on
  // them. Both persist across the lock window so nothing is lost before unlock.
  const degradedProviders = new Set<ProviderId>();
  const held = new Map<string, ProviderId>();

  // A stable subjectRef per provider so a recurring lock bumps ONE deduped item.
  const subjectRefOf = (p: ProviderId): string => `keychain:${p}`;
  // 18.16/CP-6: a DISTINCT subjectRef prefix so a credential-unavailable item NEVER dedupe-collides with a
  // keychain LOCK under the §10.3 (failureClass, subjectRef) identity (both reuse the worker_down class).
  const credentialSubjectRefOf = (p: ProviderId): string => `credential:${p}`;

  return {
    async onKeychainLocked(
      input: KeychainLockedInput,
    ): Promise<Result<KeychainLockedOutcome, DegradedModeError>> {
      // Mark the provider/connector DEGRADED (ProviderProfile/connector state).
      await degradationStore.markDegraded(input.subjectRef);
      degradedProviders.add(input.subjectRef);

      const message =
        `Keychain locked/denied for provider '${input.subjectRef}' — the secret ` +
        "cannot be resolved; dependent jobs are held (retryable) and re-attempt on unlock.";
      const recorded = await surface.record({
        failureClass: healthClass,
        subjectRef: subjectRefOf(input.subjectRef),
        message,
        auditRef,
        now: input.now,
      });
      if (!recorded.ok) return err(mapSurfaceError(recorded.error));

      return ok({ healthItem: recorded.value.item, degradedProvider: input.subjectRef });
    },

    async onCredentialUnavailable(
      input: KeychainLockedInput,
    ): Promise<Result<CredentialUnavailableOutcome, DegradedModeError>> {
      // OBSERVABILITY ONLY (18.16/CP-6): surface a DISTINCT credential-unavailable item so an un-provisioned /
      // unresolvable credential is no longer a SILENT fail-closed HOLD. Reuses the worker_down FailureClass
      // (L25 — no frozen-taxonomy expansion) but a DISTINCT `credential:` subjectRef (never collides with a
      // LOCK under §10.3) + a GENERIC message (NOT a lock — L41). Deliberately does NOT mark the provider
      // degraded / hold jobs: the accessor's fail-closed Err drives the HOLD; this is purely additive audit/
      // health. Value-free (rule 7): only subjectRef (a provider id) + now cross in — never the key or raw ref.
      const message =
        `Credential unavailable for provider '${input.subjectRef}' — could not be resolved; ` +
        "verify the credential is provisioned. Dependent jobs are held (retryable).";
      const recorded = await surface.record({
        failureClass: healthClass,
        subjectRef: credentialSubjectRefOf(input.subjectRef),
        message,
        auditRef,
        now: input.now,
      });
      if (!recorded.ok) return err(mapSurfaceError(recorded.error));

      return ok({ healthItem: recorded.value.item });
    },

    holdJob(
      jobId: string,
      input: HoldJobInput,
    ): Promise<Result<HoldJobOutcome, DegradedModeError>> {
      // HOLD as RETRYABLE — never failed_terminal. The route's `retryable` is the
      // load-bearing guarantee: no work is lost, the job re-attempts on unlock.
      held.set(jobId, input.subjectRef);
      return Promise.resolve(ok({ disposition: "held_retryable" as const, retryable }));
    },

    async onUnlock(
      input: KeychainUnlockInput,
    ): Promise<Result<KeychainUnlockOutcome, DegradedModeError>> {
      // Re-attempt held work by draining the §8 outbox through the LIFE-6 wake
      // hook. IDEMPOTENT by construction: a committed entry returns `reused`
      // (adapter.create never re-fires → zero duplicate side effect). The drain
      // itself re-holds any still-unreachable entry — this controller never
      // discards a held entry.
      const drain = await wakeDrain(input);

      // Clear DEGRADED on every provider we degraded, and resolve their items.
      const releasedCount = held.size;
      for (const provider of degradedProviders) {
        await degradationStore.clearDegraded(provider);
        const resolved = await surface.resolve({
          failureClass: healthClass,
          subjectRef: subjectRefOf(provider),
          now: input.now,
        });
        if (!resolved.ok) return err(mapSurfaceError(resolved.error));
      }
      degradedProviders.clear();
      held.clear();

      return ok({ drain, releasedCount });
    },

    heldJobs(): readonly string[] {
      return [...held.keys()];
    },
  };
}
