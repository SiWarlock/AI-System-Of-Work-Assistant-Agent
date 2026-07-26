// @vitest-environment jsdom
//
// Task 9.10-C (desktop leg) — the workspace-settings EGRESS surface. Pins: the per-workspace posture is
// rendered from the worker's UI-safe projection (never derived/guessed); an unavailable posture reads as
// UNKNOWN, never as permission; revoke is a deliberate two-step confirm that dispatches the audited worker
// command and re-renders from ITS returned status (no optimistic flip); a revoke failure leaves the posture
// unchanged; no revoke is offered when the ack is already OFF; and there is NO re-ack affordance at all
// (the ack direction is an owner-gated rule-5 crossing).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { EgressSettings, type EgressSettingsProps } from "../renderer/surfaces/workspace-settings/egress";
import type { EgressStatusResult, UiSafeEgressStatusView } from "../renderer/lib/egress-status";

afterEach(cleanup);

const WORKSPACES = [
  { id: "ws_employer", label: "Employer Work" },
  { id: "ws_personal", label: "Personal Business" },
];

const status = (over: Partial<UiSafeEgressStatusView> = {}): UiSafeEgressStatusView => ({
  workspaceId: "ws_employer",
  employerRawEgressAcknowledged: true,
  zeroEgressOnly: false,
  ...over,
});

/** The last RTL render result — for the tests that need `rerender` (prop-identity / set-change cases). */
let renderResult: ReturnType<typeof render>;

function renderEgress(over: Partial<EgressSettingsProps> = {}): EgressSettingsProps {
  const props: EgressSettingsProps = {
    workspaces: WORKSPACES,
    onLoadStatus: vi.fn((workspaceId: string) =>
      Promise.resolve({ ok: true as const, status: status({ workspaceId }) }),
    ),
    onRevoke: vi.fn((workspaceId: string) =>
      Promise.resolve({ ok: true as const, status: status({ workspaceId, employerRawEgressAcknowledged: false }) }),
    ),
    ...over,
  };
  renderResult = render(<EgressSettings {...props} />);
  return props;
}

const row = (workspaceId: string): HTMLElement => {
  const el = document.querySelector(`[data-egress-workspace="${workspaceId}"]`);
  if (el === null) throw new Error(`no egress row for ${workspaceId}`);
  return el as HTMLElement;
};

describe("Workspace-settings egress surface (9.10-C)", () => {
  it("renders the acknowledged / not-acknowledged posture per workspace from the query", async () => {
    // spec(§16) REQ-S-002 — the posture is SURFACED per workspace, read from the worker's projection only.
    renderEgress({
      onLoadStatus: vi.fn((workspaceId: string) =>
        Promise.resolve({
          ok: true as const,
          status: status({ workspaceId, employerRawEgressAcknowledged: workspaceId === "ws_employer" }),
        }),
      ),
    });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    expect(row("ws_employer").textContent).toMatch(/acknowledged/i);
    expect(row("ws_personal").getAttribute("data-egress-ack")).toBe("false");
    expect(row("ws_personal").textContent).toMatch(/not acknowledged/i);
  });

  it("a query error renders 'posture unavailable' and NEVER 'acknowledged' (fail-closed presentation)", async () => {
    // spec(§5) safety rule 5 (presentation analog) — an unknown posture must not read as permission.
    renderEgress({ onLoadStatus: vi.fn(() => Promise.resolve({ ok: false as const })) });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("unknown"));
    expect(row("ws_employer").textContent).toMatch(/unavailable/i);
    expect(row("ws_employer").textContent).not.toMatch(/\backnowledged\b/i);
    // With an unknown posture there is nothing to revoke — no policy command on a guess.
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("revoke is a deliberate TWO-STEP confirm that dispatches the worker command exactly once", async () => {
    // spec(§11) — the renderer never mutates policy locally; it requests the audited worker command.
    // No native confirm()/alert() (they block the harness) — the confirm is in-surface.
    const props = renderEgress();
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    // Step 1 arms the confirm; nothing dispatched yet.
    expect(props.onRevoke).not.toHaveBeenCalled();
    expect(row("ws_employer").textContent).toMatch(/no longer be sent/i);
    fireEvent.click(within_(row("ws_employer"), /confirm revoke/i));
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledTimes(1));
    expect(props.onRevoke).toHaveBeenCalledWith("ws_employer");
    // The OTHER workspace was never touched.
    expect((props.onRevoke as ReturnType<typeof vi.fn>).mock.calls.flat()).not.toContain("ws_personal");
  });

  it("after a successful revoke the row re-renders from the COMMAND's returned status (no re-query, no local flip)", async () => {
    // spec(§10) — the worker is the single source of posture truth (9.10-A store-backed single-source).
    const props = renderEgress();
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    const loadsBefore = (props.onLoadStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    fireEvent.click(within_(row("ws_employer"), /confirm revoke/i));
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("false"));
    expect(row("ws_employer").textContent).toMatch(/not acknowledged/i);
    expect((props.onLoadStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsBefore);
  });

  it("a revoke failure surfaces a safe typed error and leaves the displayed posture UNCHANGED", async () => {
    // spec(§16) — no optimistic flip, no false "revoked" claim, no raw cause in the message.
    renderEgress({ onRevoke: vi.fn(() => Promise.resolve({ ok: false as const })) });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    fireEvent.click(within_(row("ws_employer"), /confirm revoke/i));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't revoke/i);
    expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"); // unchanged
  });

  it("no revoke affordance when the ack is already OFF (no no-op policy commands)", async () => {
    // spec(§5) — the audited command path stays meaningful; an already-OFF workspace has nothing to revoke.
    renderEgress({
      onLoadStatus: vi.fn((workspaceId: string) =>
        Promise.resolve({ ok: true as const, status: status({ workspaceId, employerRawEgressAcknowledged: false }) }),
      ),
    });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("false"));
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("exposes NO re-ack affordance in ANY posture state — the ack direction is owner-gated (rule 5)", async () => {
    // spec(§5) safety rule 5 — the ONLY control this surface may offer is the fail-SAFE revoke (+ its
    // confirm/cancel). Asserted as a full control INVENTORY per posture state (not merely a filter over
    // whatever happens to be rendered — with ack OFF the surface renders zero controls, so a filter-only
    // assertion would be vacuous exactly where the crossing would be re-opened).
    for (const ack of [true, false]) {
      cleanup();
      renderEgress({
        onLoadStatus: vi.fn((workspaceId: string) =>
          Promise.resolve({ ok: true as const, status: status({ workspaceId, employerRawEgressAcknowledged: ack }) }),
        ),
      });
      await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe(String(ack)));
      // EVERY interactive node, not just button/checkbox/switch — a re-ack added as an <a href>, a
      // <select>, a radio, or any role-bearing div must fail this pin too (element-type drift-proof).
      const controls = [...document.querySelectorAll("button,input,select,textarea,a[href],[role]")]
        .filter((c) => c.getAttribute("role") !== "status" && c.getAttribute("role") !== "alert")
        .map((c) => c.getAttribute("aria-label") ?? c.textContent ?? "");
      // The EXACT inventory: one revoke-arm per acknowledged workspace, and nothing at all when OFF.
      expect(controls).toEqual(
        ack
          ? [
              "Revoke egress acknowledgment for Employer Work",
              "Revoke egress acknowledgment for Personal Business",
            ]
          : [],
      );
      for (const label of controls) {
        expect(label).not.toMatch(
          /acknowledge(?!ment)|re-?ack|enable|allow|permit|authori[sz]e|grant|restore|turn on|opt in/i,
        );
      }
    }
  });

  it("Cancel un-arms the confirm WITHOUT dispatching (the safety gate's escape hatch)", async () => {
    // spec(§5) — arming must be reversible without touching the audited command.
    const props = renderEgress();
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    fireEvent.click(within_(row("ws_employer"), /keep the egress acknowledgment/i));
    expect(props.onRevoke).not.toHaveBeenCalled();
    expect(row("ws_employer").textContent).not.toMatch(/no longer be sent/i);
    expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true");
  });

  it("a double-click on Confirm dispatches the audited command exactly ONCE", async () => {
    // spec(§5) — there is no idempotency key on this command, so the in-flight guard is the only
    // duplicate-dispatch defense on an audited policy write (desktop Lesson 6's noted follow-up).
    let resolveRevoke!: (v: { ok: true; status: UiSafeEgressStatusView }) => void;
    const onRevoke = vi.fn(
      () => new Promise<{ ok: true; status: UiSafeEgressStatusView }>((res) => (resolveRevoke = res)),
    );
    renderEgress({ onRevoke });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    const confirm = within_(row("ws_employer"), /confirm revoke/i);
    fireEvent.click(confirm);
    fireEvent.click(confirm); // second click while the first is in flight — must be ignored
    resolveRevoke({ ok: true, status: status({ employerRawEgressAcknowledged: false }) });
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull(); // no spurious failure banner on a success
  });

  it("an ARMED confirm never survives a posture re-hydrate (no silently pre-armed policy control)", async () => {
    // spec(§5) — the deliberate two-step gate must be armed in THIS cycle; a workspace-set change
    // re-reads every posture, so the armed state (and any stale error) must reset with it.
    const props = renderEgress();
    const { rerender } = renderResult;
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    expect(row("ws_employer").textContent).toMatch(/no longer be sent/i);
    // The onboarded set changes → every posture re-reads.
    rerender(<EgressSettings {...props} workspaces={[...WORKSPACES, { id: "ws_life", label: "Personal Life" }]} />);
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    expect(row("ws_employer").textContent).not.toMatch(/no longer be sent/i);
    expect(props.onRevoke).not.toHaveBeenCalled();
  });

  it("a re-render with an EQUAL (but new) workspaces array does not re-fire the reads; a changed set does", async () => {
    // spec(§10) — App.tsx rebuilds `onboardedWorkspaces` every render, so the effect keys on the id SET.
    // If that regresses to the array identity, every render storms the worker with posture reads.
    const props = renderEgress();
    const { rerender } = renderResult;
    await waitFor(() => expect((props.onLoadStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));
    rerender(<EgressSettings {...props} workspaces={[...WORKSPACES]} />); // equal SET, new array identity
    expect((props.onLoadStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // no re-read
    rerender(<EgressSettings {...props} workspaces={[WORKSPACES[0]!]} />); // genuinely changed set
    await waitFor(() => expect((props.onLoadStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3));
  });

  it("NEVER claims zero-egress / local-only — the producer derives that field as !acknowledged", async () => {
    // spec(§5) safety rule 5 — `zeroEgressOnly` is currently `!employerRawEgressAcknowledged`
    // (apps/worker/src/boot.ts:564), NOT a real local-provider pin: a personal workspace has ack=false
    // while its allowlist is [claude] (cloud). Rendering it as "zero-egress only" would tell the owner
    // content stays local when it egresses — the dangerous direction on the disclosure surface. So the
    // surface must not make that claim until the producer computes a genuine pin (worker-track Finding).
    renderEgress({
      onLoadStatus: vi.fn((workspaceId: string) =>
        Promise.resolve({
          ok: true as const,
          status: status({ workspaceId, employerRawEgressAcknowledged: false, zeroEgressOnly: true }),
        }),
      ),
    });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("false"));
    expect(document.body.textContent).not.toMatch(/zero-egress|stays local|local[- ]only/i);
  });

  it("an UNAVAILABLE posture offers a Retry that re-reads — a blip must not strand the fail-safe control", async () => {
    // spec(§16) — failing closed on the DISPLAY is right; making the revoke (the emergency OFF switch)
    // permanently unreachable after one transient read fault is not.
    let attempt = 0;
    const onLoadStatus = vi.fn((workspaceId: string) => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1 ? { ok: false as const } : { ok: true as const, status: status({ workspaceId }) },
      );
    });
    renderEgress({ workspaces: [WORKSPACES[0]!], onLoadStatus });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("unknown"));
    fireEvent.click(within_(row("ws_employer"), /retry/i));
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    // …and the fail-safe control is reachable again.
    expect(within_(row("ws_employer"), /revoke egress acknowledgment/i)).toBeTruthy();
  });

  it("a STALE in-flight read never overwrites the post-revoke posture", async () => {
    // spec(§5) — a hydrate dispatched before the revoke landed must not resurrect "acknowledged" on a
    // workspace that is now revoked (it would overstate permission AND re-offer a completed revoke).
    let resolveRead2!: (v: EgressStatusResult) => void;
    const calls: Record<string, number> = {};
    const onLoadStatus = vi.fn((workspaceId: string) => {
      const n = (calls[workspaceId] = (calls[workspaceId] ?? 0) + 1);
      // ONLY the employer row's SECOND read is deferred — the sibling's reads must not steal the
      // resolver (else this test would assert nothing about the row it is about).
      if (workspaceId !== "ws_employer" || n === 1) {
        return Promise.resolve({ ok: true as const, status: status({ workspaceId }) });
      }
      return new Promise<EgressStatusResult>((res) => (resolveRead2 = res));
    });
    let resolveRevoke!: (v: EgressStatusResult) => void;
    const onRevoke = vi.fn(() => new Promise<EgressStatusResult>((res) => (resolveRevoke = res)));
    const props = renderEgress({ workspaces: [WORKSPACES[0]!], onLoadStatus, onRevoke });
    const { rerender } = renderResult;
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));

    fireEvent.click(within_(row("ws_employer"), /revoke egress acknowledgment/i));
    fireEvent.click(within_(row("ws_employer"), /confirm revoke/i));
    // A re-hydrate races in while the revoke is still in flight (routine: the onboarded set updates).
    rerender(<EgressSettings {...props} workspaces={[WORKSPACES[0]!, WORKSPACES[1]!]} />);
    resolveRevoke({ ok: true, status: status({ employerRawEgressAcknowledged: false }) });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("false"));
    // The stale read (captured BEFORE the revoke landed) now resolves with the pre-revoke posture.
    // `act` FLUSHES its state update — without a staleness guard this repaints "acknowledged".
    await act(async () => {
      resolveRead2({ ok: true, status: status({ employerRawEgressAcknowledged: true }) });
    });
    expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("false"); // not resurrected
  });

  it("renders ONLY the allowlisted fields — a smuggled raw field on a status is never surfaced", async () => {
    // spec(§5) rule 7 — pins that the COMPONENT never dumps `cell.status` wholesale. (The allowlist
    // reconstruction itself is covered at the lib layer: test/renderer/egress-status.test.ts — this
    // status arrives already-ok, so the fold is deliberately not in this code path.)
    const tainted = { ...status(), rawEmployerContent: "confidential deck bytes", vaultPath: "/Users/owner/vault" };
    renderEgress({
      onLoadStatus: vi.fn(() => Promise.resolve({ ok: true as const, status: tainted as UiSafeEgressStatusView })),
    });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    expect(document.body.textContent).not.toMatch(/confidential deck bytes|\/Users\/owner\/vault/);
  });

  it("without a live worker the revoke control is not offered (never a dead control)", async () => {
    // spec(§11) — mirrors the Approvals/decide gating: no handle ⇒ no affordance, not a silent no-op.
    renderEgress({ onRevoke: undefined });
    await waitFor(() => expect(row("ws_employer").getAttribute("data-egress-ack")).toBe("true"));
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("no onboarded workspaces → an honest empty state (no fabricated posture)", () => {
    renderEgress({ workspaces: [] });
    expect(screen.getByRole("status").textContent).toMatch(/no workspaces/i);
  });
});

/** Scoped button lookup — the surface renders one row per workspace, so names repeat across rows. */
function within_(scope: HTMLElement, name: RegExp): HTMLElement {
  const match = [...scope.querySelectorAll("button")].find((b) =>
    name.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
  );
  if (match === undefined) throw new Error(`no button matching ${String(name)} in row`);
  return match;
}
