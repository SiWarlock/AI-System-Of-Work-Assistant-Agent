// §5 visibility levels + hard denial #2 (REQ-F-005 / REQ-F-020 / WS-8).
//
// Two responsibilities:
//   1. The visibility-level lattice (isolated < coordination < sanitized < full)
//      and the "within workspace default" predicate + the projection-visibility
//      gate §6 GCL-reconcile calls before serving a cross-workspace projection.
//   2. `denyDirectCrossWorkspaceRaw` — the fail-closed refusal of ANY direct
//      cross-workspace / cross-brain RAW retrieval (safety rule 4). The ONLY
//      permitted cross-workspace path is a sanitized GclProjection; the SOLE
//      exception is a recorded Level-3 owner-approved link.
//
// PURE + FAIL-CLOSED: missing / unrecognized / malformed input ⇒ DENY. Every
// decision emits a redaction-safe AuditSignal (refs / hashes / codes only).
import type { GclProjection, Workspace, VisibilityLevel } from "@sow/contracts";
import { isVisibilityLevel, WorkspaceIdSchema } from "@sow/contracts";
import { allowDecision, denyDecision, type PolicyDecision } from "./decision";
import { buildAuditSignal, POLICY_DENIAL_HEALTH_CLASS } from "./audit-signal";

// The visibility lattice: strictly increasing exposure. A closed map keyed by the
// four levels — total over VisibilityLevel, so the lookup is never undefined.
const RANK: Readonly<Record<VisibilityLevel, number>> = {
  isolated: 0,
  coordination: 1,
  sanitized: 2,
  full: 3,
};

/** Numeric rank of a visibility level: isolated(0) < coordination(1) < sanitized(2) < full(3). */
export function visibilityRank(l: VisibilityLevel): number {
  return RANK[l];
}

/**
 * True iff a projection's level does NOT exceed the workspace default — i.e. the
 * projection exposes no more than the workspace permits by default.
 */
export function isWithinDefault(
  projectionLevel: VisibilityLevel,
  workspaceDefault: VisibilityLevel,
): boolean {
  return visibilityRank(projectionLevel) <= visibilityRank(workspaceDefault);
}

/**
 * A `projectionType` ⇒ permitted-`VisibilityLevel`-set DERIVATION (task 24.18 /
 * WS-1 finding F14). §5/§6 arch_gap: the full `projectionType` taxonomy is
 * unspecified upstream (see `@sow/contracts` `gcl-projection.ts`) — this map is
 * deliberately EXTENSIBLE, not exhaustive. A `projectionType` absent from it has
 * no known derivation yet, so {@link isVisibilityConsistentWithProjectionType}
 * returns `true` (no opinion) for it — the workspace-default CEILING
 * ({@link isWithinDefault}) remains its sole gate until an entry is added here.
 */
export type ProjectionTypeVisibilityTaxonomy = Readonly<Record<string, readonly VisibilityLevel[]>>;

/**
 * The production default taxonomy — EMPTY. No `projectionType` category is
 * specified upstream today (the finding's own severity reasoning: self-disclosed
 * `arch_gap`, zero concrete `ProjectionSource` implementations), so asserting any
 * real category here would be an invented classification this package has no
 * authority to make. The derivation MECHANISM below is real and tested; this
 * constant is what makes it a no-op in production until a real taxonomy lands.
 */
export const DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY: ProjectionTypeVisibilityTaxonomy = {};

/**
 * Read `key` off `obj` ONLY if it is an OWN DATA property; `undefined` otherwise. The
 * single hardened read this module uses for every producer-controlled object (task
 * 24.65 / `#58`, safety rules 4 + 7).
 *
 * ⛔ TWO HAZARDS, ONE PRIMITIVE — and neither is closed by the obvious guard:
 *  • **Inherited property** ⇒ no own descriptor ⇒ `undefined`. Closes the FAIL-OPEN: a
 *    workspace built via `Object.create({id, defaultVisibility})` has zero own properties
 *    and previously read as well-formed, so a visibility gate returned **ALLOW** for it.
 *  • **Accessor property** ⇒ descriptor carries `get`, not `value` ⇒ the getter is NEVER
 *    INVOKED, so it cannot throw. Closes six measured accessor throw shapes (§16).
 *  • **Hostile Proxy trap** ⇒ caught. ⛔ THIS NEEDS THE `try`/`catch` AND AN EARLIER VERSION
 *    OF THIS COMMENT CLAIMED IT DID NOT: *"closes the throw class without a `try`/`catch` —
 *    the hostile code simply never runs."* **False.** `Object.getOwnPropertyDescriptor`
 *    INVOKES a Proxy's `getOwnPropertyDescriptor` trap, which is arbitrary caller code;
 *    three throw-throughs were measured (workspace, projection, taxonomy) against exactly
 *    the version that claimed otherwise. The accessor half never runs; the Proxy half does.
 *
 * ⚠ `Object.hasOwn` alone closes only the first: an own accessor passes it and still
 * throws on read. That is why the sibling guard below — cited as this class's hardened
 * exemplar — was itself incomplete against a hostile taxonomy.
 *
 * ⚠ RESIDUAL, measured and NOT closed here: this validates the DESCRIPTOR channel while
 * every downstream consumer reads through `[[Get]]`. For a plain object they coincide; a
 * Proxy can present one value to each. The gate is fail-closed either way (it can only
 * refuse on the descriptor it sees), but an ALLOWED projection can still read differently
 * downstream. Filed rather than fixed — closing it means validating and re-emitting.
 *
 * ⛔ `### 24.81` — THE ENUMERATION THIS RESIDUAL GESTURES AT, PRODUCED RATHER THAN LEFT
 * IMPLICIT. Named by SYMBOL, tracing `admitProjection`'s ALLOW value
 * (`packages/knowledge/src/gcl/visibility-gate.ts`'s `decision.value`) forward through
 * its production callers in `packages/knowledge/src/gcl/projection.ts`:
 *   • `admitAndPersistProjection` passes `admitted.value` straight to
 *     `repo.upsert(admitted.value)` — the `GclProjectionRepository` INTERFACE call, not
 *     yet a concrete read.
 *   • The interface's two concrete dialect implementations RE-READ the same object via
 *     ordinary property access, never a descriptor — these ARE the `[[Get]]` consumers
 *     this note names: `gclProjections.upsert` in
 *     `packages/db/src/adapters/sqlite/index.ts` (`.values(projection)` +
 *     `projection.sanitizedPayload` / `projection.sourceRefs`) and its byte-identical
 *     mirror in `packages/db/src/adapters/postgres/index.ts`.
 *   • `serveProjection` (same file as `admitAndPersistProjection`) returns `admitted` —
 *     carrying the identical gate-validated object on its `ok` branch — straight to ITS
 *     caller. The one named production call site, `resolveApprovedCrossWorkspaceSlice`
 *     (`apps/worker/src/composition/crossWorkspaceRead.ts`), is a THIRD `[[Get]]`
 *     consumer IN SOURCE but is NOT production-reachable as of this measurement (that
 *     file's own doc comment: zero production callers of its own, every real caller is
 *     in a test file) — a dormant consumer, not a live one.
 * METHOD: a forward SYMBOL trace from `admitProjection`'s success branch (not a
 * name-grep, which would miss the interface indirection through
 * `GclProjectionRepository`), reading each landing site's body to classify it as a
 * `[[Get]]` re-read (ordinary property access / spread / destructure) vs. a fresh
 * re-parse (which would close the divergence — see `WorkspaceSchema.parse` two
 * paragraphs down, which already does this for `Workspace`). `get` /
 * `listByWorkspace` / `listByVisibility` on the same repository are OUT OF SCOPE for
 * THIS residual: they read a DIFFERENT object (a freshly `row as GclProjection`-cast
 * STORED row, not the in-memory gate-validated reference) — a distinct unchecked-cast
 * hazard tracked separately (`contracts L76`'s remaining `pattern:` census).
 * BOUNDARY: `packages/knowledge/src`, `packages/db/src`, `apps/worker/src` — SRC ONLY,
 * no test trees (a test-only reader carries no production risk); traced FORWARD from
 * this module's own gate, not backward from every `GclProjectionRepository` caller for
 * unrelated reasons. Taken at commit `16169caf0a0e4575caa7b8faae2e6bbd8ddd2911`.
 * BOUNDED, not open-ended, WITHIN that boundary: exactly two concrete repository
 * implementations exist and `admitProjection`'s success value has exactly two
 * production call sites in `projection.ts`. NOT bounded ACROSS TIME: this exported
 * `validateProjectionVisibility` is directly callable with an un-Zod-parsed candidate
 * from anywhere in `packages/policy`'s dependents — `admitProjection`'s Zod stage is
 * what currently defuses the divergence for every production caller (`GclProjectionSchema
 * .safeParse` constructs a FRESH plain object from the candidate before this function
 * ever sees it, so `projection` here already coincides descriptor-vs-`[[Get]]` in
 * production); a future caller bypassing that stage would need its own enumeration,
 * not this one.
 *
 * ⛔ `### 24.81` REVIEWER SCOPE NOTE — TRACED, NOT CLAIMED UNREACHABLE. The reviewer traced
 * ONE production call site for `projection`/`candidate` (the Zod `parsed.data` inside
 * `admitProjection` itself, two paragraphs down) and explicitly left `sourceWorkspace`
 * UNTRACED. Traced here, BACKWARD from `validateProjectionVisibility`'s `sourceWorkspace`
 * parameter through every non-test production caller of the three functions that supply it
 * (`admitProjection`, `admitAndPersistProjection`, `serveProjection` — `packages/knowledge/
 * src/gcl/{visibility-gate,projection}.ts`):
 *   • `admitAndPersistProjection` (the WRITE leg) — ZERO production callers; every call site
 *     is `packages/knowledge/test/gcl-projection.test.ts`.
 *   • `serveProjection` ← `createGclProjectionGate` (`packages/workflows/src/activities/
 *     gclProjectionGate.ts`), whose `sourceWorkspace` is `lookupWorkspace(candidate.workspaceId)`
 *     — an INJECTED function bound at exactly one site (`deps.gclProjection.lookupWorkspace`)
 *     inside `createOutputWorkflowActivities`.
 *     ⛔⛔ RE-DERIVED 2026-08-28 AND THIS LEG HAS CHANGED — the trigger this note itself names
 *     ("re-derive this note when that binding lands") HAS FIRED, and nobody ran it until now.
 *     ~~"which itself has ZERO production callers in `apps/worker/src` … the worker composition
 *     root never calls it"~~ — STRUCK AND RETAINED. `apps/worker/src/composition/
 *     buildActivities.ts:1617` NOW CALLS IT, ungated. So this leg reaches a production entry
 *     point: `serveProjection` ← `createGclProjectionGate` (`outputWorkflows.ts:423`) ←
 *     `createOutputWorkflowActivities` ← the composition root.
 *   • `serveProjection` ← `resolveApprovedCrossWorkspaceSlice` (`apps/worker/src/composition/
 *     crossWorkspaceRead.ts`), whose `sourceWorkspace` IS a real, wired store read
 *     (`deps.workspaceConfig.get(link.toWorkspaceId)`) — but that function itself has ZERO
 *     production callers (its own module header: "ships behind a reachability waiver until
 *     25.2/25.4"; re-confirmed here, not merely relayed from that comment).
 * ⇒ ⛔ THE ABSENCE CONCLUSION IS NO LONGER TRUE, AND THE SAFETY PROPERTY STILL HOLDS — for a
 * DIFFERENT REASON THAN THIS NOTE GAVE, which is exactly why it had to be re-derived rather
 * than inherited. ~~"`sourceWorkspace` reaches this function via NO production entry point
 * today — the write leg and both read legs each terminate at a function with zero production
 * callers"~~ — STRUCK AND RETAINED (`L194`).
 *   • WRITE leg (`admitAndPersistProjection`) — still ZERO src call sites. UNCHANGED.
 *   • READ leg via `resolveApprovedCrossWorkspaceSlice` — still ZERO src call sites of its own.
 *     UNCHANGED.
 *   • READ leg via `createGclProjectionGate` — ⛔ NOW LIVE to the composition root (above).
 * ⭐ WHAT ACTUALLY DEFUSES THE DIVERGENCE IS ALREADY DOCUMENTED TWO PARAGRAPHS UP AND IS
 * UNAFFECTED: `serveProjection` delegates to `admitProjection` (`projection.ts:227`), whose
 * `GclProjectionSchema.safeParse` constructs a FRESH plain object before this function sees the
 * candidate; and both production producers of a `Workspace` terminate in `WorkspaceSchema.parse()`,
 * so `sourceWorkspace` is a fresh plain object too. ⇒ the gate was never resting on the absence —
 * it rests on the Zod stages, and the absence was a second, weaker belt that has now gone.
 * ⚠ THE LESSON, because the note did everything right and still went stale: it named its own
 * re-derivation trigger, stated its METHOD, and pinned the commit — and the trigger fired
 * silently anyway, because NOTHING WATCHES A TRIGGER. A re-derivation condition written in prose
 * is a request, not a mechanism.
 * ⚠ AND A MEASUREMENT WARNING FROM RE-RUNNING IT: an `rg | head -6` while re-deriving this
 * returned only comment hits and looked like "the symbol does not exist" — output ORDER is not
 * stable, so a truncated search is not evidence of absence. Re-run unbounded before concluding.
 * METHOD: `grep -rn "admitAndPersistProjection(\|serveProjection(\|createGclProjectionGate\|
 * resolveApprovedCrossWorkspaceSlice" packages apps --include='*.ts'`, every SRC hit read to
 * classify test vs production caller. BOUNDARY: `packages/knowledge/src`, `packages/workflows/
 * src`, `apps/worker/src` — SRC only, same convention as the enumeration above. Taken at commit
 * `67adf09f8a9b23bcd79fd88818f9a8819f5d6511`.
 *
 * ⚠ FAIL-CLOSED BEHAVIOUR CHANGE, and it is safe because of what produces a `Workspace`:
 * both production producers terminate in `WorkspaceSchema.parse()` (`defaultWorkspace`,
 * and `packages/db`'s workspace read gate returning `parsed.data`), and a Zod parse emits
 * a fresh plain object with own data properties. An accessor-bearing or class-instance
 * producer would now be DENIED — deliberate for a safety gate, and measured, not assumed.
 *
 * ⛔ `### 24.82` leg (a) — NO ENUMERABILITY CHECK, AND THAT IS DELIBERATE, NOT AN
 * OVERSIGHT. `Object.getOwnPropertyDescriptor` returns a descriptor for an OWN property
 * regardless of whether it is enumerable, and this function only inspects `"value" in
 * descriptor` — never `descriptor.enumerable`. So a workspace whose every property was
 * defined non-enumerable (`Object.keys(w)` returns `[]`) still reads as well-formed here
 * and still passes. ⚠ ENUMERABILITY GOVERNS ITERATION (`for...in` / `Object.keys()` /
 * object-spread), NOT PROPERTY EXISTENCE — a security predicate that DENIED a hidden-but-
 * real property would be refusing based on how the object enumerates, not on what it
 * contains, which is the wrong axis for a fail-closed gate to key on (the fail-open this
 * function exists to close, `Object.create({...})`, is about the property being ABSENT
 * from the object entirely, not merely hidden from enumeration).
 * ⛔⛔ THE CONSEQUENCE FOR AN AUDITOR: an `Object.keys()`-based sweep of this gate's
 * admission criterion reaches the WRONG CONCLUSION. `Object.keys(workspace).length === 0`
 * looks exactly like the `Object.create({...})` fail-open this module closes, and is NOT
 * — the two are distinguishable only by `Object.getOwnPropertyDescriptor`, never by
 * `Object.keys`/`for...in`/`JSON.stringify`. Pinned so a future "tighten to require
 * enumerable properties" change is a visible RED, not a silent behavior change.
 */
interface OwnDataRead {
  /** `true` only for an OWN DATA property — distinct from one whose value is `undefined`. */
  readonly found: boolean;
  readonly value: unknown;
}
const NOT_FOUND: OwnDataRead = { found: false, value: undefined };

function readOwnDataProperty(obj: unknown, key: string): OwnDataRead {
  if (obj === null || typeof obj !== "object") return NOT_FOUND;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor === undefined || !("value" in descriptor)) return NOT_FOUND;
    return { found: true, value: descriptor.value };
  } catch {
    // ⛔ A Proxy's `getOwnPropertyDescriptor` TRAP IS ARBITRARY CALLER CODE and
    // `Object.getOwnPropertyDescriptor` invokes it. Measured: a throwing trap on the
    // workspace, the projection or the taxonomy threw straight out of this module. A
    // hostile trap is malformed input, so it fails CLOSED here rather than propagating.
    return NOT_FOUND;
  }
}

/** The value only — for the sites where "absent" and "present-but-undefined" are both malformed. */
function readOwnData(obj: unknown, key: string): unknown {
  return readOwnDataProperty(obj, key).value;
}

/**
 * The §5/§6 derivation check: does `level` belong to the permitted set for
 * `projectionType`? A `projectionType` with NO entry in `taxonomy` has no
 * derivation opinion — returns `true` (fail-OPEN for the unknown case only,
 * matching this module's `arch_gap` convention; the ceiling check is the
 * fail-closed floor for every projectionType regardless of taxonomy coverage).
 * A `projectionType` WITH an entry is fail-closed: `level` must be a member.
 */
export function isVisibilityConsistentWithProjectionType(
  projectionType: string,
  level: VisibilityLevel,
  taxonomy: ProjectionTypeVisibilityTaxonomy = DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY,
): boolean {
  // `projectionType` is a fully open, producer-controlled string — a bare
  // `taxonomy[projectionType]` bracket lookup on a plain-object taxonomy would
  // resolve a prototype-colliding name ("constructor", "__proto__", ...) to an
  // INHERITED Object.prototype member instead of `undefined`, defeating the
  // `undefined` short-circuit below and throwing on `.includes` — never throw
  // across this boundary (§16 / this module's own fail-closed contract).
  // `Object.hasOwn` checks OWN membership only (desktop Lesson 15's family).
  // ⛔ 24.65/#58 — was `Object.hasOwn` + a bracket read. `hasOwn` closes the prototype-KEY
  // hazard described above but NOT an own ACCESSOR: a taxonomy carrying a throwing getter
  // passed `hasOwn` and then threw on the bracket read, so this guard — the one cited as the
  // hardened exemplar for this class — was itself incomplete. `readOwnData` closes both.
  // `Array.isArray` because an own data property need not be an array, and `.includes` on a
  // non-array is the same never-throw violation by another route.
  const entry = readOwnDataProperty(taxonomy, projectionType);
  // ⛔ ABSENT ⇒ `true` (no derivation opinion) — this predicate only ever ADDS denials for
  // types it knows; the workspace-default CEILING remains an independent gate, so returning
  // `true` here is not an authorization. An inherited, accessor or hostile-trap entry reads
  // as absent by design: an unusable taxonomy entry is "no opinion", never "permitted".
  //
  // ⛔ `found`, NOT `value === undefined` — the distinction is load-bearing and I collapsed
  // it once: pre-slice, `Object.hasOwn` separated ABSENT from PRESENT-BUT-`undefined`, and a
  // taxonomy `{ summary: undefined }` denied. Reading only the value made it ALLOW, a silent
  // deny→allow flip on a caller-supplied input. `found` restores the pre-slice answer.
  if (!entry.found) return true;
  const permitted = entry.value;
  // `Array.isArray` because an own data property need not be an array, and `.includes` on a
  // non-array is the same never-throw violation by another route.
  return Array.isArray(permitted) && permitted.includes(level);
}

/**
 * §9.4 Global-Today drill-down gate: does a projection's visibility level permit
 * opening WORKSPACE-SCOPED RAW context from the global surface?
 *
 * ONLY `full` — the top of the lattice, the sole level that authorizes raw/full
 * exposure. Every level below (`isolated`/`coordination`/`sanitized`) is a
 * sanitized-only cross-workspace exposure, so drilling to raw would exceed what the
 * workspace authorized for the global surface; it is denied (the owner can still open
 * that workspace directly via its own scope — a within-workspace read — but the GLOBAL
 * drill is a deliberate boundary crossing and stays conservative).
 *
 * FAIL-CLOSED: the strict `=== "full"` returns false for ANY other value, including a
 * malformed/unrecognized one — never permits raw on a bad input. Shared by the worker
 * UI-safe projector (the `drillable` affordance HINT) AND the worker drill-down query
 * (the ENFORCEMENT) so the hint can never diverge from the gate.
 */
export function permitsRawDrillDown(level: VisibilityLevel): boolean {
  return level === "full";
}

// A payloadHash-shaped code (not a real content hash — policy is pure and has no
// hasher outside session-auth). Redaction-safe: a fixed decision-kind marker; the
// projection/workspace identity rides the refs.
const VISIBILITY_PAYLOAD_MARKER = "policy:visibility-decision" as const;
const CROSS_WS_PAYLOAD_MARKER = "policy:cross-workspace-raw-decision" as const;

/**
 * Projection-visibility gate (§6 GCL-reconcile predicate). FAIL-CLOSED:
 *  - projection omits visibilityLevel or workspaceId, or workspaceId mismatches the
 *    source workspace, or the source default is itself malformed ⇒ MALFORMED_POLICY_INPUT.
 *  - level exceeds the workspace default, or falls outside the closed level set ⇒
 *    VISIBILITY_EXCEEDS_SOURCE.
 *  - otherwise ALLOW, echoing the projection.
 */
export function validateProjectionVisibility(
  projection: GclProjection,
  sourceWorkspace: Workspace,
  taxonomy: ProjectionTypeVisibilityTaxonomy = DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY,
): PolicyDecision<GclProjection> {
  // ⛔ 24.65/#58 — OWN DATA reads, not `?.`. `?.` guards a nullish left side only: it
  // resolves inherited properties (the fail-open) and invokes accessors (six throw shapes).
  const wsId: unknown = readOwnData(projection, "workspaceId");
  const level: unknown = readOwnData(projection, "visibilityLevel");
  // ⛔ VALIDATE BEFORE INTERPOLATING (task 24.45, safety rules 4 + 7). `wsId` is the
  // CANDIDATE's own, still-unvalidated claim, and the mismatch branch below fires
  // PRECISELY when it is foreign — so interpolating it here would write untrusted
  // candidate data into the audit of the very check that exists to reject it.
  // `isRedactionSafe` cannot catch that: a workspace id (an employer project codename,
  // a person's name) is not credential-shaped — `contracts L5`. Mirrors the closed-set
  // discipline the visibility ref below already applies.
  //
  // Affects THREE deny branches, each of which previously emitted the raw candidate
  // value: "omits workspaceId" (its empty-string sub-case), "omits visibilityLevel",
  // and the mismatch itself. The allow / exceeds-source / type-mismatch paths run only
  // AFTER the equality check, so their ref is byte-identical to before.
  //
  // ⚠ Each workspace field is read ONCE, here, and reused everywhere below. A second read
  // could disagree with the first (a Proxy or lazily-hydrated record), which would render one
  // value into `refs` while a different one decides the branch. `readOwnData` also means an
  // accessor is never invoked, so the split-read attack is unrepresentable rather than merely
  // prevented (24.65 → #58; §5 / task-9.33 accessor precedent, `ARCHITECTURE.md:204-205`).
  //
  // ⛔ SURVIVING RESIDUAL — a Proxy whose `getOwnPropertyDescriptor` trap REPORTS one value
  // while its `get` trap RETURNS another still lies to this function. `readOwnData` takes the
  // descriptor's `value`, so the lie is confined to what the descriptor says; nothing here
  // re-reads via `get`. **Keep it that way: any raw `sourceWorkspace.x` added below re-opens
  // it** — that is exactly the defect `#58`'s own review caught in this slice.
  //
  // ⛔ RESIDUAL 2, stated so it cannot decay (`contracts L100`): on the equality branch this
  // ref renders the RAW `srcId`. That is trusted PROVENANCE (config-sourced), NOT validated
  // SHAPE. ⇒ ONE residual, TWO sites (`24.65`): the sibling is `denyDirectCrossWorkspaceRaw`'s
  // `from`/`to` below. **Closing one does NOT shut the class.**
  // ⛔ NO REMEDY IS FILED FOR THAT SITE — `### 24.68` MEASURED the obvious one and it does not
  // exist (no trusted supplier; the only candidate is caller-echoed). Read the note there
  // before assuming this half is merely awaiting work. *(This previously cited `#54`, a
  // session-scoped id `contracts L51` forbids for durable debt and which already resolves to a
  // different historical item.)*
  const srcId: unknown = readOwnData(sourceWorkspace, "id");
  const srcDefault: unknown = readOwnData(sourceWorkspace, "defaultVisibility");
  const refs: readonly string[] = [
    `ref:workspace:${
      typeof wsId !== "string" || wsId === "" ? "MISSING" : wsId === srcId ? wsId : "UNVALIDATED"
    }`,
    `ref:visibility:${isVisibilityLevel(level) ? level : "UNRECOGNIZED"}`,
  ];

  const denyMalformed = (afterSummary: string): PolicyDecision<GclProjection> =>
    denyDecision(
      "MALFORMED_POLICY_INPUT",
      afterSummary,
      buildAuditSignal({
        actor: "policy",
        event: "visibility.projection.denied",
        refs,
        payloadHash: VISIBILITY_PAYLOAD_MARKER,
        beforeSummary: "projection visibility not validated",
        afterSummary,
        denialCode: "MALFORMED_POLICY_INPUT",
      }),
    );

  // Fail-closed: absent identity fields (omits visibilityLevel / workspaceId).
  if (projection == null || wsId === undefined || wsId === null || wsId === "") {
    return denyMalformed("projection omits workspaceId");
  }
  if (typeof wsId !== "string") {
    return denyMalformed("projection workspaceId is not a string");
  }
  if (level === undefined || level === null) {
    return denyMalformed("projection omits visibilityLevel");
  }
  // Referential pin: a projection must name its own source workspace. Uses the SAME
  // single read as the audit ref above (24.45) — see the note there.
  if (wsId !== srcId) {
    return denyMalformed("projection workspaceId does not match source workspace");
  }
  // Guard the source default too — a malformed source posture is fail-closed input.
  if (!isVisibilityLevel(srcDefault)) {
    return denyMalformed("source workspace defaultVisibility is unrecognized");
  }

  const exceedsSignal = (afterSummary: string) =>
    buildAuditSignal({
      actor: "policy",
      event: "visibility.projection.denied",
      refs,
      payloadHash: VISIBILITY_PAYLOAD_MARKER,
      beforeSummary: "projection visibility not validated",
      afterSummary,
      denialCode: "VISIBILITY_EXCEEDS_SOURCE",
    });

  // Present but outside the closed level set ⇒ exceeds-source (unrecognized level
  // is treated as an over-exposure, fail-closed — never silently permitted).
  if (!isVisibilityLevel(level)) {
    return denyDecision(
      "VISIBILITY_EXCEEDS_SOURCE",
      "projection visibilityLevel falls outside the closed visibility set",
      exceedsSignal("projection visibilityLevel outside closed set"),
    );
  }
  // ⛔ `srcDefault`, NOT a raw `sourceWorkspace.defaultVisibility` re-read (24.65/#58 review).
  // The raw read here was the split-read shape 24.45 closed for `srcId`, re-opened by
  // hardening one read and not its sibling: a Proxy reporting one value via
  // `getOwnPropertyDescriptor` and another via `get` passed the guard above and then supplied
  // THE CEILING here — a fail-open on the gate that decides over-exposure.
  if (!isWithinDefault(level, srcDefault)) {
    return denyDecision(
      "VISIBILITY_EXCEEDS_SOURCE",
      "projection visibility level exceeds the workspace default",
      exceedsSignal("projection level exceeds workspace default"),
    );
  }

  // §5/§6 DERIVATION check (task 24.18 / WS-1 finding F14) — a SEPARATE,
  // INDEPENDENT gate alongside the ceiling check above, not a replacement for
  // it: a ceiling breach still denies even when the type/level pair is
  // consistent (the check above), and a type/level mismatch still denies here
  // even when the ceiling would have permitted the declared level. Raising
  // `sourceWorkspace.defaultVisibility` can never retroactively validate a
  // mismatched declaration — this check does not consult the ceiling at all.
  // 24.65/#58 — own-data read; a non-string projectionType is malformed input, denied
  // rather than coerced into the taxonomy lookup.
  const projType = readOwnData(projection, "projectionType");
  if (typeof projType !== "string") {
    return denyMalformed("projection projectionType is not a string");
  }
  if (!isVisibilityConsistentWithProjectionType(projType, level, taxonomy)) {
    return denyDecision(
      "VISIBILITY_TYPE_MISMATCH",
      "projection visibility level is not permitted for its projectionType",
      buildAuditSignal({
        actor: "policy",
        event: "visibility.projection.denied",
        refs,
        payloadHash: VISIBILITY_PAYLOAD_MARKER,
        beforeSummary: "projection visibility not validated",
        afterSummary: "projection level not permitted for its projectionType",
        denialCode: "VISIBILITY_TYPE_MISMATCH",
      }),
    );
  }

  return allowDecision(
    projection,
    buildAuditSignal({
      actor: "policy",
      event: "visibility.projection.allowed",
      refs,
      payloadHash: VISIBILITY_PAYLOAD_MARKER,
      beforeSummary: "projection visibility not validated",
      afterSummary: "projection within workspace default visibility",
    }),
  );
}

/** A recorded Level-3 owner-approved cross-workspace link (REQ-F-020 / WS-5). */
export interface ApprovedLink {
  readonly level3: true;
  readonly recordedApprovalRef: string;
}

/** Request shape for the direct cross-workspace raw-retrieval gate. */
export interface CrossWorkspaceRawRequest {
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  /** Present ⇒ a recorded Level-3 owner link (the SOLE permitted exception). */
  readonly approvedLink?: ApprovedLink;
}

/**
 * Hard denial #2 (safety rule 4): DENY any DIRECT cross-workspace / cross-brain RAW
 * retrieval. The only permitted cross-workspace path is a sanitized GclProjection
 * (validated above) — raw retrieval is never permitted directly. The SOLE exception
 * is a recorded Level-3 owner-approved link; ABSENT or malformed ⇒ deny (the link is
 * never auto-created). Same-workspace (from === to) is not a cross-workspace request.
 *
 * FAIL-CLOSED: missing / empty workspace ids ⇒ MALFORMED_POLICY_INPUT.
 */
export function denyDirectCrossWorkspaceRaw(
  req: CrossWorkspaceRawRequest,
): PolicyDecision<{ permitted: true }> {
  const from: unknown = req?.fromWorkspaceId;
  const to: unknown = req?.toWorkspaceId;

  if (
    req == null ||
    typeof from !== "string" ||
    from === "" ||
    typeof to !== "string" ||
    to === ""
  ) {
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "cross-workspace request omits a workspace id",
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.denied",
        refs: ["ref:workspace:from:MISSING", "ref:workspace:to:MISSING"],
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "cross-workspace request malformed",
        denialCode: "MALFORMED_POLICY_INPUT",
      }),
    );
  }

  // ⛔ RESIDUAL — the SAME one `24.45` recorded, SECOND SITE, not a second accepted risk
  // (`24.65`). `from`/`to` render RAW below after only a typeof/non-empty check, so a
  // credential-shaped workspace id reaches the audit. This is **`contracts L147`** — trusted
  // PROVENANCE is not validated SHAPE. The sibling site is the `srcId` interpolation in
  // `validateProjectionVisibility`, which points back here: ⛔ **closing one does NOT shut
  // the class.**
  // ⛔ NO FIX HERE — lead ruling (option D): `24.45`'s remedy is REFERENTIAL, interpolating
  // only a value proven equal to a trusted counterpart in scope. This function receives ONLY
  // `req`, so `from` and `to` are BOTH caller-supplied and no counterpart exists to prove
  // anything against. Reusing that sentinel without the validation that earns it would be a
  // weaker second spelling of a control `24.45` proved insufficient ⇒ false assurance, which
  // costs more than a documented gap: a documented gap gets re-checked, a control nobody
  // knows is weak does not.
  // ⛔⛔ THIS IS NOT "DEFERRED" — a residual filed as remediable when it is not is a false
  // promise that ages into a false assurance. ⚠ SCOPED PRECISELY, because the categorical
  // form is broader than the measurement: what is unfixable at this layer is THE REFERENTIAL
  // REMEDY. `### 24.68` proposed it — pass a trusted counterpart in — and MEASURING IT KILLED
  // IT (2026-08-14; re-run the chain, do not inherit):
  //   • `denyDirectCrossWorkspaceRaw` ← `guardCrossWorkspaceRawRead` ← `CrossWorkspaceLinkMap`
  //     `.authorizeCrossWorkspaceRawRead` ← NOTHING. No production caller supplies anything.
  //   • ⛔ And the one candidate that LOOKS like an authority is not one: `CrossWorkspaceLinkMap`
  //     holds `new Map()` and NOTHING ELSE — no registry, no resolver, no repo. Its keys are
  //     whatever a caller passed to `recordLink`, admitted by `endpointsValid` = non-empty +
  //     distinct — ⭐ THE SAME CLASS OF CHECK AS THE `typeof`/NON-EMPTY GUARD **ABOVE** THAT WE
  //     WOULD BE STRENGTHENING. (Direction matters: reading *below* lands on `linkValid`, which
  //     merely resembles it — the `### 24.66` shape, where the auditor concludes they misread.)
  //   • ⚠ The INPUT axis was checked too, since a dependency enumeration structurally cannot see
  //     a parameter-borne counterpart: `RecordLinkInput.approval` carries an `Approval
  //     .workspaceId` documented as server-bound. It does not rescue the remedy — `recordLink`
  //     never cross-checks it against `from`/`to`, and it is provenance again, not shape.
  //   ⇒ any "trusted counterpart" available here is THE SAME CALLER-SUPPLIED STRING ECHOED BACK.
  //     Passing it would manufacture `contracts L147` deliberately — trusted PROVENANCE
  //     presented as validated SHAPE — and would read as coverage forever after. That is
  //     `### 24.83`'s falsified justification exactly: "registry-validated" means "someone
  //     inserted it".
  // ⛔⛔ AND THE SAME LESSON APPLIES TO THE REGISTRY, WHICH AN EARLIER DRAFT OF THIS NOTE
  // EXEMPTED. It called `workspaceConfig` "A REAL authority" one sentence after using `24.83`
  // to disqualify the `Map` — ⛔ applying a lesson to one instance and not its sibling, in one
  // paragraph. `workspaceConfig` is an EXISTENCE authority and NOT a shape authority: its own
  // write boundary (`parseCreateWorkspace`) admits ANY NON-EMPTY STRING as the id and never
  // runs `WorkspaceIdSchema` (`### 24.62` boundary a / `#52`). ⇒ ⛔ WIRING IT WOULD NOT CLOSE
  // THIS RESIDUAL: a registry lookup proves NEITHER shape (`### 24.83`) NOR entitlement
  // (`### 24.62` boundary b — authz gates WHETHER, not WHICH). ⭐ Both halves are needed,
  // because a reader who notices this is a SHAPE residual will correctly dismiss an
  // entitlement-only objection and wire the registry anyway.
  // ⭐ THE ASYMMETRY, recorded because it outlives the timing: ONE counterpart cannot validate
  // both — `from` (the caller) would need an authenticated identity, none of which is in scope;
  // `to` (the target) would need an entitlement check.
  // ⛔ A SHAPE remedy WAS RE-DERIVED AGAINST `### 24.84` AND IS STILL REJECTED — BUT ONLY AS A
  // REMEDY FOR **THIS RESIDUAL**, AND THE SCOPE IS LOAD-BEARING: ⚠ the SAME edit at this sink
  // IS wanted, for a DIFFERENT reason (`### 24.95`, bounded-input hygiene). ⛔ Do not close
  // `### 24.95` on the strength of this rejection — it would retire a rule-7 fix that this
  // rejection was never about.
  // ⛔ WHY THIS PARAGRAPH WAS REWRITTEN (`### 24.93`, 2026-08-17): the sentence it replaces
  // carried its own expiry and nothing watched it — `L176`'s FIRES-AND-LOOKS-SILENT direction,
  // and `L187` from the other side: the decision WAS defended at the site where it mattered,
  // but an expiry condition needs a WATCHER, not a location. It read: "rejected against the
  // CURRENT schema … so that rejection expires when `24.84` lands."
  // ⭐ THE PRIOR GROUND WAS HALF RIGHT, AND THE HALVES SEPARATE. Option (B) — run
  // `WorkspaceIdSchema` on `from`/`to` before they render — was rejected as "cosmetic AND
  // provably admits the bad case" in
  // `docs/briefs/286-24.68-trusted-counterpart-for-cross-workspace-deny.md:45`
  // (⚠ the ADJACENT row `:44` is option (A), a different rejection — check the row you land
  // on), decided against the generic factory at
  // `packages/contracts/src/primitives/zod-brands.ts:30-35` @ `54b052a7` (`.min(1)` +
  // non-blank refine), which `WorkspaceIdSchema` merely BOUND at `:38`.
  //   • "COSMETIC" IS NOW FALSE, as of `25ae6c49` (`### 24.84` contracts leg): `WorkspaceId`
  //     carries a bounded positive slug shape, which strictly narrows against the
  //     `typeof`/non-empty guard ABOVE. ⛔ That shape is OWNED THERE and is NOT RESTATED IN
  //     THIS COMMENT — a second hand-maintained copy is `### 24.46`'s class. ⚠ Option (B) was
  //     an IMPORT, so `### 24.46` is NOT a third reason to reject it.
  //   • "ADMITS THE BAD CASE" SURVIVES, AND ITS GROUND IS NOW STRUCTURAL RATHER THAN
  //     SCHEMA-SPECIFIC — WHICH IS THE ENTIRE REPAIR, BECAUSE A SCHEMA-SPECIFIC GROUND IS
  //     EXACTLY WHAT EXPIRED: ⛔ NO CHARSET+LENGTH SHAPE CAN EXCLUDE CREDENTIAL SHAPES OVER AN
  //     OPEN ID SET. A credential is not charset-distinguishable from a well-formed id, and
  //     not length-distinguishable either — measured at `25ae6c49`: `hunter2abcdef` ACCEPTS
  //     and is EXACTLY as long as `employer-work` (13), so no bound separates them. `### 24.84`
  //     ships the same limitation about itself and PINS it executably
  //     (`packages/contracts/test/primitives/zod-brands.test.ts:161`); `worker L73` is why —
  //     "is this a credential?" is the unwinnable denylist question.
  //     ⛔⛔ SCOPED TO "CHARSET+LENGTH" DELIBERATELY, BECAUSE THE UNSCOPED FORM IS FALSE AND
  //     THIS NOTE ALMOST SHIPPED IT: an earlier draft said "a WELL-FORMEDNESS RULE cannot
  //     exclude credential shapes" and the security review CONSTRUCTED THE COUNTER-EXAMPLE —
  //     `^(employer-work|personal-business|personal-life)$` is a well-formedness rule, admits
  //     all 3 ids `### 24.84` measured live, and excludes every credential.
  //     ⇒ ⛔⛔ WHAT FORECLOSES AN ENUMERATION HERE IS *NOT* MEMBERSHIP-OPENNESS. THAT GROUND
  //     IS DEAD, AND IT IS NAMED DEAD RATHER THAN DELETED, BECAUSE AN OMITTED GROUND GETS
  //     RE-INVENTED BY THE NEXT AUTHOR.
  //     ⛔ ~~"A WORKSPACE ID'S MEMBERSHIP IS USER-DETERMINED BY DESIGN: `id` is a FREE field
  //     on the create path ⇒ a user creating `acme-corp` produces a slug-valid id that no
  //     enumeration written today contains, so an enumeration would reject a live id"~~ —
  //     RETAINED AS REASONING, FALSE AS STATE (`L195`). ⛔ MEASURED FALSE 2026-08-18,
  //     `### 24.111`'s completed census (`L106` — A CAPABILITY IS NOT A GUARANTEE):
  //       • ONE production constructor of the create input exists:
  //         `apps/desktop/renderer/surfaces/onboarding/index.tsx:82`, and it sets
  //         `id: scopeForType(type)`.
  //       • `scopeForType`'s codomain is the CLOSED 3-value `WorkspaceBucketScope` union.
  //       • ONE production tRPC call site (`renderer/lib/onboard-workspace.ts:48`). NO other
  //         production client of `onboarding.createWorkspace` exists.
  //       • THERE IS NO FREE-TEXT ID INPUT ANYWHERE IN ONBOARDING. `acme-corp` IS NOT
  //         PRODUCIBLE BY ANY PRODUCTION PATH.
  //     ⇒ `^(employer-work|personal-business|personal-life)$` ADMITS 3 OF 3 IDS THIS PRODUCT
  //     CAN MINT. The id set is OPEN AS A CAPABILITY — `parseCreateWorkspace` still accepts
  //     any slug-valid id from any local caller, `createWorkspace` being a `passthroughInput`
  //     mutation — and CLOSED IN PRACTICE at the only producer. ⛔ THE CAPABILITY IS NOT THE
  //     GROUND; THE PRODUCER IS.
  //     ⛔⛔ THE GROUND THAT ACTUALLY SURVIVES IS THE OTHER ONE: THE PRE-BRAND ROW POPULATION
  //     IS UNMEASURED ACROSS INSTALLS. The brand binds at CREATE and does NOT migrate rows
  //     written before it; `### 24.84` measured 3 of 3 conforming on ONE deployment at ONE
  //     moment (`L180` — a count sourced from what you personally saw is a SAMPLE).
  //     `### 24.106` OWNS that migration and is FILED, NOT BUILT — an OWNER-ACCEPTED cost,
  //     deliberately carried. ⇒ AN ENUMERATION WRITTEN TODAY COULD STILL REJECT A LEGACY ROW
  //     THAT NOBODY HAS ENUMERATED.
  //     ⚠ THIS NOTE PREVIOUSLY HAD THE TWO HALVES INVERTED — it said the enumeration was
  //     "foreclosed TWICE OVER right now" and that "only the MEMBERSHIP half survives
  //     `### 24.106` landing." THE MEMBERSHIP HALF IS THE ONE THAT DIED. Corrected here so a
  //     reader watching `### 24.106` land knows which ground they are watching expire.
  //     ⛔⛔ WHAT WOULD HAVE TO BE TRUE TO ENUMERATE SAFELY — STATED SO THE HONEST ANSWER IS
  //     "NOT YET" RATHER THAN "NO REASON REMAINS": the pre-brand population measured ACROSS
  //     INSTALLS rather than on one deployment, with the result showing every legacy id
  //     inside the proposed set. ⛔ UNTIL THEN THIS NOTE DOES NOT LICENSE AN ENUMERATION.
  //     THE LOSS OF THE MEMBERSHIP GROUND IS NOT A LICENCE — it removed one of two locks.
  //     ⚠ NO LIVE LEAK, AND NOTHING IS BROKEN TODAY: no enumeration is implemented. WHAT
  //     CHANGED IS THAT A FUTURE AUTHOR IS NOW *LICENSED* TO WRITE ONE — WHICH IS PRECISELY
  //     WHAT `### 24.55` EXISTS TO STOP. This is that entry's LIVE CASE, not an abstract risk.
  //     ⭐ THE TWO NAMESPACES ARE STILL DEMONSTRABLY DIFFERENT, AND THAT PART SURVIVES INTACT:
  //     `WorkspaceType` is `employer_work | personal_business | personal_life` (UNDERSCORES,
  //     `packages/contracts/src/primitives/enums.ts`) and would itself FAIL `WorkspaceIdSchema`,
  //     while the live ids are hyphen-spelled. ⇒ deriving an enumeration from the type enum is
  //     not merely incomplete, it is ILL-TYPED — a checkable fact, not a judgement. ⚠ BUT NOTE
  //     WHAT `### 24.111` MEASURED: `scopeForType` IS EXACTLY THAT DERIVATION, PERFORMED IN
  //     THE DESKTOP STORE — and it is why ids and scopes coincide at all.
  //     ⛔⛔ HOW TO WRITE THE NEXT CONTINGENCY IN THIS NOTE. THIS IS THE THIRD GROUND TO EXPIRE
  //     HERE AND THE FIRST TO EXPIRE *SILENTLY*. The previous text read: "IF the id set were
  //     EVER architecturally fixed to a closed set, membership WOULD stop being
  //     user-determined ... NO TASK OWNS THAT BECAUSE NO SUCH CHANGE IS PROPOSED."
  //     ⛔ THE CONDITION WAS ALREADY MET WHEN THAT SENTENCE WAS WRITTEN.
  //     ⇒ ⭐⭐ A GUARD WRITTEN IN THE FUTURE TENSE ABOUT AN ALREADY-TRUE CONDITION IS A GUARD
  //     THAT CLOSES THE QUESTION IT EXISTS TO OPEN: a reader who dutifully checks the named
  //     contingency reads "no such change is proposed" and STOPS. ⛔ WORSE THAN A ROTTED
  //     POINTER — every citation resolves, so the reader gets a CLEAN READ and a WRONG
  //     CONCLUSION. ⇒ WRITE EVERY CONTINGENCY IN THE TENSE OF ITS CURRENT TRUTH VALUE, AND
  //     STATE THE MEASUREMENT THAT ESTABLISHES IT.
  //   ⇒ the bad case is the one stated at the top of this residual — a credential-shaped id
  //     reaching the audit — and a shape gate does NOT close it. Recording one as if it did is
  //     the FALSE-ASSURANCE principle that rejected option (C) above: a weaker second spelling
  //     of a control already proved insufficient.
  // ⭐ And the asymmetry above survives all of this untouched: a shape validates
  // WELL-FORMEDNESS — never AUTHENTICITY (`from`) or ENTITLEMENT (`to`).
  // ⭐ THE GENERAL RULE, for the next author of a conditional note: PREFER A GROUND THAT
  // CANNOT EXPIRE; where contingency is unavoidable, name the contingency AND THE TASK THAT
  // OWNS IT — never a relative word like "current" or "in the tree".
  // ⚠ And "cannot reach here" is a WIRING fact, not
  // a structural impossibility — `apps/worker` already depends on `@sow/policy`, so a worker
  // caller could supply a counterpart without the `### 24.81`-fenced GCL port binding.
  // ⚠ Reachability MEASURED 2026-08-13 — and stated as REACHABILITY, not as "no caller",
  // because it HAS two production callers: `← guardCrossWorkspaceRawRead`
  // (`packages/knowledge/src/gcl/visibility-gate.ts:255`) `← CrossWorkspaceLinkMap`'s
  // `authorizeCrossWorkspaceRawRead` (`packages/knowledge/src/gcl/cross-workspace-links.ts:237`)
  // `← NOTHING`. ⛔ NOT production-REACHABLE from any entry point.
  // ⚠ CORRECTED 2026-08-14 — this previously read "BOTH hops are exported from
  // `@sow/knowledge`'s public barrel, so a SINGLE import makes this live … the dormancy is ONE
  // IMPORT away from ending." **That is no longer true: `### 24.78` Part 1 landed and the barrel
  // no longer re-exports `./gcl/visibility-gate` or `./gcl/cross-workspace-links`.** Arming this
  // now takes a deliberate deep import through the surviving `"./*"` wildcard — which that same
  // barrel classifies as the path taken BY INTENT rather than BY ACCIDENT. ⭐ The dormancy is
  // narrower than it was, NOT guaranteed: the wildcard fence is `24.78`'s own Done-when and is
  // still open. **Stale in the ALARMING direction, and corrected anyway** — a severity argument
  // resting on a false premise is a defect whichever way it leans.
  // ⚠ The four `packages/workflows/src` appearances are COMMENTS, not calls
  // (`contracts L104`, use-vs-mention; filed as `#53`).
  //
  // ⭐ `### 24.95` — a DIFFERENT fix, for a DIFFERENT reason, at the SAME sink. The residual
  // above rejects a "shape remedy" AS A REMEDY FOR THAT RESIDUAL (authenticity/entitlement
  // cannot be proven by shape) and says explicitly not to close that residual on this fix's
  // strength. This edit is not that: it is bounded-input hygiene at a DURABLE sink, mirroring
  // `validateProjectionVisibility`'s own `wsId`-vs-`srcId` shape guard two paragraphs of
  // context up. `WorkspaceIdSchema.safeParse` bounds SHAPE ONLY — a lowercase alphanumeric
  // slug, hyphen-separated, ≤64 chars (`packages/contracts/src/primitives/zod-brands.ts`).
  // It is NEVER described as "validated": a credential-shaped id that happens to conform to
  // the slug shape (`sk-ant-api03-...`) still passes and is still interpolated verbatim —
  // pinned in `visibility.test.ts`'s task-24.95 describe block so the limitation stays
  // stated, not assumed (per that schema's own docblock: "is this a credential?" is a
  // structurally unwinnable denylist question this check does not attempt to answer).
  // Each side is checked INDEPENDENTLY so a malformed `from` cannot hide a malformed `to`;
  // on failure the withheld sentinel replaces ONLY that side. The DECISION below (from===to,
  // link validity, final deny) is computed from the RAW `from`/`to` — unchanged — this
  // touches only what is RECORDED in the durable ref.
  const fromShapeBounded = WorkspaceIdSchema.safeParse(from).success;
  const toShapeBounded = WorkspaceIdSchema.safeParse(to).success;
  const refs: readonly string[] = [
    `ref:workspace:from:${fromShapeBounded ? from : "UNVALIDATED"}`,
    `ref:workspace:to:${toShapeBounded ? to : "UNVALIDATED"}`,
  ];

  // Same-workspace: not a cross-workspace request — the hard denial does not apply.
  if (from === to) {
    return allowDecision(
      { permitted: true },
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.same_workspace",
        refs,
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "same-workspace request — not a cross-workspace retrieval",
      }),
    );
  }

  // SOLE exception: a recorded Level-3 owner-approved link. Validate structurally;
  // absent OR malformed ⇒ deny (never auto-create the link).
  const link = req.approvedLink;
  const linkValid =
    link != null &&
    link.level3 === true &&
    typeof link.recordedApprovalRef === "string" &&
    link.recordedApprovalRef !== "";

  if (linkValid) {
    return allowDecision(
      { permitted: true },
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.permitted_via_link",
        // Record only that a link was present + recorded — never the raw approval ref.
        refs: [...refs, "ref:approved-link:level3:recorded"],
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "cross-workspace raw retrieval permitted via recorded Level-3 link",
      }),
    );
  }

  return denyDecision(
    "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
    "direct cross-workspace raw retrieval is denied absent a recorded Level-3 owner-approved link",
    buildAuditSignal({
      actor: "policy",
      event: "visibility.cross_workspace_raw.denied",
      refs,
      payloadHash: CROSS_WS_PAYLOAD_MARKER,
      beforeSummary: "cross-workspace raw retrieval not evaluated",
      afterSummary: "direct cross-workspace raw retrieval denied (no recorded Level-3 link)",
      denialCode: "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    }),
  );
}
