// spec(§12) — AUTH §12 named suite (Task 8.7). System-under-test = the REAL 8.1
// worker auth modules: the composed interceptor (`makeAuthInterceptor`), the tRPC
// command/query boundary (`authedResolver` over `ctx.auth`, exercised through the
// real 8.4 command router + the health seam), the WS stream handshake
// (`runStreamHandshake`), and the loopback-bind invariant (`assertLoopbackBind`).
//
// The gate this suite certifies (DoD for phase-exit 8):
//   For BOTH the tRPC command/query boundary AND the WS stream handshake, each of
//     · no-token
//     · wrong-token (equal-length ⇒ the constant-time compare path)
//     · valid-token + wrong-Origin
//     · valid-token + wrong-Host (DNS-rebind)
//   is REJECTED as a typed err BEFORE any handler/subscription runs — proven by
//   asserting the injected command port is NEVER touched on rejection, and the
//   stream generator yields NOTHING. Plus: loopback-only bind (REQ-NF-004) —
//   every non-loopback bind address is refused; loopback is admitted.
//
// DETERMINISTIC + PURE over the injected SUT: tokens are minted with a FIXED rng
// so the equal-length wrong-token case deterministically drives the constant-time
// branch. §16: the runner never throws — a case that would throw folds to a fail.
import { isErr, isOk, type Result, type FailureVariant } from "@sow/contracts";
import type { Approval, ApprovalStatus } from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import type { ApprovalTransitionOutcome, DbError } from "@sow/db";
import { makeAuthInterceptor, type AuthInterceptor } from "@sow/worker/api/auth/interceptor";
import { assertLoopbackBind } from "@sow/worker/api/auth/loopbackBind";
import type { WorkerOriginAllowlist } from "@sow/worker/api/auth/originAllowlist";
import { createApiServer } from "@sow/worker/api/server";
import {
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
} from "@sow/worker/api/procedures/copilot";
import { createFixtureBriefingRetrieval } from "@sow/worker/api/procedures/copilotBriefing";
import { runStreamHandshake } from "@sow/worker/api/stream/handshake";
import { createPushStream } from "@sow/worker/api/stream/pushStream";
import { createCallerFactory, router, type ApiContext } from "@sow/worker/api/trpc";
import {
  buildCommandRouter,
  type ApprovalCommandPort,
  type CommandDeps,
} from "@sow/worker/api/procedures/commands";
import { baseApproval, baseWorkflowRunRef } from "./fixtures";
import { expectCase, foldSuite, type SuiteCase, type SuiteResult } from "./suite-core";

export const AUTH_SUITE_NAME = "worker-api-auth.auth";

// ── Fixed-rng session tokens (deterministic; equal-length wrong-token) ───────
function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
/** A DIFFERENT but EQUAL-LENGTH token — exercises the constant-time compare, not a length short-circuit. */
const WRONG: SessionToken = mintSessionToken(fixedRng(0xcd));

const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173"],
  hosts: ["localhost:5173"],
};
const GOOD_ORIGIN = "http://localhost:5173";
const GOOD_HOST = "localhost:5173";

const INTERCEPTOR: AuthInterceptor = makeAuthInterceptor({
  expectedToken: EXPECTED,
  allowlist: ALLOWLIST,
});

// The MOUNT wave extended `createApiServer`'s deps with the query/command/
// systemHealth router ports. The AUTH suite exercises ONLY the `health.ping` seam
// (the same authedResolver gate) — so the router ports are empty no-op fakes: the
// full surface is COMPOSED (proving the gate is uniform across it), but no query/
// command handler is reached on any reject vector (the gate fails first). Each fake
// is §16-safe (a typed err / a benign empty) if a resolver ever did reach it.
const emptyErr = {
  ok: false as const,
  error: { kind: "validation_rejected" as const, message: "unwired-in-suite", retryable: false },
};
function serverDeps() {
  return {
    expectedToken: EXPECTED,
    allowlist: ALLOWLIST,
    readModel: {
      dashboardCards: () => emptyErr,
      workspaceCards: () => emptyErr,
      projectCards: () => emptyErr,
      ingestionInbox: () => emptyErr,
      approvalInbox: () => emptyErr,
      copilotSurface: () => emptyErr,
      globalSurface: () => emptyErr,
      recentChanges: () => emptyErr,
      projectDashboards: () => emptyErr,
    },
    // Copilot ask backend — never exercised by these AUTH-boundary vectors; empty fixtures suffice.
    copilot: {
      retrieval: createFixtureRetrieval({}),
      synthesis: createStubSynthesis(),
      workspacePosture: createLocalWorkspacePosture({}),
      routeSelector: createLocalRouteSelector(),
    },
    // Copilot briefing backend — likewise never exercised here; empty fixtures suffice.
    briefing: {
      retrieval: createFixtureBriefingRetrieval({}),
      synthesis: createStubSynthesis(),
      workspacePosture: createLocalWorkspacePosture({}),
      routeSelector: createLocalRouteSelector(),
    },
    systemHealth: {
      healthItems: () => emptyErr,
      egressStatus: () => emptyErr,
    },
    approvals: makeTripwirePort(),
    dispatchApproval: async () => ({ ok: true as const, value: undefined }),
    triage: {
      async reenterIngestion(input: { idempotencyKey: string }) {
        return { ok: true as const, value: { idempotencyKey: input.idempotencyKey } };
      },
    },
    // 14.1 onboarding port — a canned-ok stub (this auth suite exercises the auth boundary, not onboarding).
    onboarding: {
      async provisionWorkspace(spec: { id: string; preset: string }) {
        return { ok: true as const, value: { id: spec.id, registryMember: true as const, preset: spec.preset } };
      },
    },
    // 14.6 project-registry port — a canned-ok stub (not exercised by this auth suite).
    projectRegistry: {
      async createProject(input: { projectId: string }) {
        return {
          ok: true as const,
          value: {
            projectId: input.projectId,
            workspaceId: "eval-ws" as never,
            progressProviders: [],
            title: "",
            slug: "",
            lifecycleState: "active" as const,
          },
        };
      },
    },
    now: () => "2026-07-02T00:00:00.000Z",
  };
}

// ── A command port that RECORDS whether it was ever touched ──────────────────
// The exactly-once gate is proven elsewhere; here the port is a TRIP-WIRE: on a
// rejected auth the command handler must NOT run, so `get`/`applyTransition` must
// NOT be called. Any call flips `touched` — a rejected-but-touched case FAILS.
interface TripwirePort extends ApprovalCommandPort {
  touched: boolean;
}
function makeTripwirePort(): TripwirePort {
  const port: TripwirePort = {
    touched: false,
    async get(id: Approval["id"]): Promise<Result<Approval, DbError>> {
      port.touched = true;
      return { ok: true, value: baseApproval({ id }) };
    },
    async applyTransition(
      _id: Approval["id"],
      _expectedFrom: ApprovalStatus,
      next: Approval,
    ): Promise<Result<ApprovalTransitionOutcome, DbError>> {
      port.touched = true;
      return { ok: true, value: { approval: next, applied: true } };
    },
  };
  return port;
}

/** Build a loopback caller over the REAL 8.4 command router (the command boundary). */
function makeCommandCaller(req: { token?: string; origin?: string; host?: string }, port: TripwirePort) {
  const deps: CommandDeps = {
    approvals: port,
    dispatchApproval: async () => ({ ok: true, value: undefined }),
    triage: {
      async reenterIngestion(input: { idempotencyKey: string }) {
        return { ok: true as const, value: { idempotencyKey: input.idempotencyKey } };
      },
    },
    now: () => "2026-07-02T00:00:00.000Z",
  };
  const appRouter = router({ command: buildCommandRouter(deps) });
  const factory = createCallerFactory(appRouter);
  const ctx: ApiContext = {
    auth: INTERCEPTOR({ token: req.token, origin: req.origin, host: req.host }),
  };
  return factory(ctx);
}

// The four rejection vectors, each named for its case id.
interface Vector {
  readonly id: string;
  readonly token: string | undefined;
  readonly origin: string | undefined;
  readonly host: string | undefined;
}
const REJECT_VECTORS: readonly Vector[] = [
  { id: "no-token", token: undefined, origin: GOOD_ORIGIN, host: GOOD_HOST },
  { id: "wrong-token", token: WRONG.value, origin: GOOD_ORIGIN, host: GOOD_HOST },
  { id: "wrong-origin", token: EXPECTED.value, origin: "http://evil.com", host: GOOD_HOST },
  // valid token + wrong Host = the DNS-rebind vector (Origin on-list, Host off-list).
  { id: "wrong-host", token: EXPECTED.value, origin: GOOD_ORIGIN, host: "evil.com" },
];

const NON_LOOPBACK_BINDS: readonly string[] = [
  "0.0.0.0", // all-interfaces IPv4 — remotely reachable
  "::", // all-interfaces IPv6
  "192.168.1.10", // LAN
  "10.0.0.5", // private
  "203.0.113.7", // public
  "example.com", // hostname (not provably loopback)
  "127.0.0.1.evil.com", // loopback-suffix spoof
  "", // empty — fail-closed
];

/**
 * Run the AUTH §12 suite against the REAL worker auth modules. Returns a folded
 * {@link SuiteResult}. Deterministic; never throws (§16 — a throwing case folds
 * to a fail).
 */
export async function runAuthSuite(): Promise<SuiteResult> {
  const cases: SuiteCase[] = [];

  // ── (1) tRPC command/query boundary — every reject vector fails PRE-handler ──
  for (const v of REJECT_VECTORS) {
    // (a) the query boundary (health seam — the same authedResolver gate).
    try {
      const server = createApiServer(serverDeps());
      const r = await server
        .createCaller({ token: v.token, origin: v.origin, host: v.host })
        .health.ping();
      const rejected = isErr(r);
      cases.push(
        expectCase(
          `auth.query.${v.id}`,
          rejected,
          rejected ? "" : "query boundary admitted a rejected auth vector",
        ),
      );
    } catch {
      cases.push(expectCase(`auth.query.${v.id}`, false, "query boundary threw across the §16 boundary"));
    }

    // (b) the command boundary (real 8.4 command router) — rejected AND the
    //     injected port is NEVER touched (the handler never ran pre-auth).
    try {
      const port = makeTripwirePort();
      const caller = makeCommandCaller({ token: v.token, origin: v.origin, host: v.host }, port);
      const r = (await caller.command.decideApproval({
        approvalId: "apr_1",
        decision: "approve",
        channel: "mac",
      })) as Result<unknown, FailureVariant>;
      const rejected = isErr(r);
      const untouched = port.touched === false;
      cases.push(
        expectCase(
          `auth.command.${v.id}`,
          rejected && untouched,
          !rejected
            ? "command boundary admitted a rejected auth vector"
            : "command handler ran BEFORE auth (port was touched on a rejected vector)",
        ),
      );
    } catch {
      cases.push(
        expectCase(`auth.command.${v.id}`, false, "command boundary threw across the §16 boundary"),
      );
    }
  }

  // A positive control: a fully-valid caller IS admitted at both boundaries — so a
  // suite that rejects everything (a broken interceptor) cannot pass by accident.
  try {
    const server = createApiServer(serverDeps());
    const ok = await server
      .createCaller({ token: EXPECTED.value, origin: GOOD_ORIGIN, host: GOOD_HOST })
      .health.ping();
    cases.push(
      expectCase("auth.query.valid-admitted", isOk(ok), "valid caller was NOT admitted at the query boundary"),
    );
  } catch {
    cases.push(expectCase("auth.query.valid-admitted", false, "valid query caller threw"));
  }

  // ── (2) WS stream handshake — every reject vector fails PRE-subscription ──────
  for (const v of REJECT_VECTORS) {
    // (a) the handshake itself returns a typed err.
    const connectionParams = v.token === undefined ? null : { token: v.token };
    const hs = runStreamHandshake(INTERCEPTOR, {
      connectionParams,
      origin: v.origin,
      host: v.host,
    });
    cases.push(
      expectCase(
        `auth.stream.handshake.${v.id}`,
        isErr(hs),
        "stream handshake admitted a rejected auth vector",
      ),
    );

    // (b) the subscription generator, given that failed handshake outcome, yields
    //     NOTHING — no event ever flows to an unauthenticated / off-origin consumer.
    try {
      const ps = createPushStream({ interceptor: INTERCEPTOR });
      // Feed an event so a leak WOULD be observable if the gate failed open.
      ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
      const seen: unknown[] = [];
      for await (const item of ps.subscribe(hs, { lastEventId: undefined })) {
        seen.push(item);
      }
      cases.push(
        expectCase(
          `auth.stream.subscribe.${v.id}`,
          seen.length === 0,
          "stream flowed events to a rejected-auth consumer",
        ),
      );
    } catch {
      cases.push(
        expectCase(`auth.stream.subscribe.${v.id}`, false, "stream subscribe threw across the §16 boundary"),
      );
    }
  }

  // A positive control: a valid handshake IS admitted and DOES flow events.
  {
    const ps = createPushStream({ interceptor: INTERCEPTOR });
    ps.publisher.publishWorkflowStatus(baseWorkflowRunRef());
    const authed = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: GOOD_ORIGIN,
      host: GOOD_HOST,
    });
    const seen: unknown[] = [];
    for await (const item of ps.subscribe(authed, { lastEventId: undefined })) {
      seen.push(item);
    }
    cases.push(
      expectCase(
        "auth.stream.valid-admitted",
        isOk(authed) && seen.length === 1,
        "valid handshake did NOT admit / flow the event",
      ),
    );
  }

  // ── (3) loopback-only bind (REQ-NF-004) ──────────────────────────────────────
  for (const addr of NON_LOOPBACK_BINDS) {
    const r = assertLoopbackBind(addr);
    cases.push(
      expectCase(
        `auth.bind.refuse.${addr === "" ? "empty" : addr}`,
        isErr(r),
        "non-loopback bind was NOT refused (REQ-NF-004)",
      ),
    );
  }
  for (const addr of ["127.0.0.1", "::1", "localhost"]) {
    const r = assertLoopbackBind(addr);
    cases.push(
      expectCase(`auth.bind.admit.${addr}`, isOk(r), "loopback bind was refused"),
    );
  }

  return foldSuite(AUTH_SUITE_NAME, cases);
}
