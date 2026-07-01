// spec(§6) — KnowledgeWriter tombstone/removal commit-point primitive (task 4.5,
// REQ-F-013): the Markdown commit point of the §9 deletion saga. Ordered,
// idempotent removal that preserves every unaffected human-owned section (no
// collateral deletion), leaves a tombstone (not a silent delete), records a new
// revision + AuditRecord, and triggers the post-commit GBrain purge via the 4.4
// path (async, never rolls back the durable Markdown tombstone).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, WorkflowRunRef } from "@sow/contracts";
import { applyTombstone } from "../src/knowledge-writer/tombstone";
import type {
  TombstoneCommand,
  TombstoneDeps,
  PostCommitGbrainPurgeTrigger,
} from "../src/knowledge-writer/tombstone";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import type {
  GbrainSyncOutcome,
  GbrainSyncTriggerFault,
  GbrainSyncTriggerInput,
} from "../src/knowledge-writer/gbrain-sync-trigger";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

const wf: WorkflowRunRef = {
  workflowId: "wf-del-1" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-del-1",
  auditRefs: [],
};

const region = (id: string, body: string): string =>
  `<!-- kw:region:${id} -->\n${body}\n<!-- /kw:region:${id} -->`;

function revOf(vault: MemoryVaultFs): string {
  return computeRevisionId(new Map(Object.entries(vault.snapshot())));
}

function deps(
  vault: MemoryVaultFs,
  triggerGbrainPurge?: PostCommitGbrainPurgeTrigger,
): TombstoneDeps & {
  revisions: MemoryRevisionStore;
  audit: MemoryAuditRepo;
} {
  return {
    vault,
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-07-01T00:00:00.000Z",
    ...(triggerGbrainPurge !== undefined ? { triggerGbrainPurge } : {}),
  };
}

function cmd(
  targets: TombstoneCommand["targets"],
  base: string,
  idempotencyKey = "idem-del-1",
): TombstoneCommand {
  return {
    workspaceId: "ws-1",
    deletionId: "del-1",
    targets,
    expectedBaseRevision: base,
    actor: "KnowledgeWriter",
    sourceEventRef: "evt-del-1",
    workflowRunRef: wf,
    idempotencyKey,
    reason: "user-initiated deletion",
  };
}

const TOMBSTONE_MARKER = "<!-- kw:tombstone -->";

describe("applyTombstone — whole-note tombstone (not silent delete)", () => {
  it("removes all assistant content, leaves a tombstone marker stub, records one revision + audit", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "secret decision body") });
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault)), d);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.replayed).toBe(false);
    expect(r.value.changed).toBe(true);
    expect(r.value.affectedPaths).toEqual(["notes/a.md"]);
    expect(r.value.removedRegionCount).toBe(1);

    const after = vault.snapshot()["notes/a.md"]!;
    // no resurrection: the removed body is gone; a tombstone stub remains (not deleted).
    expect(after).not.toContain("secret decision body");
    expect(after).not.toContain("kw:region:r1");
    expect(after).toContain(TOMBSTONE_MARKER);
    // file path preserved (tombstone, not silent delete)
    expect(Object.keys(vault.snapshot())).toContain("notes/a.md");

    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
    expect(r.value.revisionId).toBe(revOf(vault));
    expect(d.audit.records[0]!.refs).toContain(r.value.revisionId);
  });
});

describe("applyTombstone — no collateral deletion (KN-7 human sections preserved)", () => {
  it("preserves human-owned content while removing the targeted assistant region", async () => {
    const human = "# My own heading\n\nHand-written note I care about.\n\n";
    const vault = new MemoryVaultFs({ "notes/b.md": `${human}${region("r1", "assistant text")}` });
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/b.md" }], revOf(vault)), d);

    expect(isOk(r)).toBe(true);
    const after = vault.snapshot()["notes/b.md"]!;
    expect(after).toContain("# My own heading");
    expect(after).toContain("Hand-written note I care about.");
    expect(after).not.toContain("assistant text");
    expect(after).toContain(TOMBSTONE_MARKER);
  });
});

describe("applyTombstone — surgical region removal keeps unrelated regions byte-stable (KN-8)", () => {
  it("removes only the named region; other assistant regions + human content survive; no note-level tombstone stub", async () => {
    const content = `intro\n${region("r1", "delete me")}\nmid\n${region("r2", "keep me")}\ntail`;
    const vault = new MemoryVaultFs({ "notes/c.md": content });
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/c.md", regionIds: ["r1"] }], revOf(vault)), d);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.removedRegionCount).toBe(1);
    const after = vault.snapshot()["notes/c.md"]!;
    expect(after).not.toContain("delete me");
    expect(after).not.toContain("kw:region:r1");
    // untargeted region survives byte-identically
    expect(after).toContain(region("r2", "keep me"));
    expect(after).toContain("intro");
    expect(after).toContain("tail");
    // surgical removal does NOT drop a note-level tombstone stub — the note lives on
    expect(after).not.toContain(TOMBSTONE_MARKER);
  });
});

describe("applyTombstone — idempotent replay (same idempotencyKey)", () => {
  it("returns the prior revision without a second write or audit", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const d = deps(vault);
    const base = revOf(vault);
    const first = await applyTombstone(cmd([{ path: "notes/a.md" }], base), d);
    expect(isOk(first)).toBe(true);
    const firstRev = isOk(first) ? first.value.revisionId : "";

    // replay with the SAME key (stale base) — short-circuits to the prior commit
    const replay = await applyTombstone(cmd([{ path: "notes/a.md" }], base), d);
    expect(isOk(replay)).toBe(true);
    if (isOk(replay)) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.revisionId).toBe(firstRev);
    }
    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
  });
});

describe("applyTombstone — idempotent content no-op (re-drive under a new key)", () => {
  it("no duplicate tombstone: an already-tombstoned end state commits nothing", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const d = deps(vault);
    const first = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault), "k1"), d);
    expect(isOk(first)).toBe(true);

    // fresh saga step (different key), current base, same target — already in end state
    const noop = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault), "k2"), d);
    expect(isOk(noop)).toBe(true);
    if (isOk(noop)) {
      expect(noop.value.changed).toBe(false);
      expect(noop.value.revisionId).toBe(revOf(vault));
    }
    // still exactly one commit total — no duplicate tombstone
    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
  });
});

describe("applyTombstone — compare-revision precondition", () => {
  it("fails with write_conflict on a stale base and leaves the vault untouched", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const before = vault.snapshot();
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/a.md" }], computeRevisionId(new Map())), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("write_conflict");
    expect(vault.snapshot()).toEqual(before);
    expect(d.audit.records).toHaveLength(0);
  });
});

describe("applyTombstone — structural rejections", () => {
  it("rejects an empty target set", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const r = await applyTombstone(cmd([], revOf(vault)), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r) && r.error.code === "tombstone_rejected") {
      expect(r.error.reason).toBe("empty_targets");
    } else throw new Error("expected tombstone_rejected/empty_targets");
    expect(d.audit.records).toHaveLength(0);
  });

  it("rejects a missing target path (never a silent no-op that could mask an inconsistency)", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/ghost.md" }], revOf(vault)), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r) && r.error.code === "tombstone_rejected") {
      expect(r.error.reason).toBe("target_missing");
      expect(r.error.path).toBe("notes/ghost.md");
    } else throw new Error("expected tombstone_rejected/target_missing");
    expect(d.audit.records).toHaveLength(0);
  });

  it("rejects a target with malformed region markers rather than corrupting it", async () => {
    const vault = new MemoryVaultFs({ "notes/bad.md": "<!-- kw:region:r1 -->\nunclosed" });
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/bad.md" }], revOf(vault)), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r) && r.error.code === "tombstone_rejected") {
      expect(r.error.reason).toBe("malformed_markers");
    } else throw new Error("expected tombstone_rejected/malformed_markers");
    expect(vault.snapshot()["notes/bad.md"]).toBe("<!-- kw:region:r1 -->\nunclosed");
    expect(d.audit.records).toHaveLength(0);
  });
});

describe("applyTombstone — atomic all-or-nothing", () => {
  it("leaves the vault unchanged on a mid-commit fault", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const before = vault.snapshot();
    vault.failRenameOn = (to) => to === "notes/a.md";
    const d = deps(vault);
    const r = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault)), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("commit_failed");
    expect(vault.snapshot()).toEqual(before);
    expect(d.audit.records).toHaveLength(0);
    expect(d.revisions.recordCalls).toBe(0);
  });
});

describe("applyTombstone — post-commit GBrain purge (4.4 path, async, never rolls back)", () => {
  it("fires the purge trigger for the committed revision and surfaces its outcome", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const calls: GbrainSyncTriggerInput[] = [];
    const outcome: GbrainSyncOutcome = {
      kind: "queued",
      entry: {
        outboxId: "gbrain-sync:ws-1:x",
        workspaceId: "ws-1",
        revisionId: "rev:x",
        planId: "del-1",
        status: "gbrain_sync_queued",
        attempts: 0,
        auditRef: "a",
        enqueuedAt: "2026-07-01T00:00:00.000Z",
      },
      mutationState: "gbrain_sync_queued",
    };
    const trigger: PostCommitGbrainPurgeTrigger = async (input) => {
      calls.push(input);
      return ok(outcome);
    };
    const d = deps(vault, trigger);
    const r = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault)), d);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(calls).toHaveLength(1);
    // purge targets the newly committed tombstone revision
    expect(calls[0]!.committedRevisionId).toBe(r.value.revisionId);
    expect(calls[0]!.workspaceId).toBe("ws-1");
    expect(r.value.purge && isOk(r.value.purge)).toBe(true);
  });

  it("keeps the durable tombstone even when the purge trigger throws (never rolls back)", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const trigger: PostCommitGbrainPurgeTrigger = async () => {
      throw new Error("gbrain down");
    };
    const d = deps(vault, trigger);
    const r = await applyTombstone(cmd([{ path: "notes/a.md" }], revOf(vault)), d);

    // the Markdown tombstone stands regardless of the async purge fault
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.changed).toBe(true);
      expect(r.value.purge).toBeUndefined();
    }
    expect(vault.snapshot()["notes/a.md"]).toContain(TOMBSTONE_MARKER);
    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
  });

  it("keeps the durable tombstone when the purge trigger returns a typed fault", async () => {
    const vault = new MemoryVaultFs({ "notes/a.md": region("r1", "body") });
    const fault: GbrainSyncTriggerFault = {
      code: "outbox_unavailable",
      message: "down",
      healthItem: {
        id: "h1",
        failureClass: "sync_lagging",
        severity: "warn",
        message: "lagging",
        auditRef: "a" as GbrainSyncTriggerFault["healthItem"]["auditRef"],
        openedAt: "2026-07-01T00:00:00.000Z",
        state: "open",
      },
    };
    const trigger: PostCommitGbrainPurgeTrigger = async () => err(fault);
    const d = deps(vault, trigger);
    const r: Result<unknown, unknown> = await applyTombstone(
      cmd([{ path: "notes/a.md" }], revOf(vault)),
      d,
    );

    expect(isOk(r)).toBe(true);
    expect(d.audit.records).toHaveLength(1);
    expect(vault.snapshot()["notes/a.md"]).toContain(TOMBSTONE_MARKER);
  });
});
