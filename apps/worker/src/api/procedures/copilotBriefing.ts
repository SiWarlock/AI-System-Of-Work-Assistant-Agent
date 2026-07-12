// C6 (b)-1 §13.10 — the on-request, READ-ONLY Copilot BRIEFING skill, bound to the workspace-scoped §9.4
// Today read-model. It assembles the asking workspace's Today (recent activity + inbox) into a CANDIDATE
// context and runs it through the SAME governed synthesis core as `answerCopilotQuestion`
// (`runGovernedCopilotSynthesis`: WS-8 re-guard → authoritative posture → egress veto BEFORE synthesis →
// synthesize on the veto-CLEARED route → candidate/UI-safe gate). NO write, NO commit — the propose bridge
// is untouched (hard line). The safety machinery is single-sourced with Q&A, so it cannot drift.
import { ok, err, isOk } from "@sow/contracts";
import type {
  Approval,
  FailureVariant,
  Result,
  UiSafeCopilotAnswer,
  UiSafeIngestionItem,
  UiSafeRecentChange,
} from "@sow/contracts";
import {
  enforceRetrievalScope,
  runGovernedCopilotSynthesis,
  unknownWorkspace,
  type GovernedCopilotSynthesisDeps,
  type RetrievedContext,
  type RetrievedSource,
} from "./copilot";

/** A port result that may be delivered synchronously (a fake) or async (@sow/db-backed). */
type MaybeAsyncResult<T> = Result<T, FailureVariant> | Promise<Result<T, FailureVariant>>;

/** The on-request briefing input — ONLY the workspace. The directive is SERVER-fixed (see BRIEFING_DIRECTIVE);
 *  there is no client-settable prompt, so the injection surface is smaller than Q&A's. */
export interface CopilotBriefingInput {
  readonly workspaceId: string;
}

/** The fixed synthesis directive for a briefing — server-side, never client-settable. */
export const BRIEFING_DIRECTIVE =
  "Brief me on this workspace's current state: what's active, what changed recently, and what's awaiting me.";

/**
 * Assembles the asking workspace's §9.4 Today read-model into a candidate RetrievedContext. Unknown
 * workspace → typed err (fail closed). WS-8 by construction — reads ONLY this workspace's queries.
 */
export interface CopilotBriefingRetrievalPort {
  readonly assemble: (workspaceId: string) => MaybeAsyncResult<RetrievedContext>;
}

/** The briefing deps — the shared governed core + a Today-read-model retrieval. */
export interface CopilotBriefingDeps extends GovernedCopilotSynthesisDeps {
  readonly retrieval: CopilotBriefingRetrievalPort;
}

/**
 * The narrow slice of the §9.4 Today read-model the briefing reads. `recentChanges` + `ingestionInbox` are
 * ALREADY UiSafe (safe to summarize into blocks/citations). `approvalInbox` is RAW `Approval` at the port
 * (redaction is the procedure's job, not the port) — the adapter reads ONLY its `.length` (a this-workspace
 * COUNT), NEVER a field, so no raw approval content can enter the egressed context. (Workspace cards, also
 * raw at the port, are a DEFERRED enrichment — they'd need the UiSafe dashboard projector.)
 */
export interface BriefingTodayPort {
  readonly recentChanges: (workspaceId: string) => MaybeAsyncResult<readonly UiSafeRecentChange[]>;
  readonly ingestionInbox: (workspaceId: string) => MaybeAsyncResult<readonly UiSafeIngestionItem[]>;
  readonly approvalInbox: (workspaceId: string) => MaybeAsyncResult<readonly Approval[]>;
}

/**
 * The on-request, READ-ONLY briefing skill: assemble Today → re-guard scope (defense-in-depth) → run the
 * SAME governed core as answerCopilotQuestion. NO write, NO commit; the propose bridge is untouched.
 */
export async function answerCopilotBriefing(
  deps: CopilotBriefingDeps,
  input: CopilotBriefingInput,
): Promise<Result<UiSafeCopilotAnswer, FailureVariant>> {
  const assembled = await deps.retrieval.assemble(input.workspaceId);
  if (!isOk(assembled)) return assembled; // unknown workspace / retrieval failure → fail closed (WS-8)
  const scoped = enforceRetrievalScope(input.workspaceId, assembled.value);
  if (!isOk(scoped)) return scoped; // defense-in-depth — a foreign-scoped context is rejected
  return runGovernedCopilotSynthesis(deps, input.workspaceId, BRIEFING_DIRECTIVE, scoped.value);
}

/** Interim fixture-backed briefing retrieval (tests + honest boot interim). Mirrors createFixtureRetrieval. */
export function createFixtureBriefingRetrieval(
  fixtures: Readonly<Record<string, RetrievedContext>>,
): CopilotBriefingRetrievalPort {
  return {
    assemble: (workspaceId) => {
      // Own-property check (never an inherited '__proto__' etc.) → unknown key fails closed.
      if (!Object.hasOwn(fixtures, workspaceId)) return err(unknownWorkspace());
      const context = fixtures[workspaceId];
      if (context === undefined) return err(unknownWorkspace());
      // Re-guard by construction so a mis-keyed fixture can never leak a foreign scope.
      return enforceRetrievalScope(workspaceId, context);
    },
  };
}

/**
 * The real read-model-backed briefing retrieval. Reads the workspace-scoped §9.4 Today read-model and
 * assembles a RetrievedContext from ONLY already-UiSafe items (recentChanges + ingestion summaries) + an
 * approval/ingestion COUNT — NO raw Approval/card field ever enters `blocks`. Fails closed on an unknown
 * workspace (the recentChanges query errs). WS-8 by construction — every read is this workspace's.
 */
export function createReadModelBriefingRetrieval(port: BriefingTodayPort): CopilotBriefingRetrievalPort {
  return {
    assemble: async (workspaceId) => {
      const recent = await port.recentChanges(workspaceId);
      if (!isOk(recent)) return recent; // unknown workspace → fail closed
      const ingestion = await port.ingestionInbox(workspaceId);
      if (!isOk(ingestion)) return ingestion;
      const approvals = await port.approvalInbox(workspaceId);
      if (!isOk(approvals)) return approvals;

      const blocks: string[] = [];
      const sources: RetrievedSource[] = [];
      for (const rc of recent.value) {
        blocks.push(rc.summary);
        sources.push({ citationId: rc.changeId, title: rc.summary });
      }
      for (const item of ingestion.value) {
        blocks.push(item.summary);
        sources.push({ citationId: item.sourceId, title: item.summary });
      }
      // Approvals + ingestion COUNTS ONLY — read `.length`, NEVER a field (no raw content into the context).
      blocks.push(`${approvals.value.length} approval(s) awaiting review.`);
      blocks.push(`${ingestion.value.length} item(s) awaiting triage.`);

      return ok({ workspaceId, blocks, sources });
    },
  };
}
