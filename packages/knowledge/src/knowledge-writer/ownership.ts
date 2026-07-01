// Human-owned section preservation (§6, REQ-F-016 / KN-7 / KN-8, task 4.2). The
// `OwnershipCheck` predicate the KnowledgeWriter injects (writer.ts `deps.ownershipCheck`)
// BEFORE the secret scan and the atomic commit. It compares the on-disk bytes
// (`priorContent`) against the projected post-apply bytes (`nextContent`) and
// admits the write ONLY when it rewrites marker-bounded assistant regions the
// plan actually targets — every human-owned byte and every untargeted assistant
// region stays intact.
//
// Four rejection conditions, all surfaced as a typed `ownership_violation`
// (§16, never thrown):
//   1. malformed region markers on either side (can't attribute ownership);
//   2. an untargeted assistant region whose bytes changed (KN-8: unrelated
//      regions are byte-stable across a rewrite);
//   3. a new assistant region no patch targets (no silent invented region);
//   4. human-owned content deleted, modified, or absorbed into a region (KN-7).
//
// PURE: no fs/clock/network. Reuses the `sections.ts` region model.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  OwnershipCheck,
  OwnershipCheckContext,
  OwnershipViolation,
} from "./writer";
import {
  parseSections,
  humanOwnedText,
  type AssistantSection,
  type Section,
} from "../markdown-vault/sections";

function violation(
  path: string,
  reason: string,
  regionId?: string,
): OwnershipViolation {
  return { code: "ownership_violation", path, regionId, reason };
}

/** id → exact marker-to-marker byte slice, for byte-stability comparison. */
function regionRawById(sections: readonly Section[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sections) {
    if (s.kind === "assistant") {
      map.set(s.regionId, (s as AssistantSection).raw);
    }
  }
  return map;
}

// Human-owned bytes are compared modulo whitespace that merely frames a machine
// marker (the structural `\n\n` a region insertion introduces is not human
// semantic content). Every non-whitespace human character + its order is pinned.
function humanSignature(sections: readonly Section[]): string {
  return humanOwnedText(sections).replace(/\s+/gu, " ").trim();
}

/**
 * Ownership predicate over one changed file. Returns `ok` when the write only
 * touches targeted assistant regions; otherwise a typed `ownership_violation`.
 */
export function checkOwnership(
  ctx: OwnershipCheckContext,
): Result<void, OwnershipViolation> {
  const { path, priorContent, nextContent, plan } = ctx;

  // A create (no prior file) has no human content to protect; still reject a
  // structurally malformed region layout so a broken region can't be born.
  if (priorContent === undefined) {
    const parsedNew = parseSections(nextContent);
    if (!parsedNew.ok) {
      return err(violation(path, `malformed_marker:${parsedNew.error.reason}`, parsedNew.error.regionId));
    }
    return ok(undefined);
  }

  const parsedPrior = parseSections(priorContent);
  if (!parsedPrior.ok) {
    return err(
      violation(path, `prior_malformed_marker:${parsedPrior.error.reason}`, parsedPrior.error.regionId),
    );
  }
  const parsedNext = parseSections(nextContent);
  if (!parsedNext.ok) {
    return err(violation(path, `malformed_marker:${parsedNext.error.reason}`, parsedNext.error.regionId));
  }

  const priorSecs = parsedPrior.value;
  const nextSecs = parsedNext.value;
  const priorRegions = regionRawById(priorSecs);
  const nextRegions = regionRawById(nextSecs);
  const targeted = new Set(
    plan.patches.filter((p) => p.path === path).map((p) => p.regionId),
  );

  // (2) Untargeted prior regions must survive byte-identically (KN-8).
  for (const [id, raw] of priorRegions) {
    if (targeted.has(id)) {
      continue;
    }
    const nextRaw = nextRegions.get(id);
    if (nextRaw !== raw) {
      return err(violation(path, "unrelated_region_modified", id));
    }
  }

  // (3) A new assistant region must be explicitly targeted by a patch — no
  // silently invented region absorbing surrounding content.
  for (const id of nextRegions.keys()) {
    if (!priorRegions.has(id) && !targeted.has(id)) {
      return err(violation(path, "untargeted_region_introduced", id));
    }
  }

  // (4) Human-owned content must be preserved — this also catches absorption:
  // any human token pulled inside a (targeted or new) region leaves the human
  // set and the signatures diverge.
  if (humanSignature(priorSecs) !== humanSignature(nextSecs)) {
    return err(violation(path, "human_content_modified"));
  }

  return ok(undefined);
}

/** The injectable `OwnershipCheck` KnowledgeWriter wires into its apply pipeline. */
export const enforceHumanOwnership: OwnershipCheck = checkOwnership;
