// Gate 4 (G1e-1) — the production RehydrateFn: re-hydrate a fact's bytes from COMMITTED Markdown at serve time.
//
// The serving gate (`admitForServing`) NEVER serves DB bytes — it re-reads the committed vault through an
// injected RehydrateFn and re-verifies the provenance stamp before admitting. This module builds that RehydrateFn
// over an already-read vault snapshot + the trusted allow-set (CanonicalFactSet). For a page fact it:
//   1. finds the fact in the allow-set → its FactProvenance.originPath (the committed note path);
//   2. reads that note's bytes from the snapshot;
//   3. re-hashes them through the SHARED `computePageProvenance` — the SAME function the deriver + the writer
//      use, so the rehydrated mdContentSha matches the allow-set's page hash byte-for-byte (leg A);
//   4. reads back the SignedProvenanceStamp via `readStampField` (leg B re-verifies its HMAC).
// Any missing fact / originPath / note / stamp fails closed to a typed RehydrateError (the gate withholds the
// candidate — never a crash, never a partial admit). Pure + synchronous (the snapshot is pre-read); never throws.
import { ok, err } from "@sow/contracts";
import type { MdContentSha } from "@sow/contracts";
import type { RehydrateFn, RehydratedFact, RehydrateError } from "./rehydration-gate";
import { computePageProvenance } from "../derive/canonical-fact-deriver";
import type { CanonicalFactSet } from "../derive/canonical-fact-deriver";
import { readStampField } from "../../knowledge-writer/provenance-stamp";

/** A synchronous committed-vault reader (a pre-read snapshot lookup) — the RehydrateFn is sync by contract. */
export type CommittedNoteReader = (path: string) => string | undefined;

const fail = (factIdentity: string, reason: string): RehydrateError => ({
  code: "rehydrate_failed",
  factIdentity,
  reason,
});

/**
 * Build a {@link RehydrateFn} over a pre-read vault snapshot + the trusted allow-set. `readNote` reads a
 * committed note by path (a snapshot lookup); `allowSet` maps each factIdentity to its committed `originPath`.
 * Rehydration re-hashes the LIVE committed bytes (not the allow-set's stored hash) so the gate's leg A can catch
 * a bytes-vs-canonical-hash divergence, and reads the stamp back for leg B's HMAC re-verification. Serves only
 * PAGE facts (the citable/served unit — `computePageProvenance` is the page hasher); a fact with no safe page
 * slug, no originPath, an unreadable note, or no stamp fails closed → the gate withholds it.
 */
export function createVaultRehydrate(readNote: CommittedNoteReader, allowSet: CanonicalFactSet): RehydrateFn {
  const byId = new Map(allowSet.facts.map((f) => [String(f.fact.factIdentity), f]));
  return (factIdentity: string) => {
    const df = byId.get(factIdentity);
    if (df === undefined) return err(fail(factIdentity, "not_in_allow_set"));
    const originPath = df.provenance.originPath;
    if (originPath === undefined || originPath.length === 0) {
      return err(fail(factIdentity, "origin_path_missing"));
    }
    const content = readNote(originPath);
    if (content === undefined) return err(fail(factIdentity, "note_unreadable"));
    // Re-hash the LIVE bytes through the shared core (kwStamp is carved out — G1b — so the committed stamped
    // note re-derives to the SAME page hash the stamp bound). Non-page / unhashable notes fail closed.
    const page = computePageProvenance(originPath, content);
    if (page === null) return err(fail(factIdentity, "unhashable_note"));
    const stamp = readStampField(content);
    if (stamp === null) return err(fail(factIdentity, "no_stamp"));
    const rehydrated: RehydratedFact = {
      factIdentity,
      content,
      mdContentSha: page.pageSha as MdContentSha,
      stamp,
    };
    return ok(rehydrated);
  };
}
