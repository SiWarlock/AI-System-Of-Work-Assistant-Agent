// spec(§6) — GCL projection persistence + serve, both gated by the Visibility
// Gate. GCL DB is the queryable master (persist via the repository INTERFACE, no
// concrete driver); a raw / over-visibility candidate is HARD-rejected and NEVER
// upserted; a tampered stored row is re-gated on serve (defense in depth).
import { describe, it, expect } from "vitest";
import { ok, err, defaultWorkspace, buildSchemaRegistry, GCL_PROJECTION_SCHEMA_ID } from "@sow/contracts";
import type { GclProjection, Workspace } from "@sow/contracts";
import type { DbError, DbResult } from "@sow/db";
import type { ProjectionTypeVisibilityTaxonomy, AuditSignal } from "@sow/policy";
import { buildAuditSignal, isRedactionSafe } from "@sow/policy";
// The CANONICAL string-form redaction predicate (`packages/domain/src/redaction/redact.ts`).
// Aliased: `@sow/policy`'s signal-form above shares the name.
//
// ⛔ CORRECTED (task 24.121) — THE PRIOR COMMENT HERE CLAIMED "Both delegate to the
// SAME `redaction-rules.ts` `looksUnsafe`". FALSE when written: `@sow/policy`'s
// `isRedactionSafe` (imported above from "@sow/policy") wrapped an
// INDEPENDENTLY-MAINTAINED, byte-identical COPY of domain's credential-detection
// nets in `packages/policy/src/audit-signal.ts` — a second hand-maintained home
// for the predicate, not a delegation to this one.
//
// ⭐ STATE AS OF task 24.110 (landed the same session as this correction): policy's
// `looksUnsafe` now runs `domainLooksUnsafe(s) || <policy's own nets, un-stripped>`
// — a UNION, not a delegation. It genuinely CONSULTS this module's `looksUnsafe`
// now (so "adds no second home" is closer to true in the refusal direction than it
// was), but it is still NOT the same function: policy's own local nets remain and
// independently refuse values domain's `looksUnsafe` alone would not (see
// `packages/policy/src/audit-signal.ts`'s own extensive comment on the (C') union
// and its residual marker-keyword divergence). "Delegates to" overclaims a
// same-function identity that does not exist even today.
//
// OWNER OF CLOSING THE REMAINING GAP: task 24.110 (its (B)-wholesale-delegation
// axis is explicitly still BLOCKED, not this correction's to resolve).
//
// ⛔ RE-CHECK TRIGGER, NOT A RE-GREEN: if a future slice makes `@sow/policy`'s
// `isRedactionSafe` a genuine delegation (calling `@sow/domain`'s `looksUnsafe`
// directly with no local nets of its own, i.e. (B) landing), THIS COMMENT — and the
// "one home, not two" framing on the hostile-fixture assertion below — must be
// RE-DERIVED from the real source at that time, never simply restored to its
// pre-24.121 wording because the destination claim happens to have become true.
import { isRedactionSafe as isValueRedactionSafe } from "@sow/domain";
import {
  admitAndPersistProjection,
  serveProjection,
  persistDenialAudit,
  type GclAuditPersistPort,
} from "../src/gcl/projection";

// ── in-memory GclAuditPersistPort fake (task 24.33 — spy, records every call) ──
class FakeAuditPersistPort implements GclAuditPersistPort {
  readonly calls: { signal: AuditSignal; workspaceId: string }[] = [];
  // task 24.53 — records EVERY argument list the refusal notice is invoked with, so a test can
  // assert not just "it fired" but "it carried nothing." `unknown[]` deliberately: typing it as the
  // declared zero-arg shape would make a leak unrepresentable in the TEST while saying nothing about
  // the implementation, which is the thing under test.
  readonly refusals: unknown[][] = [];
  async persistDenial(signal: AuditSignal, workspaceId: string): Promise<void> {
    this.calls.push({ signal, workspaceId });
  }
  onRefused = (...args: unknown[]): void => {
    this.refusals.push(args);
  };
}

// ── in-memory GclProjectionRepository fake (interface-only; no concrete driver) ──
class FakeGclProjectionRepo {
  readonly rows: GclProjection[] = [];
  upsertCalls = 0;
  failNext: DbError | undefined;

  async get(): DbResult<GclProjection> {
    return err({ code: "not_found", message: "n/a" });
  }
  async upsert(projection: GclProjection): DbResult<GclProjection> {
    this.upsertCalls += 1;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      return err(e);
    }
    this.rows.push(projection);
    return ok(projection);
  }
  async listByWorkspace(): DbResult<GclProjection[]> {
    return ok(this.rows);
  }
  async listByVisibility(): DbResult<GclProjection[]> {
    return ok(this.rows);
  }
}

function ws(level: Workspace["defaultVisibility"]): Workspace {
  return defaultWorkspace({
    id: "ws-001",
    name: "Acme",
    type: "personal_business",
    markdownRepoPath: "/vault/acme",
    gbrainBrainId: "brain-acme",
    defaultVisibility: level,
  });
}

const validCandidate: GclProjection = {
  workspaceId: "ws-001" as GclProjection["workspaceId"],
  visibilityLevel: "coordination",
  projectionType: "calendar_busy",
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
};

describe("admitAndPersistProjection", () => {
  it("gates then upserts a clean projection through the repository interface", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo);
    expect(r.ok).toBe(true);
    expect(repo.upsertCalls).toBe(1);
    expect(repo.rows).toEqual([validCandidate]);
  });

  it("HARD-rejects a raw-content-bearing candidate and NEVER calls upsert", async () => {
    const repo = new FakeGclProjectionRepo();
    const rawBearing = { ...validCandidate, sanitizedPayload: { content: "raw text" } };
    const r = await admitAndPersistProjection(rawBearing, ws("full"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("rejected");
      if (r.error.code === "rejected") expect(r.error.reason.code).toBe("raw_content_present");
    }
    expect(repo.upsertCalls).toBe(0);
    expect(repo.rows).toEqual([]);
  });

  it("HARD-rejects an over-visibility candidate and NEVER calls upsert (no downgrade-and-store)", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("isolated"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "rejected") {
      expect(r.error.reason.code).toBe("visibility_exceeds_source");
    }
    expect(repo.upsertCalls).toBe(0);
  });

  // task 24.18 (WS-1/F14): the projectionType-derivation taxonomy threads through
  // to this real entry point too (not only `admitProjection` directly) — an
  // injected taxonomy activates the same way through the persist path.
  it("HARD-rejects (and never upserts) a projectionType/visibilityLevel mismatch when an injected taxonomy is in effect (task 24.18)", async () => {
    const repo = new FakeGclProjectionRepo();
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    const r = await admitAndPersistProjection(validCandidate, ws("full"), repo, undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "rejected") {
      expect(r.error.reason.code).toBe("visibility_type_mismatch");
    }
    expect(repo.upsertCalls).toBe(0);
  });

  it("surfaces a repository write failure as a typed persist error (never throws)", async () => {
    const repo = new FakeGclProjectionRepo();
    repo.failNext = { code: "unavailable", message: "db down" };
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("persist_failed");
      if (r.error.code === "persist_failed") expect(r.error.dbError.code).toBe("unavailable");
    }
  });

  // task 24.33 — MOVE THE STATE (24.7's precedent): drive a real denial through the real
  // admitProjection → admitAndPersistProjection chain, faking only the repository seam (as
  // this suite already does) + the injected auditPersist port, and assert a durable record
  // lands. A construction-side test can't distinguish "built and dropped" from a fix.
  it("gcl_denial_lands_a_durable_audit_record_end_to_end: a real denial through admitAndPersistProjection calls the injected persist port with the signal + workspaceId", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const workspace = ws("isolated");
    const r = await admitAndPersistProjection(validCandidate, workspace, repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(1);
    expect(auditPersist.calls[0]?.workspaceId).toBe(workspace.id);
    expect(auditPersist.calls[0]?.signal.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
  });

  // task 24.33 / contracts L86 — a channel that fires on every path carries no information; the ALLOW
  // path must persist nothing for the deny channel to mean anything.
  it("allow_path_persists_nothing: a clean admission calls the injected persist port zero times", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(true);
    expect(auditPersist.calls).toHaveLength(0);
  });

  it("with no auditPersist port injected, a denial still resolves normally (port is optional, byte-equivalent when absent)", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("isolated"), repo);
    expect(r.ok).toBe(false);
  });

  // task 24.33 (code-quality review) — a schema/raw-content denial has no PolicyDecision behind
  // it (auditOf returns undefined for these two variants), so the injected port must never be
  // called for them either, not just for the ALLOW path.
  it("a raw-content denial (no PolicyDecision, no AuditSignal to persist) calls the injected persist port zero times", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const rawBearing = { ...validCandidate, sanitizedPayload: { content: "raw text" } };
    const r = await admitAndPersistProjection(rawBearing, ws("full"), repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(0);
  });
});

// task 24.33 — the redaction-safety gate lives HERE (packages/knowledge), not inside the
// injected port, because the real port binding is deferred to Phase 25.2/25.4 and the safety
// property must hold regardless of what that future adapter does.
//
// ⛔ RETRACTED 2026-08-13 (task 24.45's knowledge leg; this was home #3 of a false invariant, and
// the LOAD-BEARING one — a coverage claim that justifies NOT writing a test fails silently and
// permanently). This block used to read: "Every real GCL-produced AuditSignal is safe by
// construction (policy-authored refs/codes only), so the refusal case is pinned directly against a
// hand-built unsafe signal … for cases the real chain can't produce." ⛔ THAT IS FALSE, and THIS
// FILE NOW DISPROVES IT: the redaction-gate test below drives an unsafe signal through the REAL
// chain, because `visibility.ts`'s `ref:workspace:` interpolates the raw workspace id whenever the
// candidate matches it.
// ⛔ THE FACT SURVIVES; ITS REASON EXPIRED, AND A TRUE FACT WITH A DEAD REASON IS WORSE THAN A FALSE
// ONE BECAUSE NOBODY RE-CHECKS IT. This clause used to end "…and nothing constrains that id's
// shape." `### 24.84` constrains it: the id is now a bounded lowercase slug.
// ⭐ THE REAL CHAIN STILL PRODUCES AN UNSAFE SIGNAL FOR A DIFFERENT AND BETTER-EVIDENCED REASON —
// `zod-brands.ts` says so itself: *"WHAT THIS IS NOT: a credential detector. Lowercase
// credential-shaped strings ACCEPT (`sk-ant-api03-abc123def456`, …)"*. A slug-valid id can still be
// credential-shaped, so it passes the brand and reaches the gate. ⇒ THE TWO CONTROLS ARE
// COMPLEMENTARY PRECISELY BECAUSE THE BRAND IS A WELL-FORMEDNESS RULE AND NOT A CREDENTIAL DETECTOR;
// the brand's documented limitation is what preserves the redaction gate's reachability.
// ⇒ The hand-built signals below are a UNIT-LEVEL convenience for enumerating gate behaviour, NOT
// evidence that the real chain cannot produce one. Do not read them as a reason to skip a
// real-chain pin for a new GCL audit path.
describe("persistDenialAudit — the fail-closed redaction-safety gate before any persist (task 24.33)", () => {
  const safeSignal = buildAuditSignal({
    actor: "policy",
    event: "gcl.denied",
    refs: ["ref:workspace:ws-001"],
    payloadHash: "sha256:cafe",
    beforeSummary: "not evaluated",
    afterSummary: "denied",
  });

  it("persists a redaction-safe signal", async () => {
    const auditPersist = new FakeAuditPersistPort();
    await persistDenialAudit(safeSignal, "ws-001", auditPersist);
    expect(auditPersist.calls).toHaveLength(1);
  });

  it("redaction_unsafe_signal_is_refused_not_persisted: a credential-shaped signal is refused, never persisted", async () => {
    const leaky = buildAuditSignal({
      actor: "policy",
      event: "gcl.denied",
      refs: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
      payloadHash: "sha256:cafe",
      beforeSummary: "not evaluated",
      afterSummary: "denied",
    });
    const auditPersist = new FakeAuditPersistPort();
    await persistDenialAudit(leaky, "ws-001", auditPersist);
    expect(auditPersist.calls).toHaveLength(0);
  });

  it("a missing signal (allow path) or a missing port is a no-op, never throws", async () => {
    const auditPersist = new FakeAuditPersistPort();
    await expect(persistDenialAudit(undefined, "ws-001", auditPersist)).resolves.toBeUndefined();
    expect(auditPersist.calls).toHaveLength(0);
    await expect(persistDenialAudit(safeSignal, "ws-001", undefined)).resolves.toBeUndefined();
  });

  // task 24.62 — `persistDenialAudit` gated ONE of its TWO data channels: `isRedactionSafe`
  // scanned `audit`, but `workspaceId` rode beside it as a bare second parameter and was NEVER
  // scanned, so a credential-shaped id reached `auditPersist.persistDenial` even when the signal
  // itself was perfectly safe. This is that reachable combination: `safeSignal` alone (unchanged
  // fixture, still passes `isRedactionSafe`) paired with a credential-shaped `workspaceId`.
  it("workspaceId_channel_is_gated_the_same_way_as_the_signal: a credential-shaped workspaceId is refused even when the signal itself is redaction-safe (task 24.62)", async () => {
    const auditPersist = new FakeAuditPersistPort();
    await persistDenialAudit(safeSignal, "https://u:hunter2@evil.example", auditPersist);
    expect(auditPersist.calls).toHaveLength(0);
    expect(auditPersist.refusals).toHaveLength(1);
  });
});

// ── `### 24.84` fixture leg — a NAMED bypass for a credential-shaped workspace id ─────────────
//
// ⛔ THIS IS A DELIBERATE VALIDATOR BYPASS, AND IT IS A NAMED FUNCTION RATHER THAN AN `as` CAST ON
// PURPOSE. `contracts L179` / `### 24.87` measured that `as X` casts are INVISIBLE to compiler enumeration —
// a cast is anonymous, so a later sweep asking "where do we bypass the brand?" structurally cannot
// find it. A NAME is greppable and declares intent at every call site, not only where a comment
// happens to sit.
//
// ⛔ THE POPULATION THIS MODELS — READ THIS BEFORE DELETING THE HELPER AS AN OBSTACLE TO A CLEAN
// BRAND. `### 24.84`'s tightened `WorkspaceIdSchema` is a WRITE-boundary control and it is
// PROSPECTIVE: it makes a malformed id unrepresentable from the moment it ships. It does NOT reach
// a row ALREADY IN A USER'S DB — a workspace written BEFORE the validator existed. That
// pre-validator population is what the WRITE gate cannot reach.
// ⛔ WHAT HAPPENS TO IT POST-`24.84`, MEASURED, NOT ASSUMED — and this replaces an earlier claim of
// mine that the READ gate must still REDACT that population. It does not: the row is refused one
// stage EARLIER, at ajv, as `schema_rejected`. ⭐ `### 24.98` (`124e3f45`) makes that refusal
// RECORDED rather than silent, and the record carries structural paths only, so the credential-shaped
// id never reaches an audit surface at all. ⇒ THE COVERAGE DID NOT EVAPORATE, IT MOVED — from
// "the gate refuses an unsafe signal" to "no unsafe signal is ever constructed."
// ⇒ ⛔ THE CLAIM SPLITS, AND CONFLATING THE TWO HALVES IS WHAT MADE THE OLD SENTENCE WRONG:
//   • the PRE-VALIDATOR POPULATION is carried by `pre_validator_row_is_refused_recorded_and_credential_free`;
//   • the REDACTION-GATE REACHABILITY is carried by
//     `serve_projection_denial_routes_through_the_redaction_gate`, whose fixture MOVED to a
//     slug-valid credential-shaped id for exactly the reason above.
// ⇒ ⭐ THE WRITE GATE AND THE READ GATE ARE GENUINELY DIFFERENT CONTROLS AND MUST NOT BE COLLAPSED —
// the principle survives; only its factual half was wrong.
// ⚠ AND THE CARRIER IS PINNED, NOT CLOSED BY CONSTRUCTION. I assumed it was closed; my own
// measurement falsified that (`### 24.55`'s obligation therefore still has a live control).
// ⛔ ONE CALLER IS SUFFICIENT JUSTIFICATION, AND THE NARROWING IS A FINDING RATHER THAN DECAY. This
// helper once looked like "what keeps the rule-7 test alive across the landing." It is not: the
// redaction-gate test needs NO bypass, because its fixture is now a slug-valid credential-shaped id
// that the brand admits. The helper's sole caller is the PRE-VALIDATOR-ROW test — which is exactly
// what its name and this docblock always claimed it was for. ⚠ THE RISK MOVED THE WRONG WAY: at one
// caller a reader is MORE likely to read this as over-engineered and delete it, and that deletion
// would be GREEN. The narrower reason is the TRUE one.
// ⚠ SUBSTITUTING A VALID SLUG HERE TURNS THE SUITE GREEN WHILE DELETING THE RULE-7 COVERAGE
// (`contracts L82`'s completion badge, on a rule-7 surface). The guard inside the constructor and the
// `the_fixture_stays_hostile_and_its_bypass_resists_substitution` test exist to make that
// substitution RED.
// (B)'s fixture — a PRE-VALIDATOR row: credential-shaped AND not slug-valid, so it is exactly what
// `### 24.84` makes unconstructible and what the named bypass exists to model.
const CREDENTIAL_SHAPED_WS_ID = "https://u:hunter2@evil.example";
// ⭐ (A)'s fixture — SLUG-VALID *and* credential-shaped, taken verbatim from `zod-brands.ts`'s own
// docblock, which states: "WHAT THIS IS NOT: a credential detector. Lowercase credential-shaped
// strings ACCEPT (`sk-ant-api03-abc123def456`, …)". It passes the tightened brand, reaches the
// visibility stage, renders RAW into `ref:workspace:` on the equality branch, and `isRedactionSafe`
// refuses it — measured. ⛔ NO BYPASS NEEDED: the brand admits it, which is the whole point.
const SLUG_VALID_CREDENTIAL_WS_ID = "sk-ant-api03-abc123def456";

function unsafeWorkspaceIdForTest(raw: string): Workspace["id"] {
  // ⛔ AN ALPHABET PRECONDITION — ⚠ AND IT IS *NOT* A HOSTILITY CHECK. Naming it one was the defect
  // security review caught: this predicate answers "would the brand reject this?", NOT "is this
  // credential-shaped?" `"ws.acme"` and `"Ws Acme"` satisfy it and are entirely benign. The value's
  // actual hostility is pinned separately, over the canonical redaction predicate, in
  // `the_fixture_stays_hostile_and_its_bypass_resists_substitution` below.
  // ⛔ DELIBERATELY NOT A MIRROR OF THE BRAND'S REGEX. Re-stating
  // `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` here would copy a safety predicate into a second home (which
  // this codebase forbids — a safety predicate lives once) and would go stale the moment contract
  // tunes the pattern, for no safety benefit. What is asserted instead is the WEAKER, DURABLE
  // property this fixture actually depends on: the value carries at least one character OUTSIDE
  // `[a-z0-9-]`. That is implied by the brand's ALPHABET rather than by its exact shape, so it holds
  // under ANY id rule drawn from that alphabet — and, load-bearing for landing order, it is
  // checkable TODAY, against the CURRENT loose brand, before the tightened one exists.
  if (!/[^a-z0-9-]/u.test(raw)) {
    throw new Error(
      "unsafeWorkspaceIdForTest: refusing a benign value — this constructor exists ONLY to model a " +
        "pre-validator row, and a value drawn entirely from [a-z0-9-] does not need it. Build a " +
        "well-formed id through the schema instead of bypassing it.",
    );
  }
  return raw as Workspace["id"];
}

describe("serveProjection — re-gate a stored row before it crosses a workspace boundary", () => {
  it("serves a clean stored row unchanged", async () => {
    const r = await serveProjection(validCandidate, ws("sanitized"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(validCandidate);
  });

  it("refuses a tampered stored row that now carries raw content", async () => {
    const tampered = { ...validCandidate, sanitizedPayload: { body: "leaked raw" } } as GclProjection;
    const r = await serveProjection(tampered, ws("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("raw_content_present");
  });

  it("refuses a stored row whose visibility now exceeds the source default", async () => {
    const r = await serveProjection(validCandidate, ws("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("visibility_exceeds_source");
  });

  // task 24.18 (WS-1/F14), corrected 2026-08-12 (24.33's own finding, session 155): worker's
  // `crossWorkspaceRead.ts`'s `resolveApprovedCrossWorkspaceSlice` calls `serveProjection` — a
  // real call site (`crossWorkspaceRead.ts:139`), accurate at the source level — but that
  // function itself has ZERO production callers today; every real caller is in a test file.
  // The projectionType derivation must still be reachable HERE, not only through
  // `admitProjection` in isolation, so it is already correct the moment that chain is wired
  // (Phase 25.2/25.4) — not because it runs today.
  it("refuses a re-served stored row whose visibility level is inconsistent with its projectionType under an injected taxonomy (task 24.18)", async () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    const r = await serveProjection(validCandidate, ws("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("visibility_type_mismatch");
  });

  // task 24.44 (leg 2 of 24.33's pair; the argument is from 24.33's own Step 2.5): serveProjection's
  // re-gate denial is the defense-in-depth catch of a post-write tamper — arguably the MORE
  // safety-critical audit case, since admitAndPersistProjection catches a bad projection on the
  // way IN, this catches one already stored. The suite below covers, on this path: carries the
  // signal · end-to-end durable record · a raw-content denial (this function's OWN characteristic
  // denial, no PolicyDecision behind it) persists nothing either · allow persists nothing ·
  // byte-equivalent when the port is absent · workspaceId provenance (never row-derived) ·
  // routes through the fail-closed gate rather than bypassing it (code-quality + security review).
  it("serve_projection_denial_carries_the_signal: a re-gate denial's AuditSignal survives on the returned error, same as admitProjection's own output shape", async () => {
    const r = await serveProjection(validCandidate, ws("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok && "audit" in r.error) {
      expect(r.error.audit).toBeDefined();
      expect(r.error.audit?.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
    } else {
      expect.fail("expected a policy-decision deny variant carrying an audit field");
    }
  });

  // MOVE THE STATE (24.17's precedent, reused for 24.33's own end-to-end pin): a
  // construction-side assertion can't distinguish "the signal is built and dropped" from a fix
  // — drive a real denial through the real serveProjection call with an injected persist port
  // and assert the durable record lands.
  it("serve_projection_denial_is_durably_recorded_end_to_end: a real re-gate denial calls the injected persist port with the signal + workspaceId", async () => {
    const auditPersist = new FakeAuditPersistPort();
    const workspace = ws("isolated");
    const r = await serveProjection(validCandidate, workspace, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(1);
    expect(auditPersist.calls[0]?.workspaceId).toBe(workspace.id);
    expect(auditPersist.calls[0]?.signal.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
  });

  // code-quality review (24.44): 24.33's ACTUAL fourth pin was "a raw-content denial (no
  // PolicyDecision, no AuditSignal — auditOf returns undefined) calls the port zero times," not
  // "carries the signal" (which is really a restatement of the first pin). serveProjection's
  // characteristic denial IS a tampered raw-content row ("refuses a tampered stored row..."
  // above) — this pin was missing on the path it matters most for.
  it("serve_projection_raw_content_denial_persists_nothing: a raw-content denial (no PolicyDecision behind it) calls the injected persist port zero times", async () => {
    const auditPersist = new FakeAuditPersistPort();
    const tampered = { ...validCandidate, sanitizedPayload: { body: "leaked raw" } } as GclProjection;
    const r = await serveProjection(tampered, ws("full"), undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("raw_content_present");
    expect(auditPersist.calls).toHaveLength(0);
  });

  // task 24.33 / contracts L86 — allow persists nothing (positive control: the tests above
  // already prove the channel fires on a real denial, so this proves it does NOT fire when
  // nothing was denied — a channel that fires on every path carries no information).
  it("serve_projection_allow_persists_nothing: a clean re-serve calls the injected persist port zero times", async () => {
    const auditPersist = new FakeAuditPersistPort();
    const r = await serveProjection(validCandidate, ws("sanitized"), undefined, undefined, auditPersist);
    expect(r.ok).toBe(true);
    expect(auditPersist.calls).toHaveLength(0);
  });

  // security review (24.44) — a REAL comparison, not two independent assertions that happen to
  // agree: the port's mere presence must not change the returned Result at all (byte-equivalent),
  // proven by comparing the SAME denial served with and without an injected port.
  it("serve_projection_without_audit_port_is_byte_equivalent: injecting a port does not change the returned Result shape for the same denial", async () => {
    const withoutPort = await serveProjection(validCandidate, ws("isolated"));
    const withPort = await serveProjection(validCandidate, ws("isolated"), undefined, undefined, new FakeAuditPersistPort());
    expect(withoutPort.ok).toBe(false);
    expect(withPort).toEqual(withoutPort);
  });

  // security review (24.44) — MUTATION-PROVEN gap: swapping sourceWorkspace.id for the row's own
  // (attacker-controllable) workspaceId left every other test in this block green, because on
  // every OTHER denial path validateProjectionVisibility has already proven wsId===sourceWorkspace.id
  // before denying (packages/policy/src/visibility.ts:162) — the two values are equal by
  // construction there, so no other test can tell them apart. This is the ONE fixture that can:
  // a MISMATCHING but REDACTION-SAFE workspaceId reaches the persist call (unlike the routing-gate
  // test below, whose mismatch is also unsafe and never gets far enough to record who's used).
  it("serve_projection_denial_persists_under_sourceWorkspace_id_never_the_stored_rows_own_value: a mismatched-but-safe row workspaceId does not leak into the persisted record", async () => {
    const auditPersist = new FakeAuditPersistPort();
    const workspace = ws("full");
    const foreignSafe = { ...validCandidate, workspaceId: "ws-002" as GclProjection["workspaceId"] };
    const r = await serveProjection(foreignSafe, workspace, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(1);
    expect(auditPersist.calls[0]?.workspaceId).toBe(workspace.id);
    expect(auditPersist.calls[0]?.workspaceId).not.toBe("ws-002");
  });

  // task 24.44 (orchestrator ADD) — a ROUTING pin, not a re-test of persistDenialAudit's own
  // refusal logic (that's covered once, in 24.33's suite — L39). It asserts "the deny path goes
  // through the gate," not "the gate works": a correctly-routed serveProjection (calls
  // persistDenialAudit) persists this signal ZERO times; an implementation that bypassed the
  // gate straight to auditPersist.persistDenial would persist it ONCE (mutation-verified by hand:
  // temporarily bypassing the gate turned this test red with exactly this count delta, before
  // reverting). Constructed through the REAL path (24.45's own finding, not stubbed):
  // A credential-shaped string reaching `ref:workspace:` trips isRedactionSafe's
  // URL_USERINFO_CREDENTIAL rule specifically (code-quality review: the password below is
  // deliberately NOT also a SENSITIVE_KEYWORD match, so this pins the URL-userinfo rule and not an
  // unrelated one — swap it if that rule changes). ⚠ Post-24.45 the value survives because the
  // REFERENTIAL PIN PASSES, not because `refs` is built before the guards — that ordering no longer
  // decides it, since a foreign id now renders `UNVALIDATED` whenever it is built.
  //
  // ⭐ FIXTURE MIGRATED (task 24.45 pair, knowledge leg): the predecessor sourced the unsafe value
  // from the candidate's own FOREIGN workspaceId, which 24.45 renders `UNVALIDATED` ⇒ the fixture
  // was wrong, not the test (its own :350 coupling note called this, and the lead upheld it).
  // ⛔ THE ENUMERATION THAT PICKED THIS REPLACEMENT, recorded so it is falsifiable rather than
  // re-derived by the next person:
  //   • The sibling gates CANNOT carry an unsafe signal: `auditOf` (visibility-gate.ts:78) returns
  //     `undefined` for BOTH `schema_rejected` AND `raw_content_present`, so ajv/Zod denials reach
  //     persistDenialAudit with no AuditSignal at all. Sourcing from "a different gate" is not
  //     available — it is structurally impossible, not merely unused.
  //   • Within the visibility gate, `refs` has exactly TWO entries and `ref:visibility:` was already
  //     closed-set (`level` or "UNRECOGNIZED"). Every other scanned field is a fixed literal:
  //     payloadHash is VISIBILITY_PAYLOAD_MARKER, beforeSummary is constant, and every afterSummary
  //     is a hardcoded string. denialCode/healthSignalClass are closed codes and are never scanned.
  //   • ⇒ ONE raw interpolation survives 24.45: `ref:workspace:` still renders the RAW id on the
  //     `wsId === sourceWorkspace.id` branch. So the workspace NAMES ITSELF with a credential-shaped
  //     id and the candidate matches it; the referential pin passes and denial comes from the
  //     visibility ceiling instead.
  // ⇒ GREEN UNDER BOTH producer behaviours: on THESE inputs the pre- and post-24.45 forms of that
  // expression evaluate to the same string — and this is the exceeds-source path, one of the three
  // 24.45's own comment names as "byte-identical to before." Verified by running the suite against
  // both producer states, not by reading.
  // ⭐ THE FIXTURE'S BASE IS A SCHEMA-VALID WORKSPACE, which is load-bearing: `schemaValidBase` is built through
  // `defaultWorkspace`, which itself calls `WorkspaceSchema.parse` and propagates `id` into BOTH
  // `egressPolicy.workspaceId` and `providerMatrix.workspaceId` — so it cannot return a
  // referentially-inconsistent aggregate, and a construction that violated the schema would THROW
  // here. ⚠ RETARGETED (`### 24.84` fixture leg): the aggregate handed to `serveProjection` is
  // `schemaValidBase` with EXACTLY the three id fields rewired through the named bypass, so it is
  // deliberately out-of-shape in one property and parse-validated in every other. The claim above is
  // about the BASE; it is no longer true of `workspace` itself, and saying so is the point.
  // ⛔ An earlier draft hand-built the workspace with `as`-casts and a bogus `defaultVisibility`;
  // that state is one `WorkspaceSchema` forbids, and a reader checking whether the state this test's
  // conclusions rest on is representable would have found it is not — reopening the very deletion
  // the note at `src/gcl/projection.ts` exists to prevent (security review).
  // ⚠ REPRESENTABLE, and only that. The LOOSE brand admitted a credential-shaped id directly
  // (`.min(1)` + a non-blank refine); `### 24.84`'s tightened brand does not — which is precisely why
  // the named bypass above exists. Cited by SYMBOL — `zod-brands.ts`'s `WorkspaceIdSchema` — not by
  // line, because those line numbers differ between HEAD and the working tree while `24.84` is in
  // flight. No enumeration of workspace-id PRODUCERS was run, so this does not claim such an id is
  // reachable in production.
  // ⛔ NAME MOVED WITH THE FIXTURE (`L188`/`L191`). It read "…(URL-userinfo-credential-shaped workspace
  // ref)…", which describes a fixture this test no longer uses. A test's NAME is one of the artifacts
  // that carries a premise, and it is the one a Step-2.5 reviewer actually evaluates — leaving it
  // would have been a fresh instance of the defect this round banked.
  it("serve_projection_denial_routes_through_the_redaction_gate: a re-gate denial whose AuditSignal is unsafe (SLUG-VALID but credential-shaped workspace ref, admitted by the brand) persists zero times via the real chain, not via persistDenialAudit's own isolated unit test", async () => {
    const auditPersist = new FakeAuditPersistPort();
    // The workspace names itself with the credential-shaped id and the candidate matches it, so the
    // referential pin PASSES and the raw id is interpolated into refs. Denial then comes from the
    // ceiling: the candidate's "coordination" exceeds this workspace's "isolated" default.
    // ⭐ NO BYPASS HERE, DELIBERATELY, AND THE ABSENCE IS THE FINDING: this id is SLUG-VALID, so the
    // tightened brand ADMITS it and `defaultWorkspace` builds it directly. The reachability of the
    // redaction gate does not depend on constructing an out-of-shape id at all — it depends on the
    // brand being a well-formedness rule rather than a credential detector, which `zod-brands.ts`
    // states about itself. ⇒ STATE-INDEPENDENT BY CONSTRUCTION: identical behaviour under the loose
    // and tightened brands, so this pin does not flip when contract lands.
    const workspace = defaultWorkspace({
      id: SLUG_VALID_CREDENTIAL_WS_ID,
      name: "Acme",
      type: "personal_business",
      markdownRepoPath: "/vault/acme",
      gbrainBrainId: "brain-acme",
      defaultVisibility: "isolated",
    });
    const candidate = {
      ...validCandidate,
      workspaceId: SLUG_VALID_CREDENTIAL_WS_ID as GclProjection["workspaceId"],
    };
    const r = await serveProjection(candidate, workspace, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "visibility_exceeds_source") {
      expect(r.error.audit).toBeDefined();
      // ⭐ DIAGNOSTIC-CLARITY GUARD — deliberately NOT a non-vacuity guard, and the distinction was a
      // code-quality finding against this very comment's first draft. The premise dying already reds
      // this test WITHOUT this line: a sanitized signal is redaction-SAFE, so it gets persisted and
      // the `toHaveLength(0)` below fails — which is EXACTLY how 24.45 broke the predecessor. What
      // this line buys is the CAUSE at the line that owns it ("the signal stopped being unsafe")
      // instead of an opaque count delta twelve lines down.
      expect(isRedactionSafe(r.error.audit as AuditSignal)).toBe(false);
    } else {
      expect.fail("expected visibility_exceeds_source carrying an audit field");
    }
    expect(auditPersist.calls).toHaveLength(0);
    // task 24.53's REAL-CHAIN pin, deliberately here rather than only in 24.53's own unit suite:
    // this file's retraction at the top of the persistDenialAudit block forbids treating hand-built
    // signals as a reason to skip a real-chain pin, and a new suite of only hand-built ones would
    // have done exactly that. The refusal notice fires on the path a real denial actually takes.
    expect(auditPersist.refusals).toHaveLength(1);
  });

  // ⛔⛔ (B) — THE PRE-VALIDATOR POPULATION, WHICH THE TEST ABOVE NO LONGER CARRIES. Splitting these
  // is the correction: one sentence used to claim the redaction-gate test covered both, and after the
  // fixture moved it covered neither half of that claim honestly.
  // ⭐ STATE-INDEPENDENT BY CONSTRUCTION, the `### 24.98` discipline: the ajv schema is supplied as an
  // INPUT (a tightened stand-in carrying `24.84`'s pattern), so this pin asserts the POST-landing end
  // state deterministically — at HEAD, where the real schema has no pattern, and after contract lands,
  // where it does. ⚠ Without that, this test would assert one thing today and another tomorrow, which
  // is the red window the whole landing-order arc exists to avoid.
  //
  // ⛔⛔ REWRITTEN BY `### 24.62`, NOT STRUCK — the fixture is UNCHANGED (still the pre-validator row:
  // `legacyId` = `CREDENTIAL_SHAPED_WS_ID`, a credential-shaped id that predates the write-boundary
  // validator) but this fixture ALSO happens to be `sourceWorkspace.id`, i.e. exactly the second data
  // channel `24.62` found ungated: `serveProjection(candidate, workspace, …)` passes `workspace.id`
  // (= `legacyId`) straight through to `persistDenialAudit`'s `workspaceId` parameter. Before the fix,
  // assertions 2+3 below asserted that credential-shaped id reached `auditPersist.persistDenial` and
  // was durably written — the record it landed happened to be credential-FREE at the signal-field
  // level (that half of the finding, not this one), but the raw id itself still went out the door as
  // the second, unscanned argument. `24.62` closes that: `workspaceId` is now scanned the same way the
  // signal is, so this exact combination is now REFUSED, not persisted-with-a-clean-signal.
  it("pre_validator_row_is_refused_and_never_reaches_a_durable_record_at_all (24.62: the workspaceId channel is now gated too)", async () => {
    const auditPersist = new FakeAuditPersistPort();
    const tightenedAjv = buildSchemaRegistry([
      {
        $id: GCL_PROJECTION_SCHEMA_ID,
        type: "object",
        properties: {
          workspaceId: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", maxLength: 64 },
        },
      },
    ]);
    // ⛔ THE BYPASS'S SOLE REMAINING CALLER, and its docblock's population verbatim: a row written
    // BEFORE the validator existed. The three id fields are rewired together — `defaultWorkspace`
    // propagates `id` into `egressPolicy` and `providerMatrix`, and rewiring only `id` would break
    // the referential pin while the test kept passing.
    const base = defaultWorkspace({
      id: "ws-acme",
      name: "Acme",
      type: "personal_business",
      markdownRepoPath: "/vault/acme",
      gbrainBrainId: "brain-acme",
      defaultVisibility: "isolated",
    });
    const legacyId = unsafeWorkspaceIdForTest(CREDENTIAL_SHAPED_WS_ID);
    const workspace: Workspace = {
      ...base,
      id: legacyId,
      egressPolicy: { ...base.egressPolicy, workspaceId: legacyId },
      providerMatrix: { ...base.providerMatrix, workspaceId: legacyId },
    };
    const candidate = { ...validCandidate, workspaceId: legacyId };
    const r = await serveProjection(candidate, workspace, tightenedAjv, undefined, auditPersist);

    // 1 — STILL REFUSED, and asserted by CODE not by bare falsity (`### 24.101`). The row does not
    //     become readable; `### 24.84` shipping as built is the owner-ruled end state.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("schema_rejected");

    // 2 — ⛔ REVERSED BY `### 24.62`, AND THAT REVERSAL IS THE FIX, NOT A REGRESSION. `### 24.98`
    //     (`124e3f45`) made the SIGNAL side observable (a `schema_rejected` refusal is no longer a
    //     silent no-op). `24.62` adds the second gate: `workspaceId` here IS `legacyId` — the same
    //     credential-shaped value the fixture models — so it now fails `auditFieldContainsSecret` and
    //     the WHOLE call is refused before anything is persisted, exactly like an unsafe signal
    //     always was. The refusal notice fires (task 24.53's observability channel) instead of a
    //     durable write landing.
    expect(auditPersist.calls).toHaveLength(0);
    expect(auditPersist.refusals).toHaveLength(1);

    // 3 — ⛔ "CREDENTIAL-FREE" IS NOW TRIVIALLY AND MORE STRONGLY TRUE: there is no persisted record
    //     for a credential to hide in at all. Before `24.62` this test asserted the persisted
    //     record's SIGNAL fields were clean while the raw id still rode along unscanned as the
    //     second argument — a true but incomplete property (`contracts L82`'s shape: a narrower true
    //     claim standing in for a broader one nobody re-checked). `onRefused` is zero-arg BY DESIGN
    //     (task 24.53's `GclAuditPersistPort.onRefused` contract), so there is no captured value left
    //     to inspect here — the absence of a persisted call IS the assertion.
  });

  // ⛔⛔ THE PIN THAT MAKES THE DANGEROUS FIX RED. When `### 24.84`'s tightened `WorkspaceIdSchema`
  // lands, the obvious repair for a red here is to swap the fixture for a well-formed slug: the file
  // keeps its name, the test above keeps passing, and it SILENTLY STOPS TESTING that a
  // credential-shaped workspace id is redacted on the read path. That is `contracts L82`'s completion
  // badge on a rule-7 surface, and it is the path of least resistance.
  // ⚠ A TEST THAT MERELY PASSES IS EXACTLY WHAT THE DANGEROUS FIX ALSO PRODUCES.
  // ⛔ SCOPE OF THIS TEST, CORRECTED — the earlier wording here claimed it was "the only assertion in
  // the file that can tell the two apart," which is FALSE and was actively dangerous (security
  // review): the comment ~20 lines above already records that the premise dying reds the redaction
  // test WITHOUT that line. Two discriminators exist and they cover DIFFERENT classes:
  //   • THIS test reds the VALID-SLUG substitution at its own line (the constructor throws, and
  //     assertions 1 + 4 fail) — a named, local, immediate failure.
  //   • `isRedactionSafe(r.error.audit)` in the redaction test above is the co-discriminator for the
  //     BENIGN-BUT-OUT-OF-ALPHABET class (`"ws.acme"`), where a sanitized signal becomes
  //     redaction-SAFE, gets persisted, and reds the `toHaveLength(0)` below it.
  // ⚠ THAT LINE IS NOT DELETABLE AS A MERE DIAGNOSTIC CONVENIENCE, whatever its own comment says
  // about not being a non-vacuity guard — it is the only cover for a class this test does not reach.
  it("the_fixture_stays_hostile_and_its_bypass_resists_substitution", () => {
    // 1 — the fixture value itself is out-of-alphabet, so it is rejected by ANY id rule drawn from
    //     `[a-z0-9-]`. Stated over the alphabet, not over contract's exact regex, so this does not
    //     go stale when the pattern is tuned and does not copy a safety predicate into a second home.
    expect(CREDENTIAL_SHAPED_WS_ID).toMatch(/[^a-z0-9-]/u);
    // 2 — the bypass REFUSES benign values, so it cannot be quietly repurposed as a general-purpose
    //     id constructor. A bypass that also accepts well-formed ids gets reached for out of
    //     convenience and its name stops meaning anything.
    expect(() => unsafeWorkspaceIdForTest("ws-acme")).toThrow(/refusing a benign value/u);
    // 3 — the bypass is value-preserving: it brands, it does not normalise. If it ever sanitised the
    //     id, the test above would be asserting redaction of a value the production path never sees.
    expect(unsafeWorkspaceIdForTest(CREDENTIAL_SHAPED_WS_ID)).toBe(CREDENTIAL_SHAPED_WS_ID);
    // 4 — ⛔ THE HOSTILITY ASSERTION, AND IT IS THE ONE ASSERTIONS 1-3 DO NOT MAKE. 1 pins an
    //     ALPHABET precondition; 2 and 3 pin the CONSTRUCTOR's contract. None of them reads the
    //     value's SHAPE, so `"ws.acme"` / `"Ws-Acme"` / `"ws acme"` satisfy all three while being
    //     entirely benign — this test was NAMED for hostility and did not test it (security review;
    //     `contracts L82` in miniature, inside the test written to prevent exactly that).
    //     ⭐ Asserted over the CANONICAL predicate, `@sow/domain`'s own string-form
    //     `isRedactionSafe`, which IS its `redaction-rules.ts` `looksUnsafe` (no copy — this
    //     is the producer). ⛔ CORRECTED (task 24.121): the prior wording here claimed
    //     `@sow/policy`'s signal-form "delegates to" the SAME function, i.e. "one home, not
    //     two" — FALSE when written (policy carried an independently-maintained copy) and
    //     STILL NOT TRUE today even after task 24.110 landed the same session: policy's
    //     `looksUnsafe` now ORs domain's verdict with its own un-stripped local nets — it
    //     CONSULTS this predicate, it does not delegate to it. See the corrected comment on
    //     the `isRedactionSafe as isValueRedactionSafe` import above for the full state +
    //     the re-check trigger (24.110 owns closing the gap; if it ever lands a genuine
    //     delegation, THIS line's claim must be re-derived, not re-greened).
    expect(isValueRedactionSafe(CREDENTIAL_SHAPED_WS_ID)).toBe(false);
    // 5 — ⛔ (A)'s FIXTURE CARRIES THE WHOLE FINDING AND MUST BE PINNED THE SAME WAY. Its premise is
    //     a CONJUNCTION — slug-valid AND credential-shaped — and each half is load-bearing for a
    //     different reason: slug-valid is why the tightened brand ADMITS it (so no bypass is needed
    //     and the pin is state-independent); credential-shaped is why the redaction gate REFUSES it
    //     (so `### 24.55`'s protection obligation keeps a live control). Neither half alone reaches
    //     the gate, and the conjunction is exactly what `zod-brands.ts` documents about itself.
    //     ⭐ IF CONTRACT EVER MAKES THE BRAND REJECT CREDENTIAL SHAPES TOO, THIS LINE REDS AND SAYS
    //     SO — the honest signal, because at that moment the redaction gate loses its last reachable
    //     carrier and `### 24.55` needs RE-DECIDING rather than re-greening.
    expect(SLUG_VALID_CREDENTIAL_WS_ID).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u);
    expect(SLUG_VALID_CREDENTIAL_WS_ID.length).toBeLessThanOrEqual(64);
    expect(isValueRedactionSafe(SLUG_VALID_CREDENTIAL_WS_ID)).toBe(false);
  });
});

// task 24.53 — a signal REFUSED by the redaction gate was dropped with zero observability: a refused
// audit and one that was never produced are byte-identical to every observer. The fix is an OPTIONAL
// injected notice, not a console write (`packages/knowledge/src` has zero `console.` calls, and this
// is library code — logic-in-package, wire-at-boot; `boot.ts` is a composition root and sits on the
// other side of that line).
//
// ⛔ THE NOTICE CARRIES NOTHING, AND THAT IS THE WHOLE DESIGN. Brief 275 prescribed mirroring
// `boot.ts:588-591`'s "event name only" refusal log. That is unsafe here and the orchestrator ruled
// it out on this reasoning: `@sow/policy`'s `isRedactionSafe` scans SIX fields — `actor`,
// `event`, `payloadHash`, `beforeSummary`, `afterSummary`, `...refs` (cited by SYMBOL, not line: that
// block's line numbers differ between HEAD and the working tree while 24.45 is held). On the refusal path at least one
// of them is unsafe BY DEFINITION and this function cannot know which. `event` is one of the six ⇒
// logging it can emit precisely the value the gate refused. "Event name only" reads safe because an
// event name is USUALLY a literal; the gate scans it because that is not guaranteed.
describe("persistDenialAudit — a refused signal is observable, and the notice carries nothing (task 24.53)", () => {
  const CREDENTIAL_SHAPED = "https://u:hunter2@evil.example";

  /** Unsafe via `event` SPECIFICALLY — the field the naive "event name only" log would have emitted. */
  const unsafeByEvent = buildAuditSignal({
    actor: "policy",
    event: CREDENTIAL_SHAPED,
    refs: ["ref:workspace:ws-001"],
    payloadHash: "policy:visibility-decision",
    beforeSummary: "projection visibility not validated",
    afterSummary: "projection level exceeds workspace default",
    denialCode: "VISIBILITY_EXCEEDS_SOURCE",
  });

  it("fixture_is_unsafe_via_event_specifically: the gate refuses it, and refuses it BECAUSE of `event`", () => {
    // Non-vacuity for the whole describe: if this ever went safe, every test below would pass by
    // refusing nothing.
    expect(isRedactionSafe(unsafeByEvent)).toBe(false);
    // ⛔ THE CAUSAL PIN. The two assertions above prove "refused" and "event holds the string" — NOT
    // that `event` is WHY. Without this line, making some other field unsafe later keeps both green
    // while silently destroying the property this whole suite is built on: that it discriminates
    // against an event-name-only notice. Neutralise `event` and the same signal must go SAFE.
    expect(isRedactionSafe({ ...unsafeByEvent, event: "gcl.projection.denied" })).toBe(true);
  });

  it("refused_signal_is_observable: the notice fires exactly once and nothing is persisted", async () => {
    const port = new FakeAuditPersistPort();
    await persistDenialAudit(unsafeByEvent, "ws-001", port);
    expect(port.calls).toHaveLength(0); // the refusal still holds — this slice does not weaken the gate
    expect(port.refusals).toHaveLength(1); // ⬅ the defect: this was 0 before 24.53
  });

  it("refusal_notice_carries_no_scanned_field_value: THE rule-7 pin — the naive implementation fails this", async () => {
    // ⛔ This is the test that would RED against brief 275's prescribed "event name only" log, because
    // this fixture's unsafe field IS the event. Asserting zero arguments is stronger than scanning for
    // the value: it forbids the whole class, not this one string.
    const port = new FakeAuditPersistPort();
    await persistDenialAudit(unsafeByEvent, "ws-001", port);
    expect(port.refusals[0]).toEqual([]);
    // Kept as a deliberate 24.62 marker only — 24.62 is the sibling defect where `workspaceId` rides
    // beside the signal unscanned. The value-scan assertions for the signal itself are omitted: they
    // are strictly implied by `toEqual([])` and can never fail while it passes.
    expect(JSON.stringify(port.refusals)).not.toContain("ws-001");
  });

  it("safe_signal_does_not_notify: a channel that fires on every path carries no information (contracts L86)", async () => {
    const port = new FakeAuditPersistPort();
    const safe = buildAuditSignal({
      actor: "policy",
      event: "visibility.projection.denied",
      refs: ["ref:workspace:ws-001"],
      payloadHash: "policy:visibility-decision",
      beforeSummary: "projection visibility not validated",
      afterSummary: "projection level exceeds workspace default",
      denialCode: "VISIBILITY_EXCEEDS_SOURCE",
    });
    await persistDenialAudit(safe, "ws-001", port);
    expect(port.calls).toHaveLength(1);
    expect(port.refusals).toHaveLength(0);
  });

  it("no signal and no port stay silent no-ops, and a port without the optional notice never throws", async () => {
    const port = new FakeAuditPersistPort();
    await persistDenialAudit(undefined, "ws-001", port);
    expect(port.refusals).toHaveLength(0);
    await expect(persistDenialAudit(unsafeByEvent, "ws-001", undefined)).resolves.toBeUndefined();
    // A port predating 24.53 (no `onRefused`) must still refuse silently rather than crash — the
    // member is optional, so every existing call site stays byte-identical (§16 never-throws).
    const legacy: GclAuditPersistPort = { persistDenial: async () => undefined };
    await expect(persistDenialAudit(unsafeByEvent, "ws-001", legacy)).resolves.toBeUndefined();
  });

  it("a THROWING onRefused never breaks persistDenialAudit's never-throw contract (§16)", async () => {
    // The notice is caller-supplied and fires ONLY on the refusal path, so an unguarded throw would
    // turn "a signal was unsafe" into "the write path threw" — content-conditioned, and worse than
    // the silence 24.53 removes.
    const hostile: GclAuditPersistPort = {
      persistDenial: async () => undefined,
      onRefused: () => {
        throw new Error("hostile port");
      },
    };
    await expect(persistDenialAudit(unsafeByEvent, "ws-001", hostile)).resolves.toBeUndefined();
  });

  it("an ASYNC onRefused that REJECTS never escapes as an unhandled rejection", async () => {
    // ⛔ The second escape route, and the one the signature CANNOT close: `() => void` accepts an
    // async implementation (TypeScript's void-return assignability rule), so the most natural sink —
    // `onRefused: async () => { await metrics.increment(...) }` — typechecks. Its rejection would
    // bypass a plain try/catch; Node 22 defaults to --unhandled-rejections=throw and this repo
    // registers no handler, so the process would DIE, and only ever when a signal was unsafe.
    const hostile: GclAuditPersistPort = {
      persistDenial: async () => undefined,
      onRefused: (async () => {
        throw new Error("async sink down");
      }) as unknown as () => void,
    };
    const escaped: unknown[] = [];
    const capture = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", capture);
    try {
      await expect(persistDenialAudit(unsafeByEvent, "ws-001", hostile)).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve)); // let any rejection surface
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });
});
