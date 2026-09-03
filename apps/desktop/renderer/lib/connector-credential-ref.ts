// Derive the Keychain ref a connector's write credential is stored at, from the workspace + vendor.
//
// ⛔⛔ THIS STRING MUST BE BYTE-IDENTICAL TO `writeSecretRef(target, workspaceId)` IN
// `@sow/integrations`. They are the two ends of one credential: this side decides where the user's
// pasted key is WRITTEN; that side decides where the write path LOOKS for it. A divergence is
// silent and permanent — the key is stored somewhere nothing ever reads, the UI reports success,
// and the failure only surfaces much later as an unauthenticated vendor call.
//
// It is a MIRROR rather than an import because the renderer does not depend on `@sow/integrations`
// (and should not — it would drag the whole write path into the UI bundle). Drift is caught NOT by
// this comment but by `test/renderer/connector-credential-ref-parity.test.ts`, which imports the
// real `writeSecretRef` (a test file, never bundled) and asserts equality across the full vendor set.
//
// ⚠ This exact class already bit once, on 2026-09-03: the first scoped ref used a THIRD path segment
// and no test compared it against the parser that had to accept it, so all 21 refs silently failed
// closed. Pure string agreement between packages is not self-evident and must be asserted.
import { KNOWN_CONNECTORS } from "./connector-catalog";

/**
 * `keychain://connector-write.<workspaceId>/<connectorId>` — two segments, because the resolver's
 * parser takes exactly two. The workspace rides in the SERVICE segment so a hyphenated id
 * (`employer-work`) stays unambiguous, and the two workspaces land in genuinely different
 * (service, account) pairs rather than merely different strings (safety rule 4).
 */
export function connectorCredentialRef(workspaceId: string, connectorId: string): string {
  return `keychain://connector-write.${workspaceId}/${connectorId}`;
}

/**
 * Whether this connector participates in the external-WRITE path at all.
 *
 * ⭐ NOT every connector does, and saying so matters: `granola` and `gmail` are read/ingest sources
 * with no write target, so a key stored for them is a credential slot the write path will never
 * consult. The surface uses this to avoid implying a capability that does not exist.
 */
export function isWriteTarget(connectorId: string): boolean {
  return (KNOWN_CONNECTORS as readonly string[]).includes(connectorId) && WRITE_TARGETS.has(connectorId);
}

/** The `TargetSystem` members that are also offered as connectors in this surface. */
const WRITE_TARGETS: ReadonlySet<string> = new Set([
  "drive",
  "calendar",
  "linear",
  "github",
  "asana",
  "todoist",
]);
