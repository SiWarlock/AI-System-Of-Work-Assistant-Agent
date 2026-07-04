import type { CSSProperties } from "react";

/**
 * Set the subtle per-workspace accent via a CSS var (Treatment 1 "subtle scope": the app
 * accent stays system-blue; only the switcher dot + the thin scope line + a Global group
 * head take the workspace color). Shared by the shell (chrome/AppShell) and the Today
 * surface's Global groups.
 */
export function accentVar(accent: string): CSSProperties {
  return { ["--sow-ws-accent"]: accent } as CSSProperties;
}
