// Task 19.2 — worker-side pins for the KnowledgeWriter provenance-signing dep
// threaded through `buildProofSpineActivities`, and the boot.ts wrapper that
// mints a `parity_defect` HealthItem on a locked Keychain resolution.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok, err, workspaceId, workflowId, sourceId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceId, HealthItem } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingJobInputs, SourceNoteIdentity, ValidatedExtraction } from "@sow/workflows";
import type { HealthItemStore } from "@sow/workflows";
import { computePageProvenance, readStampField, verifyProvenanceStamp } from "@sow/knowledge";
import type { SecretsPort, SecretRef, SecretUnresolved, StamperDeps } from "@sow/knowledge";
import type { FactIdentity, MdContentSha } from "@sow/contracts";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import { withParityDefectSignalOnLockedKeychain } from "../../src/boot";

const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SIGNING_KEY = new TextEncoder().encode("test-provenance-signing-key");
const SIGNING_KEY_REF: SecretRef = "keychain:test.kw.provenance-signing-key";

function fakeSecretsPort(key: Uint8Array = SIGNING_KEY): SecretsPort {
  return {
    async resolveSigningKey(ref: SecretRef) {
      return ref === SIGNING_KEY_REF ? ok(key) : err({ code: "secret_unresolved" as const, ref });
    },
  };
}

const SRC_WS: WorkspaceId = workspaceId("ws-19-2");
const VALIDATED = {} as unknown as ValidatedExtraction;
const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-19-2"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:19-2",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-19-2"),
  workspaceId: SRC_WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:19-2",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:19-2#0" } },
};
const sourceExtraction: AgentExtraction = {
  fields: { owner: { value: "Bob", evidenceRef: "source#L12" }, dueDate: { value: TBD } },
  schemaId: "sow:source-ingest-output",
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(SRC_WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: SRC_WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: SRC_WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const sourceRef: SourceRef = { sourceId: sourceId("src-19-2") };

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
  const dir = mkdtempSync(join(tmpdir(), "sow-19-2-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

/** Build minimal params, `signing` optional (the field under test). */
function paramsFor(signing: StamperDeps | undefined, suffix: string): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: SRC_WS },
    meetingJobInputs,
    meetingExtraction,
    revisions: undefined as never, // filled by the caller per-backends
    commit: {
      actor: "worker:test",
      sourceEventRef: `evt:19-2-${suffix}`,
      workflowRunRef: runRef,
      expectedBaseRevision: "" as never, // filled by the caller
    },
    sourceRef,
    planIdentity: { closeout: `meeting:19-2-${suffix}` },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId(`src-ingest-19-2-${suffix}`) },
      planIdentity: { ingest: `source:19-2-${suffix}` },
    },
    ...(signing !== undefined ? { signing } : {}),
  };
}

async function commitOneNote(
  signing: StamperDeps | undefined,
  suffix: string,
): Promise<{ path: string; content: string; backends: Awaited<ReturnType<typeof assembleBackends>> }> {
  const backends = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
    { candidateOutput: {} },
  );
  const revisions = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
  const emptyVaultRevision = (await import("@sow/knowledge")).computeRevisionId(new Map());
  const params: ProofSpineParams = {
    ...paramsFor(signing, suffix),
    revisions,
    commit: {
      actor: "worker:test",
      sourceEventRef: `evt:19-2-${suffix}`,
      workflowRunRef: runRef,
      expectedBaseRevision: emptyVaultRevision,
    },
  };
  const acts = buildProofSpineActivities(backends, params);
  const src: SourceNoteIdentity = {
    sourceId: sourceId(`file:ws-19-2:notes/${suffix}.md`) as SourceId,
    contentHash: `sha256:${suffix}`,
  };
  const built = await acts.sourceBuildOutputs(VALIDATED, SRC_WS, src);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("sourceBuildOutputs failed");
  const plan = built.value.plan;
  const committed = await acts.sourceCommit(plan);
  expect(committed.ok).toBe(true);
  if (!committed.ok) throw new Error("sourceCommit failed");
  const path = plan.creates[0]?.path;
  if (path === undefined) throw new Error("no created note path");
  const content = await backends.vault.read(path);
  if (content === undefined) throw new Error("committed note not found on disk");
  return { path, content, backends };
}

describe("provenance-signing dep — absent ⇒ byte-identical unstamped commit", () => {
  it("absent_signing_produces_a_byte_identical_commit: no signing ⇒ the committed note carries NO kwStamp field", async () => {
    const { content, backends } = await commitOneNote(undefined, "absent");
    try {
      expect(readStampField(content)).toBeNull();
    } finally {
      backends.close();
    }
  });
});

describe("provenance-signing dep — present ⇒ a valid stamp verifies", () => {
  it("a_valid_stamp_verifies_through_verifyProvenanceStamp: signing present ⇒ the committed note carries a stamp that VERIFIES", async () => {
    const signing: StamperDeps = { secrets: fakeSecretsPort(), signingKeyRef: SIGNING_KEY_REF };
    const { path, content, backends } = await commitOneNote(signing, "present");
    try {
      const stamp = readStampField(content);
      expect(stamp).not.toBeNull();
      if (stamp === null) return;
      // Re-derive the SAME content-binding tuple `embedProvenanceStamps` minted against — kwStamp is
      // carved out of the page hash (G1b), so re-deriving from the FINAL committed (stamped) bytes
      // yields the identical pageIdentity/pageSha the mint used. This proves the REAL WIRING produced
      // a stamp that independently re-verifies — not just that `stampProvenance`/`verifyProvenanceStamp`
      // agree in isolation (already covered by provenance-stamp.test.ts).
      const page = computePageProvenance(path, content);
      expect(page).not.toBeNull();
      if (page === null) return;
      const verified = await verifyProvenanceStamp(
        {
          stamp,
          workspaceId: SRC_WS,
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

  it("a_tampered_byte_fails_verification: a byte-tampered copy of the committed note fails to re-verify", async () => {
    const signing: StamperDeps = { secrets: fakeSecretsPort(), signingKeyRef: SIGNING_KEY_REF };
    const { path, content, backends } = await commitOneNote(signing, "tamper");
    try {
      const stamp = readStampField(content);
      expect(stamp).not.toBeNull();
      if (stamp === null) return;
      // Append a non-whitespace marker to the note BODY (never touching kwStamp itself — a
      // copy-onto-fabricated-bytes attack) and re-derive the tuple from the TAMPERED content.
      const tampered = `${content}\nTAMPERED-BY-TEST`;
      expect(tampered).not.toBe(content);
      const tamperedPage = computePageProvenance(path, tampered);
      expect(tamperedPage).not.toBeNull();
      if (tamperedPage === null) return;
      const verifiedTampered = await verifyProvenanceStamp(
        {
          stamp,
          workspaceId: SRC_WS,
          factIdentity: tamperedPage.pageIdentity as FactIdentity,
          originPath: stamp.originPath,
          mdContentSha: tamperedPage.pageSha as MdContentSha,
        },
        signing,
      );
      expect(verifiedTampered.ok).toBe(true);
      if (verifiedTampered.ok) expect(verifiedTampered.value).toBe(false);
    } finally {
      backends.close();
    }
  });
});

describe("keychain_locked_degrades_to_an_unstamped_parity_defect_signal", () => {
  it("a locked Keychain resolution mints a parity_defect HealthItem AND still returns the fail-closed err", async () => {
    const lockedPort: SecretsPort = {
      async resolveSigningKey(ref: SecretRef): Promise<import("@sow/contracts").Result<Uint8Array, SecretUnresolved>> {
        return err({ code: "secret_unresolved", ref, reason: "locked" });
      },
    };
    const puts: HealthItem[] = [];
    const fakeHealthItems: HealthItemStore = {
      async getByDedupeKey() {
        return undefined;
      },
      async put(item) {
        puts.push(item);
      },
      async list() {
        return puts;
      },
    };
    const wrapped = withParityDefectSignalOnLockedKeychain(
      lockedPort,
      fakeHealthItems,
      () => NOW,
      () => "hi-locked-1",
    );
    const result = await wrapped.resolveSigningKey(SIGNING_KEY_REF);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("locked");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.failureClass).toBe("parity_defect");
    expect(puts[0]?.state).toBe("open");
  });

  // NOTE: this fixture's `reason` field is ABSENT (not the literal `"missing"` the real
  // `KeychainUnresolvedReason` adapter emits — apps/worker/src/secrets/keychain-adapter.ts) — it pins
  // the UNSPECIFIED-reason case, a THIRD disposition distinct from both `locked` and the real `missing`
  // case task 19.2 adds coverage for immediately below. Renamed from its former "(missing key)"
  // description, which mis-labeled this fixture — no assertion changed.
  it("an UNSPECIFIED-reason resolution (no reason field at all) does NOT mint the parity_defect signal", async () => {
    const unspecifiedReasonPort: SecretsPort = {
      async resolveSigningKey(ref: SecretRef) {
        return err({ code: "secret_unresolved" as const, ref });
      },
    };
    const puts: HealthItem[] = [];
    const fakeHealthItems: HealthItemStore = {
      async getByDedupeKey() {
        return undefined;
      },
      async put(item) {
        puts.push(item);
      },
      async list() {
        return puts;
      },
    };
    const wrapped = withParityDefectSignalOnLockedKeychain(
      unspecifiedReasonPort,
      fakeHealthItems,
      () => NOW,
      () => "hi-x",
    );
    await wrapped.resolveSigningKey(SIGNING_KEY_REF);
    expect(puts).toHaveLength(0);
  });

  // task 19.2 — the MISSING-key half. `reason: "missing"` is the REAL `KeychainUnresolvedReason` the
  // keychain adapter emits when the signing key was never provisioned (apps/worker/src/secrets/
  // keychain-adapter.ts:38) — a DISTINCT disposition from `locked`, previously minting NOTHING.
  it("a MISSING-key resolution (reason: 'missing') ALSO mints a parity_defect HealthItem AND still returns the fail-closed err", async () => {
    const missingPort: SecretsPort = {
      async resolveSigningKey(ref: SecretRef): Promise<import("@sow/contracts").Result<Uint8Array, SecretUnresolved>> {
        return err({ code: "secret_unresolved", ref, reason: "missing" });
      },
    };
    const puts: HealthItem[] = [];
    const fakeHealthItems: HealthItemStore = {
      async getByDedupeKey() {
        return undefined;
      },
      async put(item) {
        puts.push(item);
      },
      async list() {
        return puts;
      },
    };
    const wrapped = withParityDefectSignalOnLockedKeychain(
      missingPort,
      fakeHealthItems,
      () => NOW,
      () => "hi-missing-1",
    );
    const result = await wrapped.resolveSigningKey(SIGNING_KEY_REF);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("missing");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.failureClass).toBe("parity_defect");
    expect(puts[0]?.state).toBe("open");
    // The message names WHICH condition applies (remediation differs: unlock vs. provision) — never
    // conflates a missing key with a locked one.
    expect(puts[0]?.message).toContain("MISSING");
    expect(puts[0]?.message).not.toContain("LOCKED");
  });

  it("a locked resolution's message names LOCKED, never MISSING (the two dispositions stay distinguishable)", async () => {
    const lockedPort: SecretsPort = {
      async resolveSigningKey(ref: SecretRef): Promise<import("@sow/contracts").Result<Uint8Array, SecretUnresolved>> {
        return err({ code: "secret_unresolved", ref, reason: "locked" });
      },
    };
    const puts: HealthItem[] = [];
    const fakeHealthItems: HealthItemStore = {
      async getByDedupeKey() {
        return undefined;
      },
      async put(item) {
        puts.push(item);
      },
      async list() {
        return puts;
      },
    };
    const wrapped = withParityDefectSignalOnLockedKeychain(
      lockedPort,
      fakeHealthItems,
      () => NOW,
      () => "hi-locked-2",
    );
    await wrapped.resolveSigningKey(SIGNING_KEY_REF);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.message).toContain("LOCKED");
    expect(puts[0]?.message).not.toContain("MISSING");
  });

  it("end-to-end: a commit through a locked signing dep NEVER crashes and STILL commits (unstamped)", async () => {
    const lockedPort: SecretsPort = {
      async resolveSigningKey(ref: SecretRef) {
        return err({ code: "secret_unresolved" as const, ref, reason: "locked" });
      },
    };
    const signing: StamperDeps = { secrets: lockedPort, signingKeyRef: SIGNING_KEY_REF };
    const { content, backends } = await commitOneNote(signing, "locked-commit");
    try {
      // The commit succeeded (commitOneNote already asserts `committed.ok`); the note is unstamped.
      expect(readStampField(content)).toBeNull();
    } finally {
      backends.close();
    }
  });
});
