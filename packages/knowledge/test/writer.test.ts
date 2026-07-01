// spec(§6) — KnowledgeWriter core: composed gate, atomic commit, compare-revision,
// revision/audit recording, idempotent replay, typed failure variants (task 4.1)
import { describe, it, expect } from "vitest";
import { err, isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import { applyPlan } from "../src/knowledge-writer/writer";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
  OwnershipCheck,
  SecretScan,
} from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

const wf: WorkflowRunRef = {
  workflowId: "wf-001" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-cmd-1",
  auditRefs: [],
};

const EMPTY_REV = computeRevisionId(new Map());

function deps(vault: MemoryVaultFs): KnowledgeWriterDeps & {
  revisions: MemoryRevisionStore;
  audit: MemoryAuditRepo;
} {
  return {
    vault,
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-07-01T00:00:00.000Z",
  };
}

function cmd(
  plan: unknown,
  base = EMPTY_REV,
  idempotencyKey = "idem-cmd-1",
): KnowledgeWriteCommand {
  return {
    plan,
    expectedBaseRevision: base,
    actor: "KnowledgeWriter",
    sourceEventRef: "evt-1",
    workflowRunRef: wf,
    idempotencyKey,
  };
}

const planWithCreate = (
  path = "notes/a.md",
  body = "hello",
): KnowledgeMutationPlan => ({
  ...validKnowledgeMutationPlan,
  creates: [{ path, body }],
});

describe("applyPlan — secure-by-default gates (regression)", () => {
  // spec(§6) — REGRESSION (adversarial verify): the ownership + secret-scan hooks
  // formerly DEFAULTED to pass-through no-ops, so an uninjected caller got NO
  // enforcement (fail-OPEN). They now default to the REAL predicates. A plan whose
  // body carries a secret-shaped value is REJECTED even with NO injected secretScan.
  it("rejects a secret-bearing plan via the REAL default scanner (no injected secretScan)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault); // deps() injects neither ownershipCheck nor secretScan
    const plan = planWithCreate("notes/leak.md", "this note has a secret value inside");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("secret_found");
    // fail-closed: nothing committed, no revision recorded
    expect(vault.snapshot()["notes/leak.md"]).toBeUndefined();
    expect(d.revisions.recordCalls).toBe(0);
  });
});

describe("applyPlan — happy path", () => {
  it("commits a valid plan atomically and records exactly one revision + audit", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const r = await applyPlan(cmd(planWithCreate()), d);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.replayed).toBe(false);
    expect(vault.snapshot()["notes/a.md"]).toBe("hello");
    // revision id matches the post-apply snapshot
    expect(r.value.revisionId).toBe(computeRevisionId(new Map(Object.entries(vault.snapshot()))));
    // exactly one AuditRecord + one CommittedRevision
    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
    expect(d.audit.records[0]!.refs).toContain(r.value.revisionId);
  });
});

describe("applyPlan — composed candidate-data gate (never ajv alone)", () => {
  it("rejects an unsourced plan (empty sourceRefs) with schema_rejected — the Zod/§3 layer catches what ajv drops", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const unsourced = { ...validKnowledgeMutationPlan, sourceRefs: [] };
    const r = await applyPlan(cmd(unsourced), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("schema_rejected");
    // no side effect before the gate passes
    expect(vault.snapshot()).toEqual({});
    expect(d.audit.records).toHaveLength(0);
    expect(d.revisions.recordCalls).toBe(0);
  });

  it("rejects a structurally malformed plan at the ajv layer", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const r = await applyPlan(cmd({ planId: "p" }), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("schema_rejected");
      if (r.error.code === "schema_rejected") expect(r.error.stage).toBe("ajv");
    }
  });
});

describe("applyPlan — compare-revision precondition", () => {
  it("fails with write_conflict when the on-disk revision != expected base", async () => {
    const vault = new MemoryVaultFs({ "notes/x.md": "pre-existing" });
    const d = deps(vault);
    // caller believes the vault is empty (stale base) but it is not
    const r = await applyPlan(cmd(planWithCreate(), EMPTY_REV), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r) && r.error.code === "write_conflict") {
      expect(r.error.expectedBaseRevision).toBe(EMPTY_REV);
      expect(r.error.onDiskRevision).not.toBe(EMPTY_REV);
    } else {
      throw new Error("expected write_conflict");
    }
    // no lost update: vault untouched
    expect(vault.snapshot()).toEqual({ "notes/x.md": "pre-existing" });
    expect(d.audit.records).toHaveLength(0);
  });
});

describe("applyPlan — idempotent replay", () => {
  it("returns the already-committed revision without a second write or audit", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);

    const first = await applyPlan(cmd(planWithCreate()), d);
    expect(isOk(first)).toBe(true);
    const firstRev = isOk(first) ? first.value.revisionId : "";

    // replay the SAME idempotencyKey (base is now stale, but replay short-circuits)
    const replay = await applyPlan(cmd(planWithCreate(), EMPTY_REV), d);
    expect(isOk(replay)).toBe(true);
    if (isOk(replay)) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.revisionId).toBe(firstRev);
    }
    // no double-commit: still exactly one audit + one revision record
    expect(d.audit.records).toHaveLength(1);
    expect(d.revisions.recordCalls).toBe(1);
  });
});

describe("applyPlan — atomic all-or-nothing", () => {
  it("leaves the vault unchanged when a mid-apply commit fault occurs", async () => {
    const vault = new MemoryVaultFs();
    vault.failRenameOn = (to) => to === "b.md";
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [
        { path: "a.md", body: "A" },
        { path: "b.md", body: "B" },
      ],
    };
    const r = await applyPlan(cmd(plan), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("commit_failed");
    // NOTHING written (a.md rolled back, b.md never landed)
    expect(vault.snapshot()).toEqual({});
    expect(d.audit.records).toHaveLength(0);
    expect(d.revisions.recordCalls).toBe(0);
  });
});

describe("applyPlan — injected ownership + secret hooks (ordering + typed variants)", () => {
  it("rejects with ownership_violation before the secret scan or commit", async () => {
    const vault = new MemoryVaultFs();
    const secretCalls: string[] = [];
    const ownershipCheck: OwnershipCheck = (ctx) =>
      err({ code: "ownership_violation", path: ctx.path, reason: "human region" });
    const secretScan: SecretScan = (ctx) => {
      secretCalls.push(ctx.path);
      return err({ code: "secret_found", path: ctx.path });
    };
    const d = { ...deps(vault), ownershipCheck, secretScan };
    const r = await applyPlan(cmd(planWithCreate()), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("ownership_violation");
    // secret scan never ran (ownership gates first); nothing committed
    expect(secretCalls).toHaveLength(0);
    expect(vault.snapshot()).toEqual({});
  });

  it("rejects with secret_found before the commit (reject, not redact)", async () => {
    const vault = new MemoryVaultFs();
    const secretScan: SecretScan = (ctx) =>
      err({ code: "secret_found", path: ctx.path, kind: "aws_key" });
    const d = { ...deps(vault), secretScan };
    const r = await applyPlan(cmd(planWithCreate()), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("secret_found");
    // never writes a partial/sanitized file
    expect(vault.snapshot()).toEqual({});
    expect(d.audit.records).toHaveLength(0);
  });
});
