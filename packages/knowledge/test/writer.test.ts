// spec(§6) — KnowledgeWriter core: composed gate, atomic commit, compare-revision,
// revision/audit recording, idempotent replay, typed failure variants (task 4.1)
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
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

describe("applyPlan — YAML-safe frontmatter serialization (§13.10a go-live gate 2)", () => {
  // Model/domain-authored frontmatter VALUES (title, projectId, tags…) must serialize as YAML-safe
  // scalars — a value starting with a YAML indicator or carrying a flow/comment ambiguity would
  // misparse in a real vault (Obsidian / gbrain ingest). Isolate serialization from the secret/
  // ownership gates (pass-through) so these tests pin the serializer alone.
  const openDeps = (vault: MemoryVaultFs): KnowledgeWriterDeps & {
    revisions: MemoryRevisionStore;
    audit: MemoryAuditRepo;
  } => ({ ...deps(vault), secretScan: () => ok(undefined), ownershipCheck: () => ok(undefined) });

  const createPlan = (
    over: { title?: string; frontmatter?: Record<string, unknown>; path?: string },
  ): KnowledgeMutationPlan => ({
    ...validKnowledgeMutationPlan,
    creates: [{ path: over.path ?? "notes/proj.md", title: over.title, body: "body", frontmatter: over.frontmatter }],
  });

  const commit = async (plan: KnowledgeMutationPlan, vault: MemoryVaultFs, base = EMPTY_REV, key = "idem-yaml") => {
    const r = await applyPlan(cmd(plan, base, key), openDeps(vault));
    expect(isOk(r)).toBe(true);
    return vault.snapshot();
  };

  it("QUOTES a value carrying a YAML indicator / flow-ambiguity (colon-space, leading #, brackets)", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ title: "Q3: Launch", frontmatter: { tags: "#urgent", note: "[draft]" } }), vault);
    const md = snap["notes/proj.md"]!;
    // the unsafe forms are NOT written verbatim; they are double-quoted (YAML-safe).
    expect(md).not.toContain("title: Q3: Launch");
    expect(md).toContain('title: "Q3: Launch"');
    expect(md).toContain('tags: "#urgent"');
    expect(md).toContain('note: "[draft]"');
  });

  it("leaves a SAFE plain scalar unquoted (no regression / clean vault output)", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ title: "Acme Corp", frontmatter: { projectId: "acme-corp", lifecycleState: "active" } }), vault);
    const md = snap["notes/proj.md"]!;
    expect(md).toContain("title: Acme Corp");
    expect(md).toContain("projectId: acme-corp");
    expect(md).toContain("lifecycleState: active");
  });

  it("QUOTES YAML bool/null keywords + purely-numeric strings so they stay STRINGS", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ title: "true", frontmatter: { projectId: "42", flag: "null" } }), vault);
    const md = snap["notes/proj.md"]!;
    expect(md).toContain('title: "true"');
    expect(md).toContain('projectId: "42"');
    expect(md).toContain('flag: "null"');
  });

  it("QUOTES date-like + hex/octal/binary strings (an unquoted digit-leading scalar is re-TYPED by YAML)", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ title: "2020-01-01", frontmatter: { hex: "0x1F", oct: "0o17", ver: "3.0" } }), vault);
    const md = snap["notes/proj.md"]!;
    expect(md).toContain('title: "2020-01-01"');
    expect(md).toContain('hex: "0x1F"');
    expect(md).toContain('oct: "0o17"');
    expect(md).toContain('ver: "3.0"');
  });

  it("escapes non-printable control chars inside a quoted value (a strict YAML parser must not reject the block)", async () => {
    const vault = new MemoryVaultFs();
    const vt = String.fromCharCode(0x0b); // vertical tab (0x0B) — built here so the source stays clean ASCII
    const snap = await commit(createPlan({ title: `tab\tvert${vt}x` }), vault);
    const md = snap["notes/proj.md"]!;
    // tab → \t (handled), VT (0x0B) → \x0B — never emitted RAW inside the quotes.
    expect(md).toContain('title: "tab\\tvert\\x0Bx"');
    // no raw C0/C1 control char survives in the committed note (tab/newline/CR are the only legit ones).
    const rawControl = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]", "u");
    expect(rawControl.test(md)).toBe(false);
  });

  it("escapes embedded quotes/backslashes inside a double-quoted value", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ title: 'a "quote" and \\ slash: x' }), vault);
    const md = snap["notes/proj.md"]!;
    expect(md).toContain('title: "a \\"quote\\" and \\\\ slash: x"');
  });

  it("preserves an already-quoted value across a re-commit (no double-quoting round-trip corruption)", async () => {
    const vault = new MemoryVaultFs();
    // First commit writes a quoted title. A later FrontmatterPatch on a DIFFERENT key re-parses +
    // re-composes; the quoted title must survive verbatim (parseNote/composeNote round-trip).
    await commit(createPlan({ title: "Q3: Launch", frontmatter: { projectId: "acme-corp" } }), vault, EMPTY_REV, "k1");
    const base = computeRevisionId(new Map(Object.entries(vault.snapshot())));
    const patchPlan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      frontmatterUpdates: [{ path: "notes/proj.md", key: "status", value: "shipped" }],
    };
    const snap = await commit(patchPlan, vault, base, "k2");
    const md = snap["notes/proj.md"]!;
    expect(md).toContain('title: "Q3: Launch"'); // preserved, NOT '""Q3: Launch""'
    expect(md).not.toContain('""');
    expect(md).toContain("status: shipped");
  });

  it("serializes non-string values unchanged (numbers/booleans as plain YAML scalars)", async () => {
    const vault = new MemoryVaultFs();
    const snap = await commit(createPlan({ frontmatter: { count: 3, active: true } }), vault);
    const md = snap["notes/proj.md"]!;
    expect(md).toContain("count: 3");
    expect(md).toContain("active: true");
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
