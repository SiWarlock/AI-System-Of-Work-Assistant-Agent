// spec(§5) spec(§16) — task 9.10-A: the durable posture feeds the veto at the ASSEMBLED
// composition root (safety rule 5; worker L50 — drive the real assembly, not just units).
//
// After the swap, the store-backed resolver (WorkspaceConfigRepository.egressPolicy) is the
// SINGLE source of the veto's acknowledgment input on BOTH consumer paths (Copilot synthesis
// + source ingestion), and backs systemHealth.egressStatus. These pins prove:
//   • byte-equivalent default: employer-raw + cloud + store-ack-OFF still DENYs at the real
//     broker (no cloud fallback) — the retired `type==="employer_work"` hack no longer forces
//     ack=true;
//   • single-sourced live read: one store change flips the resolved posture;
//   • egressStatus reflects the durable store, not the fail-closed constant.
import { describe, it, expect, afterEach } from "vitest";
import { isOk, isErr, ok, processorId, validAgentJob, defaultWorkspace } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ProviderMatrix, Workspace, WorkspaceType } from "@sow/contracts";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createSystemHealthQueryPort } from "../../src/boot";
import { createStoreBackedWorkspacePosture } from "../../src/api/adapters/storeBackedWorkspacePosture";
import { seedPersonalCloudCopilotAllowlist } from "../../src/composition/provisionWorkspace";
import type { WorkspaceConfigRepository, DbResult } from "@sow/db";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS = String(validAgentJob.workspaceId);

const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "test-model",
  endpoint: "https://api.anthropic.test",
  egressClass: "cloud",
} as unknown as ProviderRoute;

// A raw-content job on a CLOUD route. Whether the rule-5 veto bites depends on the
// WORKSPACE arg (employer_work vs personal), not the job.
const rawCloudJob = (over: Record<string, unknown> = {}): AgentJob =>
  ({ ...validAgentJob, providerRoute: cloudRoute, carriesRawContent: true, ...over }) as unknown as AgentJob;

const matrixFor = (allowed: string[]): ProviderMatrix =>
  ({
    workspaceId: validAgentJob.workspaceId,
    allowedProviders: allowed,
    capabilityDefaults: { "meeting.close": cloudRoute } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  }) as unknown as ProviderMatrix;

function workspaceWith(type: WorkspaceType, ack: boolean): Workspace {
  const base = defaultWorkspace({ id: WS, name: "W", type, markdownRepoPath: "/vault", gbrainBrainId: "brain" });
  return {
    ...base,
    egressPolicy: {
      ...base.egressPolicy,
      // ack-ON case allowlists claude for raw content so a DENY there proves the veto (not an empty allowlist).
      ...(ack ? { allowedProcessors: [processorId("claude")], rawContentAllowedProcessors: [processorId("claude")] } : {}),
      employerRawEgressAcknowledged: ack,
      ...(ack ? { acknowledgedAt: "2026-07-25T00:00:00.000Z" } : {}),
    },
  };
}

/** A mutable fake WorkspaceConfigRepository — `set` flips the persisted workspace to prove live reads. */
function mutableRepo(initial: Workspace): { repo: WorkspaceConfigRepository; set: (w: Workspace) => void } {
  let current = initial;
  const repo: WorkspaceConfigRepository = {
    get: (): DbResult<Workspace> => Promise.resolve(ok(current)),
    list: () => Promise.resolve(ok([current])),
    upsert: (w: Workspace) => {
      current = w;
      return Promise.resolve(ok(w));
    },
  };
  return { repo, set: (w) => (current = w) };
}

describe("§5 9.10-A — the durable posture feeds the assembled veto (rule 5 held, byte-equivalent)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("employer_raw_cloud_ack_off_still_denies — store ack=false ⇒ the real broker DENYs employer-raw cloud (no fallback)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const { repo } = mutableRepo(workspaceWith("employer_work", false));
    const resolver = createStoreBackedWorkspacePosture(repo);
    const posture = await resolver.resolve(WS);
    expect(isOk(posture)).toBe(true);
    if (!isOk(posture)) return;
    const outcome = await backends.broker.runJob({
      job: rawCloudJob({ idempotencyKey: "idem-store-deny" }),
      matrix: matrixFor(["claude"]),
      egress: posture.value.egress,
      workspace: { type: posture.value.type, dataOwner: posture.value.dataOwner },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("synthesis_hack_removed_reads_store — an employer_work workspace with store ack=false resolves ack=FALSE (the hack no longer forces true)", async () => {
    // The retired cloudCopilotPosture hack set employerRawEgressAcknowledged = (type==="employer_work"),
    // i.e. TRUE for every employer workspace. The store-backed resolver reads the DURABLE value instead.
    const resolver = createStoreBackedWorkspacePosture(mutableRepo(workspaceWith("employer_work", false)).repo);
    const p = await resolver.resolve(WS);
    expect(isOk(p)).toBe(true);
    if (isOk(p)) {
      expect(p.value.type).toBe("employer_work");
      expect(p.value.egress.employerRawEgressAcknowledged).toBe(false); // NOT the hack's true
    }
  });

  it("both_veto_paths_single_sourced — one store change flips the resolved posture (live read, no cached allow)", async () => {
    const { repo, set } = mutableRepo(workspaceWith("employer_work", false));
    const resolver = createStoreBackedWorkspacePosture(repo);
    const before = await resolver.resolve(WS);
    expect(isOk(before) && before.value.egress.employerRawEgressAcknowledged).toBe(false);
    // Flip the durable store (the Brief-B acknowledge write's effect) — the SAME resolver re-reads it.
    set(workspaceWith("employer_work", true));
    const after = await resolver.resolve(WS);
    expect(isOk(after) && after.value.egress.employerRawEgressAcknowledged).toBe(true);
  });

  it("egress_status_reflects_durable_store — systemHealth.egressStatus returns the persisted ack, not the fail-closed constant", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    // Persist a workspace with ack acknowledged.
    await backends.repos.workspaceConfig.upsert(workspaceWith("employer_work", true));
    const port = createSystemHealthQueryPort(backends);
    const status = await port.egressStatus(WS);
    expect(isOk(status)).toBe(true);
    if (isOk(status)) expect(status.value.employerRawEgressAcknowledged).toBe(true);
  });

  it("personal_cloud_copilot_allows_via_seeded_allowlist — a SEEDED personal workspace ALLOWS the cloud route post-swap (no regression, worker L7 positive control)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    // Option A single-source: the seed persists personal allowlist=[claude] so the LIVE
    // personal cloud-copilot allow-path survives the swap (employer stays fail-closed).
    const personal = seedPersonalCloudCopilotAllowlist(workspaceWith("personal_business", false));
    const resolver = createStoreBackedWorkspacePosture(mutableRepo(personal).repo);
    const posture = await resolver.resolve(WS);
    expect(isOk(posture)).toBe(true);
    if (!isOk(posture)) return;
    const outcome = await backends.broker.runJob({
      job: rawCloudJob({ idempotencyKey: "idem-personal-allow" }),
      matrix: matrixFor(["claude"]),
      egress: posture.value.egress,
      workspace: { type: posture.value.type, dataOwner: posture.value.dataOwner },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    // PERSONAL (employer veto never bites) + claude allowlisted (incl. raw) ⇒ the egress veto
    // ALLOWS. providerTransport is UNSET ⇒ the dormant stub run leg errs DOWNSTREAM — so assert
    // the failure (if any) is NOT at the egress veto (the allow-path survived the swap).
    if (isErr(outcome)) expect(outcome.error.stage).not.toBe("egress_veto");
  });

  it("seed_allowlists_personal_not_employer — personal types get [claude]; employer_work stays fail-closed (empty, ack false)", () => {
    const pb = seedPersonalCloudCopilotAllowlist(workspaceWith("personal_business", false));
    const pl = seedPersonalCloudCopilotAllowlist(workspaceWith("personal_life", false));
    const ew = seedPersonalCloudCopilotAllowlist(workspaceWith("employer_work", false));
    expect(pb.egressPolicy.rawContentAllowedProcessors).toContain(processorId("claude"));
    expect(pl.egressPolicy.rawContentAllowedProcessors).toContain(processorId("claude"));
    // EMPLOYER_WORK is NEVER seeded — it opens ONLY via 9.10-B's audited acknowledge.
    expect(ew.egressPolicy.allowedProcessors).toEqual([]);
    expect(ew.egressPolicy.rawContentAllowedProcessors).toEqual([]);
    expect(ew.egressPolicy.employerRawEgressAcknowledged).toBe(false);
  });
});
