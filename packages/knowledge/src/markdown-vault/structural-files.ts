// Structural-file parity (§6 KN-12; 13.8d) — PURE builders that regenerate the vault's STRUCTURAL
// surfaces (the `index.md` catalog + the operation log) as KnowledgeWriter mutation primitives, NEVER
// as a direct/second writer (safety rule 1). The living vault "rewrites itself" on ingest: when notes
// change, the index's affected sections + the op-log are re-authored — but only ever as `NotePatch`
// mutations routed through KW. Structural writes target WRITER-OWNED regions only (kw:region/@generated
// on the vault-surface files) — never a `@user`/human region. Region ids are fixed marker-safe literals.
// PURE: no fs, no clock (the op-log date is injected), no throws.
import type { NotePatch } from "@sow/contracts";

/** One `- [[slug]] - desc` catalog entry in an index section. */
export interface IndexEntry {
  readonly slug: string;
  readonly desc?: string;
}

/** A named (writer-owned) section of `index.md` and its full entry set. */
export interface IndexSection {
  readonly regionId: string;
  readonly entries: readonly IndexEntry[];
}

const isSafeId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id !== "@user" && /^[^\s>]+$/.test(id);

/** Render an index section body: one `- [[slug]] - desc` line per entry (writer-owned @generated content). */
export function renderIndexEntries(entries: readonly IndexEntry[]): string {
  if (!Array.isArray(entries)) return "";
  return entries
    .filter((e): e is IndexEntry => e != null && typeof e.slug === "string" && e.slug.length > 0)
    .map((e) => (typeof e.desc === "string" && e.desc.length > 0 ? `- [[${e.slug}]] - ${e.desc}` : `- [[${e.slug}]]`))
    .join("\n");
}

/**
 * Per-section `NotePatch` regenerating ONLY the given (CHANGED) index sections — a minimal diff, KN-7-safe
 * (each targets a fixed writer-owned region id; unchanged sections are never touched). The CALLER passes
 * only the sections whose entry set changed this run. A marker-unsafe region id is dropped.
 */
export function buildIndexSectionPatches(indexPath: string, changed: readonly IndexSection[]): NotePatch[] {
  if (typeof indexPath !== "string" || indexPath.length === 0 || !Array.isArray(changed)) return [];
  const out: NotePatch[] = [];
  for (const s of changed) {
    if (s == null || !isSafeId(s.regionId)) continue;
    out.push({ path: indexPath, regionId: s.regionId, newBody: renderIndexEntries(s.entries) });
  }
  return out;
}

/** The op-log mutations for one run: a `Logs/<date>.md` day-log region + a `log.md` pointer, as KW patches. */
export interface OpLogMutations {
  readonly patches: readonly NotePatch[];
}

/**
 * Build the operation-log mutations for one ingest run: a `NotePatch` into the day log
 * `Logs/<date>.md` (a writer-owned region KW appends when absent) + a `log.md` pointer patch to the
 * latest day. Emitted as KW mutations (sole writer). `date` is INJECTED (pure — no clock).
 */
export function buildOpLogMutations(opts: {
  readonly date: string;
  readonly entry: string;
  readonly logsDir?: string;
  readonly pointerPath?: string;
  readonly regionId?: string;
}): OpLogMutations {
  const date = typeof opts?.date === "string" ? opts.date : "";
  const entry = typeof opts?.entry === "string" ? opts.entry : "";
  if (date.length === 0 || !/^[^\s>]+$/.test(date)) return { patches: [] }; // marker-safe date anchor required
  const logsDir = typeof opts.logsDir === "string" && opts.logsDir.length > 0 ? opts.logsDir : "Logs";
  const pointerPath = typeof opts.pointerPath === "string" && opts.pointerPath.length > 0 ? opts.pointerPath : "log.md";
  const regionId = isSafeId(opts.regionId) ? opts.regionId : "log";
  const dayPath = `${logsDir}/${date}.md`;
  return {
    patches: [
      { path: dayPath, regionId, newBody: entry },
      { path: pointerPath, regionId: "pointer", newBody: `Latest: [[${logsDir}/${date}]]` },
    ],
  };
}
