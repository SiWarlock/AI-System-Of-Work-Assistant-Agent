// spec(§5 REQ-S-002; ⚠ SAFETY rule 5; 9.22) — `zeroEgressOnly` now means its documented contract: derived
// from the option-C two-axis predicate (`isZeroEgressOnlyWorkspace`, packages/policy/src/processors.ts:281),
// never from `!employerRawEgressAcknowledged`. Owner ruling: an EMPTY `providerMatrix` is a CORRECT
// "NOT ESTABLISHED" state, not a missing writer — `false` never means "cloud egress is possible", only
// "not yet proven local-only".
//
// THREE sites had to move together or the field kept a second meaning: boot.ts's live derivation
// (`createSystemHealthQueryPort.egressStatus`), boot.ts's fail-closed default (`failClosedEgress` — whose
// DIRECTION INVERTS under the new meaning, since a fault can never PROVE local-only), and
// egressRevoke.ts's post-revoke return (derived from the just-written state, not asserted).
//
// ⚠ TWO tests below fail on a SINGLE conjunct each (`a_cloud_provider_in_the_matrix_defeats_it` /
// `raw_cloud_egress_flag_alone_defeats_it`) — deliberately, so each dies if its OWN conjunct is removed
// and stays green if a DIFFERENT conjunct is removed (mutation-verified against processors.ts during
// authoring; packages/policy is otherwise untouched by this slice — consume only).
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isOk, validWorkspace } from "@sow/contracts";
import type { Workspace, ProviderMatrix, ProcessorId, AuditRecord } from "@sow/contracts";
import type { WorkspaceConfigRepository, AuditRepository, DbResult, DbError, AuditQuery } from "@sow/db";
import { createSystemHealthQueryPort } from "../../src/boot";
import { createEgressCommandPort } from "../../src/composition/egressRevoke";
import type { ProofSpineBackends } from "../../src/composition/backends";

const NOW = "2026-07-29T00:00:00.000Z";
const nf: DbError = { code: "not_found", message: "nf" } as DbError;

const LOOPBACK_OLLAMA_ROUTE = {
  provider: "ollama",
  model: "x",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

/** A workspace whose routing genuinely pins local: non-vacuous, all-local providers, a loopback route, both allowlists empty. */
const LOCAL_ONLY: Workspace = {
  ...validWorkspace,
  egressPolicy: {
    ...validWorkspace.egressPolicy,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: validWorkspace.id,
    allowedProviders: ["ollama"],
    capabilityDefaults: { "meeting.close": LOOPBACK_OLLAMA_ROUTE } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};

/** Fails the PROVIDER conjunct ALONE — rawCloudEgressEnabled + the routes are both otherwise clean. */
const PROVIDER_AXIS_ONLY_CLOUD: Workspace = {
  ...LOCAL_ONLY,
  providerMatrix: { ...LOCAL_ONLY.providerMatrix, allowedProviders: ["ollama", "claude"] },
};

/** Fails the rawCloudEgressEnabled conjunct ALONE — providers + routes are both otherwise clean. */
const RAW_CLOUD_FLAG_ONLY: Workspace = {
  ...LOCAL_ONLY,
  providerMatrix: { ...LOCAL_ONLY.providerMatrix, rawCloudEgressEnabled: true },
};

/** A workspace with a cloud processor allowlisted — axis 2 fails regardless of the ack flag. */
const CLOUD_ALLOWLISTED: Workspace = {
  ...LOCAL_ONLY,
  egressPolicy: { ...LOCAL_ONLY.egressPolicy, allowedProcessors: ["proc.anthropic" as ProcessorId] },
};

/** A mutable in-memory WorkspaceConfigRepository seeded with one workspace (absent ⇒ not_found). */
function memConfig(
  seed: Workspace | undefined,
  opts: { getFault?: boolean; getThrows?: boolean } = {},
): WorkspaceConfigRepository {
  let stored = seed;
  return {
    get: (id): DbResult<Workspace> => {
      if (opts.getThrows) throw new Error("boom — must be caught, never crosses");
      if (opts.getFault) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } as DbError });
      return stored !== undefined && String(id) === String(stored.id)
        ? Promise.resolve({ ok: true, value: stored })
        : Promise.resolve({ ok: false, error: nf });
    },
    list: (): DbResult<Workspace[]> => Promise.resolve({ ok: true, value: stored ? [stored] : [] }),
    upsert: (w: Workspace): DbResult<Workspace> => {
      stored = w;
      return Promise.resolve({ ok: true, value: w });
    },
    insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
    updateProvisioningFields: (): DbResult<Workspace> => Promise.resolve({ ok: false, error: nf }),
  };
}

function memAudit(): AuditRepository {
  return {
    append: (_rec: AuditRecord): DbResult<void> => Promise.resolve({ ok: true, value: undefined }),
    query: (_f: AuditQuery, _n: number): DbResult<AuditRecord[]> => Promise.resolve({ ok: true, value: [] }),
  };
}

/** Drive the real egressStatus visibility port over a workspaceConfig repo (only touches repos.workspaceConfig). */
function egressStatusOver(workspaceConfig: WorkspaceConfigRepository) {
  return createSystemHealthQueryPort({ repos: { workspaceConfig } } as unknown as ProofSpineBackends);
}

describe("zeroEgressOnly — derived from the option-C predicate, not acknowledgement (9.22)", () => {
  it("zero_egress_only_is_derived_not_acknowledgement_shaped — ack=false + a cloud-allowlisted policy ⇒ false", async () => {
    const res = await egressStatusOver(memConfig(CLOUD_ALLOWLISTED)).egressStatus(String(CLOUD_ALLOWLISTED.id));
    expect(isOk(res)).toBe(true);
    // The old `!acknowledged` derivation would say TRUE here (ack is false) — the headline defect.
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(false);
  });

  it("all_local_nonempty_matrix_with_empty_allowlists_is_true — the positive control (L80)", async () => {
    const res = await egressStatusOver(memConfig(LOCAL_ONLY)).egressStatus(String(LOCAL_ONLY.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(true);
  });

  it("empty_matrix_is_false_not_true — the owner's ruling as behaviour: NOT ESTABLISHED, deliberate", async () => {
    // validWorkspace's OWN providerMatrix (capabilityDefaults: {}) is the vacuous, never-provisioned case.
    const res = await egressStatusOver(memConfig(validWorkspace)).egressStatus(String(validWorkspace.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(false);
  });

  it("a_cloud_provider_in_the_matrix_defeats_it — ALL-not-ANY, failing the PROVIDER conjunct alone", async () => {
    const res = await egressStatusOver(memConfig(PROVIDER_AXIS_ONLY_CLOUD)).egressStatus(String(PROVIDER_AXIS_ONLY_CLOUD.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(false);
  });

  it("raw_cloud_egress_flag_alone_defeats_it — the sibling single-axis isolate (rawCloudEgressEnabled)", async () => {
    const res = await egressStatusOver(memConfig(RAW_CLOUD_FLAG_ONLY)).egressStatus(String(RAW_CLOUD_FLAG_ONLY.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(false);
  });

  it("store_fault_yields_false — failClosedEgress's INVERTED direction: a fault does NOT claim local-only", async () => {
    const res = await egressStatusOver(memConfig(LOCAL_ONLY, { getFault: true })).egressStatus(String(LOCAL_ONLY.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.employerRawEgressAcknowledged).toBe(false);
      expect(res.value.zeroEgressOnly).toBe(false); // was `true` pre-9.22 — the inversion, pinned
    }
  });

  it("store_throw_yields_false — a THROWING get also folds to the fail-closed false", async () => {
    const res = await egressStatusOver(memConfig(LOCAL_ONLY, { getThrows: true })).egressStatus(String(LOCAL_ONLY.id));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.zeroEgressOnly).toBe(false);
  });

  it("post_revoke_status_is_derived_from_state — a revoke on a cloud-allowlisted workspace still reports false", async () => {
    const acked: Workspace = {
      ...CLOUD_ALLOWLISTED,
      egressPolicy: { ...CLOUD_ALLOWLISTED.egressPolicy, employerRawEgressAcknowledged: true, acknowledgedAt: NOW },
    };
    const port = createEgressCommandPort({ workspaceConfig: memConfig(acked), audit: memAudit(), now: () => NOW });
    const r = await port.revokeEgressAck({ workspaceId: String(acked.id) });
    expect(isOk(r)).toBe(true);
    // The L69 replacement: revoke turns ack OFF, but the workspace is STILL cloud-allowlisted, so the
    // honest answer stays false — the old literal `true` here was the tested false assurance.
    if (isOk(r)) expect(r.value.zeroEgressOnly).toBe(false);
  });
});

// ── the structural census: every zeroEgressOnly PRODUCER is the predicate or a fail-closed `false` ──
// Mirrors the workspace-config-writer census (test/composition/provision-preserves-egress-posture.test.ts):
// anchored to `git ls-files` (tracked-only, deterministic across machines/CI), scoped to apps/worker/ only
// (packages/policy is the predicate's own home, out of this census's scope).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function trackedWorkerSources(): string[] {
  let out = "";
  try {
    out = execSync("git ls-files -- 'apps/worker/**/*.ts'", { cwd: repoRoot, encoding: "utf8" });
  } catch {
    out = "";
  }
  return out.split("\n").filter(Boolean).filter((p) => !p.includes(".test.") && !p.includes("/test/"));
}

/** A pass-through forward of an already-derived status (`status.zeroEgressOnly`) — not a NEW producer. */
const IS_FORWARD = /^\w+\.zeroEgressOnly$/;
/**
 * A genuine producer: the predicate call OR the fail-closed literal `false` — and NOTHING ELSE.
 * BOTH-anchored (`^...$`), not prefix-only: `isZeroEgressOnlyWorkspace(x) || true` or
 * `false || dangerousExpr()` would start with a good prefix while evaluating to something else
 * entirely — exactly the L70 trap (a structural pin matching the construction you happened to
 * write, not the invariant). The whole trimmed RHS must be the call or the literal, full stop.
 */
const IS_GOOD_PRODUCER = /^(isZeroEgressOnlyWorkspace\([^()]*\)|false)$/;
/** A TYPE declaration (`zeroEgressOnly: boolean;` on an interface field), not a value construction. */
const IS_TYPE_DECL = /^boolean\b/;

/** Strip `//` and `/* *\/` comments so prose describing the field (this file's own doc comments included) never masquerades as a construction. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `zeroEgressOnly:` construction in tracked apps/worker/ sources that is NEITHER a forward NOR the predicate/false/a type. */
function zeroEgressOnlyProducerViolations(): string[] {
  const out: string[] = [];
  for (const p of trackedWorkerSources()) {
    let raw: string;
    try {
      raw = readFileSync(resolve(repoRoot, p), "utf8");
    } catch {
      out.push(`${p} (unreadable)`);
      continue;
    }
    const src = stripComments(raw);
    const re = /zeroEgressOnly:\s*([^,}\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const rhs = m[1]!.trim();
      if (IS_FORWARD.test(rhs) || IS_GOOD_PRODUCER.test(rhs) || IS_TYPE_DECL.test(rhs)) continue;
      out.push(`${p}: ${rhs}`);
    }
  }
  return out.sort();
}

describe("zeroEgressOnly producer census — the 9.22 tripwire", () => {
  it("no_producer_bypasses_the_predicate — every construction is the predicate or a fail-closed false", () => {
    expect(zeroEgressOnlyProducerViolations()).toEqual([]);
  });
});
