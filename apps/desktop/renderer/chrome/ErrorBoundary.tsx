// A render-time failure boundary (§16 "nothing fails silently / degrade-and-surface, never
// crash"). Until now there was NO ErrorBoundary anywhere in apps/desktop (task #35 / 9.35) — any
// render-time throw unmounted the ENTIRE `createRoot` root. See
// renderer/surfaces/copilot/Copilot.tsx's `admitReply` doc comment: Copilot defended itself by
// validating BEFORE render for exactly this reason. Validate-before-render stays strictly
// better than catch-after-throw (it degrades one turn instead of blanking a pane) — this
// boundary is a BACKSTOP for everything that has not built its own pre-render validation, not a
// replacement for `admitReply`.
//
// Class-only: React 18 has no hook equivalent for `componentDidCatch` / `getDerivedStateFromError`.
//
// Scope (characterization, not endorsement — pinned by
// `boundary_does_not_catch_async_or_handler_failures` in test-dom/error-boundary.test.tsx): this
// catches RENDER-time throws ONLY. Async/event-handler failures are NOT caught here — the house
// pattern for those is the `{ok:false}` fold already used throughout `renderer/lib/*.ts` (e.g.
// `copilot-ask.ts`); this boundary does not supersede that pattern.
//
// Rule 7 (redaction): a caught error's message/stack may carry content derived from an
// untrusted/worker payload. Rather than ask a caller not to render it, `fallback` is typed with
// NO error parameter at all — only a `reset` callback — so a caller cannot render error detail
// even by mistake. (The withheld-from-the-type move, not a withhold-by-convention one — same
// shape as the `AdmittedCopilotAnswer` brand in Copilot.tsx.) `componentDidCatch` logs the raw
// error to `console.error` only (dev-tools, not a UI surface, not a persisted log sink) — there
// is no preload logging channel to report to (verified — preload/bridge.ts's 7-channel allowlist
// has none); adding one is an out-of-scope IPC-surface expansion (9.35 brief).
//
// Reset: uncontrolled by design. A caller can remount an instance via React `key` (e.g. keyed on
// the current route, so navigating away from a broken surface gets a fresh boundary) and/or let
// the user invoke `fallback`'s `reset` callback (e.g. a "Try again" button) to re-attempt
// rendering the SAME children in place. Neither is required; both are cheap (AppShell.tsx uses
// both; main.tsx's root instance uses only the button — there is no "route" to key the whole app
// on).
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  /**
   * Rendered instead of the crashed subtree. Receives ONLY `reset` (clears the caught error and
   * re-attempts rendering `children`) — no error detail is passed, so a caller structurally
   * cannot render one (rule 7).
   */
  readonly fallback: (reset: () => void) => ReactNode;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Dev-tools only (rule 7) — see file header. Never rendered, never persisted.
    console.error("[ErrorBoundary] render-time throw caught:", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ hasError: false });
  };

  public override render(): ReactNode {
    return this.state.hasError ? this.props.fallback(this.reset) : this.props.children;
  }
}

/**
 * The shared, fixed fallback content for both boundary sites (main.tsx's root instance +
 * AppShell's content-pane instance) — a short, calm message + a manual retry affordance. No
 * error code, no raw detail, no "contact support" (matches the Copilot `ASK_FAILED` treatment's
 * tone, Copilot.tsx:125-127).
 */
export function ErrorFallback({ reset }: { readonly reset: () => void }): ReactElement {
  return (
    <div className="sow-error-fallback" role="alert">
      <p className="sow-error-fallback-text">Something went wrong, and this part of the app couldn&apos;t render.</p>
      <button className="sow-error-fallback-retry" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
