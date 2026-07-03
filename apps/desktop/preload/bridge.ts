// The privileged bridge, defined electron-free so the security snapshot test can
// build it with a recording `invoke` and verify the exact channel set. preload/
// index.ts wires the real `ipcRenderer.invoke`; the renderer only ever sees the
// typed `SowBridge` shape (preload/api.d.ts).
//
// This bridge exposes ONLY enumerated privileged/lifecycle channels — NO
// database, filesystem, secrets, connector, or worker-internal access
// (apps/desktop forbidden pattern #3; §5 / REQ-S-004).

export type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

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
}

export function buildSowBridge(invoke: InvokeFn): SowBridge {
  return {
    app: {
      getVersion: () => invoke("app:getVersion") as Promise<string>,
    },
    session: {
      getToken: () => invoke("session:getToken") as Promise<string>,
    },
  };
}

// The flat, checked-in set of privileged channels the bridge may invoke — the
// SINGLE SOURCE mirrored by preload/inventory.json and pinned by the snapshot
// test. Adding a capability MUST extend this list AND inventory.json together.
export const PRELOAD_CHANNELS = ["app:getVersion", "session:getToken"] as const;
export type PreloadChannel = (typeof PRELOAD_CHANNELS)[number];
