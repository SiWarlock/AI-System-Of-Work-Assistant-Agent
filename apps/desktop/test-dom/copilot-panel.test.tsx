// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Copilot, type CopilotProps, type CopilotTurnView } from "../renderer/surfaces/copilot/Copilot";
import type { AskResult } from "../renderer/lib/copilot-ask";

afterEach(cleanup);

const base: Omit<CopilotProps, "scope"> = {
  onCollapse: () => {},
};

function renderCopilot(props: Partial<CopilotProps> & { scope: CopilotProps["scope"] }): void {
  render(<Copilot {...base} {...props} />);
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
    renderCopilot({ scope: "employer-work", turns: [] });
    expect(screen.getByText(/ask a question/i)).toBeTruthy();
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
    // resolveWorkspaceId returns null for any scope that isn't one of the three known workspaces —
    // so a garbage scope (persisted stale value, bad deep link) can NEVER render a queryable ask.
    renderCopilot({ scope: "mystery-scope" as CopilotProps["scope"] });
    expect(screen.getByText(/pick a workspace/i)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /ask copilot/i })).toBeNull();
  });
});

describe("Copilot panel — transcript bubbles + citations (§4.6, rendered from the view-model)", () => {
  const turns: readonly CopilotTurnView[] = [
    {
      id: "t1",
      question: "What decisions did we make on the vendor review?",
      answer: "Two decisions were logged: adopt the new SLA and defer the pricing change.",
      citations: [
        { id: "c1", title: "Vendor review — decisions" },
        { id: "c2", title: "Pricing change memo" },
      ],
      proposalLabel: "Draft a follow-up email",
    },
  ];

  it("renders the question, the answer, and each citation as a chip", () => {
    renderCopilot({ scope: "employer-work", turns });
    expect(screen.getByText(/What decisions did we make/i)).toBeTruthy();
    expect(screen.getByText(/Two decisions were logged/i)).toBeTruthy();
    expect(screen.getByText("Vendor review — decisions")).toBeTruthy();
    expect(screen.getByText("Pricing change memo")).toBeTruthy();
  });

  it("a turn carrying a proposal shows a routes-to-Approvals action row (never a direct write)", () => {
    renderCopilot({ scope: "employer-work", turns });
    const proposal = screen.getByText(/Draft a follow-up email/i).closest(".sow-copilot-proposal");
    expect(proposal).not.toBeNull();
    expect(proposal?.textContent).toMatch(/approvals/i);
  });

  it("a turn with no citations and no proposal renders a bare answer (false branches)", () => {
    const bare: readonly CopilotTurnView[] = [
      { id: "b1", question: "Any update on the standup?", answer: "Nothing new since yesterday.", citations: [] },
    ];
    renderCopilot({ scope: "employer-work", turns: bare });
    expect(screen.getByText("Nothing new since yesterday.")).toBeTruthy();
    // No citation list rendered, and no proposal action row.
    expect(screen.queryByRole("list", { name: "Citations" })).toBeNull();
    expect(document.querySelector(".sow-copilot-proposal")).toBeNull();
  });
});

describe("Copilot panel — Employer-Work egress notice (§9.6-real P1.3, safety rule 5)", () => {
  it("a turn carrying egressProcessor shows the cloud-egress notice banner (processor + cloud + Employer-Work)", () => {
    const turns: readonly CopilotTurnView[] = [
      { id: "e1", question: "q", answer: "an answer synthesized on the cloud", citations: [], egressProcessor: "claude" },
    ];
    renderCopilot({ scope: "employer-work", turns });
    const notice = document.querySelector(".sow-copilot-egress-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/claude/i);
    expect(notice?.textContent).toMatch(/cloud/i);
    expect(notice?.textContent).toMatch(/employer-work/i);
  });

  it("a turn WITHOUT egressProcessor renders NO egress notice (false branch — local/no-egress answer)", () => {
    const turns: readonly CopilotTurnView[] = [
      { id: "n1", question: "q", answer: "a local answer", citations: [] },
    ];
    renderCopilot({ scope: "employer-work", turns });
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
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
