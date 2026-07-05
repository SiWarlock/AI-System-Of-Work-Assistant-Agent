// spec(§6 · §12 · §13 · KN-4/KN-9 · safety rule 1) — task 12.23.
//
// The GBrain divergence / serving-fail-closed acceptance suite — the harness
// tie-together that drives the REAL @sow/knowledge modules (imported read-only via
// bare deep subpaths, exactly the shapes packages/knowledge's own unit tests use)
// and asserts task 12.23's three bullets end-to-end:
//
//   23a — monotonic apply / out-of-order drain: a burst of triggers collapses to
//         the MAX revision, and a replayed index apply is idempotent (the served
//         revision pointer does not churn); a job whose loaded snapshot does not
//         hash to its named revision is refused (no stale-revision indexing).
//   23b — crash recovery: the serving allow-set is rebuilt as
//         CanonicalFactDeriver(current Markdown) (gbrain-INDEPENDENT), no true fact
//         is stranded, and a purged identity that reappears in Markdown stays
//         blocked (no resurrection).
//   23c — quarantine-as-absence non-resurrection under a one-byte change
//         (content-INDEPENDENT factIdentity); content_mismatch resolves
//         Markdown-wins (no DB-content laundering); a forged / borrowed provenance
//         stamp is rejected at serve time; and a reconciler failure /
//         coverageComplete=false degrades to Markdown-provenanced-only serving —
//         never the last-known DB row set.
//
// DoD honesty (§20.2): 12.23 does NOT map to a §20.1 acceptance row, so there is no
// dedicated EVAL-1 criterion to score and none is invented. (The closest row,
// GBRAIN_PARITY_DIVERGENCE, is requiresRealIntegration=true — scoring it from this
// seam-level run would be dodPass=false — so this suite asserts the invariants
// directly against the real deterministic modules instead of scoring a criterion.)
//
// KNOWN GAP (23a-ii): the "a LOWER-revision index apply arriving after a higher one
// is a NO-OP; the applied/served revision pointer never regresses" guard does NOT
// exist in code. After a genuine search of @sow/knowledge (index-sync,
// parity/reconciler, serving/rehydration-gate, fs-watch/reconcile, sync-outbox) the
// ONLY revision-ordering primitive is `collapseToMaxRevision` (a within-burst
// collapse=MAX, parity/reconciler.ts). `applyGbrainIndexJob` (gbrain/index-sync.ts)
// holds NO persistent applied-revision / applied-seq pointer and never compares the
// job's revision against a previously-applied one — a revision id is a CONTENT HASH
// (computeRevisionId), not an ordinal, so "lower" is only meaningful via the
// PendingTrigger.seq that only `collapseToMaxRevision` consults. This suite therefore
// PINS what exists (collapse=MAX + same-rev idempotency + stale-snapshot refusal) and
// CHARACTERIZES the missing monotonic guard with a clearly-labelled test that asserts
// the current (unguarded) behaviour — it does not fabricate a passing guard. Expected
// home for the fix: `applyGbrainIndexJob` / the `IndexApplyClient` seam in
// gbrain/index-sync.ts (a per-(workspace) applied-seq high-water mark that no-ops a
// lower-seq apply).
import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  workspaceId,
  factIdentity,
  HealthItemSchema,
  WorkspaceIdSchema,
  RevisionIdSchema,
} from "@sow/contracts";
import type {
  WorkspaceId,
  RevisionId as ContractsRevisionId,
  FactIdentity,
  MdContentSha,
  SemanticFact,
  FactProvenance,
  QuarantineRecord,
  AuditId,
} from "@sow/contracts";
import type { DbResult } from "@sow/db";
import { computeRevisionId } from "@sow/knowledge/knowledge-writer/revision";
import type { RevisionId as KwRevisionId } from "@sow/knowledge/knowledge-writer/revision";
import {
  buildSyncOutboxEntry,
  gbrainSyncOutboxKey,
} from "@sow/knowledge/knowledge-writer/sync-outbox";
import type {
  GbrainSyncOutboxEntry,
  GbrainSyncOutboxStore,
} from "@sow/knowledge/knowledge-writer/sync-outbox";
import { deriveCanonicalFacts } from "@sow/knowledge/gbrain/derive/canonical-fact-deriver";
import type {
  CanonicalVaultSnapshot,
  CanonicalFactSet,
  DerivedFact,
} from "@sow/knowledge/gbrain/derive/canonical-fact-deriver";
import { applyGbrainIndexJob } from "@sow/knowledge/gbrain/index-sync";
import type {
  CanonicalMarkdownSource,
  IndexApplyClient,
  IndexApplyRequest,
  GbrainIndexSyncDeps,
} from "@sow/knowledge/gbrain/index-sync";
import {
  reconcileParity,
  collapseToMaxRevision,
} from "@sow/knowledge/gbrain/parity/reconciler";
import type {
  ReconcilerDbProjection,
  ReconcilerDeps,
  ReconcileRequest,
  PendingTrigger,
} from "@sow/knowledge/gbrain/parity/reconciler";
import { classifyDivergence } from "@sow/knowledge/gbrain/parity/divergence-classifier";
import type { DbFact } from "@sow/knowledge/gbrain/parity/divergence-classifier";
import { createQuarantineLedger } from "@sow/knowledge/gbrain/serving/quarantine-ledger";
import {
  admitForServing,
  synthesisContext,
  isDegradedCoverage,
} from "@sow/knowledge/gbrain/serving/rehydration-gate";
import type {
  DbPointer,
  RehydratedFact,
  RehydrateFn,
  ServingCoverage,
  ServingDeps,
  ServingRequest,
} from "@sow/knowledge/gbrain/serving/rehydration-gate";
import { recoverServingState } from "@sow/knowledge/gbrain/enablement/crash-recovery-reconciler";
import type { CrashRecoveryDeps } from "@sow/knowledge/gbrain/enablement/crash-recovery-reconciler";
import { resolveWriteThrough } from "@sow/knowledge/gbrain/enablement/write-through-flag";
import type {
  EnablementConditions,
  WriteThroughResolveInput,
  WriteThroughContext,
} from "@sow/knowledge/gbrain/enablement/write-through-flag";
import { stampProvenance } from "@sow/knowledge/knowledge-writer/provenance-stamp";
import type {
  SecretsPort,
  SecretRef,
  StampInputs,
} from "@sow/knowledge/knowledge-writer/provenance-stamp";

// ── injected doubles (real ports, not behaviour mocks) ───────────────────────────

/** Loads a single fixed committed-Markdown snapshot for any revision id (read-only). */
class FixedMarkdownSource implements CanonicalMarkdownSource {
  constructor(private readonly snapshot: CanonicalVaultSnapshot) {}
  async loadSnapshot() {
    return ok(this.snapshot);
  }
}

function sameNodes(a: Map<string, string> | undefined, b: Map<string, string>): boolean {
  if (a === undefined || a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** A derived-index write client that records the last-applied revision per workspace. */
class FakeIndexClient implements IndexApplyClient {
  readonly applyCalls: IndexApplyRequest[] = [];
  readonly index = new Map<string, Map<string, string>>();
  readonly revByWs = new Map<string, string>();

  async applyRevision(req: IndexApplyRequest) {
    this.applyCalls.push(req);
    const nodes = new Map<string, string>();
    for (const df of req.facts) {
      nodes.set(df.fact.factIdentity as unknown as string, df.fact.mdContentSha as string);
    }
    const prevRev = this.revByWs.get(req.workspaceId);
    const mutated = prevRev !== req.revisionId || !sameNodes(this.index.get(req.workspaceId), nodes);
    this.index.set(req.workspaceId, nodes);
    this.revByWs.set(req.workspaceId, req.revisionId);
    return ok({
      workspaceId: req.workspaceId,
      revisionId: req.revisionId,
      nodeCount: nodes.size,
      mutated,
    });
  }
}

/** In-memory GbrainSyncOutboxStore double (a real map keyed by outboxId, never throws). */
class MemoryOutbox implements GbrainSyncOutboxStore {
  readonly byId = new Map<string, GbrainSyncOutboxEntry>();
  async getByKey(ws: string, rev: KwRevisionId): DbResult<GbrainSyncOutboxEntry | undefined> {
    return ok(this.byId.get(gbrainSyncOutboxKey(ws, rev)));
  }
  async enqueue(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry> {
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }
  async update(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry> {
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }
  async listDue(_now: string, limit: number): DbResult<GbrainSyncOutboxEntry[]> {
    return ok([...this.byId.values()].filter((e) => e.status !== "indexed").slice(0, limit));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// 23a — MONOTONIC APPLY / OUT-OF-ORDER DRAIN
// ─────────────────────────────────────────────────────────────────────────────────
describe("12.23a — monotonic apply / out-of-order drain (real reconciler + index-sync)", () => {
  const WS = "ws-employer";
  const NOW = "2026-07-01T00:00:00.000Z";

  function snapshotOf(files: Record<string, string>): {
    snapshot: CanonicalVaultSnapshot;
    revId: KwRevisionId;
  } {
    const map = new Map(Object.entries(files));
    const revId = computeRevisionId(map);
    const snapshot: CanonicalVaultSnapshot = {
      workspaceId: workspaceId(WS),
      revisionId: revId as unknown as ContractsRevisionId,
      files: map,
    };
    return { snapshot, revId };
  }

  function queuedEntry(revId: KwRevisionId): GbrainSyncOutboxEntry {
    return buildSyncOutboxEntry({
      workspaceId: WS,
      revisionId: revId,
      planId: "plan-1",
      auditRef: "audit-commit-1",
      enqueuedAt: NOW,
    });
  }

  function mkIndexDeps(
    source: CanonicalMarkdownSource,
    client: IndexApplyClient,
    outbox: GbrainSyncOutboxStore,
  ): GbrainIndexSyncDeps {
    let n = 0;
    return {
      snapshotSource: source,
      indexClient: client,
      outbox,
      now: () => NOW,
      newHealthItemId: () => `health-index-${(n += 1)}`,
    };
  }

  // 23a(i) — collapse=MAX.
  it("(i) collapses a burst of out-of-order triggers to the NEWEST revision (MAX seq, LIFE-2)", () => {
    const burst: PendingTrigger[] = [
      { origin: "post_commit", revisionId: "rev:1", seq: 1 },
      { origin: "fs_watch", revisionId: "rev:3", seq: 3 },
      { origin: "schedule", revisionId: "rev:2", seq: 2 },
    ];
    expect(collapseToMaxRevision(burst)?.revisionId).toBe("rev:3");
    expect(collapseToMaxRevision([])).toBeUndefined();
  });

  // 23a(ii) — same-rev idempotency: replay never churns the applied revision.
  it("(ii) a replayed index apply is idempotent — no duplicate nodes, second apply mutated=false", async () => {
    const { snapshot, revId } = snapshotOf({
      "acme/auth.md": "---\nslug: auth\n---\n# Auth\nSee [[oauth]].\n",
      "acme/oauth.md": "---\nslug: oauth\n---\n# OAuth\n",
    });
    const client = new FakeIndexClient();
    const outbox = new MemoryOutbox();

    const first = await applyGbrainIndexJob(queuedEntry(revId), mkIndexDeps(new FixedMarkdownSource(snapshot), client, outbox));
    expect(first.kind).toBe("indexed");
    expect(first.receipt?.mutated).toBe(true);
    const firstCount = client.index.get(WS)!.size;

    // Re-drain the SAME committed revision (a lost-status replay): a no-op set-replace.
    const second = await applyGbrainIndexJob(queuedEntry(revId), mkIndexDeps(new FixedMarkdownSource(snapshot), client, outbox));
    expect(second.kind).toBe("indexed");
    expect(second.receipt?.mutated).toBe(false);
    expect(client.index.get(WS)!.size).toBe(firstCount); // no duplicate nodes
    expect(client.applyCalls[1]!.facts.length).toBe(client.applyCalls[0]!.facts.length);
    expect(client.revByWs.get(WS)).toBe(revId); // pointer unchanged on replay
  });

  it("(ii) an already-indexed entry short-circuits — no re-derive, no re-apply (frozen terminal)", async () => {
    const { snapshot, revId } = snapshotOf({ "p.md": "hi" });
    const client = new FakeIndexClient();
    const indexed: GbrainSyncOutboxEntry = { ...queuedEntry(revId), status: "indexed" };
    const outcome = await applyGbrainIndexJob(indexed, mkIndexDeps(new FixedMarkdownSource(snapshot), client, new MemoryOutbox()));
    expect(outcome.kind).toBe("already_indexed");
    expect(client.applyCalls).toEqual([]);
  });

  // 23a(ii) — stale-snapshot refusal: never index a revision the bytes don't hash to.
  it("(ii) refuses to apply when the loaded snapshot does not hash to the job's revision id (no stale/lower-rev indexing)", async () => {
    const { snapshot } = snapshotOf({ "p.md": "hi" });
    const client = new FakeIndexClient();
    // The job names a revision the loaded snapshot does NOT match → the guard trips.
    const bogus = queuedEntry("rev:not-the-real-hash" as unknown as KwRevisionId);
    const outcome = await applyGbrainIndexJob(bogus, mkIndexDeps(new FixedMarkdownSource(snapshot), client, new MemoryOutbox()));
    expect(outcome.kind).toBe("lagging");
    expect(outcome.mutationState).toBe("sync_lagging");
    expect(client.applyCalls).toEqual([]); // never applied unverifiable bytes
    expect(client.revByWs.get(WS)).toBeUndefined(); // pointer never moved
  });

  // 23a(ii) — CHARACTERIZATION of the KNOWN GAP (see file header). This asserts the
  // CURRENT, unguarded behaviour; it is NOT a passing monotonic guard.
  it("(ii) KNOWN GAP: applyGbrainIndexJob holds no applied-revision pointer, so an out-of-order (older) apply is NOT a no-op and the pointer regresses", async () => {
    // Conceptually revA is the NEWER committed state (seq 2) and revB the OLDER one
    // (seq 1) that arrives out of order. `applyGbrainIndexJob` takes no seq and keeps
    // no high-water mark, so it applies whatever revision its job names.
    const a = snapshotOf({ "p.md": "the NEWER committed body" });
    const b = snapshotOf({ "p.md": "an OLDER committed body", "q.md": "extra" });
    const client = new FakeIndexClient();
    const outbox = new MemoryOutbox();

    const newer = await applyGbrainIndexJob(queuedEntry(a.revId), mkIndexDeps(new FixedMarkdownSource(a.snapshot), client, outbox));
    expect(newer.kind).toBe("indexed");
    expect(client.revByWs.get(WS)).toBe(a.revId);

    const olderOutOfOrder = await applyGbrainIndexJob(
      queuedEntry(b.revId),
      mkIndexDeps(new FixedMarkdownSource(b.snapshot), client, outbox),
    );
    // A monotonic guard WOULD make this a no-op with the pointer pinned at a.revId.
    // It does not exist: the older apply lands and the served revision pointer regresses.
    expect(olderOutOfOrder.kind).toBe("indexed");
    expect(olderOutOfOrder.receipt?.mutated).toBe(true);
    expect(client.revByWs.get(WS)).toBe(b.revId); // <- regressed (the gap)
    expect(client.revByWs.get(WS)).not.toBe(a.revId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// 23b — CRASH RECOVERY (gbrain-independent allow-set; no strand; no resurrection)
// ─────────────────────────────────────────────────────────────────────────────────
describe("12.23b — crash recovery rebuilds the allow-set from current Markdown (real crash-recovery reconciler)", () => {
  const WS = "ws-employer";
  const NOTES: Record<string, string> = {
    "alpha.md": "---\nslug: alpha\ntags: work\n---\nAlpha body [[beta]].\n",
    "beta.md": "---\nslug: beta\n---\nBeta body.\n",
  };

  function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
    return {
      workspaceId: WS as WorkspaceId,
      revisionId: "rev-current" as unknown as ContractsRevisionId,
      files: new Map(Object.entries(files)),
    };
  }

  let idn = 0;
  const deps: CrashRecoveryDeps = {
    now: () => "2026-07-01T00:00:00.000Z",
    newHealthItemId: () => `health-${(idn += 1)}`,
    newAuditId: () => `audit-${(idn += 1)}`,
  };

  function quarantineRecord(id: string, remediationState: QuarantineRecord["remediationState"]): QuarantineRecord {
    return {
      factIdentity: id as FactIdentity,
      workspaceId: WS as WorkspaceId,
      divergenceRef: "div-1",
      divergenceClass: "db_only",
      capturedDbDigest: "digest-abc",
      remediationState,
      healthItemId: "health-seed",
      auditRef: "audit-seed" as AuditId,
    };
  }

  it("rebuilds the allow-set as CanonicalFactDeriver(current Markdown) verbatim, and strands NO true fact", () => {
    const snap = snapshot(NOTES);
    const derived = deriveCanonicalFacts(snap);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const r = recoverServingState({ snapshot: snap, quarantine: createQuarantineLedger() }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // gbrain-INDEPENDENT: the recovered allow-set IS the deriver's fact set (same members).
    expect(r.value.allowSet.facts.map((f) => f.fact.factIdentity)).toEqual(
      derived.value.facts.map((f) => f.fact.factIdentity),
    );
    // no true (Markdown-derivable) fact stranded un-served with an empty ledger.
    expect(r.value.servable.length).toBe(r.value.allowSet.facts.length);
    expect(r.value.quarantineBlocked).toEqual([]);
    expect(r.value.resurrectionBlocked).toEqual([]);
    expect(r.value.healthItems).toEqual([]);
  });

  it("a PURGED identity that reappears in committed Markdown stays blocked + surfaced (no resurrection)", () => {
    const snap = snapshot(NOTES); // beta.md is present again
    const betaPage = factIdentity({ kind: "page", slug: "beta" }) as string;
    const ledger = createQuarantineLedger([quarantineRecord(betaPage, "purged")]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).not.toContain(betaPage);
    expect(r.value.quarantineBlocked).toContain(betaPage);
    expect(r.value.resurrectionBlocked).toContain(betaPage);
    expect(r.value.healthItems.length).toBe(1);
    expect(r.value.healthItems[0]?.factIdentity).toBe(betaPage);
    expect(() => HealthItemSchema.parse(r.value.healthItems[0])).not.toThrow();
  });

  it("a one-byte re-introduction cannot evade a purge — quarantine identity is content-INDEPENDENT", () => {
    // Same slug ⇒ same page factIdentity, but a different body byte.
    const snap = snapshot({ "beta.md": "---\nslug: beta\n---\nBeta body EDITED.\n" });
    const betaPage = factIdentity({ kind: "page", slug: "beta" }) as string;
    const ledger = createQuarantineLedger([quarantineRecord(betaPage, "purged")]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).not.toContain(betaPage);
    expect(r.value.resurrectionBlocked).toContain(betaPage);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// 23c — QUARANTINE-AS-ABSENCE / MARKDOWN-WINS / SERVE-TIME REBINDING / DEGRADE
// ─────────────────────────────────────────────────────────────────────────────────
describe("12.23c — quarantine non-resurrection · content_mismatch Markdown-wins (real classifier + reconciler)", () => {
  const WS = WorkspaceIdSchema.parse("ws-employer");
  const REV = RevisionIdSchema.parse("rev:abc123");

  function derive(files: Record<string, string>): readonly DerivedFact[] {
    const r = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) });
    if (!r.ok) throw new Error("derive failed in fixture");
    return r.value.facts;
  }
  function byId(facts: readonly DerivedFact[], id: string): DerivedFact {
    const f = facts.find((x) => (x.fact.factIdentity as string) === id);
    if (!f) throw new Error(`no derived fact ${id}`);
    return f;
  }
  const pageFact = (): DerivedFact => byId(derive({ "p.md": "hello prose" }), "page:p");
  function dbFor(canonical: DerivedFact, over: Partial<DbFact> = {}): DbFact {
    return {
      factIdentity: canonical.fact.factIdentity as string,
      factKind: canonical.fact.factKind,
      dbContentHash: canonical.fact.mdContentSha as string,
      stamped: true,
      revisionId: REV as string,
      ...over,
    };
  }

  // Content-INDEPENDENT factIdentity at the ledger layer: a re-introduced fact stays blocked.
  it("the quarantine ledger keys on the content-INDEPENDENT identity — a re-introduced / one-byte-changed fact stays blocked", () => {
    const ID = "page:acme/auth" as FactIdentity;
    const base = {
      factIdentity: ID,
      workspaceId: WS,
      divergenceRef: "div-001",
      divergenceClass: "db_only" as const,
      remediationState: "purged" as const,
      healthItemId: "health-001",
      auditRef: "aud-001" as AuditId,
    };
    const ledger = createQuarantineLedger([{ ...base, capturedDbDigest: "first-capture" }]);
    expect(ledger.isQuarantined(WS, ID)).toBe(true);
    // Re-quarantine the SAME identity with a DIFFERENT captured digest (a re-introduction):
    // it upserts to a single entry and stays blocked — content is never the key.
    ledger.quarantine({ ...base, capturedDbDigest: "second-capture" });
    expect(ledger.isQuarantined(WS, ID)).toBe(true);
    expect(ledger.list()).toHaveLength(1);
  });

  it("content_mismatch → SOFT, Markdown-wins: the divergence carries the canonical mdContentSha, never launders DB content", () => {
    const c = pageFact();
    const db = dbFor(c, { dbContentHash: "deadbeef".repeat(8) });
    const out = classifyDivergence({ present: "both", canonical: c, db }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("content_mismatch");
    expect(out.divergence.severityFloor).toBe("soft"); // does not block serving
    expect(out.divergence.remediation).toBe("resync");
    // Markdown-wins: the resync target is the canonical hash; the DB hash is only recorded.
    expect(out.divergence.mdContentSha).toBe(c.fact.mdContentSha);
    expect(out.divergence.dbContentHash).toBe("deadbeef".repeat(8));
    expect(out.divergence.mdContentSha).not.toBe(out.divergence.dbContentHash);
  });

  it("a content_mismatch keeps the ParityReport clean-for-serving (soft divergence never blocks)", () => {
    let seq = 0;
    const deps: ReconcilerDeps = {
      newReportId: () => `report-${(seq += 1)}`,
      newHealthItemId: () => `health-${(seq += 1)}`,
      newAuditId: () => `audit-${(seq += 1)}`,
      now: () => "2026-07-01T00:00:00.000Z",
    };
    const r0 = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map([["p.md", "hi"]]) });
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    const set: CanonicalFactSet = r0.value;
    const facts: DbFact[] = set.facts.map((df) => ({
      factIdentity: df.fact.factIdentity as string,
      factKind: df.fact.factKind,
      // one fact's DB hash disagrees with Markdown → content_mismatch (soft).
      dbContentHash: (df.fact.factIdentity as string) === "page:p" ? "00".repeat(32) : (df.fact.mdContentSha as string),
      stamped: true,
      revisionId: REV as string,
    }));
    const dbProjection: ReconcilerDbProjection = {
      workspaceId: WS as string,
      gbrainSchemaVersion: 3,
      facts,
      complete: true,
    };
    const req: ReconcileRequest = { origin: "post_commit", canonicalSet: set, dbProjection };
    const r = reconcileParity(req, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.divergences.some((d) => d.divergenceClass === "content_mismatch")).toBe(true);
    expect(r.value.report.cleanForServing).toBe(true); // soft → serving not blocked
  });
});

describe("12.23c — serve-time rebinding + degrade-to-Markdown-only (real rehydration serving gate)", () => {
  const WS = "ws-emp" as WorkspaceId;
  const REV = "rev-001" as unknown as ContractsRevisionId;
  const SHA_AUTH = "a".repeat(64) as MdContentSha;
  const SHA_OTHER = "b".repeat(64) as MdContentSha;
  const SHA_TAMPERED = "c".repeat(64) as MdContentSha;
  const ID_AUTH = "page:acme/auth" as FactIdentity;
  const ID_OTHER = "page:acme/other" as FactIdentity;
  const PATH_AUTH = "acme/auth.md";
  const BODY_AUTH = "# Auth\n\nThe real, committed-Markdown body.";
  const DB_ROW_BYTES = "EVIL fabricated DB-row bytes that must never be served.";
  const SECRET_MARKER = "SUPER-SECRET-HMAC-KEY-DO-NOT-LEAK";
  const REF: SecretRef = "keychain:sow.kw.provenance-signing-key";
  const KEY = new TextEncoder().encode(SECRET_MARKER);

  class FakeSecretsPort implements SecretsPort {
    constructor(private readonly keys: Record<string, Uint8Array>) {}
    async resolveSigningKey(ref: SecretRef) {
      const key = this.keys[ref];
      return key === undefined ? err({ code: "secret_unresolved" as const, ref }) : ok(key);
    }
  }

  function sgDeps(port: SecretsPort = new FakeSecretsPort({ [REF]: KEY })): ServingDeps {
    return { secrets: port, signingKeyRef: REF };
  }

  async function mintStamp(over: Partial<StampInputs> = {}) {
    const inputs: StampInputs = {
      workspaceId: WS,
      factIdentity: ID_AUTH,
      originPath: PATH_AUTH,
      mdContentSha: SHA_AUTH,
      kwRevision: REV,
      sourceEventRef: "meeting:123",
      committedAt: "2026-06-30T12:00:00.000Z",
      ...over,
    };
    const r = await stampProvenance(inputs, { secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF });
    if (!r.ok) throw new Error(`fixture stamp mint failed: ${r.error.code}`);
    return r.value;
  }

  function derivedFact(
    over: { factIdentity?: FactIdentity; mdContentSha?: MdContentSha; originPath?: string } = {},
  ): DerivedFact {
    const fact: SemanticFact = {
      factIdentity: over.factIdentity ?? ID_AUTH,
      factKind: "page",
      workspaceId: WS,
      mdContentSha: over.mdContentSha ?? SHA_AUTH,
      revisionId: REV,
    };
    const provenance: FactProvenance = {
      origin: "markdown",
      kwRevision: REV,
      originPath: over.originPath ?? PATH_AUTH,
      mdContentSha: over.mdContentSha ?? SHA_AUTH,
    };
    return { fact, provenance };
  }
  const allowSet = (facts: DerivedFact[]): CanonicalFactSet => ({ workspaceId: WS, revisionId: REV, facts });
  const coverage = (over: Partial<ServingCoverage> = {}): ServingCoverage => ({
    cleanForServing: true,
    coverageComplete: true,
    pinValid: true,
    oracleBuildOk: true,
    ...over,
  });
  const pointer = (over: Partial<DbPointer> = {}): DbPointer => ({ factIdentity: ID_AUTH as string, score: 0.9, ...over });
  function rehydrateAuth(stamp: RehydratedFact["stamp"]): RehydrateFn {
    return (id) =>
      id === (ID_AUTH as string)
        ? { ok: true, value: { factIdentity: id, content: BODY_AUTH, mdContentSha: SHA_AUTH, stamp } }
        : { ok: false, error: { code: "rehydrate_failed", factIdentity: id, reason: "not_committed" } };
  }
  function request(over: Partial<ServingRequest>): ServingRequest {
    return {
      workspaceId: WS,
      revisionId: REV,
      pointers: [pointer()],
      allowSet: allowSet([derivedFact()]),
      rehydrate: () => ({ ok: false, error: { code: "rehydrate_failed", factIdentity: "x", reason: "unset" } }),
      quarantine: createQuarantineLedger(),
      coverage: coverage(),
      ...over,
    };
  }

  it("serves the MARKDOWN-rehydrated bytes, NEVER the DB-row bytes (bytes-from-Markdown, no DB laundering)", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      request({ pointers: [pointer({ dbBody: DB_ROW_BYTES })], rehydrate: rehydrateAuth(stamp) }),
      sgDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("gated");
    const a = res.value.admitted[0]!;
    expect(a.content).toBe(BODY_AUTH);
    expect(a.content).not.toBe(DB_ROW_BYTES);
    expect(JSON.stringify(res.value)).not.toContain(DB_ROW_BYTES);
    expect(synthesisContext(res.value)).toEqual(res.value.admitted);
  });

  it("withholds a FORGED provenance signature (an attacker without the signing key cannot mint a valid stamp)", async () => {
    const forged: RehydratedFact["stamp"] = {
      kwRevision: REV,
      originPath: PATH_AUTH,
      mdContentSha: SHA_AUTH,
      writerActor: "KnowledgeWriter",
      sourceEventRef: "meeting:123",
      committedAt: "2026-06-30T12:00:00.000Z",
      sig: "deadbeef".repeat(8),
    };
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(forged) }), sgDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signature_invalid" }]);
  });

  it("withholds a BORROWED/COPIED stamp — a genuine stamp for another fact fails serve-time rebinding", async () => {
    const borrowed = await mintStamp({ factIdentity: ID_OTHER, originPath: "acme/other.md", mdContentSha: SHA_OTHER });
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(borrowed) }), sgDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signature_invalid" }]);
  });

  it("withholds when the rehydrated hash != the canonical mdContentSha (tampered/stale bytes)", async () => {
    const stamp = await mintStamp();
    const rehydrate: RehydrateFn = () => ({
      ok: true,
      value: { factIdentity: ID_AUTH as string, content: "tampered", mdContentSha: SHA_TAMPERED, stamp },
    });
    const res = await admitForServing(request({ rehydrate }), sgDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "content_hash_mismatch" }]);
  });

  it("degrades a DIRTY / INCOMPLETE ParityReport (reconciler-failure proxy) to Markdown-provenanced-only serving — never the last-known DB set", async () => {
    const stamp = await mintStamp();
    for (const over of [{ cleanForServing: false }, { coverageComplete: false }] as Partial<ServingCoverage>[]) {
      expect(isDegradedCoverage(coverage(over))).toBe(true);
      const res = await admitForServing(
        request({ pointers: [pointer({ dbBody: DB_ROW_BYTES })], rehydrate: rehydrateAuth(stamp), coverage: coverage(over) }),
        sgDeps(),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.value.mode).toBe("degraded_direct_markdown");
      expect(res.value.admitted).toEqual([]);
      expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "degraded_coverage" }]);
      expect(synthesisContext(res.value)).toEqual([]);
      // fail-closed: the last-known DB row bytes are NEVER served in degraded mode.
      expect(JSON.stringify(res.value)).not.toContain(DB_ROW_BYTES);
    }
  });

  it("fails closed when the signing key cannot be resolved — degrades the whole request (no unverifiable serve)", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(stamp) }), sgDeps(new FakeSecretsPort({})));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("degraded_direct_markdown");
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signing_key_unresolved" }]);
  });
});

describe("12.23c — write-through auto-reverts to Markdown-provenanced-only on a non-clean/incomplete ParityReport (real enablement resolver)", () => {
  const WS = WorkspaceIdSchema.parse("ws-employer");
  const REV = RevisionIdSchema.parse("rev:abc123");

  const allGreen: EnablementConditions = {
    pinValidated: true,
    pinShaMatchesRunning: true,
    goOneWriter: true,
    goNoLostUpdate: true,
    goParityCatchesDbOnly: true,
    goRoundTripLossless: true,
    readTokenRejectsWrite: true,
    embeddingKeyGreen: true,
    noCronOrAutopilot: true,
  };
  const ctx: WriteThroughContext = { now: () => "2026-07-01T00:00:00.000Z", auditRef: "audit-1" };

  // Build a REAL, incomplete-coverage ParityReport from the reconciler (clean but not complete).
  function incompleteReport() {
    let seq = 0;
    const deps: ReconcilerDeps = {
      newReportId: () => `report-${(seq += 1)}`,
      newHealthItemId: () => `health-${(seq += 1)}`,
      newAuditId: () => `audit-${(seq += 1)}`,
      now: () => "2026-07-01T00:00:00.000Z",
    };
    const d = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map([["p.md", "hi"]]) });
    if (!d.ok) throw new Error("derive failed");
    const set = d.value;
    const facts: DbFact[] = set.facts.map((df) => ({
      factIdentity: df.fact.factIdentity as string,
      factKind: df.fact.factKind,
      dbContentHash: df.fact.mdContentSha as string,
      stamped: true,
      revisionId: REV as string,
    }));
    // complete:false → coverageComplete false (clean, but containment unproven).
    const dbProjection: ReconcilerDbProjection = { workspaceId: WS as string, gbrainSchemaVersion: 3, facts, complete: false };
    const r = reconcileParity({ origin: "post_commit", canonicalSet: set, dbProjection }, deps);
    if (!r.ok) throw new Error("reconcile failed");
    return r.value.report;
  }

  it("an incomplete-coverage ParityReport auto-reverts write-through to markdown_provenanced_only (fail-closed, never DB-sourced)", () => {
    const report = incompleteReport();
    expect(report.cleanForServing).toBe(true);
    expect(report.coverageComplete).toBe(false);
    const input: WriteThroughResolveInput = {
      workspaceId: WS,
      flagEnabled: true,
      conditions: allGreen,
      latestParityReport: report,
    };
    const res = resolveWriteThrough(input, ctx);
    expect(res.active).toBe(false);
    expect(res.mode).toBe("markdown_provenanced_only");
    expect(res.reason).toBe("parity_incomplete");
    expect(res.healthItem?.failureClass).toBe("write_through_failed");
    expect(() => HealthItemSchema.parse(res.healthItem)).not.toThrow();
  });

  it("an ABSENT ParityReport also auto-reverts (containment unproven ⇒ Markdown-provenanced-only)", () => {
    const res = resolveWriteThrough({ workspaceId: WS, flagEnabled: true, conditions: allGreen }, ctx);
    expect(res.mode).toBe("markdown_provenanced_only");
    expect(res.reason).toBe("parity_report_absent");
    expect(res.active).toBe(false);
  });
});
