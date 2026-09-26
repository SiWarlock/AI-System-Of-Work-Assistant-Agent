// @sow/integrations — the Linear PEOPLE reader: who a Copilot-proposed issue is assigned to (Linear slice 5b.2).
//
// Owner decision 2026-09-25, "You, or who you name": by default the key's OWN Linear user (`viewer`); if the owner
// names someone, the worker matches that EXACT name (full name, display name or email — ignoring case and outer
// spaces) against the workspace's active members. No partial or fuzzy match. ⛔ The member list never leaves the
// worker — it is not sent to the cloud model, and the name the owner typed is never sent to Linear (the match is local).
//
// Grounded on Linear's docs via Context7 (2026-09-25): `viewer { id name }`; `users(first, after)` with Relay pagination.
// The filter input's fields were not confirmed there, so this does not depend on them: it pages the member list, bounded
// at LINEAR_MEMBERS_MAX_PAGES, reading EVERY page so a same-named member on a later page is still caught. A match is
// used only when the WHOLE list was read: past the cap (or a page that says "more" with no cursor), a same-named person
// could be unread, so the answer is `too_many_members` even with one match (review 2026-09-25, measured). The ONE
// exception is an exact EMAIL match: an email is unique in a Linear org, so it identifies one person whatever is unread
// — and it wins over a member whose name or display name merely reads like that email (critic 2026-09-25).
//
// ⭐ ONE GUARDED PIPELINE, like the teams reader: `guardedHttpExchange` (SSRF guard, workspace-scoped key read that fails
// closed, key in the header only, no redirects, positive-2xx gate, parsed body never echoed), with the Linear write
// spec's host, auth scheme and rate-limit rule. Built by the worker ONLY in `resolveLinearWriteArming`'s armed branch.
import { guardedHttpExchange, type GuardedHttpSpec, type WriteHttpTransportDeps, type GuardedHttpExchange } from "./write-http-transport";
import { LINEAR_WRITE_SPEC } from "./linear-write-spec";

/** Members per page, and the most pages read for one lookup — a bounded read, never an unbounded crawl. */
export const LINEAR_MEMBERS_PAGE = 250;
export const LINEAR_MEMBERS_MAX_PAGES = 4;

const VIEWER_QUERY = "query Me { viewer { id name } }";
const MEMBERS_QUERY =
  "query Members($first: Int!, $after: String) { users(first: $first, after: $after) { nodes { id name displayName email active } pageInfo { hasNextPage endCursor } } }";

export interface LinearPerson {
  readonly id: string;
  readonly name: string;
}
export type LinearPeopleFailure = "unreachable" | "rejected" | "malformed";
export type LinearViewerRead = { readonly ok: true; readonly user: LinearPerson } | { readonly ok: false; readonly reason: LinearPeopleFailure };
export type LinearMemberMatch =
  | { readonly ok: true; readonly user: LinearPerson }
  | { readonly ok: false; readonly reason: LinearPeopleFailure | "not_found" | "ambiguous" | "too_many_members" };

export interface LinearPeopleReader {
  /** The key's own Linear user — the default assignee. */
  readonly viewer: (workspaceId: string) => Promise<LinearViewerRead>;
  /**
   * The ONE active member whose full name, display name or email equals `name` (ignoring case and outer spaces) — found
   * in a list read to its END. Two matches ⇒ `ambiguous`; an unfinished list ⇒ `too_many_members`, even with one match
   * — except an exact EMAIL match, which is unique in the org and is used as soon as it is read.
   */
  readonly findMember: (workspaceId: string, name: string) => Promise<LinearMemberMatch>;
}

function specFor(body: string): GuardedHttpSpec {
  return {
    baseUrl: LINEAR_WRITE_SPEC.baseUrl,
    allowedHosts: LINEAR_WRITE_SPEC.allowedHosts,
    ...(LINEAR_WRITE_SPEC.authScheme !== undefined ? { authScheme: LINEAR_WRITE_SPEC.authScheme } : {}),
    buildRequest: () => ({ method: "POST", path: "/graphql", body }),
    ...(LINEAR_WRITE_SPEC.retryableBody !== undefined ? { retryableBody: LINEAR_WRITE_SPEC.retryableBody } : {}),
  };
}

/** The data of a clean 2xx answer, or the typed failure. An `errors[]` answer is a failure even on HTTP 200. */
function dataOf(exchanged: GuardedHttpExchange): { readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false; readonly reason: LinearPeopleFailure } {
  if (!exchanged.ok) {
    if (exchanged.fault === "unreachable") return { ok: false, reason: "unreachable" };
    if (exchanged.faultDetail === "malformed_body") return { ok: false, reason: "malformed" };
    return { ok: false, reason: "rejected" };
  }
  const json = exchanged.json as { errors?: unknown; data?: unknown } | null;
  const errors = json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    let limited = false;
    try {
      limited = LINEAR_WRITE_SPEC.retryableBody?.(400, json) === true;
    } catch {
      limited = false;
    }
    return { ok: false, reason: limited ? "unreachable" : "rejected" };
  }
  const data = json?.data;
  return typeof data === "object" && data !== null ? { ok: true, data: data as Record<string, unknown> } : { ok: false, reason: "malformed" };
}

function exchange(deps: WriteHttpTransportDeps, workspaceId: string, body: string): Promise<GuardedHttpExchange> {
  return guardedHttpExchange(specFor(body), deps, {
    op: "query",
    targetSystem: "linear",
    canonicalObjectKey: "linear:people",
    idempotencyKey: "linear:people",
    identity: {},
    workspaceId,
  });
}

const norm = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** Build the reader over an injected http client and the Keychain-backed accessor. TOTAL — never throws. */
export function createLinearPeopleReader(deps: WriteHttpTransportDeps): LinearPeopleReader {
  return {
    async viewer(workspaceId) {
      try {
        const d = dataOf(await exchange(deps, workspaceId, JSON.stringify({ query: VIEWER_QUERY })));
        if (!d.ok) return d;
        const v = d.data["viewer"] as { id?: unknown; name?: unknown } | null | undefined;
        if (typeof v?.id !== "string" || v.id.trim().length === 0 || typeof v.name !== "string") return { ok: false, reason: "malformed" };
        return { ok: true, user: { id: v.id, name: v.name } };
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },

    async findMember(workspaceId, name) {
      const wanted = norm(name);
      if (wanted.length === 0) return { ok: false, reason: "not_found" };
      try {
        const found: LinearPerson[] = [];
        const byEmail: LinearPerson[] = [];
        let after: string | null = null;
        let more = true;
        let incomplete = false;
        for (let page = 0; page < LINEAR_MEMBERS_MAX_PAGES && more; page++) {
          const d = dataOf(await exchange(deps, workspaceId, JSON.stringify({ query: MEMBERS_QUERY, variables: { first: LINEAR_MEMBERS_PAGE, after } })));
          if (!d.ok) return d;
          const users = d.data["users"] as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null } | null | undefined;
          if (typeof users !== "object" || users === null || !Array.isArray(users.nodes)) return { ok: false, reason: "malformed" };
          for (const n of users.nodes as unknown[]) {
            const u = n as { id?: unknown; name?: unknown; displayName?: unknown; email?: unknown; active?: unknown } | null;
            if (typeof u?.id !== "string" || typeof u.name !== "string" || u.active === false) continue;
            if (norm(u.email) === wanted) byEmail.push({ id: u.id, name: u.name });
            if ([u.name, u.displayName, u.email].some((f) => norm(f) === wanted)) found.push({ id: u.id, name: u.name });
          }
          const hasNext = users.pageInfo?.hasNextPage === true;
          more = hasNext && typeof users.pageInfo?.endCursor === "string";
          if (hasNext && !more) incomplete = true; // "more" with no cursor: the rest cannot be read
          after = more ? (users.pageInfo?.endCursor as string) : null;
        }
        if (more) incomplete = true; // stopped at the cap with pages left
        const email = byEmail[0];
        if (byEmail.length === 1 && email !== undefined) return { ok: true, user: email }; // unique in the org
        if (found.length > 1) return { ok: false, reason: "ambiguous" };
        if (incomplete) return { ok: false, reason: "too_many_members" };
        const only = found[0];
        return only !== undefined ? { ok: true, user: only } : { ok: false, reason: "not_found" };
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}
