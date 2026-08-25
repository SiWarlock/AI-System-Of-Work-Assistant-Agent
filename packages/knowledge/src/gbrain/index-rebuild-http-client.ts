// The concrete IndexRebuildClient HTTP transport over `gbrain serve --http`'s wholesale-replace
// rebuild surface (§6/§13, task 19.7). Dormant arming-prep — makes the sole-issuer worker-side rebuild
// transport CONSTRUCTIBLE + fully unit-tested, still UNBOUND: no caller in
// apps/worker/src/composition/backends.ts binds this.
//
// It implements the `IndexRebuildClient.rebuildFromMarkdown` interface `rebuildIndexFromMarkdown`
// (rebuild.ts) consumes: reuses the read client's SSRF/allowlist + SecretsAccessor seams (same shapes,
// same guard order, same redacted fault type — Lesson 1) to resolve a bearer token → POST the derived
// fact set as a WHOLESALE replace → fold every outcome into a typed `IndexRebuildError`. NEVER throws
// across the boundary (§16) — matches the frozen `IndexRebuildClient` contract at rebuild.ts:61.
//
// SCRATCH-ONLY, never canonical (module header of rebuild.ts + safety rule 1): a rebuild is a wholesale
// REPLACE, not a merge, so it must never target the single-owner CANONICAL brain — that would let a
// concurrent reader observe a partially-replaced canonical index, and a failed rebuild would leave the
// canonical brain in an undefined state instead of leaving an isolated scratch brain to discard. This
// client therefore takes BOTH `scratchBrainId` (the rebuild's REQUIRED target) and `canonicalBrainId`
// (what it must never equal) as deps, and refuses — typed `rebuild_failed`, ZERO dispatch, before even
// the SSRF/allowlist guard — the moment they match.
//
// Honesty (rebuild.ts's own fail-closed legs depend on it): `nodeCount`/`replaced` in the returned
// receipt are relayed EXACTLY as the server reported them — never synthesized from `request.facts.length`
// or hardcoded `true`. `rebuildIndexFromMarkdown` compares the receipt's `nodeCount` against the
// derivable fact count and fails `incomplete_recovery` on a mismatch; a client that fabricated the count
// would silently defeat that check and turn a genuine partial rebuild into a false green.
//
// Safety posture (mirrors Lesson 1 / gbrain-http-read-client.ts):
//   • (0) canonical-target guard runs FIRST, before any network/secret concern.
//   • (1) SSRF/allowlist guard — an off-loopback or off-allowlist endpoint refuses with ZERO secret
//     reads and ZERO dispatch.
//   • (2) the bearer token resolves ONLY AFTER the guard passes; an unresolvable/throwing accessor
//     fails closed with ZERO dispatch.
//   • Every fault carries ONLY a redacted host ref / status number / secret-unavailable reason — never
//     a token, a URL, or fact/row content (rule 7).
//
// arch_gap (Lesson 21): the real `gbrain serve --http` wholesale-rebuild wire shape is OWNER-GATED, same
// as the read/apply clients. `REBUILD_PATH` + the request/response envelope below are a DOCUMENTED
// CANDIDATE, parsed fail-closed.
//
// DORMANT + reachability-waivered: no production caller. Do not bind this in apps/worker — that is a
// separate, owner-gated arming slice.
import { ok, err, isErr } from "@sow/contracts";
import type { Result, BrainId } from "@sow/contracts";
import { isLoopbackEndpoint, endpointHostRef } from "@sow/policy";
import { GbrainHttpTransportFault } from "./gbrain-http-read-client";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "./gbrain-http-read-client";
import type {
  IndexRebuildClient,
  IndexRebuildRequest,
  IndexRebuildReceipt,
  IndexRebuildError,
} from "./rebuild";

/** The injected deps for the HTTP rebuild transport. Mirrors `GbrainHttpReadClientDeps`'s
 *  transport/secrets/endpoint/allowlist shapes exactly, plus the two brain identifiers the
 *  scratch-only guard compares. */
export interface GbrainHttpIndexRebuildClientDeps {
  readonly transport: HttpTransport;
  readonly secrets: SecretsAccessor;
  /** The grant's Keychain reference handle — resolved via `secrets`, never inline. */
  readonly tokenRef: string;
  /** The loopback `gbrain serve --http` base URL (provisioned at arming; a fake string in tests). */
  readonly endpoint: string;
  /** The explicit endpoint allowlist (defense-in-depth over the loopback predicate). */
  readonly allowedEndpoints: readonly string[];
  /** REQUIRED: the SCRATCH brain this rebuild targets. Must differ from `canonicalBrainId` — a
   *  wholesale rebuild is never issued against the single-owner canonical brain. */
  readonly scratchBrainId: BrainId;
  /** The canonical brain this client refuses to target. */
  readonly canonicalBrainId: BrainId;
}

/** arch_gap (Lesson 21): candidate wholesale-rebuild path — confirmed at arming. */
const REBUILD_PATH = "/write/index-rebuild";

/** Strip a single trailing slash so `${endpoint}${path}` never doubles it (mirrors the read client). */
function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/** Fold a redacted transport fault into the frozen `IndexRebuildError` union. Endpoint/token/transport
 *  faults never reached the server (or the server never answered) ⇒ `gbrain_unavailable`; a non-2xx or
 *  a malformed/mis-shaped 2xx body ⇒ `rebuild_failed`. Exhaustive over `GbrainHttpTransportFaultCode`. */
function foldRebuildFault(fault: GbrainHttpTransportFault): IndexRebuildError {
  switch (fault.code) {
    case "endpoint_refused":
    case "token_unavailable":
    case "transport_throw":
      return { code: "gbrain_unavailable", message: fault.message, cause: fault };
    case "status_error":
    case "malformed_body":
      return { code: "rebuild_failed", message: fault.message, cause: fault };
  }
}

interface RebuildResponseBody {
  readonly nodeCount: number;
  readonly replaced: boolean;
}

/** Structural gate over the parsed 2xx body — a right-shaped-but-wrong-typed body (or a missing field)
 *  is treated exactly like a JSON parse failure: `rebuild_failed`, never a synthesized receipt. */
function isRebuildResponseBody(value: unknown): value is RebuildResponseBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.nodeCount === "number" && typeof candidate.replaced === "boolean";
}

/**
 * Build the concrete write-side HTTP wholesale-rebuild transport. DORMANT/unbound — the caller (owner
 * arming) supplies a real transport + Keychain SecretsAccessor + provisioned loopback endpoint + the
 * scratch/canonical brain identifiers. Structurally satisfies `IndexRebuildClient` (rebuild.ts:61).
 */
export function createGbrainHttpIndexRebuildClient(
  deps: GbrainHttpIndexRebuildClientDeps,
): IndexRebuildClient {
  const { transport, secrets, tokenRef, endpoint, allowedEndpoints, scratchBrainId, canonicalBrainId } =
    deps;
  const hostRef = endpointHostRef(endpoint);

  return {
    async rebuildFromMarkdown(
      request: IndexRebuildRequest,
    ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
      // (0) NEVER target the canonical brain — refused before ANY I/O: no endpoint check, no secret
      //     read, no dispatch. This is a local precondition, not a transport fault, so it is returned
      //     directly rather than routed through the redacted-fault fold below.
      if (scratchBrainId === canonicalBrainId) {
        return err({
          code: "rebuild_failed",
          message: "rebuild target must be a scratch brain, not the canonical brain — refused before dispatch",
        });
      }
      try {
        // (1) SSRF/allowlist guard — zero secret reads, zero dispatch on refusal.
        if (!isLoopbackEndpoint(endpoint) || !allowedEndpoints.includes(endpoint)) {
          throw new GbrainHttpTransportFault("endpoint_refused", hostRef);
        }
        // (2) Resolve the bearer token — fail closed, and wrap a THROWING accessor into the same
        //     redacted fault rather than letting the raw cause escape.
        let secret: Result<string, SecretUnavailable>;
        try {
          secret = await secrets.getSecret(tokenRef);
        } catch {
          throw new GbrainHttpTransportFault("token_unavailable");
        }
        if (isErr(secret)) {
          throw new GbrainHttpTransportFault("token_unavailable", secret.error.reason);
        }
        // (3) Build + dispatch — the wholesale rebuild names its scratch target explicitly.
        const httpRequest: HttpTransportRequest = {
          url: `${trimTrailingSlash(endpoint)}${REBUILD_PATH}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${secret.value}`,
          },
          body: JSON.stringify({
            workspaceId: request.workspaceId,
            revisionId: request.revisionId,
            scratchBrainId,
            facts: request.facts,
          }),
        };
        let response: HttpTransportResponse;
        try {
          response = await transport.send(httpRequest);
        } catch {
          throw new GbrainHttpTransportFault("transport_throw", hostRef);
        }
        // (4) Positive 2xx gate — a non-integer/out-of-range status fails CLOSED.
        if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
          throw new GbrainHttpTransportFault("status_error", `HTTP ${response.status}`);
        }
        // (5) Parse + shape-validate the 2xx body — never echo the raw body in a fault.
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.body) as unknown;
        } catch {
          throw new GbrainHttpTransportFault("malformed_body", hostRef);
        }
        if (!isRebuildResponseBody(parsed)) {
          throw new GbrainHttpTransportFault("malformed_body", hostRef);
        }
        // Report the SERVER's actual counts honestly — never synthesize `nodeCount`/`replaced` from the
        // request. `rebuildIndexFromMarkdown`'s incomplete_recovery / non_replacing_rebuild legs depend
        // on receiving the real values, not a value this client made up to look successful.
        return ok({
          workspaceId: request.workspaceId,
          revisionId: request.revisionId,
          nodeCount: parsed.nodeCount,
          replaced: parsed.replaced,
        });
      } catch (fault) {
        if (fault instanceof GbrainHttpTransportFault) {
          return err(foldRebuildFault(fault));
        }
        // Unreachable in practice (every throw above is a GbrainHttpTransportFault) but keeps
        // rebuildFromMarkdown a TOTAL function — a stray throw still resolves as a typed Result.
        return err({ code: "rebuild_failed", message: "unexpected gbrain index-rebuild failure" });
      }
    },
  };
}
