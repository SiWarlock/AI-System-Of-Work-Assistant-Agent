// spec(§6 KN-10 · §12 · REQ-F-017) — 13.8c synthesis REASON-leg eval: corpus loader + deps builders.
//
// Translates a labeled `SynthesisCorpusEntry` into the exact `SynthesisInput` + `SynthesisDeps` the LANDED
// `planSynthesis` consumes: the recorded model candidate replayed through a fake `SynthesisReasonPort`, the
// per-note region allowlist through a fake `SynthesisSectionPort`, and the per-entity gbrain resolution
// (withheld/create_stub/resolved) through a fake `EntityGbrainReadPort` (mirrors the unit test's fakes).
// Deterministic / provider-free (no model / network / clock / random).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err, isErr } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import type {
  SynthesisInput,
  SynthesisDeps,
  SynthesisSectionPort,
  EntityGbrainReadPort,
  EntityCandidate,
  EntityReadFault,
  EntityRef,
} from "@sow/knowledge";
import { loadCorpus, type CorpusManifest } from "../harness/corpus-loader";
import { CORPUS_FLOORS, type SynthesisCorpusEntry } from "../harness/corpus-schemas";

/** The single workspace the corpus runs under (the eval is workspace-agnostic for the safety invariants). */
export const SYNTH_WS = "ws-synth" as WorkspaceId;

const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");

/** Load + verify the synthesis corpus through the real loader (hash/floor-checked, replay-stable). */
export function loadSynthesisCorpus(): readonly SynthesisCorpusEntry[] {
  const dir = resolve(CORPORA, "synthesis");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as SynthesisCorpusEntry[];
  const r = loadCorpus<SynthesisCorpusEntry>(manifest, entries, { expectedFloor: CORPUS_FLOORS.synthesis });
  if (isErr(r)) {
    throw new Error(`synthesis corpus failed to load: ${JSON.stringify(r.error)}`);
  }
  return entries;
}

/** Build the SynthesisInput for an entry (workspace-bound; linkCandidates get the workspace id). */
export function buildInput(entry: SynthesisCorpusEntry): SynthesisInput {
  return {
    workspaceId: SYNTH_WS,
    provenanceOrigin: entry.provenanceOrigin as ProvenanceOrigin,
    sourceRefs: entry.sourceRefs,
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    linkCandidates: (entry.linkCandidates ?? []).map((c) => ({ ...c, workspaceId: SYNTH_WS })),
  };
}

/** A fake gbrain that drives resolveEntity by the recorded per-name resolution (err→withheld, []→stub, match→resolved). */
function buildGbrain(entry: SynthesisCorpusEntry): EntityGbrainReadPort {
  const byName = entry.gbrainByName ?? {};
  return {
    workspaceId: SYNTH_WS,
    findCandidates: (ref: EntityRef): Promise<Result<readonly EntityCandidate[], EntityReadFault>> => {
      const r = byName[ref.name];
      if (r === undefined || r.outcome === "create_stub") return Promise.resolve(ok([])); // no candidate ⇒ create_stub
      if (r.outcome === "withheld") return Promise.resolve(err({ code: "read_fault" })); // err ⇒ withheld
      // resolved: a candidate whose `title` faithful-matches the ref name ⇒ resolveEntity resolves to `resolvedPath`.
      const candidate: EntityCandidate = { path: r.resolvedPath ?? "", slug: "resolved-note", title: ref.name, workspaceId: SYNTH_WS };
      return Promise.resolve(ok([candidate]));
    },
  };
}

/** A fake section provider: notePath → its writer-owned region-id allowlist (empty when unknown). */
function buildSections(entry: SynthesisCorpusEntry): SynthesisSectionPort {
  return { describe: (path) => ({ generatedRegionIds: entry.sections[path] ?? [] }) };
}

/** Build the full SynthesisDeps for an entry — deterministic newPlanId (counter, no random). */
export function buildDeps(entry: SynthesisCorpusEntry): SynthesisDeps {
  let n = 0;
  return {
    gbrain: buildGbrain(entry),
    reason: { reason: () => Promise.resolve(entry.candidate) },
    sections: buildSections(entry),
    newPlanId: () => `${entry.id}-plan-${(n += 1)}`,
  };
}
