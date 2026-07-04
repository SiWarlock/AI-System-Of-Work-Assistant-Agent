// spec(§4.6 Copilot Q&A / safety rules 2·4·5 / WS-7 leakage) — Copilot GOVERNANCE conformance.
//
// The Copilot backend's SAFETY properties, exercised end-to-end as a deterministic conformance
// battery over the committed worker functions (retrieval → orchestration → candidate-data gate,
// and the egress veto). The synthesis is an interim STUB, so these are DETERMINISTIC governance
// checks — NOT a model-prose eval.
//
// DEFERRED (the model eval, explicitly out of scope here): retrieval GROUNDING (does the answer
// reflect the retrieved context?) and citation CORRECTNESS (do citations support the claim?) are
// QUALITY properties of the real LLM synthesis — they need the AgentRuntimePort/ModelProviderPort
// wired to a real provider + a labeled corpus (PRD §20.1 acceptance; EVAL-1 floors). The app runs
// over stubs today, so those are a follow-up. This suite pins the GOVERNANCE that holds regardless
// of the model: read-only / no side effects, WS-8 workspace isolation, the Employer-Work egress
// veto, and no raw-content SHAPE surviving the UI-safe gate.
import { describe, it, expect } from "vitest";
import {
  isOk,
  isErr,
  UI_SAFE_ALLOWLIST,
  processorId,
  type AgentJob,
  type DataOwner,
  type EgressPolicy,
  type ProviderRoute,
  type UiSafeCopilotAnswer,
  type WorkspaceType,
} from "@sow/contracts";
import {
  answerCopilotQuestion,
  toUiSafeCopilotAnswer,
  guardCopilotEgress,
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
  localWorkspacePosture,
  type CandidateCopilotAnswer,
  type CopilotDeps,
  type RetrievedContext,
} from "@sow/worker/api/procedures/copilot";

// The full newline family the summary-line gate neutralizes: CR, LF, VT, FF, NEL, LS, PS. A
// charCode Set (NOT a regex) so no escape/literal-line-terminator ever sits in the source (a literal
// U+2028/U+2029 would terminate a line; the same trap fixed in the write-side normalizer).
const NL_CODES = new Set([0x0d, 0x0a, 0x0b, 0x0c, 0x85, 0x2028, 0x2029]);
function hasNewlineFamily(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (NL_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const NEL = String.fromCodePoint(0x85);

// ── three distinct workspaces, each with its OWN sources ──────────────────────
const WS_EMPLOYER = "ws-employer";
const WS_PERSONAL = "ws-personal";
const WS_LIFE = "ws-life";

function ctx(workspaceId: string, sourceTag: string): RetrievedContext {
  return {
    workspaceId,
    blocks: [`RAW_BLOCK_${sourceTag}_should_never_surface`],
    sources: [{ citationId: `src:${sourceTag}`, title: `${sourceTag} note` }],
  };
}

const allFixtures: Readonly<Record<string, RetrievedContext>> = {
  [WS_EMPLOYER]: ctx(WS_EMPLOYER, "employer"),
  [WS_PERSONAL]: ctx(WS_PERSONAL, "personal"),
  [WS_LIFE]: ctx(WS_LIFE, "life"),
};

const deps: CopilotDeps = {
  retrieval: createFixtureRetrieval(allFixtures),
  synthesis: createStubSynthesis(),
  // All three workspaces resolve to a local posture + a local route ⇒ the egress decision allows
  // with no notice, so the leakage battery still serves the interim {answer, citations}.
  workspacePosture: createLocalWorkspacePosture({
    [WS_EMPLOYER]: localWorkspacePosture(WS_EMPLOYER, "employer_work"),
    [WS_PERSONAL]: localWorkspacePosture(WS_PERSONAL),
    [WS_LIFE]: localWorkspacePosture(WS_LIFE, "personal_life"),
  }),
  routeSelector: createLocalRouteSelector(),
};

// ── 1. Read-only / no side effects (§4.6) ─────────────────────────────────────
describe("Copilot governance — read-only / no side effects (§4.6)", () => {
  it("the served answer surface carries ONLY answer/citations + the egress notice — no action/write/execution field", () => {
    // The UI-safe allowlist is the frozen surface: answer + citations + an OPTIONAL `egressProcessor`
    // (a read-only egress NOTICE label — §9.6 real-model follow-up, safety rule 5). It names no
    // execution/write/apply field, so a Copilot answer structurally cannot carry a side effect (an
    // action becomes an Approvals proposal instead).
    expect([...UI_SAFE_ALLOWLIST.copilotAnswer].sort()).toEqual(["answer", "citations", "egressProcessor"]);
    for (const forbidden of ["action", "execute", "apply", "write", "mutation", "sideEffect", "proposal"]) {
      expect(UI_SAFE_ALLOWLIST.copilotAnswer).not.toContain(forbidden);
    }
  });

  it("the served answer's runtime field set is a SUBSET of the allowlist (no field smuggled)", async () => {
    const r = await answerCopilotQuestion(deps, { workspaceId: WS_EMPLOYER, question: "q" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // Every served key is allowlisted (nothing smuggled). `egressProcessor` is OPTIONAL — OMITTED
      // for this local/no-egress stub answer — so the served set is a subset, not an exact match.
      const allowed = new Set<string>(UI_SAFE_ALLOWLIST.copilotAnswer);
      for (const k of Object.keys(r.value)) expect(allowed.has(k), `key ${k} allowlisted`).toBe(true);
      expect(r.value).toHaveProperty("answer");
      expect(r.value).toHaveProperty("citations");
    }
  });
});

// ── 2. WS-8 workspace isolation (no cross-workspace leak) ──────────────────────
describe("Copilot governance — WS-8 workspace isolation (no cross-workspace leak)", () => {
  it("each workspace's answer cites ONLY that workspace's own sources", async () => {
    const cases: ReadonlyArray<{ ws: string; own: string; foreign: readonly string[] }> = [
      { ws: WS_EMPLOYER, own: "src:employer", foreign: ["src:personal", "src:life"] },
      { ws: WS_PERSONAL, own: "src:personal", foreign: ["src:employer", "src:life"] },
      { ws: WS_LIFE, own: "src:life", foreign: ["src:employer", "src:personal"] },
    ];
    for (const c of cases) {
      const r = await answerCopilotQuestion(deps, { workspaceId: c.ws, question: "what do we know?" });
      expect(isOk(r), `ask on ${c.ws}`).toBe(true);
      if (isOk(r)) {
        const citedIds = r.value.citations.map((x) => x.citationId);
        expect(citedIds).toContain(c.own);
        for (const foreign of c.foreign) expect(citedIds).not.toContain(foreign);
      }
    }
  });

  it("an UNKNOWN workspace fails CLOSED — never synthesizes, never leaks another workspace", async () => {
    const r = await answerCopilotQuestion(deps, { workspaceId: "ws-does-not-exist", question: "q" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("a retrieval adapter returning FOREIGN-scoped context fails CLOSED (defense-in-depth)", async () => {
    // Mis-keyed fixture: the WS_EMPLOYER key carries WS_PERSONAL's context → scope guard rejects.
    const misKeyed: CopilotDeps = {
      retrieval: createFixtureRetrieval({ [WS_EMPLOYER]: ctx(WS_PERSONAL, "personal") }),
      synthesis: createStubSynthesis(),
      // Scope guard rejects BEFORE posture resolution, so an empty posture map is unreached here.
      workspacePosture: createLocalWorkspacePosture({}),
      routeSelector: createLocalRouteSelector(),
    };
    const r = await answerCopilotQuestion(misKeyed, { workspaceId: WS_EMPLOYER, question: "q" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("no RAW block ever surfaces in a served answer (raw passages stay worker-side)", async () => {
    for (const ws of [WS_EMPLOYER, WS_PERSONAL, WS_LIFE]) {
      const r = await answerCopilotQuestion(deps, { workspaceId: ws, question: "q" });
      // Assert the ask SUCCEEDED first — without this the `if` would silently skip the check if the
      // ask ever started erroring (a green-on-failure trap).
      expect(isOk(r), `ask on ${ws}`).toBe(true);
      if (isOk(r)) {
        // Forward-looking regression pin: today the stub never touches `context.blocks`, so this
        // can't match — it TRIPS if a future synthesis starts echoing a raw passage into the answer.
        expect(JSON.stringify(r.value)).not.toMatch(/RAW_BLOCK_/);
      }
    }
  });
});

// ── 3. Employer-Work egress veto (safety rule 5) ──────────────────────────────
const cloudRoute: ProviderRoute = { provider: "claude", model: "claude-opus-4", endpoint: "https://api.anthropic.com", egressClass: "cloud" };
const localRoute: ProviderRoute = { provider: "ollama", model: "llama3.1", endpoint: "http://127.0.0.1:11434", egressClass: "local" };
const tunneledRoute: ProviderRoute = { provider: "ollama", model: "llama3.1", endpoint: "https://exfil.example.com:11434", egressClass: "local" };

const job: AgentJob = {
  id: "job-copilot" as AgentJob["id"],
  workflowRunId: "wf" as AgentJob["workflowRunId"],
  workspaceId: "ws-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: cloudRoute,
  trustLevel: "trusted",
  carriesRawContent: true,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem",
};
const egress = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: "ws-001" as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
  ...over,
});
const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const personalWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };

describe("Copilot governance — Employer-Work egress veto (safety rule 5)", () => {
  it("employer-work raw + ack OFF: DENIES cloud AND tunneled-'local' (no cloud fallback)", () => {
    for (const route of [cloudRoute, tunneledRoute]) {
      const r = guardCopilotEgress({ job, route, egress: egress(), workspace: employerWs });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    }
  });

  it("employer-work raw + ack OFF: ALLOWS a genuine loopback-local route (never substitutes it)", () => {
    const r = guardCopilotEgress({ job, route: localRoute, egress: egress(), workspace: employerWs });
    expect(isOk(r)).toBe(true);
    // Narrow-only: the permitted route is the SAME one handed in (the veto denies/narrows, never widens).
    if (isOk(r)) expect(r.value).toEqual(localRoute);
  });

  it("employer-work with ack ON, and personal-workspace cloud: ALLOWED (allowlisted)", () => {
    expect(isOk(guardCopilotEgress({ job, route: cloudRoute, egress: egress({ employerRawEgressAcknowledged: true }), workspace: employerWs }))).toBe(true);
    expect(isOk(guardCopilotEgress({ job, route: cloudRoute, egress: egress(), workspace: personalWs }))).toBe(true);
  });
});

// ── 4. No raw-content SHAPE survives the UI-safe candidate-data gate (leakage battery) ──
// ≥15 raw-content-shaped candidates. A leak-shaped citationId / structural violation is REJECTED;
// a multi-line / over-length answer block or title is NORMALIZED to a single-line, ≤1024 shape.
// Either way, no raw multi-line / over-length SHAPE crosses to the renderer. (The SEMANTIC "is this
// raw note content" property is the model's no-inference job — the deferred eval above.)
const okCite = { citationId: "src:ok", title: "ok" };
const base: CandidateCopilotAnswer = { answer: ["A safe answer."], citations: [okCite] };

function isShapeSafe(a: UiSafeCopilotAnswer): boolean {
  const strings = [...a.answer, ...a.citations.map((c) => c.title)];
  return strings.every((s) => !hasNewlineFamily(s) && s.length <= 1024);
}

const REJECT_CASES: ReadonlyArray<{ name: string; candidate: CandidateCopilotAnswer }> = [
  { name: "citationId = absolute path", candidate: { ...base, citations: [{ citationId: "/etc/passwd", title: "t" }] } },
  { name: "citationId = https URL", candidate: { ...base, citations: [{ citationId: "https://internal.acme/doc", title: "t" }] } },
  { name: "citationId = path traversal", candidate: { ...base, citations: [{ citationId: "../../secret", title: "t" }] } },
  { name: "citationId = file URL", candidate: { ...base, citations: [{ citationId: "file:///x", title: "t" }] } },
  { name: "citationId with whitespace", candidate: { ...base, citations: [{ citationId: "a b", title: "t" }] } },
  { name: "citationId empty", candidate: { ...base, citations: [{ citationId: "", title: "t" }] } },
  { name: "citationId over 128 chars", candidate: { ...base, citations: [{ citationId: "x".repeat(200), title: "t" }] } },
  { name: "empty answer", candidate: { ...base, answer: [] } },
  { name: "answer over the 40-block cap", candidate: { ...base, answer: Array(41).fill("line") } },
  { name: "citations over the 20 cap", candidate: { ...base, citations: Array(21).fill(okCite) } },
  { name: "empty title", candidate: { ...base, citations: [{ citationId: "src:x", title: "" }] } },
];

const NORMALIZE_CASES: ReadonlyArray<{ name: string; candidate: CandidateCopilotAnswer }> = [
  { name: "answer block with LF", candidate: { ...base, answer: ["line one\nRAW leaked line two"] } },
  { name: "answer block with CR", candidate: { ...base, answer: ["line one\rRAW leaked"] } },
  { name: "answer block with LS (U+2028)", candidate: { ...base, answer: [`a${LS}RAW`] } },
  { name: "answer block with PS (U+2029)", candidate: { ...base, answer: [`a${PS}RAW`] } },
  { name: "answer block with NEL (U+0085)", candidate: { ...base, answer: [`a${NEL}RAW`] } },
  { name: "answer block over 1024 chars", candidate: { ...base, answer: ["x".repeat(2000)] } },
  { name: "citation title multi-line", candidate: { ...base, citations: [{ citationId: "src:x", title: "title\nRAW body" }] } },
  { name: "citation title over 1024 chars", candidate: { ...base, citations: [{ citationId: "src:x", title: "y".repeat(2000) }] } },
];

describe("Copilot governance — no raw-content SHAPE survives the UI-safe gate (leakage battery)", () => {
  it(`runs a leakage battery of ${String(REJECT_CASES.length + NORMALIZE_CASES.length)} cases (≥15 floor)`, () => {
    expect(REJECT_CASES.length + NORMALIZE_CASES.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of REJECT_CASES) {
    it(`REJECTS: ${c.name}`, () => {
      expect(isErr(toUiSafeCopilotAnswer(c.candidate))).toBe(true);
    });
  }

  for (const c of NORMALIZE_CASES) {
    it(`NORMALIZES to a single-line, bounded shape: ${c.name}`, () => {
      const r = toUiSafeCopilotAnswer(c.candidate);
      expect(isOk(r)).toBe(true);
      if (isOk(r)) {
        expect(isShapeSafe(r.value)).toBe(true);
        for (const s of [...r.value.answer, ...r.value.citations.map((x) => x.title)]) {
          expect(hasNewlineFamily(s)).toBe(false);
        }
      }
    });
  }
});
