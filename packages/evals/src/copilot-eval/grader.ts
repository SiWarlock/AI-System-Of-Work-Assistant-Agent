// spec(§4.6 / PRD §20.1 / REQ-F-017) — the DETERMINISTIC Copilot answer grader.
//
// Scores a Copilot answer (the model's `{answer, citations}` output) against a labeled case's
// expectations along four axes: citation GROUNDING (no invented source), REQUIRED citations (the answer
// grounds on the sources it should), REFUSAL correctness (refuse iff the context can't answer — the
// no-inference floor), and FORBIDDEN claims (a fabricated fact the context never states). Pure + typed —
// no model call here; the real synthesis is generated elsewhere and graded through this. Test data, not
// a frozen contract.

/** The model's structured Copilot answer (the shape the JSON-schema output + the candidate both carry). */
export interface CopilotModelOutput {
  readonly answer: readonly string[];
  readonly citations: readonly { readonly citationId: string; readonly title: string }[];
}

/** The retrieved context the answer was synthesized over (the grounding set). */
export interface CopilotEvalContext {
  readonly workspaceId: string;
  readonly blocks: readonly string[];
  readonly sources: readonly { readonly citationId: string; readonly title: string }[];
}

/** What a labeled case expects of a correct answer. */
export interface CopilotExpectation {
  /** The context does NOT answer the question — the answer MUST refuse + cite nothing (no-inference). */
  readonly refuse?: boolean;
  /** citationIds a correctly-grounded answer must cite. */
  readonly mustCite?: readonly string[];
  /**
   * Substrings the answer MUST contain — the grounded FACT it should state. This is the CORRECTNESS axis:
   * without it the grader checks only citation bookkeeping (id membership), so a vacuous ("here's what I
   * found") or wrong-fact answer with the right citation would pass. Case-insensitive.
   */
  readonly mustContain?: readonly string[];
  /** Substrings that must NOT appear — facts/figures the context never states (fabrication guards). */
  readonly forbidden?: readonly string[];
}

export interface CopilotGrade {
  readonly citationsGrounded: boolean;
  readonly requiredCitationsPresent: boolean;
  readonly contentPresent: boolean;
  readonly refusalCorrect: boolean;
  readonly noForbiddenClaims: boolean;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

// Phrases that mark a refusal ("I couldn't find …") — a keyword PROXY for the no-answer path (imperfect
// by nature). Deliberately excludes broad fragments that recur MID-answer ("not in the", "nothing in",
// "no relevant") to avoid misreading a substantive answer as a refusal; includes several phrasings a live
// model might use for the false-negative direction. The system prompt steers the model toward the
// canonical "could not find it" wording, which the first entries anchor.
const REFUSAL_PHRASES: readonly string[] = [
  "couldn't find",
  "could not find",
  "couldn't locate",
  "could not locate",
  "didn't find",
  "did not find",
  "no information",
  "isn't here",
  "is not here",
  "unable to find",
  "wasn't able to",
  "was not able to",
  "don't have",
  "do not have",
  "no data",
  "doesn't mention",
  "does not mention",
  "not available",
  "nothing about",
];

/** True iff the answer text reads as a refusal (couldn't find / no information / …). Pure. */
export function isRefusalAnswer(answer: readonly string[]): boolean {
  const text = answer.join(" ").toLowerCase();
  return REFUSAL_PHRASES.some((p) => text.includes(p));
}

/**
 * Grade a Copilot answer against a case's expectations. Pure; every axis is a boolean + a human-readable
 * reason so a failing eval says WHY. `pass` is the conjunction of all applicable axes.
 */
export function gradeCopilotAnswer(
  output: CopilotModelOutput,
  context: CopilotEvalContext,
  expect: CopilotExpectation,
): CopilotGrade {
  const failures: string[] = [];
  const retrievedIds = new Set(context.sources.map((s) => s.citationId));
  const citedIds = output.citations.map((c) => c.citationId);

  // 1. Grounding: every cited id must be in the retrieved set (no invented source). Empty ⇒ trivially ok.
  const citationsGrounded = citedIds.every((id) => retrievedIds.has(id));
  if (!citationsGrounded) {
    failures.push("cited a citationId not in the retrieved set (hallucinated source)");
  }

  // 2. Refusal: refuse iff the context can't answer. A correct refusal reads as "couldn't find it" and
  // MAY cite the source showing the topic was discussed-but-unquantified — a GROUNDED refusal-with-context
  // is high-quality (e.g. "no churn figure was recorded [cite: QBR]"). Any citations it does carry are
  // still validated by `citationsGrounded`, so a refusal citing an INVENTED source fails there, not here.
  const refusal = isRefusalAnswer(output.answer);
  let refusalCorrect: boolean;
  if (expect.refuse === true) {
    refusalCorrect = refusal;
    if (!refusal) failures.push("expected a refusal (context can't answer) but the answer was substantive");
  } else {
    refusalCorrect = !refusal;
    if (refusal) failures.push("refused an answerable case (context supports an answer)");
  }

  // 3. Required citations — only meaningful when the case is answerable (not a refusal case).
  let requiredCitationsPresent = true;
  if (expect.mustCite !== undefined && expect.refuse !== true) {
    requiredCitationsPresent = expect.mustCite.every((id) => citedIds.includes(id));
    if (!requiredCitationsPresent) failures.push("did not cite a required grounding source");
  }

  const joined = output.answer.join(" \n ").toLowerCase();

  // 4. Content correctness — the answer must STATE the grounded fact (not merely cite it). This is what
  // separates "cited the right source" from "said the right thing"; a vacuous/wrong answer fails here.
  let contentPresent = true;
  if (expect.mustContain !== undefined && expect.refuse !== true) {
    contentPresent = expect.mustContain.every((k) => joined.includes(k.toLowerCase()));
    if (!contentPresent) failures.push("answer omits a required grounded fact (cited but did not state it)");
  }

  // 5. Forbidden claims — a fabricated fact/figure the context never states (REQ-F-017 no-inference).
  const noForbiddenClaims =
    expect.forbidden === undefined || !expect.forbidden.some((f) => joined.includes(f.toLowerCase()));
  if (!noForbiddenClaims) failures.push("answer contains a forbidden (fabricated / ungrounded) claim");

  const pass =
    citationsGrounded && requiredCitationsPresent && contentPresent && refusalCorrect && noForbiddenClaims;
  return {
    citationsGrounded,
    requiredCitationsPresent,
    contentPresent,
    refusalCorrect,
    noForbiddenClaims,
    pass,
    failures,
  };
}
