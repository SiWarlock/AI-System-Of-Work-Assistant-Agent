// §13.10a G4a — buildSemanticApprovalDispatch: the composition that wires the on-approval semantic branch
// (gate-1 reader + existence probe over the vault → head-at-commit KnowledgeWriter commit port → executor).
// Uses a RECORDING fake applyPlan (injected) so this proves the WIRING + head-at-commit resolution without a
// full KnowledgeWriter setup; the real writer is exercised by the knowledge suite, and the resolver semantics
// by the workflows commit-activity suite.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Approval } from "@sow/contracts";
import type { AuditRepository, DbError, DbResult, PendingKnowledgeMutation, PendingKnowledgeMutationRepository } from "@sow/db";
import type { ApplyPlanFn } from "@sow/workflows";
import type { WriteSuccess, VaultFs, KnowledgeWriterDeps, KnowledgeRevisionStore, CommittedRevision, StamperDeps } from "@sow/knowledge";
import type { KnowledgeMutationPlan } from "@sow/contracts";
import { LEGACY_UNPREFIXED_WORKSPACE_ID } from "../../src/composition/legacy-workspace";
import { readVaultHeadRevision, readStampField, KW_STAMP_FRONTMATTER_KEY } from "@sow/knowledge";
import { payloadHash } from "@sow/integrations";
import { buildSemanticApprovalDispatch } from "../../src/composition/semanticApprovalDispatch";

const NOW = "2026-07-09T00:00:00.000Z";

/** A schema-valid create KMP (passes the executor's candidate re-gate). Target: the canonical WS-8 note path. */
const validPlan: Record<string, unknown> = {
  planId: "plan-g4-1",
  workspaceId: "personal-business",
  sourceRefs: [{ sourceId: "src-1" }],
  creates: [{ path: "projects/personal-business/acme.md", title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } }],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.5,
  requiresApproval: true,
  provenanceOrigin: "copilot_propose",
  expectedProjectId: "acme",
};
const HASH = payloadHash(validPlan);
const roundTrip = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

function mkRow(over: Partial<PendingKnowledgeMutation> = {}): PendingKnowledgeMutation {
  return { planId: "plan-g4-1", workspaceId: "personal-business", plan: validPlan, payloadHash: HASH, status: "pending", recordedAt: "2026-07-08T00:00:00.000Z", ...over };
}
function mkApproval(over: Record<string, unknown> = {}): Approval {
  return { id: "appr-1", planRef: "plan-g4-1", subjectKind: "semantic_mutation", workspaceId: "personal-business", status: "approved", actor: "copilot", channel: "mac", payloadHash: HASH, ...over } as unknown as Approval;
}
function fakePendingKmp(seed: PendingKnowledgeMutation): { repo: PendingKnowledgeMutationRepository; store: Map<string, PendingKnowledgeMutation> } {
  const store = new Map<string, PendingKnowledgeMutation>([[seed.planId, { ...seed, plan: roundTrip(seed.plan) }]]);
  const repo: PendingKnowledgeMutationRepository = {
    record: (e) => Promise.resolve(ok(e)),
    get: (planId) => Promise.resolve(store.has(planId) ? ok(store.get(planId)!) : err({ code: "not_found", message: "nf" } satisfies DbError)) as DbResult<PendingKnowledgeMutation>,
    update: (e) => { store.set(e.planId, e); return Promise.resolve(ok(e)); },
  };
  return { repo, store };
}
function memVault(files: Record<string, string>): VaultFs {
  const m = new Map(Object.entries(files));
  return {
    list: async () => [...m.keys()],
    read: async (p) => m.get(p),
    write: async (p, c) => { m.set(p, c); },
    rename: async (from, to) => { const v = m.get(from); if (v !== undefined) { m.set(to, v); m.delete(from); } },
    remove: async (p) => { m.delete(p); },
  };
}
function recordingApplyPlan(): { fn: ApplyPlanFn; calls: { expectedBaseRevision: string; planId: string; sourceEventRef: string }[] } {
  const calls: { expectedBaseRevision: string; planId: string; sourceEventRef: string }[] = [];
  const fn: ApplyPlanFn = (command) => {
    // `command.plan` is candidate data (typed `unknown` at the writer boundary) — narrow it just to read planId.
    const planId = String((command.plan as { planId?: unknown }).planId);
    // sourceEventRef is what the writer stamps into the AuditRecord + CommittedRevision — capture it to prove
    // the authorizing approval id was folded in.
    calls.push({ expectedBaseRevision: String(command.expectedBaseRevision), planId, sourceEventRef: command.sourceEventRef });
    return Promise.resolve(ok({ revisionId: "rev-new" as WriteSuccess["revisionId"], auditRecord: {} as WriteSuccess["auditRecord"], replayed: false } as WriteSuccess));
  };
  return { fn, calls };
}

function build(vault: VaultFs, applyPlan: ApplyPlanFn, seed = mkRow()): { dispatch: ReturnType<typeof buildSemanticApprovalDispatch>; kmp: ReturnType<typeof fakePendingKmp> } {
  const kmp = fakePendingKmp(seed);
  const dispatch = buildSemanticApprovalDispatch({
    vault,
    pendingKmp: kmp.repo,
    revisions: {} as never, // unused by the recording fake applyPlan
    audit: {} as never,
    now: () => NOW,
    commit: { actor: "copilot-approval", sourceEventRef: "copilot.propose_knowledge", workflowRunRef: "run-1" as never },
    applyPlan,
  });
  return { dispatch, kmp };
}

describe("buildSemanticApprovalDispatch", () => {
  it("commits an approved create card whose target path is FREE, resolving the base revision to the live head", async () => {
    const vault = memVault({}); // empty ⇒ Projects/acme.md is free
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(applied.calls).toHaveLength(1);
    expect(applied.calls[0]?.planId).toBe("plan-g4-1");
    // Head-at-commit: the base revision handed to the writer is the CURRENT live head (not a fixed value).
    expect(applied.calls[0]?.expectedBaseRevision).toBe(await readVaultHeadRevision(vault));
    // Audit-trail linkage: the authorizing approval id is folded into the sourceEventRef the writer records.
    expect(applied.calls[0]?.sourceEventRef).toBe("copilot.propose_knowledge#approval:appr-1");
    expect(kmp.store.get("plan-g4-1")?.status).toBe("committed");
  });

  it("head-at-commit reflects an UNRELATED vault change since propose (would spuriously conflict on a fixed base)", async () => {
    // A note added between propose and approve moves the whole-vault head. A FIXED base would clash here; the
    // resolver picks up the current head, so the commit proceeds (the target Projects/acme.md is still free).
    const vault = memVault({ "notes/added-after-propose.md": "hi\n" });
    const applied = recordingApplyPlan();
    const { dispatch } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(applied.calls[0]?.expectedBaseRevision).toBe(await readVaultHeadRevision(vault)); // head includes the new note
  });

  it("REJECTS a create whose target path is OCCUPIED (gate-1 existence probe over the vault) — no commit", async () => {
    const vault = memVault({ "projects/personal-business/acme.md": "---\nprojectId: someone-else\n---\n# Other\n" });
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SEMANTIC_DISPATCH_CREATE_TARGET_EXISTS");
    expect(applied.calls).toHaveLength(0); // fail-closed BEFORE the writer
    expect(kmp.store.get("plan-g4-1")?.status).toBe("pending"); // unchanged
  });

  it("settles a REJECTED card without committing (marks the row rejected)", async () => {
    const vault = memVault({});
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval({ status: "rejected" }));
    expect(isOk(r)).toBe(true);
    expect(applied.calls).toHaveLength(0);
    expect(kmp.store.get("plan-g4-1")?.status).toBe("rejected");
  });
});

// --- 24.26: the exempt workspace id is SUPPLIED, and since step 3 it is the SOLE enforcement ---
//
// ⛔ WHY THESE ARE BOUNDARY PINS AND NOT END-TO-END BEHAVIOURAL TESTS. The reason CHANGED at step 3
// (`46e34ca8`) and both halves are worth keeping, because the pins are correct under each:
//
//   • BEFORE step 3 — an end-to-end test would have been VACUOUS. `applyPlan` read
//     `deps.workspacePathCheck ?? enforceWorkspacePathScope`, and that fallback was the SAME factory
//     over the SAME string this composition supplies, so a plan drove IDENTICALLY whether the wiring
//     existed or not — the test would have stayed green with the wiring deleted.
//   • ⛔ SINCE step 3 — the `??` fallback is DELETED and `KnowledgeWriterDeps.workspacePathCheck` is
//     REQUIRED, so "the wiring deleted" no longer compiles (`TS2741`, mutation-verified at the
//     buildActivities.ts site). The vacuity is gone, and so is the need for an end-to-end test to
//     catch ABSENCE — the type system catches that.
//
// ⭐ WHAT THE PINS STILL EARN, and it is the residual the type system CANNOT reach: a required
// parameter type-checks PRESENCE, never the STRING. Supplying the WRONG exempt workspace id compiles
// perfectly and silently re-points a rule-4 / WS-8 path guard (`worker L28` — mutation-proved on the
// higher-traffic sibling literal, where a wrong-id change left 2095 tests green). These pin WHICH
// check instance reaches the writer, which is exactly the axis left unguarded.
//
// ⚠ ERRATUM (24.26 step-3 spinoff). This block used to forecast that these "become genuine
// behavioural tests at step 3", and anchored that on two BARE LINE NUMBERS — one into `writer.ts`,
// one into `workspace-path-guard.ts`. Step 3 landed and both rotted the same day: the guard-file
// anchor now points PAST END OF FILE (that file is 163 lines), and the writer anchor lands on
// unrelated prose. ⛔ The dead line numbers are deliberately NOT reproduced here — quoting them would
// leave the exact strings a future dangling-citation sweep hunts for. Both are replaced by SYMBOL
// references above, per this round's ruling: a line number rots SILENTLY (it still resolves, to the
// wrong thing) whereas an absent symbol gets investigated. This comment is one of the sites that
// motivated the rule.
describe("buildSemanticApprovalDispatch — exempt workspace id from the composition root (24.26 step 2)", () => {
  /** Captures the KnowledgeWriterDeps that actually reach the writer boundary. */
  function capturingApplyPlan(): { fn: ApplyPlanFn; deps: () => KnowledgeWriterDeps | undefined } {
    let seen: KnowledgeWriterDeps | undefined;
    const fn = ((_cmd: unknown, d: KnowledgeWriterDeps) => {
      seen = d;
      return Promise.resolve(ok({ revisionId: "rev-1", planId: "plan-g4-1" } as unknown as WriteSuccess));
    }) as unknown as ApplyPlanFn;
    return { fn, deps: () => seen };
  }

  it("supplies workspacePathCheck on the deps that reach the writer (not the writer's fallback)", async () => {
    const cap = capturingApplyPlan();
    const { dispatch } = build(memVault({}), cap.fn);
    await dispatch(mkApproval());
    // The ONLY observable difference this slice makes.
    expect(cap.deps()?.workspacePathCheck).toBeDefined();
  });

  it("the supplied check carries the exempt id — exempt commits unprefixed, non-exempt does not", async () => {
    // THE DIFFERENTIAL, and the one with real force: exercising the captured check with two
    // workspaces proves the SUPPLIED value is the one in effect and carries the right id. This
    // is what catches a factory wired with the WRONG id — the failure the identical-string
    // coincidence hides from every end-to-end assertion.
    const cap = capturingApplyPlan();
    const { dispatch } = build(memVault({}), cap.fn);
    await dispatch(mkApproval());
    const check = cap.deps()?.workspacePathCheck;
    expect(check).toBeDefined();

    const planFor = (workspaceId: string): KnowledgeMutationPlan =>
      ({ ...validPlan, workspaceId }) as unknown as KnowledgeMutationPlan;

    // The exempt workspace may commit an UNPREFIXED path.
    expect(isOk(check!({ path: "acme.md", plan: planFor(LEGACY_UNPREFIXED_WORKSPACE_ID) }))).toBe(true);
    // Any other workspace may not — the control (L80). A check built with the wrong id reds here.
    const other = check!({ path: "acme.md", plan: planFor("employer-work") });
    expect(isErr(other)).toBe(true);
    if (isErr(other)) expect(other.error.code).toBe("workspace_path_violation");
  });

  it("builds the check ONCE at composition, not per approval", async () => {
    // Criterion 3. `writerDeps` is constructed once in buildSemanticApprovalDispatch, OUTSIDE the
    // per-approval `commit:` closure, so every approval must see the SAME check instance. A
    // per-approval construction would re-run the factory on a job path — where a blank/missing id
    // throws, and `applyPlan` promises a typed WriteFailure rather than an uncaught throw (step 1's
    // note). Reference equality is the assertion because that is precisely what "once" means here.
    const cap = capturingApplyPlan();
    const { dispatch } = build(memVault({}), cap.fn);
    await dispatch(mkApproval());
    const first = cap.deps()?.workspacePathCheck;
    await dispatch(mkApproval({ id: "appr-2" }));
    const second = cap.deps()?.workspacePathCheck;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("buildActivities' literal supplies the check from the SAME shared const (worker L28 source pin)", () => {
    // ⛔ WHY A SOURCE ASSERTION, AND WHY IT LIVES HERE. 24.26 wires TWO KnowledgeWriterDeps
    // literals. The sibling above is defended by a runtime differential; `buildActivities.ts`
    // is NOT, and it is the HIGHER-TRAFFIC of the two (it feeds BOTH `commit` and
    // `sourceCommit` — meeting closeout AND source ingestion, the real KnowledgeWriter path).
    // It has no lightweight runtime seam: exercising it needs full backends.
    //
    // The gap is not theoretical — the 24.26 step-2 security review MUTATION-PROVED it:
    // rewriting that literal to `makeEnforceWorkspacePathScope("employer-work")` — a live
    // rule-4 exemption change on the main write path — left the ENTIRE worker suite green
    // (163 files, 2095 tests). ⚠ And step 3 does NOT close it: making the parameter REQUIRED
    // type-checks PRESENCE, never the string. So a source pin anchored on the shared const is
    // the cheapest thing that reds on a weakened id (worker L28's precedent for exactly this
    // shape — a site with no runtime seam).
    const src = readFileSync(
      new URL("../../src/composition/buildActivities.ts", import.meta.url),
      "utf8",
    );
    // Must build from the shared const, NOT a literal string — a hardcoded id here would be a
    // fourth copy AND could silently diverge from the one this slice exists to single-source.
    expect(src).toContain("makeEnforceWorkspacePathScope(LEGACY_UNPREFIXED_WORKSPACE_ID)");
    expect(src).toContain('from "./legacy-workspace"');
    // Non-vacuity control: the anchor is only meaningful if the surrounding key is present.
    expect(src).toContain("workspacePathCheck:");
  });
});

// --- task 22.4/20.2 — the KnowledgeWriter provenance-signing dep, closes the CONFIRMED verification
// finding "boot never passes `signing` to the semantic dispatch": these tests exercise the REAL
// `@sow/knowledge` writer (via the default `applyPlan`, never the recording fake above), over a REAL
// in-memory `KnowledgeRevisionStore` + `AuditRepository`, so a genuine `SignedProvenanceStamp` is
// minted, embedded in the committed frontmatter, and read back — not merely observed at the deps
// boundary. `signing` present ⇒ a stamp; absent (the shipped default) ⇒ byte-identical to pre-20.2.
describe("buildSemanticApprovalDispatch — provenance-signing seam (task 22.4)", () => {
  /** A REAL in-memory KnowledgeRevisionStore (the writer's own idempotency guard reads/writes it). */
  function memRevisionStore(): KnowledgeRevisionStore {
    const byKey = new Map<string, CommittedRevision>();
    return {
      getByIdempotencyKey: (k) => Promise.resolve(byKey.get(k)),
      record: (rev) => {
        byKey.set(rev.idempotencyKey, rev);
        return Promise.resolve();
      },
    };
  }

  /** A REAL in-memory AuditRepository (the writer appends one AuditRecord per commit). */
  function memAuditRepository(): AuditRepository {
    return {
      append: () => Promise.resolve(ok(undefined)),
      query: () => Promise.resolve(ok([])),
    };
  }

  // A REAL, well-formed WorkflowRunRef — NOT the bare `"run-1" as never` shortcut the recording-fake
  // tests above use. That shortcut is harmless there (the recording fake never reads `.workflowId`),
  // but the REAL writer's `buildCommitAuditRecord` folds `workflowRunRef.workflowId` into the
  // AuditRecord's `refs` array — a bare string cast leaves that `.workflowId` read `undefined`, which
  // trips an UNRELATED pre-existing crash in the redaction-safety scan
  // (`packages/domain/src/redaction/redaction-rules.ts`'s `stripMarkers` calls `.split()` on the
  // unguarded value) — a genuine out-of-territory defect (flagged separately), not something these
  // tests should paper over by continuing to use a malformed fixture.
  const REAL_RUN_REF = {
    workflowId: "wf-run-1",
    trigger: "owner_action",
    state: "running",
    idempotencyKey: "run:1",
    auditRefs: [],
  } as never;

  /** A fake StamperDeps: resolves a fixed 32-byte key, never touches a real Keychain. */
  function fakeSigning(): StamperDeps {
    return {
      secrets: {
        resolveSigningKey: () => Promise.resolve(ok(new Uint8Array(32).fill(7))),
      },
      signingKeyRef: "keychain://test/kw-signing-key",
    };
  }

  /** Build over the REAL writer (`applyPlan` OMITTED ⇒ defaults to the real `@sow/knowledge` writer). */
  function buildReal(
    vault: VaultFs,
    over: { readonly signing?: StamperDeps } = {},
  ): { dispatch: ReturnType<typeof buildSemanticApprovalDispatch>; kmp: ReturnType<typeof fakePendingKmp> } {
    const kmp = fakePendingKmp(mkRow());
    const dispatch = buildSemanticApprovalDispatch({
      vault,
      pendingKmp: kmp.repo,
      revisions: memRevisionStore(),
      audit: memAuditRepository(),
      now: () => NOW,
      commit: { actor: "copilot-approval", sourceEventRef: "copilot.propose_knowledge", workflowRunRef: REAL_RUN_REF },
      ...(over.signing !== undefined ? { signing: over.signing } : {}),
    });
    return { dispatch, kmp };
  }

  it("WITH a fake stamper: one real KnowledgeWriter commit whose bytes carry a SignedProvenanceStamp", async () => {
    const vault = memVault({});
    const { dispatch, kmp } = buildReal(vault, { signing: fakeSigning() });
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(kmp.store.get("plan-g4-1")?.status).toBe("committed");
    const content = await vault.read("projects/personal-business/acme.md");
    expect(content).toBeDefined();
    const stamp = readStampField(content!);
    expect(stamp).not.toBeNull();
    expect(stamp?.writerActor).toBe("KnowledgeWriter");
    expect(typeof stamp?.sig).toBe("string");
    expect(stamp?.sig.length).toBeGreaterThan(0);
    // Non-vacuity: the raw serialized stamp key is really present on disk (not just parsed back true).
    expect(content).toContain(KW_STAMP_FRONTMATTER_KEY);
  });

  it("re-approval (stranded-card re-drive) is idempotent via the writer's kw:commit:<planId> key — no second commit, no re-stamp", async () => {
    // Simulates the §13.10a hardening-residual #1 scenario the reconciler exists for: a PRIOR run's
    // KnowledgeWriter commit landed (its idempotencyKey is durably recorded in `revisions`) but the
    // pending-KMP row's status-advance did not (crash between them) — so a stranded row is still
    // "pending" and a re-approval/re-drive dispatches AGAIN for the SAME plan. Pre-seed `revisions`
    // with the record a first successful commit would have left, and leave the vault EMPTY (nothing
    // this run has written yet) — the writer's `getByIdempotencyKey` check runs PRE-COMMIT (before any
    // vault I/O, writer.ts's own "nothing written yet" note), so a genuine replay must return `ok`
    // WITHOUT ever touching the vault. That is the load-bearing, directly observable proof of
    // idempotency: a re-approval that actually re-executed the commit would write the note (and mint a
    // SECOND stamp); a replay leaves the vault exactly as it found it.
    const vault = memVault({});
    const revisions = memRevisionStore();
    await revisions.record({
      revisionId: "rev:prior",
      baseRevisionId: await readVaultHeadRevision(vault),
      idempotencyKey: "kw:commit:plan-g4-1",
      planId: "plan-g4-1" as never,
      actor: "copilot-approval",
      sourceEventRef: "copilot.propose_knowledge#approval:appr-1",
      workflowRunRef: REAL_RUN_REF,
      auditRecord: {} as never,
      committedAt: NOW,
    });
    const kmp = fakePendingKmp(mkRow());
    const dispatch = buildSemanticApprovalDispatch({
      vault,
      pendingKmp: kmp.repo,
      revisions,
      audit: memAuditRepository(),
      now: () => NOW,
      commit: { actor: "copilot-approval", sourceEventRef: "copilot.propose_knowledge", workflowRunRef: REAL_RUN_REF },
      signing: fakeSigning(),
    });
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    // The replay short-circuited BEFORE any vault write — the note was never created by THIS dispatch.
    expect(await vault.read("projects/personal-business/acme.md")).toBeUndefined();
    // The row is still marked committed (step 9 of the executor advances status on any `ok` outcome,
    // replay included) — the operational-truth layer sees a settled card either way.
    expect(kmp.store.get("plan-g4-1")?.status).toBe("committed");
  });

  it("with NO signing key (the shipped default): no stamp, and the committed bytes are the same as an unsigned commit", async () => {
    const vault = memVault({});
    const { dispatch, kmp } = buildReal(vault); // signing OMITTED
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(kmp.store.get("plan-g4-1")?.status).toBe("committed");
    const content = await vault.read("projects/personal-business/acme.md");
    expect(content).toBeDefined();
    expect(readStampField(content!)).toBeNull();
    expect(content).not.toContain(KW_STAMP_FRONTMATTER_KEY);
  });

  it("signing present vs absent produce DIFFERENT committed bytes (the stamp is really embedded, not a no-op)", async () => {
    const vaultSigned = memVault({});
    const vaultUnsigned = memVault({});
    await buildReal(vaultSigned, { signing: fakeSigning() }).dispatch(mkApproval());
    await buildReal(vaultUnsigned).dispatch(mkApproval());
    const signedContent = await vaultSigned.read("projects/personal-business/acme.md");
    const unsignedContent = await vaultUnsigned.read("projects/personal-business/acme.md");
    expect(signedContent).toBeDefined();
    expect(unsignedContent).toBeDefined();
    expect(signedContent).not.toBe(unsignedContent);
  });
});
