// `onboarding.listWorkspaces` — the renderer's authoritative list of ONBOARDED workspaces.
//
// ⛔ THE DEFECT THIS EXISTS FOR, reported by the owner 2026-09-21 ("it still says 'Select an onboarded
// workspace to configure its connectors'") and traced at source: the renderer's `onboarded` slice had
// exactly ONE writer — the onboarding wizard's completion callback (`App.tsx`). Nothing ever rebuilt it
// on launch. The durable first-run marker (9.17) correctly suppressed the wizard, so after the FIRST
// restart every scope resolved to "not onboarded": Connectors, Copilot, egress, projects — all
// fail-closed, on an install with two real workspaces in `workspace_config`.
//
// ⭐ SOURCE OF TRUTH, chosen on measurement: `workspace_config`, NOT the `workspace_registry` read
// model. On the owner's machine the registry listed THREE ids and `workspace_config` held TWO —
// `personal-business` existed only in the registry (demo-seed residue). The store-backed egress-posture
// resolver reads `workspace_config` and fails closed on an absent row, so hydrating from the registry
// would make a workspace SELECTABLE that every posture check then rejects. Reading the same table the
// isolation checks read keeps "selectable" and "has a posture" identical by construction (WS-8).
//
// ⛔ RULE 7 / §5 — a FIELD ALLOWLIST, not a pass-through. `Workspace` carries `markdownRepoPath` (a
// filesystem path the renderer must never learn), `gbrainBrainId`, and the full egress policy. Only
// id, name and type cross.
import { describe, it, expect } from "vitest";
import { isErr, isOk, ok, err, type Result } from "@sow/contracts";
import type { Workspace } from "@sow/contracts";
import type { DbError, WorkspaceConfigRepository } from "@sow/db";
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

function realPort(repo: WorkspaceConfigRepository): OnboardingCommandPort {
  return createProvisionWorkspacePort({
    workspaceConfig: repo,
    readModels: {} as never,
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

  it("requires auth — an unauthenticated caller gets the gate's err, and the store is never read", async () => {
    let reads = 0;
    const repo = { list: async () => { reads += 1; return ok([]); } } as unknown as WorkspaceConfigRepository;
    const res = await caller(realPort(repo), UNAUTH_CTX).onboarding.listWorkspaces();
    expect(isErr(res)).toBe(true);
    expect(reads).toBe(0);
  });
});
