// @sow/integrations — read-only Obsidian-vault MCP tool surface (Phase-13 §13.4).
//
// A governed read-ONLY vault tool surface (shape (A): a read-tool-descriptor surface, NOT a
// cursor-paginated ConnectorPort — the 5 vault ops are named QUERY tools, not a paginated pull;
// the load-bearing property is "no MCP write path", not the ConnectorPort seam). It registers ONLY
// the 5 vault READ tools and does NOT register the 3 write tools (save_note/update_note/capture),
// so no MCP path can write canonical Markdown — KnowledgeWriter stays the provably-sole autonomous
// writer (safety rule 1 / KN-4 / KN-9). Mirrors the `copilot-tool-catalog` pattern: a FROZEN
// read-only descriptor set (`mutating:false` by construction) + a FAIL-SAFE registry (an unknown /
// unregistered / write id ⇒ rejected, mirroring `isMutatingCopilotTool`'s unknown⇒mutating default)
// + a read-only `invoke` that routes a REGISTERED read tool to an INJECTED faked transport and can
// never reach a write surface.
//
//   • safety rule 1 (one writer): no write tool registered; the fail-safe rejects a write/unknown id
//     BEFORE the transport, so a write never reaches the seam. The module holds NO write-surface
//     token (Lesson 12) — it structurally cannot write.
//   • safety rule 4 (workspace isolation): `config.workspaceId`/`vaultScope` are injected + passed
//     through (no inference); the read scope is a least-privilege READ scope.
//   • safety rule 6 (ING-7): a read-only, non-mutating tool posture over untrusted vault content.
//   • PURE + TOTAL (§16, Lesson 11): no clock/network/randomness of its own — the transport is
//     injected; the transport call + map run under ONE try, so a throw becomes a typed err.
//
// DORMANT: the real per-workspace MCP server + the MCP SDK wiring + real vault reads + routing the
// surface through the Connector Gateway (`runConnectorSync`) are named wiring follow-ups; the faked
// transport stands in and no real vault/MCP I/O happens here.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/**
 * One vault read tool: its id, `mutating:false` (a LITERAL type — a read tool literally cannot be
 * typed mutating, stronger than the copilot catalog's `boolean`), and a one-line description.
 */
export interface ObsidianVaultToolSpec {
  readonly id: string;
  readonly mutating: false;
  readonly description: string;
}

function readTool(id: string, description: string): ObsidianVaultToolSpec {
  // The annotation forces `mutating:false` as a literal (not widened to boolean); freeze so a runtime
  // `spec.mutating = true` (silently admitting a write tool) is impossible, not just compile-time.
  const spec: ObsidianVaultToolSpec = { id, mutating: false, description };
  return Object.freeze(spec);
}

/**
 * The frozen read-only tool set — the 5 vault READ tools. Frozen (array + each spec) so this
 * safety-critical classification source cannot be runtime-tampered to admit a write tool.
 */
export const OBSIDIAN_VAULT_READ_TOOLS: readonly ObsidianVaultToolSpec[] = Object.freeze([
  readTool("obsidian_search", "full-text + semantic search over the workspace vault notes"),
  readTool("read_note", "read one vault note's content by path"),
  readTool("backlinks", "list the notes that reference a given note (backlinks)"),
  readTool("vault_health", "read the vault index / health status"),
  readTool("validate_note", "validate a note's structure + frontmatter (read-only lint)"),
]);

/**
 * The 3 vault WRITE tool ids that are DELIBERATELY NOT registered (KN-4/KN-9 — no MCP write path).
 * Frozen; used by the exclusion guarantee (never registered, never invokable).
 */
export const OBSIDIAN_VAULT_WRITE_TOOL_IDS: readonly string[] = Object.freeze([
  "save_note",
  "update_note",
  "capture",
]);

/** Injected per-workspace config — the isolation binding + the least-privilege read scope. Passed through, never inferred. */
export interface ObsidianVaultConfig {
  readonly workspaceId: string;
  readonly vaultScope: string;
}

/** A read-tool invocation — an open `args` payload (no invented per-tool schema; the real MCP server firms these up). */
export interface VaultReadCall {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

/** The injected transport's closed result: an open read payload OR a typed failure. */
export type VaultReadTransportResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly code: "unreachable" | "unknown"; readonly message: string };

/** The injected read transport (a real per-workspace MCP server in production; a fake in tests). */
export type ObsidianVaultTransport = (call: VaultReadCall) => Promise<VaultReadTransportResult>;

/** A successful read — the tool that ran + its open faked payload. */
export interface VaultReadResult {
  readonly toolId: string;
  readonly payload: Record<string, unknown>;
}

/** Closed read-error set (§16 — enumerable). `not_registered` = the fail-safe rejection (write/unknown). */
export interface VaultReadError {
  readonly code: "not_registered" | "unreachable" | "unknown";
  readonly message: string;
}

/** The read-only vault connector surface — registered read set + fail-safe registry + read-only invoke. */
export interface ObsidianVaultReadConnector {
  readonly workspaceId: string;
  /** The 5 registered read tool ids. */
  registeredToolIds(): readonly string[];
  /** Fail-safe: true IFF `id` is a registered read tool — unknown / write / unregistered ⇒ false. */
  isRegisteredReadTool(id: string): boolean;
  /** The least-privilege READ scope handed to the transport (never a write/mutate scope). */
  readScope(): string;
  /** Route a REGISTERED read tool to the injected transport; a write/unknown id ⇒ typed err, no transport call, no write. Never throws. */
  invoke(call: VaultReadCall): Promise<Result<VaultReadResult, VaultReadError>>;
}

/**
 * Build the read-only vault connector over an injected transport. Registers ONLY the 5 read tools;
 * the fail-safe registry rejects any other id; `invoke` rejects a non-registered id BEFORE touching
 * the transport (so a write/unknown tool never reaches the seam) and runs the transport call + map
 * under one try (never throws). `config.workspaceId`/`vaultScope` are passed through, never inferred.
 */
export function createObsidianVaultReadConnector(
  transport: ObsidianVaultTransport,
  config: ObsidianVaultConfig,
): ObsidianVaultReadConnector {
  const registered: ReadonlySet<string> = new Set(OBSIDIAN_VAULT_READ_TOOLS.map((t) => t.id));
  return {
    workspaceId: config.workspaceId,
    registeredToolIds(): readonly string[] {
      return OBSIDIAN_VAULT_READ_TOOLS.map((t) => t.id);
    },
    isRegisteredReadTool(id: string): boolean {
      return registered.has(id);
    },
    readScope(): string {
      return config.vaultScope;
    },
    async invoke(call: VaultReadCall): Promise<Result<VaultReadResult, VaultReadError>> {
      // TOTAL never-throws (§16, Lesson 11): the WHOLE body — the `call.toolId` read, the fail-safe
      // membership check, the transport call, and the map — runs under ONE try, so even a malformed
      // `call` (null / a throwing `toolId` getter) resolves to a typed err, never a rejected promise.
      try {
        // FAIL-SAFE (mirror isMutatingCopilotTool unknown⇒mutating): reject any id not in the frozen
        // registered read set BEFORE the transport — a write / unknown / unregistered tool never
        // reaches the seam, so there is no write path (safety rule 1).
        if (!registered.has(call.toolId)) {
          return err({ code: "not_registered", message: `tool '${call.toolId}' is not a registered read tool` });
        }
        const result = await transport(call);
        if (!result.ok) {
          return err({ code: result.code, message: result.message });
        }
        return ok({ toolId: call.toolId, payload: result.payload });
      } catch (e) {
        return err({ code: "unknown", message: e instanceof Error ? e.message : "transport threw" });
      }
    },
  };
}
