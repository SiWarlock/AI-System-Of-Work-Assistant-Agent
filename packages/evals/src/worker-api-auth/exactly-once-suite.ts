// spec(§12) — APPROVAL EXACTLY-ONCE (cross-channel) §12 named suite (Task 8.7,
// REQ-F-012, §9). System-under-test = the REAL 8.4 command router
// (`buildCommandRouter` → `decideApproval`) driven THROUGH the tRPC command
// boundary (behind the real 8.1 auth gate), over a fake exactly-once approval CAS.
//
// The gate this suite certifies (DoD for phase-exit 8):
//   A Mac + Telegram DOUBLE-APPLY of the SAME approval decision collapses to
//   EXACTLY ONE state transition — the second (cross-channel) contender is an
//   idempotent no-op, NOT a second apply. Proven at the API boundary by asserting:
//     · exactly ONE call returns `applied: true` (the genuine transition);
//     · the other returns `applied: false` (the idempotent no-op contender);
//     · the downstream dispatch side effect fires EXACTLY ONCE (only the genuine
//       transitioner dispatches — the one-writer / Tool-Gateway rule, §7/§8);
//     · the store's DURABLE write happens exactly once (one CAS moved the record).
//
// The fake `ApprovalCommandPort` models the CAS the real `packages/db`
// `ApprovalRepository` implements: the FIRST transition into a target status from
// the expected `pending` applies; any LATER call whose desired end-state ALREADY
// holds resolves to `applied: false` (a replay OR a concurrent second-channel
// contender). This is the exact contract `ApprovalTransitionOutcome` documents.
//
// DETERMINISTIC + PURE over the injected SUT. §16: never throws — a throwing case
// folds to a fail.
import { isOk, type Result } from "@sow/contracts";
import type { Approval, ApprovalStatus, Channel } from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import type { ApprovalTransitionOutcome, DbError } from "@sow/db";
import { makeAuthInterceptor, type AuthInterceptor } from "@sow/worker/api/auth/interceptor";
import type { WorkerOriginAllowlist } from "@sow/worker/api/auth/originAllowlist";
import { createCallerFactory, router, type ApiContext } from "@sow/worker/api/trpc";
import {
  buildCommandRouter,
  type ApprovalCommandPort,
  type UiSafeApprovalDecisionResult,
  type CommandDeps,
} from "@sow/worker/api/procedures/commands";
import { baseApproval } from "./fixtures";
import { expectCase, foldSuite, type SuiteCase, type SuiteResult } from "./suite-core";

export const EXACTLY_ONCE_SUITE_NAME = "worker-api-auth.approval-exactly-once";

function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173"],
  hosts: ["localhost:5173"],
};
const INTERCEPTOR: AuthInterceptor = makeAuthInterceptor({
  expectedToken: EXPECTED,
  allowlist: ALLOWLIST,
});

/** Records what the exactly-once CAS actually did across all contenders. */
interface CasLedger {
  /** Count of genuine durable transitions (the exactly-once invariant = 1). */
  appliedCount: number;
  /** Count of dispatch side effects fired (exactly-once = 1). */
  dispatchCount: number;
  /** The record's terminal status after all contenders resolved. */
  terminalStatus: ApprovalStatus;
}

/**
 * Build a fake exactly-once approval CAS + the command deps. The fake holds a
 * SINGLE authoritative record; `applyTransition` moves it exactly once (from the
 * expected `pending`) and thereafter — when the desired end-state already holds —
 * returns `applied: false` (the idempotent no-op a second-channel contender / a
 * replay resolves to). This is the CAS contract the real repository guarantees.
 */
function makeExactlyOnceCas(approvalId: string): { deps: CommandDeps; ledger: CasLedger } {
  const id = approvalId as Approval["id"];
  let record: Approval = baseApproval({ id, status: "pending" });
  const ledger: CasLedger = { appliedCount: 0, dispatchCount: 0, terminalStatus: "pending" };

  const approvals: ApprovalCommandPort = {
    async get(): Promise<Result<Approval, DbError>> {
      return { ok: true, value: record };
    },
    async applyTransition(
      _id: Approval["id"],
      expectedFrom: ApprovalStatus,
      next: Approval,
    ): Promise<Result<ApprovalTransitionOutcome, DbError>> {
      // IDEMPOTENT NO-OP FIRST — the desired end-state ALREADY holds. This is what
      // a Temporal replay OR a concurrent second-channel contender resolves to: NO
      // durable write, `applied: false`. It is checked BEFORE the apply branch
      // because the command layer reads the (now-transitioned) current status just
      // before calling — so a second-channel contender arrives with
      // `expectedFrom === next.status === current.status`, and the exactly-once
      // invariant is "already in the target state" ⇒ no second apply. (This mirrors
      // the real `decideApprovalCas`: end-state match ⇒ idempotent_noop.)
      if (record.status === next.status) {
        return { ok: true, value: { approval: record, applied: false } };
      }
      // GENUINE TRANSITION — the CAS moves the record IFF it still matches the
      // pre-transition `expectedFrom`. This branch fires exactly once.
      if (record.status === expectedFrom) {
        record = next;
        ledger.appliedCount += 1;
        ledger.terminalStatus = next.status;
        return { ok: true, value: { approval: next, applied: true } };
      }
      // A different, non-target terminal state already holds ⇒ the CAS is a conflict.
      return { ok: false, error: { code: "conflict", message: "approval CAS conflict" } };
    },
  };

  const deps: CommandDeps = {
    approvals,
    dispatchApproval: async () => {
      ledger.dispatchCount += 1;
      return { ok: true, value: undefined };
    },
    triage: {
      async reenterIngestion(input: { idempotencyKey: string }) {
        return { ok: true as const, value: { idempotencyKey: input.idempotencyKey } };
      },
    },
    // 15.8 reroute-target validator — a canned ok stub (this exactly-once suite exercises the approval CAS, not reroute).
    rerouteTargets: { async validate() { return { ok: true as const, value: undefined }; } },
    now: () => "2026-07-02T00:00:00.000Z",
  };

  return { deps, ledger };
}

/** Build a valid-auth loopback caller over the REAL 8.4 command router. */
function makeAuthedCommandCaller(deps: CommandDeps) {
  const appRouter = router({ command: buildCommandRouter(deps) });
  const factory = createCallerFactory(appRouter);
  const ctx: ApiContext = {
    auth: INTERCEPTOR({
      token: EXPECTED.value,
      origin: "http://localhost:5173",
      host: "localhost:5173",
    }),
  };
  return factory(ctx);
}

/**
 * Run the APPROVAL EXACTLY-ONCE §12 suite against the REAL command router. A Mac
 * then a Telegram apply of the SAME `approve` decision must collapse to exactly
 * one transition. Returns a folded {@link SuiteResult}. Deterministic; never
 * throws (§16).
 */
export async function runExactlyOnceSuite(): Promise<SuiteResult> {
  const cases: SuiteCase[] = [];

  try {
    const { deps, ledger } = makeExactlyOnceCas("apr_xchan");
    const caller = makeAuthedCommandCaller(deps);

    // Channel 1 (Mac) applies the decision.
    const macR = (await caller.command.decideApproval({
      approvalId: "apr_xchan",
      decision: "approve",
      channel: "mac" satisfies Channel,
    })) as Result<UiSafeApprovalDecisionResult, unknown>;

    // Channel 2 (Telegram) applies the SAME decision — the cross-channel double.
    const tgR = (await caller.command.decideApproval({
      approvalId: "apr_xchan",
      decision: "approve",
      channel: "telegram" satisfies Channel,
    })) as Result<UiSafeApprovalDecisionResult, unknown>;

    const bothOk = isOk(macR) && isOk(tgR);
    cases.push(
      expectCase("xchan.both-calls-ok", bothOk, "a cross-channel apply returned an err (expected both ok)"),
    );

    if (isOk(macR) && isOk(tgR)) {
      // Exactly ONE of the two calls caused the durable transition.
      const appliedFlags = [macR.value.applied, tgR.value.applied];
      const trueCount = appliedFlags.filter((a) => a === true).length;
      const falseCount = appliedFlags.filter((a) => a === false).length;
      cases.push(
        expectCase(
          "xchan.exactly-one-applied-flag",
          trueCount === 1 && falseCount === 1,
          `expected exactly one applied:true across channels, got true=${trueCount} false=${falseCount}`,
        ),
      );
      // Both calls report the SAME final approved record (idempotent end-state).
      cases.push(
        expectCase(
          "xchan.converged-status",
          macR.value.approval.status === "approved" && tgR.value.approval.status === "approved",
          "the two channels did not converge on the approved status",
        ),
      );
    }

    // At the STORE: exactly one durable transition landed (one CAS moved the record).
    cases.push(
      expectCase(
        "xchan.one-durable-transition",
        ledger.appliedCount === 1,
        `expected exactly 1 durable CAS transition, got ${ledger.appliedCount}`,
      ),
    );
    // The downstream dispatch fired EXACTLY ONCE (only the genuine transitioner).
    cases.push(
      expectCase(
        "xchan.one-dispatch",
        ledger.dispatchCount === 1,
        `expected exactly 1 dispatch side effect, got ${ledger.dispatchCount}`,
      ),
    );
    // Terminal status is the single applied target.
    cases.push(
      expectCase(
        "xchan.terminal-approved",
        ledger.terminalStatus === "approved",
        `expected terminal status 'approved', got '${ledger.terminalStatus}'`,
      ),
    );
  } catch {
    cases.push(expectCase("xchan.threw", false, "the exactly-once path threw across the §16 boundary"));
  }

  // A third replay of the same decision is ALSO a no-op (belt-and-suspenders: the
  // dispatch never fires a second time even under repeated re-drive).
  try {
    const { deps, ledger } = makeExactlyOnceCas("apr_replay");
    const caller = makeAuthedCommandCaller(deps);
    for (const channel of ["mac", "telegram", "mac"] as const) {
      await caller.command.decideApproval({ approvalId: "apr_replay", decision: "approve", channel });
    }
    cases.push(
      expectCase(
        "xchan.replay-still-one-apply",
        ledger.appliedCount === 1 && ledger.dispatchCount === 1,
        `repeated re-drive broke exactly-once: applied=${ledger.appliedCount} dispatch=${ledger.dispatchCount}`,
      ),
    );
  } catch {
    cases.push(expectCase("xchan.replay-threw", false, "the replay path threw across the §16 boundary"));
  }

  return foldSuite(EXACTLY_ONCE_SUITE_NAME, cases);
}
