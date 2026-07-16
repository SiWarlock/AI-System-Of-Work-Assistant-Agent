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
//   • BINARY PARSING (16.4/16.5) — a PDF (by the `%PDF-` magic) or any other NUL-binary is
//     handed to the injected `parseBinary` extractor (default: a lazy-imported `unpdf` /
//     PDF.js text extraction — pure-JS, offline, no native deps). A PDF's REAL text is
//     emitted; a non-PDF binary, or a PDF with no extractable text (image-only / encrypted),
//     returns `null` from the extractor ⇒ `unknown` reject (no garbage text emitted). The
//     structured summarize/enrichment of that text stays a downstream ModelProviderPort
//     concern; ONLY deterministic text extraction lives here. (Magic-sniff caveat: a plain
//     UTF-8 file whose first 5 bytes are literally `%PDF-` routes to the parse path — it IS
//     a PDF header — so a non-PDF text file with that exact prefix rejects rather than
//     reading as text. Pathological; accepted.) The EXTRACTED text is bounded by
//     {@link MAX_EXTRACTED_TEXT_CHARS} against compression-bomb amplification.
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
 * Defensive cap on EXTRACTED binary text (16.5). `MAX_FILE_BYTES` bounds the INPUT, but a
 * compression-bomb PDF (heavily-deflated text streams within the input cap) can amplify to a
 * far larger extracted string. Reject (fail-closed, mirroring the input cap) rather than let
 * an unbounded string flow downstream into candidate-data / SourceEnvelope.body / Markdown.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 32 * 1024 * 1024;

/**
 * A binary/document text extractor (16.5): given the raw bytes of a binary file (a PDF, or
 * any NUL-binary) + light hints, return its extracted plain text, or `null` when it has no
 * extractable text (a non-PDF binary, or a scanned/image-only/encrypted PDF). INJECTED so
 * the transport's routing + root-confinement stay deterministically testable with a fake;
 * production uses {@link defaultBinaryTextExtractor}. It should NEVER throw — a parse failure
 * is `null`, not an exception (and the transport defends the seam regardless).
 */
export type BinaryTextExtractor = (
  bytes: Uint8Array,
  hints: { readonly filename: string; readonly mime?: string },
) => Promise<string | null>;

/** True IFF the buffer begins with the `%PDF-` magic (a PDF, regardless of NUL content). */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

/**
 * The production default {@link BinaryTextExtractor}: deterministic PDF text extraction via
 * `unpdf` (a pure-JS, offline serverless build of PDF.js — no network, no native deps),
 * LAZY-imported so the module stays light + sandbox-safe until a binary is actually parsed.
 * ONLY PDFs are handled here (any other binary ⇒ `null`, rejected typed by the caller); a
 * malformed / image-only / encrypted PDF that yields no text also returns `null`. Never
 * throws (a parse fault becomes `null`).
 */
export const defaultBinaryTextExtractor: BinaryTextExtractor = async (bytes) => {
  if (!looksLikePdf(bytes)) return null; // not a PDF ⇒ no deterministic text path here
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    // SECURITY: pin `isEvalSupported: false` in OUR call rather than inheriting unpdf's
    // serverless default — closes the CVE-2024-4367-class eval-execution vector on this
    // UNTRUSTED-bytes seam explicitly, so a future unpdf default-flip or a local refactor
    // can't silently re-open it. Copy into a fresh Uint8Array — decouples pdf.js from a
    // Buffer's shared/pooled backing.
    const pdf = await getDocumentProxy(Uint8Array.from(bytes), { isEvalSupported: false });
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : typeof text === "string" ? text : "";
    return merged.trim().length > 0 ? merged : null;
  } catch {
    // A malformed / encrypted / unsupported PDF ⇒ no extractable text (never a throw).
    return null;
  }
};

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

/**
 * True IFF `realTarget` is the real root itself, or sits strictly under it. Exported
 * as the ONE authoritative root-confinement predicate (the arbitrary-file-read
 * boundary): a REAL-path prefix check with a `+ sep` guard against the `/vault` vs
 * `/vault-evil` sibling-prefix bypass. The C3b vault-watcher's pre-filter shares this
 * exact predicate (no duplicated safety check) while the transport below stays the
 * authoritative read-confinement guard. Callers pass REALPATH-resolved absolute paths.
 */
export function isContainedUnder(realRoot: string, realTarget: string): boolean {
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
  opts: { readonly maxBytes?: number; readonly parseBinary?: BinaryTextExtractor } = {},
): FileExtractTransport {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  // The binary/PDF extractor (16.5) — defaults to the real `unpdf`-backed one; tests inject
  // a deterministic fake. Runs ONLY on already-root-contained bytes (see below).
  const parseBinary = opts.parseBinary ?? defaultBinaryTextExtractor;
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
      // BINARY PARSING (16.5): a PDF (by `%PDF-` magic) or any NUL-binary is not UTF-8 text —
      // hand the ALREADY-ROOT-CONTAINED bytes (containment was asserted above) to the injected
      // extractor. The parse runs only on the resolved in-root `realTarget`, so it does NOT
      // widen the read surface; the `filename` hint is the resolved basename, never the raw
      // request. A PDF's real text is emitted; a non-PDF binary, or a PDF with no extractable
      // text (image-only / encrypted), returns `null` ⇒ typed reject (no garbage text).
      if (looksLikePdf(buf) || buf.includes(0)) {
        const extracted = await parseBinary(buf, {
          filename: basename(realTarget),
          ...(req.mime !== undefined ? { mime: req.mime } : {}),
        });
        if (typeof extracted === "string" && extracted.trim().length > 0) {
          // Bound the EXTRACTED text (compression-bomb amplification) before it flows
          // downstream — reject fail-closed, consistent with the input `maxBytes` cap.
          if (extracted.length > MAX_EXTRACTED_TEXT_CHARS) {
            return { ok: false, code: "unknown", message: "binary content: extracted text exceeds the cap" };
          }
          return { ok: true, file: { path: realTarget, filename: basename(realTarget), text: extracted } };
        }
        return { ok: false, code: "unknown", message: "binary content: no extractable text" };
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
