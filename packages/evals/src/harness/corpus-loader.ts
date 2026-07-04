// spec(§12/§18.1) — EVAL-1 corpus loader (task 12.1, REQ-T-001).
//
// Loads a VERSIONED, content-hashed corpus and refuses anything it cannot vouch
// for: an unversioned corpus, a content-hash mismatch, an entry-count mismatch,
// or a corpus below its declared floor (meeting-closeout >=20, retrieval >=30,
// leakage >=15 — the 12.2/12.3 floors). Reproducibility across runs is the point
// of EVAL-1, so an unverifiable corpus is a typed `Err`, never a best-effort load.
//
// `corpusContentHash` is a self-contained canonical SHA-256: object keys are
// recursively code-unit-sorted (array order preserved) so a differently-ORDERED
// but structurally-equal corpus yields the same hash across runs/machines. It is
// the ONE function used to both STAMP a manifest and VERIFY it — the corpus
// authoring tools (12.2/12.3) import it so stamp and check can never disagree.
//
// Pure + deterministic — no clock, no network, no randomness.
import { createHash } from "node:crypto";
import { ok, err, type Result } from "@sow/contracts";

export interface CorpusManifest {
  readonly corpusId: string;
  /** Non-empty version string; an unversioned corpus is rejected. */
  readonly version: string;
  /** `sha256:<hex>` over the canonical `{corpusId, version, entries}`. */
  readonly contentHash: string;
  /** Declared entry count; must equal `entries.length`. */
  readonly entryCount: number;
  /** Declared minimum size (the EVAL-1 floor for this corpus). */
  readonly floor: number;
}

export type CorpusLoadError =
  | { readonly code: "unversioned"; readonly message: string }
  | {
      readonly code: "hash_mismatch";
      readonly message: string;
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly code: "count_mismatch"; readonly message: string }
  | { readonly code: "below_floor"; readonly message: string };

export interface LoadedCorpus<E> {
  readonly manifest: CorpusManifest;
  readonly entries: readonly E[];
}

// Recursively canonicalize a JSON-ish value so structurally-equal payloads with
// differently-ORDERED object keys serialize identically. Objects → key-sorted
// (code-unit order, never locale-dependent). Arrays → order preserved (semantic).
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((el) => canonicalize(el));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = canonicalize(record[key]);
  }
  return out;
}

/**
 * The replay-stable digest of a corpus. Key ORDER (at any depth) never changes
 * the result; entry order, values, and shape all do. Returns `sha256:<hex>`.
 */
export function corpusContentHash(
  corpusId: string,
  version: string,
  entries: readonly unknown[],
): string {
  const preimage = JSON.stringify(canonicalize({ corpusId, version, entries }));
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

/**
 * Load + verify a corpus. Order of checks yields the most specific error:
 * unversioned → count mismatch → hash mismatch → below floor. The effective
 * floor is `max(manifest.floor, opts.expectedFloor)`.
 */
export function loadCorpus<E>(
  manifest: CorpusManifest,
  entries: readonly E[],
  opts?: { readonly expectedFloor?: number },
): Result<LoadedCorpus<E>, CorpusLoadError> {
  if (manifest.version.trim().length === 0) {
    return err({
      code: "unversioned",
      message: `corpus ${manifest.corpusId} has no version — refusing to load`,
    });
  }
  if (entries.length !== manifest.entryCount) {
    return err({
      code: "count_mismatch",
      message: `corpus ${manifest.corpusId}: manifest entryCount=${manifest.entryCount} but got ${entries.length} entries`,
    });
  }
  const actual = corpusContentHash(manifest.corpusId, manifest.version, entries);
  if (actual !== manifest.contentHash) {
    return err({
      code: "hash_mismatch",
      message: `corpus ${manifest.corpusId}: content hash mismatch`,
      expected: manifest.contentHash,
      actual,
    });
  }
  const floor = Math.max(manifest.floor, opts?.expectedFloor ?? 0);
  if (entries.length < floor) {
    return err({
      code: "below_floor",
      message: `corpus ${manifest.corpusId}: ${entries.length} entries below floor ${floor}`,
    });
  }
  return ok({ manifest, entries });
}
