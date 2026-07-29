import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, ErrorFallback } from "./chrome/ErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");
createRoot(root).render(
  <StrictMode>
    {/* Root backstop (9.35 / task #35) — catches a render-time throw ANYWHERE in <App/>,
        including the Onboarding early-return branch AND App() itself, before AppShell ever
        mounts. AppShell's own boundary (chrome/AppShell.tsx) only wraps {children}, so it
        cannot reach either of those. */}
    <ErrorBoundary fallback={(reset) => <ErrorFallback reset={reset} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
