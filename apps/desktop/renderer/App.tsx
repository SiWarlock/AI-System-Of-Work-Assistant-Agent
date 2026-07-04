import { useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import { Today } from "./surfaces/today/Today";
import { createUiSafeStore } from "./store";
import { setScope, hydrateCards } from "./store/projections";
import { WORKSPACE_SCOPES, type WorkspaceScope } from "./store/scope";
import { startLive, type StartLiveHandle } from "./lib/live";
import { seedDevStore } from "./dev/seed";

// The renderer's single UI-safe store (app singleton — one window).
const store = createUiSafeStore();

export function App(): ReactElement {
  const liveRef = useRef<StartLiveHandle | null>(null);

  useEffect(() => {
    // Connect the live worker over the §10 push stream (9.4b E). When there is no
    // worker bridge (a standalone browser without Electron main), fall back to the
    // sample seed so the surface still renders populated in dev.
    let cancelled = false;
    void startLive(store).then((handle) => {
      if (cancelled) {
        handle?.stop();
        return;
      }
      liveRef.current = handle;
      if (handle === null && import.meta.env.DEV) seedDevStore(store);
    });
    return () => {
      cancelled = true;
      liveRef.current?.stop();
      liveRef.current = null;
    };
  }, []);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // §9.4 policy-gated drill-down: REQUEST the worker-enforced query; on a permitted
  // result fold the workspace-scoped cards in + switch scope to that workspace. A
  // denial / no-bridge is a safe no-op — the worker enforces, the renderer only asks.
  const onDrillDown = (workspaceId: string, projectionType: string): void => {
    void liveRef.current?.drillDown(workspaceId, projectionType).then((r) => {
      if (!r.ok) return;
      store.dispatch((st) => hydrateCards(st, r.cards));
      const scope = WORKSPACE_SCOPES.find((m) => m.workspaceId === workspaceId);
      if (scope) store.dispatch((st) => setScope(st, scope.id));
    });
  };

  return (
    <Today
      connection={state.connection}
      scope={state.scope}
      onScopeChange={(scope: WorkspaceScope): void => store.dispatch((st) => setScope(st, scope))}
      cards={[...state.cards.values()]}
      health={[...state.health.values()]}
      global={state.global}
      onDrillDown={onDrillDown}
    />
  );
}
