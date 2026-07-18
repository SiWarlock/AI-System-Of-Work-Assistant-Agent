// 18.23 step 4 — the AND-locked `selectExtractionRoute` route knob (staged ENABLE; DORMANT).
//
// The default-OFF route switch for the extraction capability: the SHIPPED default (unarmed) is the
// byte-identical loopback-local ollama route (= boot.ts:1094 capabilityDefaults["source.process"]); the
// ARMED path (owner step-6 flip) is the cloud `{runtime:"claude-agent-sdk"}` subscription route. Mirrors
// `selectProviderRunner`/L23 — STRICT `=== true` so a truthy-not-`true` value never arms (L28).
//
// AND-LOCKED (L52 — one flip, no split-brain): boot derives `armed` from the SAME gate predicate
// `selectProviderRunner` reads (`providerTransport.enabled === true && typeof make === "function"`), so the
// owner's single step-6 flip arms the run leg AND the route together — the route can never arm while the
// transport stays stub (or vice-versa). The ARMED cloud route re-triggers the §5 egress veto for
// employer-raw jobs (verified fail-closed in egress-veto-assembled.test.ts — rule 5).
//
// Reachability-WAIVERED (L11): NO production caller this slice — boot binds this at the owner ENABLE
// (step 6, HARD STOP). Building the knob crosses no hard line; the shipped default `capabilityDefaults`
// (boot.ts:1094) is untouched ⇒ byte-equivalent.
import type { ProviderRoute } from "@sow/contracts";

/**
 * The owner-configured extraction model for the cloud subscription route (Sonnet 5, the Option-B choice).
 * ⚠ RE-CONFIRM the exact id against the live Anthropic / Agent-SDK catalog at the flip (a stale id folds to
 * a typed CompletionError, the safe failure — never a silent wrong answer).
 */
export const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-5" as const;

/**
 * The SHIPPED default (unarmed) extraction route — byte-identical to boot.ts:1094 `source.process` (and to
 * `source-extraction.ts` `DEFAULT_ROUTE`). ⚠ TRANSCRIPTION-DRIFT (L37/L55): this is currently a hand-copy;
 * the shipped route is not exported, so nothing cross-checks them today. The drift is INACTIVE while this
 * knob is unwired (boot still uses its own inline literal). #13 ENABLE precondition: when boot binds
 * `selectExtractionRoute(false)` into `capabilityDefaults`, SINGLE-SOURCE this constant with boot.ts:1094 +
 * `DEFAULT_ROUTE` (one literal, L37) so they can never drift.
 */
export const LOCAL_EXTRACTION_ROUTE: ProviderRoute = Object.freeze({
  provider: "ollama",
  model: "local-default",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
}) as unknown as ProviderRoute;

/** The ARMED cloud `{runtime}` subscription route (owner step-6 flip) — egresses to the Anthropic
 *  subscription; the §5 egress veto re-triggers for employer-raw jobs (rule 5, verified). */
export const CLOUD_EXTRACTION_ROUTE: ProviderRoute = Object.freeze({
  runtime: "claude-agent-sdk",
  model: DEFAULT_EXTRACTION_MODEL,
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
}) as unknown as ProviderRoute;

/**
 * Select the extraction route, honouring the default-OFF arming. STRICT `=== true`: `armed` any value but
 * literal `true` ⇒ the shipped LOCAL route (never arms — L28). Pure; returns a frozen shared constant.
 */
export function selectExtractionRoute(armed: boolean): ProviderRoute {
  return armed === true ? CLOUD_EXTRACTION_ROUTE : LOCAL_EXTRACTION_ROUTE;
}
