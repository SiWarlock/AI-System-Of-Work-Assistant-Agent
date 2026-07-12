// C6 (b)-2 §13.10 — the on-request, READ-ONLY Copilot CONCEPT-synthesis skill. Given a concept term it
// retrieves the asking workspace's KNOWLEDGE for the term and synthesizes a governed explanation through the
// SAME single-sourced governed core as answerCopilotQuestion / answerCopilotBriefing
// (`runGovernedCopilotSynthesis`: WS-8 re-guard → authoritative posture → egress veto BEFORE synthesis →
// synthesize on the veto-CLEARED route → candidate/UI-safe gate). NO write, NO commit — the propose bridge is
// untouched (hard line). The concept term is CLIENT input, so the injection surface equals Q&A's — bounded at
// `parseConceptInput` (queries.ts) and governed by the egress veto + candidate gate.
import { isOk } from "@sow/contracts";
import type { FailureVariant, Result, UiSafeCopilotAnswer } from "@sow/contracts";
import { enforceRetrievalScope, runGovernedCopilotSynthesis, type CopilotDeps } from "./copilot";

/** The on-request concept-synthesis input — the workspace + the (bounded) client concept term. */
export interface CopilotConceptInput {
  readonly workspaceId: string;
  readonly concept: string;
}

/** The server-fixed concept-synthesis framing. The (bounded) client concept term is folded in by
 *  `conceptDirective` — the server owns the instruction; the client owns only the term. */
export const CONCEPT_DIRECTIVE =
  "Explain this concept drawing ONLY on this workspace's knowledge, and cite what you use:";

/** Build the synthesis directive for a concept term — the server-fixed framing + the (bounded) client term. */
export function conceptDirective(concept: string): string {
  return `${CONCEPT_DIRECTIVE} "${concept}"`;
}

/**
 * The on-request, READ-ONLY concept-synthesis skill: retrieve the workspace's KNOWLEDGE for the concept term →
 * re-guard scope (defense-in-depth) → run the SAME governed core as answerCopilotQuestion. The concept term is
 * BOTH the retrieval query AND folded into the server-fixed CONCEPT_DIRECTIVE handed to synthesis. Reuses
 * `CopilotDeps` (= governed core + knowledge retrieval) verbatim — no new deps. NO write; propose bridge OFF.
 */
export async function answerCopilotConcept(
  deps: CopilotDeps,
  input: CopilotConceptInput,
): Promise<Result<UiSafeCopilotAnswer, FailureVariant>> {
  const retrieved = await deps.retrieval.retrieve(input.workspaceId, input.concept);
  if (!isOk(retrieved)) return retrieved; // unknown workspace / retrieval failure → fail closed (WS-8)
  const scoped = enforceRetrievalScope(input.workspaceId, retrieved.value);
  if (!isOk(scoped)) return scoped; // defense-in-depth — a foreign-scoped context is rejected
  return runGovernedCopilotSynthesis(deps, input.workspaceId, conceptDirective(input.concept), scoped.value);
}
