// Task 9.19 — a DEV-ONLY, flag-gated demo-seed that populates the FULL Global Today read-model with
// vault-FREE representative fixtures, so `SOW_DEMO_SEED=1 ./dev.sh` browses a populated daily briefing
// (dashboard cards, GCL global surface, recent changes, ingestion inbox, projects) with ZERO model
// calls, egress, arming, or Keychain.
//
// This is the 9.4 "empty-until-data, no seed" decision's strictly-gated DEV EXCEPTION. It mirrors
// `provisionDev.ts` (reuses its shape-correct upsert helpers so every seeded row passes the live
// read-side `sanitize*` re-gate) but drives from FIXTURES (no vault, no Markdown parse) and ADDS the
// keys provisionDev omits: the global `dashboard_cards` aggregate, the `global_surface` GCL surface
// (Q5 — the renderer's Global scope reads BOTH), and `ingestion_inbox`.
//
// SAFETY (the lead was emphatic): read-model-ONLY — it writes ONLY rebuildable `read_models` rows via
// `readModels.put` + the fail-closed WS-8 `registerWorkspace`. It NEVER writes Markdown, never routes a
// KnowledgeMutationPlan / calls KnowledgeWriter, never touches secrets or egress — the one-writer
// (KN-4/KN-9) + candidate-gate postures are structurally untouched. STRICT `=== "1"` gate: default OFF
// ⇒ a byte-equivalent boot with ZERO writes. Never throws (§16) — a store fault degrades to a typed err.
//
// ⚠ WS-8 CAUTION: the global `dashboard_cards` aggregate is written UNGATED and cross-workspace (cards
// from all 3 buckets incl. employer-work). This is safe ONLY because every fixture value below is a
// hardcoded, developer-authored, NON-SENSITIVE constant (no raw content, no real employer data) — the
// Global aggregate is un-visibility-gated, so this file must NEVER be extended with real/sensitive strings.
// ⚠ NO TEARDOWN: a re-seed REPLACES (idempotent, never duplicates) but never CLEARS. After one
// `SOW_DEMO_SEED=1` boot the 3 demo workspaces stay unioned into the production registry and the fixture
// rows persist after the flag is unset, until a read-model rebuild / `clear`. Dev-hygiene only (canonical
// bucket ids, rebuildable rows, no leak) — not a real-data path.
import { ok, err, isErr, type Result } from "@sow/contracts";
import {
  MANAGED_DOC_SLOTS,
  collapseToSummaryLine,
  workspaceId as toWorkspaceId,
  sourceId as toSourceId,
  type GclProjection,
  type UiSafeIngestionItem,
  type UiSafeProjectDashboard,
  type UiSafeRecentChange,
  type VisibilityLevel,
} from "@sow/contracts";
import { computePercent } from "@sow/workflows";
import type { ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS, readIngestionItems } from "../api/adapters/readModel";
import type { DashboardCardSource } from "../api/projections/uiSafe";
// Reuse the ONE shape-correct upsert implementation (exported from the dev provisioner, shape parity
// with the live query router's `sanitize*` re-gate) rather than duplicating it here.
import {
  upsertCardRow,
  upsertProjectRow,
  upsertRecentChangeRow,
  type DevProvisionError,
} from "./provisionDev";
import { registerWorkspace } from "./workspaceRegistry";

/** The narrow deps the demo-seed needs — the read-model repo + a clock. Read-model-ONLY (no vault,
 *  no KnowledgeWriter, no secrets, no egress). */
export interface SeedDemoDeps {
  readonly readModels: ReadModelRepository;
  readonly now: () => string;
}

// ── the representative fixture data (vault-free) ────────────────────────────────

interface DemoProject {
  readonly id: string;
  readonly title: string;
  readonly completed: number;
  readonly total: number;
}
interface DemoWorkspace {
  readonly workspaceId: string;
  readonly projects: readonly DemoProject[];
  readonly recentChanges: readonly { readonly id: string; readonly kind: string; readonly summary: string }[];
  readonly ingestion: readonly {
    readonly sourceId: string;
    readonly type: string;
    readonly sensitivity: string;
    readonly summary: string;
  }[];
  /** Cross-workspace GCL surface rows (Global Today) — sanitized summary values only (§6). */
  readonly gcl: readonly { readonly projectionType: string; readonly summary: string }[];
}

/** One demo workspace per bucket (employer-work / personal-business / personal-life). */
const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    workspaceId: "employer-work",
    projects: [
      { id: "q3-roadmap", title: "Q3 Roadmap", completed: 6, total: 10 },
      { id: "vendor-review", title: "Vendor Review", completed: 2, total: 4 },
    ],
    recentChanges: [
      { id: "roadmap-sync", kind: "project-synced", summary: "Q3 Roadmap — synced 6/10 tasks (60%)" },
      { id: "vendor-decision", kind: "decision-logged", summary: "Vendor review — decision logged: proceed with Acme" },
    ],
    ingestion: [
      { sourceId: "demo:employer:standup", type: "note", sensitivity: "normal", summary: "Standup notes awaiting triage" },
    ],
    gcl: [{ projectionType: "calendar_busy", summary: "3 meetings today" }],
  },
  {
    workspaceId: "personal-business",
    projects: [{ id: "sow-launch", title: "SoW Launch", completed: 8, total: 12 }],
    recentChanges: [
      { id: "shipped-briefing", kind: "project-synced", summary: "SoW Launch — synced 8/12 tasks (67%)" },
    ],
    ingestion: [
      { sourceId: "demo:business:podcast", type: "podcast", sensitivity: "normal", summary: "Podcast episode awaiting triage" },
    ],
    gcl: [{ projectionType: "project_status", summary: "2 active projects" }],
  },
  {
    workspaceId: "personal-life",
    projects: [{ id: "home-reno", title: "Home Reno", completed: 3, total: 8 }],
    recentChanges: [
      { id: "reno-task", kind: "project-synced", summary: "Home Reno — synced 3/8 tasks (38%)" },
    ],
    ingestion: [
      { sourceId: "demo:life:article", type: "web", sensitivity: "normal", summary: "Saved article awaiting triage" },
    ],
    gcl: [{ projectionType: "calendar_busy", summary: "1 appointment this week" }],
  },
];

/** The representative demo workspaces (one per bucket) — exported for reachability tests. */
export const DEMO_WORKSPACE_IDS: readonly string[] = DEMO_WORKSPACES.map((w) => w.workspaceId);

// ── local upsert helpers for the keys provisionDev omits ────────────────────────

/** Overwrite a GLOBAL (null-scoped) read-model row with a full representative array (idempotent — the
 *  demo owns these aggregates; a re-seed replaces, never duplicates). */
async function putGlobalRow(
  readModels: ReadModelRepository,
  readModelKey: string,
  data: Record<string, unknown>,
  at: string,
): Promise<Result<void, DevProvisionError>> {
  const put = await readModels.put({ readModelKey, data, rebuiltAt: at });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: `read-model put failed: ${readModelKey}` });
}

/** UPSERT one ingestion item (by `sourceId`) into the workspace's `ingestion_inbox` row, preserving
 *  siblings — the same shape the 9.16 producer writes + the read-side `sanitizeIngestionInbox` re-gates. */
async function upsertIngestionItem(
  readModels: ReadModelRepository,
  workspaceId: string,
  item: UiSafeIngestionItem,
  at: string,
): Promise<Result<void, DevProvisionError>> {
  const existing = await readModels.get(READ_MODEL_KEYS.ingestion, workspaceId);
  if (isErr(existing) && existing.error.code !== "not_found") {
    return err({ code: "store_fault", message: "ingestion-inbox get failed" });
  }
  const prior = existing.ok ? readIngestionItems(existing.value.data) : [];
  const items = [...prior.filter((i) => i.sourceId !== item.sourceId), item];
  const put = await readModels.put({ readModelKey: READ_MODEL_KEYS.ingestion, workspaceId, data: { items }, rebuiltAt: at });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: "ingestion-inbox put failed" });
}

/** Build a representative `UiSafeProjectDashboard` with a deterministic, consistent progress triple
 *  (percentComplete === computePercent(counts)) so it passes the REQ-F-011 re-validation. */
function buildProjectDashboard(workspaceId: string, project: DemoProject, at: string): UiSafeProjectDashboard {
  const percent = computePercent(project.completed, project.total);
  return {
    projectId: `${workspaceId}:${project.id}`,
    title: project.title,
    status: percent === 100 ? "done" : percent === 0 ? "not-started" : "in-progress",
    progress: { completedCount: project.completed, totalCount: project.total, percentComplete: percent },
    blockers: [],
    waitingItems: [],
    nextActions: [],
    evidenceRefs: [],
    docPack: MANAGED_DOC_SLOTS.map((s) => ({
      slot: s.slot,
      title: s.title,
      linkState: "unlinked" as const,
      syncState: "unknown" as const,
    })),
    updatedAt: at,
  };
}

/** Build a representative sanitized GCL projection (short single-line summary value only — §6). */
function buildGclProjection(workspaceId: string, projectionType: string, summary: string): GclProjection {
  return {
    workspaceId: toWorkspaceId(workspaceId),
    visibilityLevel: "coordination" as VisibilityLevel,
    projectionType,
    sanitizedPayload: { summary: collapseToSummaryLine(summary) },
    sourceRefs: [{ sourceId: toSourceId(`demo:${workspaceId}`) }],
  };
}

// ── the seed ────────────────────────────────────────────────────────────────────

/**
 * Write representative rows across the FULL Global Today read-model. Read-model-ONLY, idempotent
 * (upsert / overwrite by stable id), fail-CLOSED on the first store fault (typed `store_fault`,
 * never a masked partial), never throws (§16).
 */
export async function seedDemoData(deps: SeedDemoDeps): Promise<Result<void, DevProvisionError>> {
  const { readModels, now } = deps;
  try {
    const at = now();

    // Per-workspace surfaces + the cross-workspace GCL aggregate + the global dashboard aggregate.
    const dashboardCards: DashboardCardSource[] = [];
    const gclProjections: GclProjection[] = [];

    for (const ws of DEMO_WORKSPACES) {
      for (const p of ws.projects) {
        const card: DashboardCardSource = {
          cardId: `${ws.workspaceId}:project:${p.id}`,
          kind: "project",
          title: p.title,
          status: "ok",
          count: computePercent(p.completed, p.total),
          updatedAt: at,
        };
        // Workspace + project scoped cards (the per-workspace Today surfaces).
        const wsPut = await upsertCardRow(readModels, READ_MODEL_KEYS.workspace, ws.workspaceId, card, at);
        if (isErr(wsPut)) return wsPut;
        const projPut = await upsertCardRow(readModels, READ_MODEL_KEYS.project, ws.workspaceId, card, at);
        if (isErr(projPut)) return projPut;
        // The rich Projects-surface row (§9.5) — consistent deterministic progress.
        const pdPut = await upsertProjectRow(readModels, ws.workspaceId, buildProjectDashboard(ws.workspaceId, p, at), at);
        if (isErr(pdPut)) return pdPut;
        // Accumulate one representative card into the GLOBAL dashboard aggregate.
        dashboardCards.push(card);
      }
      for (const rc of ws.recentChanges) {
        const change: UiSafeRecentChange = {
          changeId: `${ws.workspaceId}:${rc.id}`,
          kind: rc.kind,
          summary: collapseToSummaryLine(rc.summary),
          occurredAt: at,
        };
        const rcPut = await upsertRecentChangeRow(readModels, ws.workspaceId, change, at);
        if (isErr(rcPut)) return rcPut;
      }
      for (const ing of ws.ingestion) {
        const item: UiSafeIngestionItem = {
          sourceId: ing.sourceId,
          type: ing.type,
          sensitivity: ing.sensitivity,
          summary: collapseToSummaryLine(ing.summary),
        };
        const ingPut = await upsertIngestionItem(readModels, ws.workspaceId, item, at);
        if (isErr(ingPut)) return ingPut;
      }
      for (const g of ws.gcl) gclProjections.push(buildGclProjection(ws.workspaceId, g.projectionType, g.summary));

      // Register the workspace as KNOWN (the fail-closed WS-8 visibility authority) so its scoped
      // reads resolve. Union — preserves any prior members.
      const reg = await registerWorkspace(readModels, ws.workspaceId, at);
      if (isErr(reg)) return err({ code: "store_fault", message: "workspace registry union failed" });
    }

    // The GLOBAL (null-scoped) Today aggregates the Global scope reads (Q5 — both).
    const dashPut = await putGlobalRow(readModels, READ_MODEL_KEYS.dashboard, { cards: dashboardCards }, at);
    if (isErr(dashPut)) return dashPut;
    const gclPut = await putGlobalRow(readModels, READ_MODEL_KEYS.global, { projections: gclProjections }, at);
    if (isErr(gclPut)) return gclPut;

    return ok(undefined);
  } catch {
    // Defense-in-depth: even a contract-violating throw from a backend degrades to a typed err (§16) —
    // the dev fixture must never crash boot.
    return err({ code: "store_fault", message: "demo seed faulted" });
  }
}

/**
 * The STRICT default-OFF boot gate: seed ONLY when `SOW_DEMO_SEED === "1"` (strict — not truthy). OFF /
 * absent ⇒ `undefined` (a byte-equivalent boot, ZERO writes). Pure over the injected env + deps so the
 * gate is unit-testable; `bootWorker` calls it with `process.env` after the read-model repo is available.
 */
export async function maybeSeedDemoData(
  env: { readonly SOW_DEMO_SEED?: string },
  deps: SeedDemoDeps,
): Promise<Result<void, DevProvisionError> | undefined> {
  if (env.SOW_DEMO_SEED !== "1") return undefined;
  return seedDemoData(deps);
}
