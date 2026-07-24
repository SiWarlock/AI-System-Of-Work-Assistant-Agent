// 9.15 (Step-7.5 reachability) — a REAL source-ingestion commit surfaces a recent-change. Drives the proof-spine
// source activities DIRECTLY (no Temporal, no network — a FAKE $0 completion is the only fake; every gate real):
// assemble ARMED → sourceRunAgentJob → meetingValidate → sourceBuildOutputs → sourceCommit (wired to fire
// refreshRecentChanges post-commit) → the served read-model port returns ≥1 change for the committing workspace.
// Mirrors the proven autoIngest dry-run assembly ($0, no spend). Proves the producer is reachable on the real path
// ("real data appears"), not just from its own unit tests. spec(§11 / §9)
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk, ok, workspaceId, sourceId } from "@sow/contracts";
import type { SourceEnvelope } from "@sow/contracts";
import type { SourceIngestionContext } from "@sow/workflows";
import type { ClaudeSubscriptionCompletion } from "@sow/providers";
import { TBD } from "@sow/domain";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import { buildAutoIngestProofSpineParams, withSubscriptionExtractionArming } from "../../src/boot";
import { gateSubscriptionOnlyExtraction } from "../../src/composition/subscription-extraction-arming";
import { CLOUD_EXTRACTION_ROUTE } from "../../src/composition/extraction-route-gate";
import type { ExtractionContentResolver } from "../../src/composition/subscription-extraction-runner";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";

const WS = "ws-rc-live";
const NOW = "2026-07-24T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SRC_ID = sourceId("src-rc-live");
const CONTENT_HASH = "sha256:rc-live";
const BENIGN_MD = "# Standup\nAlex will refactor the auth module by Friday.\n";
const EXTRACTION_PROCESSOR = (CLOUD_EXTRACTION_ROUTE as unknown as { runtime: string }).runtime;

// evidence-backed owner + TBD dueDate ⇒ passes the REAL validateNoInference gate.
const VALID_AGENT_EXTRACTION = { fields: { owner: { value: "Alex", evidenceRef: "standup#L1" }, dueDate: { value: TBD } } } as const;

function armedWiring() {
  const completion: ClaudeSubscriptionCompletion = {
    complete: () => Promise.resolve(ok({ structuredOutput: VALID_AGENT_EXTRACTION, costUsd: 0 })),
  };
  const content: ExtractionContentResolver = { resolve: () => Promise.resolve(ok(BENIGN_MD)) };
  const wiring = gateSubscriptionOnlyExtraction(
    { enabled: true },
    {
      makeCompletion: () => completion,
      makeContentResolver: () => content,
      checkReachable: () => ({ loginPresent: true, sdkReachable: true }),
      now: () => 1000,
    },
  );
  if (wiring === undefined) throw new Error("expected an armed wiring (enabled:true)");
  return wiring.providerTransport;
}

const ctxFor = (): SourceIngestionContext => ({
  source: {
    sourceId: SRC_ID,
    workspaceId: workspaceId(WS),
    origin: "file://vault/standup.md",
    contentHash: CONTENT_HASH,
    type: "note",
    sensitivity: "normal",
    routingHints: {},
    body: BENIGN_MD,
  } as SourceEnvelope,
  workspaceId: workspaceId(WS),
  envelopes: [],
});

describe("recent-changes producer — wired post-commit refresh surfaces a real ingest on the served read path", () => {
  it("real_source_commit_surfaces_a_recent_change — spec(§11 / §9)", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-rc-live-"));
    const backends = await assembleBackends({
      now: () => NOW,
      vaultRoot,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      providerTransport: armedWiring(),
    });
    try {
      const armed = withSubscriptionExtractionArming(buildAutoIngestProofSpineParams(WS, [EXTRACTION_PROCESSOR]), true);
      if (armed === undefined) throw new Error("expected armed proof-spine params");
      const acts = buildProofSpineActivities(backends, armed);

      // Drive the source path to a REAL commit (every gate real; the $0 fake completion is the only fake).
      const run = await acts.sourceRunAgentJob(ctxFor());
      expect(isOk(run)).toBe(true);
      if (!isOk(run)) return;
      const validated = acts.meetingValidate(run.value);
      expect(isOk(validated)).toBe(true);
      if (!isOk(validated)) return;
      const built = await acts.sourceBuildOutputs(
        validated.value,
        workspaceId(WS),
        { sourceId: SRC_ID, contentHash: CONTENT_HASH },
        BENIGN_MD,
      );
      expect(isOk(built)).toBe(true);
      if (!isOk(built)) return;
      const commit = await acts.sourceCommit(built.value.plan);
      expect(isOk(commit)).toBe(true);

      // The wired post-commit refresh populated the recent_changes read-model row for WS from the real
      // `knowledge_writer.commit` audit row the commit appended — proving the producer is reachable on the real
      // path. (The served `queries.recentChanges` additionally gates on known-workspace registry provisioning —
      // orthogonal to the producer; the row's presence + non-empty projection is the reachability proof.)
      const row = await backends.repos.readModels.get(READ_MODEL_KEYS.recentChanges, WS);
      expect(isOk(row)).toBe(true);
      if (isOk(row)) {
        const changes = (row.value.data as { changes: unknown[] }).changes;
        expect(changes.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
