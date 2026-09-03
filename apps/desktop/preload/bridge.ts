// The privileged bridge, defined electron-free so the security snapshot test can
// build it with a recording `invoke` and verify the exact channel set. preload/
// index.ts wires the real `ipcRenderer.invoke`; the renderer only ever sees the
// typed `SowBridge` shape (preload/api.d.ts).
//
// This bridge exposes ONLY enumerated privileged/lifecycle channels — NO
// database, filesystem, secrets, connector, or worker-internal access
// (apps/desktop forbidden pattern #3; §5 / REQ-S-004).

export type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

// The durable first-run marker's wire type is owned by main/first-run.ts (the marker's owner); re-export it
// so the renderer imports it from the preload layer it already depends on (renderer → preload → main). A
// type-only import — erased at runtime, so the bridge stays electron-free for the security snapshot test.
import type { FirstRunStatus } from "../main/first-run";
export type { FirstRunStatus } from "../main/first-run";
// The closed repo-target union (9.12r Option A) is owned by main/open-in-vault.ts (the resolver's owner); re-export
// it so the renderer imports it from the preload layer it already depends on. Type-only ⇒ erased at runtime, so the
// bridge stays electron-free for the security snapshot test.
import type { VaultRepoTarget } from "../main/open-in-vault";
import type { CredentialProvisionResult } from "../main/credential-provision";
export type { VaultRepoTarget } from "../main/open-in-vault";

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
     * Open a repo in the OS file manager by CLOSED TARGET (9.12r Option A / REQ-UX-003). The renderer names
     * WHICH repo ("workspace" | "global") — never a path; MAIN resolves the target to a configured root and
     * opens it (the renderer never learns or enumerates the vault filesystem, §5). Resolves `{ ok }` — no reason
     * disclosed. (True "open in Obsidian" via the obsidian:// URI is the tracked A1 fast-follow.)
     */
    readonly open: (target: VaultRepoTarget) => Promise<{ ok: boolean }>;
    /** Reveal a repo (by the same closed target) in the OS file manager (Finder); main resolves the path. */
    readonly reveal: (target: VaultRepoTarget) => Promise<{ ok: boolean }>;
  };
  readonly secrets: {
    /**
     * Store a vendor write-credential in the login Keychain at `ref` (§14.2 / owner-authorized
     * 2026-09-03). ONE-WAY: the value goes in and there is NO channel to read one back.
     *
     * ⛔⛔ THIS IS THE ONE PLACE A SECRET CROSSES THE PRELOAD BRIDGE, AND IT WAS A DELIBERATE OWNER
     * DECISION TAKEN WITH THE COST STATED. Before it, the inventory guard forbade any
     * secrets-shaped channel outright. It is still forbidden in general; this single channel is an
     * explicit, named exception in `test/security/preload-inventory.snapshot.test.ts`.
     * ⭐ DIRECTIONALITY IS THE WHOLE MITIGATION AND MUST NEVER BE RELAXED: a compromised renderer
     * can OVERWRITE a credential; it cannot READ one. Adding any read counterpart here would end
     * that property, and it is the property the owner accepted the residual on.
     * ⚠ Resolves a closed `{ ok, reason? }` — the reason is one of a fixed token set, never the
     * value, the ref, or `security`'s output (rule 7).
     */
    readonly provision: (ref: string, value: string) => Promise<CredentialProvisionResult>;
  };
  readonly lifecycle: {
    /**
     * The durable first-run marker status (9.17 / §11). Main owns the marker under app-data; the renderer
     * consults it to decide the onboarding MOUNT (never the WS-8 isolation predicate — LESSON 9). A read
     * fault resolves to a typed err Result the renderer gate maps to the registry-derived fallback.
     */
    readonly firstRunStatus: () => Promise<FirstRunStatus>;
    /**
     * Mark onboarding complete (9.17) — idempotent. Called on a CONFIRMED `createWorkspace` and on the
     * existing-install backfill. Resolves the write Result; the renderer uses it fire-and-forget.
     */
    readonly markOnboarded: () => Promise<FirstRunStatus>;
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
      open: (target) => invoke("vault:open", target) as Promise<{ ok: boolean }>,
      reveal: (target) => invoke("vault:reveal", target) as Promise<{ ok: boolean }>,
    },
    secrets: {
      provision: (ref, value) =>
        invoke("secret:provision", ref, value) as Promise<CredentialProvisionResult>,
    },
    lifecycle: {
      firstRunStatus: () => invoke("lifecycle:firstRunStatus") as Promise<FirstRunStatus>,
      markOnboarded: () => invoke("lifecycle:markOnboarded") as Promise<FirstRunStatus>,
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
  "secret:provision",
  "lifecycle:firstRunStatus",
  "lifecycle:markOnboarded",
] as const;
export type PreloadChannel = (typeof PRELOAD_CHANNELS)[number];
