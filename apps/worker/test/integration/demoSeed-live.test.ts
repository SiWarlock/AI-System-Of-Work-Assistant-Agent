// 9.19 (Step-7.5 reachability) — the demo-seed lights up the SERVED Today queries. Assembles REAL
// backends, runs the boot GATE helper (`maybeSeedDemoData`) with SOW_DEMO_SEED ON vs OFF, and drives
// the REAL served tRPC query router (`buildQueryRouter` over `createDbReadModelQueryPort`, in-process
// caller — the SAME path the renderer hits, incl. the sanitize re-gates): ON → dashboard + global +
// each demo workspace's recentChanges/ingestionInbox/projectList return the seeded rows; OFF → the
// global surfaces are empty (byte-equivalent). Proves the seed is reachable end-to-end on the served
// path, not just from its own unit tests. spec(§11 / §10)
import { describe, it, expect } from "vitest";
import { ok, isOk } from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../src/api/trpc";
import type { AuthedContext } from "../../src/api/auth/sessionAuth";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createDbReadModelQueryPort } from "../../src/api/adapters/readModel";
import { buildQueryRouter } from "../../src/api/procedures/queries";
import {
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
} from "../../src/api/procedures/copilot";
import { createFixtureBriefingRetrieval } from "../../src/api/procedures/copilotBriefing";
import { maybeSeedDemoData, DEMO_WORKSPACE_IDS } from "../../src/composition/demoSeed";

const NOW = "2026-07-24T00:00:00.000Z";
const AUTHED_CTX: ApiContext = { auth: ok<AuthedContext>({ authenticated: true }) };

/** An in-process caller over the query router mounted on the REAL read-model port. */
function makeCaller(b: ProofSpineBackends) {
  const readModel = createDbReadModelQueryPort({ readModels: b.repos.readModels, approvals: b.repos.approvals });
  const copilot = {
    retrieval: createFixtureRetrieval({}),
    synthesis: createStubSynthesis(),
    workspacePosture: createLocalWorkspacePosture({}),
    routeSelector: createLocalRouteSelector(),
  };
  const briefing = {
    retrieval: createFixtureBriefingRetrieval({}),
    synthesis: createStubSynthesis(),
    workspacePosture: createLocalWorkspacePosture({}),
    routeSelector: createLocalRouteSelector(),
  };
  const appRouter = router({ query: buildQueryRouter({ readModel, copilot, briefing }) });
  return createCallerFactory(appRouter)(AUTHED_CTX);
}

describe("demoSeed — boot-gated reachability on the served Today queries", () => {
  it("boot_demo_seed_on_populates_off_empty — spec(§11 / §10)", async () => {
    // ── ON: SOW_DEMO_SEED="1" seeds; the served queries return the rows. ──
    const on = await assembleBackends({ now: () => NOW });
    try {
      const seeded = await maybeSeedDemoData({ SOW_DEMO_SEED: "1" }, { readModels: on.repos.readModels, now: on.now });
      expect(seeded !== undefined && isOk(seeded)).toBe(true);
      const caller = makeCaller(on);

      const dash = await caller.query.dashboard();
      expect(isOk(dash) && dash.value.length > 0).toBe(true);
      const glob = await caller.query.global();
      expect(isOk(glob) && glob.value.length > 0).toBe(true);

      for (const ws of DEMO_WORKSPACE_IDS) {
        const rc = await caller.query.recentChanges({ workspaceId: ws });
        expect(isOk(rc) && rc.value.length > 0).toBe(true);
        const ing = await caller.query.ingestionInbox({ workspaceId: ws });
        expect(isOk(ing) && ing.value.length > 0).toBe(true);
        const pl = await caller.query.projectList({ workspaceId: ws });
        expect(isOk(pl) && pl.value.length > 0).toBe(true);
      }
    } finally {
      on.close();
    }

    // ── OFF: no flag ⇒ byte-equivalent, the global surfaces stay empty. ──
    const off = await assembleBackends({ now: () => NOW });
    try {
      const skipped = await maybeSeedDemoData({}, { readModels: off.repos.readModels, now: off.now });
      expect(skipped).toBeUndefined();
      const caller = makeCaller(off);
      const dash = await caller.query.dashboard();
      expect(isOk(dash) && dash.value.length === 0).toBe(true);
      const glob = await caller.query.global();
      expect(isOk(glob) && glob.value.length === 0).toBe(true);
    } finally {
      off.close();
    }
  });
});
