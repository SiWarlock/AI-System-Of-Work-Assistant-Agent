// Foreign-workspace path-consistency guard (24.12 remedy leg; §5 WS-8; safety rule 4).
//
// The `packages/policy` Copilot serving-time `LegacyContentPolicy` `{mode:"assign"}` bridge
// (`copilot-workspace-scope.ts`) treats every UNPREFIXED note in the combined gbrain brain as
// belonging to its one `toWorkspaceId` — sound ONLY while the brain holds a single workspace's
// unprefixed content. That precondition was previously enforced by an operator-discipline comment
// alone (contracts L123: "MUST is prose, not a gate"). This guard makes the unsound state
// UNREPRESENTABLE at the ONE place every semantic write crosses (KnowledgeWriter, safety rule 1): a
// foreign-workspace note whose path does not carry its own workspace's prefix is rejected before any
// filesystem write (`writer.ts` step 4.5, before ownership/secret-scan/commit).
//
// LAYERING (24.12 brief, deliberate): this module expresses the invariant in the WRITER's own terms
// — "a note's path must be consistent with its bound workspace" — as DATA (which one workspace may
// commit unprefixed), never as an import of `packages/policy`: a writer (rule-1 territory) importing
// a Copilot SERVING policy would be a layering inversion.
//
// ⛔ THE EXEMPT WORKSPACE ID IS NO LONGER STORED HERE (24.26, complete). It is a REQUIRED argument to
// `makeEnforceWorkspacePathScope`, supplied by the composition root; its single home is
// `apps/worker/src/composition/legacy-workspace.ts`.
//
// ⛔ AND DO NOT BIND THIS TO `apps/desktop`'s `copilotLegacyContentPolicy.toWorkspaceId`. The two
// strings match today and are DIFFERENT FACTS: that one decides where unassigned Copilot legacy
// content is ASSIGNED at serving time; this one decides who may COMMIT UNPREFIXED PATHS. The full
// reasoning lives once, at `apps/worker/src/composition/legacy-workspace.ts` — not restated here,
// since duplicating the FRAMING of a fact is how the fact itself drifted.
//
// ⚠⚠ BUT THEY MUST STILL BE CHANGED TOGETHER, AND THE CONSEQUENCE OF NOT DOING SO IS A WS-8 LEAK —
// recorded here because 24.26 step 3 deleted the docblock that used to carry it, and that docblock
// had the direction WRONG in the reassuring direction (it called the stranded workspace
// "writable-but-no-longer-served (inert, not a leak)"). ⛔ IT IS NOT INERT: it is served TO THE OTHER
// WORKSPACE. If `toWorkspaceId` moves to `personal-life` while this guard still exempts
// `personal-business`, the exempt workspace keeps committing UNPREFIXED, those slugs stay
// unattributable, `assign` maps legacy → `personal-life`, and `decideHitScope` KEEPS them for a
// `personal-life` ask ⇒ personal-business content surfaces under another workspace's ask, and
// personal-business loses its own legacy content. Nothing structurally stops `employer-work` here.
// ⇒ Not one fact, not independent either: two facts with a coupled safe-change rule.
//
// EXEMPTIONS + a SECOND SANCTIONED PREFIX SHAPE (24.12 brief U3 + a code-quality-review finding):
//  1. The ONE legacy workspace (the supplied `exemptWorkspaceId`) may commit prefixed OR unprefixed —
//     narrowing this further would break the shipped, owner-chosen posture the `assign` bridge serves.
//  2. KN-12 structural surfaces (`index.md`/`log.md`/`Logs/<date>.md`) are writer-owned, not per-
//     workspace CONTENT, and legitimately ride inside ANY workspace's plan (13.8d: "structural parity
//     rides INSIDE the AUTO plan as ordinary KnowledgeWriter mutations") — reuses `isStructuralSurface`
//     (exported from `../synthesis/grounded-path`, L39: predicate lives once) so the two checks can
//     never drift.
//  3. `${SOURCE_NOTE_SUBTREE}/<workspaceId>/**` (`sources/<ws>/<digest>.md`) is a SECOND sanctioned
//     prefix shape, not an exemption — the workspace id still appears, as the SECOND segment rather
//     than the first. `apps/worker/src/composition/sourceNotePath.ts` derives every ingested-source
//     note at exactly this path (its own header names `SOURCE_NOTE_SUBTREE = "sources"` the "SINGLE
//     SOURCE OF TRUTH"), and left UNRECOGNIZED here, this guard rejected every real ingested source
//     for every workspace but the legacy-exempt one — caught by code-quality review BEFORE it shipped
//     (verified against real, running `apps/worker` tests, not inferred). `SOURCE_NOTE_SUBTREE` below
//     duplicates that file's constant VALUE as DATA, not as an import (packages/knowledge cannot
//     depend on apps/worker — the reverse of the layering direction this whole module exists to
//     preserve). ⚠ It is the LAST such duplication in this file: the exempt workspace id used to be
//     the other one and is now supplied as an argument instead (24.26).
//
// PURE; TOTAL never-throws; fail-closed (a malformed/absent plan.workspaceId is rejected, never
// silently admitted).
import { ok, err } from "@sow/contracts";
import type { WorkspacePathCheck, WorkspacePathContext, WorkspacePathViolation } from "./writer";
import { isStructuralSurface, hasNoTraversalSegments } from "../synthesis/grounded-path";

/**
 * DUPLICATES (never imports — `packages/knowledge` cannot depend on `apps/worker`)
 * `apps/worker/src/composition/sourceNotePath.ts`'s `SOURCE_NOTE_SUBTREE` constant. Drift direction:
 * if that file's value ever changes without a matching edit here, EVERY workspace's real source
 * ingestion starts failing this guard (fail-closed, breaks loudly) until the two are re-aligned.
 * Safe-but-loud in both directions; never silent.
 */
export const SOURCE_NOTE_SUBTREE = "sources";

function violation(path: string): WorkspacePathViolation {
  return { code: "workspace_path_violation", path };
}

/**
 * Build a path-scope check whose ONE legacy-exempt workspace is supplied, not asserted (24.26 step 1
 * of 3). The returned predicate rejects a changed path unless it is (a) a KN-12 structural surface,
 * (b) targeted by `exemptWorkspaceId`, (c) prefixed with its OWN `plan.workspaceId` as the first
 * `/`-delimited path segment, or (d) under `${SOURCE_NOTE_SUBTREE}/<workspaceId>/` (segment-wise
 * throughout, mirroring `copilot-workspace-scope.ts`'s own boundary-correct matching —
 * `employer-work` never matches `employer-work-x`).
 *
 * ⭐ THE ONLY IMPLEMENTATION, AND THE ONLY EXPORTED PREDICATE (contracts L39 — a predicate lives once;
 * ledger named because a bare `LNN` would mean the KNOWLEDGE ledger, which runs only §1–§3).
 * 24.26 step 3 deleted the module-level `enforceWorkspacePathScope` instance that used to sit below
 * this: an instance built here from a hardcoded string was a second home for the exempt workspace id,
 * which is the duplication the task removes. Build one per composition root instead.
 *
 * ⛔ THROWS on a blank `exemptWorkspaceId` — the one place in this module that throws, and only when
 * a check is BUILT, never per call, so the returned predicate keeps the module's PURE / TOTAL /
 * never-throws contract (§16) untouched.
 * ⭐ AND SINCE 24.26 step 3 THIS MODULE CONSTRUCTS NOTHING AT IMPORT TIME. Until step 3 there was a
 * module-level instance, so the throw could fire during MODULE EVALUATION and abort an import of
 * `writer.ts` / `@sow/knowledge`. That hazard is now discharged by deletion: the only way to reach
 * this throw is to CALL the factory, which only a composition root does.
 * ⛔ STANDING RULE FOR CALLERS: build the check ONCE at the composition root/boot. Constructing it on
 * a job path would surface a config fault as an uncaught throw exactly where `applyPlan` promises a
 * typed `WriteFailure` (its never-throws guarantee holds for WELL-TYPED deps — see `writer.ts`).
 * ⚠ THE REASON IS MISCONFIGURATION, NOT AN EXEMPTION HOLE — recorded precisely because the obvious
 * rationale is wrong and would otherwise be re-derived incorrectly. A blank exempt id opens NOTHING:
 * the `workspaceId.length === 0` fail-closed below returns BEFORE the exemption comparison is
 * reached, so `""` is unreachable there, and `""` never equals a non-empty workspace id. A blank
 * exempt id is INERT — it means "nothing is exempt", which is strictly fail-CLOSED. What it would
 * actually do, now that the composition root supplies it (24.26 complete), is SILENTLY DISABLE the
 * legacy-content posture the `{mode:"assign"}` bridge depends on. That is a misconfiguration, and it
 * should name itself at boot rather than surface later as "every personal-business unprefixed write
 * started failing." ⚠ `.trim()` (not `.length`) is deliberate: `" "` has length 1, so it would clear
 * the fail-closed check below and genuinely exempt a `" "` workspace.
 *
 * ⛔ WHAT THIS CHECK DOES **NOT** CLOSE — stated because this comment's first draft claimed it closed
 * "the one real hole," and a security review REFUTED that EMPIRICALLY rather than by reading.
 * `.trim()` covers the ECMAScript `WhiteSpace`/`LineTerminator` class ONLY. Zero-width / format code
 * points — U+200B ZWSP, U+200C ZWNJ, U+2060 WORD JOINER, U+180E — are category Cf, NOT whitespace:
 * they construct successfully here, AND they clear `WorkspaceIdSchema` (`zod-brands.ts:31-34`), which
 * applies the SAME `.trim()` test — so a zero-width exempt id paired with a zero-width plan workspace
 * admits an unprefixed vault-root write. ⇒ THIS IS A BLANK-CONFIG TRIPWIRE, NOT VALIDATION THAT THE
 * ARGUMENT IS A LEGITIMATE WORKSPACE ID.
 *
 * ⛔⛔ THE PRECONDITION, AND ITS TRIGGER IS NOT A STEP NUMBER (lead ruling, 24.26):
 * **the exempt workspace id must be validated against the known workspace set before it may be
 * sourced from anything other than a compile-time constant.** A hardcoded literal — what step 2 will
 * pass — does NOT make the residual reachable. What makes it reachable is env, settings, a DB row, a
 * user-editable file: anything where the supplying actor stops being trusted composition code. ⚠ The
 * trigger is deliberately stated as a CONDITION rather than "before step 2," because step 2 could
 * land safely and a config change months later could open the class with nobody re-reading `24.26`.
 * If you are here changing this argument from a constant to a config read, THIS is the obligation.
 */
export function makeEnforceWorkspacePathScope(exemptWorkspaceId: string): WorkspacePathCheck {
  // ⚠ The `typeof` half is UNREACHABLE from TypeScript (the parameter is typed `string`) and is kept
  // deliberately, mirroring the same defensive shape at the plan-workspaceId check below: the supplier
  // is a composition root, and a JS caller or an `as`-cast reaches this with anything. Without it,
  // `undefined` throws a bare "Cannot read properties of undefined" naming no parameter. The test's
  // blank-values table includes cast non-strings, so this branch is defensive, not dead.
  if (typeof exemptWorkspaceId !== "string" || exemptWorkspaceId.trim().length === 0) {
    // Names the parameter, never echoes the value (rule 7 posture — this is config, not a secret,
    // but the module's discipline is to keep boundary values out of messages).
    throw new Error("makeEnforceWorkspacePathScope: exemptWorkspaceId must be a non-blank string");
  }
  return (ctx: WorkspacePathContext) => {
    const path = ctx?.path;
    if (typeof path !== "string" || path.length === 0) return err(violation(typeof path === "string" ? path : ""));
    // Security-review finding (24.12): EVERY check below is a raw string match on path SEGMENTS
    // (prefix/equality), never a resolved-path check — so a `..`/`.`/empty segment can satisfy ANY of
    // them (the structural exemption, the plain prefix match, AND the sources/<ws>/ match) while
    // RESOLVING (`path.resolve`) somewhere else entirely: "Logs/../employer-work-secret.md"
    // string-starts-with "logs/" but resolves outside Logs/; "employer-work/../secret.md" string-starts
    // with "employer-work" but resolves to the vault ROOT, unprefixed — the exact unsound state this
    // whole guard exists to prevent. Reject up front (mirrors the order `admitGroundedPath` always
    // uses) — no exemption or prefix match downstream is meaningful on a traversal-crafted path, for
    // ANY workspace including the legacy-exempt one.
    if (!hasNoTraversalSegments(path)) return err(violation(path));
    if (isStructuralSurface(path)) return ok(undefined);
    const workspaceId = ctx?.plan?.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return err(violation(path)); // fail closed on a malformed plan
    if (workspaceId === exemptWorkspaceId) return ok(undefined);
    const segments = path.split("/");
    if (segments[0] === workspaceId) return ok(undefined);
    if (segments[0] === SOURCE_NOTE_SUBTREE && segments[1] === workspaceId) return ok(undefined);
    return err(violation(path));
  };
}
