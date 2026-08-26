// spec(§5, §7) — task 9.32: the missing ProviderMatrix PRODUCER. Owner ruling
// 2026-07-29: an EMPTY providerMatrix is a CORRECT state, not a defect — this
// suite pins that the producer never fabricates a route, only ever admits a
// candidate that a real conformance check (the injected certifier) PASSED, and
// never defaults `rawCloudEgressEnabled` to a permissive value. The certifier
// itself is the arming-gated seam (a real one calls a provider over the network)
// — this suite injects only fakes; nothing here binds a real certifier.
import { describe, it, expect, vi } from "vitest";
import type { Capability, ConformanceResult, ProviderId, ProviderRoute, WorkspaceId } from "@sow/contracts";
import { ProviderMatrixSchema } from "@sow/contracts";
import {
  buildProviderMatrix,
  type ProviderConformanceCertifier,
  type ProviderMatrixCandidate,
} from "../src/provider-matrix-producer";

const WS = "ws-producer-001" as WorkspaceId;
const CAP_CLOSE = "meeting.close" as Capability;
const CAP_SYNTH = "note.synthesize" as Capability;

const cloudClaudeRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

const localOllamaRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

const agentRuntimeRoute: ProviderRoute = {
  runtime: "claude-agent-sdk",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

/** A fake certifier: always returns the given fixed verdict for every candidate it sees. */
function fakeCertifier(status: ConformanceResult["status"]): ProviderConformanceCertifier {
  return async (candidate: ProviderMatrixCandidate): Promise<ConformanceResult> => ({
    subjectKind: "provider" in candidate.route ? "provider" : "runtime",
    subjectId: "provider" in candidate.route ? candidate.route.provider : candidate.route.runtime,
    capability: candidate.capability,
    model: candidate.route.model,
    egressClass: candidate.route.egressClass,
    status,
    checkedAt: "2026-08-25T00:00:00.000Z",
  });
}

describe("buildProviderMatrix — empty input stays empty (owner ruling: absence is correct)", () => {
  it("no candidates ⇒ an empty, schema-valid matrix", async () => {
    const m = await buildProviderMatrix(WS, [], fakeCertifier("passing"));
    expect(m.workspaceId).toBe(WS);
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults).toEqual({});
    expect(m.rawCloudEgressEnabled).toBe(false);
    expect(() => ProviderMatrixSchema.parse(m)).not.toThrow();
  });
});

describe("buildProviderMatrix — only a PASSING candidate is admitted", () => {
  it("a passing provider-branch candidate lands in both allowedProviders and capabilityDefaults", async () => {
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.allowedProviders).toEqual(["claude"]);
    expect(m.capabilityDefaults[CAP_CLOSE]).toEqual(cloudClaudeRoute);
  });

  it.each(["failing", "disabled", "unknown"] as const)(
    "a %s candidate is EXCLUDED — never routed, never allow-listed",
    async (status) => {
      const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
      const m = await buildProviderMatrix(WS, candidates, fakeCertifier(status));
      expect(m.allowedProviders).toEqual([]);
      expect(m.capabilityDefaults).toEqual({});
    },
  );

  it("a passing RUNTIME-branch candidate populates capabilityDefaults but NOT allowedProviders (providers-only allowlist)", async () => {
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: agentRuntimeRoute }];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults[CAP_CLOSE]).toEqual(agentRuntimeRoute);
  });

  it("a throwing certifier fails CLOSED for that candidate (never propagates, never admits)", async () => {
    const throwing: ProviderConformanceCertifier = async () => {
      throw new Error("network exploded");
    };
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, throwing);
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults).toEqual({});
  });
});

describe("buildProviderMatrix — correspondence check (L55/L119): the verdict must match the REQUESTED candidate", () => {
  it("a certifier returning a PASS for a DIFFERENT capability does not certify this candidate", async () => {
    const mismatched: ProviderConformanceCertifier = async (candidate) => ({
      subjectKind: "provider",
      subjectId: "provider" in candidate.route ? candidate.route.provider : "unused",
      capability: CAP_SYNTH, // wrong capability — candidate asked about CAP_CLOSE
      model: candidate.route.model,
      egressClass: candidate.route.egressClass,
      status: "passing",
      checkedAt: "2026-08-25T00:00:00.000Z",
    });
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, mismatched);
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults).toEqual({});
  });

  it("a certifier returning a PASS for a DIFFERENT provider id does not certify this candidate", async () => {
    const mismatched: ProviderConformanceCertifier = async (candidate) => ({
      subjectKind: "provider",
      subjectId: "openai", // wrong subject — candidate names "claude"
      capability: candidate.capability,
      model: candidate.route.model,
      egressClass: candidate.route.egressClass,
      status: "passing",
      checkedAt: "2026-08-25T00:00:00.000Z",
    });
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, mismatched);
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults).toEqual({});
  });

  it("a certifier returning a PASS with a mismatched egressClass does not certify this candidate", async () => {
    const mismatched: ProviderConformanceCertifier = async (candidate) => ({
      subjectKind: "provider",
      subjectId: "provider" in candidate.route ? candidate.route.provider : "unused",
      capability: candidate.capability,
      model: candidate.route.model,
      egressClass: "local", // wrong — the candidate route is "cloud"
      status: "passing",
      checkedAt: "2026-08-25T00:00:00.000Z",
    });
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, mismatched);
    expect(m.allowedProviders).toEqual([]);
    expect(m.capabilityDefaults).toEqual({});
  });
});

describe("buildProviderMatrix — per-capability FIRST-passing-wins, deterministic ordering", () => {
  it("two candidates for the SAME capability: the first PASSING one wins, the second is ignored", async () => {
    const secondRoute: ProviderRoute = { ...localOllamaRoute };
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_CLOSE, route: secondRoute },
    ];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.capabilityDefaults[CAP_CLOSE]).toEqual(cloudClaudeRoute);
    // both providers still passed certification, so both are allow-listed —
    // only the CAPABILITY DEFAULT is first-wins, not the allowlist membership.
    expect(m.allowedProviders.sort()).toEqual(["claude", "ollama"]);
  });

  it("a failing first candidate lets the second (passing) candidate win the capability", async () => {
    const certify: ProviderConformanceCertifier = async (candidate) => ({
      subjectKind: "provider",
      subjectId: "provider" in candidate.route ? candidate.route.provider : "unused",
      capability: candidate.capability,
      model: candidate.route.model,
      egressClass: candidate.route.egressClass,
      // only "ollama" passes
      status: "provider" in candidate.route && candidate.route.provider === "ollama" ? "passing" : "failing",
      checkedAt: "2026-08-25T00:00:00.000Z",
    });
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_CLOSE, route: localOllamaRoute },
    ];
    const m = await buildProviderMatrix(WS, candidates, certify);
    expect(m.capabilityDefaults[CAP_CLOSE]).toEqual(localOllamaRoute);
    expect(m.allowedProviders).toEqual(["ollama"]);
  });

  it("independent capabilities each resolve their own candidate, never cross-contaminating", async () => {
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_SYNTH, route: localOllamaRoute },
    ];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.capabilityDefaults[CAP_CLOSE]).toEqual(cloudClaudeRoute);
    expect(m.capabilityDefaults[CAP_SYNTH]).toEqual(localOllamaRoute);
  });

  it("the same provider passing for two capabilities appears exactly once in allowedProviders", async () => {
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_SYNTH, route: cloudClaudeRoute },
    ];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.allowedProviders).toEqual(["claude"]);
  });
});

describe("buildProviderMatrix — rawCloudEgressEnabled NEVER defaults permissive (⛔ NOTHING ARMS)", () => {
  it("defaults to false even when every admitted route is cloud-egress-classed", async () => {
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(m.rawCloudEgressEnabled).toBe(false);
  });

  it("an explicit caller-supplied true is threaded through unchanged (the producer never invents consent)", async () => {
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"), {
      rawCloudEgressEnabled: true,
    });
    expect(m.rawCloudEgressEnabled).toBe(true);
  });

  it("an explicit caller-supplied false stays false", async () => {
    const m = await buildProviderMatrix(WS, [], fakeCertifier("passing"), { rawCloudEgressEnabled: false });
    expect(m.rawCloudEgressEnabled).toBe(false);
  });
});

describe("buildProviderMatrix — localProviderPreference is optional and additive", () => {
  it("omits the key entirely when not supplied (no undefined-valued key)", async () => {
    const m = await buildProviderMatrix(WS, [], fakeCertifier("passing"));
    expect(Object.hasOwn(m, "localProviderPreference")).toBe(false);
  });

  it("threads a caller-supplied preference through unchanged", async () => {
    const pref: ProviderId = "ollama";
    const m = await buildProviderMatrix(WS, [], fakeCertifier("passing"), {
      localProviderPreference: pref,
    });
    expect(m.localProviderPreference).toBe("ollama");
  });
});

describe("buildProviderMatrix — output is ALWAYS schema-valid (Appendix A invariant)", () => {
  it("every produced matrix satisfies ProviderMatrixSchema, incl. the provider⊆allowedProviders refine", async () => {
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_SYNTH, route: localOllamaRoute },
    ];
    const m = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(() => ProviderMatrixSchema.parse(m)).not.toThrow();
  });
});

describe("buildProviderMatrix — deterministic + does not mutate its inputs", () => {
  it("the same (candidates, certifier) produces an equal matrix on repeat calls", async () => {
    const candidates: ProviderMatrixCandidate[] = [{ capability: CAP_CLOSE, route: cloudClaudeRoute }];
    const a = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    const b = await buildProviderMatrix(WS, candidates, fakeCertifier("passing"));
    expect(a).toEqual(b);
  });

  it("calls the injected certifier exactly once per candidate", async () => {
    const spy = vi.fn(fakeCertifier("passing"));
    const candidates: ProviderMatrixCandidate[] = [
      { capability: CAP_CLOSE, route: cloudClaudeRoute },
      { capability: CAP_SYNTH, route: localOllamaRoute },
    ];
    await buildProviderMatrix(WS, candidates, spy);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
