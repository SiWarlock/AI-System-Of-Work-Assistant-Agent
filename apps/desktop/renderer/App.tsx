import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import { Today } from "./surfaces/today/Today";
import { createUiSafeStore } from "./store";
import { seedDevStore } from "./dev/seed";

// The renderer's single UI-safe store (app singleton — one window).
const store = createUiSafeStore();

export function App(): ReactElement {
  useEffect(() => {
    // Dev: hydrate with sample UI-safe projections so Today renders populated.
    // 9.4b (production): connect the live event stream (createEventStream + the
    // tRPC wsLink transport) using the { baseUrl, token, origin } main hands over
    // the preload bridge, and issue the initial read-model queries.
    if (import.meta.env.DEV) seedDevStore(store);
  }, []);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <Today
      connection={state.connection}
      cards={[...state.cards.values()]}
      health={[...state.health.values()]}
    />
  );
}
