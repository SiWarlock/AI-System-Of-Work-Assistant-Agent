// 24.92 — a SHARED `unsafeWorkspaceIdForTest`, so a genuine bypass in an OWNED test file routes
// through ONE named constructor instead of an anonymous `as WorkspaceId` cast. Reproduces the
// semantics `gcl-projection.test.ts` (:322-344, wave 1, NOT edited by this file) already established
// for its own local copy — that file is read for its docblock, never modified, per this task's hard
// limit. A safety predicate lives once (L39); this is the SAME predicate given a shared home so every
// OWNED file that needs it imports the real thing rather than re-deriving (or silently drifting from)
// its own copy.
//
// EXISTS ONLY TO MODEL A VALUE THE REAL CONSTRUCTOR WOULD REJECT — never a general-purpose "cast a
// string to WorkspaceId" helper. It refuses a BENIGN value (one drawn entirely from the brand's own
// alphabet, `[a-z0-9-]`) and throws — a legitimate test double for an ordinary id belongs on the REAL
// `workspaceId()` constructor from `@sow/contracts` (already used elsewhere, e.g.
// `workspace-path-guard.test.ts:13`'s `workspaceId as wsId`), not here.
import type { WorkspaceId } from "@sow/contracts";

/**
 * Model a PRE-VALIDATOR row: a value the real `workspaceId()` brand would reject (credential-shaped,
 * URL-shaped, anything outside `[a-z0-9-]`), cast past the brand so a downstream authority (a
 * redaction gate, a defense-in-depth re-check) can be driven with adversarial input it must reject on
 * its OWN terms — never a shortcut around constructing a normal test id.
 *
 * ⛔ AN ALPHABET PRECONDITION, NOT A HOSTILITY CHECK: this answers "would the brand reject this?", not
 * "is this credential-shaped?" — `"ws.acme"` satisfies it and is entirely benign. Deliberately NOT a
 * mirror of the brand's own regex (a safety predicate lives once — copying `^[a-z0-9]([a-z0-9-]*
 * [a-z0-9])?$` here would be a second, driftable home for it); this asserts the WEAKER, DURABLE
 * property every call site actually depends on: the value carries at least one character outside
 * `[a-z0-9-]`, implied by the brand's alphabet rather than its exact shape, so it holds under any id
 * rule drawn from that alphabet.
 *
 * Throws — not a silent pass-through — on a benign value: a caller reaching for this on an ordinary
 * fixture is reaching for the wrong tool, and a throw makes that reach visible immediately rather than
 * quietly building a benign "bypass" that proves nothing about the downstream authority under test.
 */
export function unsafeWorkspaceIdForTest(raw: string): WorkspaceId {
  if (!/[^a-z0-9-]/u.test(raw)) {
    throw new Error(
      "unsafeWorkspaceIdForTest: refusing a benign value — this constructor exists ONLY to model a " +
        "pre-validator row, and a value drawn entirely from [a-z0-9-] does not need it. Build a " +
        "well-formed id through the schema instead of bypassing it.",
    );
  }
  return raw as WorkspaceId;
}
