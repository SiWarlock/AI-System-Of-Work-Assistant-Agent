// Task 17.4 — the secret-ref CONVENTION over the existing `keychain://<service>/<account>` format (17.1/17.2). A
// typed KIND namespace + build/parse so EVERY downstream seam resolves ONE `getSecret` facade with a stable, single-
// sourced ref convention: the KW HMAC signing key, cloud model-provider keys, the embeddings key, per-vendor
// connector READ (Phase 23) + WRITE (Phase 21) tokens, and the Telegram bot token (21.8/23.6).
//
// SAFE BUILD — this is the ref namespace + build/parse ONLY. NO secret material flows through it (it manipulates ref
// STRINGS); the real per-vendor/per-provider PROVISIONING happens at each vendor's own owner-confirmed crossing.
//
// TRAVERSAL-SAFE BY CONSTRUCTION (L5): `buildSecretRef` composes a (service, account) then round-trip-validates it
// through the adapter's `parseKeychainRef` — the SAME single-sourced charset/segment guard the resolver uses (no
// duplicated literal that could drift and re-open the ref-injection surface, L37). A hostile vendor/account that
// contains a separator / traversal token / whitespace fails closed to `null` — it can NEVER smuggle a second
// segment or a different service (kind). Unknown/malformed refs parse to `null` (fail-closed, 0 backend calls, L9).
import type { SecretRef } from "@sow/knowledge";
import { parseKeychainRef, SCHEME } from "./keychain-adapter";

/**
 * The cloud model-provider keys stored at `keychain://providers/<providerId>`. The values MIRROR the canonical
 * `ProviderId` enum's cloud (egress) subset — `claude` (Anthropic), `openai`, `openrouter` — so Phase-18's
 * ModelProvider composes the ref DIRECTLY from its `providerId` with NO translation layer (a translation layer on
 * the credential path is a drift/bug vector). `ollama`/`lm_studio` are local/non-egress ⇒ NO key ⇒ excluded.
 */
export const KNOWN_PROVIDERS = ["claude", "openai", "openrouter"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/**
 * The embeddings keys stored at `keychain://embeddings/<provider>`. Distinct from model providers — `voyage` is the
 * gbrain embeddings key (`VOYAGE_API_KEY`), NOT a `ModelProviderPort` provider, so it gets its own kind rather than
 * a semantic lie under `providers/`.
 */
export const KNOWN_EMBEDDINGS = ["voyage"] as const;
export type KnownEmbeddings = (typeof KNOWN_EMBEDDINGS)[number];

/** The typed secret kinds the convention covers. `provider`/`embeddings` carry a closed-set member; `connector-*`
 *  carry an open per-vendor id (charset-validated at build); `hmac`/`telegram-bot` are singletons (fixed refs). */
export type SecretRefSpec =
  | { readonly kind: "provider"; readonly provider: KnownProvider }
  | { readonly kind: "embeddings"; readonly provider: KnownEmbeddings }
  | { readonly kind: "hmac" }
  | { readonly kind: "connector-read"; readonly vendor: string }
  | { readonly kind: "connector-write"; readonly vendor: string }
  | { readonly kind: "telegram-bot" };

// The `<service>` segment per kind (the account is the member, the fixed singleton account, or the vendor).
const PROVIDERS_SERVICE = "providers";
const EMBEDDINGS_SERVICE = "embeddings";
const CONNECTOR_READ_SERVICE = "connector-read";
const CONNECTOR_WRITE_SERVICE = "connector-write";
// Singleton kinds — a FIXED (service, account).
const HMAC_SERVICE = "sow";
const HMAC_ACCOUNT = "kw-signing";
const TELEGRAM_SERVICE = "telegram-bot";
const TELEGRAM_ACCOUNT = "token";

/**
 * Compose a validated `keychain://<service>/<account>` ref, or `null` if EITHER segment isn't traversal-safe.
 * Traversal-safe BY CONSTRUCTION: build the string with the single-sourced `SCHEME`, then require it to
 * round-trip through `parseKeychainRef` back to the EXACT (service, account) — so an injected separator / traversal
 * token / whitespace / empty component (which the parse rejects or re-splits) yields `null`, never a smuggled ref.
 */
function composeRef(service: string, account: string): SecretRef | null {
  const ref = `${SCHEME}${service}/${account}`;
  const parsed = parseKeychainRef(ref);
  if (parsed === null || parsed.service !== service || parsed.account !== account) return null;
  return ref;
}

const isKnownProvider = (account: string): account is KnownProvider =>
  (KNOWN_PROVIDERS as readonly string[]).includes(account);
const isKnownEmbeddings = (account: string): account is KnownEmbeddings =>
  (KNOWN_EMBEDDINGS as readonly string[]).includes(account);

/**
 * Build the stable Keychain ref for a secret kind, or `null` when a component isn't safe. Fails closed SYMMETRIC
 * with `parseSecretRef` at RUNTIME (not only via the compile-time type): a `provider`/`embeddings` member outside
 * its closed set (an `as`-cast bypass — e.g. a local/no-key ProviderId), a traversal-unsafe connector vendor, or a
 * rogue `kind` (the `default`) ⇒ `null`, never a ref for a rogue/no-key entry. NO secret material — only the string.
 */
export function buildSecretRef(spec: SecretRefSpec): SecretRef | null {
  switch (spec.kind) {
    case "provider":
      return isKnownProvider(spec.provider) ? composeRef(PROVIDERS_SERVICE, spec.provider) : null;
    case "embeddings":
      return isKnownEmbeddings(spec.provider) ? composeRef(EMBEDDINGS_SERVICE, spec.provider) : null;
    case "hmac":
      return composeRef(HMAC_SERVICE, HMAC_ACCOUNT);
    case "connector-read":
      return composeRef(CONNECTOR_READ_SERVICE, spec.vendor);
    case "connector-write":
      return composeRef(CONNECTOR_WRITE_SERVICE, spec.vendor);
    case "telegram-bot":
      return composeRef(TELEGRAM_SERVICE, TELEGRAM_ACCOUNT);
    default: {
      // Exhaustive at compile time (TS errors if a new kind is added without a case); a runtime `as`-cast rogue
      // kind that bypasses the type fails closed to `null` rather than falling through to `undefined`.
      const _exhaustive: never = spec;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Parse a ref back into its typed kind, or `null` — fail-closed on a malformed ref (0 backend calls, L9), an
 * unknown service (unknown kind), a provider/embeddings account outside its closed set, or a singleton with the
 * wrong account. The kind is determined SOLELY by the `<service>` segment (which a single account/vendor component
 * can never alter — `/` is barred in a segment), so a vendor can't smuggle a different kind (L5).
 */
export function parseSecretRef(ref: string): SecretRefSpec | null {
  const parsed = parseKeychainRef(ref);
  if (parsed === null) return null;
  const { service, account } = parsed;
  switch (service) {
    case PROVIDERS_SERVICE:
      return isKnownProvider(account) ? { kind: "provider", provider: account } : null;
    case EMBEDDINGS_SERVICE:
      return isKnownEmbeddings(account) ? { kind: "embeddings", provider: account } : null;
    case HMAC_SERVICE:
      return account === HMAC_ACCOUNT ? { kind: "hmac" } : null;
    case CONNECTOR_READ_SERVICE:
      return { kind: "connector-read", vendor: account };
    case CONNECTOR_WRITE_SERVICE:
      return { kind: "connector-write", vendor: account };
    case TELEGRAM_SERVICE:
      return account === TELEGRAM_ACCOUNT ? { kind: "telegram-bot" } : null;
    default:
      return null; // unknown service ⇒ unknown kind ⇒ fail-closed
  }
}
