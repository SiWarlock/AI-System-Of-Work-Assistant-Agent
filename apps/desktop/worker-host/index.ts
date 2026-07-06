// The @sow/worker child-process HOST (9.4b). Electron main spawns this as a
// supervised background process. It receives the launch config over the child IPC
// channel (NEVER env/argv — the session token is a secret), boots the control-plane
// worker in Temporal-DEGRADED mode (no proofSpineParams — the first-render path),
// and reports {ready, port} back to main. It NEVER mints the token or resolves the
// allowlist — main owns those and injects them.
//
// PACKAGING NOTE: dev runs this as a `child_process.fork` under SYSTEM Node (native
// deps already built for that ABI, so the worker suite stays green). Packaging moves
// it to Electron `utilityProcess` (Electron Node ABI) + @electron/rebuild — at which
// point the `process.send`/`process.on("message")` IPC below becomes
// `process.parentPort.postMessage`/`.on("message")` (a small, isolated change).
import { boot } from "@sow/worker";
import type { SessionTokenValue } from "@sow/policy";
import { workspaceId } from "@sow/contracts";

/** The launch config main injects over the child IPC channel. */
interface WorkerHostConfig {
  /** The per-launch session-token secret (same string the renderer presents as Bearer). */
  readonly token: string;
  /** The per-launch identity (audit-only; does not affect token verification). */
  readonly launchId: string;
  /** The renderer Origin allowlist (exactly one, scheme-exact). */
  readonly origins: readonly string[];
  /** The loopback Host allowlist (exactly one, port-pinned). */
  readonly hosts: readonly string[];
  readonly apiHost: string;
  readonly apiPort: number;
  readonly dbPath?: string;
  readonly vaultRoot?: string;
}

/** Messages the host emits back to main. */
type HostMessage =
  | { readonly type: "ready"; readonly port: number }
  | { readonly type: "error"; readonly message: string };

function send(msg: HostMessage): void {
  process.send?.(msg);
}

let booted: boot.BootedWorker | undefined;
let starting = false;

async function start(config: WorkerHostConfig): Promise<void> {
  if (starting || booted !== undefined) return; // config is one-shot; ignore repeats
  starting = true;
  try {
    booted = await boot.bootWorker({
      sessionToken: { value: config.token as SessionTokenValue, launchId: config.launchId },
      allowlist: { origins: config.origins, hosts: config.hosts },
      apiHost: config.apiHost,
      apiPort: config.apiPort,
      // Real Copilot cloud path ON (owner posture: cloud OK for Employer-Work WITH the visible notice).
      // Model = Claude Sonnet 5; the synthesis adapter pairs it with the 1M-context beta by default.
      // To turn OFF (back to the deterministic local stub, nothing egresses), remove these two lines.
      copilotRealModel: true,
      copilotModel: "claude-sonnet-5",
      // P3-live: the personal-business Copilot reads the LOCAL gbrain (`gbrain call query`) instead of the
      // empty fixture stub; every other workspace stays on the fixture (WS-8 — only this workspace reads the
      // single local brain). Needs VOYAGE_API_KEY in the worker env + `gbrain` on PATH (else it fails
      // closed). To turn OFF (back to the fixture stub), remove this line.
      copilotGbrainRetrieval: true,
      // §13.10 gate (a) — WS-8 per-workspace scoping of the served brain, LIVE. The P1 retrieval now filters
      // every raw gbrain hit to the served workspace (foreign + legacy-denied dropped) before synthesis.
      // Posture (owner-chosen): {assign, personal-business} — legacy/unprefixed content is served ONLY to the
      // served personal-business workspace, never crossing to another. On TODAY's single-workspace brain (all
      // content is personal-business) this is INERT (every hit kept), so it does not change what the Copilot
      // returns — it activates the enforcement mechanism so future prefixed / multi-workspace content is scoped.
      // ⚠ The {assign} bridge is sound ONLY while the brain holds a single workspace's unprefixed content; do
      // NOT save non-personal-business content unprefixed while it is on (see docs/runbooks + ws8-workspace-scoping).
      // To turn OFF (back to unfiltered passthrough), remove these two lines.
      copilotWorkspaceScoping: true,
      copilotLegacyContentPolicy: { mode: "assign", toWorkspaceId: workspaceId("personal-business") },
      // §13.10 gate (a) — the AGENTIC Copilot tool path, LIVE. With copilotRealModel already ON, this switches
      // Copilot synthesis to the tool-enabled agent (Claude Sonnet 5 may call the gbrain READ tools mid-answer).
      // Because copilotWorkspaceScoping is ON, those tool calls reach gbrain ONLY through the in-process SCOPED
      // PROXY (SC5a arg-policing → the read → SC5b result-redaction), never the raw MCP server — so no unscoped /
      // cross-workspace read is possible. On TODAY's single-workspace brain (all personal-business) the WS-8
      // scoping + the F2 field-fidelity residual are INERT (no foreign workspace exists), so this adds tool reach
      // without a WS-8 leak surface. FAILS CLOSED if the http-grant transport (`gbrain serve --http`) is not
      // reachable — the proxy exec returns empty, never a leak. ⚠ OPERATIONAL: the agentic TOOLS use the http
      // transport while P1 RETRIEVAL still uses the `gbrain call query` CLI; gbrain's PGlite is single-connection,
      // so a running `serve --http` and the CLI contend for the DB lock — the clean setup moves retrieval onto the
      // http transport too (follow-up). ⚠ Before a MULTI-workspace brain: close the F2 field-fidelity gap (gate-(c)
      // eval) + the A1 body-embedded residual (ingest-time). To turn OFF (back to the completion path, no tools),
      // remove this line.
      copilotAgentMode: true,
      // No-op dispatch stubs — a first render triggers neither path (no jobs/approvals yet).
      triageDispatch: (input) =>
        Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } }),
      dispatchApproval: () => Promise.resolve({ ok: true, value: undefined }),
      ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
      ...(config.vaultRoot !== undefined ? { vaultRoot: config.vaultRoot } : {}),
      // NO proofSpineParams → boots the control-plane API only; connectTemporal
      // degrades cleanly (the proof-spine pipeline is wired later).
    });
    // Drive the initial Temporal connect. With no proof-spine params it degrades
    // cleanly (no real Temporal contact, no throw — §16). On the degraded variant this
    // records an operator-visible worker_down System-Health item via the degraded
    // controller — persisted through the surface into the SAME health_items table the
    // systemHealth query reads — so the renderer's "System health" shows "Worker down"
    // instead of a false "All systems healthy".
    //
    // AWAITED before announcing readiness so the item is persisted BEFORE the renderer's
    // initial health hydrate (a fresh null-cursor stream subscribe does not replay a
    // pre-subscribe publish). With no proof-spine params the connect resolves without a
    // network round-trip, so awaiting adds negligible latency.
    await boot.reportInitialConnect(booted, {
      now: booted.backends.now(),
      logger: booted.backends.logger,
    });
    send({ type: "ready", port: booted.api.port });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    starting = false;
  }
}

async function shutdown(): Promise<void> {
  const b = booted;
  booted = undefined;
  try {
    if (b) await b.close();
  } finally {
    process.exit(0);
  }
}

process.on("message", (msg: unknown) => {
  if (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "config" &&
    "config" in msg
  ) {
    void start((msg as { config: WorkerHostConfig }).config);
  }
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
// If main drops the IPC channel (main exited), shut down so no orphan worker leaks.
process.on("disconnect", () => void shutdown());
