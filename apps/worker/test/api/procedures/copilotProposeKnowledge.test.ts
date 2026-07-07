// §13.10a Slice B — deriveCopilotProjectKnowledgePlan: the pure Copilot semantic-write derivation.
// Model project intent -> a validated, human-gated KnowledgeMutationPlan for the project note. PURE, never-throws.
import { describe, it, expect } from "vitest";
import { isOk, workspaceId, sourceId, KnowledgeMutationPlanSchema } from "@sow/contracts";
import type { SourceRef, WorkspaceId } from "@sow/contracts";
import {
  deriveCopilotProjectKnowledgePlan,
  COPILOT_PROPOSE_KNOWLEDGE_CONFIDENCE,
  MAX_PROPOSE_SUMMARY_CHARS,
} from "../../../src/api/procedures/copilotProposeKnowledge";

const WS: WorkspaceId = workspaceId("personal-business");
const SRC: SourceRef = { sourceId: sourceId("src-answer-1") };
const deps = (over: Partial<{ workspaceId: WorkspaceId; sourceRef: SourceRef; noteExists: boolean }> = {}) => ({
  workspaceId: over.workspaceId ?? WS,
  sourceRef: over.sourceRef ?? SRC,
  noteExists: over.noteExists ?? false,
});
const goodIntent = { projectId: "acme-api", title: "Acme API", lifecycleState: "active", summary: "kicking off the API rebuild" };

const codeOf = (r: ReturnType<typeof deriveCopilotProjectKnowledgePlan>): string | undefined =>
  isOk(r) ? undefined : (r.error.cause as { code?: string } | undefined)?.code;

describe("deriveCopilotProjectKnowledgePlan — happy path (first proposal → NoteCreate)", () => {
  const r = deriveCopilotProjectKnowledgePlan(goodIntent, deps({ noteExists: false }));

  it("returns a KMP that passes the candidate-data schema gate", () => {
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(() => KnowledgeMutationPlanSchema.parse(r.value)).not.toThrow();
  });

  it("emits exactly one NoteCreate (no patch) at the WS-8 workspace-rooted path", () => {
    if (!isOk(r)) throw new Error("ok");
    expect(r.value.creates).toHaveLength(1);
    expect(r.value.patches).toHaveLength(0);
    expect(r.value.creates[0]!.path).toBe("projects/personal-business/acme-api.md");
  });

  it("stamps the governance fields: provenanceOrigin copilot_propose, requiresApproval true, sub-1 confidence", () => {
    if (!isOk(r)) throw new Error("ok");
    expect(r.value.provenanceOrigin).toBe("copilot_propose");
    expect(r.value.requiresApproval).toBe(true);
    expect(r.value.confidence).toBe(COPILOT_PROPOSE_KNOWLEDGE_CONFIDENCE);
    expect(r.value.confidence).toBeLessThan(1); // a proposal is NOT a deterministic fact
  });

  it("WS-2/WS-4: workspaceId is the SERVER-BOUND workspace; REQ-F-006: cites the passed sourceRef", () => {
    if (!isOk(r)) throw new Error("ok");
    expect(String(r.value.workspaceId)).toBe("personal-business");
    expect(r.value.sourceRefs.map((s) => String(s.sourceId))).toEqual(["src-answer-1"]);
  });

  it("frontmatter carries the intent fields + provenance; NO smuggled path/workspace-redirect", () => {
    if (!isOk(r)) throw new Error("ok");
    const fm = r.value.creates[0]!.frontmatter as Record<string, unknown>;
    expect(fm["projectId"]).toBe("acme-api");
    expect(fm["title"]).toBe("Acme API");
    expect(fm["lifecycleState"]).toBe("active");
    expect(fm["workspaceId"]).toBe("personal-business");
    expect(fm["provenanceOrigin"]).toBe("copilot_propose");
  });

  it("the note body has the H1 + region + the candidate prose, and REQ-F-011: NO percent/progress number", () => {
    if (!isOk(r)) throw new Error("ok");
    const body = r.value.creates[0]!.body;
    expect(body).toContain("# Acme API — Status");
    expect(body).toContain("<!-- kw:region:project-status -->");
    expect(body).toContain("**Proposed lifecycle:** active");
    expect(body).toContain("kicking off the API rebuild");
    expect(body).not.toMatch(/\d+\s*%/); // no percent — a proposal has no deterministic progress
    expect(body).not.toContain("## Progress");
  });
});

describe("deriveCopilotProjectKnowledgePlan — re-proposal (noteExists → region NotePatch)", () => {
  const r = deriveCopilotProjectKnowledgePlan(goodIntent, deps({ noteExists: true }));

  it("emits exactly one region NotePatch (no create — never a whole-file overwrite/clobber)", () => {
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.creates).toHaveLength(0);
    expect(r.value.patches).toHaveLength(1);
    const p = r.value.patches[0]!;
    expect(p.path).toBe("projects/personal-business/acme-api.md");
    expect(p.regionId).toBe("project-status");
    // newBody is the region INNER only — no H1, no markers (the writer adds them); still no percent (REQ-F-011).
    expect(p.newBody).not.toContain("# Acme API — Status");
    expect(p.newBody).not.toContain("<!-- kw:region:project-status -->");
    expect(p.newBody).toContain("**Proposed lifecycle:** active");
    expect(p.newBody).not.toMatch(/\d+\s*%/);
  });

  it("byte-idempotent: the re-propose patch newBody === the create note's region INNER (same intent)", () => {
    const create = deriveCopilotProjectKnowledgePlan(goodIntent, deps({ noteExists: false }));
    const patch = deriveCopilotProjectKnowledgePlan(goodIntent, deps({ noteExists: true }));
    if (!isOk(create) || !isOk(patch)) throw new Error("ok");
    const body = create.value.creates[0]!.body;
    const open = "<!-- kw:region:project-status -->\n";
    const close = "\n<!-- /kw:region:project-status -->";
    const inner = body.slice(body.indexOf(open) + open.length, body.indexOf(close));
    expect(patch.value.patches[0]!.newBody).toBe(inner);
  });
});

describe("deriveCopilotProjectKnowledgePlan — WS-8 / injection fail-closed", () => {
  it("WS-8: a projectId with no safe path anchor (traversal) fails closed — UNSAFE_PATH", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, projectId: "../.." }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_UNSAFE_PATH");
  });

  it("WS-8: the model CANNOT smuggle a workspaceId (or any extra key) — MALFORMED (strict shape)", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, workspaceId: "employer-work" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
  });

  it("WS-8: an intent-supplied `path` is rejected (strict) — the model cannot pick the note path", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, path: "projects/employer-work/secrets.md" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
  });

  it("injection: a title with a newline is rejected (can't forge a second frontmatter key / H2) — BAD_TITLE", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, title: "Acme\nevil: true" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_TITLE");
  });

  it("injection: a title carrying a region marker is rejected — BAD_TITLE", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, title: "Acme <!-- kw:region:project-status -->" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_TITLE");
  });

  it("injection: a projectId carrying a comment marker is rejected — BAD_PROJECT_ID", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, projectId: "acme<!--x-->" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_PROJECT_ID");
  });

  it("injection: a summary that forges/closes the region is rejected — SUMMARY_UNSAFE (KN-7)", () => {
    const r = deriveCopilotProjectKnowledgePlan(
      { ...goodIntent, summary: "ok <!-- /kw:region:project-status --> now human-owned" },
      deps(),
    );
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_SUMMARY_UNSAFE");
  });
});

describe("deriveCopilotProjectKnowledgePlan — intent validation fail-closed", () => {
  it("a bogus lifecycleState is rejected — BAD_LIFECYCLE (never lands in frontmatter)", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, lifecycleState: "robot" }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_LIFECYCLE");
  });

  it("accepts every ProjectLifecycleState member", () => {
    for (const lc of ["idea", "planning", "active", "paused", "done", "archived"]) {
      expect(isOk(deriveCopilotProjectKnowledgePlan({ ...goodIntent, lifecycleState: lc }, deps()))).toBe(true);
    }
  });

  it("an over-long summary is rejected — SUMMARY_TOO_LARGE", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, summary: "x".repeat(MAX_PROPOSE_SUMMARY_CHARS + 1) }, deps());
    expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_SUMMARY_TOO_LARGE");
  });

  it("a blank projectId / title is rejected", () => {
    expect(codeOf(deriveCopilotProjectKnowledgePlan({ ...goodIntent, projectId: "   " }, deps()))).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_PROJECT_ID");
    expect(codeOf(deriveCopilotProjectKnowledgePlan({ ...goodIntent, title: "" }, deps()))).toBe("COPILOT_PROPOSE_KNOWLEDGE_BAD_TITLE");
  });

  it("a non-object / wrong-typed / extra-key intent is MALFORMED (and NEVER throws)", () => {
    for (const bad of [null, undefined, 42, "str", [], { projectId: 1, title: "t", lifecycleState: "active" }, { ...goodIntent, extra: 1 }, { ...goodIntent, summary: 5 }]) {
      const r = deriveCopilotProjectKnowledgePlan(bad, deps());
      expect(isOk(r)).toBe(false);
      expect(codeOf(r)).toBe("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
    }
  });

  it("omitting the optional summary is fine (lifecycle-only proposal)", () => {
    const r = deriveCopilotProjectKnowledgePlan({ projectId: "p", title: "P", lifecycleState: "idea" }, deps());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.creates[0]!.body).toContain("**Proposed lifecycle:** idea");
  });

  it("a whitespace-only summary is accepted but dropped from the rendered body (no empty prose line)", () => {
    const r = deriveCopilotProjectKnowledgePlan({ ...goodIntent, summary: "   \t  " }, deps());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const body = r.value.creates[0]!.body;
    expect(body).toContain("**Proposed lifecycle:** active");
    // the region body is exactly the lifecycle line wrapped — no trailing blank prose line from the empty summary.
    expect(body).toContain("**Proposed lifecycle:** active\n<!-- /kw:region:project-status -->");
  });

  it("keys the planId on the note PATH so slug-colliding projectIds derive the SAME plan (one idempotent card)", () => {
    const a = deriveCopilotProjectKnowledgePlan({ ...goodIntent, projectId: "Acme Corp" }, deps());
    const b = deriveCopilotProjectKnowledgePlan({ ...goodIntent, projectId: "Acme  Corp!" }, deps());
    if (!isOk(a) || !isOk(b)) throw new Error("ok");
    // both slug to projects/personal-business/Acme-Corp.md → the same plan id (not two racing cards).
    expect(a.value.creates[0]!.path).toBe(b.value.creates[0]!.path);
    expect(String(a.value.planId)).toBe(String(b.value.planId));
  });

  it("this slice DERIVES only — the KMP carries NO external action proposals (semantic write, not external)", () => {
    const r = deriveCopilotProjectKnowledgePlan(goodIntent, deps());
    if (!isOk(r)) throw new Error("ok");
    expect(r.value.externalActionProposals).toEqual([]);
    expect(r.value.linkMutations).toEqual([]);
    expect(r.value.frontmatterUpdates).toEqual([]);
  });
});
