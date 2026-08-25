// spec(13.23 leg B — consumer half) — surface CA-2's three entity-ref signal counts
// (`IngestRewriteReceipt.entityRefsTruncated`/`entityRefsRejected`/`entityRefsWithheldByReason`)
// through a dormant, code-only, best-effort health sink, mirroring the SHAPE of the existing
// refusal-audit channel (`living-vault-refusal-audit.test.ts`, 13.8m-B) exactly: fired ONCE per
// run, ONLY when a signal is non-zero/non-empty, never alters the returned `Result`, never
// escapes as an unhandled rejection, unbound in production today (zero invocations).
//
// Ruled destination is HEALTH, not the audit trail — `toAuditRecordInput` has zero callers and
// building it is task 24.7's scope, which this slice does not touch.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkspaceId } from "@sow/contracts";
import { createLivingVaultPort, createIngestRewriteAdapter } from "../src/composition/living-vault";
import type { ValidatedExtraction, SourceNoteIdentity } from "@sow/workflows/ports/sourceIngestion";

// Hoisted by vitest: replaces the module's `rewriteVaultForSource` for THIS test file only, so
// `adapter_forwards_signal_counts_verbatim` can drive `createIngestRewriteAdapter` over a
// controlled receipt without needing a real gbrain/reason/sections/structural port stack.
vi.mock("@sow/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sow/knowledge")>();
  return { ...actual, rewriteVaultForSource: vi.fn() };
});

const WS = "ws-employer" as WorkspaceId;
const SOURCE: SourceNoteIdentity = { sourceId: "src-1" as never, contentHash: "hash-1" };
const VALIDATED = { fields: {} } as unknown as ValidatedExtraction;

let vaultRoot = "";

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "sow-vault-signals-"));
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

describe("living-vault entity-ref signal-count health sink (13.23 leg B consumer)", () => {
  it("adapter_forwards_signal_counts_verbatim — createIngestRewriteAdapter carries all three unchanged", async () => {
    const { rewriteVaultForSource } = await import("@sow/knowledge");
    vi.mocked(rewriteVaultForSource).mockResolvedValueOnce({
      runId: "run-1",
      plans: [],
      planIds: [],
      autoCount: 0,
      proposeCount: 0,
      refusals: [],
      entityRefsTruncated: 7,
      entityRefsRejected: 3,
      entityRefsWithheldByReason: { ambiguous: 2, gbrain_unavailable: 1 },
    } as Awaited<ReturnType<typeof rewriteVaultForSource>>);

    const adapter = createIngestRewriteAdapter(
      {} as unknown as Parameters<typeof createIngestRewriteAdapter>[0],
    );
    const out = await adapter(VALIDATED, WS, SOURCE);

    expect(out.entityRefsTruncated).toBe(7);
    expect(out.entityRefsRejected).toBe(3);
    expect(out.entityRefsWithheldByReason).toEqual({ ambiguous: 2, gbrain_unavailable: 1 });
  });

  it("health_sink_fires_once_when_any_signal_is_non_zero — a non-zero truncated count fires exactly one code-only signal", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () =>
        Promise.resolve({
          plans: [plan("notes/a.md")],
          refusals: [],
          entityRefsTruncated: 2,
          entityRefsRejected: 0,
          entityRefsWithheldByReason: {},
        }),
      recordEntityRefSignals: (h) => {
        calls.push(h);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    expect(calls).toEqual([{ workspaceId: WS, truncated: 2, rejected: 0, withheldByReason: {} }]);
  });

  it("benign_run_never_invokes_the_health_sink — all three zero/empty ⇒ zero invocations (mandatory positive control)", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      rewrite: () =>
        Promise.resolve({
          plans: [plan("notes/a.md")],
          refusals: [],
          entityRefsTruncated: 0,
          entityRefsRejected: 0,
          entityRefsWithheldByReason: {},
        }),
      recordEntityRefSignals: (h) => {
        calls.push(h);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    // Positive control: `health_sink_fires_once_when_any_signal_is_non_zero` (same sink wiring,
    // one field flipped non-zero) proves the sink DOES fire when there is a signal — so this
    // zero invocation count is a real discrimination, not a channel that never fires at all.
    expect(calls).toHaveLength(0);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  it("a_throwing_or_rejecting_sink_never_alters_the_result — sync-throw and async-reject are both swallowed", async () => {
    const throwingPort = createLivingVaultPort({
      vaultRoot,
      rewrite: () =>
        Promise.resolve({
          plans: [plan("notes/a.md")],
          refusals: [],
          entityRefsTruncated: 1,
          entityRefsRejected: 0,
          entityRefsWithheldByReason: {},
        }),
      recordEntityRefSignals: (): Promise<unknown> => {
        throw new Error("sink exploded");
      },
    });
    const throwResult = await throwingPort.rewrite(VALIDATED, WS, SOURCE);
    expect(isOk(throwResult)).toBe(true);
    if (isOk(throwResult)) expect(throwResult.value).toHaveLength(1);

    const rejectingPort = createLivingVaultPort({
      vaultRoot,
      rewrite: () =>
        Promise.resolve({
          plans: [plan("notes/a.md")],
          refusals: [],
          entityRefsTruncated: 0,
          entityRefsRejected: 1,
          entityRefsWithheldByReason: {},
        }),
      recordEntityRefSignals: () => Promise.reject(new Error("sink rejected")),
    });
    const rejectResult = await rejectingPort.rewrite(VALIDATED, WS, SOURCE);
    expect(isOk(rejectResult)).toBe(true);
    // Give the rejected promise's microtask a turn; an unhandled rejection would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("payload_is_code_only — the sink payload carries only the workspace id, numbers, and a reason-code map (rule 7)", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      // The touched note path + vault root are present elsewhere in the run but must never reach
      // the health payload — only `notes/a.md`'s SIBLING withheld-reason counts may.
      rewrite: () =>
        Promise.resolve({
          plans: [plan("notes/secret-entity-name.md")],
          refusals: [],
          entityRefsTruncated: 4,
          entityRefsRejected: 2,
          entityRefsWithheldByReason: { ambiguous: 1, ws_scope_mismatch: 1 },
        }),
      recordEntityRefSignals: (h) => {
        calls.push(h);
        return Promise.resolve();
      },
    });

    await port.rewrite(VALIDATED, WS, SOURCE);

    expect(calls).toHaveLength(1);
    const payload = calls[0] as {
      workspaceId: WorkspaceId;
      truncated: number;
      rejected: number;
      withheldByReason: Record<string, number>;
    };
    expect(Object.keys(payload).sort()).toEqual(["rejected", "truncated", "withheldByReason", "workspaceId"]);
    expect(typeof payload.truncated).toBe("number");
    expect(typeof payload.rejected).toBe("number");
    expect(Object.keys(payload.withheldByReason).sort()).toEqual(["ambiguous", "ws_scope_mismatch"]);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("secret-entity-name");
    expect(serialized).not.toContain("notes/");
    expect(serialized).not.toContain(vaultRoot);
  });

  it("an_old_shaped_fake_degrades_silently — a producer omitting the three fields degrades to zeros, fires the sink zero times", async () => {
    const calls: unknown[] = [];
    const port = createLivingVaultPort({
      vaultRoot,
      // Old-shaped fake: no entityRefsTruncated/entityRefsRejected/entityRefsWithheldByReason at all.
      rewrite: () => Promise.resolve({ plans: [plan("notes/a.md")], refusals: [] }),
      recordEntityRefSignals: (h) => {
        calls.push(h);
        return Promise.resolve();
      },
    });

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
