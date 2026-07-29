// @vitest-environment jsdom
//
// Task #35 / 9.35 — there is no ErrorBoundary anywhere in apps/desktop, so any render-time
// throw unmounts the entire `createRoot` root (see renderer/surfaces/copilot/Copilot.tsx:137-138,
// the doc comment `admitReply` exists BECAUSE of this gap). This pins the boundary's contract at
// both sites: the reusable component itself, Site A (main.tsx, wraps <App/>), and Site B
// (AppShell.tsx, wraps {children}).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StrictMode, useState, type ReactElement } from "react";
import { ErrorBoundary, ErrorFallback } from "../renderer/chrome/ErrorBoundary";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";
import type { Route } from "../renderer/store/route";

// Mocks `shouldShowOnboarding` to throw — the exact call site inside `App()` (App.tsx:214) that
// gates the Onboarding-vs-AppShell branch. A throw there happens INSIDE App() before its return,
// which is precisely the class Site B (nested inside AppShell, which never mounts in this
// scenario) structurally cannot reach — only Site A (wrapping <App/> itself) can. Spread `actual`
// so `shouldBackfillMarker` (App.tsx's other import from this module) stays real.
//
// ⚠ Rendering the REAL `App` (rather than a synthetic stand-in) is deliberate: a synthetic child
// could only prove "the boundary catches throws" (already proven by
// `boundary_renders_fallback_on_child_render_throw`) — it can't prove the two acceptance bullets
// this test targets ("a throw in App() before its return is caught" / "the App.tsx:214
// Onboarding-path class is covered"), because both are claims about the REAL early-return
// structure. A synthetic component would make the test pass while testing something else.
//
// This is SAFE because the mocked throw fires synchronously DURING RENDER, before React commits
// — so App's `useEffect`s (`startLive`, `firstRunStatus`) never run; no live-wiring side effect
// leaks into this test. That safety is an assumption about App's CURRENT shape, not a guarantee:
// if App ever grows render-phase I/O before this call site, that assumption breaks. If it does,
// this test going noisy (flaky/erroring rather than cleanly red/green) is a signal to fix, not a
// maintenance cost to silence.
vi.mock("../renderer/lib/first-run-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/lib/first-run-gate")>();
  return {
    ...actual,
    shouldShowOnboarding: (): boolean => {
      throw new Error("boom-in-App-before-return");
    },
  };
});

// Imported AFTER the mock above (vi.mock is hoisted by vitest regardless of import order).
import { App } from "../renderer/App";

afterEach(cleanup);

// A child that throws unconditionally during render — stands in for any surface's render-time
// defect (a malformed payload, a bad prop, etc.).
function Boom({ message = "boom" }: { readonly message?: string }): ReactElement {
  throw new Error(message);
}

function Fine(): ReactElement {
  return <div>FINE-CONTENT</div>;
}

const fallback = (reset: () => void): ReactElement => <ErrorFallback reset={reset} />;

describe("ErrorBoundary — core render-throw containment", () => {
  it("boundary_renders_fallback_on_child_render_throw — spec(§16)", () => {
    render(
      <ErrorBoundary fallback={fallback}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("boundary_is_inert_when_no_throw — spec(§16) non-vacuity", () => {
    render(
      <ErrorBoundary fallback={fallback}>
        <Fine />
      </ErrorBoundary>,
    );
    expect(screen.getByText("FINE-CONTENT")).toBeTruthy();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("fallback_exposes_no_raw_message_or_stack — spec(§16) rule-7 redaction", () => {
    render(
      <ErrorBoundary fallback={fallback}>
        <Boom message="SECRET-abc123" />
      </ErrorBoundary>,
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/SECRET-abc123/);
    // No stack-shaped substring (a "  at <name> (<file>:<line>:<col>)" frame).
    expect(text).not.toMatch(/\bat\s+\S+\s+\(.+:\d+:\d+\)/);
  });

  it("boundary_does_not_catch_async_or_handler_failures — spec(§16) characterization, not endorsement", async () => {
    // OBSERVED, not assumed: a first draft of this test threw SYNCHRONOUSLY inside `onClick` and
    // asserted `fireEvent.click` itself throws. It doesn't — per the DOM spec a listener exception
    // is reported to the global error handler, not propagated out of `dispatchEvent` (jsdom
    // follows the spec). Worse, React's DEV-mode `invokeGuardedCallbackDev` re-dispatches the
    // throw via a real (delayed) global error report, which surfaced as a process-level
    // "Unhandled Exception" that failed the WHOLE suite run even though this test's own
    // assertions passed. So this test instead uses an async rejection the component fully
    // handles itself (the real house `{ok:false}` fold shape, `renderer/lib/*.ts`) — nothing is
    // ever globally "unhandled", and the invariant is the same one either way: an
    // async/event-handler failure never reaches the render-time boundary, handled or not.
    function AsyncFails(): ReactElement {
      const [failed, setFailed] = useState(false);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              void Promise.reject(new Error("async-boom")).catch(() => setFailed(true));
            }}
          >
            trigger
          </button>
          {failed ? <span>HANDLED-LOCALLY</span> : null}
        </div>
      );
    }
    render(
      <ErrorBoundary fallback={fallback}>
        <AsyncFails />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText("trigger"));
    await screen.findByText("HANDLED-LOCALLY");
    // The boundary never engaged — no fallback, ever — even though the async op did fail.
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("strictmode_double_render_yields_one_stable_fallback — spec(§16)", () => {
    render(
      <StrictMode>
        <ErrorBoundary fallback={fallback}>
          <Boom />
        </ErrorBoundary>
      </StrictMode>,
    );
    expect(screen.getAllByText(/something went wrong/i)).toHaveLength(1);
  });

  it("boundary_reset_button_clears_error_and_lets_children_reattempt — spec(§16) manual reset", () => {
    let shouldThrow = true;
    function Flaky(): ReactElement {
      if (shouldThrow) throw new Error("flaky-transient");
      return <div>RECOVERED</div>;
    }
    render(
      <ErrorBoundary fallback={fallback}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("RECOVERED")).toBeTruthy();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});

describe("ErrorBoundary — Site B (AppShell wraps {children}): recoverability", () => {
  const base: Omit<AppShellProps, "children"> = {
    connection: "live",
    scope: "global",
    onScopeChange: () => {},
    route: { surface: "today" },
    onNavigate: () => {},
    copilotWorkspaceScoped: false,
  };

  it("surface_throw_leaves_chrome_and_nav_mounted — spec(§11)", () => {
    render(
      <AppShell {...base}>
        <Boom />
      </AppShell>,
    );
    // Fallback shown in the content region.
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    // Chrome + nav survive — the shell around the crashed content pane is untouched.
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Copilot (collapsed)" })).toBeTruthy();
  });

  it("user_can_navigate_away_from_a_broken_surface — spec(§11) reset-on-route-change", () => {
    const handleNavigate = (r: Route): void => {
      rerender(
        <AppShell {...base} route={r} onNavigate={handleNavigate}>
          <div>NEW-SURFACE-CONTENT</div>
        </AppShell>,
      );
    };
    const { rerender } = render(
      <AppShell {...base} onNavigate={handleNavigate}>
        <Boom />
      </AppShell>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Projects"));
    expect(screen.getByText("NEW-SURFACE-CONTENT")).toBeTruthy();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});

describe("ErrorBoundary — Site A (main.tsx wraps <App/>): the class Site B cannot reach", () => {
  it("root_boundary_catches_a_throw_in_App_itself — spec(§11) covers the Onboarding-gate / pre-return class", () => {
    render(
      <ErrorBoundary fallback={fallback}>
        <App />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
  });
});
