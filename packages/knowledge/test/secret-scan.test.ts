// spec(§6) — blocking pre-commit secret scan (task 4.3): reject-not-redact,
// scans the fully-rendered post-apply content (body + frontmatter + links),
// the matched secret never leaves via the typed error / audit (§16 redaction),
// and the scan actually blocks a real commit through applyPlan.
import { describe, it, expect } from "vitest";
import { isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import { isRedactionSafe } from "@sow/policy";
import { applyPlan } from "../src/knowledge-writer/writer";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
} from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import {
  scanForSecrets,
  contentContainsSecret,
  buildSecretScanRejectionAudit,
  SECRET_SCAN_KIND,
  SECRET_SCAN_FAILURE_CLASS,
} from "../src/knowledge-writer/secret-scan";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

// Canonical, unambiguous credential samples (no ambiguity, no live secret).
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16 → CREDENTIAL_PREFIX
const PROVIDER_KEY = "sk-abcd1234efgh5678"; // sk-[a-z0-9] provider key prefix
const USERINFO_URL = "https://admin:s3cr3tzz@example.com/api"; // URL userinfo cred

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
    secretScan: scanForSecrets, // wire the REAL scan under test
  };
}

function cmd(plan: unknown): KnowledgeWriteCommand {
  return {
    plan,
    expectedBaseRevision: EMPTY_REV,
    actor: "KnowledgeWriter",
    sourceEventRef: "evt-1",
    workflowRunRef: wf,
    idempotencyKey: "idem-cmd-1",
  };
}

describe("secret-scan — detection (reuses @sow/policy redaction patterns)", () => {
  it("flags a credential-prefix key (AWS / provider) as secret", () => {
    expect(contentContainsSecret(`aws=${AWS_KEY}`)).toBe(true);
    expect(contentContainsSecret(`key: ${PROVIDER_KEY}`)).toBe(true);
  });

  it("flags a URL userinfo credential", () => {
    expect(contentContainsSecret(`see ${USERINFO_URL}`)).toBe(true);
  });

  it("flags a sensitive keyword (password/passphrase/api-key/bearer)", () => {
    expect(contentContainsSecret("the password is on the sticky note")).toBe(true);
    expect(contentContainsSecret("Authorization: bearer xyz")).toBe(true);
  });

  it("passes clean prose with no credential shape", () => {
    expect(contentContainsSecret("weekly sync notes about the roadmap")).toBe(false);
    expect(contentContainsSecret("")).toBe(false);
  });
});

describe("secret-scan — predicate returns a typed Result, never throws", () => {
  it("rejects with secret_found and carries only path + fixed redaction-safe kind", () => {
    const r = scanForSecrets({ path: "notes/a.md", content: `x ${AWS_KEY}` });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("secret_found");
    expect(r.error.path).toBe("notes/a.md");
    expect(r.error.kind).toBe(SECRET_SCAN_KIND);
    // the matched secret value NEVER rides along in the typed error (§16)
    expect(JSON.stringify(r.error)).not.toContain(AWS_KEY);
  });

  it("passes clean content", () => {
    const r = scanForSecrets({ path: "notes/a.md", content: "clean roadmap notes" });
    expect(isOk(r)).toBe(true);
  });
});

describe("secret-scan — blocks a real commit through applyPlan (reject, not redact)", () => {
  it("rejects a plan whose NOTE BODY carries a secret; nothing lands on disk", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [{ path: "notes/a.md", body: `deploy key ${AWS_KEY}` }],
    };
    const r = await applyPlan(cmd(plan), d);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("secret_found");
    // reject-not-redact: no file (partial or sanitized), no audit, no revision
    expect(vault.snapshot()).toEqual({});
    expect(d.audit.records).toHaveLength(0);
    expect(d.revisions.recordCalls).toBe(0);
  });

  it("scans FRONTMATTER, not only the body (bullet 4)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [
        { path: "notes/f.md", body: "weekly sync", frontmatter: { note: AWS_KEY } },
      ],
    };
    const r = await applyPlan(cmd(plan), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("secret_found");
    expect(vault.snapshot()).toEqual({});
  });

  it("scans LINK MUTATIONS, not only the body (bullet 4)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      linkMutations: [{ op: "add", srcPath: "notes/l.md", dstSlug: AWS_KEY }],
    };
    const r = await applyPlan(cmd(plan), d);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("secret_found");
    expect(vault.snapshot()).toEqual({});
  });

  it("lets clean content commit normally (no false block)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [{ path: "notes/ok.md", body: "roadmap and milestones" }],
    };
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    expect(vault.snapshot()["notes/ok.md"]).toBe("roadmap and milestones");
  });
});

describe("secret-scan — redaction-safe rejection audit seam (§16)", () => {
  it("builds an audit signal that is itself redaction-safe and omits the secret", () => {
    const found = scanForSecrets({ path: "notes/a.md", content: `x ${AWS_KEY}` });
    if (isOk(found)) throw new Error("expected secret_found");
    const signal = buildSecretScanRejectionAudit(found.error);
    expect(isRedactionSafe(signal)).toBe(true);
    expect(JSON.stringify(signal)).not.toContain(AWS_KEY);
    expect(JSON.stringify(signal)).toContain("notes/a.md");
  });

  it("elides a path that itself looks credential-shaped so the signal stays log-safe", () => {
    const signal = buildSecretScanRejectionAudit({
      code: "secret_found",
      path: `vault/${AWS_KEY}.md`,
      kind: SECRET_SCAN_KIND,
    });
    expect(isRedactionSafe(signal)).toBe(true);
    expect(JSON.stringify(signal)).not.toContain(AWS_KEY);
  });

  it("maps the rejection to a distinct pre-commit-gate failure class", () => {
    expect(SECRET_SCAN_FAILURE_CLASS).toBe("schema_rejection");
  });
});
