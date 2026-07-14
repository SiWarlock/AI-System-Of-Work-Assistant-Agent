// C5.4b Slice 2 — the two REAL boot-side readers that assemble a workspace's serving context from committed
// truth, feeding the built `createServingContextLoader` (servingContextLoader.ts). Both are FAIL-CLOSED and
// NEVER-THROW (§16): a fault or a missing source DEGRADES the loader, never crashes serving. Boot wires them
// in Slice 3 (brief 048) behind the go-live arming flag — the readers ship here with a reachability waiver
// (unit + integration tested directly; the production caller is Slice 3).
//
// SAFETY (WS-8 / safety rule 4): the vault reader NEVER invents a vault — it uses only the injected
// `resolveVault`'s output, confines enumeration to that VaultFs (whose fs root is containment-guarded by
// `createFsVault`), and stamps the snapshot with the REQUESTED workspaceId. The workspaceId→vault mapping's
// WS-8 correctness is the resolver's (boot's) responsibility (Slice 3). An incomplete/faulted read can only
// WITHHOLD (fewer allow-set facts) — never a false admission.
import { isOk } from "@sow/contracts";
import type { WorkspaceId, RevisionId, GbrainPin } from "@sow/contracts";
import {
  readVaultHeadRevision,
  checkVersionPin,
  type VaultFs,
  type RunningGbrainVersion,
  type CanonicalVaultSnapshot,
} from "@sow/knowledge";
import type {
  CommittedVaultReader,
  ServingCoverageReader,
  ServingCoverageSources,
} from "./servingContextLoader";
import type { ParityReportStore } from "../../composition/parityReportStore";

/** Deps for the committed-vault reader: resolve a workspaceId to its VaultFs (boot owns the mapping + WS-8). */
export interface CommittedVaultReaderDeps {
  /** Resolve a workspaceId to its committed VaultFs, or `undefined` when unmapped / no vault. */
  readonly resolveVault: (workspaceId: string) => VaultFs | undefined;
}

/**
 * Build a real {@link CommittedVaultReader}: enumerate the workspace's committed `.md` files into a
 * `CanonicalVaultSnapshot` @ head. ASYNC (fs reads are async) — the loader `await`s it (the seam is
 * sync-or-async). Fail-closed / never-throws:
 *   • unmapped workspace / no vault ⇒ `undefined`
 *   • zero readable `.md` (empty vault, or every listed `.md` unreadable) ⇒ `undefined`
 *   • a listed-but-unreadable `.md` (read → `undefined`; race/deleted) is SKIPPED (the readable subset still
 *     serves — an absent page just isn't in the allow-set ⇒ its citation withholds; incompleteness is fail-SAFE).
 *     A file whose content is the empty string is KEPT (a real empty note ≠ an unreadable one).
 *   • any thrown fault (resolver / list / read / head-revision) ⇒ `undefined`
 * The `.md` match is intentionally CASE-SENSITIVE — it mirrors the KnowledgeWriter's stamp filter
 * (`embedProvenanceStamps` also keys on `.endsWith(".md")`), so a `.MD` note is never KW-stamped and would be
 * correctly UNtrusted anyway; do not "fix" it to case-insensitive (that could surface a never-stamped page).
 * WS-8: the snapshot carries the REQUESTED workspaceId; enumeration is confined to the resolved vault.
 */
export function createCommittedVaultReader(deps: CommittedVaultReaderDeps): CommittedVaultReader {
  return async (workspaceId: string): Promise<CanonicalVaultSnapshot | undefined> => {
    try {
      const vault = deps.resolveVault(workspaceId);
      if (vault === undefined) return undefined;
      const paths = (await vault.list()).filter((p) => p.endsWith(".md"));
      if (paths.length === 0) return undefined;
      const files = new Map<string, string>();
      for (const path of paths) {
        const content = await vault.read(path);
        if (content === undefined) continue; // listed but unreadable (race/deleted) — skip, fail-safe
        files.set(path, content);
      }
      if (files.size === 0) return undefined; // nothing readable ⇒ degrade
      // FUTURE-PERF + TOCTOU: `readVaultHeadRevision` re-enumerates the vault (a SECOND full read per ask), so
      // the head revision and `files` are read as two views. Fine while dormant/degraded; at go-live take ONE
      // atomic snapshot and derive the revision from it (a single consistent view). It is the CANONICAL head fn
      // — the same one the executor uses for head-at-commit — so the revision matches the write path.
      // The `as RevisionId` is load-bearing (verified: `tsc` fails without it): the worker's build resolution
      // widens the consumed `readVaultHeadRevision` return from the branded `RevisionId` to `string`, so it must
      // be re-branded for the `CanonicalVaultSnapshot.revisionId` field.
      const revisionId = (await readVaultHeadRevision(vault)) as RevisionId;
      return { workspaceId: workspaceId as WorkspaceId, revisionId, files };
    } catch {
      return undefined; // §16 — a fault degrades the loader, never crosses the boundary
    }
  };
}

/** Deps for the serving-coverage reader (Q3: reuse boot's pin + running probe; injected clock). */
export interface ServingCoverageReaderDeps {
  /** The pinned gbrain build (from `config/gbrain.pin`) — the same pin boot's startup check uses. */
  readonly pin: GbrainPin;
  /** SYNC accessor over boot's cached startup probe of the running gbrain (`undefined` = unavailable). */
  readonly resolveRunning: () => RunningGbrainVersion | undefined;
  /** Clock for `checkVersionPin`'s ctx (the degrade HealthItem it builds is DISCARDED here) — no ambient clock. */
  readonly now: () => string;
  /**
   * OPTIONAL serve-time {@link ParityReportStore} (B1). UNBOUND in production today — boot binds the real
   * `createParityReportStoreAdapter(parityRepo)` in B4 — so the parity leg is `undefined` ⇒ degrade,
   * byte-equivalent to the pre-B2 default. When bound, the parity leg reads the LATEST persisted report for
   * the workspace @ its head revision; a store REJECT (`DbError`, incl. B1's corrupt/identity-mismatch
   * re-gate) degrades ALL legs (fail-closed — never a false green).
   */
  readonly store?: ParityReportStore;
}

const SERVING_COVERAGE_AUDIT_REF = "serving-coverage-pin-check";

/**
 * Build a real {@link ServingCoverageReader}. TWO real signals now: `pinValid` (via `checkVersionPin` — `isOk`
 * means the running gbrain matches the pinned build) AND `parity` (B2) — the LATEST persisted `ParityReport`
 * for the workspace @ its head revision, read from the OPTIONAL {@link ParityReportStore}. `oracleBuildOk`
 * stays `false` UNCONDITIONALLY (the rebuild-oracle build-status leg is a distinct later slice), so coverage
 * remains AND-degraded even with a green report + a valid pin. HONEST-INTERIM / DORMANT: the store dep is
 * UNBOUND in production today (boot binds the real adapter in B4), so `parity` is `undefined` ⇒ the loader's
 * coverage derivation degrades every workspace regardless of `pinValid` (sound + inert; propose stays OFF).
 * ASYNC (the store read is async) — the loader `await`s it (the {@link ServingCoverageReader} seam is
 * sync-or-async). Never throws / fail-closed (§6/§16): a store REJECT (or any other fault) ⇒ ALL legs false —
 * a fault never crosses the boundary and never becomes a false green (the trust-gate kill-switch's substrate).
 */
export function createServingCoverageReader(deps: ServingCoverageReaderDeps): ServingCoverageReader {
  return async (workspaceId: string, revisionId: RevisionId): Promise<ServingCoverageSources> => {
    try {
      const running = deps.resolveRunning();
      const pinValid = isOk(
        checkVersionPin(deps.pin, running, { now: deps.now, auditRef: SERVING_COVERAGE_AUDIT_REF }),
      );
      // Parity leg (B2): the latest persisted ParityReport for this workspace @ its HEAD revision. UNBOUND
      // store (dormant default) OR a true absence (never reconciled) ⇒ `undefined` ⇒ the loader degrades. A
      // store REJECT (a DbError — B1 already fail-closes a corrupt/identity-mismatched payload) THROWS here →
      // the catch degrades ALL legs (never a false green). The loader re-scopes the report to head (its
      // `revisionScopedParity` re-check) as a staleness backstop; the store query is revision-scoped on the way in.
      const parity =
        deps.store === undefined
          ? undefined
          : await deps.store.getLatestForRevision(workspaceId, String(revisionId));
      return { parity, pinValid, oracleBuildOk: false };
    } catch {
      return { parity: undefined, pinValid: false, oracleBuildOk: false };
    }
  };
}
