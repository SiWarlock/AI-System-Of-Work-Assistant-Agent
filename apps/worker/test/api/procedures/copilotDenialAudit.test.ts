// Task 24.7 (arming-block release condition (d)) — the interactive Copilot path's two live policy
// denials (§5 egress veto, ING-7 admission) already build a redaction-safe `AuditSignal` and every
// caller discarded it. This slice wires `toAuditRecordInput` → `AuditRepository.append` into both
// deny branches. Per the owner's anti-discharge clause: every test here MOVES THE STATE — it triggers
// a REAL denial through the REAL call chain (`runGovernedCopilotSynthesis` / the agentic
// `CopilotSynthesisPort.synthesize`) and then QUERIES the repository for the record. A
// construction-side-only assertion (e.g. "buildAuditSignal was called") does not discharge this task
// even if green — see IMPLEMENTATION_PLAN.md task 24.7 / brief 252.
import { describe, it, expect, vi } from "vitest";
import { ok, isOk, isErr, processorId } from "@sow/contracts";
import type { AgentJob, AuditRecord, DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import type { AuditRepository, AuditQuery, DbResult, DbError } from "@sow/db";
import {
  createLocalWorkspacePosture,
  createLocalRouteSelector,
  createStubSynthesis,
  runGovernedCopilotSynthesis,
  type GovernedCopilotSynthesisDeps,
  type WorkspacePosture,
  type CopilotSynthesisPort,
  type RetrievedContext,
} from "../../../src/api/procedures/copilot";
import {
  createAgentRuntimeCopilotSynthesis,
  admitCopilotAgentJobWithAudit,
  buildCopilotAgentJob,
  type CopilotAgentRunner,
} from "../../../src/api/procedures/copilotAgentSynthesis";
import { copilotAgentToolPolicy, buildAuditSignal } from "@sow/policy";
import { createAuditPersistPort } from "../../../src/boot";

const NOW = "2026-08-12T00:00:00.000Z";

/** A real-filtering in-memory AuditRepository — `.query` actually AND-combines actor/event/ref/workspaceId,
 *  unlike the existing `memAudit()` test helpers elsewhere (which all stub `.query` to return `[]`). Needed
 *  here because the sustained-probing acceptance criterion requires a genuine filtered read-back. */
function memAuditQueryable(fault = false): { repo: AuditRepository; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const repo: AuditRepository = {
    append: (rec: AuditRecord): DbResult<void> => {
      if (fault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "audit store down" } as DbError });
      records.push(rec);
      return Promise.resolve({ ok: true, value: undefined });
    },
    query: (filter: AuditQuery, limit: number): DbResult<AuditRecord[]> => {
      const matched = records.filter(
        (r) =>
          (filter.actor === undefined || r.actor === filter.actor) &&
          (filter.event === undefined || r.event === filter.event) &&
          (filter.ref === undefined || r.refs.includes(filter.ref)) &&
          (filter.workspaceId === undefined || r.workspaceId === filter.workspaceId),
      );
      return Promise.resolve({ ok: true, value: matched.slice(0, limit) });
    },
  };
  return { repo, records };
}

const WS = "ws-employer-audit";
const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};
const localRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};
// The agentic path's route guard (`toClaudeAgentRuntimeRoute`) fails closed on any non-Claude route
// BEFORE the ING-7 admission gate runs — the agentic tests below need a genuine Claude route so the
// denial under test is actually the admission gate's, not the earlier route guard's.
const claudeRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-sonnet-5",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};
const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const egressPolicyOff = (workspaceId: string): EgressPolicy => ({
  workspaceId: workspaceId as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
});
const employerPostureAckOff = (workspaceId: string): WorkspacePosture => ({
  type: employerWs.type,
  dataOwner: employerWs.dataOwner,
  egress: egressPolicyOff(workspaceId),
});
const ctx = (workspaceId: string): RetrievedContext => ({
  workspaceId,
  blocks: ["A decision was logged."],
  sources: [{ citationId: "src:note-1", title: "Decisions" }],
});

function synthesisDeps(over: Partial<GovernedCopilotSynthesisDeps> = {}, audit?: AuditRepository): {
  deps: GovernedCopilotSynthesisDeps;
  audit: { repo: AuditRepository; records: AuditRecord[] };
} {
  const mem = audit === undefined ? memAuditQueryable() : { repo: audit, records: [] as AuditRecord[] };
  const deps: GovernedCopilotSynthesisDeps = {
    synthesis: createStubSynthesis(),
    workspacePosture: createLocalWorkspacePosture({ [WS]: employerPostureAckOff(WS) }),
    routeSelector: createLocalRouteSelector(cloudRoute), // employer + cloud + ack OFF ⇒ egress-veto DENY
    auditPersist: createAuditPersistPort({ audit: mem.repo, now: () => NOW }),
    ...over,
  };
  return { deps, audit: mem };
}

describe("24.7 — the egress-veto denial on the interactive Copilot path persists a durable, queryable AuditRecord", () => {
  it("copilot_egress_veto_denial_persists_a_durable_audit_record", async () => {
    const { deps, audit } = synthesisDeps();
    const r = await runGovernedCopilotSynthesis(deps, WS, "what did we decide?", ctx(WS));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    // MOVE THE STATE: query the repository, don't just assert a mock was called.
    const queried = await audit.repo.query({ workspaceId: WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      expect(queried.value.length).toBe(1);
      expect(queried.value[0]?.event).toBe("egress.denied"); // @sow/policy egress.ts's deny() event name
      expect(queried.value[0]?.workspaceId).toBe(WS);
    }
  });

  it("persisted_record_is_redaction_safe — no raw prompt/content text in any field", async () => {
    const { deps, audit } = synthesisDeps();
    await runGovernedCopilotSynthesis(deps, WS, "a secret question mentioning password=hunter2", ctx(WS));
    const queried = await audit.repo.query({ workspaceId: WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      const rec = queried.value[0];
      expect(rec).toBeDefined();
      const scanned = JSON.stringify(rec);
      expect(scanned).not.toContain("password=hunter2");
      expect(scanned).not.toContain("a secret question");
    }
  });

  // security-reviewer catch: `createAuditPersistPort` must gate on `isRedactionSafe` before persisting
  // (`packages/policy/audit-signal.ts`'s own doc comment named this exact consumer in advance — 9.33's
  // house rule: a safety gate must DENY, not throw). No LIVE producer builds an unsafe signal today (both
  // egress-veto and ING-7 construct from fixed literals/refs/codes only), so this drives the gate directly
  // with a hand-built unsafe signal rather than through a real denial path — there is no live call chain
  // that produces one to trigger this "for real".
  it("createAuditPersistPort REFUSES to persist a signal that fails isRedactionSafe (9.33 — deny, don't throw, don't leak)", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const unsafeSignal = buildAuditSignal({
      actor: "test:unsafe-producer",
      event: "test.unsafe.signal",
      refs: [`ref:workspace:${WS}`],
      payloadHash: "marker",
      beforeSummary: "n/a",
      afterSummary: "leaked a secret: password=hunter2", // credential-shaped ⇒ isRedactionSafe() is false
    });
    await port.persistDenial(unsafeSignal, WS);
    const queried = await mem.repo.query({ workspaceId: WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0); // refused, not persisted
  });

  it("toAuditRecordInput_stamps_a_real_clock_value — occurredAt comes from the injected now(), not a hardcoded value", async () => {
    const FIXED = "2030-01-01T00:00:00.000Z";
    const mem = memAuditQueryable();
    const { deps } = synthesisDeps(
      { auditPersist: createAuditPersistPort({ audit: mem.repo, now: () => FIXED }) },
    );
    await runGovernedCopilotSynthesis(deps, WS, "q", ctx(WS));
    const queried = await mem.repo.query({ workspaceId: WS }, 10);
    if (isOk(queried)) expect(queried.value[0]?.timestamps.occurredAt).toBe(FIXED);
  });

  it("copilot_allowed_request_mints_zero_audit_records — the distinction is real in both directions (contracts L86)", async () => {
    const { deps, audit } = synthesisDeps({
      workspacePosture: createLocalWorkspacePosture({ [WS]: employerPostureAckOff(WS) }),
      routeSelector: createLocalRouteSelector(localRoute), // genuine loopback-local ⇒ ALLOWED, no denial
    });
    const r = await runGovernedCopilotSynthesis(deps, WS, "q", ctx(WS));
    expect(isOk(r)).toBe(true);
    const queried = await audit.repo.query({ workspaceId: WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0);
  });

  it("a persistence FAULT never changes the caller's denial — the guarantee never depends on the audit write succeeding", async () => {
    const faulted = memAuditQueryable(true);
    const { deps } = synthesisDeps({}, faulted.repo);
    const r = await runGovernedCopilotSynthesis(deps, WS, "q", ctx(WS));
    expect(isErr(r)).toBe(true); // the denial itself is unaffected by the audit-append fault
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("sustained_probing_is_queryable_and_distinguishable — N denials for one actor query back N records; a quiet workspace queries zero", async () => {
    const QUIET_WS = "ws-quiet";
    const mem = memAuditQueryable();
    const probed = synthesisDeps({ auditPersist: createAuditPersistPort({ audit: mem.repo, now: () => NOW }) }, mem.repo);
    for (let i = 0; i < 3; i += 1) {
      await runGovernedCopilotSynthesis(probed.deps, WS, `probe ${i}`, ctx(WS));
    }
    const probedQuery = await mem.repo.query({ workspaceId: WS }, 10);
    const quietQuery = await mem.repo.query({ workspaceId: QUIET_WS }, 10);
    expect(isOk(probedQuery)).toBe(true);
    expect(isOk(quietQuery)).toBe(true);
    if (isOk(probedQuery)) expect(probedQuery.value.length).toBe(3);
    if (isOk(quietQuery)) expect(quietQuery.value.length).toBe(0);
  });
});

// ── the agentic path's ING-7 admission denial (rule 6) ──────────────────────────────────────────
const agentPersonaWs = "ws-agent-untrusted";

describe("24.7 — the ING-7 admission denial on the agentic Copilot path persists a durable, queryable AuditRecord", () => {
  // ⚠ FINDING, recorded here rather than silently worked around: `synthesize`'s OWN job construction
  // (`buildCopilotAgentJob` via `resolveCopilotAgentCapability`) can NEVER produce a job that trips the
  // ING-7 `admitJob` deny — `resolveCopilotAgentCapability` returns `read_only` (non-mutating) for ANY
  // non-`"trusted"` content regardless of `proposeEnabled`/`knowledgeProposeEnabled` (copilotAgentSynthesis.ts
  // :261), so an untrusted job is ALWAYS built read_only. The `admitJob` check inside `synthesize` is
  // therefore a genuine defense-in-depth backstop — dormant-by-construction today, not reachable through any
  // legitimate `synthesize(...)` call (confirmed: the module's OWN existing unit test for this denial,
  // `copilotAgentSynthesis.test.ts` "REJECTS an UNTRUSTED job that declares a mutating tool policy", has to
  // hand-override `trustLevel`/`toolPolicy` on an already-built job — the same thing done below). This
  // exercises the REAL `admitCopilotAgentJobWithAudit` gate + the REAL persist port (the exact call
  // `synthesize` makes on its deny branch) against a job matching the denial shape, proving the wiring is
  // correct for the day `buildCopilotAgentJob`'s construction (or a future caller) can produce it — but the
  // branch inside `synthesize` itself is UNEXERCISED by any test that only drives it through its public
  // `(workspaceId, question, context, route)` parameters. Flagged at Step 9, not silently declared covered.
  it("copilot_ing7_admission_denial_persists_a_durable_audit_record (via the real gate + persist port; synthesize's own branch is unreachable-by-construction — see the finding above)", async () => {
    const mem = memAuditQueryable();
    const untrustedMutatingJob: AgentJob = {
      ...buildCopilotAgentJob(agentPersonaWs, claudeRoute),
      trustLevel: "untrusted",
      toolPolicy: copilotAgentToolPolicy(), // scoped_write + the propose tool — the ING-7 denial shape
    };
    const { result: admitted, audit } = admitCopilotAgentJobWithAudit(untrustedMutatingJob);
    expect(isErr(admitted)).toBe(true);
    if (isErr(admitted)) expect(admitted.error.cause?.code).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
    expect(audit).toBeDefined();
    if (audit === undefined) return;
    // The exact call `synthesize` makes on this branch (copilotAgentSynthesis.ts, the `!isOk(admitted)` arm).
    await createAuditPersistPort({ audit: mem.repo, now: () => NOW }).persistDenial(audit, agentPersonaWs);
    const queried = await mem.repo.query({ workspaceId: agentPersonaWs }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      expect(queried.value.length).toBe(1);
      expect(queried.value[0]?.event).toBe("job.admission.rejected");
    }
  });

  it("the agentic ALLOWED (untrusted, read_only) path mints zero audit records", async () => {
    const mem = memAuditQueryable();
    const okRunner: CopilotAgentRunner = {
      run: async () => ok({ status: "completed", candidateOutput: { answer: ["x"], citations: [] } } as never),
    };
    const synth: CopilotSynthesisPort = createAgentRuntimeCopilotSynthesis(okRunner, {
      proposeEnabled: false,
      resolveContentTrust: () => "untrusted", // untrusted + read_only (proposeEnabled off) ⇒ ING-7 admits
      auditPersist: createAuditPersistPort({ audit: mem.repo, now: () => NOW }),
    });
    await synth.synthesize(agentPersonaWs, "q", ctx(agentPersonaWs), claudeRoute);
    const queried = await mem.repo.query({ workspaceId: agentPersonaWs }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0);
  });
});

// ── task 24.62 — the port's TWO channels, and the two console.error lines that describe them ────────
//
// `createAuditPersistPort.persistDenial(signal, workspaceId)` takes TWO data channels and gates ONE:
// `isRedactionSafe` scans the `AuditSignal`; `workspaceId` rides beside it, never scanned. Both
// `console.error` lines asserted a redaction-safety property the line beneath them did not have, and
// NOTHING pinned either line's content — which is exactly how a comment and its code drift apart
// (`L82`). These tests pin the log-sink content itself, so the comments become checkable claims.
//
// ⚠ NO SEVERITY CLAIM. Neither line is a caller-injection channel: both `persistDenial` call sites are
// registry-validated (`copilot.ts:580-581` `workspacePosture.resolve`, fail-closed) with a read-back
// identity re-gate (`storeBackedWorkspacePosture.ts:39`, strict `String(ws.id) !== workspaceId`). The
// residual these tests close is narrower and real: registry-validated means the id EXISTS, not that it
// is WELL-SHAPED — a credential-shaped id in the workspace CONFIG still reaches a log sink (`24.55`'s
// trusted-provenance-vs-validated-shape rule, one layer down; `packages/policy`'s `visibility.ts`
// records the same residual for its own sibling site, in the RESIDUAL note on its `refs` construction
// — cited by symbol, not line, because that file is concurrently modified on another track).
//
// ⚠ SCOPE EXCEPTION TO THIS FILE'S OWN HEADER, stated so the header stays true. The `24.7` header
// above requires that "every test here MOVES THE STATE — it triggers a REAL denial through the REAL
// call chain". These three DRIVE THE PORT DIRECTLY, and that is deliberate, not a shortcut: the real
// chain's `event` values are three hardcoded literals, so no legitimate call chain can produce a
// gate-FAILING signal to trigger the refusal branch with. The existing `24.7` refusal test at the top
// of this file made the same choice for the same reason. ⇒ the anti-discharge clause is satisfied by
// the tests that CAN move the state; these pin a branch reachable only by construction.

/**
 * Capture `console.error` for the duration of one call; always restores.
 *
 * ⛔ NON-STRING ARGS ARE `JSON.stringify`d, NOT `String()`d, AND THAT IS LOAD-BEARING. `String({...})`
 * renders `"[object Object]"`, so a future `console.error(msg, { workspaceId })` — the most natural
 * "improve the diagnostics" edit anyone would make here — would put the value in the sink while every
 * `not.toContain` assertion below stayed GREEN. A rule-7 pin that cannot see structured args is a pin
 * that fails silently in the one direction it exists to catch.
 */
async function captureConsoleError(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const render = (a: unknown): string => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a));
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => void lines.push(args.map(render).join(" ")));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("24.62 — the audit-persist port's log sink carries only what its comments claim", () => {
  // spec(§16) — safety rule 7: redaction strips secrets + raw content before ANY log sink.
  // A refusal means at least one of the six fields `isRedactionSafe` scans is unsafe and the handler
  // CANNOT KNOW WHICH ⇒ no signal-derived value is safe to emit here, `event` included. This is the
  // doctrine `packages/knowledge`'s `GclAuditPersistPort.onRefused` (task 24.53, `e85953d3`) already
  // states in prose and discharges by SIGNATURE — `boot.ts` is the site that violates it.
  it("refused_signal_notice_carries_no_signal_derived_value — not event, not denialCode, not the ungated workspaceId", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    // Every field carries a distinct marker so an assertion failure names the leaking channel.
    const unsafe = buildAuditSignal({
      actor: "MARKERACTOR",
      event: "MARKEREVENT",
      refs: ["MARKERREF"],
      payloadHash: "MARKERHASH",
      beforeSummary: "MARKERBEFORE",
      // credential-shaped ⇒ isRedactionSafe() is false. Which field is unsafe is deliberately NOT the
      // one the notice names — that is the whole point.
      afterSummary: "MARKERAFTER password=MARKERSECRET",
      denialCode: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
    });
    const lines = await captureConsoleError(() => port.persistDenial(unsafe, "MARKERWORKSPACE"));

    // NON-VACUITY, two halves. (a) the refusal is still EMITTABLE — without this the "contains nothing"
    // assertions below pass trivially against a port that stopped logging altogether (24.53's
    // regression, inverted). (b) it is still the REFUSAL line specifically: `lines.length` alone is
    // satisfied by any single line, so a reordered branch or a rewritten message would slip through.
    expect(lines.length).toBe(1);
    const notice = lines.join("\n");
    expect(notice).toContain("REFUSED");
    for (const marker of [
      "MARKERACTOR",
      "MARKEREVENT",
      "MARKERREF",
      "MARKERHASH",
      "MARKERBEFORE",
      "MARKERAFTER",
      "MARKERSECRET",
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED", // denialCode: unscanned because closed BY TYPE, not validated
      "MARKERWORKSPACE", // the second, ungated channel
    ]) {
      expect(notice).not.toContain(marker);
    }
    // and it is still refused, not persisted (the gate's own behaviour is unchanged).
    // `isOk` asserted BEFORE narrowing — an assertion reachable only inside `if (isOk(...))` is
    // vacuously green whenever the call errs (`L15`); the sibling control below does it the same way.
    const queried = await mem.repo.query({ workspaceId: "MARKERWORKSPACE" }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) expect(queried.value.length).toBe(0);
  });

  // spec(§16, rule 7) — task 24.70: the refusal notice now NAMES which of the six scanned
  // fields tripped (a closed six-literal set, not content — `packages/policy`'s
  // `firstUnsafeAuditField`), without ever leaking that field's VALUE. This is the
  // field-NAME POSITIVE half; the test above pins the value-NEGATIVE half (unchanged by
  // 24.70 — the marker list there still asserts none of the six VALUES ever appear).
  it("refused_signal_notice_names_the_unsafe_field_by_name_only — the field NAME appears, the field's VALUE never does", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const SENTINEL = "MARKERAFTERVALUE-4471";
    const unsafe = buildAuditSignal({
      actor: "actor-ok",
      event: "event-ok",
      refs: ["ref-ok"],
      payloadHash: "hash-ok",
      beforeSummary: "before-ok",
      // credential-shaped ⇒ isRedactionSafe() is false, tripping on `afterSummary` — the
      // fifth scanned position, deliberately not `actor` (the trivial first-position case).
      afterSummary: `${SENTINEL} secret ${SENTINEL}TAIL`,
    });
    const lines = await captureConsoleError(() => port.persistDenial(unsafe, "ws-field-name-pin"));

    expect(lines.length).toBe(1);
    const notice = lines.join("\n");
    expect(notice).toContain("REFUSED");
    // POSITIVE: the field NAME appears.
    expect(notice).toContain("afterSummary");
    // NEGATIVE: the field's own VALUE never does, even though it's the one that tripped.
    expect(notice).not.toContain(SENTINEL);
  });

  // spec(§5) — the non-vacuity control for the test above AND for the append-failure test below.
  // Both of those assert ABSENCE; absence is satisfied by a port that does nothing at all. This pins
  // that the success path still produces its durable record, `workspaceId` included — the record's
  // whole purpose is workspace attribution, so the second channel is persisted RAW by design.
  it("persisted_signal_still_produces_its_record — the durable write still carries workspaceId (control)", async () => {
    const mem = memAuditQueryable();
    const port = createAuditPersistPort({ audit: mem.repo, now: () => NOW });
    const safe = buildAuditSignal({
      actor: "policy",
      event: "egress.denied",
      refs: [`ref:workspace:${WS}`],
      payloadHash: "sha256:abc123",
      beforeSummary: "route not vetoed",
      afterSummary: "egress denied",
    });
    const lines = await captureConsoleError(() => port.persistDenial(safe, WS));

    // The success path is SILENT — completing the matrix the other two tests half-cover:
    // refuse ⇒ 1 line · append-fault ⇒ 1 line · clean persist ⇒ 0. Without this, a stray diagnostic
    // added to the success branch is invisible to every test in this file.
    expect(lines).toEqual([]);
    const queried = await mem.repo.query({ workspaceId: WS }, 10);
    expect(isOk(queried)).toBe(true);
    if (isOk(queried)) {
      expect(queried.value.length).toBe(1);
      expect(queried.value[0]?.workspaceId).toBe(WS);
      expect(queried.value[0]?.event).toBe("egress.denied");
    }
  });

  // spec(§16) — `L82`: the pin IS the comment/code agreement. The adjacent comment claims "event/code
  // only"; the line also printed `workspaceId`. On THIS path the signal PASSED the gate, so `event` is
  // scanned-and-safe and may stay — the asymmetry with the refusal path above is the reusable part.
  it("append_failure_notice_matches_its_own_comment — event + store code, never the ungated workspaceId", async () => {
    const faulted = memAuditQueryable(true);
    const port = createAuditPersistPort({ audit: faulted.repo, now: () => NOW });
    const safe = buildAuditSignal({
      actor: "policy",
      event: "egress.denied",
      refs: ["ref:workspace:ws-append-fault"], // deliberately NOT the marker, so the assertion isolates channel 2
      payloadHash: "sha256:abc123",
      beforeSummary: "route not vetoed",
      afterSummary: "egress denied",
    });
    const lines = await captureConsoleError(() => port.persistDenial(safe, "MARKERAPPENDWORKSPACE"));

    expect(lines.length).toBe(1);
    const notice = lines.join("\n");
    // NON-VACUITY: the notice still carries exactly the two things its comment claims — asserted
    // WITH their interpolation slots, not as bare substrings. The slice's whole claim is about WHICH
    // VALUE OCCUPIES WHICH SLOT, and `toContain("egress.denied")` would also pass against prose that
    // merely mentions the words while emitting the value somewhere else entirely.
    expect(notice).toContain('event="egress.denied"');
    expect(notice).toContain('code="unavailable"'); // the DbError code from the faulted repo
    // …and NOT the third thing the comment never mentioned.
    expect(notice).not.toContain("MARKERAPPENDWORKSPACE");
  });
});
