// spec(§5 WS-8, §6 KN-4/KN-9) — 24.12 remedy: the foreign-workspace path-consistency guard. The
// packages/policy Copilot LegacyContentPolicy {mode:"assign"} bridge treats every UNPREFIXED note in
// the combined gbrain brain as belonging to its one toWorkspaceId — sound only while the brain holds a
// single workspace's unprefixed content. This guard makes that unsound state UNREPRESENTABLE at
// KnowledgeWriter (the one place every semantic write crosses, safety rule 1) instead of trusting an
// operator-discipline comment (contracts L123).
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr, validKnowledgeMutationPlan, workspaceId as wsId } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import { applyPlan } from "../src/knowledge-writer/writer";
import type { KnowledgeWriteCommand, KnowledgeWriterDeps, WorkspacePathContext } from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { enforceWorkspacePathScope, LEGACY_UNPREFIXED_WORKSPACE_ID, SOURCE_NOTE_SUBTREE } from "../src/knowledge-writer/workspace-path-guard";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

const wf: WorkflowRunRef = {
  workflowId: "wf-24-12" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-24-12",
  auditRefs: [],
};
const EMPTY_REV = computeRevisionId(new Map());

/** applyPlan deps with ownership/secret-scan passed through — isolates THIS gate from the others. */
function deps(vault: MemoryVaultFs): KnowledgeWriterDeps & { revisions: MemoryRevisionStore; audit: MemoryAuditRepo } {
  return {
    vault,
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-07-01T00:00:00.000Z",
    ownershipCheck: () => ok(undefined),
    secretScan: () => ok(undefined),
    // workspacePathCheck deliberately OMITTED — every test in this file exercises the REAL default.
  };
}

function cmd(plan: unknown, key = "idem-24-12"): KnowledgeWriteCommand {
  return { plan, expectedBaseRevision: EMPTY_REV, actor: "KnowledgeWriter", sourceEventRef: "evt-1", workflowRunRef: { ...wf, idempotencyKey: key }, idempotencyKey: key };
}

const planWithCreate = (workspaceId: string, path: string, body = "hello"): KnowledgeMutationPlan => ({
  ...validKnowledgeMutationPlan,
  workspaceId: wsId(workspaceId),
  creates: [{ path, body }],
});

const FOREIGN = "employer-work";

describe("applyPlan — foreign-workspace path consistency (24.12 remedy, constructing the bad state)", () => {
  it("a foreign-workspace note landing UNPREFIXED is rejected before any write", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "projects/acme.md"); // no "employer-work/" prefix
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    // fail-closed: nothing committed, no revision recorded (mirrors the secret_found regression pin)
    expect(vault.snapshot()["projects/acme.md"]).toBeUndefined();
    expect(d.revisions.recordCalls).toBe(0);
    expect(d.audit.records).toHaveLength(0);
  });

  it("the LEGACY-EXEMPT workspace's unprefixed content is UNAFFECTED — non-vacuity partner of the test above", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(LEGACY_UNPREFIXED_WORKSPACE_ID, "projects/acme.md"); // unprefixed, but the ONE exempt workspace
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(vault.snapshot()["projects/acme.md"]).toBe("hello");
  });

  it("a CORRECTLY-PREFIXED foreign-workspace note is unaffected", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work/projects/acme.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(vault.snapshot()["employer-work/projects/acme.md"]).toBe("hello");
  });

  it("the legacy-exempt workspace MAY ALSO be prefixed — the exemption permits, never requires, unprefixed", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(LEGACY_UNPREFIXED_WORKSPACE_ID, `${LEGACY_UNPREFIXED_WORKSPACE_ID}/projects/acme.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
  });

  it("segment-boundary correctness — a LOOKALIKE prefix (employer-work-x) does NOT satisfy employer-work's requirement", async () => {
    // Mirrors packages/policy copilot-workspace-scope.ts's own segment-wise matching discipline
    // ("personal-business never captures personal-business-x").
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work-x/projects/acme.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("KN-12 structural surfaces are exempt for EVERY workspace — mergeStructural rides inside any workspace's plan (13.8d)", async () => {
    // ingest-rewrite.ts's mergeStructural puts index.md/log.md/Logs/<date>.md patches inside the SAME
    // AUTO plan as a non-personal-business workspace's semantic content. A naive prefix rule would
    // break KN-12 parity for every workspace but the legacy-exempt one.
    for (const structuralPath of ["index.md", "log.md", "Logs/2026-08-11.md"]) {
      const vault = new MemoryVaultFs();
      const d = deps(vault);
      const plan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, workspaceId: wsId(FOREIGN), patches: [{ path: structuralPath, regionId: "r1", newBody: "x" }] };
      const r = await applyPlan(cmd(plan, `idem-${structuralPath}`), d);
      expect(isOk(r), `${structuralPath} was rejected`).toBe(true);
    }
  });

  it("a MIXED plan — foreign-workspace semantic content plus a structural patch — the semantic content still needs its own prefix", async () => {
    // The structural exemption must not become a back door: only the structural path itself is exempt.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      workspaceId: wsId(FOREIGN),
      creates: [{ path: "projects/acme.md", body: "hello" }], // unprefixed — still a violation
      patches: [{ path: "index.md", regionId: "r1", newBody: "x" }], // exempt
    };
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    expect((r.error as { path?: string }).path).toBe("projects/acme.md"); // the OFFENDING path, not the structural one
  });

  it("rule 7 — the violation carries a code and a path, and NOTHING else (no entity name, no content fragment)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "projects/acme.md", "this body has secret-looking content xyz");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(Object.keys(r.error).sort()).toEqual(["code", "path"]);
    expect(JSON.stringify(r.error)).not.toContain("secret-looking");
  });

  it("SECURITY (review finding) — a traversal-crafted STRUCTURAL lookalike is rejected, never silently exempted", async () => {
    // "Logs/../employer-work-secret.md" string-STARTS-WITH "logs/" (isStructuralSurface would say yes)
    // but path.resolve() lands it OUTSIDE Logs/ entirely, unprefixed, at the vault root.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "Logs/../employer-work-secret.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    expect(vault.snapshot()["employer-work-secret.md"]).toBeUndefined(); // never committed under EITHER shape
  });

  it("SECURITY (review finding) — a traversal-crafted PREFIX lookalike is rejected even though it string-starts with its own workspaceId", async () => {
    // "employer-work/../secret.md" string-starts-with "employer-work" but resolves to the vault ROOT.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work/../secret.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("the SOURCE-INGESTION shape (sources/<ws>/<digest>.md) is a second sanctioned prefix, not just the first-segment one — the regression this slice would otherwise have shipped", async () => {
    // apps/worker/src/composition/sourceNotePath.ts derives every real ingested-source note at exactly
    // this path. Verified against apps/worker's own real tests (not inferred) that this was a live
    // regression before this test + the fix landed.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/${FOREIGN}/abc123.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
  });

  it("sources/<ws>/ still requires the SECOND segment to match — a different workspace's source subtree is still a violation", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/some-other-workspace/abc123.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("SECURITY (review finding) — a traversal-crafted SOURCES lookalike is rejected", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/${FOREIGN}/../../secret.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });
});

describe("enforceWorkspacePathScope — the pure predicate (unit level, for branches applyPlan's own schema gate makes unreachable in practice)", () => {
  const ctx = (path: string, workspaceId: unknown): WorkspacePathContext => ({ path, plan: { ...validKnowledgeMutationPlan, workspaceId } as unknown as KnowledgeMutationPlan });

  it("fails closed on a malformed/absent plan.workspaceId — never silently admits", () => {
    for (const bad of [undefined, null, "", 42]) {
      const r = enforceWorkspacePathScope(ctx("projects/acme.md", bad));
      expect(isErr(r)).toBe(true);
    }
  });

  it("fails closed on an empty path", () => {
    const r = enforceWorkspacePathScope(ctx("", FOREIGN));
    expect(isErr(r)).toBe(true);
  });

  it("is case-sensitive on the segment match — 'Employer-Work' is not 'employer-work' (fail closed on ambiguity, never a lenient match)", () => {
    const r = enforceWorkspacePathScope(ctx("Employer-Work/projects/acme.md", FOREIGN));
    expect(isErr(r)).toBe(true);
  });

  it("SECURITY — hasNoTraversalSegments gates the WHOLE function, not just the structural branch: every match kind rejects a '..'/'.'/'' segment", () => {
    const traversalCrafted = [
      "Logs/../employer-work-secret.md", // structural lookalike
      "employer-work/../secret.md", // prefix lookalike
      `${SOURCE_NOTE_SUBTREE}/employer-work/../../secret.md`, // sources/<ws>/ lookalike
      "employer-work//projects/acme.md", // empty segment
      "employer-work/./acme.md", // current-dir segment
    ];
    for (const path of traversalCrafted) {
      const r = enforceWorkspacePathScope(ctx(path, FOREIGN));
      expect(isErr(r), `expected ${path} to be rejected`).toBe(true);
    }
  });
});
