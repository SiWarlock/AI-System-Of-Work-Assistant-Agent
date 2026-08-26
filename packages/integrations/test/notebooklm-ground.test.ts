// Task 13.9 — NotebookLM GROUNDING adapter (upload scoped notes → synthesize →
// force-delete the ephemeral store), dormant behind the Tool-Gateway envelope.
//
// OPPOSITE direction of 6.6 notebooklm.sync (notebooklm-sync.ts pushes
// vault-derived Markdown OUT to Drive). This module uploads a WORKSPACE-SCOPED
// note set through the REAL Tool Gateway (dispatchExternalWrite — the same
// idempotencyKey/canonicalObjectKey/receipt-reuse envelope as every other
// external write), asks an injected transport a grounding question against the
// uploaded ephemeral store, and force-deletes that store on BOTH the success
// and the failure path.
//
// Wiring uses the REAL Tool Gateway + a fake TargetWriteAdapter (mirrors
// notebook-sync.test.ts), so the envelope / no-duplicate-write invariant is
// exercised end-to-end, not mocked away.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { ok, err, validAgentJob, processorId } from "@sow/contracts";
import type {
  AgentJob,
  DataOwner,
  EgressPolicy,
  Result,
  WriteReceipt,
  AuditRecord,
  WorkspaceType,
} from "@sow/contracts";
import { processorOfRoute, denyDecision, buildAuditSignal } from "@sow/policy";
import type { TargetWriteAdapter, ExistingObject, AdapterError } from "../src/tools/adapter-port";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import {
  createNotebookLmGround,
  NOTEBOOKLM_EGRESS_ROUTE,
  type NotebookGroundDeps,
} from "../src/notebook/notebooklm-ground";
import type {
  NotebookGroundNote,
  NotebookGroundRequest,
  NotebookGroundTransport,
  GroundResult,
  NotebookGroundError,
} from "../src/notebook/notebook-ground-port";
import { InMemoryReceiptStore } from "./support/fakes";

// --- fixtures ----------------------------------------------------------------

const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

// 13.9 — the REAL rule-5 `@sow/policy` egressVeto's inputs (mirrors
// free-source-aggregator.test.ts's fixtures). NOTEBOOKLM_PROC is the
// processor identity the real `processorOfRoute` derives from
// NOTEBOOKLM_EGRESS_ROUTE's `runtime` key.
const NOTEBOOKLM_PROC = processorId("notebooklm-ground");
const PERSONAL: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };
const EMPLOYER: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };

function egressPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProcessors: [NOTEBOOKLM_PROC],
    rawContentAllowedProcessors: [NOTEBOOKLM_PROC],
    employerRawEgressAcknowledged: true,
    ...over,
  };
}

function jobWith(over: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, carriesRawContent: true, trustLevel: "trusted", ...over };
}

function note(workspaceId: string, noteId: string, body = "note body"): NotebookGroundNote {
  return { workspaceId, noteId, body };
}

function makeRequest(overrides: Partial<NotebookGroundRequest> = {}): NotebookGroundRequest {
  return {
    workspaceId: "ws-a",
    project: "proj_alpha",
    question: "what changed this week?",
    notes: [note("ws-a", "n1"), note("ws-a", "n2")],
    job: jobWith(),
    egress: egressPolicy(),
    workspace: PERSONAL,
    ...overrides,
  };
}

// A fake write adapter mirroring notebook-sync.test.ts's makeFakeDriveAdapter:
// a Map keyed by canonicalObjectKey; `create` returns a vendor id (the
// "storeRef") and remembers it so a live existence probe on the SAME key hits
// (replay reuse). Spied so tests can assert call counts.
function makeFakeAdapter(): { adapter: TargetWriteAdapter; createCalls: () => number } {
  const objects = new Map<string, string>();
  let nextId = 0;
  const create = vi.fn(
    async (env: { canonicalObjectKey: string }): Promise<Result<WriteReceipt, AdapterError>> => {
      const id = `store_${nextId++}`;
      objects.set(env.canonicalObjectKey, id);
      return ok<WriteReceipt>({ externalObjectId: id, recordedAt: FIXED_CLOCK() });
    },
  );
  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: vi.fn(
      async (canonicalObjectKey: string): Promise<Result<ExistingObject | null, AdapterError>> => {
        const hit = objects.get(canonicalObjectKey);
        return ok(hit === undefined ? null : { externalObjectId: hit });
      },
    ),
    create: create as unknown as TargetWriteAdapter["create"],
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
  return { adapter, createCalls: () => create.mock.calls.length };
}

function makeGatewayDeps(
  adapter: TargetWriteAdapter,
  store: InMemoryReceiptStore,
): ExternalWriteDeps {
  return {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async (_rec: AuditRecord) => {},
    clock: FIXED_CLOCK,
  };
}

function wellFormedResult(overrides: Partial<GroundResult> = {}): GroundResult {
  return { answer: "the synthesized answer", citations: ["note:n1"], ...overrides };
}

// A fake transport: `ground` + `deleteStore` are independently configurable
// vi.fn spies so each test can pin exact call counts + failure shapes.
function makeFakeTransport(overrides: Partial<NotebookGroundTransport> = {}): {
  transport: NotebookGroundTransport;
  ground: ReturnType<typeof vi.fn>;
  deleteStore: ReturnType<typeof vi.fn>;
} {
  const ground = vi.fn(async (): Promise<GroundResult> => wellFormedResult());
  const deleteStore = vi.fn(
    async (): Promise<Result<void, { readonly message: string }>> => ok(undefined),
  );
  const transport: NotebookGroundTransport = {
    ground: (overrides.ground ?? ground) as NotebookGroundTransport["ground"],
    deleteStore: (overrides.deleteStore ?? deleteStore) as NotebookGroundTransport["deleteStore"],
  };
  return { transport, ground, deleteStore };
}

function makeDeps(overrides: {
  adapter?: TargetWriteAdapter;
  store?: InMemoryReceiptStore;
  transport?: NotebookGroundTransport;
} = {}): { deps: NotebookGroundDeps; adapter: ReturnType<typeof makeFakeAdapter>; store: InMemoryReceiptStore } {
  const fake = overrides.adapter ? { adapter: overrides.adapter, createCalls: () => 0 } : makeFakeAdapter();
  const store = overrides.store ?? new InMemoryReceiptStore();
  const gateway = makeGatewayDeps(fake.adapter, store);
  const { transport } = makeFakeTransport();
  const deps: NotebookGroundDeps = {
    gateway,
    transport: overrides.transport ?? transport,
    approvalPolicy: "auto_allowed",
    clock: FIXED_CLOCK,
  };
  return { deps, adapter: fake, store };
}

// --- 1. workspace scoping (safety rule 4, WS-8) -------------------------------

describe("createNotebookLmGround — workspace scoping (WS-8)", () => {
  it("excludes a note from a DIFFERENT workspace than the one being grounded", async () => {
    const captured: unknown[] = [];
    const { adapter, createCalls } = makeFakeAdapter();
    const spiedAdapter: TargetWriteAdapter = {
      ...adapter,
      create: async (env, payload) => {
        captured.push(payload);
        return adapter.create(env as never, payload);
      },
    };
    const { deps } = makeDeps({ adapter: spiedAdapter });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(
      makeRequest({
        workspaceId: "ws-a",
        notes: [note("ws-a", "n1"), note("ws-b", "n2-from-other-workspace")],
      }),
    );

    expect(res.ok).toBe(true);
    expect(createCalls).toBeDefined(); // sanity: fixture wired
    expect(captured).toHaveLength(1);
    const uploaded = captured[0] as { notes: NotebookGroundNote[] };
    expect(uploaded.notes.map((n) => n.noteId)).toEqual(["n1"]);
    expect(uploaded.notes.some((n) => n.workspaceId === "ws-b")).toBe(false);
  });

  it("POSITIVE CONTROL: an all-ws-a list uploads ALL of them (proves the adapter isn't just uploading nothing)", async () => {
    const captured: unknown[] = [];
    const { adapter } = makeFakeAdapter();
    const spiedAdapter: TargetWriteAdapter = {
      ...adapter,
      create: async (env, payload) => {
        captured.push(payload);
        return adapter.create(env as never, payload);
      },
    };
    const { deps } = makeDeps({ adapter: spiedAdapter });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(
      makeRequest({ workspaceId: "ws-a", notes: [note("ws-a", "n1"), note("ws-a", "n2")] }),
    );

    expect(res.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const uploaded = captured[0] as { notes: NotebookGroundNote[] };
    expect(uploaded.notes.map((n) => n.noteId).sort()).toEqual(["n1", "n2"]);
  });
});

// --- 2. egress veto fail-closed (safety rule 5, the REAL @sow/policy egressVeto) ---

describe("createNotebookLmGround — egress veto fail-closed (safety rule 5, REAL @sow/policy egressVeto)", () => {
  it("employer-work raw content + ack OFF yields a typed err with ZERO transport calls and ZERO dispatch (adapter) calls", async () => {
    const { adapter, createCalls } = makeFakeAdapter();
    const existenceSpy = adapter.existenceCheck as ReturnType<typeof vi.fn>;
    const { transport, ground, deleteStore } = makeFakeTransport();
    const { deps } = makeDeps({ adapter, transport });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(
      makeRequest({
        workspace: EMPLOYER,
        egress: egressPolicy({ employerRawEgressAcknowledged: false, rawContentAllowedProcessors: [] }),
      }),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("egress_denied");
    // ZERO dispatch — neither the existence probe nor create ever ran.
    expect(createCalls()).toBe(0);
    expect(existenceSpy.mock.calls.length).toBe(0);
    // ZERO transport calls — no ground, no delete, no cloud fallback, no retry.
    expect(ground.mock.calls.length).toBe(0);
    expect(deleteStore.mock.calls.length).toBe(0);
  });

  it("POSITIVE CONTROL: the SAME notes/job through a personal workspace ALLOWS through (the veto discriminates, not a blanket deny)", async () => {
    const { deps } = makeDeps();
    const port = createNotebookLmGround(deps);
    const res = await port.ground(makeRequest({ workspace: PERSONAL }));
    expect(res.ok).toBe(true);
  });

  it("employer-work with ack ON allows through — the veto re-evaluates per call, not a one-way lock", async () => {
    const { deps } = makeDeps();
    const port = createNotebookLmGround(deps);
    const res = await port.ground(
      makeRequest({ workspace: EMPLOYER, egress: egressPolicy({ employerRawEgressAcknowledged: true }) }),
    );
    expect(res.ok).toBe(true);
  });

  it("the synthetic egress route classifies as EGRESS (processorOfRoute !== null) — no fail-open", () => {
    // If the synthetic route were non-egress (proc === null), the employer-raw veto
    // would fall through to ALLOW — a silent rule-5 fail-open. Pin it egress-classed.
    expect(processorOfRoute(NOTEBOOKLM_EGRESS_ROUTE)).not.toBeNull();
    expect(NOTEBOOKLM_EGRESS_ROUTE.egressClass).toBe("cloud");
  });

  it("a caller-injected fake egressVeto is honored (the OPTIONAL testing seam), still zero-transport on deny", async () => {
    const denyingVeto: NotebookGroundDeps["egressVeto"] = () =>
      denyDecision(
        "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
        "fake deny",
        buildAuditSignal({
          actor: "test",
          event: "egress.denied",
          refs: [],
          payloadHash: "policy:egress-decision",
          beforeSummary: "n/a",
          afterSummary: "fake deny",
        }),
      );
    const { transport, ground } = makeFakeTransport();
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround({ ...deps, egressVeto: denyingVeto });
    const res = await port.ground(makeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("egress_denied");
    expect(ground.mock.calls.length).toBe(0);
  });
});

// --- 3. envelope reuse (safety rule 3) ----------------------------------------

describe("createNotebookLmGround — envelope reuse (safety rule 3)", () => {
  it("a replay against a receipt store that already holds the receipt REUSES it — adapter create called ONCE total", async () => {
    const { adapter, createCalls } = makeFakeAdapter();
    const store = new InMemoryReceiptStore();
    const { deps } = makeDeps({ adapter, store });
    const port = createNotebookLmGround(deps);

    const first = await port.ground(makeRequest());
    expect(first.ok).toBe(true);
    expect(createCalls()).toBe(1);

    // Second dispatch of the SAME grounding against the SAME (now-populated)
    // receipt store: resolveExisting hits the stored receipt ⇒ reused, no
    // second create.
    const second = await port.ground(makeRequest());
    expect(second.ok).toBe(true);
    expect(createCalls()).toBe(1); // still 1 — the replay reused the receipt
  });
});

// --- 4. force-delete the ephemeral store (both paths) -------------------------

describe("createNotebookLmGround — force-delete the ephemeral store", () => {
  it("on the SUCCESS path, the delete hop runs exactly once", async () => {
    const { deleteStore, transport } = makeFakeTransport();
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(makeRequest());

    expect(res.ok).toBe(true);
    expect(deleteStore.mock.calls.length).toBe(1);
  });

  it("LOAD-BEARING: on a transport fault MID-SYNTHESIS (failure path), the delete hop STILL runs exactly once", async () => {
    const groundThatThrows = vi.fn(async (): Promise<GroundResult> => {
      throw new Error("vendor synthesis boundary fault");
    });
    const { deleteStore, transport } = makeFakeTransport({
      ground: groundThatThrows as unknown as NotebookGroundTransport["ground"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(makeRequest());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("transport_fault");
    // The whole reason this hop exists: the store is force-deleted even though
    // synthesis faulted.
    expect(deleteStore.mock.calls.length).toBe(1);
  });
});

// --- 5. delete fault is surfaced, not swallowed -------------------------------

describe("createNotebookLmGround — a failing delete after success is surfaced, never a silent ok", () => {
  it("a failing delete after a SUCCESSFUL synthesis yields a typed cleanup_failed reporting the residual store", async () => {
    const failingDelete = vi.fn(
      async (): Promise<Result<void, { readonly message: string }>> =>
        err({ message: "vendor delete rejected" }),
    );
    const { transport, ground } = makeFakeTransport({
      deleteStore: failingDelete as unknown as NotebookGroundTransport["deleteStore"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    const res = await port.ground(makeRequest());

    // Synthesis itself succeeded (ground was called + returned a good result)...
    expect(ground.mock.calls.length).toBe(1);
    // ...but the overall result is NEVER a silent ok — the leak is surfaced.
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("cleanup_failed");
      expect(typeof res.error).toBe("object");
      expect("storeRef" in res.error && typeof res.error.storeRef).toBe("string");
    }
  });
});

// --- 6. candidate, not truth (safety rules 1 + 2) -----------------------------

describe("createNotebookLmGround — candidate data only (safety rules 1 + 2)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/notebook/notebooklm-ground.ts", import.meta.url)),
    "utf8",
  );

  it("imports nothing from @sow/knowledge and calls no writer", () => {
    for (const forbidden of ['from "@sow/knowledge"', "KnowledgeWriter(", "writeMarkdown(", "commitMutation("]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("names KnowledgeWriter as the only autonomous writer in a header comment", () => {
    expect(src.includes("KnowledgeWriter")).toBe(true);
  });

  it("the success value is a plain candidate payload (no ok()-wrapped writer receipt)", async () => {
    const { deps } = makeDeps();
    const port = createNotebookLmGround(deps);
    const res = await port.ground(makeRequest());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.kind).toBe("notebooklm_ground_candidate");
      expect(res.value.answer).toBe("the synthesized answer");
      expect(res.value.citations).toEqual(["note:n1"]);
    }
  });
});

// --- 7. TOTAL — never throws (L11) --------------------------------------------

describe("createNotebookLmGround — TOTAL, never throws (L11)", () => {
  it("a throwing transport.ground becomes a typed transport_fault, not an exception", async () => {
    const { transport } = makeFakeTransport({
      ground: (async () => {
        throw new Error("boom");
      }) as unknown as NotebookGroundTransport["ground"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    await expect(port.ground(makeRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "transport_fault" },
    });
  });

  it("a throwing deleteStore becomes a typed cleanup_failed, not an exception", async () => {
    const { transport } = makeFakeTransport({
      deleteStore: (async () => {
        throw new Error("boom");
      }) as unknown as NotebookGroundTransport["deleteStore"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    await expect(port.ground(makeRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "cleanup_failed" },
    });
  });

  it("a pathological (malformed) synthesis shape becomes a typed transport_fault, not a crash", async () => {
    const { transport } = makeFakeTransport({
      ground: (async () => ({ answer: 42, citations: "not-an-array" }) as unknown) as NotebookGroundTransport["ground"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);

    await expect(port.ground(makeRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "transport_fault" },
    });
  });
});

// --- 8. rule 7 — no fault message leaks content -------------------------------

describe("createNotebookLmGround — rule 7: no fault leaks note content / question / credentials", () => {
  const SENTINEL_NOTE_CONTENT = "TOP-SECRET-NOTE-CONTENT-xyz123";
  const SENTINEL_QUESTION = "TOP-SECRET-QUESTION-abc789";
  const SENTINEL_CREDENTIAL = "sk-fake-credential-shape-000111";

  function allErrorsFrom(...errors: (NotebookGroundError | undefined)[]): string {
    return JSON.stringify(errors.filter((e): e is NotebookGroundError => e !== undefined));
  }

  it("egress_denied carries no sentinel content", async () => {
    const { deps } = makeDeps();
    const port = createNotebookLmGround(deps);
    const res = await port.ground(
      makeRequest({
        question: SENTINEL_QUESTION,
        notes: [note("ws-a", "n1", SENTINEL_NOTE_CONTENT)],
        workspace: EMPLOYER,
        egress: egressPolicy({ employerRawEgressAcknowledged: false, rawContentAllowedProcessors: [] }),
      }),
    );
    expect(res.ok).toBe(false);
    const serialized = allErrorsFrom(!res.ok ? res.error : undefined);
    expect(serialized.includes(SENTINEL_NOTE_CONTENT)).toBe(false);
    expect(serialized.includes(SENTINEL_QUESTION)).toBe(false);
    expect(serialized.includes(SENTINEL_CREDENTIAL)).toBe(false);
  });

  it("transport_fault carries no sentinel content (a throwing transport whose Error message embeds the sentinel)", async () => {
    const { transport } = makeFakeTransport({
      ground: (async () => {
        throw new Error(`vendor rejected: ${SENTINEL_QUESTION} / ${SENTINEL_CREDENTIAL}`);
      }) as unknown as NotebookGroundTransport["ground"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);
    const res = await port.ground(
      makeRequest({ question: SENTINEL_QUESTION, notes: [note("ws-a", "n1", SENTINEL_NOTE_CONTENT)] }),
    );
    expect(res.ok).toBe(false);
    const serialized = allErrorsFrom(!res.ok ? res.error : undefined);
    expect(serialized.includes(SENTINEL_NOTE_CONTENT)).toBe(false);
    expect(serialized.includes(SENTINEL_QUESTION)).toBe(false);
    expect(serialized.includes(SENTINEL_CREDENTIAL)).toBe(false);
  });

  it("cleanup_failed carries no sentinel content (only a bare storeRef id)", async () => {
    const failingDelete = vi.fn(
      async (): Promise<Result<void, { readonly message: string }>> =>
        err({ message: `delete rejected near ${SENTINEL_CREDENTIAL}` }),
    );
    const { transport } = makeFakeTransport({
      deleteStore: failingDelete as unknown as NotebookGroundTransport["deleteStore"],
    });
    const { deps } = makeDeps({ transport });
    const port = createNotebookLmGround(deps);
    const res = await port.ground(
      makeRequest({ question: SENTINEL_QUESTION, notes: [note("ws-a", "n1", SENTINEL_NOTE_CONTENT)] }),
    );
    expect(res.ok).toBe(false);
    const serialized = allErrorsFrom(!res.ok ? res.error : undefined);
    expect(serialized.includes(SENTINEL_NOTE_CONTENT)).toBe(false);
    expect(serialized.includes(SENTINEL_QUESTION)).toBe(false);
    expect(serialized.includes(SENTINEL_CREDENTIAL)).toBe(false);
  });
});

// --- 9. purity ------------------------------------------------------------------

describe("createNotebookLmGround — purity (no Date.now / Math.random; clock injected)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/notebook/notebooklm-ground.ts", import.meta.url)),
    "utf8",
  );

  it("the module source contains no Date.now() / Math.random() call", () => {
    expect(src.includes("Date.now(")).toBe(false);
    expect(src.includes("Math.random(")).toBe(false);
  });

  it("the same input twice yields identical keys (identical dispatched canonicalObjectKey/idempotencyKey)", async () => {
    const captured: { canonicalObjectKey: string; idempotencyKey: string }[] = [];
    const { adapter } = makeFakeAdapter();
    const spiedAdapter: TargetWriteAdapter = {
      ...adapter,
      existenceCheck: async (canonicalObjectKey: string, env) => {
        captured.push({ canonicalObjectKey, idempotencyKey: (env as { idempotencyKey: string }).idempotencyKey });
        return adapter.existenceCheck(canonicalObjectKey, env);
      },
    };

    // Two INDEPENDENT deps (separate receipt stores) so both calls hit the
    // create path fresh — proving the BUILT keys are identical, not just that
    // replay reused a receipt.
    const { deps: deps1 } = makeDeps({ adapter: spiedAdapter });
    const { deps: deps2 } = makeDeps({ adapter: spiedAdapter, store: new InMemoryReceiptStore() });
    const port1 = createNotebookLmGround(deps1);
    const port2 = createNotebookLmGround(deps2);

    await port1.ground(makeRequest());
    await port2.ground(makeRequest());

    expect(captured).toHaveLength(2);
    expect(captured[0]!.canonicalObjectKey).toBe(captured[1]!.canonicalObjectKey);
    expect(captured[0]!.idempotencyKey).toBe(captured[1]!.idempotencyKey);
  });
});

// --- 10. dormancy pin -----------------------------------------------------------

describe("createNotebookLmGround — dormant (nothing arms)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/notebook/notebooklm-ground.ts", import.meta.url)),
    "utf8",
  );

  it("no production caller CONSTRUCTS the grounding port (unbound seam)", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("notebooklm-ground.ts"),
    );
    const callers = files.filter((f) =>
      readFileSync(join(srcRoot, f), "utf8").includes("createNotebookLmGround("),
    );
    expect(callers).toEqual([]); // zero production callers
  });

  it("the shipped default binds no transport — no real network/API-key surface in the module", () => {
    for (const forbidden of ["node:https", "node:http", "undici", "fetch(", "process.env"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("the module exports only factories + types — nothing self-executing (no top-level side effect)", () => {
    // A dormant module's exports are all `function`/`interface`/`type`
    // declarations; nothing calls itself at module-evaluation time.
    expect(/^\s*(createNotebookLmGround|deps)\s*\(/m.test(src)).toBe(false);
    expect(src.includes("export const") && src.match(/export const \w+ = create/)).toBeFalsy();
  });
});
