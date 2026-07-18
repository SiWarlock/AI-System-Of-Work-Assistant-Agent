// @sow/worker — the proof-spine COMPOSITION ROOT (backends half).
//
// This module binds the pure @sow/workflows activity factories to the REAL
// downstream adapters (@sow/db · @sow/knowledge · @sow/integrations · @sow/providers
// · @sow/policy) and marks every per-vendor TRANSPORT as a clearly-labelled
// injection point. It is the ONLY place in the worker allowed to open a database,
// a vault, or a vendor client — the activities themselves stay effect-injected and
// unit-testable (root CLAUDE.md two-layer split).
//
// IMPORT DIRECTION (root CLAUDE.md §2.5): apps/worker may import every @sow/*
// package. It NEVER makes @sow/db import @sow/integrations — the ReceiptStore
// adapter below is exactly the worker-layer bridge the @sow/db
// `WriteReceiptRepository` doc calls for ("the worker layer adapts this @sow/db repo
// onto the integrations `ReceiptStore` interface").
//
// TRANSPORT INJECTION POINTS (carry-forward): the real vendor SDKs (a model
// provider HTTP client, a per-target write client, the GBrain index client, the
// correlation signal source) are NOT this slice. Each seam below is a DETERMINISTIC
// STUB marked `// REAL-SDK INJECTION POINT (carry-forward: vendor transport)` so the
// spine is provably wired end-to-end now and the real transports drop in later
// without touching the activities.
//
// §16: every adapter method returns a typed value / Result — nothing throws across
// a boundary the activities consume.
import { mkdtempSync, existsSync } from "node:fs";
import { readFile, readdir, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

import {
  isErr,
  KnowledgeMutationPlanSchema,
  ProposedActionSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  PROPOSED_ACTION_SCHEMA_ID,
} from "@sow/contracts";
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  TargetSystem,
  WriteReceipt,
  HealthItem,
  FailureClass,
  AuditId,
  LogRecord,
} from "@sow/contracts";

// ── @sow/db: the real operational store (sqlite + genesis migration) ──────────
import {
  createSqliteRepositories,
  createSqliteMigrationEngine,
  applyMigrations,
  type SqliteRepositories,
  type WriteReceiptRepository,
  type ReserveOutcome,
  type WriteReceiptRow,
  type DbError,
} from "@sow/db";

// ── @sow/integrations: the Tool Gateway seams the worker adapts onto ──────────
import type {
  ReceiptStore,
  ReceiptRecord,
  ReceiptReservation,
} from "@sow/integrations";
import {
  makeTargetWriteAdapter,
  type AdapterTransport,
  type AdapterTransportRequest,
  type TransportResponse,
  type TargetWriteAdapter,
} from "@sow/integrations";

// ── @sow/knowledge: the sole Markdown writer + the GBrain index seam ──────────
import type { VaultFs } from "@sow/knowledge";
import type {
  IndexApplyClient,
  IndexApplyRequest,
  IndexApplyReceipt,
  IndexApplyError,
} from "@sow/knowledge";
import type { Result } from "@sow/contracts";
import { ok, err } from "@sow/contracts";

// ── @sow/providers: the Broker + its deterministic gate stubs ─────────────────
import {
  createBroker,
  createHealthGate,
  createSchemaGate,
  makeAgentResult,
  type Broker,
  type BrokerJobRequest,
  type BrokerOutcome,
  type ProviderRunner,
  type HealthGateSources,
  type BudgetDefaults,
} from "@sow/providers";
import type { AgentResult, TokenPricing } from "@sow/providers";

// ── @sow/policy: the fail-closed approval unwrap ──────────────────────────────
import {
  requiresApproval,
  isAllow,
  buildAuditSignal,
  type PolicyDecision,
  type ApprovalVerdict,
  type ResolvedWorkspacePolicy,
  type LocalProviderConfig,
} from "@sow/policy";

// ── @sow/workflows: the operational persistence ports (health · schedule · lease) ─
import type {
  HealthItemStore,
  ScheduleStore,
  InstanceLeaseStore,
} from "@sow/workflows/ports/operational";

// ── worker composition: the operational-truth store adapters + the logger seam ─
import {
  createHealthItemStoreAdapter,
  createScheduleStoreAdapter,
  createInstanceLeaseStoreAdapter,
} from "./store-adapters";
import { createLogger, type Logger, type LogSink } from "../observability/logger";
import { selectProviderRunner, selectHealthSources, type ProviderTransportGate } from "./provider-runner";
import {
  createLedgeredBudgetGate,
  createSingleRunBudgetLedger,
  DEFAULT_BUDGET_DEFAULTS,
  DEFAULT_PROVIDER_PRICING,
  type BudgetLedgerPort,
} from "./budget-ledger";

// ---------------------------------------------------------------------------
// (0) config
// ---------------------------------------------------------------------------

/**
 * The default-OFF owner gate for the outbound external-write {@link AdapterTransport}
 * (the per-target vendor write client). Both locks are required to select a REAL
 * transport, and each alone keeps it OFF (AND-composed OFF-locks):
 *  - `enabled` must be STRICTLY `=== true` (a truthy `1`/`"true"`/`{}` never arms), and
 *  - `make` must be an owner-provisioned factory that constructs the real transport.
 *
 * Absent/false either lock ⇒ the deterministic in-memory stub
 * ({@link createStubAdapterTransport}) — so the shipped default (this field unset) is
 * BYTE-EQUIVALENT and fully dormant, and a real external write can be enabled ONLY by
 * deliberate owner config, never by editing a hardcoded call site (§8 external-write
 * envelope; root CLAUDE.md safety rule 3). The real factory ships UNBOUND.
 */
export interface WriteTransportGate {
  /** STRICT `=== true` to arm the real transport; anything else ⇒ stub. */
  readonly enabled?: boolean;
  /** Owner-provisioned real-transport factory; unbound ⇒ stub (never invoked on OFF). */
  readonly make?: () => AdapterTransport;
}

/**
 * Worker-backend configuration. A tmpdir vault + an in-memory sqlite are the
 * defaults so a test (or a first-boot smoke run) needs no external state; a real
 * deployment passes a durable `dbPath` + `vaultRoot`.
 */
export interface BackendsConfig {
  /** better-sqlite3 database path. `:memory:` (the default) is fine for tests. */
  readonly dbPath?: string;
  /** Vault root the KnowledgeWriter commits under. Defaults to a fresh tmpdir. */
  readonly vaultRoot?: string;
  /** Wall clock (ISO-8601). Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * The single local zero-egress endpoint the broker's localConfig admits. The
   * Phase-3/5 carry-forward requires localConfig ALWAYS be supplied to the broker
   * (never undefined), so the meeting.close job can never silently widen to a cloud
   * route.
   */
  readonly allowedLocalEndpoints?: readonly string[];
  /**
   * The REDACTED-log sink `createLogger` writes to. Defaults to an NDJSON line per
   * record on `process.stderr` (the standard structured-log destination — every
   * record is already redaction-safe, so no raw content or secret reaches it). A test
   * injects a capture sink; a deployment may point it at a file/collector.
   */
  readonly logSink?: LogSink;
  /**
   * Default-OFF owner gate for the outbound external-write {@link AdapterTransport}.
   * UNSET (the shipped default) ⇒ the deterministic stub — byte-equivalent + dormant.
   * A real vendor transport is selectable ONLY by deliberate owner config satisfying
   * BOTH locks (see {@link WriteTransportGate}); the real factory ships UNBOUND.
   */
  readonly writeTransport?: WriteTransportGate;
  /**
   * Default-OFF owner gate for the real ModelProvider {@link ProviderRunner} (the broker's
   * §7 run leg — 18.1). UNSET (the shipped default) ⇒ the deterministic `createStubProviderRunner`
   * — byte-equivalent + dormant. A real runner is selectable ONLY by deliberate owner config
   * satisfying BOTH locks (strict `enabled === true` AND an owner-provisioned `make` factory);
   * the real network transport + provider key are bound by `make` at the owner crossing (§19.5).
   * Mirrors {@link WriteTransportGate}; the real factory ships UNBOUND.
   */
  readonly providerTransport?: ProviderTransportGate;
  /**
   * The broker's §7 HEALTH gate sources (5.9 provider-reachability + model-availability).
   * UNSET ⇒ the inert/config-driven safe-build default ({@link DEFAULT_HEALTH_SOURCES}):
   * healthy + model-present + conformance-passing for the routable provider, no network
   * reachability probe (deferred to the owner crossing). A deploy binds the real probes;
   * a test injects a fake unhealthy source to exercise the deny path. Deny-only policing.
   */
  readonly healthSources?: HealthGateSources;
  /**
   * The COST-1/COST-2 budget default caps the real BUDGET gate enforces. UNSET ⇒
   * {@link DEFAULT_BUDGET_DEFAULTS} (mirrors config/providers.defaults.json §budgets).
   */
  readonly budgetDefaults?: BudgetDefaults;
  /**
   * CP-5b — the per-ProviderId token pricing the BUDGET gate meters cost against (COST-1 dollar cap).
   * UNSET ⇒ {@link DEFAULT_PROVIDER_PRICING} (the conservative fail-safe placeholder; deny-only ships
   * ON, worker L44). Absent/empty for a given provider ⇒ that route's cost is UNMEASURED and degrades
   * to the runtime-only backstop (never a false cost-cheap). A deployment/test overrides to inject or
   * to force the runtime-only degrade (`{}`).
   */
  readonly budgetPricing?: Readonly<Record<string, TokenPricing>>;
  /**
   * The pluggable single-run budget ledger the BUDGET gate accounts each run into.
   * UNSET ⇒ a fresh {@link createSingleRunBudgetLedger} (in-boot only). The §19.11
   * durable cross-run ledger plugs in here (backward — no forward dependency).
   */
  readonly budgetLedger?: BudgetLedgerPort;
}

// ---------------------------------------------------------------------------
// (1) sqlite open + genesis migration
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);

/** Resolve the @sow/db genesis SQLite migrations folder from the installed package. */
function resolveSqliteMigrationsFolder(): string {
  // @sow/db ships `migrations/sqlite/{meta/_journal.json,0000_genesis.sql}`. Resolve
  // the package entry (`.../packages/db/src/index.ts`) then ascend to the package root
  // (the parent of `src`) and take its `migrations/sqlite` sibling. Drizzle's migrator
  // reads `meta/_journal.json` under the folder, so that is the presence guard.
  const dbEntry = require_.resolve("@sow/db");
  let dir = dirname(dbEntry); // .../packages/db/src
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "migrations", "sqlite");
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate @sow/db migrations/sqlite genesis folder");
}

/** A live sqlite handle + the repositories built over it. */
export interface OpenDatabase {
  readonly db: unknown; // the drizzle BetterSQLite3Database (opaque here)
  readonly conn: { close(): void };
  readonly repos: SqliteRepositories;
}

/**
 * Open better-sqlite3, run the genesis migration through the REAL §4 lifecycle
 * (createSqliteMigrationEngine → applyMigrations), and build the operational-store
 * repositories. The genesis migration materializes the write_receipts table + the
 * (targetSystem, canonicalObjectKey) / idempotencyKey unique indexes the exactly-once
 * gate relies on. Throws only on a genuine unrecoverable open/migrate fault (a
 * composition-root boot failure is the one place a throw is appropriate — there is
 * no caller to fold it for).
 */
export async function openDatabase(config: BackendsConfig = {}): Promise<OpenDatabase> {
  // better-sqlite3 + drizzle are loaded through the worker's own resolution so the
  // native binding is the workspace-hoisted one.
  const Database = require_("better-sqlite3") as new (path: string) => {
    close(): void;
  };
  const { drizzle } = require_("drizzle-orm/better-sqlite3") as {
    drizzle: (conn: unknown) => unknown;
  };

  const conn = new Database(config.dbPath ?? ":memory:");
  const engine = createSqliteMigrationEngine(conn as never);
  const migrated = await applyMigrations(engine, {
    migrationsFolder: resolveSqliteMigrationsFolder(),
  });
  if (isErr(migrated)) {
    throw new Error(
      `worker composition: genesis migration failed (${migrated.error.reason}): ${migrated.error.message}`,
    );
  }
  // The engine owns the live connection (restore swaps it) — read it back.
  const live = engine.connection as unknown as { close(): void };
  const db = drizzle(live);
  const repos = createSqliteRepositories(db as never);
  return { db, conn: live, repos };
}

// ---------------------------------------------------------------------------
// (2) VaultFs — a real filesystem-backed vault for the KnowledgeWriter
// ---------------------------------------------------------------------------

/**
 * A real, filesystem-backed {@link VaultFs} rooted at `root`. Paths are
 * vault-relative; `read` returns `undefined` for a missing file (never throws for
 * absence); `remove` is a no-op on an absent file. A tmpdir root is fine for tests;
 * a deployment passes the workspace's markdownRepoPath.
 */
export function createFsVault(root: string): VaultFs {
  const rootResolved = resolve(root);
  const abs = (p: string): string => {
    const full = resolve(root, p);
    // Containment (safety rule 4 / WS-4 — defense-in-depth): every vault path MUST
    // stay UNDER the vault root. `resolve` normalizes `..` and lets an absolute `p`
    // win, so a traversal (`../ws-other/x`) or absolute (`/etc/x`) path is refused
    // here — the sole writer never writes outside the bound workspace vault, no
    // matter who produced the path. Fail-closed: the throw surfaces as a
    // KnowledgeWriter commit_failed (a typed WriteFailure), never a stray write.
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      throw new Error(`vault path escapes the vault root (refused): ${p}`);
    }
    return full;
  };
  return {
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(abs(path), "utf8");
      } catch {
        return undefined;
      }
    },
    async list(): Promise<string[]> {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          entries = (await readdir(dir, { withFileTypes: true })) as never;
        } catch {
          return;
        }
        for (const e of entries) {
          const name = String(e.name);
          const full = join(dir, name);
          if (e.isDirectory()) {
            await walk(full);
          } else if (e.isFile() && name.endsWith(".md")) {
            out.push(relative(root, full).split(sep).join("/"));
          }
        }
      };
      await walk(root);
      return out.sort();
    },
    async write(path: string, content: string): Promise<void> {
      const full = abs(path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    async rename(from: string, to: string): Promise<void> {
      const target = abs(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(abs(from), target);
    },
    async remove(path: string): Promise<void> {
      await rm(abs(path), { force: true });
    },
  };
}

/** Create a fresh throwaway vault root under the OS tmpdir (test/first-boot use). */
export function makeTmpVaultRoot(): string {
  return mkdtempSync(join(tmpdir(), "sow-vault-"));
}

// ---------------------------------------------------------------------------
// (3) HealthItemStore — in-memory (Phase-10 carry-forward: persistent store)
// ---------------------------------------------------------------------------

/**
 * An IN-MEMORY {@link HealthItemStore} keyed on the materializer's dedupe key
 * (`failureClass|subjectRef`, which the materializer uses as the item id). A
 * re-`put` under the same id is an UPSERT so a recurring failure never spawns a
 * duplicate item (§9.11).
 *
 * @deprecated (Phase 10) The assembled default now PERSISTS to the migrated sqlite
 * `health_items` table via `createHealthItemStoreAdapter` (store-adapters.ts) — the
 * durable HealthItem table shipped in @sow/db. This in-memory store is retained ONLY
 * for unit fakes that want a store with no sqlite dependency; production composition
 * no longer uses it.
 */
export function createInMemoryHealthItemStore(): HealthItemStore {
  const byId = new Map<string, HealthItem>();
  return {
    getByDedupeKey(dedupeKey: string): Promise<HealthItem | undefined> {
      return Promise.resolve(byId.get(dedupeKey));
    },
    put(item: HealthItem): Promise<void> {
      byId.set(item.id, item);
      return Promise.resolve();
    },
    list(): Promise<HealthItem[]> {
      return Promise.resolve([...byId.values()]);
    },
  };
}

// ---------------------------------------------------------------------------
// (4) ReceiptStore adapter — @sow/db WriteReceiptRepository → @sow/integrations
// ---------------------------------------------------------------------------

/** Map a @sow/db WriteReceiptRow onto the @sow/integrations ReceiptRecord (faithful). */
function rowToReceiptRecord(row: WriteReceiptRow): ReceiptRecord | undefined {
  // A row WITHOUT a receipt is a live RESERVATION (another worker mid-write) — it is
  // NOT proof of an existing object, so it must NOT surface as a ReceiptRecord (that
  // would let the existence check treat a bare reservation as a committed write and
  // wrongly skip the create). Only a COMMITTED (receipt-present) row is a record.
  if (row.receipt === undefined) return undefined;
  return {
    idempotencyKey: row.idempotencyKey,
    canonicalObjectKey: row.canonicalObjectKey,
    // @sow/db keeps targetSystem an OPEN string at the boundary; the integrations
    // ReceiptRecord types it as TargetSystem — this is the worker's map point.
    targetSystem: row.targetSystem as TargetSystem,
    payloadHash: row.payloadHash,
    receipt: row.receipt,
    recordedAt: row.recordedAt,
  };
}

/** Map an integrations ReceiptRecord back onto the @sow/db WriteReceiptRow (faithful). */
function receiptRecordToRow(rec: ReceiptRecord): WriteReceiptRow {
  return {
    targetSystem: String(rec.targetSystem),
    canonicalObjectKey: rec.canonicalObjectKey,
    idempotencyKey: rec.idempotencyKey,
    payloadHash: rec.payloadHash,
    receipt: rec.receipt,
    recordedAt: rec.recordedAt,
  };
}

/**
 * Adapt the @sow/db {@link WriteReceiptRepository} onto the @sow/integrations
 * {@link ReceiptStore} the Tool Gateway consults (the worker-layer bridge; @sow/db
 * MUST NOT import @sow/integrations). The critical, safety-bearing mapping:
 *
 *   • `reserve` — a @sow/db `{kind:"committed", record}` (a receipt already exists)
 *     maps to the integrations `{kind:"committed", record}` so a REPLAY REUSES the
 *     receipt and NEVER issues a second external create (safety rule 3 / inv-5). A
 *     `reserved` / `in_progress` outcome maps 1:1.
 *   • `getByIdempotencyKey` / `getByCanonicalObjectKey` — a @sow/db `not_found` is a
 *     MISS → `undefined` (a lookup miss is not an error); a reserved-but-receiptless
 *     row is also `undefined` (not a committed object).
 *   • `put` — record the receipt (upgrades the reservation to committed).
 *   • `release` — release a still-reserved placeholder on the fault path.
 *
 * Every @sow/db `DbError` on a genuine miss folds to `undefined`; a real fault is
 * surfaced by rejecting the promise only where the ReceiptStore contract cannot
 * express it (the gateway is fail-closed above this seam).
 */
export function createReceiptStoreAdapter(repo: WriteReceiptRepository): ReceiptStore {
  return {
    async getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined> {
      const r = await repo.getByIdempotencyKey(k);
      if (isErr(r)) return undefined; // not_found (or any lookup fault) → miss
      return rowToReceiptRecord(r.value);
    },
    async getByCanonicalObjectKey(
      targetSystem: TargetSystem,
      k: string,
    ): Promise<ReceiptRecord | undefined> {
      const r = await repo.getByCanonicalObjectKey(String(targetSystem), k);
      if (isErr(r)) return undefined;
      return rowToReceiptRecord(r.value);
    },
    async reserve(
      targetSystem: TargetSystem,
      canonicalObjectKey: string,
    ): Promise<ReceiptReservation> {
      const r = await repo.reserve(String(targetSystem), canonicalObjectKey);
      if (isErr(r)) {
        // A reserve fault cannot be expressed as a reservation kind; fail closed by
        // reporting `in_progress` so the gateway HOLDS + retries and NEVER creates a
        // possible duplicate.
        return { kind: "in_progress" };
      }
      const outcome: ReserveOutcome = r.value;
      if (outcome.kind === "committed") {
        const record = rowToReceiptRecord(outcome.record);
        // A committed reserve ALWAYS carries a receipt; if the row were receiptless
        // it would be a data defect — fail closed to in_progress rather than reuse an
        // absent receipt.
        if (record === undefined) return { kind: "in_progress" };
        return { kind: "committed", record };
      }
      return outcome.kind === "reserved"
        ? { kind: "reserved" }
        : { kind: "in_progress" };
    },
    async release(targetSystem: TargetSystem, canonicalObjectKey: string): Promise<void> {
      await repo.release(String(targetSystem), canonicalObjectKey);
    },
    async put(r: ReceiptRecord): Promise<void> {
      await repo.put(receiptRecordToRow(r));
    },
  };
}

// ---------------------------------------------------------------------------
// (5) The approval seam — fail-closed sync unwrap over @sow/policy
// ---------------------------------------------------------------------------

/**
 * The gateway's `requireApproval` seam: a SYNC, bare-verdict predicate. It unwraps
 * the @sow/policy {@link requiresApproval} PolicyDecision — `isAllow ? d.value :
 * { requiresApproval: true }` — so a policy DENY FAILS CLOSED (approval required,
 * never an auto-apply of an unclassifiable action; safety rule 2 / REQ-F-012). The
 * resolved workspace posture is captured at bind time.
 */
export function makeRequireApproval(
  resolved: ResolvedWorkspacePolicy,
): (action: ProposedAction) => ApprovalVerdict {
  return (action: ProposedAction): ApprovalVerdict => {
    const decision: PolicyDecision<ApprovalVerdict> = requiresApproval(action, resolved);
    return isAllow(decision) ? decision.value : { requiresApproval: true };
  };
}

// ---------------------------------------------------------------------------
// (6) Deterministic-stub TRANSPORTS (each a real-SDK injection point)
// ---------------------------------------------------------------------------

/**
 * The candidate extraction the meeting.close job's provider run yields. Injected so a
 * test pins a deterministic meeting output; the real transport streams a model's
 * extraction here later.
 */
export interface StubMeetingExtraction {
  readonly candidateOutput: unknown;
}

/**
 * A deterministic {@link ProviderRunner} that returns a FIXED candidate AgentResult
 * for the meeting.close job — no real model call. The broker's other gates
 * (health/budget/schema) are also deterministic stubs below.
 *
 * // REAL-SDK INJECTION POINT (carry-forward: vendor transport)
 * Swap this for the ModelProviderPort / AgentRuntimePort HTTP transport that drives a
 * real provider; the broker's fixed-order gate pipeline (admission → route → egress
 * veto → health → budget → run → schema) is unchanged.
 */
export function createStubProviderRunner(extraction: StubMeetingExtraction): ProviderRunner {
  return (_route, _job, _budget, _signal) =>
    Promise.resolve(
      ok({
        value: makeAgentResult({
          status: "completed",
          candidateOutput: extraction.candidateOutput,
          usage: { runtimeSeconds: 1 },
          logs: [],
        }),
      }),
    );
}

/**
 * The inert/config-driven safe-build HEALTH sources (5.9). Reports the routable provider
 * healthy + model-present + conformance-passing WITHOUT a network reachability probe — the
 * real reachability/Keychain probe is the owner-crossing follow-up. A deployment binds the
 * real sources; a test injects a fake unhealthy source to exercise the fail-closed deny
 * path. Deny-only policing (no spend/egress). Overridable via `config.healthSources`.
 *
 * ALWAYS-GREEN, so correct ONLY while the transport is DORMANT — `selectHealthSources`
 * (18.14/CP-4) AND-locks this to the providerTransport arming so it is never selected under a
 * real transport (that would false-green a dead provider). `Object.freeze` (L31) so an
 * in-process caller cannot mutate this safety-posture constant.
 */
export const DEFAULT_HEALTH_SOURCES: HealthGateSources = Object.freeze({
  health: () => ({ state: "healthy" as const }),
  availability: () => ({ modelPresent: true, conformanceStatus: "passing" as const }),
});

/**
 * The candidate-schema parsers the real SCHEMA gate (5.5, REQ-S-006) validates against:
 * the registered KnowledgeMutationPlan + ProposedAction contracts (the two candidate kinds
 * the broker emits). A read_only/untrusted job can only emit a KMP (a PA implies a mutating
 * action → tool_policy_violation). The concrete per-capability EXTRACTION output schema + its
 * NoInferenceView (REQ-F-017) bind with the real extraction leg (18.3/18.4); this slice wires
 * the structural candidate-data gate over the existing candidate schemas.
 */
const CANDIDATE_MODEL_SCHEMAS = {
  [KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]: KnowledgeMutationPlanSchema,
  [PROPOSED_ACTION_SCHEMA_ID]: ProposedActionSchema,
};

/**
 * A deterministic {@link AdapterTransport} (the per-target write client seam). It
 * models the three vendor ops (query / create / update) against an IN-MEMORY object
 * table keyed by canonicalObjectKey, so a create is idempotent within the process and
 * an existence probe hits a prior write — the Tool Gateway's reserve-then-create gate
 * observes a real, deterministic vendor.
 *
 * // REAL-SDK INJECTION POINT (carry-forward: vendor transport)
 * Swap this for the real per-vendor HTTP/API client (calendar/todoist/linear/…); the
 * §8 envelope pipeline (candidate-gate → approval → existence check → reserve →
 * create → receipt) is unchanged.
 */
export function createStubAdapterTransport(): AdapterTransport {
  const objects = new Map<string, { externalObjectId: string }>();
  return (req: AdapterTransportRequest): Promise<TransportResponse> => {
    const key = req.canonicalObjectKey;
    if (req.op === "query") {
      const hit = objects.get(key);
      return Promise.resolve(
        hit === undefined
          ? { ok: true, object: null }
          : { ok: true, object: { externalObjectId: hit.externalObjectId } },
      );
    }
    if (req.op === "create") {
      const existing = objects.get(key);
      if (existing !== undefined) {
        return Promise.resolve({
          ok: true,
          object: { externalObjectId: existing.externalObjectId },
          deduped: true,
        });
      }
      const externalObjectId = `stub-obj:${req.targetSystem}:${key}`;
      objects.set(key, { externalObjectId });
      return Promise.resolve({ ok: true, object: { externalObjectId } });
    }
    // update
    const externalObjectId = objects.get(key)?.externalObjectId ?? `stub-obj:${req.targetSystem}:${key}`;
    objects.set(key, { externalObjectId });
    return Promise.resolve({ ok: true, object: { externalObjectId } });
  };
}

/**
 * Select the outbound external-write {@link AdapterTransport} for the write adapter,
 * honouring the default-OFF owner gate ({@link WriteTransportGate}).
 *
 * Guard FIRST, STRICT `=== true`: the owner-provisioned real transport is selected ONLY
 * when BOTH locks are satisfied — `gate.enabled === true` (a truthy-but-not-`true` value
 * like `1`/`"true"`/`"false"`/`{}` never arms, closing the truthy-coerce false-arming
 * vector) AND `gate.make` is present. Any other input (unset gate, `enabled` absent/false,
 * missing `make`) ⇒ the deterministic {@link createStubAdapterTransport} — so the shipped
 * default (`config.writeTransport` unset) is byte-equivalent and fully dormant.
 *
 * The real factory is NEVER invoked on the OFF path (nothing real is constructed by the
 * shipped default). Enabling a real external write requires deliberate owner config, never
 * a source edit at the call site (§8 external-write envelope; safety rule 3).
 */
export function selectAdapterTransport(gate?: WriteTransportGate): AdapterTransport {
  // Type-robust on BOTH locks (a JSON-sourced config could carry a non-boolean `enabled`
  // or a non-function `make`): strict `=== true` + `typeof … === "function"` fail CLOSED
  // to the stub on any malformed input, never arm and never throw at boot.
  if (gate?.enabled === true && typeof gate.make === "function") {
    return gate.make();
  }
  return createStubAdapterTransport();
}

/**
 * A deterministic {@link IndexApplyClient} (the write-side GBrain index seam). It
 * ACKs every apply idempotently (per (workspaceId, revisionId)) with no duplicate
 * nodes, so the reindex activity has a real, deterministic index client behind it.
 *
 * // REAL-SDK INJECTION POINT (carry-forward: vendor transport)
 * Swap this for the single-owner GBrain index write client (the sole-issuer worker
 * path, distinct from the read-only runtime adapter).
 */
export function createStubIndexApplyClient(): IndexApplyClient {
  const applied = new Set<string>();
  return {
    applyRevision(
      request: IndexApplyRequest,
    ): Promise<Result<IndexApplyReceipt, IndexApplyError>> {
      const key = `${request.workspaceId}:${request.revisionId}`;
      const mutated = !applied.has(key);
      applied.add(key);
      const receipt: IndexApplyReceipt = {
        workspaceId: request.workspaceId,
        revisionId: request.revisionId,
        nodeCount: request.facts.length,
        mutated,
      };
      return Promise.resolve(ok(receipt));
    },
  };
}

// ---------------------------------------------------------------------------
// (7) The assembled backends bundle
// ---------------------------------------------------------------------------

/**
 * The concrete adapters buildProofSpineActivities binds the activity factories over.
 * Assembled ONCE at worker boot; every field is a real adapter or a clearly-marked
 * deterministic-stub transport.
 */
export interface ProofSpineBackends {
  /** The live sqlite operational store (write_receipts + genesis migrated). */
  readonly repos: SqliteRepositories;
  /** The @sow/integrations ReceiptStore over the @sow/db write-receipt repo. */
  readonly receiptStore: ReceiptStore;
  /** The filesystem-backed vault the KnowledgeWriter commits under. */
  readonly vault: VaultFs;
  /**
   * The §9 health-item store — now PERSISTENT: backed by the migrated sqlite
   * `health_items` table via `createHealthItemStoreAdapter` (Phase-10 wiring).
   */
  readonly healthItems: HealthItemStore;
  /** The LIFE-5 durable-schedule bookkeeping store (sqlite-backed). */
  readonly scheduleStore: ScheduleStore;
  /** The LIFE-1 single-active-instance lease store (sqlite-backed, atomic CAS). */
  readonly instanceLeaseStore: InstanceLeaseStore;
  /** The single redacting structured logger (over a real sink). */
  readonly logger: Logger;
  /** The §7 Broker (deterministic gate stubs; localConfig always supplied). */
  readonly broker: Broker;
  /** The per-target write adapter (deterministic transport). */
  readonly writeAdapter: TargetWriteAdapter;
  /** The GBrain index client (deterministic transport). */
  readonly indexClient: IndexApplyClient;
  /** The local-provider config ALWAYS handed to the broker (never undefined). */
  readonly localConfig: LocalProviderConfig;
  /** Injected wall clock (ISO-8601). */
  readonly now: () => string;
  /** A close handle for the sqlite connection (test teardown). */
  readonly close: () => void;
}


/**
 * The default {@link LogSink}: one NDJSON line per redacted record on stderr. The
 * record is ALREADY redaction-safe (createLogger runs the domain redactor before the
 * sink), so serializing it carries no raw content or secret. Kept off stdout so it
 * never mixes with a stdout data channel.
 */
export const defaultLogSink: LogSink = (record: LogRecord): void => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/**
 * Assemble the proof-spine backends: open sqlite (+ genesis migrate), build the
 * filesystem vault, the PERSISTENT sqlite-backed operational stores (health · schedule
 * · lease), the redacting logger, the ReceiptStore adapter, and the §7 broker over
 * deterministic gate stubs — with localConfig ALWAYS supplied. The caller
 * (buildProofSpineActivities) binds the activity factories over this bundle.
 */
export async function assembleBackends(
  config: BackendsConfig = {},
  extraction: StubMeetingExtraction = { candidateOutput: {} },
): Promise<ProofSpineBackends> {
  const now = config.now ?? ((): string => new Date().toISOString());
  const opened = await openDatabase(config);
  const vault = createFsVault(config.vaultRoot ?? makeTmpVaultRoot());

  // The single redacting logger over a real sink (default: NDJSON on stderr). The
  // sink only ever receives already-redacted, schema-valid LogRecords.
  const logger = createLogger(config.logSink ?? defaultLogSink);

  // The §9 operational-truth stores now PERSIST to the migrated sqlite tables (the
  // Phase-10 carry-forward the in-memory HealthItemStore left). `now` supplies the
  // §10.3 lastSeen the health port's bare put(item) omits.
  const healthItems = createHealthItemStoreAdapter(opened.repos.healthItems, now);
  const scheduleStore = createScheduleStoreAdapter(opened.repos.scheduleBookkeeping);
  const instanceLeaseStore = createInstanceLeaseStoreAdapter(opened.repos.instanceLeases);
  const receiptStore = createReceiptStoreAdapter(opened.repos.writeReceipts);

  const localConfig: LocalProviderConfig = {
    allowedLocalEndpoints:
      config.allowedLocalEndpoints !== undefined
        ? [...config.allowedLocalEndpoints]
        : ["http://127.0.0.1:11434"],
  };

  // 18.2 — the single-run BUDGET ledger seam (19.11 durable cross-run ledger plugs in backward).
  const budgetLedger = config.budgetLedger ?? createSingleRunBudgetLedger();
  const broker = createBroker({
    // 18.2 — the REAL §7 policing gates (deny-only: no spend/egress/write; ACTIVE by default,
    // no dormancy knob — they cross no hard line).
    // HEALTH (5.9): provider-reachability + model-availability over injected sources. The
    //   source is AND-LOCKED to the 18.1 providerTransport arming (18.14/CP-4): an explicit
    //   config.healthSources wins; else armed transport ⇒ the owner's real availability source
    //   (or a fail-closed UNAVAILABLE if the arming bundle omitted it — never the always-green
    //   stub, which would false-green a dead real provider), dormant ⇒ DEFAULT_HEALTH_SOURCES
    //   (byte-equivalent green — correct only while the transport is dormant).
    //   ⚠ ARMING CAVEAT: config.healthSources takes PRECEDENCE over the AND-lock (explicit
    //   owner source wins). When arming providerTransport, do NOT ALSO bind config.healthSources
    //   to an always-green source — that re-opens the exact false-green the AND-lock closes.
    //   (§19.5 arming runbook checklist item; the AND-lock only governs the default branch.)
    health: createHealthGate(
      config.healthSources ?? selectHealthSources(config.providerTransport, DEFAULT_HEALTH_SOURCES),
    ),
    // BUDGET (5.4): COST-1/COST-2 caps (config-sourced defaults) wrapped by the BudgetLedgerPort.
    budget: createLedgeredBudgetGate(
      {
        defaults: config.budgetDefaults ?? DEFAULT_BUDGET_DEFAULTS,
        // CP-5b: thread the real per-model→conservative-provider pricing so the COST-1 dollar cap
        // FIRES (pricingFor keyed by ProviderId). UNSET ⇒ the shipped fail-safe placeholder (deny-only
        // ships ON, L44); the cost limb was previously DEAD because `pricing` was never wired here.
        pricing: config.budgetPricing ?? DEFAULT_PROVIDER_PRICING,
      },
      budgetLedger,
    ),
    // RUN (18.1): the default-OFF real-transport gate — unset `providerTransport` ⇒ the
    //   byte-identical stub; a real ModelProvider runner is bound ONLY by owner config at the crossing.
    run: selectProviderRunner(config.providerTransport, createStubProviderRunner(extraction)),
    // SCHEMA (5.5, REQ-S-006): the candidate-data gate — ajv registry + KMP/PA model parsers.
    //   A schema-invalid candidate is rejected BEFORE emit (no side effect). The per-capability
    //   extraction NoInferenceView (REQ-F-017) binds with the real extraction leg (18.3/18.4).
    schema: createSchemaGate({ modelSchemas: CANDIDATE_MODEL_SCHEMAS }),
  });

  // The transport is chosen through the default-OFF owner gate: unset `writeTransport`
  // ⇒ the deterministic stub (byte-equivalent shipped default), never a hardcoded real
  // client at this call site (§8 external-write envelope; safety rule 3).
  const writeAdapter = makeTargetWriteAdapter(
    { targetSystem: "todoist" as TargetSystem, deriveIdentity: (env) => ({ key: env.canonicalObjectKey }) },
    { transport: selectAdapterTransport(config.writeTransport), clock: now },
  );

  const indexClient = createStubIndexApplyClient();

  return {
    repos: opened.repos,
    receiptStore,
    vault,
    healthItems,
    scheduleStore,
    instanceLeaseStore,
    logger,
    broker,
    writeAdapter,
    indexClient,
    localConfig,
    now,
    close: () => {
      try {
        opened.conn.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

// Re-export the buildAuditSignal helper so buildActivities can mint audit signals
// for the health sinks without re-importing @sow/policy.
export { buildAuditSignal };
export type { AuditId, FailureClass, HealthItem, ResolvedWorkspacePolicy, BrokerJobRequest, BrokerOutcome, DbError };
