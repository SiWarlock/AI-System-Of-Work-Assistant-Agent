// Projects surface (§4.5, §9.5) — the dedicated Projects PAGE that mounts inside the
// AppShell. A master project LIST (left) + a project DETAIL (right) with DETERMINISTIC
// progress. One of several routable surfaces.
//
// Invariants:
//   - REQ-F-011: the UI only DISPLAYS the server-provided `percentComplete` (bar width +
//     count line) — it NEVER computes or infers a percentage (no division/Math in render).
//   - WS-8: Projects is workspace-scoped. Under Global, `projects` is [] (never a
//     cross-workspace blend) → a "pick a workspace" state, distinct from a workspace's
//     own empty-until-data state.
//   - Route ≠ scope: selecting a project sets the route's projectId (scope-preserving);
//     `scope` still gates the DATA.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { type ReactElement } from "react";
import type { UiSafeProjectDashboard, UiSafeManagedDoc } from "@sow/contracts/api/ui-safe";
import type { WorkspaceScope } from "../../store/scope";
import { resolveSelectedProject } from "./select";
import { resolveDocPack } from "./docpack";

export interface ProjectsProps {
  /** The active workspace scope — Projects is workspace-scoped (WS-8). */
  readonly scope: WorkspaceScope;
  /** The active workspace scope's project dashboards (empty under Global — WS-8). */
  readonly projects: readonly UiSafeProjectDashboard[];
  /** The selected project id from the route (§9.5); undefined = just entered / list view. */
  readonly selectedProjectId: string | undefined;
  /** Select a project's detail (sets route.projectId). Scope-preserving. */
  readonly onSelectProject: (projectId: string) => void;
}

/** A labelled hairline list of a project's prose items (blockers / waiting / next). */
function ProjectItems({ label, items }: { readonly label: string; readonly items: readonly string[] }): ReactElement {
  return (
    <div className="sow-project-items">
      <span className="sow-project-items-label">{label}</span>
      <ul className="sow-project-items-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** The master list row for one project — title, status, and a scannable deterministic bar. */
function ProjectListItem({
  project,
  selected,
  onSelect,
}: {
  readonly project: UiSafeProjectDashboard;
  readonly selected: boolean;
  readonly onSelect: (projectId: string) => void;
}): ReactElement {
  const go = (): void => onSelect(project.projectId);
  return (
    <div
      className={selected ? "sow-projects-list-item sow-projects-list-item--sel" : "sow-projects-list-item"}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-project-id={project.projectId}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      <div className="sow-projects-list-head">
        <span className="sow-projects-list-title">{project.title}</span>
        <span className="sow-project-status">{project.status}</span>
      </div>
      <div
        className="sow-project-progress"
        role="progressbar"
        aria-valuenow={project.progress.percentComplete}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* width is the SERVER-provided deterministic percent — never a UI computation. */}
        <div className="sow-project-bar" style={{ width: `${project.progress.percentComplete}%` }} />
      </div>
      <div className="sow-projects-list-meta">
        {project.progress.completedCount}/{project.progress.totalCount} · {project.progress.percentComplete}%
      </div>
    </div>
  );
}

/**
 * The managed NotebookLM doc pack (§4.5): the 5 canonical slots (00–04) with link + sync
 * state, always shown in full (the resolver overlays the read-model onto the canonical slots).
 * The re-add/refresh affordance is present per §4.5 but DISABLED until a Drive connector exists
 * (nothing to link/sync yet) — honest, not a dead button pretending to work. `linkState` /
 * `syncState` are display tokens straight from the projection; no doc id/url is ever exposed.
 */
function ManagedDocPack({ docPack }: { readonly docPack: readonly UiSafeManagedDoc[] }): ReactElement {
  const docs = resolveDocPack(docPack);
  const anyLinked = docs.some((d) => d.linkState === "linked");
  return (
    <div className="sow-docpack">
      <span className="sow-project-items-label">Managed docs</span>
      <ul className="sow-docpack-list" role="list">
        {docs.map((d) => (
          <li className="sow-docpack-row" role="listitem" key={d.slot} data-slot={d.slot}>
            <span className="sow-docpack-title">{d.title}</span>
            <span className={`sow-docpack-state sow-docpack-state--${d.linkState}`}>
              {d.linkState === "linked" ? d.syncState : "unlinked"}
            </span>
            {d.linkState === "unlinked" ? (
              <button
                className="sow-docpack-readd"
                type="button"
                disabled
                title="Connect a Google Drive connector to link the managed NotebookLM docs"
              >
                Re-add
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!anyLinked ? (
        <div className="sow-docpack-hint">Connect a Google Drive connector to link the managed NotebookLM docs (00–04).</div>
      ) : null}
    </div>
  );
}

/** The detail pane for the selected project — full deterministic-progress breakdown. */
function ProjectDetail({ project }: { readonly project: UiSafeProjectDashboard }): ReactElement {
  return (
    <div className="sow-project-detail" aria-label={`${project.title} detail`}>
      <div className="sow-project-detail-head">
        <h2 className="sow-project-detail-title">{project.title}</h2>
        <span className="sow-project-status">{project.status}</span>
      </div>
      <div
        className="sow-project-progress"
        role="progressbar"
        aria-valuenow={project.progress.percentComplete}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* width is the SERVER-provided deterministic percent — never a UI computation. */}
        <div className="sow-project-bar" style={{ width: `${project.progress.percentComplete}%` }} />
      </div>
      <div className="sow-project-counts">
        {project.progress.completedCount}/{project.progress.totalCount} · {project.progress.percentComplete}% complete
      </div>
      {project.blockers.length > 0 && <ProjectItems label="Blockers" items={project.blockers} />}
      {project.waitingItems.length > 0 && <ProjectItems label="Waiting on" items={project.waitingItems} />}
      {project.nextActions.length > 0 && <ProjectItems label="Next" items={project.nextActions} />}
      {project.evidenceRefs.length > 0 && (
        <div className="sow-project-evidence">
          {project.evidenceRefs.map((ref, i) => (
            <span className="sow-evidence-chip" key={i}>
              {ref}
            </span>
          ))}
        </div>
      )}
      <ManagedDocPack docPack={project.docPack} />
    </div>
  );
}

export function Projects(props: ProjectsProps): ReactElement {
  const { scope, projects, selectedProjectId, onSelectProject } = props;
  const selected = resolveSelectedProject(projects, selectedProjectId);

  return (
    <main className="sow-content" aria-label="Projects">
      <div className="sow-page-head">
        <div>
          <h1>Projects</h1>
          {scope !== "global" && projects.length > 0 ? (
            <div className="sow-subtitle">
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </div>
          ) : null}
        </div>
      </div>

      {scope === "global" ? (
        // WS-8: Projects is workspace-scoped; the Global aggregate never blends project data.
        <div className="sow-empty" role="status">
          Select a workspace to see its projects
        </div>
      ) : projects.length === 0 ? (
        // A workspace with no projects yet (empty-until-data — no synthetic seed).
        <div className="sow-empty" role="status">
          No projects in this workspace yet
        </div>
      ) : (
        <div className="sow-projects-page">
          <div className="sow-projects-list" role="listbox" aria-label="Projects">
            {projects.map((p) => (
              <ProjectListItem
                key={p.projectId}
                project={p}
                selected={selected?.projectId === p.projectId}
                onSelect={onSelectProject}
              />
            ))}
          </div>
          {selected !== undefined ? <ProjectDetail project={selected} /> : null}
        </div>
      )}
    </main>
  );
}
