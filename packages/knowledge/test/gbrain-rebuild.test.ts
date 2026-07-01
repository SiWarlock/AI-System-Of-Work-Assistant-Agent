// spec(§6) — rebuild-from-Markdown (task 4.9, REQ-D-001). A full re-index
// reconstructs the semantic node set from committed Markdown ALONE via the
// gbrain-INDEPENDENT CanonicalFactDeriver (4.14), proving GBrain is disposable /
// derived: the rebuilt brain recovers exactly the nodes recoverable from canonical
// Markdown and NOTHING else. Because the rebuild is a WHOLESALE replace of the
// derived store, a quarantined DB-only fact (no Markdown bytes) cannot survive a
// rebuild — it is structurally absent, so it never silently re-enters retrieval as
// authoritative. Fail-closed: a non-replacing rebuild, an incomplete recovery, a
// stale snapshot, a derive failure, or a client fault all yield a typed error +
// a distinct rebuild_divergence System-Health item. Never throws across the boundary.
import { describe, it, expect } from "vitest";
import { HealthItemSchema } from "@sow/contracts";
import type { WorkspaceId, RevisionId, Result } from "@sow/contracts";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import type { CanonicalVaultSnapshot } from "../src/gbrain/derive/canonical-fact-deriver";
import { deriveCanonicalFacts } from "../src/gbrain/derive/canonical-fact-deriver";
import {
  rebuildIndexFromMarkdown,
  type IndexRebuildClient,
  type IndexRebuildRequest,
  type IndexRebuildReceipt,
  type IndexRebuildError,
  type RebuildDeps,
} from "../src/gbrain/rebuild";

const NOW = "2026-07-01T00:00:00.000Z";
const WS = "ws-1" as WorkspaceId;

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  const map = new Map(Object.entries(files));
  return { workspaceId: WS, revisionId: computeRevisionId(map) as RevisionId, files: map };
}

const twoPages = () =>
  snapshot({
    "alpha.md": "# Alpha\n\nLinks to [[beta]].\n",
    "beta.md": "---\ntags: work\n---\n# Beta\n\nBody.\n",
  });

/** A fake full-replace rebuild client that records the request it received. */
class FakeRebuildClient implements IndexRebuildClient {
  received?: IndexRebuildRequest;
  constructor(
    private readonly outcome: (req: IndexRebuildRequest) => Result<IndexRebuildReceipt, IndexRebuildError>,
    private readonly throwOn = false,
  ) {}
  async rebuildFromMarkdown(
    req: IndexRebuildRequest,
  ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
    this.received = req;
    if (this.throwOn) throw new Error("client blew up");
    return this.outcome(req);
  }
}

function okReceipt(req: IndexRebuildRequest, overrides: Partial<IndexRebuildReceipt> = {}): IndexRebuildReceipt {
  return {
    workspaceId: req.workspaceId,
    revisionId: req.revisionId,
    nodeCount: req.facts.length,
    replaced: true,
    ...overrides,
  };
}

function deps(client: IndexRebuildClient, overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    rebuildClient: client,
    now: () => NOW,
    newHealthItemId: () => "health-rebuild-1",
    auditRef: "audit-rebuild-1",
    ...overrides,
  };
}

// ── happy path ───────────────────────────────────────────────────────────────

describe("rebuildIndexFromMarkdown — reconstruct from Markdown alone", () => {
  it("re-derives from committed Markdown, replaces the index, and recovers every derivable node", async () => {
    const snap = twoPages();
    const derived = deriveCanonicalFacts(snap);
    if (!derived.ok) throw new Error("fixture derive failed");
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

    const out = await rebuildIndexFromMarkdown(snap, deps(client));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.recoveredNodeCount).toBe(derived.value.facts.length);
    expect(out.value.receipt.replaced).toBe(true);
    // The client was handed the gbrain-independent derived fact set (full replace).
    expect(client.received?.facts.length).toBe(derived.value.facts.length);
  });

  it("recovers ONLY Markdown-derivable nodes — a DB-only fact is not reconstructed (gbrain is disposable)", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));
    const out = await rebuildIndexFromMarkdown(snap, deps(client));

    expect(out.ok).toBe(true);
    // No fact whose slug has no Markdown backing appears in the rebuilt set.
    const ids = (client.received?.facts ?? []).map((f) => f.fact.factIdentity);
    expect(ids).not.toContain("page:ghost");
    expect(ids.every((id) => id.startsWith("page:") || id.startsWith("link:") || id.startsWith("tag:"))).toBe(true);
  });
});

// ── fail-closed ─────────────────────────────────────────────────────────────

describe("rebuildIndexFromMarkdown — fail-closed", () => {
  it("rejects a NON-replacing rebuild (a merge could resurrect a quarantined DB-only fact)", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req, { replaced: false }) }));
    const out = await rebuildIndexFromMarkdown(snap, deps(client));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("non_replacing_rebuild");
    expect(out.error.healthItem.failureClass).toBe("rebuild_divergence");
    expect(HealthItemSchema.safeParse(out.error.healthItem).success).toBe(true);
  });

  it("rejects an incomplete recovery (rebuilt node count != derivable node count)", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req, { nodeCount: req.facts.length - 1 }) }));
    const out = await rebuildIndexFromMarkdown(snap, deps(client));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("incomplete_recovery");
    expect(out.error.healthItem.failureClass).toBe("rebuild_divergence");
  });

  it("converts a rebuild-client err into a typed failure (no throw across the boundary)", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient(() => ({
      ok: false,
      error: { code: "gbrain_unavailable", message: "down" },
    }));
    const out = await rebuildIndexFromMarkdown(snap, deps(client));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("rebuild_client_failed");
  });

  it("catches a THROWING rebuild client and returns a typed failure", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }), true);
    const out = await rebuildIndexFromMarkdown(snap, deps(client));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("rebuild_client_failed");
  });

  it("fails closed on a derive error (never asks the rebuild client to write a bad set)", async () => {
    // A path of ".md" derives an empty slug → invalid_page_path (deriver err).
    const bad = snapshot({ ".md": "# no slug\n" });
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));
    const out = await rebuildIndexFromMarkdown(bad, deps(client));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("derive_failed");
    expect(client.received).toBeUndefined();
  });

  it("guards against a stale snapshot when an expected revision is supplied", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));
    const out = await rebuildIndexFromMarkdown(snap, deps(client, { expectedRevisionId: "revision-does-not-match" }));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("stale_revision");
    expect(client.received).toBeUndefined();
  });
});
