// @sow/integrations — the Linear TEAMS reader: the form proposer's team picker (Linear slice 5a).
//
// Grounded on Linear's docs via Context7 (2026-09-25), not memory: `query { teams { nodes { id name } } }` over
// POST https://api.linear.app/graphql, a PERSONAL key RAW in `Authorization`, Relay pagination (`first`,
// `pageInfo.hasNextPage`). Errors arrive in `errors[]`, possibly on HTTP 200; a rate limit is `RATELIMITED`.
//
// ⭐ ONE GUARDED PIPELINE. This reads through `guardedHttpExchange` — the same exchange the Linear write sender uses:
// the SSRF guard on the final url, the workspace-scoped key read (`writeSecretRef("linear", workspace)`) that fails
// closed, the key in the header only, redirects never followed, the positive-2xx gate, a parsed body that is never
// echoed. It reads `LINEAR_WRITE_SPEC`'s host, allowed hosts, auth scheme and rate-limit rule rather than restating them
// (the auth scheme was a copied literal until the slice-5a review).
//
// ⛔ OWNER DECISION 2026-09-25: the team list is read ONLY when Linear writes are on for the workspace. This module
// does not decide that and makes no real calls (the http client is injected). The worker builds the reader in ONE
// place — the armed branch of `resolveLinearWriteArming` — pinned by packages/evals/test/reachability-claim-drift.test.ts.
//
// ⚠ A team NAME is the vendor's content (Employer-Work raw content in the employer workspace). It leaves here as a
// plain string for the worker's UI-safe projector (`toUiSafeLinearTeamList`), which bounds it; nothing here logs it.
import { guardedHttpExchange, type GuardedHttpSpec, type WriteHttpTransportDeps } from "./write-http-transport";
import { LINEAR_WRITE_SPEC } from "./linear-write-spec";

/** One page. More ⇒ `hasMore`, and the form says so — never a silent cap. */
export const LINEAR_TEAMS_PAGE = 100;

const TEAMS_QUERY = "query Teams($first: Int!) { teams(first: $first) { nodes { id name } pageInfo { hasNextPage } } }";

/** Why the teams could not be read. `unreachable` may succeed later; the others will not by retrying alone. */
export type LinearTeamsFailure = "unreachable" | "rejected" | "malformed";

export type LinearTeamsRead =
  | { readonly ok: true; readonly teams: readonly { readonly id: string; readonly name: string }[]; readonly hasMore: boolean }
  | { readonly ok: false; readonly reason: LinearTeamsFailure };

const TEAMS_SPEC: GuardedHttpSpec = {
  baseUrl: LINEAR_WRITE_SPEC.baseUrl,
  allowedHosts: LINEAR_WRITE_SPEC.allowedHosts,
  // The WRITE spec's scheme, not a copy of it: if writes move to another scheme, the team read moves with them.
  ...(LINEAR_WRITE_SPEC.authScheme !== undefined ? { authScheme: LINEAR_WRITE_SPEC.authScheme } : {}),
  // A fixed QUERY document; the page size rides in `variables`, never in the text.
  buildRequest: () => ({ method: "POST", path: "/graphql", body: JSON.stringify({ query: TEAMS_QUERY, variables: { first: LINEAR_TEAMS_PAGE } }) }),
  ...(LINEAR_WRITE_SPEC.retryableBody !== undefined ? { retryableBody: LINEAR_WRITE_SPEC.retryableBody } : {}),
};

function hasErrors(json: unknown): boolean {
  const e = (json as { errors?: unknown } | null)?.errors;
  return Array.isArray(e) && e.length > 0;
}

/** A rate limit is a "later", even on HTTP 200 — Linear's own rule, reused from the write spec. */
function isRateLimited(json: unknown): boolean {
  try {
    return LINEAR_WRITE_SPEC.retryableBody?.(400, json) === true;
  } catch {
    return false;
  }
}

/**
 * Build the reader over an injected http client and the Keychain-backed accessor. TOTAL — never throws. Reads ONE
 * page for the named workspace; a workspace without a key is refused before any network call (rule 4, by the
 * exchange). A failed read is a typed failure, NEVER an empty list: an empty list would read as "this workspace has
 * no teams" and yield a form that can never be completed.
 */
export function createLinearTeamsReader(deps: WriteHttpTransportDeps): (workspaceId: string) => Promise<LinearTeamsRead> {
  return async (workspaceId: string): Promise<LinearTeamsRead> => {
    const exchanged = await guardedHttpExchange(TEAMS_SPEC, deps, {
      op: "query",
      targetSystem: "linear",
      canonicalObjectKey: "linear:teams",
      idempotencyKey: "linear:teams",
      identity: {},
      workspaceId,
    });
    if (!exchanged.ok) {
      if (exchanged.fault === "unreachable") return { ok: false, reason: "unreachable" };
      if (exchanged.faultDetail === "malformed_body") return { ok: false, reason: "malformed" };
      return { ok: false, reason: "rejected" };
    }
    try {
      const json = exchanged.json;
      if (hasErrors(json)) return { ok: false, reason: isRateLimited(json) ? "unreachable" : "rejected" };
      const teams = (json as { data?: { teams?: unknown } } | null)?.data?.teams;
      // `null` included: `{ "teams": null }` is a malformed answer, not a crash (slice-5a review, measured).
      if (typeof teams !== "object" || teams === null) return { ok: false, reason: "malformed" };
      const { nodes, pageInfo } = teams as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } | null };
      if (!Array.isArray(nodes)) return { ok: false, reason: "malformed" };
      const out: { id: string; name: string }[] = [];
      for (const n of nodes as unknown[]) {
        const node = n as { id?: unknown; name?: unknown } | null;
        if (typeof node?.id === "string" && typeof node.name === "string") out.push({ id: node.id, name: node.name });
      }
      return { ok: true, teams: out, hasMore: pageInfo?.hasNextPage === true };
    } catch {
      return { ok: false, reason: "malformed" }; // TOTAL: an unexpected answer shape never throws out of the reader
    }
  };
}
