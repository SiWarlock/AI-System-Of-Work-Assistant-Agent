// CA-4 — 20.2: thread the optional KnowledgeWriter provenance-signing dep (`StamperDeps`) into
// `buildSemanticApprovalDispatch` (site 1 — the on-approval semantic-write commit path, wired in
// `apps/worker/src/composition/semanticApprovalDispatch.ts`).
//
// SITE 2 (`buildProofSpineActivities`, `apps/worker/src/composition/buildActivities.ts`) was
// ALREADY wired at task 19.2 and has its own exhaustive behavioural coverage in
// `provenanceSigning.test.ts` (absent ⇒ byte-identical / present ⇒ verifies / tampered ⇒ fails /
// locked Keychain ⇒ parity_defect + still-unstamped commit) — this file does NOT duplicate that
// battery. It closes the GAP task 19.2 left open: `semanticApprovalDispatch.ts` had ZERO
// `signing` wiring, so an APPROVED Copilot semantic-write KMP could only ever commit unstamped no
// matter how the C5.4b serving oracle side was provisioned. `signing_is_threaded_at_BOTH_sites`
// below re-confirms site 2 stays wired with a source-anchored pin (worker L28 precedent — no
// lightweight runtime seam exists there without re-running the heavy `assembleBackends` battery a
// second time).
//
// ⛔ DORMANT: `signing` stays OPTIONAL on `SemanticApprovalDispatchDeps`, no key is provisioned, no
// default flips. The unprovisioned commit is proven BYTE-IDENTICAL against a golden struck
// directly from the raw `@sow/knowledge` writer, independent of this composition.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, err, isOk, workspaceId, workflowId } from "@sow/contracts";
import type { Approval, FactIdentity, MdContentSha, Result, WorkflowRunRef } from "@sow/contracts";
import type { DbError, DbResult, PendingKnowledgeMutation, PendingKnowledgeMutationRepository } from "@sow/db";
import type { ApplyPlanFn } from "@sow/workflows";
import { projectNotePath } from "@sow/workflows/activities/projections/noteSlug";
import {
  applyPlan as realApplyPlan,
  computePageProvenance,
  makeEnforceWorkspacePathScope,
  readStampField,
  readVaultHeadRevision,
  verifyProvenanceStamp,
} from "@sow/knowledge";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
  SecretRef,
  SecretsPort,
  SecretUnresolved,
  StamperDeps,
  VaultFs,
  WriteSuccess,
} from "@sow/knowledge";
import { payloadHash } from "@sow/integrations";
import { LEGACY_UNPREFIXED_WORKSPACE_ID } from "../../src/composition/legacy-workspace";
import { assembleBackends } from "../../src/composition/backends";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import { buildSemanticApprovalDispatch } from "../../src/composition/semanticApprovalDispatch";

const NOW = "2026-08-24T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS = LEGACY_UNPREFIXED_WORKSPACE_ID; // "personal-business" — the exempt/unprefixed workspace
const WS_ID = workspaceId(WS);
// A REAL WorkflowRunRef object — `buildCommitAuditRecord` reads `.workflowId` off it into the
// AuditRecord's `refs` array, so a bogus string-cast (fine for the fake-applyPlan capture tests
// below, which never touch this field) would poison the real writer's audit-redaction scan with an
// `undefined` ref and fail closed on `audit_record_failed` — caught the hard way via a debug repro.
const RUN_REF: WorkflowRunRef = {
  workflowId: workflowId("wf-20-2"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:20-2",
  auditRefs: [],
};

/** The executor's gate-1 containment check requires the EXACT `projects/<ws>/<slug>.md` shape. */
function planPath(projectId: string): string {
  const p = projectNotePath(WS_ID, projectId);
  if (p === null) throw new Error(`projectNotePath returned null for projectId=${projectId}`);
  return p;
}

// ── a self-contained fake SecretsPort. `packages/knowledge/test/writer.test.ts`'s FakeSecretsPort
// is test-internal to that package (not exported) — this is a deliberate, minimal, independently
// authored copy sharing the same shape, not an import across the package boundary. ──
const SIGNING_KEY = new Uint8Array(32).fill(9);
const SIGNING_KEY_REF: SecretRef = "keychain:test.kw.provenance-signing-key";
class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: SecretRef): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const goodSigning = (): StamperDeps => ({
  secrets: new FakeSecretsPort({ [SIGNING_KEY_REF]: SIGNING_KEY }),
  signingKeyRef: SIGNING_KEY_REF,
});
const badSigning = (): StamperDeps => ({ secrets: new FakeSecretsPort({}), signingKeyRef: SIGNING_KEY_REF });

// ── plan / approval / pending-KMP fixtures. `semanticApprovalDispatch.test.ts`'s equivalents are
// local un-exported functions in that sibling file — independent copies of the same shape here. ──
function mkPlan(planId: string, projectId: string): Record<string, unknown> {
  return {
    planId,
    workspaceId: WS,
    sourceRefs: [{ sourceId: "src-20-2" }],
    creates: [{ path: planPath(projectId), title: "Acme", body: "# Acme", frontmatter: { projectId } }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.5,
    requiresApproval: true,
    provenanceOrigin: "copilot_propose",
    expectedProjectId: projectId,
  };
}
function mkRow(plan: Record<string, unknown>, planId: string): PendingKnowledgeMutation {
  return {
    planId,
    workspaceId: WS,
    plan,
    payloadHash: payloadHash(plan),
    status: "pending",
    recordedAt: "2026-08-24T00:00:00.000Z",
  };
}
function mkApproval(planId: string, plan: Record<string, unknown>): Approval {
  return {
    id: `appr-${planId}`,
    planRef: planId,
    subjectKind: "semantic_mutation",
    workspaceId: WS,
    status: "approved",
    actor: "copilot",
    channel: "mac",
    payloadHash: payloadHash(plan),
  } as unknown as Approval;
}
function fakePendingKmp(seed: PendingKnowledgeMutation): {
  repo: PendingKnowledgeMutationRepository;
  store: Map<string, PendingKnowledgeMutation>;
} {
  const store = new Map<string, PendingKnowledgeMutation>([[seed.planId, seed]]);
  const repo: PendingKnowledgeMutationRepository = {
    record: (e) => Promise.resolve(ok(e)),
    get: (planId) =>
      (store.has(planId)
        ? Promise.resolve(ok(store.get(planId)!))
        : Promise.resolve(err({ code: "not_found", message: "nf" } satisfies DbError))) as DbResult<PendingKnowledgeMutation>,
    update: (e) => {
      store.set(e.planId, e);
      return Promise.resolve(ok(e));
    },
  };
  return { repo, store };
}
function memVault(files: Record<string, string> = {}): VaultFs {
  const m = new Map(Object.entries(files));
  return {
    list: async () => [...m.keys()],
    read: async (p) => m.get(p),
    write: async (p, c) => {
      m.set(p, c);
    },
    rename: async (from, to) => {
      const v = m.get(from);
      if (v !== undefined) {
        m.set(to, v);
        m.delete(from);
      }
    },
    remove: async (p) => {
      m.delete(p);
    },
  };
}

// ── real-backends harness (temp sqlite + temp fs vault per test, mirrors provenanceSigning.test.ts's
// tempDbPath pattern) so tests (a)/(b)/(d) run the REAL @sow/knowledge writer end-to-end — a fake
// applyPlan can prove wiring (test c) but cannot prove a real kwStamp appears in committed bytes. ──
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-20-2-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

async function buildRealDispatch(
  signing: StamperDeps | undefined,
  suffix: string,
): Promise<{
  dispatch: ReturnType<typeof buildSemanticApprovalDispatch>;
  backends: Awaited<ReturnType<typeof assembleBackends>>;
  planId: string;
  projectId: string;
  path: string;
}> {
  const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() });
  const revisions = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
  const planId = `plan-20-2-${suffix}`;
  const projectId = `acme-${suffix}`;
  const path = planPath(projectId);
  const plan = mkPlan(planId, projectId);
  const kmp = fakePendingKmp(mkRow(plan, planId));
  const dispatch = buildSemanticApprovalDispatch({
    vault: backends.vault,
    pendingKmp: kmp.repo,
    revisions,
    audit: backends.repos.audit,
    now: () => NOW,
    commit: { actor: "copilot-approval", sourceEventRef: `evt:20-2-${suffix}`, workflowRunRef: RUN_REF },
    ...(signing !== undefined ? { signing } : {}),
  });
  return { dispatch, backends, planId, projectId, path };
}

describe("buildSemanticApprovalDispatch — provenance-signing dep (task 20.2)", () => {
  it("unprovisioned_commit_is_byte_identical: no signing ⇒ committed bytes match a golden struck directly from the raw writer, no kwStamp", async () => {
    const { dispatch, backends, planId, projectId, path } = await buildRealDispatch(undefined, "unprov");
    try {
      const r = await dispatch(mkApproval(planId, mkPlan(planId, projectId)));
      expect(isOk(r)).toBe(true);
      const committed = await backends.vault.read(path);
      expect(committed).toBeDefined();
      if (committed === undefined) return;
      expect(committed).not.toContain("kwStamp");
      expect(readStampField(committed)).toBeNull();

      // Golden: strike the SAME plan directly through the raw @sow/knowledge writer, on an
      // INDEPENDENT vault/store, with an equivalent KnowledgeWriterDeps that OMITS `signing`
      // entirely — proving buildSemanticApprovalDispatch's own writerDeps construction is a
      // pass-through on the unprovisioned path, not a second transform of the bytes.
      const goldenBackends = await assembleBackends({
        now: () => NOW,
        allowedLocalEndpoints: [LOCAL_ENDPOINT],
        dbPath: tempDbPath(),
      });
      try {
        const goldenRevisions = createKnowledgeRevisionStoreAdapter(goldenBackends.repos.knowledgeRevisions);
        const goldenDeps: KnowledgeWriterDeps = {
          vault: goldenBackends.vault,
          revisions: goldenRevisions,
          audit: goldenBackends.repos.audit,
          now: () => NOW,
          workspacePathCheck: makeEnforceWorkspacePathScope(WS),
        };
        const cmd: KnowledgeWriteCommand = {
          plan: mkPlan(planId, projectId),
          expectedBaseRevision: await readVaultHeadRevision(goldenBackends.vault),
          actor: "copilot-approval",
          sourceEventRef: `evt:20-2-unprov#approval:appr-${planId}`,
          workflowRunRef: RUN_REF,
          idempotencyKey: `kw:commit:${planId}`,
        };
        const goldenResult = await realApplyPlan(cmd, goldenDeps);
        expect(isOk(goldenResult)).toBe(true);
        const golden = await goldenBackends.vault.read(path);
        expect(golden).toBeDefined();
        expect(committed).toBe(golden);
      } finally {
        goldenBackends.close();
      }
    } finally {
      backends.close();
    }
  });

  it("provisioned_commit_embeds_a_verifiable_kwStamp: a supplied signing dep embeds a kwStamp that VERIFIES over the committed note", async () => {
    const signing = goodSigning();
    const { dispatch, backends, planId, projectId, path } = await buildRealDispatch(signing, "prov");
    try {
      const r = await dispatch(mkApproval(planId, mkPlan(planId, projectId)));
      expect(isOk(r)).toBe(true);
      const committed = await backends.vault.read(path);
      expect(committed).toBeDefined();
      if (committed === undefined) return;
      const stamp = readStampField(committed);
      expect(stamp).not.toBeNull();
      if (stamp === null) return;
      const page = computePageProvenance(path, committed);
      expect(page).not.toBeNull();
      if (page === null) return;
      const verified = await verifyProvenanceStamp(
        {
          stamp,
          workspaceId: WS_ID,
          factIdentity: page.pageIdentity as FactIdentity,
          originPath: stamp.originPath,
          mdContentSha: page.pageSha as MdContentSha,
        },
        signing,
      );
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.value).toBe(true);
    } finally {
      backends.close();
    }
  });

  it("an_unresolvable_key_still_commits_unstamped: a SecretsPort that cannot resolve the key STILL COMMITS (fail-safe, safety rule 1) — no kwStamp", async () => {
    const signing = badSigning();
    const { dispatch, backends, planId, projectId, path } = await buildRealDispatch(signing, "badkey");
    try {
      const r = await dispatch(mkApproval(planId, mkPlan(planId, projectId)));
      expect(isOk(r)).toBe(true); // a stamping fault NEVER blocks the semantic write
      const committed = await backends.vault.read(path);
      expect(committed).toBeDefined();
      if (committed === undefined) return;
      expect(readStampField(committed)).toBeNull();
    } finally {
      backends.close();
    }
  });

  describe("signing_is_threaded_at_BOTH_sites", () => {
    /** Captures the KnowledgeWriterDeps that actually reach the writer boundary (site 1). */
    function capturingApplyPlan(): { fn: ApplyPlanFn; deps: () => KnowledgeWriterDeps | undefined } {
      let seen: KnowledgeWriterDeps | undefined;
      const fn = ((_cmd: unknown, d: KnowledgeWriterDeps) => {
        seen = d;
        return Promise.resolve(ok({ revisionId: "rev-1" } as unknown as WriteSuccess));
      }) as unknown as ApplyPlanFn;
      return { fn, deps: () => seen };
    }
    function buildFakeDispatch(
      applyPlan: ApplyPlanFn,
      signing: StamperDeps | undefined,
      planId: string,
      projectId: string,
    ): ReturnType<typeof buildSemanticApprovalDispatch> {
      const plan = mkPlan(planId, projectId);
      const kmp = fakePendingKmp(mkRow(plan, planId));
      return buildSemanticApprovalDispatch({
        vault: memVault(),
        pendingKmp: kmp.repo,
        revisions: {} as never, // unused by the recording fake applyPlan
        audit: {} as never,
        now: () => NOW,
        commit: { actor: "copilot-approval", sourceEventRef: `evt:20-2-${planId}`, workflowRunRef: RUN_REF },
        applyPlan,
        ...(signing !== undefined ? { signing } : {}),
      });
    }

    it("site 1 (semanticApprovalDispatch.ts): the deps reaching the writer carry `signing` when supplied, reference-equal to what was passed in", async () => {
      const signing = goodSigning();
      const cap = capturingApplyPlan();
      const planId = "plan-20-2-cap-a";
      const projectId = "acme-cap-a";
      const dispatch = buildFakeDispatch(cap.fn, signing, planId, projectId);
      await dispatch(mkApproval(planId, mkPlan(planId, projectId)));
      expect(cap.deps()?.signing).toBe(signing);
    });

    it("site 1 (semanticApprovalDispatch.ts): the deps OMIT the `signing` key entirely when unsupplied — never `signing: undefined`", async () => {
      const cap = capturingApplyPlan();
      const planId = "plan-20-2-cap-b";
      const projectId = "acme-cap-b";
      const dispatch = buildFakeDispatch(cap.fn, undefined, planId, projectId);
      await dispatch(mkApproval(planId, mkPlan(planId, projectId)));
      const seen = cap.deps();
      expect(seen).toBeDefined();
      // The load-bearing assertion: a naive `signing: deps.signing` (no conditional spread) would
      // leave the KEY present with value `undefined` here, which `toBeUndefined()` cannot tell
      // apart from omission — `in` is the only check that distinguishes them.
      expect("signing" in (seen as object)).toBe(false);
    });

    it("site 2 (buildActivities.ts) — already wired at task 19.2; source-anchored pin (worker L28: no lightweight runtime seam exists here without re-running the full assembleBackends battery provenanceSigning.test.ts already carries)", () => {
      const src = readFileSync(new URL("../../src/composition/buildActivities.ts", import.meta.url), "utf8");
      expect(src).toContain("...(params.signing !== undefined ? { signing: params.signing } : {})");
      // Non-vacuity control: the anchor is meaningful only if the surrounding writerDeps object
      // it is spread into still exists under that name.
      expect(src).toContain("const knowledgeWriterDeps: KnowledgeWriterDeps = {");
    });
  });
});
