// Task 9.19 — DEV-ONLY demo-seed (worker leg). RED-first spec.
//
// `seedDemoData` is a vault-FREE, flag-gated dev fixture that writes representative rows across the
// FULL Global Today read-model (dashboard_cards + global_surface + per-workspace workspace/project
// cards + project_dashboards + recent_changes + ingestion_inbox + registry, for 3 demo workspaces),
// so `SOW_DEMO_SEED=1 ./dev.sh` browses a populated dashboard with ZERO model calls / egress /
// Keychain. Read-model-ONLY (rebuildable), STRICT `=== "1"` gate (default OFF ⇒ byte-equivalent boot),
// never Markdown / never KnowledgeWriter / never secrets, never-throws at boot (§16).
//
// The happy-path pins run over REAL `assembleBackends` (in-memory sqlite) exercising the REAL
// read-model repo; the OFF-gate + fault pins inject a spy/faulting `ReadModelRepository`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, isOk, isErr, type Result } from "@sow/contracts";
import {
  UiSafeRecentChangeSchema,
  UiSafeIngestionItemSchema,
  UiSafeProjectDashboardSchema,
  GclProjectionSchema,
} from "@sow/contracts";
import { computePercent } from "@sow/workflows";
import type { DbError, ReadModelRepository, ReadModelRecord } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import { seedDemoData, maybeSeedDemoData, DEMO_WORKSPACE_IDS } from "../../src/composition/demoSeed";

const NOW = "2026-07-24T00:00:00.000Z";

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});
async function fresh(): Promise<ProofSpineBackends> {
  const b = await assembleBackends({ now: () => NOW });
  open.push(b);
  return b;
}
/** Pluck a named array off a seeded read-model row (null-scoped when ws omitted). */
async function rowArray(b: ProofSpineBackends, key: string, ws: string | null, arrayKey: string): Promise<unknown[]> {
  const r = await b.repos.readModels.get(key, ws);
  if (!isOk(r)) return [];
  const data = r.value.data as Record<string, unknown>;
  const arr = data[arrayKey];
  return Array.isArray(arr) ? arr : [];
}
async function registryIds(b: ProofSpineBackends): Promise<readonly string[]> {
  const r = await b.repos.readModels.get(READ_MODEL_KEYS.registry, null);
  if (!isOk(r)) return [];
  const ids = (r.value.data as { workspaceIds?: unknown }).workspaceIds;
  return Array.isArray(ids) ? (ids.filter((x) => typeof x === "string") as string[]) : [];
}

/** A spy `ReadModelRepository` counting puts (OFF-gate pin) — get returns not_found (empty). */
function spyRepo(): { repo: ReadModelRepository; count: () => number } {
  let puts = 0;
  const repo: ReadModelRepository = {
    get: async (): Promise<Result<ReadModelRecord, DbError>> => err({ code: "not_found", message: "x" }),
    put: async (r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> => {
      puts += 1;
      return ok(r);
    },
    clear: async (): Promise<Result<void, DbError>> => ok(undefined),
  };
  return { repo, count: () => puts };
}

describe("demoSeed (9.19 — vault-free full-Today dev fixture, read-model-only, byte-equivalent OFF)", () => {
  it("seed_populates_every_today_read_model_key: dashboard + global + per-ws cards/projects/changes/ingestion + registry — spec(§11) spec(§10)", async () => {
    const b = await fresh();
    const res = await seedDemoData({ readModels: b.repos.readModels, now: b.now });
    expect(isOk(res)).toBe(true);
    // Global (null-scoped) aggregates.
    expect((await rowArray(b, READ_MODEL_KEYS.dashboard, null, "cards")).length).toBeGreaterThan(0);
    expect((await rowArray(b, READ_MODEL_KEYS.global, null, "projections")).length).toBeGreaterThan(0);
    // Registry knows all 3 demo workspaces.
    for (const ws of DEMO_WORKSPACE_IDS) expect(await registryIds(b)).toContain(ws);
    // Per-workspace surfaces.
    for (const ws of DEMO_WORKSPACE_IDS) {
      expect((await rowArray(b, READ_MODEL_KEYS.workspace, ws, "cards")).length).toBeGreaterThan(0);
      expect((await rowArray(b, READ_MODEL_KEYS.project, ws, "cards")).length).toBeGreaterThan(0);
      expect((await rowArray(b, READ_MODEL_KEYS.projectDashboards, ws, "projects")).length).toBeGreaterThan(0);
      expect((await rowArray(b, READ_MODEL_KEYS.recentChanges, ws, "changes")).length).toBeGreaterThan(0);
      expect((await rowArray(b, READ_MODEL_KEYS.ingestion, ws, "items")).length).toBeGreaterThan(0);
    }
  });

  it("seeded_rows_pass_the_live_sanitize_regate: every seeded row parses through its FROZEN schema (shapes == the real projection contract) — spec(§10)", async () => {
    const b = await fresh();
    await seedDemoData({ readModels: b.repos.readModels, now: b.now });
    // Global GCL projections pass the §6 GclProjectionSchema refine. (Presence-guarded so the schema
    // assertions can't pass vacuously on a silently-empty seed.)
    const projections = await rowArray(b, READ_MODEL_KEYS.global, null, "projections");
    expect(projections.length).toBeGreaterThan(0);
    for (const p of projections) expect(GclProjectionSchema.safeParse(p).success).toBe(true);
    for (const ws of DEMO_WORKSPACE_IDS) {
      const changes = await rowArray(b, READ_MODEL_KEYS.recentChanges, ws, "changes");
      const items = await rowArray(b, READ_MODEL_KEYS.ingestion, ws, "items");
      const projects = await rowArray(b, READ_MODEL_KEYS.projectDashboards, ws, "projects");
      expect(changes.length + items.length + projects.length).toBeGreaterThan(0); // non-vacuous
      for (const c of changes) expect(UiSafeRecentChangeSchema.safeParse(c).success).toBe(true);
      for (const i of items) expect(UiSafeIngestionItemSchema.safeParse(i).success).toBe(true);
      for (const p of projects) {
        const parsed = UiSafeProjectDashboardSchema.safeParse(p);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          // REQ-F-011 cross-field consistency the sanitize re-gate additionally enforces.
          const pr = parsed.data.progress;
          expect(pr.completedCount).toBeLessThanOrEqual(pr.totalCount);
          expect(pr.percentComplete).toBe(computePercent(pr.completedCount, pr.totalCount));
        }
      }
    }
  });

  it("off_is_byte_equivalent_zero_writes: STRICT gate — unset/'0'/'true' ⇒ no seed, ZERO puts — spec(§10) [dev-gate]", async () => {
    for (const env of [{}, { SOW_DEMO_SEED: "0" }, { SOW_DEMO_SEED: "true" }, { SOW_DEMO_SEED: " 1" }]) {
      const s = spyRepo();
      const res = await maybeSeedDemoData(env, { readModels: s.repo, now: () => NOW });
      expect(res).toBeUndefined(); // OFF ⇒ the gate builds nothing
      expect(s.count()).toBe(0); // byte-equivalent — zero writes
    }
    // ON ("1", strict) DOES seed (a non-zero put count) — the gate's positive edge.
    const on = spyRepo();
    const onRes = await maybeSeedDemoData({ SOW_DEMO_SEED: "1" }, { readModels: on.repo, now: () => NOW });
    expect(onRes).toBeDefined();
    expect(on.count()).toBeGreaterThan(0);
  });

  it("seed_is_read_model_only: the module imports NO KnowledgeWriter/secret/egress/connector dep — spec(§5) [rule 1/2]", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/composition/demoSeed.ts", import.meta.url)), "utf8");
    // Match FULL import STATEMENTS (multi-line safe — a `} from "..."` line does NOT start with
    // `import`), scanning the module specifier + the imported symbols but NOT the header-comment prose
    // (which legitimately names KnowledgeWriter/egress/secrets in the safety posture).
    const imports = [...src.matchAll(/import[\s\S]*?from\s*["']([^"']+)["']/g)];
    expect(imports.length).toBeGreaterThan(0); // the scan actually found the imports (non-vacuous)
    for (const m of imports) {
      expect(m[1]).not.toMatch(/@sow\/knowledge/); // module specifier — never the sole-writer package
      expect(m[0]).not.toMatch(/KnowledgeWriter|applyPlan|SecretsPort|Keychain|egress|connector/i); // symbols
    }
    // Positive: it DOES go through the read-model repo (the only write surface).
    expect(src).toMatch(/ReadModelRepository|workspaceRegistry|provisionDev/);
  });

  it("seed_is_idempotent: seeding twice upserts (no duplicate rows) — spec(§10)", async () => {
    const b = await fresh();
    const ws0 = DEMO_WORKSPACE_IDS[0]!;
    await seedDemoData({ readModels: b.repos.readModels, now: b.now });
    const firstDash = (await rowArray(b, READ_MODEL_KEYS.dashboard, null, "cards")).length;
    const firstWsChanges = (await rowArray(b, READ_MODEL_KEYS.recentChanges, ws0, "changes")).length;
    await seedDemoData({ readModels: b.repos.readModels, now: b.now });
    expect((await rowArray(b, READ_MODEL_KEYS.dashboard, null, "cards")).length).toBe(firstDash);
    expect((await rowArray(b, READ_MODEL_KEYS.recentChanges, ws0, "changes")).length).toBe(firstWsChanges);
    expect(await registryIds(b)).toHaveLength(DEMO_WORKSPACE_IDS.length); // registry not doubled
  });

  it("seed_fault_never_crashes_boot: a readModels.put fault ⇒ a typed err, NO throw — spec(§16)", async () => {
    const faulting: ReadModelRepository = {
      get: async (): Promise<Result<ReadModelRecord, DbError>> => err({ code: "not_found", message: "x" }),
      put: async (): Promise<Result<ReadModelRecord, DbError>> => err({ code: "unavailable", message: "store down" }),
      clear: async (): Promise<Result<void, DbError>> => ok(undefined),
    };
    // Returns a Result unconditionally (Lesson 15 — never assertions-only-in-catch).
    const res = await seedDemoData({ readModels: faulting, now: () => NOW });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    // The gate helper folds the same typed err (no throw crossing the boot seam).
    const gated = await maybeSeedDemoData({ SOW_DEMO_SEED: "1" }, { readModels: faulting, now: () => NOW });
    expect(gated !== undefined && isErr(gated)).toBe(true);
  });
});
