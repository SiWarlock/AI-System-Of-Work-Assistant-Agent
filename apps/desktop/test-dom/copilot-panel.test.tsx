// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  Copilot,
  CopilotAnswerView,
  admitReply,
  type CopilotProps,
  type CopilotTurnView,
} from "../renderer/surfaces/copilot/Copilot";
import type { AskResult } from "../renderer/lib/copilot-ask";

afterEach(cleanup);

const base: Omit<CopilotProps, "workspaceScoped"> = {
  onCollapse: () => {},
};

// The three onboarded buckets resolve to `workspaceScoped: true` (a single workspace); Global and
// any unknown scope resolve to `false` (pick-a-workspace). The App computes `workspaceScoped` from
// the onboarded store slice (§19.1 / 14.1); this harness mirrors that mapping so the tests keep
// documenting intent by scope NAME while exercising Copilot's real `workspaceScoped` prop.
const WORKSPACE_SCOPED = new Set(["employer-work", "personal-business", "personal-life"]);

function renderCopilot(
  props: Partial<Omit<CopilotProps, "workspaceScoped">> & { scope: string },
): void {
  const { scope, ...rest } = props;
  render(<Copilot {...base} workspaceScoped={WORKSPACE_SCOPED.has(scope)} {...rest} />);
}

describe("Copilot panel — read-only posture (§4.6)", () => {
  it("shows a PERSISTENT read-only reminder — reads only, routes to Approvals", () => {
    renderCopilot({ scope: "employer-work" });
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/reads only/i);
    expect(note.textContent).toMatch(/approvals/i);
  });

  it("the reminder is present even under Global scope (never absent)", () => {
    renderCopilot({ scope: "global" });
    expect(screen.getByRole("note").textContent).toMatch(/reads only/i);
  });
});

describe("Copilot panel — composer scaffolded/disabled until the backend (A)", () => {
  it("renders the ask input + send control DISABLED in a workspace scope", () => {
    renderCopilot({ scope: "personal-business" });
    const input = screen.getByRole("textbox", { name: /ask copilot/i });
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    const send = screen.getByRole("button", { name: /send/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Copilot panel — empty-until-data (no synthetic seed)", () => {
  it("a workspace scope with no turns shows the ask-a-question empty state", () => {
    renderCopilot({ scope: "employer-work" });
    expect(screen.getByText(/ask a question/i)).toBeTruthy();
  });

  it("turns is not part of CopilotProps — the mount-time seed door is deleted (9.39)", () => {
    // @ts-expect-error — 9.39: `turns` no longer exists on `CopilotProps`; this line type-checked
    // with no error at all before this slice (9.25's now-removed AST scanner policed the seed door
    // over an unbounded construction space at runtime — L100; this is the closed-space compile-time
    // gate L103 asks for instead: nothing to police once the prop cannot exist).
    render(<Copilot {...base} workspaceScoped={true} turns={[]} />);
  });
});

describe("Copilot panel — WS-8 workspace isolation under Global", () => {
  it("Global scope shows a pick-a-workspace state and NO composer (Copilot is workspace-scoped)", () => {
    renderCopilot({ scope: "global" });
    expect(screen.getByText(/pick a workspace/i)).toBeTruthy();
    // No ask affordance under Global — Copilot reads a single workspace's knowledge.
    expect(screen.queryByRole("textbox", { name: /ask copilot/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });

  it("an UNRECOGNIZED (out-of-union) scope fails CLOSED to pick-a-workspace, no composer", () => {
    // resolveOnboardedWorkspaceId returns null for any scope that isn't an onboarded workspace —
    // so a garbage scope (persisted stale value, bad deep link) resolves to workspaceScoped:false
    // and can NEVER render a queryable ask.
    renderCopilot({ scope: "mystery-scope" });
    expect(screen.getByText(/pick a workspace/i)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /ask copilot/i })).toBeNull();
  });
});

describe("Copilot panel — transcript bubbles + citations (§4.6, rendered from the view-model)", () => {
  it("renders the question, the answer, and each citation as a chip", async () => {
    // 9.39 — driven through the real live-ask path (the seed door is deleted); same assertions.
    const onAsk = vi.fn().mockResolvedValue({
      ok: true,
      answer: {
        answer: ["Two decisions were logged: adopt the new SLA and defer the pricing change."],
        citations: [
          { citationId: "c1", title: "Vendor review — decisions" },
          { citationId: "c2", title: "Pricing change memo" },
        ],
      },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), {
      target: { value: "What decisions did we make on the vendor review?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/Two decisions were logged/i)).toBeTruthy();
    expect(screen.getByText(/What decisions did we make/i)).toBeTruthy();
    expect(screen.getByText("Vendor review — decisions")).toBeTruthy();
    expect(screen.getByText("Pricing change memo")).toBeTruthy();
  });

  it("a turn with no citations renders a bare answer (false branch)", async () => {
    // 9.39 — driven live (the seed door is deleted); same assertion. (9.40 removed the proposal-row
    // mechanism entirely — a turn can no longer carry one at all, so there is nothing left to assert
    // absent here; see the type-level pin in the "proposal-row mechanism is removed" describe below.)
    const onAsk = vi.fn().mockResolvedValue({
      ok: true,
      answer: { answer: ["Nothing new since yesterday."], citations: [] },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), {
      target: { value: "Any update on the standup?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("Nothing new since yesterday.")).toBeTruthy();
    // No citation list rendered.
    expect(screen.queryByRole("list", { name: "Citations" })).toBeNull();
  });
});

describe("Copilot panel — Employer-Work egress notice (§9.6-real P1.3, safety rule 5)", () => {
  it("a turn carrying egressProcessor shows the cloud-egress notice banner (processor + cloud + Employer-Work)", async () => {
    // 9.39 — driven live (the seed door is deleted); same assertions.
    const onAsk = vi.fn().mockResolvedValue({
      ok: true,
      answer: { answer: ["an answer synthesized on the cloud"], citations: [], egressProcessor: "claude" },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("an answer synthesized on the cloud");
    const notice = document.querySelector(".sow-copilot-egress-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/claude/i);
    expect(notice?.textContent).toMatch(/cloud/i);
    expect(notice?.textContent).toMatch(/employer-work/i);
    // spec(§5) rule 7 (9.24) — the notice discloses the SERVER-DERIVED label and NOTHING else.
    // Exact-equality (not a leak-shape blocklist): a blocklist over a fixed template + the label
    // "claude" cannot fail under any plausible mutation, so it would assert nothing.
    expect((notice?.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(
      "Answered using claude — a cloud model — on Employer-Work content.",
    );
  });

  it("a leak-shaped processor label renders VERBATIM — the contract permits it, so nothing here sanitizes", async () => {
    // spec(§5) rule 7 (9.24) — characterization, NOT an endorsement. `uiSafeSummaryLine`
    // (`UiSafeCopilotAnswer.egressProcessor`) is any single-line string ≤1024: it rejects
    // multi-line/over-length/empty but does NOT reject a URL- or path-shaped label, unlike the
    // sibling `citationId`'s `uiSafeOpaqueRef`. The renderer interpolates the label as-is. Not
    // reachable today (labels are server-constructed route literals), and it is the OVER-disclosure
    // direction rather than case 3 — pinned so the tightening lands deliberately, with this test
    // flipping to an assertion, rather than being discovered in a banner.
    // 9.39 — driven live (the seed door is deleted); same assertion.
    const onAsk = vi.fn().mockResolvedValue({
      ok: true,
      answer: { answer: ["a"], citations: [], egressProcessor: "https://api.anthropic.com/v1" },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText(/api\.anthropic\.com/);
    expect(document.querySelector(".sow-copilot-egress-notice")?.textContent).toMatch(
      /https:\/\/api\.anthropic\.com\/v1/,
    );
  });

  it("a turn WITHOUT egressProcessor renders NO egress notice (false branch — local/no-egress answer)", async () => {
    // 9.39 — driven live (the seed door is deleted); same assertions.
    const onAsk = vi.fn().mockResolvedValue({
      ok: true,
      answer: { answer: ["a local answer"], citations: [] },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    // Positive anchor FIRST: without it the three negatives below all pass on an empty DOM (a
    // regression in the live-turn render path would report green).
    const turnAnswer = await screen.findByText("a local answer");
    const turn = turnAnswer.closest(".sow-copilot-turn");
    expect(turn).not.toBeNull();
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
    // spec(§5) (9.24) — and it stays SILENT: no warning/unknown affordance either. Case 1 is
    // genuinely nothing-to-disclose, so alarm noise on the safe path would train the owner to
    // ignore the surface — the notice's value depends on it being rare and meaningful.
    //
    // ⚠ CONDITIONAL PIN: "absence ⇒ silence" is correct ONLY because the server-side derivation
    // makes case 3 (signal-didn't-arrive) unreachable — see the describe header below. If that ever
    // stops holding, an unknown-provenance affordance becomes the RIGHT fix and this assertion must
    // be revisited, not defended. It pins today's conclusion, not an eternal law.
    expect(turn?.querySelector('[role="alert"]')).toBeNull();
    expect(turn?.textContent ?? "").not.toMatch(/unknown|unavailable|couldn't determine/i);
  });

  it("a LIVE answer carrying egressProcessor threads the notice onto the rendered turn", async () => {
    const onAsk = vi.fn().mockResolvedValue({
      ok: true as const,
      answer: { answer: ["Answered on the cloud."], citations: [], egressProcessor: "claude" },
    });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("Answered on the cloud.");
    expect(document.querySelector(".sow-copilot-egress-notice")).not.toBeNull();
  });
});

// Task 9.24 (⚠ rule-5, pre-existing) — the notice is a DERIVED-PRESENCE indicator, so it is only
// honest if its ABSENCE is also derived. Absence carries THREE meanings (see the contract comment on
// `UiSafeCopilotAnswer.egressProcessor`):
//   1. local / zero-egress answer            — nothing to disclose ✅
//   2. non-Employer-Work cloud egress        — owner-chosen: no notice ✅
//   3. the signal did not arrive             — would be fail-open-by-omission ❌
//
// The Step-2.5 trace concluded case 3 is UNREACHABLE on the live path. ⚠ The legs that actually
// close it are SERVER-side (`apps/worker`), and NOTHING in this file guards them — the durable
// statement lives in the arch note / plan; this is a pointer, not the authority:
//   • `runGovernedCopilotSynthesis` is the one core behind all three answer procedures, and
//     `toUiSafeCopilotAnswer` the one projector that makes an answer servable;
//   • the notice derives from the TRUSTED `processorOfRoute`, never a route's self-declared
//     `egressClass` (pinned worker-side: a route lying "local" on a remote endpoint still notifies);
//   • BOTH real synthesis adapters FAIL CLOSED on a non-Claude route before any egress, and
//     `buildCopilotDeps` pairs synthesis+routeSelector so they cannot skew — this is what stops
//     "egressed on a route the classifier called local", which the chokepoint alone does NOT;
//   • `egressProcessor` is `.optional()`, not `.catch()`, so the field cannot be silently stripped —
//     a schema-invalid answer fails whole. (Narrower than it sounds: `uiSafeSummaryLine` rejects
//     multi-line/over-length/empty, NOT a URL-shaped label — see the leak-shape test above.)
//
// What this file legitimately pins is the RENDERER end: a signal that never arrives surfaces as a
// VISIBLE failure, never as a plausible silent answer. That is the property that makes absence safe
// to read as "nothing to disclose".
//
// ⚠ Known un-pinned closures (Step-9 flagged, worker/plan territory): `toUiSafeCopilotAnswer` takes
// the notice as an OPTIONAL trailing positional, so a fourth skill that forgets it produces a
// servable notice-free answer with every test here green; and `Copilot.tsx` is the ONLY renderer
// reader of `egressProcessor`, so the first surface rendering a briefing/concept answer without
// reading it re-opens case 3 at the renderer.
describe("Copilot panel — absence of the egress notice is DERIVED, not assumed (9.24, safety rule 5)", () => {
  it("failed_ask_renders_explicit_failure_not_a_silent_answer — a typed err is visible, never silent", async () => {
    // spec(§5) — THE load-bearing pin (mutation-confirmed: making the failure path render a
    // plausible answer fails this). If a failed ask rendered as a normal-looking answer, "the egress
    // signal didn't arrive" would be indistinguishable from "nothing to disclose" — case 3, live.
    // (The generic error-turn behaviour is also covered below; what this adds is the rule-5 half —
    // no notice, no citations, i.e. nothing that could read as a completed disclosed answer.)
    const onAsk = vi.fn<(q: string) => Promise<AskResult>>().mockResolvedValue({ ok: false });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText(/couldn't answer that right now/i);
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
    expect(screen.queryByRole("list", { name: "Citations" })).toBeNull();
  });

  it("malformed_ok_payload_renders_explicit_failure — the defensive catch lands on the same visible failure", async () => {
    // spec(§5) — separate `it` so a regression in the typed-err route cannot hide this one (and so
    // neither can match the other's stale text). ⚠ This shape is NOT reachable through
    // `createAskCopilot` (it folds a null value to {ok:false} first) — it exercises the renderer's
    // defence-in-depth `catch`, which is exactly what that try/catch exists for. The malformation
    // that would actually matter for case 3 — a well-formed answer missing ONLY egressProcessor —
    // does not throw and is by construction indistinguishable here; that risk lives in the producer
    // and consumer closures noted in the header, not in anything a renderer test can detect.
    const malformed = vi.fn<(q: string) => Promise<AskResult>>().mockResolvedValue({
      ok: true,
      answer: null,
    } as unknown as AskResult);
    renderCopilot({ scope: "employer-work", onAsk: malformed });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText(/couldn't answer that right now/i);
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
  });

  it("notice_is_scope_blind_at_the_renderer — case 2 is enforced SERVER-side, not here", async () => {
    // spec(§5) — the renderer keys the notice ONLY on `egressProcessor` presence; it does not know
    // the workspace type. So a personal-workspace turn CARRYING a processor still renders the
    // notice. Pinning that (rather than "a personal turn stays silent", which is just the absent-
    // notice branch again and would pass with any scope) makes this fail if someone "fixes" case 2
    // by adding renderer-side scope suppression — which would BOTH reverse an owner decision and
    // move a rule-5 decision out of the worker, where `decideCopilotEgress` owns it.
    const onAsk = vi.fn<(q: string) => Promise<AskResult>>().mockResolvedValue({
      ok: true,
      answer: { answer: ["Answered in the cloud, personal workspace."], citations: [], egressProcessor: "claude" },
    });
    renderCopilot({ scope: "personal-business", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("Answered in the cloud, personal workspace.");
    expect(document.querySelector(".sow-copilot-egress-notice")).not.toBeNull();
  });
});

describe("Copilot panel — collapse control", () => {
  it("clicking Collapse calls onCollapse", () => {
    const onCollapse = vi.fn();
    renderCopilot({ scope: "employer-work", onCollapse });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Copilot sidebar" }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

// ── A5: live ask (wired to query.copilotAsk via the onAsk handler) ────────────────────────
describe("Copilot panel — live ask (onAsk wired; A5)", () => {
  const okAnswer = {
    ok: true as const,
    answer: {
      answer: ["Two decisions were logged.", "The SLA was adopted."],
      citations: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
    },
  };

  it("ENABLES the composer when onAsk is provided (disabled scaffold becomes live)", () => {
    renderCopilot({ scope: "employer-work", onAsk: vi.fn().mockResolvedValue(okAnswer) });
    expect((screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("submitting a question calls onAsk and renders the answer turn WITH citations", async () => {
    const onAsk = vi.fn().mockResolvedValue(okAnswer);
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), {
      target: { value: "what did we decide?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onAsk).toHaveBeenCalledWith("what did we decide?");
    // The answer bubble + question + citation chip appear once the async ask resolves.
    expect(await screen.findByText(/Two decisions were logged\./)).toBeTruthy();
    expect(screen.getByText("what did we decide?")).toBeTruthy();
    expect(screen.getByText("Vendor review — decisions")).toBeTruthy();
  });

  it("a FAILED ask (fail-closed err) renders an error turn, never a partial/raw answer", async () => {
    const onAsk = vi.fn().mockResolvedValue({ ok: false });
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), {
      target: { value: "something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/couldn't answer that|something went wrong/i)).toBeTruthy();
  });

  it("does not submit a blank question (no onAsk call)", () => {
    const onAsk = vi.fn().mockResolvedValue(okAnswer);
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("does not fire a CONCURRENT ask — the pending guard blocks a second submit while one is in flight", async () => {
    let resolve!: (v: AskResult) => void;
    const onAsk = vi.fn().mockReturnValue(new Promise<AskResult>((r) => (resolve = r)));
    renderCopilot({ scope: "employer-work", onAsk });
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "q" } });
    const send = screen.getByRole("button", { name: /send/i });
    fireEvent.click(send);
    fireEvent.click(send); // while the first ask is still pending
    expect(onAsk).toHaveBeenCalledTimes(1);
    resolve(okAnswer);
    expect(await screen.findByText(/Two decisions were logged\./)).toBeTruthy();
  });

  it("clicking a suggestion chip prefills the composer draft (live only)", () => {
    renderCopilot({ scope: "employer-work", onAsk: vi.fn().mockResolvedValue(okAnswer) });
    fireEvent.click(screen.getByRole("button", { name: /what decisions did we log/i }));
    expect((screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement).value).toMatch(
      /what decisions did we log/i,
    );
  });
});

// Task 9.28 (⚠ rule-5 LATENT, not live) — the disclosure must travel WITH the answer.
//
// The gap: `copilotBriefing` and `copilotConcept` ALREADY return notice-bearing answers and have NO
// renderer consumer today. The first surface that renders one by re-mapping fields — `answer`,
// `citations`, and (forgotten) `egressProcessor` — silently drops the disclosure. That re-map IS the
// drop vector, and it is exactly the renderer twin of 9.27's optional trailing positional.
//
// MECHANISM (construction, not enumeration — L64/L73 retired the enumerate-the-consumers posture):
// the turn view holds the VALIDATED `UiSafeCopilotAnswer` VERBATIM (`reply`) instead of flattening it
// into loose fields, and a single shared `CopilotAnswerView` renders body + notice together, so
// `reply: result.answer` — the path of least resistance — carries the disclosure.
//
// ⚠ HONEST BOUND, corrected at security review: the vector is BIASED AGAINST, not eliminated.
// `egressProcessor` is optional on the contract, so a hand-built partial literal at `reply:` still
// compiles and still drops the disclosure — the same omission one level up. These tests CANNOT catch
// that (no renderer test can observe a future consumer's literal); what they pin is that the shared
// view discloses whenever the object it is given carries a label, and that the LIVE path passes the
// whole object through (`notice_is_scope_blind_at_the_renderer`, which drives the real onAsk path).
// Closing the residual needs a branded reply mintable only from a validated wire payload — Step-9
// Future TODO. Naming that here so nobody reads these pins as proof of a guarantee they do not give.
//
// ✅ 9.34 — CLOSED (see the new describe block below): `CopilotTurnView.reply` and
// `CopilotAnswerView`'s prop are now `AdmittedCopilotAnswer`, mintable only via `admitReply` (exported
// from Copilot.tsx). The three `render(<CopilotAnswerView reply={...} />)` calls above were updated
// to `admitReply(...)` for exactly this reason — a bare literal no longer type-checks there.
describe("Copilot — the disclosure travels with the answer (9.28)", () => {
  it("shared_view_renders_body_and_disclosure_together — the notice is the view's job, not each call site's", () => {
    // spec(§5) — the notice is a property of the ANSWER OBJECT + the shared view, not of each call
    // site remembering. Rendering the view with a notice-bearing answer discloses, always.
    render(<CopilotAnswerView reply={admitReply({ answer: ["Answered."], citations: [], egressProcessor: "claude" })} />);
    const notice = document.querySelector(".sow-copilot-egress-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/claude/i);
  });

  it("an_answer_shaped_like_a_briefing_reply_discloses_through_the_shared_view", () => {
    // spec(§5) — `copilotBriefing`/`copilotConcept` return the SAME `UiSafeCopilotAnswer` shape, so a
    // future briefing surface renders through this same view and inherits the disclosure. Simulated
    // here by rendering a briefing-shaped notice-bearing answer through the shared view directly —
    // which is what such a surface would do.
    const briefingAnswer = {
      answer: ["Your day: 2 approvals pending.", "1 item to triage."],
      citations: [{ citationId: "b1", title: "Today read-model" }],
      egressProcessor: "claude",
    };
    render(<CopilotAnswerView reply={admitReply(briefingAnswer)} />);
    expect(document.querySelector(".sow-copilot-egress-notice")).not.toBeNull();
    // …and the answer body still renders (the view is not notice-only).
    expect(screen.getByText(/2 approvals pending/)).toBeTruthy();
  });

  it("a local answer through the shared view stays silent — case 1 unchanged", () => {
    // spec(§5) — the mechanism must not manufacture a notice where the contract says there is
    // nothing to disclose (that would be alarm noise on the safe path, and a claim of its own).
    render(<CopilotAnswerView reply={admitReply({ answer: ["A local answer."], citations: [] })} />);
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
    expect(screen.getByText("A local answer.")).toBeTruthy();
  });
});

// Task 9.34 — the reply is BRANDED: `admitReply` is the ONLY function that can produce an
// `AdmittedCopilotAnswer`, so a hand-built literal is uninhabitable at `CopilotTurnView.reply` and at
// `CopilotAnswerView`'s prop. This closes the "HONEST BOUND" left open above (9.28): a plain literal
// there used to compile silently; now it is a compile error, proven below via `@ts-expect-error`
// (the brand is compile-time-only — nothing prevents the SAME object from rendering correctly once
// admitted, which the positive test below also shows).
describe("Copilot — the reply is branded, uninhabitable by a hand-built literal (9.34)", () => {
  it("admitReply mints a reply usable wherever CopilotAnswerView/CopilotTurnView require one", () => {
    const admitted = admitReply({ answer: ["Admitted."], citations: [] });
    render(<CopilotAnswerView reply={admitted} />);
    expect(screen.getByText("Admitted.")).toBeTruthy();
  });

  it("a hand-built literal no longer satisfies CopilotAnswerView's reply prop (compile-time)", () => {
    // @ts-expect-error — 9.34: `reply` must be minted by `admitReply`; a fresh literal (even one
    // satisfying every UiSafeCopilotAnswer field) is missing the brand and is rejected at compile
    // time. Before this slice, this line type-checked with no error at all.
    render(<CopilotAnswerView reply={{ answer: ["x"], citations: [] }} />);
  });

  it("a hand-built literal no longer satisfies CopilotTurnView's reply field (compile-time)", () => {
    // @ts-expect-error — 9.34: same brand, the OTHER chokepoint named in the task (`reply:` on
    // CopilotTurnView itself, not just the shared view's prop).
    const bad: CopilotTurnView = { id: "x", question: "q", reply: { answer: ["a"], citations: [] } };
    // The brand is compile-time-only (no runtime property), so the object still behaves normally —
    // this line exists only so the `@ts-expect-error` above has a use, not to assert anything new.
    expect(bad.reply.answer).toEqual(["a"]);
  });
});

// Task 9.40 — LEAD RULING: delete the proposal-row MECHANISM, keep the GOAL (re-tracked as a
// separate task, not implemented here). `UiSafeCopilotAnswer`'s header states the answer shape can
// never carry an action; the renderer-local `proposalLabel` field was the only attempt, its button
// was permanently `disabled` with no producer, and 9.39 deleted that producer's only source. This
// pins the field's absence at the TYPE level — the same "RED for a type-level pin is a
// `@ts-expect-error` that goes unused" technique as the 9.34 brand tests above (contracts L87):
// currently `proposalLabel` still exists, so the directive below is unused and typecheck is RED;
// removing the field from `CopilotTurnView` turns it GREEN.
describe("Copilot — the proposal-row mechanism is removed, not merely unreachable (9.40)", () => {
  it("proposalLabel no longer exists on CopilotTurnView", () => {
    const turn: CopilotTurnView = {
      id: "t1",
      question: "q",
      reply: admitReply({ answer: ["a"], citations: [] }),
      // @ts-expect-error — 9.40: `proposalLabel` removed from `CopilotTurnView`; this property must
      // fail to type-check once the field is gone (currently unused — the field still exists).
      proposalLabel: "should not compile",
    };
    expect(turn.reply.answer).toEqual(["a"]);
  });
});
