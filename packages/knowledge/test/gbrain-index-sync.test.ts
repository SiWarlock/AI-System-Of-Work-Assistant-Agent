// spec(§6) — GBrain index/sync apply (task 4.8): consume a post-commit index job
// (4.4 outbox entry keyed by (workspaceId, revisionId)) and re-derive the index
// from the CURRENT committed Markdown identified by that revision id — GBrain is
// DERIVED, Markdown is the source (REQ-D-001). Idempotent per (workspaceId,
// revisionId): re-running yields an identical index state with no duplicate nodes
// and advances gbrain_sync_queued → indexed. A persistent apply/load failure
// surfaces sync_lagging in System Health (§16) and leaves the entry retryable via
// the 4.4 outbox. The apply never writes back into Markdown and never becomes a
// source of truth; it never throws across the boundary (§16).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, workspaceId } from "@sow/contracts";
import type { RevisionId as ContractsRevisionId } from "@sow/contracts";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import type { RevisionId } from "../src/knowledge-writer/revision";
import { buildSyncOutboxEntry } from "../src/knowledge-writer/sync-outbox";
import type { GbrainSyncOutboxEntry } from "../src/knowledge-writer/sync-outbox";
import type { CanonicalVaultSnapshot } from "../src/gbrain/derive/canonical-fact-deriver";
import { deriveCanonicalFacts } from "../src/gbrain/derive/canonical-fact-deriver";
import {
  applyGbrainIndexJob,
  toIndexDispatcher,
} from "../src/gbrain/index-sync";
import type {
  CanonicalMarkdownSource,
  IndexApplyClient,
  IndexApplyRequest,
  IndexApplyError,
  GbrainIndexSyncDeps,
} from "../src/gbrain/index-sync";
import { MemoryGbrainSyncOutbox } from "./sync-outbox-fake";

const WS = "ws-employer";
const NOW = "2026-07-01T00:00:00.000Z";

// ── fixtures ────────────────────────────────────────────────────────────────

const PAGES: Record<string, string> = {
  "acme-api/auth.md":
    "---\nslug: auth\ntags: security, auth\n---\n# Auth\nSee [[oauth]] for the flow.\n",
  "acme-api/oauth.md": "---\nslug: oauth\n---\n# OAuth\nDetails here.\n",
};

function snapshotOf(files: Record<string, string>): {
  snapshot: CanonicalVaultSnapshot;
  revId: RevisionId;
} {
  const map = new Map(Object.entries(files));
  const revId = computeRevisionId(map);
  const snapshot: CanonicalVaultSnapshot = {
    workspaceId: workspaceId(WS),
    revisionId: revId as unknown as ContractsRevisionId,
    files: map,
  };
  return { snapshot, revId };
}

function queuedEntry(revId: RevisionId, enqueuedAt: string = NOW): GbrainSyncOutboxEntry {
  return buildSyncOutboxEntry({
    workspaceId: WS,
    revisionId: revId,
    planId: "plan-1",
    auditRef: "audit-commit-1",
    enqueuedAt,
  });
}

// ── injected doubles (real ports, not behavior mocks) ────────────────────────

class FakeMarkdownSource implements CanonicalMarkdownSource {
  readonly loadCalls: Array<{ workspaceId: string; revisionId: string }> = [];
  fault = false;
  missing = false;
  constructor(private readonly snapshot: CanonicalVaultSnapshot) {}
  async loadSnapshot(ws: string, rev: string) {
    this.loadCalls.push({ workspaceId: ws, revisionId: rev });
    if (this.fault) {
      return err({ code: "source_fault" as const, message: "vault unavailable" });
    }
    if (this.missing) {
      return err({
        code: "revision_unavailable" as const,
        revisionId: rev,
        message: "no such revision",
      });
    }
    return ok(this.snapshot);
  }
}

function sameNodes(a: Map<string, string> | undefined, b: Map<string, string>): boolean {
  if (a === undefined || a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

class FakeIndexClient implements IndexApplyClient {
  readonly applyCalls: IndexApplyRequest[] = [];
  /** ws → (factIdentity → mdContentSha): a real derived index keyed by identity. */
  readonly index = new Map<string, Map<string, string>>();
  readonly revByWs = new Map<string, string>();
  fail: IndexApplyError | null = null;
  throwOnApply = false;

  async applyRevision(req: IndexApplyRequest) {
    this.applyCalls.push(req);
    if (this.throwOnApply) throw new Error("client boom");
    if (this.fail) return err(this.fail);
    const nodes = new Map<string, string>();
    for (const df of req.facts) {
      nodes.set(df.fact.factIdentity as unknown as string, df.fact.mdContentSha);
    }
    const prevRev = this.revByWs.get(req.workspaceId);
    const mutated =
      prevRev !== req.revisionId || !sameNodes(this.index.get(req.workspaceId), nodes);
    this.index.set(req.workspaceId, nodes);
    this.revByWs.set(req.workspaceId, req.revisionId);
    return ok({
      workspaceId: req.workspaceId,
      revisionId: req.revisionId,
      nodeCount: nodes.size,
      mutated,
    });
  }
}

function deps(
  source: CanonicalMarkdownSource,
  indexClient: IndexApplyClient,
  outbox: MemoryGbrainSyncOutbox,
): GbrainIndexSyncDeps {
  let n = 0;
  return {
    snapshotSource: source,
    indexClient,
    outbox,
    now: () => NOW,
    newHealthItemId: () => `health-index-${(n += 1)}`,
  };
}

// ── re-derive from current Markdown; advance to indexed ───────────────────────

describe("applyGbrainIndexJob — re-derive from committed Markdown", () => {
  it("loads current Markdown by revision id, derives the index, and advances gbrain_sync_queued → indexed", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();
    await outbox.enqueue(queuedEntry(revId));

    const outcome = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));

    expect(outcome.kind).toBe("indexed");
    expect(outcome.mutationState).toBe("indexed");
    // re-derived from the CURRENT Markdown identified by this revision id
    expect(source.loadCalls).toEqual([{ workspaceId: WS, revisionId: revId }]);

    // the applied node set is EXACTLY what the pure deriver produces from Markdown
    const derived = deriveCanonicalFacts(snapshot);
    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    const expectedIds = derived.value.facts
      .map((f) => f.fact.factIdentity as unknown as string)
      .sort();
    const appliedIds = client.applyCalls[0]!.facts
      .map((f) => f.fact.factIdentity as unknown as string)
      .sort();
    expect(appliedIds).toEqual(expectedIds);
    expect(outcome.receipt?.nodeCount).toBe(derived.value.facts.length);

    // durable entry advanced to indexed
    const stored = await outbox.getByKey(WS, revId);
    expect(isOk(stored) && stored.value?.status).toBe("indexed");
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────

describe("applyGbrainIndexJob — idempotent per (workspaceId, revisionId)", () => {
  it("short-circuits an already-indexed entry (no re-derive, no re-apply)", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();

    const indexed: GbrainSyncOutboxEntry = { ...queuedEntry(revId), status: "indexed" };
    const outcome = await applyGbrainIndexJob(indexed, deps(source, client, outbox));

    expect(outcome.kind).toBe("already_indexed");
    expect(outcome.mutationState).toBe("indexed");
    expect(source.loadCalls).toEqual([]); // terminal is frozen — no work
    expect(client.applyCalls).toEqual([]);
  });

  it("re-running the same job yields an identical index state with no duplicate nodes", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();

    const first = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));
    expect(first.kind).toBe("indexed");
    const firstCount = client.index.get(WS)!.size;

    // simulate a drain that lost the persisted status (entry still queued): the
    // apply must be a no-op set-replace — same node count, mutated=false.
    const second = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));
    expect(second.kind).toBe("indexed");
    expect(client.index.get(WS)!.size).toBe(firstCount); // no duplicate nodes
    expect(client.applyCalls[1]!.facts.length).toBe(client.applyCalls[0]!.facts.length);
    expect(second.receipt?.mutated).toBe(false);
  });
});

// ── failure → sync_lagging, retryable ─────────────────────────────────────────

describe("applyGbrainIndexJob — failure surfaces sync_lagging + stays retryable", () => {
  it("degrades to sync_lagging with a distinct HealthItem when the index apply fails", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    client.fail = { code: "gbrain_unavailable", message: "sidecar down" };
    const outbox = new MemoryGbrainSyncOutbox();
    await outbox.enqueue(queuedEntry(revId));

    const outcome = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));

    expect(outcome.kind).toBe("lagging");
    expect(outcome.mutationState).toBe("sync_lagging");
    expect(outcome.healthItem?.failureClass).toBe("sync_lagging");
    expect(outcome.healthItem?.state).toBe("open");
    expect(outcome.healthItem?.auditRef).toBe("audit-commit-1");
    expect(outcome.entry.status).toBe("sync_lagging");
    expect(outcome.entry.attempts).toBe(1);
    // still durably present for retry
    const stored = await outbox.getByKey(WS, revId);
    expect(isOk(stored) && stored.value?.status).toBe("sync_lagging");
  });

  it("never throws even when the injected index client throws — degrades to sync_lagging", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    client.throwOnApply = true;
    const outbox = new MemoryGbrainSyncOutbox();

    const outcome = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));
    expect(outcome.kind).toBe("lagging");
    expect(outcome.healthItem?.failureClass).toBe("sync_lagging");
  });

  it("degrades to sync_lagging when the Markdown snapshot cannot be loaded (no apply attempted)", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const source = new FakeMarkdownSource(snapshot);
    source.fault = true;
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();

    const outcome = await applyGbrainIndexJob(queuedEntry(revId), deps(source, client, outbox));
    expect(outcome.kind).toBe("lagging");
    expect(outcome.healthItem?.failureClass).toBe("sync_lagging");
    expect(client.applyCalls).toEqual([]); // never indexed stale/absent Markdown
  });
});

// ── no stale-revision indexing (LIFE-6) / never a byte source ─────────────────

describe("applyGbrainIndexJob — no stale-revision indexing", () => {
  it("refuses to apply when the loaded snapshot does not hash to the job's revision id", async () => {
    const { snapshot } = snapshotOf(PAGES);
    // job names a revision the loaded snapshot does NOT match → stale/byte-source
    // guard trips; we never index content that isn't the named committed Markdown.
    const source = new FakeMarkdownSource(snapshot);
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();
    const bogus = queuedEntry("rev:not-the-real-hash" as RevisionId);

    const outcome = await applyGbrainIndexJob(bogus, deps(source, client, outbox));
    expect(outcome.kind).toBe("lagging");
    expect(client.applyCalls).toEqual([]);
  });
});

// ── monotonic high-water guard (no out-of-order regression) ───────────────────

describe("applyGbrainIndexJob — monotonic high-water guard", () => {
  // Distinct committed states with distinct content hashes and distinct enqueue times.
  const OLDER = snapshotOf({ "acme-api/old.md": "---\nslug: old\n---\n# Old\n" });
  const CURRENT = snapshotOf(PAGES);
  const NEWER = snapshotOf({
    "acme-api/new.md": "---\nslug: new\n---\n# New\n",
    "acme-api/extra.md": "---\nslug: extra\n---\n# Extra\n",
  });
  const T_OLDER = "2026-07-01T00:00:00.000Z";
  const T_CURRENT = "2026-07-02T00:00:00.000Z";
  const T_NEWER = "2026-07-03T00:00:00.000Z";

  it("supersedes an out-of-order OLDER apply after a NEWER revision is indexed (no re-apply, no regress); a genuine forward apply still indexes", async () => {
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();

    // rev N (CURRENT) applied + indexed → high-water = N.
    const nOutcome = await applyGbrainIndexJob(
      queuedEntry(CURRENT.revId, T_CURRENT),
      deps(new FakeMarkdownSource(CURRENT.snapshot), client, outbox),
    );
    expect(nOutcome.kind).toBe("indexed");
    expect(client.revByWs.get(WS)).toBe(CURRENT.revId);
    const applyCallsAfterN = client.applyCalls.length;

    // rev N-1 (OLDER, earlier enqueuedAt) arrives out of order → SUPERSEDED, no re-apply.
    const olderOutcome = await applyGbrainIndexJob(
      queuedEntry(OLDER.revId, T_OLDER),
      deps(new FakeMarkdownSource(OLDER.snapshot), client, outbox),
    );
    expect(olderOutcome.kind).toBe("superseded");
    expect(olderOutcome.mutationState).toBe("indexed");
    expect(olderOutcome.receipt).toBeUndefined();
    expect(client.applyCalls.length).toBe(applyCallsAfterN); // applyRevision NOT called for N-1
    expect(client.revByWs.get(WS)).toBe(CURRENT.revId); // served pointer did not regress
    // the older entry is still advanced to the frozen `indexed` terminal (not left retrying).
    const storedOlder = await outbox.getByKey(WS, OLDER.revId);
    expect(isOk(storedOlder) && storedOlder.value?.status).toBe("indexed");

    // rev N+1 (NEWER, later enqueuedAt) is a legitimate FORWARD apply → still indexes normally.
    const newerOutcome = await applyGbrainIndexJob(
      queuedEntry(NEWER.revId, T_NEWER),
      deps(new FakeMarkdownSource(NEWER.snapshot), client, outbox),
    );
    expect(newerOutcome.kind).toBe("indexed");
    expect(client.applyCalls.length).toBe(applyCallsAfterN + 1); // client CALLED for N+1
    expect(client.revByWs.get(WS)).toBe(NEWER.revId); // pointer advanced forward
  });

  it("fails closed to sync_lagging when the high-water query faults (cannot prove non-regression)", async () => {
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();
    outbox.failIndexedHighWater = true;

    const outcome = await applyGbrainIndexJob(
      queuedEntry(CURRENT.revId, T_CURRENT),
      deps(new FakeMarkdownSource(CURRENT.snapshot), client, outbox),
    );
    expect(outcome.kind).toBe("lagging");
    expect(outcome.mutationState).toBe("sync_lagging");
    expect(client.applyCalls).toEqual([]); // never applied without a proven high-water
  });
});

// ── wiring into the 4.4 dispatch seam ─────────────────────────────────────────

describe("toIndexDispatcher — wires the 4.8 apply into the 4.4 trigger seam", () => {
  it("returns ok(void) when the index job indexes, err when it lags", async () => {
    const { snapshot, revId } = snapshotOf(PAGES);
    const client = new FakeIndexClient();
    const outbox = new MemoryGbrainSyncOutbox();
    const okDispatch = toIndexDispatcher(deps(new FakeMarkdownSource(snapshot), client, outbox));
    const r1 = await okDispatch(queuedEntry(revId));
    expect(isOk(r1)).toBe(true);

    const failing = new FakeIndexClient();
    failing.fail = { code: "gbrain_unavailable", message: "down" };
    const badDispatch = toIndexDispatcher(
      deps(new FakeMarkdownSource(snapshot), failing, new MemoryGbrainSyncOutbox()),
    );
    const r2 = await badDispatch(queuedEntry(revId));
    expect(isOk(r2)).toBe(false);
    if (!isOk(r2)) expect(r2.error.code).toBe("gbrain_unavailable");
  });
});
