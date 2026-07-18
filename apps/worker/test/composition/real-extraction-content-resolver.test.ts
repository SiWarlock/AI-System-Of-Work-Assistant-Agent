// 18.21 — the REAL ExtractionContentResolver (the 18.20 seam): deref an extraction AgentJob's
// contextRefs → the parked sourceId, read SourceEnvelope.body via the durable ParkedSourceReader, and
// return it as the inline text the subscription runner sends as userPrompt. These tests pin:
//   • the happy path derefs the source ContextRef → reads the parked body;
//   • fail-closed typed CODE-ONLY faults (rule 7 — never the content): unresolvable sourceId ⇒
//     source_ref_unresolved (reader never called); reader err ⇒ source_unavailable; empty/absent body
//     ⇒ no_body — NEVER ok("") (the runner would send an empty prompt);
//   • UNIFORM deref for meeting.close + source.process (both park a SourceEnvelope keyed by sourceId);
//   • §16 totality — a reader throw folds to a typed err, no throw escapes;
//   • the fault is code-only — the reader's message (which carries the sourceId) is dropped (rule 7).
//
// DORMANT: no production caller — bound at the owner ENABLE flip (step 6) as
// RealProviderRunnerDeps.subscription.content. Reachability-WAIVERED (L11).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, ContextRef, SourceEnvelope } from "@sow/contracts";
import type { ParkedSourceReader } from "@sow/workflows";
import {
  createRealExtractionContentResolver,
  createReaderHolder,
  createLateBoundParkedReader,
  SOURCE_CONTEXT_REF_KIND,
} from "../../src/composition/real-extraction-content-resolver";

// ── deterministic fixtures ─────────────────────────────────────────────────────
const sourceRef = (sourceId: string): ContextRef => ({ refKind: SOURCE_CONTEXT_REF_KIND, ref: sourceId });

const envelope = (body: string | undefined): SourceEnvelope =>
  ({
    sourceId: "S1",
    workspaceId: "ws-1",
    ...(body !== undefined ? { body } : {}),
  }) as unknown as SourceEnvelope;

const makeJob = (contextRefs: ContextRef[], capability = "source.process"): AgentJob =>
  ({
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-1",
    capability,
    contextRefs,
    outputSchemaId: "sow:agent-extraction",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [] },
    providerRoute: { runtime: "claude-agent-sdk", model: "m", endpoint: "https://api.anthropic.com", egressClass: "cloud" },
    trustLevel: "untrusted",
    carriesRawContent: true,
    maxRuntimeSeconds: 30,
    idempotencyKey: "idem-1",
  }) as unknown as AgentJob;

const okReader = (env: SourceEnvelope, calls: string[] = []): ParkedSourceReader => ({
  read: (sourceId: string) => {
    calls.push(sourceId);
    return Promise.resolve(ok(env));
  },
});
const errReader = (calls: string[] = []): ParkedSourceReader => ({
  read: (sourceId: string) => {
    calls.push(sourceId);
    return Promise.resolve(err({ code: "source_unavailable" as const, message: `parked source ${sourceId} not found` }));
  },
});
const throwingReader = (): ParkedSourceReader => ({
  read: () => Promise.reject(new Error("reader boom sk-canary-secret")),
});

// ── happy path ──────────────────────────────────────────────────────────────────
describe("createRealExtractionContentResolver — deref + read", () => {
  it("resolves_body_from_parked_source — derefs the source ContextRef → reads the parked body [spec(§19.5)]", async () => {
    const calls: string[] = [];
    const resolver = createRealExtractionContentResolver({ reader: okReader(envelope("transcript text"), calls) });
    const res = await resolver.resolve(makeJob([sourceRef("S1")]));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value).toBe("transcript text");
    expect(calls).toEqual(["S1"]); // read keyed on the derefed sourceId
  });

  it.each([
    { capability: "source.process" },
    { capability: "meeting.close" },
  ])("uniform_deref_for_$capability — both park a SourceEnvelope keyed by sourceId (no capability branch) [spec(§9)]", async ({ capability }) => {
    const calls: string[] = [];
    const resolver = createRealExtractionContentResolver({ reader: okReader(envelope("text"), calls) });
    const res = await resolver.resolve(makeJob([sourceRef("S1")], capability));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value).toBe("text");
    expect(calls).toEqual(["S1"]); // same deref path regardless of capability
  });
});

// ── fail-closed typed faults (code-only, rule 7 — never ok("")) ──────────────────
describe("createRealExtractionContentResolver — fail-closed faults", () => {
  it.each([
    { label: "empty_refs", refs: [] as ContextRef[] },
    { label: "no_source_kind", refs: [{ refKind: "other", ref: "X" }] as ContextRef[] },
    // EXACTLY-ONE (WS-8 / no-inference): MULTIPLE source refs are ambiguous — never guess-first.
    { label: "multiple_source_refs", refs: [sourceRef("S1"), sourceRef("S2")] as ContextRef[] },
    // A present-but-empty source `ref` is unresolvable (defense-in-depth; ContextRef.ref is `.min(1)` in
    // validated data, but the resolver receives a raw job).
    { label: "empty_source_ref", refs: [{ refKind: SOURCE_CONTEXT_REF_KIND, ref: "" }] as ContextRef[] },
  ])("source_ref_unresolved_$label_fails_closed — no derivable sourceId ⇒ source_ref_unresolved, reader never called [spec(§16)]", async ({ refs }) => {
    const calls: string[] = [];
    const resolver = createRealExtractionContentResolver({ reader: okReader(envelope("body"), calls) });
    const res = await resolver.resolve(makeJob(refs));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("source_ref_unresolved");
    expect(calls).toHaveLength(0); // never touched the store
  });

  it("workspace_mismatch_fails_closed — the parked envelope's workspace is re-gated against the job (WS-8 read-back) [spec(rule4)]", async () => {
    // ParkedSourceReader.read(sourceId) is NOT workspace-scoped, and the sourceId comes from externally-
    // populated contextRefs — so a smuggled/mis-populated ref could return a DIFFERENT workspace's
    // SourceEnvelope, whose body would then reach the model + commit to the wrong workspace's notes. The
    // resolver re-gates envelope.workspaceId === job.workspaceId (L12/L20/L32) — content NEVER on mismatch.
    const calls: string[] = [];
    const foreign = { sourceId: "S1", workspaceId: "ws-OTHER", body: "another workspace's secret" } as unknown as SourceEnvelope;
    const resolver = createRealExtractionContentResolver({ reader: okReader(foreign, calls) });
    const res = await resolver.resolve(makeJob([sourceRef("S1")])); // job.workspaceId = "ws-1"
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("workspace_mismatch");
    expect(JSON.stringify(res)).not.toContain("another workspace's secret"); // the foreign body never crosses
  });

  it("reader_unavailable_fails_closed — reader err ⇒ source_unavailable [spec(§16)]", async () => {
    const resolver = createRealExtractionContentResolver({ reader: errReader() });
    const res = await resolver.resolve(makeJob([sourceRef("S1")]));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("source_unavailable");
  });

  it.each([
    { label: "absent", body: undefined },
    { label: "empty", body: "" },
  ])("empty_or_absent_body_$label_fails_closed — a present-but-empty/absent body ⇒ no_body, NEVER ok(\"\") [spec(§19.5)]", async ({ body }) => {
    const resolver = createRealExtractionContentResolver({ reader: okReader(envelope(body)) });
    const res = await resolver.resolve(makeJob([sourceRef("S1")]));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_body");
  });

  it("reader_throw_folds_closed — a throwing reader folds to a typed err, no throw escapes (§16 totality)", async () => {
    const resolver = createRealExtractionContentResolver({ reader: throwingReader() });
    // Capture UNCONDITIONALLY (L15) — a resolve-instead-of-throw still hits the asserts.
    const res = await resolver.resolve(makeJob([sourceRef("S1")]));
    expect(isErr(res)).toBe(true); // RESOLVED, not thrown
    if (!isErr(res)) return;
    expect(typeof res.error.code).toBe("string");
    expect(JSON.stringify(res.error)).not.toContain("canary"); // no reader cause echoed (rule 7)
  });

  it("code_only_fault_no_content_leak — the fault carries ONLY the code, never the reader's message/sourceId (rule 7)", async () => {
    const resolver = createRealExtractionContentResolver({
      reader: { read: (sourceId: string) => Promise.resolve(err({ code: "source_unavailable" as const, message: `parked source ${sourceId} not found` })) },
    });
    const res = await resolver.resolve(makeJob([sourceRef("src-canary-secret")]));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error).toEqual({ code: "source_unavailable" }); // reader's message (carries the sourceId) dropped
    expect(JSON.stringify(res.error)).not.toContain("canary");
  });
});

// ── 18.25 step-6 — the reader-holder late-bind (solves the eager-consumption ordering: config.providerTransport
//    is consumed at assembleBackends (backends.ts:809) BEFORE backends.repos.sourceDisposition exists, so the
//    resolver is built over a LATE-BOUND reader whose holder is filled POST-assembly). ─────────────────────
describe("createLateBoundParkedReader — the reader-holder late-bind (18.25 step-6, dormant)", () => {
  it("late_bound_reader_unset_fails_closed — an unfilled holder ⇒ read() returns a typed source_unavailable, no throw (fail-closed) [spec(§19.5)]", async () => {
    const holder = createReaderHolder();
    const reader = createLateBoundParkedReader(holder);
    const res = await reader.read("S1");
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("source_unavailable");
  });

  it("late_bound_reader_delegates_once_filled — the holder filled POST-assembly ⇒ read() delegates verbatim [spec(§19.5)]", async () => {
    const holder = createReaderHolder();
    const reader = createLateBoundParkedReader(holder); // built while the holder is still empty
    const calls: string[] = [];
    holder.reader = okReader(envelope("late-body"), calls); // filled AFTER construction (post-assembleBackends)
    const res = await reader.read("S7");
    expect(calls).toStrictEqual(["S7"]); // delegated to the real reader
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.body).toBe("late-body");
  });

  it("resolver_over_late_bound_reader_resolves_after_fill — the resolver built over the late-bound reader resolves content ONLY after the holder is filled (the whole late-bind chain) [spec(§19.5)]", async () => {
    const holder = createReaderHolder();
    const resolver = createRealExtractionContentResolver({ reader: createLateBoundParkedReader(holder) });
    const job = makeJob([sourceRef("S1")]);
    // Before the holder is filled (pre-arm / pre-assembly bind) ⇒ fail-closed, NEVER ok("").
    const before = await resolver.resolve(job);
    expect(isErr(before)).toBe(true);
    if (isErr(before)) expect(before.error.code).toBe("source_unavailable");
    // Filled post-assembly ⇒ resolves the parked body.
    holder.reader = okReader(envelope("real-body"));
    const after = await resolver.resolve(job);
    expect(isOk(after)).toBe(true);
    if (isOk(after)) expect(after.value).toBe("real-body");
  });
});
