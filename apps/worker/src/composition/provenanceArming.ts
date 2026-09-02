// @sow/worker — resolve the `provenanceServingOracle` bundle from what is ACTUALLY PROVISIONED.
//
// ⭐ THE POINT, in one line: **PROVISIONING IS THE ARMING ACT.** The owner provisions the Keychain
// item and drops the pin file; nothing else — no flag to flip afterwards, no code change, no second
// deliberate step. This resolver is what makes that true without making it UNSAFE.
//
// ⛔⛔ THE DEFECT IT EXISTS TO PREVENT, and it is why the host does not simply pass
// `keychainSecrets: {}` plus a bundle. `bootWorker` binds the signing dep on CONSTRUCTION:
//
//     const signing = provenanceBundle === undefined || resolvedSigningSecrets === undefined
//       ? undefined : { … }
//
// and `gateProposeArming` then reads precondition (3) as `signingKeyResolved: signing !== undefined`.
// ⇒ ***a field NAMED for resolution that actually measures CONSTRUCTION.*** Passing a Keychain gate
// and a bundle would report `signingKeyResolved: true` **with no key in the Keychain at all**, and
// the first anyone would learn of it is a provenance stamp failing at commit time — after propose
// had already been armed on the strength of it. (`contracts L118` — a proxy standing in for the
// property; the proxy is right almost always, and wrong exactly when the key is missing.)
//
// ⇒ **This resolver RESOLVES THE KEY BEFORE REPORTING ARMED**, which makes the precondition's name
// true and keeps the owner's provisioning act the only thing that arms.
//
// ⛔ RULE 7 — THE KEY IS PROOF-OF-RESOLUTION AND NOTHING ELSE. `resolveSigningKey` is called for its
// `Result`; the bytes are discarded at the point of check and appear on NEITHER outcome branch. The
// bundle carries the opaque `SecretRef` and the port, never key material. Pinned.
//
// ⭐ WHY A TYPED REASON RATHER THAN A BARE `undefined` (`worker L79`): four not-armed states are
// individually recoverable and an operator must know WHICH to fix — no Keychain gate wired, no pin
// file on disk, a pin that will not parse, or a key that does not resolve. Collapsing them to
// "not armed" leaves the owner guessing between four different remedies.
//
// ⚠ WHAT THIS DOES **NOT** DO, stated so a green here is not read as more than it is: arming the
// provenance bundle satisfies `gateProposeArming` preconditions (1), (3) and (5) ONLY. Precondition
// (4) `writeTransportArmed` needs a real external-write transport (Phase 21, a vendor credential),
// and (2) `proofSpineProvisioned` needs `autoIngest`. **Propose stays OFF until all five hold** —
// and separately, SERVING still withholds regardless, because two coverage legs (`oracleBuildOk`,
// `pinValid`) are structurally false today (`### 20.1`, `### 24.142`).
import { isErr, type GbrainPin } from "@sow/contracts";
import {
  parseGbrainPinFile,
  type RunningGbrainVersion,
  type SecretsPort,
  type SecretRef,
} from "@sow/knowledge";

/**
 * The KnowledgeWriter provenance-signing key's Keychain ref (task 20.1 / §ARM-17).
 *
 * ⛔ `service = sow`, `account = kw-signing`. RESOLVED 2026-08-29 against the two runbooks that said
 * `sow-provenance-signing/hmac-key`: three sources — the secret-ref convention module,
 * `ARCHITECTURE.md §19.4`, and `IMPLEMENTATION_PLAN.md` §ARM-17 — say `sow`/`kw-signing`, and both
 * runbooks are now aligned to it.
 * ⚠ NOTHING VALIDATES THIS AGAINST THE CONVENTION AT RUNTIME — `parseSecretRef` has ZERO callers —
 * so this ref and the provisioned item can drift silently, which is exactly how the two names
 * diverged in the first place. **If you provision a different pair, THIS CONSTANT MOVES WITH IT.**
 *
 * ⛔ THE VALUE MUST BE STORED AS PRINTABLE ASCII — BASE64 FOR THIS ONE. It is an HMAC key, i.e. the
 * binary case: `security find-generic-password -w` returns lowercase HEX for any non-printable byte
 * with NO marker, so a raw-binary key would stamp AND verify SELF-CONSISTENTLY with the wrong bytes
 * and break only on rotation. Measured 2026-08-28.
 *
 * ⭐ Lives HERE rather than in the desktop host so the convention has ONE home, beside the code that
 * consumes it (`contracts L39`) — and so the host needs no `@sow/knowledge` dependency to name it.
 */
export const KW_SIGNING_REF = "keychain://sow/kw-signing" as SecretRef;

/** The bundle `BootConfig.provenanceServingOracle` expects, built only when everything resolves. */
export interface ProvenanceServingOracleBundle {
  readonly secrets: SecretsPort;
  readonly signingKeyRef: SecretRef;
  readonly pin: GbrainPin;
  readonly resolveRunning?: () => RunningGbrainVersion | undefined;
}

/** Why the bundle did not arm. Each member is a DIFFERENT owner remedy — never collapse them. */
export type ProvenanceNotArmedReason =
  | "no_secrets_gate"
  | "no_pin_file"
  | "pin_invalid"
  | "signing_key_unresolved";

export type ProvenanceArmingOutcome =
  | { readonly armed: true; readonly bundle: ProvenanceServingOracleBundle }
  | { readonly armed: false; readonly reason: ProvenanceNotArmedReason };

export interface ProvenanceArmingDeps {
  /** Pin-file text, or `undefined` when there is no pin file. MAY reject — handled. */
  readonly readPinText: () => Promise<string | undefined>;
  /** The real Keychain-backed port, or `undefined` when no Keychain gate is wired. */
  readonly secrets: SecretsPort | undefined;
  readonly signingKeyRef: SecretRef;
  readonly resolveRunning?: () => RunningGbrainVersion | undefined;
}

/**
 * Decide whether the provenance bundle is genuinely provisioned. TOTAL — never throws (§16): this
 * runs during host startup, where a throw takes the whole worker down, which is strictly worse than
 * declining to arm.
 */
export async function resolveProvenanceArming(
  deps: ProvenanceArmingDeps,
): Promise<ProvenanceArmingOutcome> {
  const secrets = deps.secrets;
  if (secrets === undefined) return { armed: false, reason: "no_secrets_gate" };

  let pinText: string | undefined;
  try {
    pinText = await deps.readPinText();
  } catch {
    // An unreadable pin file is indistinguishable from an absent one FOR THE ARMING DECISION —
    // both mean "no usable pin". The distinction would matter for diagnosis, and the host logs the
    // reason; it does not change what we do here.
    return { armed: false, reason: "no_pin_file" };
  }
  if (pinText === undefined) return { armed: false, reason: "no_pin_file" };

  const parsed = parseGbrainPinFile(pinText);
  if (isErr(parsed)) return { armed: false, reason: "pin_invalid" };

  // ⛔ THE LOAD-BEARING CALL. Everything above is cheap and local; this is the one that proves the
  // owner actually provisioned the Keychain item. Its VALUE is deliberately not bound to a name —
  // we need the Result's shape and nothing else (rule 7).
  try {
    const resolved = await secrets.resolveSigningKey(deps.signingKeyRef);
    if (isErr(resolved)) return { armed: false, reason: "signing_key_unresolved" };
  } catch {
    // A SecretsPort is contractually never-throwing, but this is a trust boundary and a throwing
    // implementation must degrade rather than crash boot (`worker L21`/`L29`).
    return { armed: false, reason: "signing_key_unresolved" };
  }

  return {
    armed: true,
    bundle: {
      secrets,
      signingKeyRef: deps.signingKeyRef,
      pin: parsed.value,
      ...(deps.resolveRunning !== undefined ? { resolveRunning: deps.resolveRunning } : {}),
    },
  };
}

/** Operator-facing, redaction-safe (a closed reason token — never a value, never a ref). */
export function describeProvenanceArming(outcome: ProvenanceArmingOutcome): string {
  if (outcome.armed) return "provenance: ARMED (pin parsed, signing key resolved)";
  const fix: Record<ProvenanceNotArmedReason, string> = {
    no_secrets_gate: "no Keychain gate wired",
    no_pin_file: "no readable config/gbrain.pin",
    pin_invalid: "config/gbrain.pin did not parse",
    signing_key_unresolved: "the signing key did not resolve from the Keychain",
  };
  return `provenance: NOT ARMED (${outcome.reason} — ${fix[outcome.reason]})`;
}
