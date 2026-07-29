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
import { seedCloudCopilotAllowlist } from "../../src/composition/provisionWorkspace";
import type { WorkspaceConfigRepository, DbResult } from "@sow/db";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS = String(validAgentJob.workspaceId);
const NOW = "2026-07-25T00:00:00.000Z";

const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "test-model",
  endpoint: "https://api.anthropic.test",
  egressClass: "cloud",
} as unknown as ProviderRoute;
// A NON-claude cloud route (its own processor id "openai"), for the scope pin.
const openaiCloudRoute: ProviderRoute = {
  provider: "openai",
  model: "gpt",
  endpoint: "https://api.openai.test",
  egressClass: "cloud",
} as unknown as ProviderRoute;

// A raw-content job on a given CLOUD route (default claude). Whether the rule-5 veto bites depends on
// the WORKSPACE arg (employer_work vs personal) + the seeded allowlist, not the job itself.
const rawCloudJob = (over: Record<string, unknown> = {}, route: ProviderRoute = cloudRoute): AgentJob =>
  ({ ...validAgentJob, providerRoute: route, carriesRawContent: true, ...over }) as unknown as AgentJob;

const matrixFor = (allowed: string[], route: ProviderRoute = cloudRoute): ProviderMatrix =>
  ({
    workspaceId: validAgentJob.workspaceId,
    allowedProviders: allowed,
    capabilityDefaults: { "meeting.close": route } as ProviderMatrix["capabilityDefaults"],
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
    updateProvisioningFields: (_id, f) => {
      // Apply for real — a fake that reports success while mutating nothing lets a silently-dropped
      // write pass as green (its `upsert` sibling two lines up DOES mutate).
      current = { ...current, ...f };
      return Promise.resolve(ok(current));
    },
    insertIfAbsent: () => Promise.resolve(ok(false)),
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
    // personal cloud-copilot allow-path survives the swap.
    const personal = seedCloudCopilotAllowlist(workspaceWith("personal_business", false), NOW);
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

  it("seed_allowlists_personal_and_employer_scoped — personal + employer get [claude]; ONLY employer gets ack=true + acknowledgedAt (the owner-authorized flip)", () => {
    const pb = seedCloudCopilotAllowlist(workspaceWith("personal_business", false), NOW);
    const pl = seedCloudCopilotAllowlist(workspaceWith("personal_life", false), NOW);
    const ew = seedCloudCopilotAllowlist(workspaceWith("employer_work", false), NOW);
    // personal: [claude] allowlist, ack UNCHANGED false (the employer veto never bites for personal).
    expect(pb.egressPolicy.rawContentAllowedProcessors).toContain(processorId("claude"));
    expect(pl.egressPolicy.rawContentAllowedProcessors).toContain(processorId("claude"));
    expect(pb.egressPolicy.employerRawEgressAcknowledged).toBe(false);
    // employer_work — the ⛔ OWNER-AUTHORIZED FLIP: SCOPED to [claude] only + ack=true + acknowledgedAt.
    expect(ew.egressPolicy.allowedProcessors).toEqual([processorId("claude")]);
    expect(ew.egressPolicy.rawContentAllowedProcessors).toEqual([processorId("claude")]);
    expect(ew.egressPolicy.employerRawEgressAcknowledged).toBe(true);
    expect(ew.egressPolicy.acknowledgedAt).toBe(NOW); // acknowledged_at_stamped (REQ-S-002 audit trail)
  });

  it("veto_allows_employer_raw_cloud_claude — a SEEDED employer_work workspace RESOLVES ack=true + the assembled broker ALLOWS employer-raw cloud [claude] (INVERSE of the 9.10-A ack-off DENY)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const seededEmployer = seedCloudCopilotAllowlist(workspaceWith("employer_work", false), NOW);
    const resolver = createStoreBackedWorkspacePosture(mutableRepo(seededEmployer).repo);
    const posture = await resolver.resolve(WS);
    expect(isOk(posture)).toBe(true);
    if (!isOk(posture)) return;
    expect(posture.value.egress.employerRawEgressAcknowledged).toBe(true); // employer_seed_resolves_ack_true
    const outcome = await backends.broker.runJob({
      job: rawCloudJob({ idempotencyKey: "idem-employer-claude-allow" }),
      matrix: matrixFor(["claude"]),
      egress: posture.value.egress,
      workspace: { type: posture.value.type, dataOwner: posture.value.dataOwner },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    // ack=true + claude allowlisted ⇒ the veto ALLOWS; the dormant stub run leg errs DOWNSTREAM (not egress_veto).
    if (isErr(outcome)) expect(outcome.error.stage).not.toBe("egress_veto");
  });

  it("non_claude_employer_raw_still_denies — the flip is SCOPED to [claude]: a NON-claude cloud processor on employer-raw STILL DENIES (rule-5; never blanket-cloud)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const seededEmployer = seedCloudCopilotAllowlist(workspaceWith("employer_work", false), NOW);
    const resolver = createStoreBackedWorkspacePosture(mutableRepo(seededEmployer).repo);
    const posture = await resolver.resolve(WS);
    expect(isOk(posture)).toBe(true);
    if (!isOk(posture)) return;
    const outcome = await backends.broker.runJob({
      job: rawCloudJob({ idempotencyKey: "idem-employer-openai-deny" }, openaiCloudRoute),
      matrix: matrixFor(["openai"], openaiCloudRoute),
      egress: posture.value.egress,
      workspace: { type: posture.value.type, dataOwner: posture.value.dataOwner },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    // ack=true (the employer veto doesn't bite) BUT proc "openai" ∉ the [claude] allowlist ⇒ DENY at the veto.
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.stage).toBe("egress_veto");
  });

  it("employer_absence_still_fails_closed — THE line: the flip seeds a PROVISIONED durable ack, NEVER a fault-time default-true — an absent/faulted employer posture STILL fails closed (rule-5 preserve-fault)", async () => {
    // A never-provisioned (absent) employer workspace: the seed only applies at provisioning, so the
    // store-backed resolver reads not_found ⇒ err (unknownWorkspace), NOT a synthesized ack=true.
    const absentRepo: WorkspaceConfigRepository = {
      get: (): DbResult<Workspace> => Promise.resolve({ ok: false, error: { code: "not_found", message: "never provisioned" } }),
      list: () => Promise.resolve({ ok: false, error: { code: "unknown", message: "n/a" } }),
      upsert: (w: Workspace) => Promise.resolve(ok(w)),
      insertIfAbsent: () => Promise.resolve(ok(false)),
      updateProvisioningFields: () =>
        Promise.resolve({ ok: false, error: { code: "not_found", message: "never provisioned" } }),
    };
    // A store FAULT on an employer read: still fail-closed (fault ≠ benign absence, never default-true).
    const faultRepo: WorkspaceConfigRepository = {
      get: (): DbResult<Workspace> => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } }),
      list: () => Promise.resolve({ ok: false, error: { code: "unknown", message: "n/a" } }),
      upsert: (w: Workspace) => Promise.resolve(ok(w)),
      insertIfAbsent: () => Promise.resolve(ok(false)),
      updateProvisioningFields: () =>
        Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } }),
    };
    expect(isOk(await createStoreBackedWorkspacePosture(absentRepo).resolve(WS))).toBe(false);
    expect(isOk(await createStoreBackedWorkspacePosture(faultRepo).resolve(WS))).toBe(false);
  });
});
