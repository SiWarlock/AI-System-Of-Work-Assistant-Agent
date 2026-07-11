// @sow/integrations — the REAL ROOT-confined node:fs file-read transport (make-it-real C2).
//
// The FIRST real disk I/O of the arc. It supplies the REAL FileExtractTransport behind
// the emit-only `extractFileSource` adapter (file-source.ts): read ONE local UTF-8 text
// file under an allowed root and hand its bytes back as an ExtractedFile.
//
// SAFETY CRUX — ROOT CONFINEMENT (arbitrary-file-read containment):
//   Resolve BOTH the root and the requested target to a REAL absolute path (fs.realpath,
//   which follows every symbolic link), then assert the real target IS the real root itself or
//   sits strictly under `realRoot + sep` — a prefix check on the RESOLVED real paths, NOT
//   the raw strings. This defeats `../` traversal, an absolute path outside root, and a
//   symbolic link whose realpath escapes root. Containment is asserted BEFORE any byte is read,
//   and we read the RESOLVED `realTarget` (never the raw request) to shrink the check→read
//   TOCTOU window. The `+ sep` guard kills the classic `/vault` vs `/vault-evil`
//   sibling-prefix bypass. RESIDUALS (out of the single-user local-desktop threat model,
//   both requiring pre-existing in-root WRITE access an attacker would already need): a
//   HARDLINK inside root to an outside file (its realpath stays under root, so it passes),
//   and the realpath→readFile TOCTOU (a swap of an intermediate dir after resolution) —
//   fully closing either needs openat(O_NOFOLLOW), unavailable in fs/promises.
//
// Other guards:
//   • BOUNDED READ — a file whose size exceeds `maxBytes` (default {@link MAX_FILE_BYTES},
//     ample for a Markdown/text vault) is rejected `unknown`, never read into an unbounded
//     buffer (a defensive robustness cap; the size is read from stat before the read).
//   • TEXT-ONLY — a NUL byte in the buffer ⇒ binary ⇒ `unknown` (no garbage text emitted);
//     PDF/doc parsing stays a deferred downstream (ModelProviderPort) concern.
//   • FAIL CLOSED (§16) — a missing file (ENOENT), a non-file (a directory), a bad/missing
//     root, or ANY thrown fs error becomes a typed FileExtractResult; the transport NEVER
//     throws across the seam. Emptiness is NOT decided here — the transport returns the
//     (possibly empty) text and the adapter fails an empty extraction closed as
//     `empty_content`.
//
// LOCAL-ONLY: a single local disk read. No network, no cloud, no external write, no vault
// write. This module uses `node:fs`; it is DELIBERATELY NOT re-exported from the package
// barrel, so `node:fs` never enters the `@sow/integrations` barrel graph and can never be
// pulled into the Temporal workflow sandbox bundle (sandbox-safe BY CONSTRUCTION, not via
// the bundler stub). Consumed only deep-import + composition/activity-side (in C2 only the
// deep-import tests drive it; the always-on capture wiring lands in C3) — never sandbox-side.
import { realpath, stat, readFile } from "node:fs/promises";
import { resolve, basename, sep } from "node:path";
import type { FileExtractResult, FileExtractTransport } from "./file-source";

/**
 * The default maximum file size the transport will read (10 MiB). Ample for a
 * Markdown/text note vault; a larger file is rejected `unknown` rather than read into an
 * unbounded buffer. Override per transport via `createFileReadTransport(root, { maxBytes })`.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The fs errno code (e.g. "ENOENT" / "EACCES" / "ELOOP") off a thrown fs error, when
 * present — carried in the typed fault message for observability WITHOUT echoing the
 * absolute filesystem path the raw `e.message` would leak across the seam.
 */
function errnoCode(e: unknown): string | undefined {
  if (e !== null && typeof e === "object" && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** True IFF `realTarget` is the real root itself, or sits strictly under it. */
function isContainedUnder(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true;
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realTarget.startsWith(rootWithSep);
}

/**
 * Build a REAL, ROOT-confined {@link FileExtractTransport} over `node:fs`. Every read is
 * confined to `root` by realpath containment (see the module header); a path escaping the
 * root, a missing/non-file target, an oversized file, or binary content is a typed reject.
 * Never throws (§16).
 */
export function createFileReadTransport(
  root: string,
  opts: { readonly maxBytes?: number } = {},
): FileExtractTransport {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  return async (req): Promise<FileExtractResult> => {
    try {
      // Resolve the root to a REAL absolute path. A missing / not-a-directory root throws
      // here → caught below → every read fails CLOSED as unreachable.
      const realRoot = await realpath(resolve(root));
      // Resolve the request against the real root: a relative path joins under root, an
      // absolute path wins (and then fails containment). realpath follows EVERY symbolic link in
      // the chain and throws ENOENT for a missing target.
      const realTarget = await realpath(resolve(realRoot, req.path));
      if (!isContainedUnder(realRoot, realTarget)) {
        return { ok: false, code: "unreachable", message: "path resolves outside the allowed root" };
      }
      // Confine to a regular file (a directory / socket / device is not a readable source).
      const info = await stat(realTarget);
      if (!info.isFile()) {
        return { ok: false, code: "unreachable", message: "target is not a regular file" };
      }
      // Bounded read — never pull an unbounded buffer at the real-I/O boundary.
      if (info.size > maxBytes) {
        return { ok: false, code: "unknown", message: `file exceeds the ${maxBytes}-byte read cap` };
      }
      // Read the RESOLVED realTarget (not the raw request) — shrinks the check→read TOCTOU.
      const buf = await readFile(realTarget);
      // Text-only honesty: a NUL byte ⇒ binary ⇒ do NOT emit garbage text.
      if (buf.includes(0)) {
        return { ok: false, code: "unknown", message: "binary (non-UTF-8) content" };
      }
      const text = buf.toString("utf8");
      return {
        ok: true,
        file: { path: realTarget, filename: basename(realTarget), text },
      };
    } catch (e) {
      // ENOENT / EACCES / EISDIR / ELOOP / ENOTDIR / a bad root / any thrown fs error →
      // fail CLOSED as unreachable. The transport NEVER throws across the seam (§16). The
      // message carries ONLY the errno code (no absolute path — the raw e.message would
      // leak one across the seam toward logs/UI).
      const code = errnoCode(e);
      return {
        ok: false,
        code: "unreachable",
        message: code !== undefined ? `file unreachable (${code})` : "file unreachable",
      };
    }
  };
}
