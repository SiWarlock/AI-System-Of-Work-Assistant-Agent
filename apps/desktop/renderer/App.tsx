import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import { Today } from "./surfaces/today/Today";
import { createUiSafeStore } from "./store";
import { setScope } from "./store/projections";
import type { WorkspaceScope } from "./store/scope";
import { startLive } from "./lib/live";
import { seedDevStore } from "./dev/seed";

// The renderer's single UI-safe store (app singleton — one window).
const store = createUiSafeStore();

export function App(): ReactElement {
  useEffect(() => {
    // Connect the live worker over the §10 push stream (9.4b E). When there is no
    // worker bridge (a standalone browser without Electron main), fall back to the
    // sample seed so the surface still renders populated in dev.
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startLive(store).then((s) => {
      if (cancelled) {
        s?.();
        return;
      }
      stop = s;
      if (s === null && import.meta.env.DEV) seedDevStore(store);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <Today
      connection={state.connection}
      scope={state.scope}
      onScopeChange={(scope: WorkspaceScope): void => store.dispatch((st) => setScope(st, scope))}
      cards={[...state.cards.values()]}
      health={[...state.health.values()]}
    />
  );
}
