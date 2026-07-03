// Task 9.4b — the traversal-safe resolver for the packaged `app://sow` scheme.
//
// In prod the renderer is served from a custom privileged scheme (app://sow), not
// file:// — file:// has an opaque `null` origin (unusable with the worker's Origin
// allowlist) and broad filesystem semantics. The protocol handler maps each
// `app://sow/<path>` request to a file UNDER the built renderer root.
//
// SECURITY: the resolver MUST NOT let a request escape the root. It decodes the
// path, rejects NUL bytes + malformed encodings, normalizes, and then requires the
// result to be the root itself or strictly under `root + sep` — a `..` climb, a
// percent-encoded `..%2f`, or a shared-prefix sibling (`renderer-evil`) all fail
// closed to null (→ the handler answers 404).
import { join, normalize, sep } from "node:path";

/**
 * Resolve an `app://sow/<path>` request URL to an absolute file path under `root`,
 * or `null` if the URL is malformed or would escape `root`. The app root (`/`) and
 * any directory path (trailing `/`) resolve to that directory's `index.html`.
 * Pure; never throws.
 */
export function resolveAppRequest(requestUrl: string, root: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null; // NUL-byte injection

  let rel = decoded.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  const rootNorm = normalize(root);
  const full = normalize(join(rootNorm, rel));

  // Containment: the resolved path must be the root or strictly under `root + sep`.
  // The `+ sep` guard rejects a sibling that merely shares the root's string prefix
  // (e.g. `/app/out/renderer-evil` vs root `/app/out/renderer`).
  if (full !== rootNorm && !full.startsWith(rootNorm + sep)) return null;
  return full;
}
