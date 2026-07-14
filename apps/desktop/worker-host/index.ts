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
import { boot, gbrainServe } from "@sow/worker";
import type { SessionTokenValue } from "@sow/policy";
import { workspaceId, isOk } from "@sow/contracts";

// Option A (app-managed serve): worker-host owns the local `gbrain serve --http --enable-dcr` lifecycle so the
// agentic Copilot tools + the http retrieval transport share ONE server (one PGlite connection — no CLI/serve
// DB-lock contention). On boot this SPAWNS `gbrain serve --http --enable-dcr --port 8899` (needs `gbrain` on PATH
// + VOYAGE_API_KEY + an initialized brain); on failure the supervisor fails closed → we omit the http config →
// retrieval stays on the CLI + agentic tools fail closed (graceful, ≤10s readiness bound).
//
// ✅ ENABLED — verified 2026-07-06 against gbrain 0.35.1: `serve --http --enable-dcr --port 8899` becomes ready
// (/mcp responds) and BINDS LOOPBACK ONLY (`lsof` + the serve banner both show 127.0.0.1, not 0.0.0.0) — so the
// SS1 bind-interface residual does not materialize here (gbrain has no `--host` flag, so this rests on gbrain's
// loopback default: ⚠ RE-VERIFY after a `gbrain upgrade` before trusting it on an untrusted LAN). Flip to `false`
// to go back to CLI retrieval + http tools that fail closed unless you run serve yourself.
const MANAGE_GBRAIN_SERVE = true;
/** The loopback base url the managed serve binds + both http transports read (matches worker DEFAULT_GBRAIN_HTTP_URL). */
const GBRAIN_SERVE_BASE_URL = "http://127.0.0.1:8899";
/** Bound the boot wait for serve-ready so a failed serve degrades in seconds, not the supervisor's 30s default. */
const GBRAIN_SERVE_READINESS_TIMEOUT_MS = 10_000;

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
  /** OPEN-THE-GATES auto-ingest opt-in (owner env; default OFF). When true + a vaultRoot is present, the host
   *  wires vaultWatch + proofSpineParams + Temporal into bootWorker to activate live vault→ingestion. */
  readonly autoIngest?: boolean;
  /** The workspace ingestion binds to by policy (WS-8); default the canonical personal-business id. */
  readonly ingestWorkspaceId?: string;
  /** The local Temporal dev-server address; default 127.0.0.1:7233. */
  readonly temporalAddress?: string;
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
let serveSupervisor: gbrainServe.GbrainServeSupervisor | undefined;

async function start(config: WorkerHostConfig): Promise<void> {
  if (starting || booted !== undefined) return; // config is one-shot; ignore repeats
  starting = true;
  try {
    // Option A: start the managed `gbrain serve --http` BEFORE bootWorker so its ready URL feeds BOTH http
    // transports. On success, point retrieval + the agentic tools at it (copilotGbrainHttpUrl + transport
    // "http"); on failure the supervisor fails closed → we omit those fields → retrieval stays on the CLI and
    // the agentic tools fail closed (graceful degradation — no throw, boot still succeeds).
    let gbrainHttpConfig: { readonly copilotGbrainHttpUrl: string; readonly copilotGbrainTransport: "http" } | undefined;
    if (MANAGE_GBRAIN_SERVE) {
      serveSupervisor = gbrainServe.createGbrainServeSupervisor({
        baseUrl: GBRAIN_SERVE_BASE_URL,
        spawn: gbrainServe.createGbrainServeSpawner(),
        probe: gbrainServe.createGbrainServeProbe(),
        sleep: gbrainServe.realSleep,
        readinessTimeoutMs: GBRAIN_SERVE_READINESS_TIMEOUT_MS,
      });
      const serveStarted = await serveSupervisor.start();
      if (isOk(serveStarted)) {
        gbrainHttpConfig = { copilotGbrainHttpUrl: GBRAIN_SERVE_BASE_URL, copilotGbrainTransport: "http" };
      }
      // else: supervisor already disposed itself on the failed start; leave gbrainHttpConfig undefined.
    }
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
      // §13.10 gate (a) — WS-8 per-workspace scoping of the served brain, LIVE + MULTI-SERVED (Option A). With
      // the multi-served retrieval landed, this flag now makes EACH registered workspace read the ONE combined
      // brain scoped PER-REQUEST to its own slug prefix — so asking personal-life/employer-work reads the brain
      // filtered to that workspace (empty today, since only personal-business holds content), not the empty
      // fixture. Foreign + legacy-denied hits are dropped before synthesis. Posture (owner-chosen): {assign,
      // personal-business} — legacy/unprefixed content is served ONLY to the served personal-business workspace,
      // never crossing to another (decideHitScope enforces this per ask). WS-8 now holds by SCOPE FILTERING (not
      // by construction), so the F2 field-fidelity + A1 body-embedded residuals are REACHABLE for any workspace
      // that holds real content in the combined brain — INERT today (only personal-business has content).
      // ⚠ Operator guards while this is on:
      //   (1) do NOT save non-personal-business content UNPREFIXED (the {assign} bridge is sound only while the
      //       brain holds a single workspace's unprefixed content — save employer-work/personal-life PREFIXED).
      //   (2) OWNER ACCEPTED employer-work in the combined brain (2026-07-06, "separate brains later"). F2
      //       structural field-fidelity is CLOSED (`allowItemFields`), so cross-workspace SURFACING is scoped
      //       out per ask. Accepted residuals of ONE shared brain: A1 (a page whose BODY verbatim quotes another
      //       workspace surfaces that text under its own workspace's ask) — and because employer-work egresses to
      //       the Claude cloud WITH a notice (cloudCopilotPosture), A1 employer text embedded in a PERSONAL page
      //       egresses under a PERSONAL ask WITHOUT the employer notice. Option B (per-workspace brains) removes
      //       both, deferred per owner. See docs/planning/ws8-workspace-scoping.md.
      // To turn OFF (back to single-served, only personal-business reads the brain), remove these two lines.
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
      // §13.10d GO-LIVE (owner-authorized 2026-07-12, via the lead's AskUserQuestion) — activate the two BUILT +
      // dual-reviewed read-only Copilot skills on the LIVE cloud Sonnet-5 agent:
      //   • copilotVaultRead — the agent may read ONE canonical-Markdown note BY PATH, scoped PER-ASK to the
      //     SERVED workspace: the handler realpath-resolves the path, RE-ATTRIBUTES its owning workspace, and
      //     DENIES any cross-workspace target (WS-8) + is realpath-confined to `vaultRoot` + READ-ONLY (one
      //     `read` tool; no write/mutating op exists). NOTE (multi-served runtime, `copilotWorkspaceScoping`):
      //     on an employer-work-served ask this reads EMPLOYER-WORK notes into the cloud model — the SAME
      //     employer-work→cloud-with-notice egress posture already LIVE + owner-accepted for gbrain retrieval
      //     (2026-07-06); vault.read adds no new egress class, only a per-note read within that scoped path.
      //   • copilotSkillIntrospection — the agent may enumerate its OWN read-skill catalog only (STATIC,
      //     zero-leak, NEVER reveals the propose tool). Needs no vault/disk config.
      // `vaultRoot` is an OWNER RUNTIME precondition (the personal-business Obsidian vault path, injected via
      // config). Until it is set, the boot guard (`gateCopilotVaultReadDeps`) leaves vault.read UNWIRED/inert —
      // so this flip is SAFE to land before the path is provided (like MANAGE_GBRAIN_SERVE). skill-introspection
      // is LIVE-but-harmless (a STATIC read-only catalog — nothing to leak; never reveals the propose tool).
      // HARD LINE: the write/propose bridge stays OFF — `copilotProposeMode`
      // / `copilotProposeKnowledge` are deliberately NOT set here. To turn OFF, remove these two lines.
      copilotVaultRead: true,
      copilotSkillIntrospection: true,
      // Option A: when the managed serve came up, route retrieval + tools over it (http); else omitted (CLI + fail-closed).
      ...(gbrainHttpConfig ?? {}),
      // No-op dispatch stubs — a first render triggers neither path (no jobs/approvals yet).
      triageDispatch: (input) =>
        Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } }),
      dispatchApproval: () => Promise.resolve({ ok: true, value: undefined }),
      ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
      ...(config.vaultRoot !== undefined ? { vaultRoot: config.vaultRoot } : {}),
      // OPEN-THE-GATES auto-ingest (owner opt-in, default OFF): when `config.autoIngest` is ON AND a vaultRoot is
      // present, wire vaultWatch + proofSpineParams + temporalAddress → activate the built §11.8 vault→ingestion
      // loop on the local Temporal dev-server. Default (opt-in OFF or no vaultRoot) ⇒ the gate returns undefined ⇒
      // NO proofSpineParams / NO vaultWatch — EXACTLY today's degraded boot (control-plane API only; connectTemporal
      // degrades cleanly, the proof-spine pipeline stays dormant). The proof-spine params are built only when gated on.
      ...(boot.gateAutoIngest(
        {
          autoIngest: config.autoIngest,
          ingestWorkspaceId: config.ingestWorkspaceId,
          // sensitivity is not an owner env knob this slice — the gate defaults it to "normal".
          temporalAddress: config.temporalAddress,
        },
        config.vaultRoot,
        boot.buildAutoIngestProofSpineParams,
      ) ?? {}),
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
    // Boot threw AFTER the managed serve may have come up — reap it so we never orphan a gbrain serve holding
    // port 8899 + the PGlite DB lock (which would wedge a respawn/CLI into a permanently contended state). The
    // supervisor's dispose is idempotent + never-throws, so this is safe even if the serve never started.
    if (serveSupervisor !== undefined) {
      const sup = serveSupervisor;
      serveSupervisor = undefined;
      try {
        await sup.dispose();
      } catch {
        // ignore — dispose is best-effort on the error path
      }
    }
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    starting = false;
  }
}

async function shutdown(): Promise<void> {
  const b = booted;
  const sup = serveSupervisor;
  booted = undefined;
  serveSupervisor = undefined;
  try {
    if (b) await b.close();
  } finally {
    try {
      // Tear down the managed gbrain serve so it releases the port + the PGlite DB lock on worker-host exit.
      if (sup) await sup.dispose();
    } finally {
      process.exit(0);
    }
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
