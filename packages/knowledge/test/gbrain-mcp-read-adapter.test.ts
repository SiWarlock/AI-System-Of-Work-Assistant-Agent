// spec(§6) — GBrain read/query-only MCP adapter (REQ-F-019/KN-2): exposes ONLY
// the V1 read surface (search/graph/timeline/schema_read/health/contained
// synthesis); rejects any op outside the grant; the ContainedSynthesisGate
// refuses to run without passed-in gated context; a non-read/non-http/generative
// or cross-brain grant is refused at construction (no write/admin token reaches
// the runtime).
import { describe, it, expect, vi } from "vitest";
import type { GbrainReadGrant, WorkspaceId, BrainId } from "@sow/contracts";
import {
  createGbrainReadAdapter,
  type GbrainReadClient,
  type GbrainAllowedOp,
} from "../src/gbrain/mcp-read-adapter";

const SHA40 = "3933eb6a3933eb6a3933eb6a3933eb6a3933eb6a";

function makeGrant(overrides: Partial<GbrainReadGrant> = {}): GbrainReadGrant {
  return {
    workspaceId: "ws-001" as WorkspaceId,
    brainId: "brain-acme" as BrainId,
    transport: "http",
    scope: ["read"],
    tokenRef: "keychain:gbrain-token",
    allowedOps: ["search", "graph", "timeline", "schema_read", "health", "contained_synthesis"],
    federationScope: "workspace_only",
    generativeCycleEnabled: false,
    pinnedSha: SHA40,
    indexSchemaVersion: 2,
    ...overrides,
  };
}

function fakeClient(
  impl?: (op: GbrainAllowedOp, payload: unknown, context?: readonly unknown[]) => unknown,
): GbrainReadClient & { calls: { op: GbrainAllowedOp; payload: unknown; context?: readonly unknown[] }[] } {
  const calls: { op: GbrainAllowedOp; payload: unknown; context?: readonly unknown[] }[] = [];
  return {
    calls,
    async invoke(op, payload, context) {
      calls.push({ op, payload, context });
      return impl ? impl(op, payload, context) : { op, echoed: payload };
    },
  };
}

describe("createGbrainReadAdapter — construction proof (read-only, workspace-scoped)", () => {
  it("accepts a read-only grant and exposes its identity + allowed ops", () => {
    const r = createGbrainReadAdapter(makeGrant(), fakeClient());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.workspaceId).toBe("ws-001");
    expect(r.value.brainId).toBe("brain-acme");
    expect(r.value.allowedOps).toEqual([
      "search", "graph", "timeline", "schema_read", "health", "contained_synthesis",
    ]);
  });

  it("has NO write/mutate method on its surface (structural one-writer proof)", () => {
    const r = createGbrainReadAdapter(makeGrant(), fakeClient());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const surface = r.value as unknown as Record<string, unknown>;
    for (const forbidden of ["put", "put_page", "write", "delete", "add_link", "extract_facts", "dream", "sync"]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it("refuses a non-http (stdio) transport ⇒ grant_not_read_only/transport", () => {
    const r = createGbrainReadAdapter(makeGrant({ transport: "stdio" as never }), fakeClient());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("grant_not_read_only");
    expect(r.error.reason).toBe("transport");
  });

  it("refuses an empty / non-read scope ⇒ grant_not_read_only/scope", () => {
    const r = createGbrainReadAdapter(makeGrant({ scope: [] as never }), fakeClient());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("scope");
  });

  it("refuses a generative-cycle-enabled grant ⇒ grant_not_read_only/generative_cycle", () => {
    const r = createGbrainReadAdapter(makeGrant({ generativeCycleEnabled: true as never }), fakeClient());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("generative_cycle");
  });

  it("refuses cross-brain federation ⇒ grant_not_read_only/federation", () => {
    const r = createGbrainReadAdapter(makeGrant({ federationScope: "federated" as never }), fakeClient());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("federation");
  });

  it("refuses a grant carrying an op OUTSIDE the read surface ⇒ allowed_op_out_of_read_surface", () => {
    const r = createGbrainReadAdapter(makeGrant({ allowedOps: ["search", "put_page"] as never }), fakeClient());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("allowed_op_out_of_read_surface");
  });
});

describe("read ops — delegation + per-op gating", () => {
  it("search delegates to the injected client and returns ok(result)", async () => {
    const client = fakeClient(() => ({ hits: [1, 2] }));
    const r = createGbrainReadAdapter(makeGrant(), client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await r.value.search({ q: "auth" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({ hits: [1, 2] });
    expect(client.calls[0]).toEqual({ op: "search", payload: { q: "auth" }, context: undefined });
  });

  it("an op absent from the grant's allowedOps is refused ⇒ op_not_allowed (client never called)", async () => {
    const client = fakeClient();
    const r = createGbrainReadAdapter(makeGrant({ allowedOps: ["search"] }), client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await r.value.timeline({ page: "acme/auth" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("op_not_allowed");
    if (res.error.code !== "op_not_allowed") return;
    expect(res.error.op).toBe("timeline");
    expect(client.calls).toHaveLength(0);
  });

  it("a transport fault becomes a typed err (never throws across the boundary)", async () => {
    const boom = new Error("socket hang up");
    const client = fakeClient(() => {
      throw boom;
    });
    const r = createGbrainReadAdapter(makeGrant(), client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await r.value.graph({ root: "acme/auth" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("transport_fault");
    if (res.error.code !== "transport_fault") return;
    expect(res.error.cause).toBe(boom);
  });
});

describe("ContainedSynthesisGate — synthesis runs ONLY over passed-in gated context", () => {
  it("refuses contained synthesis with empty context ⇒ requires_context (raw store never read)", async () => {
    const client = fakeClient();
    const r = createGbrainReadAdapter(makeGrant(), client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await r.value.containedSynthesis({ prompt: "summarize" }, []);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("contained_synthesis_requires_context");
    expect(client.calls).toHaveLength(0);
  });

  it("runs contained synthesis when gated context is supplied, forwarding the context", async () => {
    const client = fakeClient(() => ({ summary: "ok" }));
    const r = createGbrainReadAdapter(makeGrant(), client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gated = [{ factIdentity: "page:acme/auth", bytes: "..." }];
    const res = await r.value.containedSynthesis({ prompt: "summarize" }, gated);
    expect(res.ok).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.op).toBe("contained_synthesis");
    expect(client.calls[0]?.context).toBe(gated);
  });
});
