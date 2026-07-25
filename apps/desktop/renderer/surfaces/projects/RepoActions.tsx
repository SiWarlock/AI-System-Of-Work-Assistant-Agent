// 9.12r — the repo open/reveal affordance (Option A). A PURE, path-BLIND prop-render: it emits a CLOSED target
// ("workspace" | "global") to injected callbacks, NEVER a filesystem path (main resolves the path; §5). The
// WORKSPACE actions are disabled when no workspace repo is available (never offer an unconfigured repo); the
// Global/Coordination actions are always available. NEVER imports electron/node/window — the window.sow call
// lives in renderer/lib/open-in-vault.ts, wired by App.
import { type ReactElement } from "react";
import type { VaultRepoTarget } from "../../../preload/bridge";

export interface RepoActionsProps {
  /** True when the active workspace is onboarded (has a repo) — the UI-safe proxy for "a repo is configured". */
  readonly workspaceRepoAvailable: boolean;
  readonly onOpen: (target: VaultRepoTarget) => void;
  readonly onReveal: (target: VaultRepoTarget) => void;
}

function RepoGroup({
  label,
  target,
  disabled,
  onOpen,
  onReveal,
}: {
  readonly label: string;
  readonly target: VaultRepoTarget;
  readonly disabled: boolean;
  readonly onOpen: (t: VaultRepoTarget) => void;
  readonly onReveal: (t: VaultRepoTarget) => void;
}): ReactElement {
  const noun = target === "workspace" ? "workspace repo" : "coordination repo";
  return (
    <div className="sow-repo-group">
      <span className="sow-repo-group-label">{label}</span>
      <button
        type="button"
        className="sow-repo-btn"
        disabled={disabled}
        aria-label={`Open ${noun} in Obsidian`}
        onClick={() => onOpen(target)}
      >
        Open in Obsidian
      </button>
      <button
        type="button"
        className="sow-repo-btn"
        disabled={disabled}
        aria-label={`Reveal ${noun} in Finder`}
        onClick={() => onReveal(target)}
      >
        Reveal in Finder
      </button>
    </div>
  );
}

export function RepoActions({ workspaceRepoAvailable, onOpen, onReveal }: RepoActionsProps): ReactElement {
  return (
    <div className="sow-repo-actions" aria-label="Repo actions">
      <RepoGroup
        label="Workspace repo"
        target="workspace"
        disabled={!workspaceRepoAvailable}
        onOpen={onOpen}
        onReveal={onReveal}
      />
      <RepoGroup label="Coordination repo" target="global" disabled={false} onOpen={onOpen} onReveal={onReveal} />
    </div>
  );
}
