// spec(§4.6 / PRD §20.1 / EVAL-1) — the synthetic Copilot grounding corpus.
//
// Labeled cases for the Copilot SYNTHESIS eval: each carries the question, the retrieved context the
// model synthesizes over (aligned block↔source pairs), the expectations a correct answer must satisfy,
// and a GOLDEN reference answer (the deterministic suite grades this; the gated real tier replaces it
// with the live model's output). Fully SYNTHETIC — no real/employer data. Spans all three workspaces and
// the load-bearing cases: single/multi-source grounding, correct REFUSAL when the context can't answer
// (REQ-F-017 no-inference), and FABRICATION traps (a figure/fact the context never states).
import type { CopilotEvalContext, CopilotExpectation, CopilotModelOutput } from "./grader";

export interface CopilotEvalCase {
  readonly id: string;
  readonly workspace: "employer-work" | "personal-business" | "personal-life";
  readonly question: string;
  readonly context: CopilotEvalContext;
  readonly expect: CopilotExpectation;
  /** The reference ideal answer — passes the grader; the real tier substitutes the live model output. */
  readonly golden: CopilotModelOutput;
}

/** EVAL-1 floor for this corpus (local to this suite; not the shared harness CORPUS_FLOORS). */
export const COPILOT_EVAL_FLOOR = 12;

/** A one-source context helper. */
function ctx1(workspaceId: string, block: string, citationId: string, title: string): CopilotEvalContext {
  return { workspaceId, blocks: [block], sources: [{ citationId, title }] };
}

export const COPILOT_EVAL_CORPUS: readonly CopilotEvalCase[] = [
  {
    id: "emp-sla-01",
    workspace: "employer-work",
    question: "What is the vendor SLA uptime target?",
    context: ctx1("employer-work", "The vendor SLA target is 99.9% uptime.", "gbrain:emp-sla", "Vendor SLA"),
    expect: { mustCite: ["gbrain:emp-sla"], mustContain: ["99.9"] },
    golden: {
      answer: ["The vendor SLA target is 99.9% uptime."],
      citations: [{ citationId: "gbrain:emp-sla", title: "Vendor SLA" }],
    },
  },
  {
    id: "emp-renewal-02",
    workspace: "employer-work",
    question: "When does the vendor contract renew?",
    // Context names the VENDOR contract explicitly so the question + passage refer to the same thing
    // (the real model rightly refused when the passage said only "the contract" — an ambiguity, not a
    // grounding failure).
    context: ctx1("employer-work", "The vendor contract renews annually each March.", "gbrain:emp-contract", "Contract terms"),
    expect: { mustCite: ["gbrain:emp-contract"], mustContain: ["march"] },
    golden: {
      answer: ["The vendor contract renews annually, each March."],
      citations: [{ citationId: "gbrain:emp-contract", title: "Contract terms" }],
    },
  },
  {
    id: "emp-auth-multi-03",
    workspace: "employer-work",
    question: "What did we decide in the auth redesign and what is the access-token TTL?",
    context: {
      workspaceId: "employer-work",
      blocks: [
        "Decision: move from opaque session cookies to short-lived JWT access tokens.",
        "Access tokens are valid for 15 minutes; refresh tokens rotate on use.",
      ],
      sources: [
        { citationId: "gbrain:emp-auth-adr", title: "Auth redesign ADR" },
        { citationId: "gbrain:emp-token-ttl", title: "Token lifetimes" },
      ],
    },
    expect: { mustCite: ["gbrain:emp-auth-adr", "gbrain:emp-token-ttl"], mustContain: ["jwt", "15 min"] },
    golden: {
      answer: [
        "The team moved from opaque session cookies to short-lived JWT access tokens.",
        "Access tokens are valid for 15 minutes, with refresh tokens rotating on use.",
      ],
      citations: [
        { citationId: "gbrain:emp-auth-adr", title: "Auth redesign ADR" },
        { citationId: "gbrain:emp-token-ttl", title: "Token lifetimes" },
      ],
    },
  },
  {
    id: "emp-pagination-04",
    workspace: "employer-work",
    question: "What pagination style must new public endpoints use?",
    context: ctx1(
      "employer-work",
      "New public REST endpoints must use cursor-based pagination.",
      "gbrain:emp-style",
      "API style guide",
    ),
    expect: { mustCite: ["gbrain:emp-style"], mustContain: ["cursor"] },
    golden: {
      answer: ["New public endpoints must use cursor-based pagination."],
      citations: [{ citationId: "gbrain:emp-style", title: "API style guide" }],
    },
  },
  {
    id: "emp-approval-05",
    workspace: "employer-work",
    question: "Did we approve the vendor in the review?",
    context: ctx1(
      "employer-work",
      "Vendor review outcome: SecureCorp was approved for the integration.",
      "gbrain:emp-vendor-review",
      "Vendor review",
    ),
    expect: { mustCite: ["gbrain:emp-vendor-review"], mustContain: ["approved"] },
    golden: {
      answer: ["Yes — SecureCorp was approved for the integration in the vendor review."],
      citations: [{ citationId: "gbrain:emp-vendor-review", title: "Vendor review" }],
    },
  },
  {
    id: "emp-refuse-address-06",
    workspace: "employer-work",
    question: "What is the CEO's home address?",
    context: ctx1("employer-work", "The vendor SLA target is 99.9% uptime.", "gbrain:emp-sla", "Vendor SLA"),
    expect: { refuse: true },
    golden: { answer: ["I couldn't find anything about that in this workspace."], citations: [] },
  },
  {
    id: "emp-noinfer-owner-07",
    workspace: "employer-work",
    question: "Who owns the database migration task?",
    context: ctx1(
      "employer-work",
      "The database migration is scheduled for the next sprint.",
      "gbrain:emp-migration",
      "Migration plan",
    ),
    // The context names NO owner — must not invent one (REQ-F-017); refuse on the owner question.
    expect: { refuse: true, forbidden: ["assigned to"] },
    golden: { answer: ["I couldn't find an owner named for the migration task in this workspace."], citations: [] },
  },
  {
    id: "emp-fabrication-churn-08",
    workspace: "employer-work",
    question: "How many customers churned last quarter?",
    context: ctx1(
      "employer-work",
      "Churn was flagged as a concern in the quarterly review, with no figure recorded.",
      "gbrain:emp-qbr",
      "Quarterly review",
    ),
    // A number would be fabricated — the context records none (the refuse check is the primary guard).
    expect: { refuse: true, forbidden: ["%"] },
    golden: { answer: ["I couldn't find a churn figure recorded for last quarter in this workspace."], citations: [] },
  },
  {
    id: "emp-refuse-forecast-09",
    workspace: "employer-work",
    question: "What will next year's budget be?",
    context: ctx1(
      "employer-work",
      "This year's engineering budget is fully allocated across the four active projects.",
      "gbrain:emp-budget",
      "Budget",
    ),
    expect: { refuse: true, forbidden: ["$", "next year's budget is"] },
    golden: { answer: ["I couldn't find any information about next year's budget in this workspace."], citations: [] },
  },
  {
    id: "pb-pricing-10",
    workspace: "personal-business",
    question: "Which pricing tier did I decide on?",
    context: ctx1(
      "personal-business",
      "After comparing three tiers, I chose the mid tier at $29/month.",
      "gbrain:pb-pricing",
      "Pricing decision",
    ),
    expect: { mustCite: ["gbrain:pb-pricing"], mustContain: ["mid", "29"] },
    golden: {
      answer: ["You chose the mid tier, at $29/month."],
      citations: [{ citationId: "gbrain:pb-pricing", title: "Pricing decision" }],
    },
  },
  {
    id: "pb-priorities-11",
    workspace: "personal-business",
    question: "What are my two side-project priorities this month?",
    context: ctx1(
      "personal-business",
      "This month's priorities: ship the public API, then write the getting-started docs.",
      "gbrain:pb-priorities",
      "Monthly priorities",
    ),
    expect: { mustCite: ["gbrain:pb-priorities"], mustContain: ["api", "docs"] },
    golden: {
      answer: ["Your two priorities this month are to ship the public API, then write the getting-started docs."],
      citations: [{ citationId: "gbrain:pb-priorities", title: "Monthly priorities" }],
    },
  },
  {
    id: "pb-refuse-dentist-12",
    workspace: "personal-business",
    question: "When is my next dentist appointment?",
    context: ctx1(
      "personal-business",
      "This month's priorities: ship the public API, then write the getting-started docs.",
      "gbrain:pb-priorities",
      "Monthly priorities",
    ),
    expect: { refuse: true },
    golden: { answer: ["I couldn't find anything about a dentist appointment in this workspace."], citations: [] },
  },
  {
    id: "pl-reading-13",
    workspace: "personal-life",
    question: "What book did I want to read next?",
    context: ctx1(
      "personal-life",
      "Next up on the reading list: 'Deep Work' by Cal Newport.",
      "gbrain:pl-reading",
      "Reading list",
    ),
    expect: { mustCite: ["gbrain:pl-reading"], mustContain: ["deep work"] },
    golden: {
      answer: ["Next on your reading list is 'Deep Work' by Cal Newport."],
      citations: [{ citationId: "gbrain:pl-reading", title: "Reading list" }],
    },
  },
  {
    id: "pl-refuse-flight-14",
    workspace: "personal-life",
    question: "What time is my flight tomorrow?",
    context: ctx1(
      "personal-life",
      "Next up on the reading list: 'Deep Work' by Cal Newport.",
      "gbrain:pl-reading",
      "Reading list",
    ),
    expect: { refuse: true, forbidden: ["a.m.", "p.m.", "departs at"] },
    golden: { answer: ["I couldn't find any flight details in this workspace."], citations: [] },
  },
];
