// §9.6 Phase-C C5.4b — the provenance-stamping retrieval DECORATOR (deterministic surface).
//
// The LAST contentTrust go-live gate: a RetrievedSource is stamped provenance="knowledge_writer" ONLY
// when a CopilotServingOracle (the admitForServing seam) ADMITS its citationId under an explicit GATED
// verdict — never a blanket stamp (which would re-open the ING-7 bypass the C4 job-admission backstop
// cannot catch). Degraded coverage / any error / a foreign-id anomaly ⇒ ZERO stamps ⇒ untrusted. The
// decorator is PURE (join = mode + set membership) and TDD'd here against fakes; the real admitForServing-
// backed oracle is a SEPARATE future sub-slice. The interim oracle always degrades, so on every live ask
// TODAY nothing is stamped ⇒ propose stays structurally OFF (the C5.4a honest-interim pattern).
//
// These tests fold the 4 adversarial-verifier corrections that ship in THIS slice:
//   • always-OVERWRITE provenance from the verdict (forbid a future inner adapter self-stamping) — C1.3/C4.4
//   • subset-or-FAIL-CLOSED: a foreign admitted id (oracle saw a different context — TOCTOU) strips all — C3.4
//   • mode-gated discriminated-union read (a stray admittedCitationIds on a non-gated verdict stamps nothing) — C3.5
//   • whole-body no-throw + malformed-sources fail-closed err — C4.1/C4.2
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import {
  createProvenanceStampingRetrieval,
  createInterimDegradedServingOracle,
  createServingGateOracle,
} from "../../../src/api/procedures/copilotProvenanceStamp";
import type {
  CopilotServingOracle,
  CopilotServingVerdict,
  AdmitForServingFn,
  ServingContextLoader,
  WorkspaceServingContext,
} from "../../../src/api/procedures/copilotProvenanceStamp";
import type {
  ServingResult,
  ServingError,
  CanonicalFactSet,
  QuarantineLedger,
  RehydrateFn,
} from "@sow/knowledge";
import type { RevisionId } from "@sow/contracts";
import type {
  CopilotRetrievalPort,
  RetrievedContext,
  RetrievedSource,
  SourceProvenance,
} from "../../../src/api/procedures/copilot";
import { deriveCopilotContentTrust } from "../../../src/api/procedures/copilotAgentSynthesis";

const WS = "ws-pb";

const src = (citationId: string, provenance?: SourceProvenance): RetrievedSource =>
  provenance === undefined ? { citationId, title: "T" } : { citationId, title: "T", provenance };

const ctx = (
  workspaceId: string,
  sources: readonly RetrievedSource[],
  blocks: readonly string[] = ["blk"],
): RetrievedContext => ({ workspaceId, blocks, sources });

/** A fixed inner retrieval port returning a canned Result; records call count. */
function fixedInner(result: Result<RetrievedContext, FailureVariant>): {
  readonly port: CopilotRetrievalPort;
  calls(): number;
} {
  let n = 0;
  return {
    port: {
      retrieve: (): Result<RetrievedContext, FailureVariant> => {
        n += 1;
        return result;
      },
    },
    calls: () => n,
  };
}

/** A serving oracle returning a fixed verdict; records whether admit() was consulted. */
function spyOracle(verdict: Result<CopilotServingVerdict, FailureVariant>): {
  readonly oracle: CopilotServingOracle;
  calls(): number;
} {
  let n = 0;
  return {
    oracle: {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> => {
        n += 1;
        return Promise.resolve(verdict);
      },
    },
    calls: () => n,
  };
}

const gated = (ids: readonly string[]): Result<CopilotServingVerdict, FailureVariant> =>
  ok({ mode: "gated", admittedCitationIds: new Set(ids) });
const degraded: Result<CopilotServingVerdict, FailureVariant> = ok({
  mode: "degraded_direct_markdown",
});
const oracleErr: Result<CopilotServingVerdict, FailureVariant> = err(
  failure("degraded_unavailable", "oracle down", { cause: { code: "SERVING_ORACLE_FAULT" } }),
);

function sourceById(context: RetrievedContext, id: string): RetrievedSource | undefined {
  return context.sources.find((s) => s.citationId === id);
}

describe("createProvenanceStampingRetrieval — gated admission ⇒ knowledge_writer", () => {
  it("all-admitted ⇒ every source knowledge_writer ⇒ trusted; blocks + workspaceId preserved", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")], ["blkA", "blkB"])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(gated(["gbrain:a", "gbrain:b"])).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources.every((s) => s.provenance === "knowledge_writer")).toBe(true);
      expect(r.value.blocks).toEqual(["blkA", "blkB"]);
      expect(r.value.workspaceId).toBe(WS);
      expect(deriveCopilotContentTrust(r.value)).toBe("trusted");
    }
  });

  it("PARTIAL admission ⇒ unadmitted source keeps provenance ABSENT (not omitted) ⇒ untrusted", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(gated(["gbrain:a"])).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(sourceById(r.value, "gbrain:a")?.provenance).toBe("knowledge_writer");
      expect(sourceById(r.value, "gbrain:b")?.provenance).toBeUndefined();
      expect(r.value.sources).toHaveLength(2); // b is PRESENT, just untrusted — never dropped
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });
});

describe("createProvenanceStampingRetrieval — fail-closed to untrusted", () => {
  it("DEGRADED coverage ⇒ zero stamps, sources + blocks preserved ⇒ untrusted", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")], ["blkA", "blkB"])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(degraded).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources.every((s) => s.provenance === undefined)).toBe(true);
      expect(r.value.sources).toHaveLength(2);
      expect(r.value.blocks).toEqual(["blkA", "blkB"]);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("EMPTY retrieval ⇒ untrusted (empty-guard beats the vacuous-truth trap)", async () => {
    const inner = fixedInner(ok(ctx(WS, [], [])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(gated([])).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources).toEqual([]);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("FOREIGN admitted id (⊄ retrieved — a TOCTOU anomaly) ⇒ strip ALL ⇒ untrusted (C3.4)", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")])));
    // oracle admits a real id AND a phantom one it must have seen in a DIFFERENT context.
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(gated(["gbrain:a", "gbrain:zzz"])).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // even gbrain:a loses its stamp — the whole verdict is distrusted on the anomaly.
      expect(r.value.sources.every((s) => s.provenance === undefined)).toBe(true);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("ORACLE err ⇒ unstamped passthrough (read-only Q&A survives, propose off), never throws", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spyOracle(oracleErr).oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources.every((s) => s.provenance === undefined)).toBe(true);
      expect(r.value.sources).toHaveLength(2);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("INNER err ⇒ propagates unchanged; oracle is NEVER consulted", async () => {
    const inner = fixedInner(err(failure("degraded_unavailable", "boom", { cause: { code: "INNER_X" } })));
    const spy = spyOracle(gated(["gbrain:a"]));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spy.oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("INNER_X");
    expect(spy.calls()).toBe(0);
  });
});

describe("createProvenanceStampingRetrieval — WS-8 scope", () => {
  it("inner returns FOREIGN-workspace context ⇒ err RETRIEVAL_SCOPE_MISMATCH BEFORE the oracle", async () => {
    const inner = fixedInner(ok(ctx("ws-OTHER", [src("gbrain:a")])));
    const spy = spyOracle(gated(["gbrain:a"]));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: spy.oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
    expect(spy.calls()).toBe(0); // oracle never sees cross-workspace context
  });
});

describe("createProvenanceStampingRetrieval — always OVERWRITE provenance from the verdict (C1.3/C4.4)", () => {
  it("a source the inner PRE-STAMPED knowledge_writer is stripped on degraded / oracle-err / not-admitted", async () => {
    const prestamped = fixedInner(ok(ctx(WS, [src("gbrain:a", "knowledge_writer")])));
    for (const oracle of [spyOracle(degraded).oracle, spyOracle(oracleErr).oracle, spyOracle(gated([])).oracle]) {
      const deco = createProvenanceStampingRetrieval({ inner: prestamped.port, oracle });
      const r = await deco.retrieve(WS, "q");
      expect(isOk(r)).toBe(true);
      if (isOk(r)) {
        expect(sourceById(r.value, "gbrain:a")?.provenance).toBeUndefined();
        expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
      }
    }
  });
});

describe("createProvenanceStampingRetrieval — malformed-verdict + malformed-context defenses", () => {
  it("a NON-gated verdict carrying a STRAY admittedCitationIds still stamps nothing (C3.5)", async () => {
    const sneaky: CopilotServingOracle = {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> =>
        Promise.resolve(
          ok({ mode: "degraded_direct_markdown", admittedCitationIds: new Set(["gbrain:a"]) } as unknown as CopilotServingVerdict),
        ),
    };
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: sneaky });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(sourceById(r.value, "gbrain:a")?.provenance).toBeUndefined();
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("a gated verdict whose admittedCitationIds is NOT a Set ⇒ strip all (fail closed)", async () => {
    const broken: CopilotServingOracle = {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> =>
        Promise.resolve(ok({ mode: "gated", admittedCitationIds: ["gbrain:a"] } as unknown as CopilotServingVerdict)),
    };
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: broken });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(sourceById(r.value, "gbrain:a")?.provenance).toBeUndefined();
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("a structurally-malformed verdict (missing `mode`) degrades to unstamped ⇒ untrusted", async () => {
    const noMode: CopilotServingOracle = {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> =>
        Promise.resolve(ok({ admittedCitationIds: new Set(["gbrain:a"]) } as unknown as CopilotServingVerdict)),
    };
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const r = await createProvenanceStampingRetrieval({ inner: inner.port, oracle: noMode }).retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(sourceById(r.value, "gbrain:a")?.provenance).toBeUndefined();
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });

  it("MALFORMED sources (non-array, or a null element) ⇒ typed err, never throws (C4.1/C4.2)", async () => {
    const spy1 = spyOracle(gated(["gbrain:a"]));
    const nonArray = createProvenanceStampingRetrieval({
      inner: fixedInner(ok({ workspaceId: WS, blocks: [], sources: null } as unknown as RetrievedContext)).port,
      oracle: spy1.oracle,
    });
    const r1 = await nonArray.retrieve(WS, "q");
    expect(isErr(r1)).toBe(true);
    if (isErr(r1)) expect(r1.error.cause?.code).toBe("RETRIEVAL_CONTEXT_MALFORMED");
    expect(spy1.calls()).toBe(0); // never reaches the oracle

    const spy2 = spyOracle(gated(["gbrain:a"]));
    const nullElem = createProvenanceStampingRetrieval({
      inner: fixedInner(ok({ workspaceId: WS, blocks: [], sources: [null] } as unknown as RetrievedContext)).port,
      oracle: spy2.oracle,
    });
    const r2 = await nullElem.retrieve(WS, "q");
    expect(isErr(r2)).toBe(true);
    if (isErr(r2)) expect(r2.error.cause?.code).toBe("RETRIEVAL_CONTEXT_MALFORMED");
    expect(spy2.calls()).toBe(0);
  });

  it("§16 no-throw: a THROWING / REJECTING oracle and a THROWING inner each yield a typed err", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const throwing: CopilotServingOracle = {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> => {
        throw new Error("sync boom");
      },
    };
    const r1 = await createProvenanceStampingRetrieval({ inner: inner.port, oracle: throwing }).retrieve(WS, "q");
    expect(isErr(r1)).toBe(true);

    const rejecting: CopilotServingOracle = {
      admit: (): Promise<Result<CopilotServingVerdict, FailureVariant>> => Promise.reject(new Error("async boom")),
    };
    const r2 = await createProvenanceStampingRetrieval({ inner: inner.port, oracle: rejecting }).retrieve(WS, "q");
    expect(isErr(r2)).toBe(true);

    const throwingInner: CopilotRetrievalPort = {
      retrieve: (): Result<RetrievedContext, FailureVariant> => {
        throw new Error("inner boom");
      },
    };
    const r3 = await createProvenanceStampingRetrieval({ inner: throwingInner, oracle: spyOracle(gated([])).oracle }).retrieve(WS, "q");
    expect(isErr(r3)).toBe(true);
  });
});

describe("createInterimDegradedServingOracle — the structurally-OFF input", () => {
  it("resolves degraded_direct_markdown for ANY workspace/context (no admitted set)", async () => {
    const oracle = createInterimDegradedServingOracle();
    const v1 = await oracle.admit("ws-1", ctx("ws-1", [src("gbrain:a")]));
    const v2 = await oracle.admit("ws-2", ctx("ws-2", []));
    expect(isOk(v1)).toBe(true);
    expect(isOk(v2)).toBe(true);
    if (isOk(v1)) expect(v1.value.mode).toBe("degraded_direct_markdown");
    if (isOk(v2)) expect(v2.value.mode).toBe("degraded_direct_markdown");
  });

  it("wired through the decorator, EVERY live ask is untrusted (propose stays OFF today)", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a"), src("gbrain:b")])));
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle: createInterimDegradedServingOracle() });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources.every((s) => s.provenance === undefined)).toBe(true);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });
});

// ── gate 4 — the REAL admitForServing-backed oracle CORE (over fake seams) ──────

const REV = "rev-1" as RevisionId;
const OK_COVERAGE = { cleanForServing: true, coverageComplete: true, pinValid: true, oracleBuildOk: true };

/** A fake serving gate: admits exactly the pointer factIdentities in `admit`, in the given `mode`. */
function fakeGate(opts: {
  admit?: readonly string[];
  mode?: "gated" | "degraded_direct_markdown";
  error?: ServingError;
  throws?: boolean;
}): { fn: AdmitForServingFn; reqs: { factIds: string[]; workspaceId: string }[] } {
  const reqs: { factIds: string[]; workspaceId: string }[] = [];
  const fn: AdmitForServingFn = (req) => {
    reqs.push({ factIds: req.pointers.map((p) => p.factIdentity), workspaceId: String(req.workspaceId) });
    if (opts.throws === true) throw new Error("gate blew up");
    if (opts.error !== undefined) return Promise.resolve(err(opts.error));
    const admitSet = new Set(opts.admit ?? []);
    const result: ServingResult = {
      mode: opts.mode ?? "gated",
      admitted: req.pointers
        .filter((p) => admitSet.has(p.factIdentity))
        .map((p) => ({ factIdentity: p.factIdentity, content: "c", mdContentSha: "sha" as never, score: p.score })),
      withheld: [],
    };
    return Promise.resolve(ok(result));
  };
  return { fn, reqs };
}

/** A ready serving context whose resolver is a plain map (citationId → factIds); other legs are stubs. */
function readyContext(resolver: Record<string, readonly string[]>): WorkspaceServingContext {
  return {
    revisionId: REV,
    allowSet: { workspaceId: WS, revisionId: REV, facts: [] } as unknown as CanonicalFactSet,
    rehydrate: (() => err({ code: "rehydrate_failed", factIdentity: "x", reason: "stub" })) as RehydrateFn,
    quarantine: { isQuarantined: () => false } as unknown as QuarantineLedger,
    coverage: OK_COVERAGE,
    servingDeps: { secrets: {} as never, signingKeyRef: "ref" as never },
    resolveCitation: (cid) => resolver[cid] ?? null,
  };
}

const readyLoader =
  (resolver: Record<string, readonly string[]>): ServingContextLoader =>
  () =>
    Promise.resolve(ok({ mode: "ready", context: readyContext(resolver) }));

const verdictOf = (r: Result<CopilotServingVerdict, FailureVariant>): CopilotServingVerdict => {
  if (!isOk(r)) throw new Error("expected an ok verdict");
  return r.value;
};
const admittedSet = (v: CopilotServingVerdict): ReadonlySet<string> =>
  v.mode === "gated" ? v.admittedCitationIds : new Set();

describe("createServingGateOracle — precondition 2/3 (resolve + all-or-nothing per page)", () => {
  it("admits a citationId when EVERY factIdentity reachable via it is admitted by the gate", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a", "tag:a"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a", "tag:a"] }),
    });
    const v = verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")])));
    expect(v.mode).toBe("gated");
    expect([...admittedSet(v)]).toEqual(["gbrain:a"]);
  });

  it("WITHHOLDS a page whose facts are only PARTIALLY admitted (all-or-nothing)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a"] }).fn, // tag:a NOT admitted
      loadContext: readyLoader({ "gbrain:a": ["page:a", "tag:a"] }),
    });
    const v = verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")])));
    expect([...admittedSet(v)]).toEqual([]); // partial page ⇒ unstamped
  });

  it("EXCLUDES a citationId the resolver cannot uniquely resolve (null) or that resolves to nothing (empty)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a", "page:b"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"], "gbrain:empty": [] }), // gbrain:unknown → null
    });
    const v = verdictOf(
      await oracle.admit(WS, ctx(WS, [src("gbrain:a"), src("gbrain:unknown"), src("gbrain:empty")])),
    );
    expect([...admittedSet(v)]).toEqual(["gbrain:a"]);
  });

  it("a resolver repeating a factId WITHIN one citation does NOT self-CONFLICT (page still admits)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a", "page:a"] }), // intra-citation duplicate
    });
    const v = verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")])));
    expect([...admittedSet(v)]).toEqual(["gbrain:a"]);
  });

  it("EXCLUDES BOTH citationIds when they claim the SAME factIdentity (injectivity violated for the context)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:shared", "page:a", "page:b"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a", "page:shared"], "gbrain:b": ["page:b", "page:shared"] }),
    });
    const v = verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a"), src("gbrain:b")])));
    expect([...admittedSet(v)]).toEqual([]); // both dropped — neither may be stamped
  });
});

describe("createServingGateOracle — precondition 5 (citation uniqueness)", () => {
  it("EXCLUDES a citationId that appears more than once in the context, even if resolvable + admitted", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a", "page:b"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"], "gbrain:b": ["page:b"] }),
    });
    // gbrain:a is duplicated (two chunks of one note) ⇒ dropped; gbrain:b unique ⇒ admitted.
    const v = verdictOf(
      await oracle.admit(WS, ctx(WS, [src("gbrain:a"), src("gbrain:a"), src("gbrain:b")])),
    );
    expect([...admittedSet(v)]).toEqual(["gbrain:b"]);
  });
});

describe("createServingGateOracle — precondition 4 (serving-error mapping) + degraded + §16", () => {
  it("maps a hard ServingError (workspace_mismatch) to a typed err — NEVER an ok verdict", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ error: { code: "workspace_mismatch", request: WS, allowSet: "other" } }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"] }),
    });
    const r = await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SERVING_WORKSPACE_MISMATCH");
  });

  it("passes the REQUESTED workspaceId to the gate (so its allow-set/workspace cross-check can fire)", async () => {
    const gate = fakeGate({ admit: ["page:a"] });
    const oracle = createServingGateOracle({ admitForServing: gate.fn, loadContext: readyLoader({ "gbrain:a": ["page:a"] }) });
    await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(gate.reqs[0]?.workspaceId).toBe(WS);
    expect(gate.reqs[0]?.factIds).toEqual(["page:a"]);
  });

  it("a gate returning degraded_direct_markdown ⇒ oracle degraded verdict", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ mode: "degraded_direct_markdown" }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"] }),
    });
    expect(verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")]))).mode).toBe("degraded_direct_markdown");
  });

  it("loadContext returning `degraded` ⇒ degraded verdict WITHOUT consulting the gate", async () => {
    const gate = fakeGate({ admit: ["page:a"] });
    const oracle = createServingGateOracle({
      admitForServing: gate.fn,
      loadContext: () => Promise.resolve(ok({ mode: "degraded" })),
    });
    expect(verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")]))).mode).toBe("degraded_direct_markdown");
    expect(gate.reqs).toHaveLength(0); // gate never called
  });

  it("loadContext err propagates as the oracle's err (decorator strips ⇒ untrusted)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: [] }).fn,
      loadContext: () => Promise.resolve(err(failure("degraded_unavailable", "no ctx", { cause: { code: "NO_CONTEXT" } }))),
    });
    const r = await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("NO_CONTEXT");
  });

  it("maps revision_mismatch to SERVING_REVISION_MISMATCH (the other hard ServingError)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ error: { code: "revision_mismatch", request: "rev-1", allowSet: "rev-2" } }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"] }),
    });
    const r = await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SERVING_REVISION_MISMATCH");
  });

  it("a THROWING gate never escapes §16 — folds to a typed SERVING_ORACLE_FAULT err", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ throws: true }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a"] }),
    });
    const r = await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SERVING_ORACLE_FAULT");
  });

  it("a THROWING loadContext also folds to SERVING_ORACLE_FAULT (never escapes §16)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a"] }).fn,
      loadContext: () => Promise.reject(new Error("loader blew up")),
    });
    const r = await oracle.admit(WS, ctx(WS, [src("gbrain:a")]));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SERVING_ORACLE_FAULT");
  });

  it("no resolvable sources ⇒ a gated verdict admitting nothing (never a vacuous stamp)", async () => {
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a"] }).fn,
      loadContext: readyLoader({}), // resolver returns null for everything
    });
    const v = verdictOf(await oracle.admit(WS, ctx(WS, [src("gbrain:a")])));
    expect(v.mode).toBe("gated");
    expect([...admittedSet(v)]).toEqual([]);
  });
});

describe("createServingGateOracle — wired through the decorator (end-to-end trust)", () => {
  it("a fully-admitted page ⇒ knowledge_writer stamp ⇒ deriveCopilotContentTrust = trusted", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a", "tag:a"] }).fn,
      loadContext: readyLoader({ "gbrain:a": ["page:a", "tag:a"] }),
    });
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources[0]?.provenance).toBe("knowledge_writer");
      expect(deriveCopilotContentTrust(r.value)).toBe("trusted");
    }
  });

  it("a partially-admitted page ⇒ NO stamp ⇒ untrusted (propose stays OFF)", async () => {
    const inner = fixedInner(ok(ctx(WS, [src("gbrain:a")])));
    const oracle = createServingGateOracle({
      admitForServing: fakeGate({ admit: ["page:a"] }).fn, // tag:a withheld
      loadContext: readyLoader({ "gbrain:a": ["page:a", "tag:a"] }),
    });
    const deco = createProvenanceStampingRetrieval({ inner: inner.port, oracle });
    const r = await deco.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources[0]?.provenance).toBeUndefined();
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });
});
