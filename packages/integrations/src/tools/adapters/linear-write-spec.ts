// @sow/integrations — the Linear WRITE spec: create / update / existence-probe issues over Linear's
// GraphQL API, driven by the shared `createWriteHttpTransport` (SSRF guard, header-only token,
// positive-2xx gate, redacted faults). Linear slice 2 of 6.
//
// Grounded on Linear's docs via Context7 (2026-09-21), not memory:
//   • POST https://api.linear.app/graphql. A PERSONAL key goes in RAW — `Authorization: <key>`, no
//     Bearer prefix (OAuth tokens take Bearer). Hence `authScheme: "raw"`.
//   • issueCreate(input) — `teamId` is the only required field; `id` accepts a caller-chosen UUID v4.
//   • issueUpdate(id, input) — every input field optional.
//   • Errors arrive in `errors[]`, possibly with HTTP 200 (partial success). A rate limit is HTTP 400
//     with `extensions.code = "RATELIMITED"` (the SDK also classifies on `extensions.type`).
//
// ⭐ STABLE ISSUE ID. The id is derived from (workspace, canonical key), so the create call CARRIES our
// key: a retry after a crash targets the same id and cannot mint a second issue, with no window
// between "created it" and "remembered it". The workspace is in the hash so two workspaces never share
// an id (rule 4). ⚠ UNVERIFIED LIVE — Linear does not document that it honours a caller-chosen id, how
// strictly it checks the v4 bits, or what a duplicate returns. Slice 6 checks all three against a real
// team BEFORE writes are armed; if it does not hold, the fallback is an attachment-URL key.
//
// ⭐ FILTER PROBE. Existence is `issues(filter: { id: { eq: $id } })`, which answers "absent" with an
// EMPTY LIST. `issue(id:)` answers "absent" with an error of undocumented shape, and a probe that
// cannot tell absent from failed either blocks every first create or risks a duplicate.
// ⚠ An ARCHIVED issue is outside the default filter, so it probes as absent; the create then collides
// on the same id and is refused — which fails closed rather than duplicating.
//
// ⛔ REQ-F-017 (never invent task owners or dates) — AMENDED 2026-09-25 (Linear slice 5b.2, owner decision): the
// assignee is the owner or a person the owner NAMED (resolved by the worker against the Linear members), and a due
// date only if the owner STATED one. Both are validated where they are proposed and SHOWN on the card before Approve,
// so the rule is kept where the values are made. This sender sends them when the APPROVED payload carries
// well-formed ones, and drops a malformed one. ⚠ The model-facing generic propose tool is CLOSED for Linear (it could
// otherwise put a raw assignee id in a payload); only the worker's Linear paths build a Linear payload.
import { sha256Hex } from "@sow/domain";
import { isCalendarDate } from "@sow/contracts";
import type { WriteHttpSpec } from "./write-http-transport";
import type { AdapterTransportRequest, TransportObject, TransportResponse } from "./transport";

const PROBE = "query IssueExists($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1) { nodes { id identifier url } } }";
const CREATE = "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }";
const UPDATE = "mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }";

// The zero character separates workspace from key, so no pair of strings can collide by
// concatenation. Built at runtime: a literal zero byte in the source makes git treat this file as
// binary and makes ripgrep skip it without a warning (found by review, 2026-09-21).
const ID_SEPARATOR = String.fromCharCode(0);

/**
 * A stable, UUID-v4-formatted id for (workspace, canonical key): the first 128 bits of a SHA-256,
 * with the version nibble set to 4 and the RFC 4122 variant bits set to `10`.
 */
export function linearIssueId(workspaceId: string, canonicalObjectKey: string): string {
  const h = sha256Hex(`${workspaceId}${ID_SEPARATOR}${canonicalObjectKey}`).slice(0, 32).split("");
  h[12] = "4";
  h[16] = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

const LINE_BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/;

/** A Linear user id as the worker resolved it: one line, ≤ 64. */
function assigneeIdOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 64 && !LINE_BREAK.test(v) ? v : undefined;
}

/** A real calendar day in Linear's TimelessDate form — the SAME check the card's Details use (`isCalendarDate`). */
function dueDateOf(v: unknown): string | undefined {
  return isCalendarDate(v) ? v : undefined;
}

/** The fields this sender will write — each only when well-formed (the assignee and due date: see REQ-F-017 above). */
function writableFields(p: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = nonBlank(p["title"]);
  if (title !== undefined) out["title"] = title;
  if (typeof p["description"] === "string") out["description"] = p["description"];
  const pr = p["priority"];
  if (typeof pr === "number" && Number.isInteger(pr) && pr >= 0 && pr <= 4) out["priority"] = pr;
  const assigneeId = assigneeIdOf(p["assigneeId"]);
  if (assigneeId !== undefined) out["assigneeId"] = assigneeId;
  const dueDate = dueDateOf(p["dueDate"]);
  if (dueDate !== undefined) out["dueDate"] = dueDate;
  return out;
}

interface LinearError {
  readonly extensions?: { readonly code?: unknown; readonly type?: unknown };
}

function errorsOf(json: unknown): readonly LinearError[] {
  const e = (json as { errors?: unknown } | null)?.errors;
  return Array.isArray(e) ? (e as LinearError[]) : [];
}

function isRateLimited(errors: readonly LinearError[]): boolean {
  return errors.some((e) => e?.extensions?.code === "RATELIMITED" || e?.extensions?.type === "ratelimited");
}

/** An https URL, or nothing — the receipt schema requires a valid URL, and nothing downstream checks. */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

function toObject(issue: unknown): TransportObject | undefined {
  const i = issue as { id?: unknown; identifier?: unknown; url?: unknown } | null | undefined;
  const id = nonBlank(i?.id);
  if (id === undefined) return undefined;
  const url = safeUrl(i?.url);
  const ref = nonBlank(i?.identifier);
  return { externalObjectId: id, ...(url !== undefined ? { externalUrl: url } : {}), ...(ref !== undefined ? { rawRef: ref } : {}) };
}

const notProof = (what: string): TransportResponse => ({ ok: false, fault: "unknown", detail: `linear ${what} was not proof of a write` });

export const LINEAR_WRITE_SPEC: WriteHttpSpec = {
  baseUrl: "https://api.linear.app",
  allowedHosts: ["api.linear.app"],
  authScheme: "raw",

  buildRequest: (req: AdapterTransportRequest) => {
    const id = linearIssueId(req.workspaceId ?? "", req.canonicalObjectKey);
    const p = req.payload ?? {};
    let doc: { query: string; variables: Record<string, unknown> };
    if (req.op === "query") {
      doc = { query: PROBE, variables: { id } };
    } else if (req.op === "create") {
      // Fail closed BEFORE anything is sent: a throw here becomes `request_build_error` in the
      // transport, which dispatches nothing. Messages stay generic — never echo payload values.
      const teamId = nonBlank(p["teamId"]);
      if (teamId === undefined) throw new Error("linear create needs a teamId");
      const fields = writableFields(p);
      if (fields["title"] === undefined) throw new Error("linear create needs a title");
      doc = { query: CREATE, variables: { input: { id, teamId, ...fields } } };
    } else {
      doc = { query: UPDATE, variables: { id, input: writableFields(p) } };
    }
    // Values ride in `variables` only; the query text is a constant, so input can never become syntax.
    return { method: "POST", path: "/graphql", body: JSON.stringify(doc) };
  },

  mapResponse: (_status: number, json: unknown, req: AdapterTransportRequest): TransportResponse => {
    const errors = errorsOf(json);
    if (errors.length > 0) {
      // A partial success is not a clean answer, so any error fails closed. Only a rate limit is
      // worth retrying; auth and everything else are terminal.
      return isRateLimited(errors)
        ? { ok: false, fault: "unreachable", detail: "linear rate limited" }
        : { ok: false, fault: "rejected", detail: "linear returned errors" };
    }
    const data = (json as { data?: Record<string, unknown> } | null)?.data;
    if (req.op === "query") {
      const nodes = (data?.["issues"] as { nodes?: unknown } | undefined)?.nodes;
      if (!Array.isArray(nodes)) return { ok: false, fault: "unknown", detail: "linear probe was malformed" };
      if (nodes.length === 0) return { ok: true, object: null };
      const obj = toObject(nodes[0]);
      return obj !== undefined ? { ok: true, object: obj } : { ok: false, fault: "unknown", detail: "linear probe was malformed" };
    }
    const key = req.op === "create" ? "issueCreate" : "issueUpdate";
    const res = data?.[key] as { success?: unknown; issue?: unknown } | undefined;
    if (res?.success !== true) return notProof(key);
    const obj = toObject(res.issue);
    return obj !== undefined ? { ok: true, object: obj } : notProof(key);
  },

  retryableBody: (_status: number, json: unknown) => isRateLimited(errorsOf(json)),
};
