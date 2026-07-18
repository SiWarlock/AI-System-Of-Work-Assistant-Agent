// 18.27 / #13 Finding C — the `sow:agent-extraction` candidate flows through the REAL assembled broker.
//
// The GATE-1 (Lesson 51) `agent_extraction` candidate + normalizer case existed, but `assembleBackends`'s
// broker SCHEMA gate (`CANDIDATE_MODEL_SCHEMAS`) registered only the KMP + ProposedAction Zod parsers — so
// an accepted `agent_extraction` candidate failed closed at `schema_gate/schema_rejected` ("no model parser
// registered for 'sow:agent-extraction'"). This slice registers the parser so the subscription-extraction
// path (outputSchemaId → sow:agent-extraction) reaches the accepted candidate + the note-write path.
//
// SPEND-FREE: drives the REAL `assembleBackends` broker + the deterministic STUB run leg (a supplied
// `candidateOutput`, Lesson 50) — NO real SDK/completion/network/spend, no `providerTransport` arming.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isOk,
  isErr,
  validAgentJob,
  validKnowledgeMutationPlan,
  AGENT_EXTRACTION_SCHEMA_ID,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  workspaceId,
  sourceId,
} from "@sow/contracts";
import type { AgentJob, ProviderRoute, ProviderMatrix, EgressPolicy, SourceEnvelope } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { AgentExtraction, SourceIngestionContext } from "@sow/workflows";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { buildAutoIngestProofSpineParams } from "../../src/boot";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const NOW = "2026-07-18T00:00:00.000Z";

// ── candidate fixtures (the stubbed run-leg `candidateOutput`) ────────────────────────────────────
/** VALID sow:agent-extraction: `owner` evidence-backed (passes validateNoInference), `dueDate` = TBD sentinel. */
const VALID_AGENT_EXTRACTION = {
  fields: {
    owner: { value: "Alex", evidenceRef: "transcript#L12" },
    dueDate: { value: TBD },
  },
} as const;
/** MALFORMED: a field value that is a non-primitive object (the strict field schema rejects it). */
const MALFORMED_NONPRIMITIVE = { fields: { owner: { value: { nested: "obj" } } } };
/** MALFORMED: a prototype-pollution field key (L51 blocklist — via JSON.parse so it is an OWN key). */
const MALFORMED_PROTO = JSON.parse('{"fields":{"__proto__":{"value":"x","evidenceRef":"e"}}}') as unknown;
/** INFERRED: a CONCRETE value with NO evidenceRef — structurally valid but REQ-F-017 rejects it at validate. */
const INFERRED_AGENT_EXTRACTION = { fields: { owner: { value: "Carol" } } };

// ── passing route/matrix/egress/workspace (a loopback-local route — trivially egress-safe) ─────────
const loopbackLocalRoute: ProviderRoute = {
  provider: "ollama",
  model: "local-default",
  endpoint: LOCAL_ENDPOINT,
  egressClass: "local",
} as unknown as ProviderRoute;

const passingJob = (outputSchemaId: string, over: Record<string, unknown> = {}): AgentJob =>
  ({
    ...validAgentJob,
    outputSchemaId,
    providerRoute: loopbackLocalRoute,
    carriesRawContent: false,
    ...over,
  }) as unknown as AgentJob;

const passingMatrix: ProviderMatrix = {
  workspaceId: validAgentJob.workspaceId,
  allowedProviders: ["ollama"],
  capabilityDefaults: { "meeting.close": loopbackLocalRoute },
  rawCloudEgressEnabled: false,
} as unknown as ProviderMatrix;

const passingEgress: EgressPolicy = {
  workspaceId: validAgentJob.workspaceId,
  allowedProcessors: [],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
} as unknown as EgressPolicy;

const passingWorkspace = { type: "personal_business", dataOwner: "user" } as const;
const passingLocalConfig = { allowedLocalEndpoints: [LOCAL_ENDPOINT] };

/** Recursively collect every `.md` file under a root (relative paths). */
function findMarkdown(root: string, rel = ""): string[] {
  const abs = rel === "" ? root : join(root, rel);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const childRel = rel === "" ? entry : join(rel, entry);
    if (statSync(join(root, childRel)).isDirectory()) out.push(...findMarkdown(root, childRel));
    else if (entry.endsWith(".md")) out.push(childRel);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("18.27 — the assembled broker accepts/rejects sow:agent-extraction candidates (Finding C)", () => {
  const opened: ProofSpineBackends[] = [];
  const close = (): void => {
    for (const b of opened.splice(0)) b.close();
  };

  it("assembled_broker_accepts_agent_extraction — a VALID agent_extraction candidate + outputSchemaId=agent-extraction ⇒ accepted (no 'no model parser' schema_rejected)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: VALID_AGENT_EXTRACTION });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: passingJob(AGENT_EXTRACTION_SCHEMA_ID, { idempotencyKey: "idem-ae-accept" }),
      matrix: passingMatrix,
      egress: passingEgress,
      workspace: passingWorkspace,
      localConfig: passingLocalConfig,
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("agent_extraction");
    close();
  });

  it("assembled_broker_rejects_malformed_agent_extraction — a non-primitive field value ⇒ schema_gate/schema_rejected BY THE PARSER (not the missing-parser guard)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: MALFORMED_NONPRIMITIVE });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: passingJob(AGENT_EXTRACTION_SCHEMA_ID, { idempotencyKey: "idem-ae-malformed" }),
      matrix: passingMatrix,
      egress: passingEgress,
      workspace: passingWorkspace,
      localConfig: passingLocalConfig,
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("schema_gate");
    expect(outcome.error.reason).toBe("schema_rejected");
    // RED-first distinguisher: pre-impl the rejection is the missing-parser guard; post-impl it is the
    // registered parser ENFORCING the candidate-data gate (rule 2 / REQ-S-006).
    expect(outcome.error.message).not.toContain("no model parser");
    close();
  });

  it("assembled_broker_rejects_prototype_pollution_key — a `__proto__` field key ⇒ schema_gate/schema_rejected (L51 blocklist wired at the broker gate)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: MALFORMED_PROTO });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: passingJob(AGENT_EXTRACTION_SCHEMA_ID, { idempotencyKey: "idem-ae-proto" }),
      matrix: passingMatrix,
      egress: passingEgress,
      workspace: passingWorkspace,
      localConfig: passingLocalConfig,
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("schema_gate");
    expect(outcome.error.reason).toBe("schema_rejected");
    expect(outcome.error.message).not.toContain("no model parser");
    close();
  });

  it("existing_candidates_byte_equivalent — validKnowledgeMutationPlan + outputSchemaId=KMP ⇒ still accepted (the registry add is inert for non-agent-extraction jobs, L23)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: validKnowledgeMutationPlan });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: passingJob(KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, { idempotencyKey: "idem-kmp-accept" }),
      matrix: passingMatrix,
      egress: passingEgress,
      workspace: passingWorkspace,
      localConfig: passingLocalConfig,
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
    close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The GATE-1 payoff, e2e over the REAL source activities (buildProofSpineActivities over assembleBackends):
// sourceRunAgentJob (broker + mapAcceptedMeetingExtraction reconstruction) → validate (no-inference) →
// buildOutputs → commit (real KnowledgeWriter) → read the note back.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("18.27 — agent_extraction reconstructs, no-inference gates, and commits (e2e)", () => {
  const WS = "ws-e2e";
  const SRC_ID = sourceId("src-e2e-standup");
  const CONTENT_HASH = "sha256:e2e-standup";
  const TRANSCRIPT = "Standup: Alex will refactor the auth module by Friday.";

  const ctxFor = (): SourceIngestionContext => ({
    source: {
      sourceId: SRC_ID,
      workspaceId: workspaceId(WS),
      origin: "e2e://synthetic/standup",
      contentHash: CONTENT_HASH,
      type: "meeting_transcript",
      sensitivity: "normal",
      routingHints: {},
      body: TRANSCRIPT,
    } as SourceEnvelope,
    workspaceId: workspaceId(WS),
    envelopes: [],
  });

  const paramsWith = (outputSchemaId: string | undefined): ProofSpineParams => {
    const base = buildAutoIngestProofSpineParams(WS);
    return {
      ...base,
      sourceIngestion: {
        ...base.sourceIngestion!,
        ...(outputSchemaId !== undefined ? { outputSchemaId } : {}),
      },
    };
  };

  it("agent_extraction_reconstructs_and_commits — evidence-backed candidate ⇒ faithful reconstruction (value+evidenceRef) ⇒ validate PASSES ⇒ a note is committed + read back", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-ae-e2e-"));
    const backends = await assembleBackends(
      { now: () => NOW, vaultRoot, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: VALID_AGENT_EXTRACTION },
    );
    try {
      const acts = buildProofSpineActivities(backends, paramsWith(AGENT_EXTRACTION_SCHEMA_ID));
      const ctx = ctxFor();

      const run = await acts.sourceRunAgentJob(ctx);
      expect(isOk(run)).toBe(true);
      if (!isOk(run)) return;
      const extraction: AgentExtraction = run.value;
      // Faithful reconstruction: value + evidenceRef preserved (the GATE-1 payoff over the KMP stand-in).
      expect(extraction.fields.owner?.value).toBe("Alex");
      expect(extraction.fields.owner?.evidenceRef).toBe("transcript#L12");

      const validated = acts.meetingValidate(extraction);
      expect(isOk(validated)).toBe(true);
      if (!isOk(validated)) return;

      const built = await acts.sourceBuildOutputs(
        validated.value,
        workspaceId(WS),
        { sourceId: SRC_ID, contentHash: CONTENT_HASH },
        TRANSCRIPT,
      );
      expect(isOk(built)).toBe(true);
      if (!isOk(built)) return;

      const commit = await acts.sourceCommit(built.value.plan);
      expect(isOk(commit)).toBe(true);

      const md = findMarkdown(vaultRoot);
      expect(md.length).toBe(1);
      const note = readFileSync(join(vaultRoot, md[0]!), "utf8");
      expect(note).toContain(TRANSCRIPT); // the real body (Lesson 35)
      expect(note).toContain("owner"); // the extraction frontmatter (Lesson 49)
      expect(note).toContain("Alex"); // the reconstructed evidence-backed value
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("buildactivities_reads_binding_outputschemaid — UNSET binding ⇒ the source job falls back to KMP ⇒ the agent_extraction candidate is schema_rejected (byte-equivalent unarmed; contrast with the accept above)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: VALID_AGENT_EXTRACTION });
    try {
      const acts = buildProofSpineActivities(backends, paramsWith(undefined)); // sourceIngestion.outputSchemaId unset
      const run = await acts.sourceRunAgentJob(ctxFor());
      // The job carried KMP (the default) ⇒ the agent_extraction candidate fails the KMP structural gate ⇒
      // the source agent returns a typed err (contrast with the accept above — proves buildActivities reads
      // `sourceBinding.outputSchemaId`, not a hardcoded id). The specific fail-closed code is not load-bearing.
      expect(isErr(run)).toBe(true);
    } finally {
      backends.close();
    }
  });

  it("inferred_candidate_rejected_no_note — a CONCRETE value with NO evidenceRef passes the broker structurally but validateNoInference REJECTS ⇒ NO note (REQ-F-017); a TBD value is the positive control", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-ae-inferred-"));
    const backends = await assembleBackends(
      { now: () => NOW, vaultRoot, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: INFERRED_AGENT_EXTRACTION },
    );
    try {
      const acts = buildProofSpineActivities(backends, paramsWith(AGENT_EXTRACTION_SCHEMA_ID));
      // The broker accepts the inferred candidate STRUCTURALLY (evidenceRef is optional at the schema level).
      const run = await acts.sourceRunAgentJob(ctxFor());
      expect(isOk(run)).toBe(true);
      if (!isOk(run)) return;
      // …but validateNoInference REJECTS a concrete value with no evidence (REQ-F-017) ⇒ NO commit / NO note.
      const validated = acts.meetingValidate(run.value);
      expect(isErr(validated)).toBe(true);
      expect(findMarkdown(vaultRoot).length).toBe(0);

      // Positive control (non-vacuity): the SAME field with a TBD value validates OK (no evidence needed).
      const positive = acts.meetingValidate({ fields: { owner: { value: TBD } } });
      expect(isOk(positive)).toBe(true);
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
