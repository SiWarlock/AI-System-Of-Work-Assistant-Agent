// spec(§16) — task 24.32: `proposeWindows.ts` reuses the canonical raw-content-shape
// predicate (`@sow/contracts`'s `isRawContentShaped`/`carriesRawContent`, hardened by
// task 24.19 — Map/Set/non-enumerable/Symbol-key closed by construction) instead of
// maintaining its own unfixed fork (24.19 Step 9 / contracts L138). Two behavioral
// regression pins prove the reuse actually took (not merely imported alongside a
// still-running fork) without newly over-rejecting a clean payload; a census pin
// (mirroring `neutralizer-single-source.test.ts`'s #54/L39 pattern) proves the
// predicate lives exactly ONCE repo-wide, both function AND const forms, both-anchored.
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { carriesRawContent as fromContracts, ok, sourceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { payloadCarriesRawContent, createProposeWindowsActivity } from "../src/activities/proposeWindows";
import type { ValidatedProposal } from "../src/ports/crossCalendarScheduling";
import {
  CALENDAR_PAYLOAD_KEYS,
  unknownCalendarPayloadKey,
} from "../src/activities/calendar-payload-allowlist";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ORG_WS = "ws-allowlist-test" as WorkspaceId;

/** A minimal well-formed DerivedCalendarAction descriptor, sharing every field a
 * real deriver must supply except `payload`, which each test overrides. */
function baseAction(payload: Record<string, unknown>) {
  return {
    targetSystem: "calendar" as const,
    canonicalIdentity: { slot: "s" },
    operation: "calendar.create",
    idempotencyIdentity: { slot: "s" },
    payload,
    approvalPolicy: "auto_private",
    payloadHash: "h",
    preconditions: [],
    genericExplanation: "no conflicts",
  };
}

function buildWith(payload: Record<string, unknown>) {
  const port = createProposeWindowsActivity({
    projection: { project: () => ok({ action: baseAction(payload) }) },
    sourceRef: { sourceId: sourceId("src-allowlist-1") },
    planIdentity: { run: "1" },
  });
  const validated: ValidatedProposal = { validated: true, fields: {}, windows: [] };
  return port.build(validated, ORG_WS);
}

describe("24.32 — proposeWindows reuses the canonical raw-content-shape predicate", () => {
  // 24.19's own case: a Map value's entries are internal slots, not own enumerable
  // string-keyed properties — the fork's `Object.entries` traversal could never see
  // it. RED against the unmodified fork; proves the reuse actually took.
  it("propose_windows_rejects_a_map_valued_field — the fork's Object.entries traversal could not see this", () => {
    const m = new Map([["x", "line one\nline two — raw transcript"]]);
    expect(payloadCarriesRawContent({ schedule: m })).toBe(true);
  });

  // 24.19's other own case: a non-enumerable own property is invisible to
  // `Object.entries`/`Object.keys`/`for...in` — the canonical predicate scans via
  // `Object.getOwnPropertyNames` instead. RED against the unmodified fork.
  it("propose_windows_rejects_a_non_enumerable_raw_property — the fork's Object.entries traversal could not see this either", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "secret", {
      value: "line one\nline two — hidden raw text",
      enumerable: false,
    });
    expect(payloadCarriesRawContent({ meta: obj })).toBe(true);
  });

  // The risk direction a delete-and-reuse introduces: the canonical predicate is
  // STRICTER, so verify no legitimate short/single-line payload is newly rejected.
  it("propose_windows_still_accepts_a_clean_payload", () => {
    expect(
      payloadCarriesRawContent({
        start: "2026-08-20T09:00:00.000Z",
        end: "2026-08-20T09:30:00.000Z",
        genericExplanation: "conflicts with a busy block",
      }),
    ).toBe(false);
  });
});

// Census the repo's non-test TypeScript sources for `pattern`, returning the matching
// FILES. `node_modules`/`dist` excluded so a hoisted install or stale build output
// can't make the census see the canonical definition twice and fail spuriously. A
// grep fault yields `[]`, which fails the assertions below (fail-closed, never a
// false green).
function censusFiles(grepArgs: string): readonly string[] {
  let out = "";
  try {
    out = execSync(
      `grep -rn ${grepArgs} packages apps --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist || true`,
      { cwd: repoRoot, encoding: "utf8" },
    );
  } catch {
    out = "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    // Source definitions only — a test fixture that declares one is not a second authority.
    .filter((l) => !l.includes(".test.ts") && !l.includes("/test/"))
    .map((l) => l.split(":")[0])
    .filter((f): f is string => f !== undefined);
}

describe("24.32 — isRawContentShaped/carriesRawContent live ONCE, in @sow/contracts", () => {
  it("raw_content_shape_predicate_lives_once — exactly ONE DEFINITION of isRawContentShaped repo-wide", () => {
    // Matches any DEFINITION form (`function isRawContentShaped`, `const
    // isRawContentShaped =`), not just the `export function` spelling a re-fork
    // would most plausibly land as (L39). RED today — proposeWindows.ts's fork is
    // a second `export function` definition; this is the pin 24.34 deliberately
    // deferred to this slice because two definitions legitimately existed until now.
    expect(censusFiles(`-E '(function|const) isRawContentShaped'`)).toEqual([
      "packages/contracts/src/models/gcl-projection.ts",
    ]);
  });

  it("carries_raw_content_lives_once — exactly ONE DEFINITION of carriesRawContent repo-wide", () => {
    // Not RED today (the fork's wrapper was named `payloadCarriesRawContent`, never
    // colliding on this name) — a completeness pin for the predicate's other half,
    // covering a future fork under the canonical name.
    expect(censusFiles(`-E '(function|const) carriesRawContent'`)).toEqual([
      "packages/contracts/src/models/gcl-projection.ts",
    ]);
  });

  it("propose_windows_export_is_the_contracts_authority — the two import paths yield the SAME function object", () => {
    // Referential identity, not behavioral agreement: proves a re-export rather
    // than a re-implementation that merely agrees today (the exact failure mode
    // this task exists to close). RED today — the fork is a distinct function.
    expect(payloadCarriesRawContent).toBe(fromContracts);
  });
});

// R7-g — the plan row cites `crossCalendarScheduling.ts` (the PURE driver); the
// leakage detector actually lives here, in the ACTIVITY the driver calls via
// `deps.buildOutputs.build(...)`. `crossCalendarScheduling.ts` was not touched.
describe("R7-g — the calendar-payload key allowlist fails closed on an unknown field", () => {
  it("an_unknown_payload_key_is_refused_even_when_its_value_looks_generic", async () => {
    // Every allowlisted key present, PLUS one extra key whose value is short and
    // single-line — exactly the shape `payloadCarriesRawContent` alone would admit.
    const built = await buildWith({
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
      genericExplanation: "conflicts with a busy block",
      attendeeEmail: "alice@acme.example",
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe("build_failed");
      expect(built.error.message).toMatch(/attendeeEmail/);
    }
  });

  it("the_allowlist_is_the_authority_not_the_value_shape — an allowlisted key with a raw-content-shaped VALUE still refuses", async () => {
    // Only allowlisted keys, but genericExplanation's VALUE is multi-line — the
    // value-shape check (payloadCarriesRawContent) must still fire. Proves the two
    // guards COMPOSE: the allowlist alone waves this payload through (every key is
    // known — checked directly below), so the refusal must come from the OTHER
    // (value-shape) guard, never the allowlist replacing it.
    const leakyPayload = {
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
      genericExplanation: "Sync with Acme re: Q3 contract\nAttendees: alice@acme, bob@acme",
    };
    expect(unknownCalendarPayloadKey(leakyPayload)).toBeNull(); // the allowlist alone sees no unknown key
    const built = await buildWith(leakyPayload);
    expect(built.ok).toBe(false); // yet the build still refuses — the value-shape guard caught it
  });

  it("every_allowlisted_key_the_deriver_actually_emits_is_present", async () => {
    // A normal, clean derivation — the deriver's own emitted keys must be a SUBSET
    // of CALENDAR_PAYLOAD_KEYS (the allowlist must not be missing a legitimate key).
    const built = await buildWith({
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
      genericExplanation: "conflicts with a busy block",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      const emittedKeys = Object.getOwnPropertyNames(built.value.action.payload);
      expect(emittedKeys.length).toBeGreaterThan(0);
      for (const key of emittedKeys) {
        expect(CALENDAR_PAYLOAD_KEYS.has(key)).toBe(true);
      }
    }
  });

  it("a_symbol_keyed_or_non_enumerable_own_key_is_also_refused", async () => {
    // Mirrors the traversal hardening `payloadCarriesRawContent` already has
    // (task 24.19): a bare `Object.keys`/`Object.entries` walk cannot see either of
    // these, so a naive allowlist check would silently admit them.
    const nonEnumerable: Record<string, unknown> = {
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
    };
    Object.defineProperty(nonEnumerable, "genericExplanation", {
      value: "no conflicts",
      enumerable: false,
    });
    Object.defineProperty(nonEnumerable, "hiddenLeak", {
      value: "short and single-line",
      enumerable: false,
    });
    expect(Object.keys(nonEnumerable)).toEqual(["start", "end"]); // control: invisible to Object.keys
    const built1 = await buildWith(nonEnumerable);
    expect(built1.ok).toBe(false);

    const symKeyed: Record<string, unknown> = {
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
      genericExplanation: "no conflicts",
    };
    const leakSymbol = Symbol("leak");
    (symKeyed as Record<PropertyKey, unknown>)[leakSymbol] = "short and single-line";
    expect(Object.keys(symKeyed)).toEqual(["start", "end", "genericExplanation"]); // control: invisible to Object.keys
    // Unit-level, direct on `unknownCalendarPayloadKey` — NOT just the full build
    // path: `payloadCarriesRawContent` (the pre-existing @sow/contracts check)
    // independently treats ANY Symbol-keyed own property as raw-content-shaped BY
    // CONSTRUCTION regardless of value (gcl-projection.ts's own `isRawContentShaped`
    // Symbol-presence rule), so a build-level assertion alone would stay green even
    // if THIS module's own Symbol scan were deleted — that redundancy would mask a
    // regression here. Asserting the allowlist function's own return value directly
    // proves ITS Symbol traversal specifically, not the neighboring guard's.
    expect(unknownCalendarPayloadKey(symKeyed)).not.toBeNull();
    const built2 = await buildWith(symKeyed);
    expect(built2.ok).toBe(false);
  });

  it("unknownCalendarPayloadKey fails closed on a non-plain-object payload (null/array) — extra coverage beyond the 5 named tests, for the IMPLEMENT spec's stated fail-closed behavior", () => {
    // Not one of R7-g's 5 named TDD tests, but `unknownCalendarPayloadKey` is
    // documented as "fail-closed on a non-plain-object input" — pinning it directly.
    expect(unknownCalendarPayloadKey(null as unknown as Record<string, unknown>)).not.toBeNull();
    expect(unknownCalendarPayloadKey([1, 2] as unknown as Record<string, unknown>)).not.toBeNull();
  });

  it("the_refusal_reason_carries_no_payload_VALUE", async () => {
    // Rule 7 (secrets/redaction) applies to the refusal path too — the message may
    // name the offending KEY, never its VALUE.
    const secretValue = "leaked-secret-value-should-never-appear-in-a-message";
    const built = await buildWith({
      start: "2026-08-20T09:00:00.000Z",
      end: "2026-08-20T09:30:00.000Z",
      genericExplanation: "no conflicts",
      sourceEventTitle: secretValue,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.message).toMatch(/sourceEventTitle/);
      expect(built.error.message).not.toContain(secretValue);
    }
  });
});
