// `WorkspaceIdSchema` own-shape tests (task `### 24.84`, contracts leg — §5/§16).
//
// THE CLASS FIX: `WorkspaceIdSchema` stops being the shape-free generic
// `brandedIdSchema<WorkspaceId>()` and gains its OWN bounded positive shape, so a
// malformed workspace id is UNREPRESENTABLE rather than DETECTED — at one site,
// inherited by every model that validates through the brand, including models not
// yet written.
//
// ⛔ WHAT THIS SHAPE IS NOT — asserted below, not merely commented (`L82`):
// it is a WELL-FORMEDNESS check, NOT a credential detector. Lowercase
// credential-shaped strings ACCEPT, and `accepts lowercase credential shapes`
// pins exactly that so the limitation is a STATED one rather than a gap a later
// reader assumes is covered. "Is this a credential?" is a structurally
// unwinnable denylist (`worker L73`); the question asked here is "is this a
// well-formed workspace id?".
//
// ⛔ THE LENGTH BOUND IS BOUNDED-INPUT HYGIENE, NOT CREDENTIAL DEFENSE. It bounds
// an unbounded string at a durable sink that reaches logs, audit rows and the
// renderer. Measured: every credential shape below accepts under BOTH max(64)
// and max(40), so no plausible bound buys credential rejection.
import { describe, expect, it } from "vitest";
import * as brands from "../../src/primitives/zod-brands";
import { WorkspaceIdSchema } from "../../src/primitives/zod-brands";
import type { WorkspaceId } from "../../src/primitives/ids";
import { AuditRecordSchema } from "../../src/models/audit-record";

/**
 * The live PRODUCTION workspace-id population, measured at HEAD `3b74e497` by
 * DIRECT READING of the defining sites.
 * ⚠ METHOD, stated precisely: a pattern scan for `workspaceId: "…"` alone
 * UNDER-reports this population — `demoSeed.ts` DOES use that form and is found
 * by such a scan, but `scope.ts` and `onboarding.ts` declare these ids as
 * type-union members and named consts, which such a scan misses entirely. The
 * population below is the union of both, read directly:
 *   `apps/desktop/renderer/store/scope.ts:18,39-41` · `store/onboarding.ts:41-43`
 *   `apps/worker/src/composition/demoSeed.ts:84,99,110`
 *   `apps/worker/src/composition/legacy-workspace.ts:42` (LEGACY_UNPREFIXED)
 *   `apps/worker/src/api/procedures/copilotGbrainSubprocess.ts:42` (DEFAULT_GBRAIN)
 *   `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts:382-384`
 * ⚠ THIS IS A UI CONVENTION, NOT A GATE (`L123`): the shipped renderer derives
 * the id from the workspace bucket (`onboarding/index.tsx` → `scopeForType`,
 * total over the closed `WorkspaceType` union), but the tRPC create endpoint
 * does NOT constrain it — `parseCreateWorkspace` admits any non-empty trimmed
 * string and does not run this schema. Any authed loopback client or dev
 * fixture could therefore have persisted an out-of-shape id.
 *
 * ⭐ PRE-EXISTING ROWS — MEASURED, not assumed (2026-08-17). Against the live
 * operational store (`~/Library/Application Support/@sow/desktop/sow.db`,
 * opened READ-ONLY): 13 columns carry a workspace id; 3 distinct values exist;
 * ALL 3 conform to this shape; 0 non-conforming. ⇒ zero availability break on
 * that deployment.
 * ⛔ SEARCH BOUNDARY (`L100`) — the claim is exactly that and no wider: repo
 * source, plus ONE deployment's store at one moment. A different install is
 * UNMEASURED, so the read-side redaction gate remains the sole control for any
 * non-conforming row that may exist elsewhere. Dormancy is not a guarantee
 * (`L106`); do not read "0 here" as "0 anywhere."
 */
const LIVE_PRODUCTION_IDS = ["employer-work", "personal-business", "personal-life"] as const;

/** Shapes the well-formedness rule must reject. */
const OUT_OF_SHAPE: ReadonlyArray<readonly [string, string]> = [
  ["", "empty"],
  [" ", "single space"],
  ["   ", "whitespace only"],
  ["ws_employer", "underscore"],
  ["ws-A", "trailing uppercase"],
  ["MARKERWORKSPACE", "all uppercase"],
  ["-lead", "leading separator"],
  ["trail-", "trailing separator"],
  ["ws space", "inner space"],
  ["ws/../etc", "path traversal"],
  ["../../etc/passwd", "relative traversal"],
  ["ws.dot", "dot — would let `.`/`..` form"],
  ["ws\ttab", "control char"],
  // Regression pins, not live defects: JS `$` without the `m` flag already
  // rejects a trailing newline (the PCRE/Python gotcha does not apply). These
  // exist so that adding an `m` flag or swapping matchers goes RED — an embedded
  // newline is the log-injection shape, and this id reaches log sinks.
  ["ws\nid", "embedded newline (log injection)"],
  ["employer-work\n", "trailing newline"],
  ["ws\r", "carriage return"],
  ["ws​zwsp", "zero-width space (L-141 family: not ECMAScript whitespace)"],
  ["a".repeat(65), "exceeds the 64-char bound"],
];

/**
 * Credential-shaped strings that this shape ACCEPTS. Pinned deliberately — an
 * asserted acceptance is a STATED limitation; an unasserted one is a gap a
 * future reader assumes is covered (`L82`).
 */
const LOWERCASE_CREDENTIAL_SHAPES = [
  "sk-ant-api03-abc123def456",
  "ghp-16c7e42f292c6912e7710c838347ae178b4a",
  "akiaiosfodnn7example",
  "deadbeefcafebabe0123456789abcdef",
  "xoxb-123456789012-abcdefghijklm",
] as const;

/**
 * Brands that do NOT come from the shape-free `brandedIdSchema` factory and so
 * are legitimately outside the sibling-invariance check. Enumerated explicitly:
 * a NEW factory brand is covered automatically, while a new non-factory schema
 * fails this suite loudly and forces a conscious decision.
 */
const NON_FACTORY_SCHEMAS = new Set([
  "WorkspaceIdSchema", // the subject of this slice
  "FactIdentitySchema", // own regex (pre-existing)
  "MdContentShaSchema", // own regex (pre-existing)
]);

/** Values the narrowed workspace shape rejects — siblings must still accept them. */
const SIBLING_PROBES = ["ws_employer", "ws-A", "MARKERWORKSPACE"] as const;

/**
 * Values the FACTORY itself guarantees are rejected (`.min(1)` + the non-blank
 * `.refine`). Asserted per sibling so that WEAKENING the factory goes red —
 * accept-side probes alone cannot see a weakening, because weakening only widens
 * acceptance.
 */
const FACTORY_REJECT_PROBES = ["", "   "] as const;

/**
 * EXACT, not a floor. `zod-brands.ts` exports 19 `*Schema` symbols; 3 are
 * non-factory (above) ⇒ 16 factory brands. A floor (`>=`) would tolerate a
 * silent loss — an export deleted, or a name quietly added to
 * `NON_FACTORY_SCHEMAS` — while the "every factory brand" claim kept reading true.
 */
const FACTORY_BRAND_COUNT = 16;

type Parseable = { safeParse: (v: unknown) => { success: boolean } };

/** Stage 1: name-filtered. Stage 2: also has `safeParse`. Sizes MUST agree. */
const namedFactorySchemas = (): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(brands as Record<string, unknown>).filter(
    ([name]) => name.endsWith("Schema") && !NON_FACTORY_SCHEMAS.has(name),
  );

const factoryBrandEntries = (): ReadonlyArray<readonly [string, Parseable]> =>
  namedFactorySchemas().filter(
    (e): e is [string, Parseable] =>
      typeof (e[1] as Parseable | undefined)?.safeParse === "function",
  );

describe("WorkspaceIdSchema own shape — spec(§5) spec(§16)", () => {
  it("rejects out-of-shape values", () => {
    for (const [value, why] of OUT_OF_SHAPE) {
      expect(WorkspaceIdSchema.safeParse(value).success, `${why}: ${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  // ⛔ THE AVAILABILITY PIN — the one test that stops a hardening becoming an
  // outage. Rejecting an id in use today is an availability break, not a win.
  it("accepts every live production id", () => {
    for (const id of LIVE_PRODUCTION_IDS) {
      expect(WorkspaceIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("accepts lowercase credential shapes — it is NOT a credential detector", () => {
    for (const cred of LOWERCASE_CREDENTIAL_SHAPES) {
      expect(WorkspaceIdSchema.safeParse(cred).success, cred).toBe(true);
    }
  });

  // The bound is bounded-input hygiene. This test also pins that the bound buys
  // NO credential rejection, so the rationale cannot drift into one.
  it("bounds length at 64 — and the bound is not credential defense", () => {
    expect(WorkspaceIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(WorkspaceIdSchema.safeParse("a".repeat(65)).success).toBe(false);
    for (const cred of LOWERCASE_CREDENTIAL_SHAPES) {
      expect(cred.length, `${cred} is within both max(64) and max(40)`).toBeLessThanOrEqual(40);
    }
  });

  // The brand is COMPILE-TIME only, so a runtime equality assertion cannot
  // observe it — `expect(parsed).toBe("employer-work")` passes for a plain
  // string too. Pinned at the TYPE level instead: the annotation fails to
  // compile if `parse` stops returning `WorkspaceId`, and the `@ts-expect-error`
  // fails as an UNUSED directive if a bare string ever becomes assignable.
  it("preserves the brand on a valid parse — pinned at the type level", () => {
    const parsed: WorkspaceId = WorkspaceIdSchema.parse("employer-work");
    expect(parsed).toBe("employer-work");
    // @ts-expect-error — a bare string must NOT be assignable to WorkspaceId
    const notBranded: WorkspaceId = "employer-work";
    expect(notBranded).toBe("employer-work");
  });
});

describe("brandedIdSchema factory is UNCHANGED — spec(§3)", () => {
  // The enumeration itself is pinned: no silent loss through either filter stage.
  it("enumerates exactly the factory brands — both filter stages agree", () => {
    const named = namedFactorySchemas();
    const parseable = factoryBrandEntries();
    expect(named).toHaveLength(FACTORY_BRAND_COUNT);
    // If these diverge, a `*Schema` export lost its `safeParse` and was silently
    // dropped from every assertion below.
    expect(parseable).toHaveLength(named.length);
  });

  // Complete-by-construction rather than sampled: every factory brand, not two.
  it("every other factory brand still ACCEPTS values the workspace shape rejects", () => {
    for (const [name, schema] of factoryBrandEntries()) {
      for (const probe of SIBLING_PROBES) {
        expect(schema.safeParse(probe).success, `${name} <- ${probe}`).toBe(true);
      }
    }
  });

  // ⛔ THE DIRECTION THAT CATCHES A WEAKENED FACTORY. Accept-side probes above
  // cannot: weakening only widens acceptance, so stripping `.min(1)` and the
  // non-blank refine would leave them all green. These pin the factory's OWN
  // guarantee, which is the thing "UNCHANGED" actually claims.
  it("every other factory brand still REJECTS empty / whitespace-only", () => {
    for (const [name, schema] of factoryBrandEntries()) {
      for (const probe of FACTORY_REJECT_PROBES) {
        expect(schema.safeParse(probe).success, `${name} <- ${JSON.stringify(probe)}`).toBe(false);
      }
    }
  });

  it("the workspace shape rejects exactly those same probes", () => {
    for (const probe of SIBLING_PROBES) {
      expect(WorkspaceIdSchema.safeParse(probe).success, probe).toBe(false);
    }
  });
});

describe("the class fix's KNOWN boundary — spec(§16)", () => {
  // ⛔ STATE THE UNIT — three different populations get called "17" (`L183`):
  //   17 = model files containing the TOKEN `workspaceId` (includes
  //        `signed-provenance-stamp.ts`, which has NO such field — it matches
  //        only an arch_gap comment about the HMAC)
  //   16 = model files DECLARING a `workspaceId`-named field
  //   14 = models validating that field through the brand
  //    1 = `Workspace`, which validates its `id` through the brand (different
  //        field name, so a `workspaceId:`-keyed census misses it)
  //    1 = `AuditRecord`, the ONE model declaring a `workspaceId` that does NOT
  //        route it through the brand
  // ⛔ Deliberately NOT collapsed into a "15 of 17" ratio: those two numbers
  // count different things, and subtracting them is what produced the phantom
  // "2 unidentified skippers" this task inherited (`L183` — subtraction launders
  // a unit error out of view).
  //
  // `AuditRecord`'s skip is DELIBERATE AND STRUCTURAL: the model imports no
  // branded ids at all, to keep `z.infer` free of module-private brand symbols
  // (`audit-record.ts` header). Pinned so a future reader cannot mistake a
  // designed boundary for a gap.
  it("AuditRecord still accepts a workspaceId the brand rejects (deliberate, documented)", () => {
    const record = {
      actor: "ToolGateway",
      event: "external.write.committed",
      refs: ["plan:abc"],
      payloadHash: "sha256:deadbeefcafe",
      beforeSummary: "before",
      afterSummary: "after",
      timestamps: { occurredAt: "2026-06-30T12:00:00.000Z" },
      workspaceId: "ws_employer",
    };
    expect(AuditRecordSchema.safeParse(record).success).toBe(true);
    expect(WorkspaceIdSchema.safeParse("ws_employer").success).toBe(false);
  });
});

// ── On the discriminating control (`L80`) ───────────────────────────────────
// An earlier draft of this file carried a `discriminating control` describe that
// built an accept-everything stand-in and asserted it rejected nothing. That
// assertion was VACUOUS TWICE OVER: it tested a property of a two-line literal
// declared beside it, so no implementation of `WorkspaceIdSchema` could ever
// make it fail; and its surviving half merely restated `rejects out-of-shape
// values` as a count. It is deleted rather than repaired, because the control it
// was reaching for is ALREADY STRUCTURAL here:
//   • an accept-everything shape fails `rejects out-of-shape values` (18 cases), and
//   • a reject-everything shape fails `accepts every live production id` (3 cases).
// Those two tests bracket the schema from both sides, so neither degenerate
// implementation can pass this file. A separate "control" test added nothing but
// the appearance of one — which is the failure mode `L80` exists to prevent.
