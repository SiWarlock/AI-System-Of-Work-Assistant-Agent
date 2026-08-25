// spec(§6) — KnowledgeWriter core: composed gate, atomic commit, compare-revision,
// revision/audit recording, idempotent replay, typed failure variants (task 4.1)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err, isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef, Result, FactIdentity, MdContentSha } from "@sow/contracts";
import { applyPlan } from "../src/knowledge-writer/writer";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
  OwnershipCheck,
  SecretScan,
} from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import {
  verifyProvenanceStamp,
  readStampField,
  type SecretsPort,
  type StamperDeps,
  type SecretUnresolved,
} from "../src/knowledge-writer/provenance-stamp";
import { computePageProvenance } from "../src/gbrain/derive/canonical-fact-deriver";
import { readFrontmatterField } from "../src/knowledge-writer/frontmatter";
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
    // 24.12: this file's fixtures use the generic "ws-001" workspace with unprefixed paths ("notes/a.md")
    // for reasons orthogonal to workspace-path scoping — pass-through here, exactly like the REAL
    // ownership/secret defaults are isolated in the "YAML-safe" block below. The real gate is pinned in
    // workspace-path-guard.test.ts.
    workspacePathCheck: () => ok(undefined),
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
    // task 24.123: the fixture is now a credential SHAPE, not the WORD "secret".
    // The commit-granularity predicate no longer trips on prose keywords (see the
    // companion admits-prose pin below); it still trips on a real key shape, which
    // is what this regression exists to prove.
    const plan = planWithCreate("notes/leak.md", "this note has sk-Abc123Def456Ghi789Jkl inside");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("secret_found");
    // fail-closed: nothing committed, no revision recorded
    expect(vault.snapshot()["notes/leak.md"]).toBeUndefined();
    expect(d.revisions.recordCalls).toBe(0);
  });

  // ⛔ task 24.123 (OWNER DECISION 2026-08-25) — THE ADMITTING DIRECTION, PINNED.
  // A note that merely SAYS "secret"/"password" is ordinary prose and MUST commit.
  // Measured before the split: the keyword arm rejected 218 of 668 tracked .md files
  // (32.8% of the vault unwritable) and accounted for 218 of 219 total rejections.
  // This pin is what makes re-adding the keyword arm to the COMMIT path fail loudly
  // instead of silently restoring a 1-in-3 refusal rate on the sole-writer path.
  it("ADMITS ordinary prose containing the words secret/password (24.123 granularity split)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate("notes/prose.md", "Rotate the password quarterly; never email a secret.");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    // non-vacuous: it really committed, rather than passing on an unrelated early return
    expect(vault.snapshot()["notes/prose.md"]).toContain("Rotate the password quarterly");
    expect(d.revisions.recordCalls).toBe(1);
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

describe("applyPlan — gate 4 G1d-2: provenance stamp minting at commit", () => {
  const KEY = new Uint8Array(32).fill(7);
  const REF = "kw-provenance-key";
  class FakeSecretsPort implements SecretsPort {
    constructor(private readonly keys: Record<string, Uint8Array>) {}
    resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
      const k = this.keys[ref];
      return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
    }
  }
  const goodSigning = (): StamperDeps => ({ secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF });
  const badSigning = (): StamperDeps => ({ secrets: new FakeSecretsPort({}), signingKeyRef: REF });

  it("DORMANT — no signing key ⇒ the committed note carries NO kwStamp (byte-identical to today)", async () => {
    const vault = new MemoryVaultFs();
    const r = await applyPlan(cmd(planWithCreate("notes/acme.md", "hello")), deps(vault));
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["notes/acme.md"];
    expect(committed).toBe("hello"); // exactly the projected bytes — no stamp embedded
    expect(readStampField(committed ?? "")).toBeNull();
  });

  it("ACTIVE — a signing key embeds a kwStamp that VERIFIES over the committed note's own provenance", async () => {
    const vault = new MemoryVaultFs();
    const signing = goodSigning();
    const plan = planWithCreate("notes/acme.md", "hello");
    const r = await applyPlan(cmd(plan), { ...deps(vault), signing });
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["notes/acme.md"] ?? "";
    const stamp = readStampField(committed);
    expect(stamp).not.toBeNull();
    const page = computePageProvenance("notes/acme.md", committed);
    expect(page).not.toBeNull();
    if (stamp === null || page === null) return;
    // End-to-end: the stamp verifies over the tuple re-derived from the COMMITTED note (exactly what the gate does).
    const verified = await verifyProvenanceStamp(
      {
        workspaceId: plan.workspaceId,
        factIdentity: page.pageIdentity as FactIdentity,
        originPath: "notes/acme.md",
        mdContentSha: page.pageSha as MdContentSha,
        stamp,
      },
      signing,
    );
    expect(isOk(verified) && verified.value).toBe(true);
    expect(stamp.writerActor).toBe("KnowledgeWriter");
  });

  it("ACTIVE — the recorded revision equals computeRevisionId over the COMMITTED (stamped) vault (no next-commit conflict)", async () => {
    const vault = new MemoryVaultFs();
    const r = await applyPlan(cmd(planWithCreate("notes/acme.md", "hello")), { ...deps(vault), signing: goodSigning() });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // The revision recorded IS the revision of the on-disk STAMPED bytes → the next commit's compare-revision passes.
    expect(r.value.revisionId).toBe(computeRevisionId(new Map(Object.entries(vault.snapshot()))));
  });

  it("FAIL-SAFE — an unresolvable signing key leaves the note UNSTAMPED but the write STILL SUCCEEDS", async () => {
    const vault = new MemoryVaultFs();
    const r = await applyPlan(cmd(planWithCreate("notes/acme.md", "hello")), { ...deps(vault), signing: badSigning() });
    expect(isOk(r)).toBe(true); // a stamping fault NEVER blocks the semantic write
    const committed = vault.snapshot()["notes/acme.md"] ?? "";
    expect(committed).toBe("hello"); // committed unstamped ⇒ safely untrusted at serving
    expect(readStampField(committed)).toBeNull();
  });

  it("ACTIVE — preserves a note's PRE-EXISTING frontmatter through stamping (round-trip + verify)", async () => {
    const vault = new MemoryVaultFs();
    const signing = goodSigning();
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [{ path: "notes/acme.md", title: "Acme", body: "prose", frontmatter: { owner: "dana" } }],
      patches: [],
    };
    const r = await applyPlan(cmd(plan), { ...deps(vault), signing });
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["notes/acme.md"] ?? "";
    // the pre-existing frontmatter keys survive alongside the added kwStamp (composeNote round-trip preserved)
    expect(readFrontmatterField(committed, "owner")).toBe("dana");
    expect(readFrontmatterField(committed, "title")).toBe("Acme");
    const stamp = readStampField(committed);
    const page = computePageProvenance("notes/acme.md", committed);
    expect(stamp).not.toBeNull();
    if (stamp === null || page === null) return;
    const verified = await verifyProvenanceStamp(
      {
        workspaceId: plan.workspaceId,
        factIdentity: page.pageIdentity as FactIdentity,
        originPath: "notes/acme.md",
        mdContentSha: page.pageSha as MdContentSha,
        stamp,
      },
      signing,
    );
    expect(isOk(verified) && verified.value).toBe(true);
  });

  it("ACTIVE — idempotent replay does NOT re-stamp (second apply returns replayed, vault unchanged)", async () => {
    const vault = new MemoryVaultFs();
    const d = { ...deps(vault), signing: goodSigning() };
    const first = await applyPlan(cmd(planWithCreate("notes/acme.md", "hello")), d);
    expect(isOk(first)).toBe(true);
    const afterFirst = vault.snapshot()["notes/acme.md"];
    const second = await applyPlan(cmd(planWithCreate("notes/acme.md", "hello")), d);
    expect(isOk(second) && second.value.replayed).toBe(true);
    expect(vault.snapshot()["notes/acme.md"]).toBe(afterFirst); // no second stamp / no double-write
  });
});

// 24.26 step 3 of 3 — the slice's load-bearing pin, and the only form that can express it.
describe("KnowledgeWriterDeps.workspacePathCheck is REQUIRED (24.26 step 3)", () => {
  it("a deps literal omitting workspacePathCheck does not compile", () => {
    // ⛔ TYPE-LEVEL, NEVER INVOKED. A behavioural test cannot express "this does not compile", and
    // the runtime consequence of omission is pinned separately in workspace-path-guard.test.ts.
    // `tsc --noEmit` really covers this file (`include: ["src","test"]`, and `lint` IS `typecheck`),
    // so if the field is ever widened back to optional the suppression below goes UNUSED and
    // typecheck FAILS with TS2578 — it reds in the direction that matters, the guarantee weakening.
    // ⚠ Do not begin a comment line with the directive's own name while describing it: tsc reads
    // `//` + that token as a REAL directive wherever it appears (cost a RED cycle in step 1).
    const neverInvoked = (): KnowledgeWriterDeps =>
      // @ts-expect-error — workspacePathCheck is required; omitting it must not typecheck
      ({
        vault: new MemoryVaultFs(),
        revisions: new MemoryRevisionStore(),
        audit: new MemoryAuditRepo(),
        now: () => "2026-07-01T00:00:00.000Z",
      });
    expect(typeof neverInvoked).toBe("function");
  });
});

// ── `### 24.116` — `applyPlan`'s docblock made a FALSE universal claim ("THIS FUNCTION CONTAINS NO
// `try` ANYWHERE"), directly contradicted by its own body 300+ lines below. Replaced with a CHECKABLE
// claim naming the two real try blocks — checkable meaning a test can (and does) cross-check the
// cited line numbers against a live scan, so a future `try` added without a comment update reds here
// instead of going silently stale the way the original sentence did.
describe("applyPlan's docblock makes a CHECKABLE claim about its own try/catch coverage (24.116)", () => {
  it("applyPlan_docblock_makes_no_false_universal_try_claim", () => {
    const srcPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/knowledge-writer/writer.ts");
    const source = readFileSync(srcPath, "utf8");
    const lines = source.split("\n");

    const fnLineIdx = lines.findIndex((l) => l.startsWith("export async function applyPlan("));
    expect(fnLineIdx, "applyPlan declaration not found — has it moved or been renamed?").toBeGreaterThan(-1);

    // Walk BACKWARD from the declaration to the docblock immediately preceding it.
    let closeIdx = fnLineIdx - 1;
    while (closeIdx >= 0 && lines[closeIdx]!.trim() === "") closeIdx--;
    expect(lines[closeIdx]!.trim(), "no docblock immediately precedes applyPlan").toBe("*/");
    let openIdx = closeIdx;
    while (openIdx >= 0 && lines[openIdx]!.trim() !== "/**") openIdx--;
    expect(openIdx, "docblock opening /** not found").toBeGreaterThanOrEqual(0);
    const docblock = lines.slice(openIdx, closeIdx + 1).join("\n");

    // 1. NO FALSE UNIVERSAL — the exact defect shape this task removes (tolerant of backtick
    //    placement around `try`). Non-vacuity: this regex DOES match the original sentence.
    const FALSE_UNIVERSAL = /no\s*`?try`?\s*anywhere/i;
    expect(FALSE_UNIVERSAL.test("THIS FUNCTION CONTAINS NO `try` ANYWHERE")).toBe(true);
    expect(FALSE_UNIVERSAL.test(docblock), "the false universal claim is still present").toBe(false);

    // 2. The docblock NAMES both real try-block line numbers (`` `:NNN` `` citations) — and they are
    //    CROSS-CHECKED against a LIVE SCAN of the function body, not merely present as SOME numbers.
    const citedLineNumbers = [...docblock.matchAll(/`:(\d+)`/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(citedLineNumbers.length, "the docblock names no `:NNN`-style try line citations").toBeGreaterThan(0);

    // The function's real closing brace: the first column-0 `}` after the declaration — this file's
    // own convention for every exported top-level function.
    let bodyEndIdx = fnLineIdx + 1;
    while (bodyEndIdx < lines.length && lines[bodyEndIdx] !== "}") bodyEndIdx++;
    expect(bodyEndIdx, "applyPlan's closing brace not found").toBeLessThan(lines.length);

    const realTryLineNumbers = lines
      .slice(fnLineIdx, bodyEndIdx + 1)
      .map((l, i) => ({ l, lineNo: fnLineIdx + i + 1 })) // 1-indexed file line number
      .filter(({ l }) => l.trim() === "try {")
      .map(({ lineNo }) => lineNo)
      .sort((a, b) => a - b);

    expect(realTryLineNumbers.length, "expected exactly two try blocks in applyPlan's body").toBe(2);
    expect(citedLineNumbers).toEqual(realTryLineNumbers);
  });
});

// ── `### 24.72` residual — the docblock's report-inversion paragraph (and reason 1 of the
// workspacePathCheck-not-guarded discussion) still described the PRE-LEG-A/B defect in the present
// tense after the fix landed: "the caller is told `commit_failed`" (false — Leg B's `commitFailureClass`
// maps `audit_record_failed`/`revision_record_failed` to `db_unavailable`, never `commit_failed`) and
// "`now` and `audit` throw with the vault ALREADY COMMITTED" (false — Leg A moved `audit`'s post-commit
// fault inside this function's own try/catch, so an omitted `audit` no longer escapes uncaught; `now`
// remains the only one that does). A stale comment claiming a fixed defect is still live is worse than
// no comment (`L161`-adjacent — it tells a future reader to stop trusting the fix).
describe("applyPlan's docblock does not misdescribe the 24.72 residual as still live", () => {
  function extractApplyPlanDocblock(): string {
    const srcPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/knowledge-writer/writer.ts");
    const lines = readFileSync(srcPath, "utf8").split("\n");
    const fnLineIdx = lines.findIndex((l) => l.startsWith("export async function applyPlan("));
    let closeIdx = fnLineIdx - 1;
    while (closeIdx >= 0 && lines[closeIdx]!.trim() === "") closeIdx--;
    let openIdx = closeIdx;
    while (openIdx >= 0 && lines[openIdx]!.trim() !== "/**") openIdx--;
    return lines.slice(openIdx, closeIdx + 1).join("\n");
  }

  it("does not claim audit/revision faults are reported to the caller as commit_failed", () => {
    const docblock = extractApplyPlanDocblock();
    // Non-vacuity: this exact phrase is the stale claim the fix removes.
    expect(/the caller is told `commit_failed`/i.test("the caller is told `commit_failed`, and NO AuditRecord")).toBe(true);
    expect(
      /the caller is told `commit_failed`/i.test(docblock),
      "docblock still claims the (now-typed) post-commit recording faults report as commit_failed",
    ).toBe(false);
    // The corrected classification is named in its place.
    expect(docblock, "docblock does not name the current db_unavailable classification").toMatch(/db_unavailable/);
  });

  it("does not claim `audit` still throws uncaught with the vault already committed", () => {
    const docblock = extractApplyPlanDocblock();
    const staleReason1Pairing = /`now`\s+and\s+`audit`\s+throw/i;
    // Non-vacuity: the pattern matches the stale sentence it is written to catch.
    expect(staleReason1Pairing.test("`now` and `audit` throw with the vault ALREADY COMMITTED")).toBe(true);
    expect(
      staleReason1Pairing.test(docblock),
      "docblock still pairs `audit` with `now` as an uncaught post-commit thrower (24.72 Leg A caught it)",
    ).toBe(false);
  });
});
