// C5.4b Slice 3 — the go-live-seam boot assembly helpers. Two PURE functions `bootWorker` uses to construct
// the real `admitForServing`-backed serving oracle DORMANT behind THREE independent OFF-locks (each
// independently sufficient to keep propose OFF — see `selectServingOracleFactory`):
//   (1) the arming flag `copilotServingOracleGoLive` (default unset ⇒ `goLiveArmed` false),
//   (2) `loaderBacked === undefined` unless a signing key is provisioned (SecretsPort/Keychain = HITL/11.4),
//   (3) the real serving-coverage reader degrades by reality (no serve-time parity store) — arming ≠ trust.
// SAFETY-CRITICAL: the go-live seam of the whole propose path. Extracted here (pure, sync) so the go-live logic
// is unit-testable without booting the async `bootWorker`. DO NOT arm — the flip is the owner's hard-line event.
import {
  admitForServing,
  type VaultFs,
  type SecretsPort,
  type SecretRef,
} from "@sow/knowledge";
import { createServingGateOracle, type CopilotServingOracle } from "./copilotProvenanceStamp";
import { createServingContextLoader, type ServingCoverageReader } from "./servingContextLoader";
import { createCommittedVaultReader } from "./servingContextBootReaders";

/**
 * Build a WS-8 fail-closed workspace→vault resolver from a served-workspace map. A workspace maps to its OWN
 * VaultFs; an UNKNOWN/unmapped workspace ⇒ `undefined` (⇒ the loader degrades — NEVER a shared/default vault).
 * Today's single dev vault (`backends.vault`) is mapped under ONLY the single served workspace; an UNSET served
 * workspace ⇒ an EMPTY map ⇒ every workspace degrades. Per-workspace vault roots are the go-live shape.
 */
export function buildServedVaultResolver(
  roots: ReadonlyMap<string, VaultFs>,
): (workspaceId: string) => VaultFs | undefined {
  return (workspaceId: string): VaultFs | undefined => roots.get(workspaceId);
}

/** Inputs to {@link buildLoaderBackedServingOracle}. */
export interface LoaderBackedServingOracleDeps {
  /** The WS-8 fail-closed workspace→vault resolver (see {@link buildServedVaultResolver}). */
  readonly resolveVault: (workspaceId: string) => VaultFs | undefined;
  /** The serving-coverage reader — the REAL (degrades-by-reality) one in boot; a green one only in tests. */
  readonly readServingCoverage: ServingCoverageReader;
  /** The provisioned signing-key seam — ABSENT ⇒ the oracle is unconstructible (OFF-lock 2, structural). */
  readonly secrets: SecretsPort | undefined;
  readonly signingKeyRef: SecretRef | undefined;
}

/**
 * Construct the REAL loader-backed serving-oracle FACTORY — or `undefined` when no signing key is provisioned
 * (OFF-lock 2: the SecretsPort/Keychain is HITL/unbuilt, so absent today ⇒ `undefined` ⇒ the selector returns
 * the interim degraded oracle REGARDLESS of the arming flag; the flag alone can never arm). When constructed it
 * is STILL dormant unless `selectServingOracleFactory` is `goLiveArmed` (OFF-lock 1) AND the real coverage reader
 * reports green (OFF-lock 3 — degrades today, `parity===undefined`). Returns a FACTORY (not the oracle) so the
 * expensive fs-backed loader / committed-vault reader / gate are not built until the factory is actually
 * called — never on the dormant (interim-selected) path.
 */
export function buildLoaderBackedServingOracle(
  deps: LoaderBackedServingOracleDeps,
): (() => CopilotServingOracle) | undefined {
  const { secrets, signingKeyRef, resolveVault, readServingCoverage } = deps;
  if (secrets === undefined || signingKeyRef === undefined) return undefined; // OFF-lock 2 — structural
  return (): CopilotServingOracle =>
    createServingGateOracle({
      admitForServing,
      loadContext: createServingContextLoader({
        readCommittedVault: createCommittedVaultReader({ resolveVault }),
        readServingCoverage,
        secrets,
        signingKeyRef,
      }),
    });
}
