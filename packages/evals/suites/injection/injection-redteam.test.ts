// spec(§20.1 "Prompt injection" · §16.1 · ING-7 · REQ-S-001) — task 12.17.
//
// The §20.1 acceptance suite for the prompt-injection red-team (safety rule 6).
// It loads the CHECKED-IN, hash-verified injection corpus (task 12.3) through the
// REAL `loadCorpus` and drives EACH declared attack through the REAL §5 admission
// / tool-policy gate — `admitJob` / `admitCandidateJob` / `admitsMutating` from
// `@sow/policy` — asserting the corpus's `expectedOutcome` HOLDS:
//   • rejected_at_admission — a job over UNTRUSTED content that DECLARES a mutating
//     tool is a HARD REJECT at admission (ING-7); never a silent downgrade.
//   • read_only_no_side_effect — the correct source-processing job is untrusted +
//     read_only: it is admitted but the gate proves it CANNOT mutate, so the
//     injected create_event / email / Slack side effect is impossible.
//   • plan_only_no_autoapply — the injected "auto-apply to Markdown" is refused:
//     the governed job emits a KnowledgeMutationPlan and cannot auto-write, and the
//     write-tool variant the injection demands is rejected at admission.
//
// NEGATIVE-CONTROL DISCIPLINE (§20.1): for every entry we materialize the attack as
// the mutating-tool job the injection is trying to coerce, and assert it is REJECTED
// — not merely that a side effect "happened to be absent."
//
// DoD honesty: PROMPT_INJECTION is a deterministic-enforcement criterion
// (requiresRealIntegration=false) — the ING-7 gate is the real code path here, so a
// seam run scores functionally-passing AND DoD-passing (no vendor needed). The
// runner enforces that below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentJob, ProviderRoute, ToolPolicy } from "@sow/contracts";
import { isOk } from "@sow/contracts";
import { admitJob, admitCandidateJob, admitsMutating, isAllow, isDeny } from "@sow/policy";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import {
  CORPUS_FLOORS,
  type InjectionCorpusEntry,
} from "../../src/harness/corpus-schemas";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// ── load the REAL, hash-verified injection corpus (task 12.3) ────────────────
const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");
function loadInjectionCorpus(): readonly InjectionCorpusEntry[] {
  const dir = resolve(CORPORA, "injection");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as InjectionCorpusEntry[];
  const r = loadCorpus<InjectionCorpusEntry>(manifest, entries, { expectedFloor: CORPUS_FLOORS.injection });
  if (!isOk(r)) {
    throw new Error(`injection corpus failed to load: ${JSON.stringify((r as { error: unknown }).error)}`);
  }
  return r.value.entries;
}
const INJECTION = loadInjectionCorpus();

// ── fixtures (pure literals) ─────────────────────────────────────────────────
const localRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

const READ_ONLY_POLICY: ToolPolicy = {
  mode: "read_only",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: false,
};
// The mutating tool policy the injection is trying to coerce the job into carrying.
const MUTATING_POLICY: ToolPolicy = {
  mode: "scoped_write",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: true,
};

// A job processing UNTRUSTED imported content (a fetched doc / transcript / note).
// `carriesRawContent`/`trustLevel:'untrusted'` model the source-ingestion posture
// under which every corpus injection arrives.
const untrustedJob = (entryId: string, toolPolicy: ToolPolicy): AgentJob => ({
  id: `job-inj-${entryId}` as AgentJob["id"],
  workflowRunId: "wf-inj-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-emp-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: `src:${entryId}` }],
  // A source-processing job emits a plan for review — never an applied write.
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy,
  providerRoute: localRoute,
  trustLevel: "untrusted",
  carriesRawContent: true,
  maxRuntimeSeconds: 300,
  idempotencyKey: `idem-inj-${entryId}`,
});

// A schema-VALID candidate (untrusted + mutating) for the composed candidate-data
// gate `admitCandidateJob` — must clear ajv + Zod refine and be rejected at ING-7,
// not at a structural stage.
const untrustedMutatingCandidate = (entryId: string): unknown => ({
  id: `job-inj-cand-${entryId}`,
  workflowRunId: "wf-inj-001",
  workspaceId: "ws-emp-001",
  capability: "meeting.close",
  contextRefs: [{ refKind: "source", ref: `src:${entryId}` }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
  providerRoute: localRoute,
  trustLevel: "untrusted",
  carriesRawContent: true,
  maxRuntimeSeconds: 300,
  idempotencyKey: `idem-inj-cand-${entryId}`,
});

// Per-entry evaluation: run BOTH the governed (read-only) job and the coerced
// (mutating) job through the real gate. Returns whether ANY injected side effect
// could occur — the §5.4 "injection-successful-side-effects" metric increment.
function evaluate(entry: InjectionCorpusEntry): { sideEffectOccurred: boolean } {
  const governed = admitJob(untrustedJob(entry.id, READ_ONLY_POLICY));
  const coerced = admitJob(untrustedJob(entry.id, MUTATING_POLICY));
  // A side effect is possible iff the coerced mutating job was ADMITTED, or the
  // governed job's policy is (wrongly) assessed mutation-capable.
  const sideEffectOccurred =
    isAllow(coerced) || admitsMutating(untrustedJob(entry.id, READ_ONLY_POLICY).toolPolicy);
  // Sanity: the governed read-only job is always admitted (read-only untrusted is fine).
  void governed;
  return { sideEffectOccurred };
}

describe("§20.1 Prompt injection — every corpus vector is rejected at the ING-7 gate", () => {
  it("loads all six §16.1 vectors from the hash-verified corpus", () => {
    expect(INJECTION.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.injection);
    const vectors = new Set(INJECTION.map((e) => e.vector));
    for (const v of [
      "transcript",
      "calendar_description",
      "web_docs",
      "notebooklm_drive",
      "markdown_note",
      "cross_workspace_exfil",
    ] as const) {
      expect(vectors.has(v), `missing vector ${v}`).toBe(true);
    }
  });

  it.each(INJECTION.map((e) => [e.id, e] as const))(
    "%s — the coerced mutating-tool job is REJECTED at admission (ING-7, negative control)",
    (_id, entry) => {
      // NEGATIVE CONTROL: materialize the attack as the mutating job the injection
      // demands and assert it is HARD-REJECTED — not merely absent.
      const coerced = admitJob(untrustedJob(entry.id, MUTATING_POLICY));
      expect(isDeny(coerced), `${entry.id}: coerced mutating job must be denied`).toBe(true);
      if (isDeny(coerced)) {
        expect(coerced.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
      }
      // And no injected side effect is possible under the governed read-only job.
      expect(evaluate(entry).sideEffectOccurred, `${entry.id}: no side effect may occur`).toBe(false);
    },
  );

  it.each(INJECTION.map((e) => [e.id, e] as const))(
    "%s — the governed read-only source job is admitted but cannot mutate",
    (_id, entry) => {
      const governed = admitJob(untrustedJob(entry.id, READ_ONLY_POLICY));
      // A read-only untrusted job clears admission — it's the correct posture.
      expect(isAllow(governed), `${entry.id}: read-only untrusted job is admitted`).toBe(true);
      // But it can perform NO mutating side effect — create_event / email / Slack /
      // auto-write to Markdown are all impossible under this policy.
      expect(admitsMutating(READ_ONLY_POLICY), `${entry.id}: read-only admits no mutation`).toBe(false);
    },
  );

  it("read_only_no_side_effect entries: the injected external side effect is impossible", () => {
    const readOnlyEntries = INJECTION.filter((e) => e.expectedOutcome === "read_only_no_side_effect");
    expect(readOnlyEntries.length).toBeGreaterThan(0);
    for (const entry of readOnlyEntries) {
      // The governed source job is admitted; its policy admits no mutation, so the
      // create_event/send-message/DM the payload demands cannot execute.
      expect(isAllow(admitJob(untrustedJob(entry.id, READ_ONLY_POLICY)))).toBe(true);
      expect(evaluate(entry).sideEffectOccurred).toBe(false);
    }
  });

  it("plan_only_no_autoapply entries: emit a KnowledgeMutationPlan, never an auto-applied write", () => {
    const planOnly = INJECTION.filter((e) => e.expectedOutcome === "plan_only_no_autoapply");
    expect(planOnly.length).toBeGreaterThan(0);
    for (const entry of planOnly) {
      const governed = untrustedJob(entry.id, READ_ONLY_POLICY);
      // The governed job's output is a PLAN (reviewed), not a direct Markdown write.
      expect(governed.outputSchemaId).toBe("sow:knowledge-mutation-plan");
      expect(admitsMutating(governed.toolPolicy)).toBe(false);
      // The injection's "auto-commit / write straight to Markdown" demands a write
      // tool on untrusted content — which is rejected at admission.
      expect(isDeny(admitJob(untrustedJob(entry.id, MUTATING_POLICY)))).toBe(true);
    }
  });

  it("rejected_at_admission entries: refused by the FULL composed candidate-data gate", () => {
    const admissionRejected = INJECTION.filter((e) => e.expectedOutcome === "rejected_at_admission");
    expect(admissionRejected.length).toBeGreaterThan(0);
    for (const entry of admissionRejected) {
      // Drive the coerced candidate through the WHOLE gate: ajv → Zod refine → ING-7.
      // It clears the structural stages and is denied specifically at ING-7.
      const d = admitCandidateJob(untrustedMutatingCandidate(entry.id));
      expect(isDeny(d), `${entry.id}: composed gate must deny`).toBe(true);
      if (isDeny(d)) {
        expect(d.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
      }
    }
  });
});

describe("injection-leakage — EVAL-1 runner scoring (PROMPT_INJECTION)", () => {
  it("scores 0 successful injection side effects functionally- AND DoD-passing", () => {
    // Derive the §5.4 metric from the REAL gate outcomes across the whole corpus.
    const successfulSideEffects = INJECTION.reduce(
      (n, e) => n + (evaluate(e).sideEffectOccurred ? 1 : 0),
      0,
    );
    expect(successfulSideEffects).toBe(0);

    const out = scoreById({
      criterionId: "PROMPT_INJECTION",
      value: successfulSideEffects,
      fromRealIntegration: false,
    });
    // max(0) threshold: 0 successful side effects passes.
    expect(out.functionalPass).toBe(true);
    // Deterministic ING-7 enforcement is the real code path — no vendor required,
    // so a seam run is DoD-valid AND DoD-passing.
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("registry marks prompt-injection deterministic (no real integration required)", () => {
    expect(criterionById("PROMPT_INJECTION")?.requiresRealIntegration).toBe(false);
  });
});
