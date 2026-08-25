// spec(§6 KN-7 "rejected AND audited"; safety rule 7; 13.8m-B) — the SOURCE-path refusal channel
// reaches an operator-visible signal instead of being dropped at the two seams that used to discard it
// (`living-vault.ts:122` inside `createLivingVaultPort`, and `:217` inside `createIngestRewriteAdapter`).
// SOURCE PATH ONLY — the meeting path has no producer field yet (13.8m-C, knowledge-side, not this slice).
//
// The highest-value test here is `refused_then_containment_rejected_still_surfaces`: a run that is
// refused AND THEN rejected by containment must still report its refusals — the worker-side analog of
// the producer's own hoisted-accumulator reasoning (`ingest-rewrite.ts:112-115`). A fault after
// admission must not discard what was already refused, or a hostile run that hijacks paths and then
// trips a later guard becomes byte-identical to a benign one again.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkspaceId } from "@sow/contracts";
import { createLivingVaultPort, createIngestRewriteAdapter } from "../src/composition/living-vault";
import type { ValidatedExtraction, SourceNoteIdentity } from "@sow/workflows/ports/sourceIngestion";

// Hoisted by vitest: replaces the module's `rewriteVaultForSource` for THIS test file only, so
// `adapter_forwards_refusals_verbatim` can drive `createIngestRewriteAdapter` over a controlled receipt
// without needing a real gbrain/reason/sections/structural port stack.
vi.mock("@sow/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sow/knowledge")>();
  return { ...actual, rewriteVaultForSource: vi.fn() };
});

const WS = "ws-employer" as WorkspaceId;
const SOURCE: SourceNoteIdentity = { sourceId: "src-1" as never, contentHash: "hash-1" };
const VALIDATED = { fields: {} } as unknown as ValidatedExtraction;

let vaultRoot = "";

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "sow-vault-refusal-"));
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function plan(path: string): KnowledgeMutationPlan {
  return {
    planId: "lv-plan-1",
    workspaceId: WS,
    creates: [{ path, body: "# note\n" }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    sourceRefs: [],
    requiresApproval: false,
  } as unknown as KnowledgeMutationPlan;
}

describe("living-vault refusal audit (13.8m-B)", () => {
  it("refusals_reach_the_sink_code_only — a non-empty refusal set fires exactly one code-only signal", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () => Promise.resolve({ plans: [plan("notes/a.md")], refusals: ["structural_surface"] }),
      recordRefusals: (audit) => {
        calls.push(audit);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    expect(calls).toEqual([{ workspaceId: WS, codes: ["structural_surface"] }]);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("notes/a.md");
    expect(serialized).not.toContain(vaultRoot);
  });

  it("benign_empty_run_invokes_no_sink — refusals: [] stays quiet, Result unchanged", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () => Promise.resolve({ plans: [plan("notes/a.md")], refusals: [] }),
      recordRefusals: (audit) => {
        calls.push(audit);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(calls).toHaveLength(0);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  it("refused_then_containment_rejected_still_surfaces — an escaping plan still surfaces its refusals", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      // Lexical `..` traversal: rejected by containment before any fs touch, no symlink fixture needed.
      rewrite: () => Promise.resolve({ plans: [plan("../outside.md")], refusals: ["unsafe_shape"] }),
      recordRefusals: (audit) => {
        calls.push(audit);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("path_escape");
    expect(calls).toEqual([{ workspaceId: WS, codes: ["unsafe_shape"] }]);
  });

  it("sink_throw_does_not_alter_the_result — a synchronously-throwing sink is swallowed", async () => {
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () => Promise.resolve({ plans: [plan("notes/a.md")], refusals: ["structural_surface"] }),
      recordRefusals: (): Promise<unknown> => {
        throw new Error("sink exploded");
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  it("sink_rejection_does_not_alter_the_result — a rejecting-promise sink is swallowed, no unhandled rejection", async () => {
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () => Promise.resolve({ plans: [plan("notes/a.md")], refusals: ["structural_surface"] }),
      recordRefusals: () => Promise.reject(new Error("sink rejected")),
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    // Give the rejected promise's microtask a turn; an unhandled rejection would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("unbound_sink_is_byte_equivalent — recordRefusals omitted ⇒ same Result, no other factory invoked", async () => {
    let rewriteInvocations = 0;
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () => {
        rewriteInvocations += 1;
        return Promise.resolve({ plans: [plan("notes/a.md")], refusals: ["structural_surface"] });
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
    expect(rewriteInvocations).toBe(1); // the rewrite itself runs once; no recordRefusals to invoke
  });

  it("adapter_forwards_refusals_verbatim — createIngestRewriteAdapter crosses :217 unmodified", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce({
      runId: "run-1",
      plans: [],
      planIds: [],
      autoCount: 0,
      proposeCount: 0,
      refusals: ["structural_surface", "unsafe_shape"],
      // 13.23 leg B (producer) added these three REQUIRED fields to IngestRewriteReceipt after this
      // test was written; this test exercises `refusals` only, so they carry benign zero/empty
      // values here (a compile-break-forced touch, not a scope change — see CA-3's living-vault
      // -health-signals.test.ts for the tests that pin these fields' behavior).
      entityRefsTruncated: 0,
      entityRefsRejected: 0,
      entityRefsWithheldByReason: {},
    } as Awaited<ReturnType<typeof rewriteVaultForSource>>);

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    const out = await adapter(VALIDATED, WS, SOURCE);

    // Verbatim: not re-mapped, not deduped, not truncated — a fix at :122 alone would leave THIS broken.
    expect(out.refusals).toEqual(["structural_surface", "unsafe_shape"]);
  });
});

// ── ARM-RESEARCH-2 — createIngestRewriteAdapter threads the validated extraction's entity context ──
describe("createIngestRewriteAdapter — ARM-RESEARCH-2: linkCandidates/confidence/date threaded from validated", () => {
  // The module-level mock is never globally cleared (this file's own convention, see the header
  // comment) and the sibling `adapter_forwards_refusals_verbatim` test above already invoked it —
  // clear THIS describe block's call history so `mock.calls[0]` always means "this test's own call."
  beforeEach(async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockClear();
  });

  function emptyReceipt() {
    return {
      runId: "run-1",
      plans: [],
      planIds: [],
      autoCount: 0,
      proposeCount: 0,
      refusals: [],
      entityRefsTruncated: 0,
      entityRefsRejected: 0,
      entityRefsWithheldByReason: {},
    };
  }

  it("two_link_candidates_and_a_date_reach_the_planner — today's gap: the adapter carried neither", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce(
      emptyReceipt() as Awaited<ReturnType<typeof rewriteVaultForSource>>,
    );

    const candidateA = { path: "projects/acme.md", slug: "acme", workspaceId: WS };
    const candidateB = { path: "people/jane-doe.md", slug: "jane-doe", workspaceId: WS };
    const validatedWithContext = {
      validated: true,
      fields: {
        linkCandidates: { value: [candidateA, candidateB] },
        date: { value: "2026-08-24" },
      },
    } as unknown as ValidatedExtraction;

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    await adapter(validatedWithContext, WS, SOURCE);

    expect(vi.mocked(rewriteVaultForSource)).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(rewriteVaultForSource).mock.calls[0]!;
    expect(input).toMatchObject({
      linkCandidates: [candidateA, candidateB],
      date: "2026-08-24",
    });
  });

  it("a_numeric_confidence_field_reaches_the_planner", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce(
      emptyReceipt() as Awaited<ReturnType<typeof rewriteVaultForSource>>,
    );

    const validatedWithConfidence = {
      validated: true,
      fields: { confidence: { value: 0.85 } },
    } as unknown as ValidatedExtraction;

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    await adapter(validatedWithConfidence, WS, SOURCE);

    const [input] = vi.mocked(rewriteVaultForSource).mock.calls[0]!;
    expect(input).toMatchObject({ confidence: 0.85 });
  });

  it("an_empty_or_malformed_validated_extraction_degrades_to_undefined — never a crash, never a guess", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce(
      emptyReceipt() as Awaited<ReturnType<typeof rewriteVaultForSource>>,
    );

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    await adapter(VALIDATED, WS, SOURCE); // VALIDATED = { fields: {} } — today's fixture, unchanged

    const [input] = vi.mocked(rewriteVaultForSource).mock.calls[0]!;
    expect(input).toMatchObject({
      linkCandidates: undefined,
      confidence: undefined,
      date: undefined,
    });
  });

  it("malformed_linkCandidates_elements_are_dropped_not_guessed — a hostile/malformed candidate never fabricates a note path", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce(
      emptyReceipt() as Awaited<ReturnType<typeof rewriteVaultForSource>>,
    );

    const wellFormed = { path: "projects/acme.md", slug: "acme", workspaceId: WS };
    const hostile = { path: "", slug: "x", workspaceId: WS }; // empty path — not a valid candidate
    const validatedHostile = {
      validated: true,
      fields: { linkCandidates: { value: [wellFormed, hostile, "not-an-object", 42, null] } },
    } as unknown as ValidatedExtraction;

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    await adapter(validatedHostile, WS, SOURCE);

    const [input] = vi.mocked(rewriteVaultForSource).mock.calls[0]!;
    expect(input).toMatchObject({ linkCandidates: [wellFormed] });
  });
});
