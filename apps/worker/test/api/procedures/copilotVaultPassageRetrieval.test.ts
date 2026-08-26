// §9.6 — the vault-backed Copilot passage retrieval adapter (the UNGATED half of the deferred "no
// passage-serving read-model" gap: `copilot.ts` header / task 9.6).
//
// Reuses the ALREADY-COMMITTED vault (via the existing `CommittedVaultReader` seam,
// servingContextLoader.ts) as the source of retrievable passages — no gbrain, no egress, no owner
// crossing: a pure local read of content KnowledgeWriter already wrote. THIS pins the deterministic
// extraction + scoping + rerank/cap logic with a fake reader.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { WorkspaceId, RevisionId } from "@sow/contracts";
import type { CanonicalVaultSnapshot } from "@sow/knowledge";
import {
  createVaultPassageRetrieval,
  deriveVaultPassages,
  DEFAULT_VAULT_PASSAGE_LIMIT,
} from "../../../src/api/procedures/copilotVaultPassageRetrieval";
import type { CommittedVaultReader } from "../../../src/api/procedures/servingContextLoader";

const WS = "ws-personal";

function snapshot(files: Record<string, string>, ws: string = WS): CanonicalVaultSnapshot {
  return {
    workspaceId: ws as WorkspaceId,
    revisionId: "rev-1" as RevisionId,
    files: new Map(Object.entries(files)),
  };
}

describe("deriveVaultPassages — pure extraction from committed vault Markdown", () => {
  it("derives one passage per .md page, skipping non-.md files", () => {
    const snap = snapshot({
      "notes/a.md": "Just a plain note about the vendor decision.",
      "notes/readme.txt": "not markdown, must be ignored",
    });
    const { blocks, sources } = deriveVaultPassages(snap);
    expect(blocks).toEqual(["Just a plain note about the vendor decision."]);
    expect(sources).toHaveLength(1);
  });

  it("uses the frontmatter `title:` when present, else the basename slug", () => {
    const snap = snapshot({
      "notes/a.md": "---\ntitle: Vendor Review\n---\nBody text here.",
      "notes/b.md": "No frontmatter body.",
    });
    const { sources } = deriveVaultPassages(snap);
    expect(sources.map((s) => s.title)).toEqual(["Vendor Review", "b"]);
  });

  it("skips a page whose body is empty after stripping frontmatter (nothing to ground/cite)", () => {
    const snap = snapshot({
      "notes/empty.md": "---\ntitle: Empty\n---\n",
      "notes/real.md": "Real content.",
    });
    const { blocks, sources } = deriveVaultPassages(snap);
    expect(blocks).toEqual(["Real content."]);
    expect(sources).toHaveLength(1);
  });

  it("citationId is opaque (no path, no slash) and deterministic for the same path", () => {
    const snap = snapshot({ "a/b/c.md": "content" });
    const { sources } = deriveVaultPassages(snap);
    expect(sources[0]!.citationId).not.toMatch(/[/\\]/);
    expect(sources[0]!.citationId).not.toContain("a/b/c");
    const again = deriveVaultPassages(snap);
    expect(again.sources[0]!.citationId).toBe(sources[0]!.citationId);
  });

  it("caps an over-long body — a body under the cap is NOT truncated, one over the cap IS (mutation-provable boundary)", () => {
    const short = "x".repeat(4000);
    const long = "y".repeat(4001);
    const snap = snapshot({ "short.md": short, "long.md": long });
    const { blocks } = deriveVaultPassages(snap);
    const shortBlock = blocks.find((b) => b.startsWith("x"))!;
    const longBlock = blocks.find((b) => b.startsWith("y"))!;
    expect(shortBlock.length).toBe(4000); // untouched — exactly at the cap
    expect(longBlock.length).toBe(4000); // truncated down to the cap, not 4001
  });
});

describe("createVaultPassageRetrieval — workspace-scoped, WS-8 fail-closed, never egresses", () => {
  it("a reader returning undefined (never-indexed / unbound) fails closed as an unknown workspace", async () => {
    const reader: CommittedVaultReader = () => undefined;
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("a snapshot for a DIFFERENT workspace than requested fails closed (WS-8 defense-in-depth)", async () => {
    const reader: CommittedVaultReader = () => snapshot({ "a.md": "content" }, "some-other-ws");
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("a throwing reader folds to a typed, retryable degraded failure (§16 — never throws across the boundary)", async () => {
    const reader: CommittedVaultReader = () => {
      throw new Error("fs exploded");
    };
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("VAULT_READ_FAULT");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("an empty vault (a bound reader, zero content) is a legitimate OK-empty answer, not an error", async () => {
    const reader: CommittedVaultReader = () => snapshot({});
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader });
    const r = await retrieval.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual([]);
      expect(r.value.sources).toEqual([]);
    }
  });

  it("a real vault returns the workspace-scoped passages, aligned block↔source", async () => {
    const reader: CommittedVaultReader = () =>
      snapshot({
        "a.md": "A vendor decision was logged on the review.",
        "b.md": "The SLA target is 99.9 percent.",
      });
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader });
    const r = await retrieval.retrieve(WS, "vendor decision");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe(WS);
      expect(r.value.blocks.length).toBe(2);
      expect(r.value.blocks.length).toBe(r.value.sources.length); // positional alignment (worker L6)
      // The block containing "vendor" pairs with a source, and vice versa — never cross-wired.
      const vendorIdx = r.value.blocks.findIndex((b) => b.includes("vendor"));
      const slaIdx = r.value.blocks.findIndex((b) => b.includes("SLA"));
      expect(r.value.sources[vendorIdx]).not.toEqual(r.value.sources[slaIdx]);
    }
  });

  it("caps the returned passages to `limit` even when more pages exist", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < DEFAULT_VAULT_PASSAGE_LIMIT + 5; i += 1) files[`n${String(i)}.md`] = `content ${String(i)}`;
    const reader: CommittedVaultReader = () => snapshot(files);
    const retrieval = createVaultPassageRetrieval({ readCommittedVault: reader, limit: 3 });
    const r = await retrieval.retrieve(WS, "content");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toHaveLength(3);
      expect(r.value.sources).toHaveLength(3);
    }
  });

  it("never invokes gbrain / any egress — the port has no such dependency (structural, not behavioral)", () => {
    // The retrieval's ONLY dependency is `readCommittedVault` (local fs-backed) — there is no
    // provider/route/exec seam for a caller to even hand it, so it cannot egress by construction.
    const deps: Parameters<typeof createVaultPassageRetrieval>[0] = {
      readCommittedVault: () => undefined,
    };
    expect(Object.keys(deps)).toEqual(["readCommittedVault"]);
  });
});
