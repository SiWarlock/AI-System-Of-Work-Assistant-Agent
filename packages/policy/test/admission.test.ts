// spec(§5) — ING-7 untrusted-content admission gate (hard denial #3) + the
// candidate-data GATE COMPOSITION (discharges LESSONS.md §3: ajv `validate()` is
// STRUCTURAL-only; the composed gate = ajv ∘ Zod.refine ∘ ING-7 predicate ⊋ ajv
// alone) + WRITE_ADAPTER_OUTSIDE_GATEWAY (hard denial #4).
import { describe, it, expect } from "vitest";
import { validate } from "@sow/domain";
import { AgentJobSchema, AGENT_JOB_SCHEMA_ID, isOk } from "@sow/contracts";
import type { AgentJob } from "@sow/contracts";
import {
  admitJob,
  admitCandidateJob,
  denyWriteAdapterOutsideGateway,
} from "../src/admission";
import { isAllow, isDeny } from "../src/decision";
import { isRedactionSafe } from "../src/audit-signal";

function validCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-employer",
    capability: "meeting_closeout",
    contextRefs: [{ refKind: "source_envelope", ref: "src-1" }],
    outputSchemaId: "sow:knowledge-mutation-plan",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    providerRoute: {
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    },
    trustLevel: "trusted",
    carriesRawContent: false,
    maxRuntimeSeconds: 180,
    maxCostUsd: 2.5,
    idempotencyKey: "job-1-key",
    ...over,
  };
}

const parse = (o: Record<string, unknown>): AgentJob => AgentJobSchema.parse(o);

describe("admitCandidateJob — the composed candidate-data gate (LESSONS.md §3)", () => {
  it("gate ⊋ ajv-alone: ajv ADMITS read_only+allowsMutating:true but the composed gate DENIES it", () => {
    const candidate = validCandidate({
      toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: true },
    });
    // (1) ajv structural gate ADMITS — the Zod `.refine` is not in the JSON Schema.
    expect(isOk(validate(candidate, AGENT_JOB_SCHEMA_ID))).toBe(true);
    // (2)+(3) the composed gate DENIES via the Zod refine layer ajv drops.
    const d = admitCandidateJob(candidate);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies a structurally invalid candidate (ajv failure) with MALFORMED_POLICY_INPUT", () => {
    const d = admitCandidateJob({ not: "an agent job" });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("admits a well-formed trusted read_only candidate through all three stages", () => {
    const d = admitCandidateJob(validCandidate());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(isRedactionSafe(d.audit)).toBe(true);
  });
});

describe("admitJob — ING-7 gate", () => {
  it("rejects untrusted + mutating with the hard denial + a health signal", () => {
    const job = parse(
      validCandidate({
        toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
      }),
    );
    const d = admitJob({ ...job, trustLevel: "untrusted" as const });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
      expect(d.audit.denialCode).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
      expect(d.audit.healthSignalClass).toBeDefined();
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("admits untrusted + read_only (no mutation capability)", () => {
    const job = parse(validCandidate());
    const d = admitJob({ ...job, trustLevel: "untrusted" as const });
    expect(isAllow(d)).toBe(true);
  });

  it("admits trusted + mutating (trust overrides the ING-7 gate)", () => {
    const job = parse(
      validCandidate({
        toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
      }),
    );
    expect(isAllow(admitJob(job))).toBe(true);
  });

  it("treats an unclassified trust level as untrusted (fail-closed default)", () => {
    const job = parse(
      validCandidate({
        toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
      }),
    );
    const weird = { ...job, trustLevel: "unknown" as unknown as AgentJob["trustLevel"] };
    const d = admitJob(weird);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
  });
});

describe("denyWriteAdapterOutsideGateway — hard denial #4", () => {
  it("returns the WRITE_ADAPTER_OUTSIDE_GATEWAY hard denial + audit signal", () => {
    const d = denyWriteAdapterOutsideGateway({
      adapterRef: "@sow/integrations/notion-write-adapter",
    });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("WRITE_ADAPTER_OUTSIDE_GATEWAY");
      expect(d.audit.denialCode).toBe("WRITE_ADAPTER_OUTSIDE_GATEWAY");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });
});
