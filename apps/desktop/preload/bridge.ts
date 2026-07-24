// The privileged bridge, defined electron-free so the security snapshot test can
// build it with a recording `invoke` and verify the exact channel set. preload/
// index.ts wires the real `ipcRenderer.invoke`; the renderer only ever sees the
// typed `SowBridge` shape (preload/api.d.ts).
//
// This bridge exposes ONLY enumerated privileged/lifecycle channels — NO
// database, filesystem, secrets, connector, or worker-internal access
// (apps/desktop forbidden pattern #3; §5 / REQ-S-004).

export type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** The non-secret loopback worker endpoint the renderer's tRPC client targets. */
export interface WorkerEndpoint {
  readonly httpUrl: string;
  readonly wsUrl: string;
}

export interface SowBridge {
  readonly app: {
    /** The running app version (a benign lifecycle read — the bridge seed). */
    readonly getVersion: () => Promise<string>;
  };
  readonly session: {
    /**
     * The per-launch session token, injected from main (§5 / task 9.2). This is
     * the ONLY path the token reaches the renderer — never a global, the HTML, or
     * a log; other localhost clients cannot read the renderer's memory.
     */
    readonly getToken: () => Promise<string>;
  };
  readonly worker: {
    /**
     * The loopback worker endpoint `{ httpUrl, wsUrl }` once main has spawned it,
     * else null (9.4b / task 9.4b-D5). Carries NO token — the renderer pairs it
     * with `session.getToken()`, keeping exactly one token-bearing channel.
     */
    readonly getConnection: () => Promise<WorkerEndpoint | null>;
  };
  readonly vault: {
    /**
     * Open a vault note in its default editor (Obsidian) — open-BY-PATH only (9.12 / REQ-UX-003). Main
     * path-scopes the path (realpath containment under the configured vault roots) and performs the open;
     * the renderer never reads or enumerates the vault filesystem. Resolves `{ ok }` — no reason disclosed.
     */
    readonly open: (path: string) => Promise<{ ok: boolean }>;
    /** Reveal a vault path in the OS file manager (Finder), same path-scoping as `open`. */
    readonly reveal: (path: string) => Promise<{ ok: boolean }>;
  };
}

export function buildSowBridge(invoke: InvokeFn): SowBridge {
  return {
    app: {
      getVersion: () => invoke("app:getVersion") as Promise<string>,
    },
    session: {
      getToken: () => invoke("session:getToken") as Promise<string>,
    },
    worker: {
      getConnection: () => invoke("worker:getConnection") as Promise<WorkerEndpoint | null>,
    },
    vault: {
      open: (path) => invoke("vault:open", path) as Promise<{ ok: boolean }>,
      reveal: (path) => invoke("vault:reveal", path) as Promise<{ ok: boolean }>,
    },
  };
}

// The flat, checked-in set of privileged channels the bridge may invoke — the
// SINGLE SOURCE mirrored by preload/inventory.json and pinned by the snapshot
// test. Adding a capability MUST extend this list AND inventory.json together.
export const PRELOAD_CHANNELS = [
  "app:getVersion",
  "session:getToken",
  "worker:getConnection",
  "vault:open",
  "vault:reveal",
] as const;
export type PreloadChannel = (typeof PRELOAD_CHANNELS)[number];
