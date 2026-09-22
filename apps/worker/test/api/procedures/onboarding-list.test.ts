// `onboarding.listWorkspaces` — the renderer's authoritative list of ONBOARDED workspaces.
//
// ⛔ THE DEFECT THIS EXISTS FOR, reported by the owner 2026-09-21 ("it still says 'Select an onboarded
// workspace to configure its connectors'") and traced at source: the renderer's `onboarded` slice had
// exactly ONE writer — the onboarding wizard's completion callback (`App.tsx`). Nothing ever rebuilt it
// on launch. The durable first-run marker (9.17) correctly suppressed the wizard, so after the FIRST
// restart every scope resolved to "not onboarded": Connectors, Copilot, egress, projects — all
// fail-closed, on an install with two real workspaces in `workspace_config`.
//
// ⭐ SOURCE OF TRUTH: `workspace_config` AND the `workspace_registry` read model — BOTH, intersected.
// ⛔ CORRECTED 2026-09-21, same day: the first cut read `workspace_config` ALONE, and an adversarial
// review (upheld 3/3) showed why that is wrong. The registry is the SOLE WS-8 visibility authority
// (`provisionWorkspace.ts:9-11`); a config row is data ABOUT a registered workspace. A PARTIAL SCAFFOLD
// (task 9.21-A: config row written, registry union failed) has a config row and no registry
// membership. Config-alone made it selectable, which then backfilled the first-run marker, which hid
// the wizard — the ONLY path that re-runs the registry union. A designed, resumable state became a
// stranded one. Each source alone is wrong in its own direction, measured on the owner's machine:
//   • registry alone lists `personal-business`, which has NO config row, so every posture check rejects it;
//   • config alone would list a partial scaffold that every registry-gated call rejects.
// ⇒ Onboarded = has a config row AND is a registry member. Then "selectable", "has a posture" and
// "registry-visible" all agree by construction.
//
// ⛔ RULE 7 / §5 — a FIELD ALLOWLIST, not a pass-through. `Workspace` carries `markdownRepoPath` (a
// filesystem path the renderer must never learn), `gbrainBrainId`, and the full egress policy. Only
// id, name and type cross.
import { describe, it, expect } from "vitest";
import { isErr, isOk, ok, err, type Result } from "@sow/contracts";
import type { Workspace } from "@sow/contracts";
import type { DbError, ReadModelRepository, WorkspaceConfigRepository } from "@sow/db";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildOnboardingRouter,
  createProvisionWorkspacePort,
  type OnboardingCommandPort,
} from "../../../src/api/procedures/onboarding";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

const SECRET_PATH = "/Users/someone/Obsidian/employer-vault";

function ws(id: string, name: string, type: Workspace["type"]): Workspace {
  return {
    id,
    name,
    type,
    dataOwner: type === "employer_work" ? "employer" : "user",
    markdownRepoPath: SECRET_PATH,
    gbrainBrainId: "brain-secret-id",
    defaultVisibility: "isolated",
    egressPolicy: {
      workspaceId: id,
      allowedProcessors: ["claude"],
      rawContentAllowedProcessors: ["claude"],
      employerRawEgressAcknowledged: true,
    },
    providerMatrix: { workspaceId: id, allowedProviders: [], capabilityDefaults: {}, rawCloudEgressEnabled: false },
  } as unknown as Workspace;
}

/** A WorkspaceConfigRepository whose `list` returns a canned result; every other method is unused. */
function repoListing(result: Result<Workspace[], DbError>): WorkspaceConfigRepository {
  return { list: async () => result } as unknown as WorkspaceConfigRepository;
}

/** A ReadModelRepository whose `get` answers for the registry key only. */
function registry(
  answer: { readonly ids: readonly string[] } | "not_found" | "fault",
): ReadModelRepository {
  return {
    get: async (key: string) => {
      if (key !== "workspace_registry") return err({ code: "not_found", message: "n/a" } as unknown as DbError);
      if (answer === "not_found") return err({ code: "not_found", message: "absent" } as unknown as DbError);
      if (answer === "fault") return err({ code: "io", message: "SQLITE_BUSY at /secret/registry.db" } as unknown as DbError);
      return ok({ readModelKey: key, workspaceId: null, data: { workspaceIds: answer.ids }, rebuiltAt: "t" });
    },
  } as unknown as ReadModelRepository;
}

/** The owner's measured registry: three ids, one of which has no config row. */
const OWNER_REGISTRY = registry({ ids: ["personal-life", "employer-work", "personal-business"] });

function realPort(repo: WorkspaceConfigRepository, readModels: ReadModelRepository = OWNER_REGISTRY): OnboardingCommandPort {
  return createProvisionWorkspacePort({
    workspaceConfig: repo,
    readModels,
    now: () => "2026-09-21T00:00:00.000Z",
  });
}

function caller(port: OnboardingCommandPort, ctx: ApiContext = AUTHED_CTX) {
  return createCallerFactory(router({ onboarding: buildOnboardingRouter({ onboarding: port }) }))(ctx);
}

describe("onboarding.listWorkspaces — the renderer's onboarded set, rebuilt on every launch", () => {
  it("returns every workspace_config row as {workspaceId, name, type}, sorted by id", async () => {
    const port = realPort(
      repoListing(ok([ws("personal-life", "Test", "personal_life"), ws("employer-work", "Main-Test", "employer_work")])),
    );
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Sorted so the renderer's per-bucket recording is deterministic across launches.
    expect(res.value).toEqual([
      { workspaceId: "employer-work", name: "Main-Test", type: "employer_work" },
      { workspaceId: "personal-life", name: "Test", type: "personal_life" },
    ]);
  });

  it("⛔ RULE 7 / §5 — no filesystem path, brain id, or egress policy crosses to the renderer", async () => {
    const port = realPort(repoListing(ok([ws("employer-work", "Main-Test", "employer_work")])));
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const wire = JSON.stringify(res.value);
    expect(wire).not.toContain(SECRET_PATH);
    expect(wire).not.toContain("brain-secret-id");
    expect(wire).not.toContain("allowedProcessors");
    // Exact key set — a future field added to the Workspace model must not ride along silently.
    expect(Object.keys(res.value[0] ?? {}).sort()).toEqual(["name", "type", "workspaceId"]);
  });

  it("an EMPTY store is an authoritative empty list, not a fault", async () => {
    const res = await caller(realPort(repoListing(ok([])))).onboarding.listWorkspaces();
    expect(isOk(res) && res.value).toEqual([]);
  });

  it("a store fault is a typed, redaction-safe err — the driver's message never crosses", async () => {
    const fault = err({ kind: "io", message: "SQLITE_BUSY at /Users/someone/secret.db" } as unknown as DbError);
    const res = await caller(realPort(repoListing(fault))).onboarding.listWorkspaces();
    expect(isErr(res)).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(res)).not.toContain("secret.db");
  });

  it("a port with no list capability is a typed err — never a fake authoritative empty list", async () => {
    // An empty ok here would tell the renderer "no workspaces are onboarded", which is a claim, not
    // an absence. A port that cannot answer must say so.
    const bare: OnboardingCommandPort = { provisionWorkspace: async () => ({ ok: false, error: {} as never }) };
    const res = await caller(bare).onboarding.listWorkspaces();
    expect(isErr(res)).toBe(true);
  });

  it("⛔ a PARTIAL SCAFFOLD (config row, no registry membership) is NOT listed alongside a registered one", async () => {
    // `insertIfAbsent` wrote personal-life's row, then `registerWorkspace` faulted. It must not be
    // selectable, because every registry-gated call would reject it.
    // ⚠ AMENDED 2026-09-21 (review, upheld 2/3): this title used to claim "the wizard's resume path
    // survives". In THIS fixture it does not — employer-work is listed, so the wizard is hidden and
    // the marker backfilled regardless. What this pins is that "selectable" matches "registry-visible".
    // The wizard-survives property holds only when the partial scaffold is the SOLE workspace; see
    // the next test and the absent-registry test.
    const port = realPort(
      repoListing(ok([ws("employer-work", "Main-Test", "employer_work"), ws("personal-life", "Test", "personal_life")])),
      registry({ ids: ["employer-work"] }), // personal-life's registry union never landed
    );
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res) && res.value.map((w) => w.workspaceId)).toEqual(["employer-work"]);
  });

  it("the SOLE workspace as a partial scaffold lists NOTHING — so the wizard stays reachable to resume it", async () => {
    // The case where the intersection actually protects the 9.21-B resume path: the registry exists
    // (some earlier union succeeded) but does not contain the only config row. An empty list keeps
    // the renderer's onboarded set empty, so the wizard mounts and a resubmit re-runs the union.
    const port = realPort(
      repoListing(ok([ws("employer-work", "Main-Test", "employer_work")])),
      registry({ ids: ["some-other-id"] }),
    );
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res) && res.value).toEqual([]);
  });

  it("a registry id with NO config row is NOT listed (the owner's `personal-business`)", async () => {
    const port = realPort(repoListing(ok([ws("employer-work", "Main-Test", "employer_work")])));
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res) && res.value.map((w) => w.workspaceId)).toEqual(["employer-work"]);
  });

  it("an ABSENT registry means nothing is registry-visible — an authoritative empty list", async () => {
    // `not_found` is the fresh-install state (nothing ever unioned), not a fault: every scoped read
    // would reject every workspace, so listing any of them would be the partial-scaffold bug again.
    const port = realPort(repoListing(ok([ws("employer-work", "Main-Test", "employer_work")])), registry("not_found"));
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isOk(res) && res.value).toEqual([]);
  });

  it("a registry store FAULT is a typed err, never a fold-to-empty, and its detail never crosses", async () => {
    // Folding a fault to empty would be a false claim that nothing is visible. Fail loudly instead,
    // matching `registerWorkspace`'s own discipline.
    const port = realPort(repoListing(ok([ws("employer-work", "Main-Test", "employer_work")])), registry("fault"));
    const res = await caller(port).onboarding.listWorkspaces();
    expect(isErr(res)).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SQLITE_BUSY");
  });

  it("requires auth — an unauthenticated caller gets the gate's err, and the store is never read", async () => {
    let reads = 0;
    const repo = { list: async () => { reads += 1; return ok([]); } } as unknown as WorkspaceConfigRepository;
    const res = await caller(realPort(repo), UNAUTH_CTX).onboarding.listWorkspaces();
    expect(isErr(res)).toBe(true);
    expect(reads).toBe(0);
  });
});
