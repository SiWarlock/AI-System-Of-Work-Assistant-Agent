// spec(§8) spec(§5) — Asana ASANA_OPT_FIELDS widening (LEG 3, PKG-INT-5 · 23.4). A SMALL enrichment, not a
// build: asana.ts already sets `opt_fields` on the query (ASANA_OPT_FIELDS = "name,modified_at"); this
// widens it to the richer read set (name, modified_at, notes, completed, due_on, assignee.name,
// projects.name) while keeping `modified_at` (the change token `asanaContentHash` needs). Item 12 is a
// FENCE, not a build: the required project/workspace GID (asana.ts's REQUIRED SCOPE gap — GET /tasks 400s
// without project|tag or assignee+workspace) needs an owner value that must NOT be invented — this suite
// pins that no default project/tag/workspace/assignee filter is silently injected.
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import { createAsanaHttpTransport } from "../src/connectors/adapters/asana";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "asana-pat-secret";
const TOKEN_REF = "keychain:asana-pat";
const REQ: TransportRequest = { readScope: "tasks:read" };

function fakeTransport(response: HttpTransportResponse): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      return response;
    },
  };
}

function fakeSecrets(result: Result<string, SecretUnavailable> = ok(TOKEN)): SecretsAccessor {
  return {
    async getSecret() {
      return result;
    },
  };
}

const asana = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// The widened read set (item 11) — order matters (asserted against the exact built query string).
const NEW_OPT_FIELDS = ["name", "modified_at", "notes", "completed", "due_on", "assignee.name", "projects.name"];

// ── 11. Widened opt_fields: every new field present, percent-encoded exactly once, modified_at retained ──
describe("Asana opt_fields — widened read set (LEG 3, item 11)", () => {
  it("the built query contains every new field, percent-encoded EXACTLY ONCE, with modified_at retained", async () => {
    const transport = fakeTransport({ status: 200, body: JSON.stringify({ data: [] }) });
    await asana(transport);
    const url = transport.calls[0]!.url;
    const expectedOptFields = NEW_OPT_FIELDS.join(",");
    // Single encodeURIComponent pass over the whole opt_fields string — a double-encode (e.g. "%2C" becoming
    // "%252C") would make this exact substring absent even though each field individually still "appears".
    expect(url).toContain(`opt_fields=${encodeURIComponent(expectedOptFields)}`);
    expect(url).toContain("modified_at");
  });

  it("every one of the 7 fields is present in the built query", async () => {
    const transport = fakeTransport({ status: 200, body: JSON.stringify({ data: [] }) });
    await asana(transport);
    const url = transport.calls[0]!.url;
    for (const field of NEW_OPT_FIELDS) {
      expect(url).toContain(encodeURIComponent(field));
    }
  });

  it("dedupe hash is UNCHANGED for a record carrying only the OLD fields (name, modified_at) — widening opt_fields didn't touch asanaContentHash", async () => {
    const task = { gid: "task_1", name: "Old shape", modified_at: "2026-01-01T00:00:00Z" };
    const body = JSON.stringify({ data: [task] });
    const a = await asana(fakeTransport({ status: 200, body }));
    const b = await asana(fakeTransport({ status: 200, body }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
    }
  });
});

// ── 12. FENCE — the required project/workspace GID is NOT invented ──────────────
describe("Asana — the required project/workspace scope GID stays FENCED (item 12: do not build)", () => {
  it("the built query never injects a default project/tag/workspace/assignee filter (the owner's arming residual is untouched)", async () => {
    const transport = fakeTransport({ status: 200, body: JSON.stringify({ data: [] }) });
    await asana(transport);
    const url = transport.calls[0]!.url;
    expect(url).not.toContain("project=");
    expect(url).not.toContain("workspace=");
    expect(url).not.toContain("&tag=");
    expect(url).not.toContain("assignee=");
  });
});
