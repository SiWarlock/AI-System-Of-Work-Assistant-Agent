// spec(§7) — 5.5 output normalization + tool-policy enforcement + strict side-effect rule.
// The normalizer maps a VALIDATED candidate output into a KnowledgeMutationPlan /
// ProposedAction CANDIDATE (never applied), returns DATA ONLY (no I/O, no write
// adapter), and exposes the tool-policy predicate the gate uses to reject a
// read_only job whose output implies a mutating external action.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOk, isErr } from "@sow/contracts";
import type { AgentJob } from "@sow/contracts";
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  PROPOSED_ACTION_SCHEMA_ID,
} from "@sow/contracts";
import { validAgentJob, validKnowledgeMutationPlan, validProposedAction } from "@sow/contracts";
import {
  bySchemaIdNormalizer,
  candidateImpliesMutatingAction,
  toolPolicyForbidsMutation,
  enforceToolPolicyOnCandidate,
  type BrokerCandidate,
} from "../src/broker/output-normalizer";

const kmpNoExternal = { ...validKnowledgeMutationPlan, externalActionProposals: [] };
const kmpWithExternal = { ...validKnowledgeMutationPlan, externalActionProposals: [validProposedAction] };

const readOnlyKmpJob: AgentJob = {
  ...validAgentJob,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
};

const scopedWriteActionJob: AgentJob = {
  ...validAgentJob,
  outputSchemaId: PROPOSED_ACTION_SCHEMA_ID,
  toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
};

describe("bySchemaIdNormalizer — maps validated output → the right candidate kind", () => {
  it("KMP schema id → knowledge_mutation_plan candidate", () => {
    const out = bySchemaIdNormalizer()(readOnlyKmpJob, kmpNoExternal);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.kind).toBe("knowledge_mutation_plan");
    if (out.value.kind !== "knowledge_mutation_plan") return;
    expect(out.value.plan).toEqual(kmpNoExternal);
  });

  it("ProposedAction schema id → proposed_action candidate", () => {
    const out = bySchemaIdNormalizer()(scopedWriteActionJob, validProposedAction);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.kind).toBe("proposed_action");
    if (out.value.kind !== "proposed_action") return;
    expect(out.value.action).toEqual(validProposedAction);
  });

  it("an unknown outputSchemaId is unnormalizable (typed err, never a throw)", () => {
    const job: AgentJob = { ...validAgentJob, outputSchemaId: "sow:not-a-candidate-shape" };
    const out = bySchemaIdNormalizer()(job, {});
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("unnormalizable");
  });
});

describe("candidateImpliesMutatingAction — external mutation detection", () => {
  it("a proposed_action candidate ALWAYS implies a mutating external action", () => {
    const c: BrokerCandidate = { kind: "proposed_action", action: validProposedAction };
    expect(candidateImpliesMutatingAction(c)).toBe(true);
  });

  it("a KMP carrying external action proposals implies a mutating external action", () => {
    const c: BrokerCandidate = { kind: "knowledge_mutation_plan", plan: kmpWithExternal };
    expect(candidateImpliesMutatingAction(c)).toBe(true);
  });

  it("a KMP with NO external action proposals does not (KnowledgeWriter is the writer, not a tool)", () => {
    const c: BrokerCandidate = { kind: "knowledge_mutation_plan", plan: kmpNoExternal };
    expect(candidateImpliesMutatingAction(c)).toBe(false);
  });
});

describe("toolPolicyForbidsMutation — read_only / !allowsMutating forbids mutation", () => {
  it("read_only (allowsMutating=false) forbids", () => {
    expect(toolPolicyForbidsMutation(readOnlyKmpJob)).toBe(true);
  });
  it("scoped_write allowsMutating=true permits", () => {
    expect(toolPolicyForbidsMutation(scopedWriteActionJob)).toBe(false);
  });
});

describe("enforceToolPolicyOnCandidate — reject, never silently coerce (5.5 bullet 4)", () => {
  it("read_only job + proposed_action → tool_policy_violation", () => {
    const c: BrokerCandidate = { kind: "proposed_action", action: validProposedAction };
    const out = enforceToolPolicyOnCandidate(readOnlyKmpJob, c);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("tool_policy_violation");
  });

  it("read_only job + KMP with external action proposals → tool_policy_violation", () => {
    const c: BrokerCandidate = { kind: "knowledge_mutation_plan", plan: kmpWithExternal };
    const out = enforceToolPolicyOnCandidate(readOnlyKmpJob, c);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("tool_policy_violation");
  });

  it("read_only job + KMP with no external actions → ok (candidate unchanged, not coerced)", () => {
    const c: BrokerCandidate = { kind: "knowledge_mutation_plan", plan: kmpNoExternal };
    const out = enforceToolPolicyOnCandidate(readOnlyKmpJob, c);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value).toBe(c); // same reference — no coercion/rebuild
  });

  it("scoped_write allowsMutating job + proposed_action → ok", () => {
    const c: BrokerCandidate = { kind: "proposed_action", action: validProposedAction };
    const out = enforceToolPolicyOnCandidate(scopedWriteActionJob, c);
    expect(isOk(out)).toBe(true);
  });
});

describe("strict side-effect rule — normalizer returns DATA, performs NO I/O", () => {
  it("bySchemaIdNormalizer returns synchronously (not a Promise/thenable)", () => {
    const out = bySchemaIdNormalizer()(readOnlyKmpJob, kmpNoExternal);
    expect(typeof (out as { then?: unknown }).then).toBe("undefined");
  });

  it("output-normalizer.ts imports NO write-adapter / I/O package (architectural import test)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/broker/output-normalizer.ts", import.meta.url)),
      "utf8",
    );
    for (const spec of forbiddenImportSpecifiers) {
      expect(importSpecifiers(src)).not.toContain(spec);
    }
  });
});

// ── shared: architectural-import-test helpers (the strict side-effect rule) ────
export const forbiddenImportSpecifiers = [
  "@sow/knowledge",
  "@sow/integrations",
  "@sow/db",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "http",
  "https",
];

export function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}
