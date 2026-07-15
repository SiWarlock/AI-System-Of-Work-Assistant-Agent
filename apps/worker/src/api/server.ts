// Task 8.2 (c) — `createApiServer(deps)`: assemble the root appRouter over a
// loopback caller, BEHIND the 8.1 auth interceptor.
//
// `createApiServer` is the composition seam the integrator (worker bootstrap)
// mounts. It:
//   1. builds the single composed 8.1 auth interceptor from `deps`
//      (expectedToken + Origin/Host allowlist) — the worker VERIFIES, never mints;
//   2. composes the root `appRouter` from the procedure-module routers (for now
//      the always-present `health` seam; 8.3's query router + 8.4's command router
//      mount here — the SEAM is `mountRouters` below);
//   3. exposes `createCaller(req)` — a loopback caller that runs the interceptor
//      in the CONTEXT FACTORY (before any resolver) and stores its typed outcome
//      on `ApiContext.auth`. No secret rides the context; an auth failure is a
//      typed `err(FailureVariant)` surfaced as resolver DATA, never a throw.
//
// `AppRouter = typeof appRouter` is exported for the renderer's typed client
// (Phase 9). This module owns the httpBatchLink-compatible loopback handler seam;
// the actual socket bind (loopback-only, REQ-NF-004) is asserted by the transport
// at startup via `assertLoopbackBind` — NOT here (that is a per-bind, not per-call,
// invariant), so it is imported/re-exported for the integrator, not folded in.
import { createCallerFactory, router, type ApiContext } from "./trpc";
import { healthRouter } from "./router";
import {
  makeAuthInterceptor,
  type AuthInterceptor,
  type AuthInterceptorInput,
} from "./auth/interceptor";
import type { SessionToken } from "@sow/policy";
import type { WorkerOriginAllowlist } from "./auth/originAllowlist";
import { buildQueryRouter, type ReadModelQueryPort } from "./procedures/queries";
import type { CopilotDeps } from "./procedures/copilot";
import type { CopilotBriefingDeps } from "./procedures/copilotBriefing";
import {
  buildCommandRouter,
  type ApprovalCommandPort,
  type TriagePort,
  type DispatchApprovalFn,
  type NowFn,
} from "./procedures/commands";
import {
  buildSystemHealthRouter,
  type SystemHealthQueryPort,
} from "./procedures/systemHealth";
import {
  buildOnboardingRouter,
  type OnboardingCommandPort,
} from "./procedures/onboarding";
import {
  buildProjectRegistryRouter,
  type ProjectRegistryCommandPort,
} from "./procedures/projectRegistry";
import {
  buildConnectorConfigRouter,
  type ConnectorConfigCommandPort,
} from "./procedures/connectorConfig";
import { createPushStream, type PushStream } from "./stream/pushStream";
import type { StreamPublisherOptions } from "./stream/eventClasses";

/**
 * Dependencies for {@link createApiServer}. `expectedToken` is the current-launch
 * token (minted by Electron main, INJECTED here — never minted in the worker);
 * `allowlist` is the strict Origin/Host anti-rebind allowlist. NO secret is
 * stored on the returned server beyond the interceptor's closure.
 *
 * The MOUNT wave extends this with the query/command/systemHealth router deps +
 * the push-stream publisher options, so `createApiServer` composes the FULL local
 * control-plane surface (not just the always-present `health` seam):
 *   - `readModel`   — the read-model query port (fake in tests, `createDbReadModelQueryPort` at boot);
 *   - `systemHealth`— the System-Health query port (OBS-2 items + egress status);
 *   - `approvals` + `dispatchApproval` + `now` — the exactly-once approval command surface;
 *   - `triage`     — the ingestion re-entry command port;
 *   - `streamPublisherOptions?` — bounded replay window for the push stream (optional).
 */
export interface ApiServerDeps {
  readonly expectedToken: SessionToken;
  readonly allowlist: WorkerOriginAllowlist;
  readonly readModel: ReadModelQueryPort;
  /** The Copilot ask backend (retrieval + synthesis) for `query.copilotAsk` (§4.6). */
  readonly copilot: CopilotDeps;
  /** The Copilot briefing backend (§9.4 Today retrieval + shared governed core) for `query.copilotBriefing` (C6 §13.10 b-1). */
  readonly briefing: CopilotBriefingDeps;
  readonly systemHealth: SystemHealthQueryPort;
  readonly approvals: ApprovalCommandPort;
  readonly dispatchApproval: DispatchApprovalFn;
  readonly triage: TriagePort;
  readonly now: NowFn;
  /** The onboarding provisioning port (14.1) — mints a workspace (config upsert + WS-8 registry union). */
  readonly onboarding: OnboardingCommandPort;
  /** The project-registry creation port (14.6) — mints a durable typed-Project entry (rule-1: registry row only). */
  readonly projectRegistry: ProjectRegistryCommandPort;
  /** The connector-config port (14.2) — register/enable/pause/set-cadence (config only; tokenRef reference-only, rule 7). */
  readonly connectorConfig: ConnectorConfigCommandPort;
  readonly streamPublisherOptions?: StreamPublisherOptions;
}

/**
 * Compose the root `appRouter` from the procedure-module routers, mounting the
 * MOUNT-wave seam (`query` / `command` / `systemHealth`) alongside the always-
 * present `health` router. The type is left to inference so each sub-router keeps
 * its full procedure map; `AppRouter = typeof appRouter` (below) tracks the full
 * surface for the renderer's typed client.
 *
 * The push-stream `onEvent` subscription lives on its OWN router (built from the
 * publisher), mounted here under `stream` so the WS transport and the loopback
 * caller share ONE composed router — mirroring how `pushStream.ts` documents the
 * integrator deriving `AppRouter` from `typeof` the composed router.
 */
function composeAppRouter(deps: ApiServerDeps, pushStream: PushStream) {
  return router({
    health: healthRouter,
    query: buildQueryRouter({ readModel: deps.readModel, copilot: deps.copilot, briefing: deps.briefing }),
    command: buildCommandRouter({
      approvals: deps.approvals,
      dispatchApproval: deps.dispatchApproval,
      triage: deps.triage,
      now: deps.now,
    }),
    systemHealth: buildSystemHealthRouter({ systemHealth: deps.systemHealth }),
    onboarding: buildOnboardingRouter({ onboarding: deps.onboarding }),
    projectRegistry: buildProjectRegistryRouter({ projectRegistry: deps.projectRegistry }),
    connectorConfig: buildConnectorConfigRouter({ connectorConfig: deps.connectorConfig }),
    stream: pushStream.router,
  });
}

/**
 * The FULL composed root router type (health + query + command + systemHealth +
 * stream). Derived from a representative `composeAppRouter` instantiation so the
 * renderer's typed client sees every mounted procedure. The runtime value is built
 * per-server in {@link createApiServer} (it closes over the injected ports); this
 * type is the static shape they all share.
 */
export type AppRouter = ReturnType<typeof composeAppRouter>;

// The loopback caller shape for {@link AppRouter}. A `BuiltRouter` carries its OWN
// caller factory as `.createCaller` (`RouterCaller<TRoot, TRecord>`), so the fully
// decorated loopback caller is simply its ReturnType — no `createCallerFactory`
// generic re-application (which would raise the TS2344 on a `BuiltRouter`). The
// runtime `createCallerFactory(appRouter)` below produces exactly this type.
/** The loopback caller shape for {@link AppRouter} (`.health.ping`, `.query.*`, `.command.*`, …). */
export type ApiCaller = ReturnType<AppRouter["createCaller"]>;

/**
 * The assembled server. `appRouter` is the composed root router; `createCaller`
 * is a loopback caller that runs the auth interceptor in the context factory
 * (BEFORE any resolver) from the raw request inputs, then invokes the router.
 * `interceptor` + `pushStream` are exposed so the REAL transport (`api/mount.ts`)
 * reuses the SAME composed interceptor for its HTTP/WS context factories and feeds
 * the SAME publisher the `stream` router subscribes over.
 */
export interface ApiServer {
  readonly appRouter: AppRouter;
  /**
   * Build a loopback caller for ONE request. `req` is the raw transport tuple the
   * 8.1 interceptor consumes (presented token + Origin + Host). The interceptor
   * runs HERE, before any resolver; its typed outcome is stored on the context.
   */
  readonly createCaller: (req: AuthInterceptorInput) => ApiCaller;
  /** The composed 8.1 auth interceptor (the transport reuses THIS, never re-builds it). */
  readonly interceptor: AuthInterceptor;
  /** The push stream whose `onEvent` router is mounted at `stream`; the worker feeds `publisher`. */
  readonly pushStream: PushStream;
}

/**
 * Build the worker API server. Assembles the FULL root `appRouter` (health + query
 * + command + systemHealth + stream) and returns a `createCaller` that admits a
 * request only after the 8.1 interceptor passes — on failure the resolver sees a
 * typed `err(FailureVariant)` on `ctx.auth` and returns it as data (never throws,
 * §16). The renderer imports {@link AppRouter} for its typed client; `api/mount.ts`
 * imports `interceptor` + `pushStream` to wire the real loopback transport.
 */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  const interceptor: AuthInterceptor = makeAuthInterceptor({
    expectedToken: deps.expectedToken,
    allowlist: deps.allowlist,
  });

  // The push stream carries the single `onEvent` subscription procedure; the worker
  // feeds its `publisher` from workflow/approval/health/read-model changes. Built
  // with the composed interceptor so the WS handshake runs the SAME auth gate.
  const pushStream = createPushStream({
    interceptor,
    ...(deps.streamPublisherOptions !== undefined
      ? { publisherOptions: deps.streamPublisherOptions }
      : {}),
  });

  const appRouter = composeAppRouter(deps, pushStream);
  // Build the caller factory from the router VALUE — `createCallerFactory` infers
  // its `TRecord` from the argument (the pattern the loopback caller needs to keep
  // the full decorated procedure map). No generic type-arg (that would re-bind the
  // ROOT, not the record) — see the `ApiCaller` derivation above.
  const appCallerFactory = createCallerFactory(appRouter);

  const createCaller = (req: AuthInterceptorInput): ApiCaller => {
    // Run the interceptor in the CONTEXT FACTORY — before any resolver. The
    // context carries ONLY the typed outcome (secret-free): ok(AuthedContext) or
    // err(FailureVariant). httpBatchLink-compatible: the same `req` tuple is what
    // an HTTP transport would extract from headers.
    const context: ApiContext = { auth: interceptor(req) };
    return appCallerFactory(context);
  };

  return { appRouter, createCaller, interceptor, pushStream };
}
