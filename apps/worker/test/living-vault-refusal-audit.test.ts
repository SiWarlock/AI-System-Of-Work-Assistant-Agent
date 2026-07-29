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
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
    } as Awaited<ReturnType<typeof rewriteVaultForSource>>);

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    const out = await adapter(VALIDATED, WS, SOURCE);

    // Verbatim: not re-mapped, not deduped, not truncated — a fix at :122 alone would leave THIS broken.
    expect(out.refusals).toEqual(["structural_surface", "unsafe_shape"]);
  });
});
