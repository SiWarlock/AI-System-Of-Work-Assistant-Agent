// Task 13.13 (aggregator leg) — the free, KEY-LESS source aggregator (Wikipedia /
// HackerNews / arXiv / Reddit / Semantic-Scholar / DuckDuckGo), DORMANT over an
// injected FAKED transport. The load-bearing pin: the query text is employer-
// content-bearing, so the aggregator SELF-runs the REAL @sow/policy egress veto
// FIRST — an employer-work ack-OFF call FAILS CLOSED (no fetch); KEY-LESS is NOT a
// bypass. The synthetic cloud route MUST classify as egress (else the veto would
// fall-through fail-OPEN). TOTAL never-throws; dormant (no real endpoint).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { AgentJob, EgressPolicy, WorkspaceType, DataOwner } from "@sow/contracts";
import { validAgentJob, processorId } from "@sow/contracts";
import { processorOfRoute } from "@sow/policy";
import {
  createFreeSourceAggregator,
  FREE_SOURCE_EGRESS_ROUTE,
  FREE_SOURCES,
  type FreeSourceTransport,
  type FreeSourceFetchRequest,
} from "../src/connectors/adapters/free-source-aggregator";

// ── faked transport (dormant — real HTTP binds at §ARM-RESEARCH) ─────────────
function fakeTransport(opts: { body?: string; throwErr?: unknown } = {}) {
  const calls: FreeSourceFetchRequest[] = [];
  const transport: FreeSourceTransport = {
    async send(req: FreeSourceFetchRequest) {
      calls.push(req);
      if (opts.throwErr !== undefined) throw opts.throwErr;
      return { status: 200, body: opts.body ?? JSON.stringify({ items: [{ title: "R", url: "https://src/1" }] }) };
    },
  };
  return { transport, calls };
}

const EMPLOYER: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const PERSONAL: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };
const RESEARCH_PROC = processorId("free-source-web-research");

function egressPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProcessors: [RESEARCH_PROC],
    rawContentAllowedProcessors: [RESEARCH_PROC],
    employerRawEgressAcknowledged: true,
    ...over,
  };
}
function jobWith(over: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, carriesRawContent: true, trustLevel: "trusted", ...over };
}

describe("free-source aggregator — gates IDENTICALLY (rule 5; key-less ≠ bypass)", () => {
  it("employer-work raw + ack OFF ⇒ egress_denied and NO source is fetched", async () => {
    const { transport, calls } = fakeTransport();
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("confidential employer question", {
      job: jobWith(),
      egress: egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      workspace: EMPLOYER,
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("egress_denied");
    expect(calls.length).toBe(0); // the veto ran BEFORE any transport — key-less did not bypass
  });

  it("the synthetic egress route classifies as EGRESS (processorOfRoute !== null) — no fail-open", () => {
    // If the synthetic route were non-egress (proc === null), the employer-raw veto
    // would fall through to ALLOW — a silent rule-5 fail-open. Pin it egress-classed.
    expect(processorOfRoute(FREE_SOURCE_EGRESS_ROUTE)).not.toBeNull();
    expect(FREE_SOURCE_EGRESS_ROUTE.egressClass).toBe("cloud");
  });

  it("personal workspace ⇒ ALLOW: fans out over every source, raw preserved VERBATIM", async () => {
    const body = JSON.stringify({ hits: [{ url: "https://a/1" }, { url: "https://b/2" }] });
    const { transport, calls } = fakeTransport({ body });
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("q", { job: jobWith(), egress: egressPolicy(), workspace: PERSONAL });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.results.length).toBe(FREE_SOURCES.length);
      expect(res.value.results.every((r) => r.ok)).toBe(true);
      expect(res.value.results[0]?.raw).toEqual({ hits: [{ url: "https://a/1" }, { url: "https://b/2" }] });
    }
    expect(calls.length).toBe(FREE_SOURCES.length);
  });

  it("employer workspace + ack ON ⇒ ALLOW (ack re-opens the allowlist — positive control)", async () => {
    const { transport, calls } = fakeTransport();
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("q", { job: jobWith(), egress: egressPolicy({ employerRawEgressAcknowledged: true }), workspace: EMPLOYER });
    expect(isOk(res)).toBe(true);
    expect(calls.length).toBe(FREE_SOURCES.length);
  });
});

describe("free-source aggregator — --academic scholarly-only + TOTAL never-throws + dormant", () => {
  it("--academic restricts to the scholarly sources only", async () => {
    const { transport, calls } = fakeTransport();
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("q", { job: jobWith(), egress: egressPolicy(), workspace: PERSONAL, academic: true });
    const scholarly = FREE_SOURCES.filter((s) => s.academic).map((s) => s.id);
    expect(scholarly.length).toBeGreaterThan(0);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.results.map((r) => r.source).sort()).toEqual([...scholarly].sort());
    expect(calls.every((c) => scholarly.includes(c.source))).toBe(true);
    expect(calls.length).toBe(scholarly.length);
  });

  it("a throwing transport is captured per-source; the aggregation never throws", async () => {
    const { transport } = fakeTransport({ throwErr: new Error("network down") });
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("q", { job: jobWith(), egress: egressPolicy(), workspace: PERSONAL });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.results.every((r) => r.ok === false)).toBe(true);
  });

  it("a malformed (non-JSON) body preserves the raw string verbatim (never throws)", async () => {
    const { transport } = fakeTransport({ body: "<<not json>>" });
    const agg = createFreeSourceAggregator({ transport });
    const res = await agg.research("q", { job: jobWith(), egress: egressPolicy(), workspace: PERSONAL });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.results[0]?.raw).toBe("<<not json>>");
  });

  it("dormant + key-less — the module constructs NO real HTTP client and handles NO secret", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/connectors/adapters/free-source-aggregator.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["node:https", "node:http", "undici", "axios", "fetch(", "Authorization", "Bearer", "getSecret", "secretRef"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
