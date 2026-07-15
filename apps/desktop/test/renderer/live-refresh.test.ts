import { describe, it, expect } from "vitest";
import { createScopeRefresher } from "../../renderer/lib/scope-refresh";
import { createUiSafeStore, type Store, type UiSafeStoreState } from "../../renderer/store";
import { setScope, recordOnboardedWorkspace } from "../../renderer/store/projections";
import type { WorkspaceBucketScope } from "../../renderer/store/onboarding";
import type { WorkspaceType } from "@sow/contracts/primitives/enums";
import { uiSafeCard } from "./fixtures";

// A minimal mock of the generic tRPC client the refresher touches: only
// `query.workspace.query({ workspaceId })`. `resolver` lets a test control the
// resolved value and (via a returned Promise it holds) the resolution timing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockClient(resolver: (workspaceId: string) => Promise<unknown>): any {
  return { query: { workspace: { query: (input: { workspaceId: string }) => resolver(input.workspaceId) } } };
}

// Onboard a bucket so it resolves to a REAL query id (§19.1 / 14.1): the refresher only pulls a
// scope that has an onboarded workspace. The buckets map 1:1 to a WorkspaceType.
const BUCKET_TYPE: Record<WorkspaceBucketScope, WorkspaceType> = {
  "employer-work": "employer_work",
  "personal-business": "personal_business",
  "personal-life": "personal_life",
};
function onboard(store: Store<UiSafeStoreState>, scope: WorkspaceBucketScope): void {
  store.dispatch((s) =>
    recordOnboardedWorkspace(s, {
      workspaceId: `ws_${scope}`,
      scope,
      name: scope,
      type: BUCKET_TYPE[scope],
      preset: "simple",
    }),
  );
}

describe("createScopeRefresher (§9.5 — push-path workspace liveness)", () => {
  it("refreshes a workspace scope's cards via the scoped pull path (query.workspace)", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "employer-work"));
    onboard(store, "employer-work");
    const client = mockClient(async () => ({ ok: true, value: [uiSafeCard("ws-1")] }));
    const r = createScopeRefresher(client, store);
    await r.refresh("employer-work");
    expect([...store.getSnapshot().cards.keys()]).toEqual(["ws-1"]);
  });

  it("is a NO-OP in Global scope — never re-queries (Global stays live via the direct fold)", async () => {
    const store = createUiSafeStore(); // default scope is Global
    let queried = 0;
    const client = mockClient(async () => {
      queried += 1;
      return { ok: true, value: [uiSafeCard("x")] };
    });
    const r = createScopeRefresher(client, store);
    await r.refresh("global");
    expect(queried).toBe(0);
    expect(store.getSnapshot().cards.size).toBe(0);
  });

  it("is latest-wins — a slow OLDER refresh never overwrites a NEWER one's cards", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "employer-work"));
    onboard(store, "employer-work");
    const resolvers: Array<(v: unknown) => void> = [];
    const client = mockClient(() => new Promise((res) => resolvers.push(res)));
    const r = createScopeRefresher(client, store);
    const p1 = r.refresh("employer-work"); // token 1 (older)
    const p2 = r.refresh("employer-work"); // token 2 (newer)
    // Resolve the NEWER first, then the older — the older must be dropped.
    resolvers[1]!({ ok: true, value: [uiSafeCard("new")] });
    await p2;
    resolvers[0]!({ ok: true, value: [uiSafeCard("old")] });
    await p1;
    expect([...store.getSnapshot().cards.keys()]).toEqual(["new"]);
  });

  it("drops a result whose scope was switched away mid-flight (stale-scope guard)", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "employer-work"));
    onboard(store, "employer-work");
    let resolve!: (v: unknown) => void;
    const client = mockClient(() => new Promise((res) => (resolve = res)));
    const r = createScopeRefresher(client, store);
    const p = r.refresh("employer-work");
    store.dispatch((s) => setScope(s, "personal-business")); // switch away mid-flight
    resolve({ ok: true, value: [uiSafeCard("stale")] });
    await p;
    expect(store.getSnapshot().cards.size).toBe(0); // stale-scope result dropped
  });

  it("a THROWN query leaves the prior snapshot intact (best-effort)", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "personal-life"));
    onboard(store, "personal-life");
    const client = mockClient(async () => {
      throw new Error("worker down");
    });
    const r = createScopeRefresher(client, store);
    await r.refresh("personal-life");
    expect(store.getSnapshot().cards.size).toBe(0); // no throw, no partial state
  });

  it("a RESOLVED failure Result ({ ok: false }) is a no-op — cards untouched", async () => {
    // Distinct from a thrown rejection: the query resolves cleanly but reports failure.
    // `cardsR?.ok === true` gates the apply, so a failure Result must leave cards as-is.
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "employer-work"));
    onboard(store, "employer-work");
    const client = mockClient(async () => ({ ok: false, error: "read-model-unavailable" }));
    const r = createScopeRefresher(client, store);
    await r.refresh("employer-work");
    expect(store.getSnapshot().cards.size).toBe(0);
  });
});
