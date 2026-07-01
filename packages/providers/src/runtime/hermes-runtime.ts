// @sow/providers — HermesRuntimeAdapter (§7 task 5.8, RT-1 / REQ-I-003).
//
// The AgentRuntimePort adapter over Hermes, driven as a ONE-SHOT CLI SUBPROCESS
// (the Phase-0 OQ-007 resolved surface, `docs/spikes/0.3-hermes-surface.md`):
//   hermes chat -q <prompt> -Q -t <readonly-toolset> -m <model> [--provider <p>]
//              --max-turns <N> [--safe-mode]
// spawned per job. It emits ONLY a candidate AgentResult — Hermes output is
// free-form text, ALWAYS candidate data, ajv-gated + validated downstream (5.5);
// it never reaches a write adapter directly (strict side-effect rule).
//
// ⚠ SECURITY INVARIANT (banked, LESSONS §1): an EMPTY `-t` silently falls back to
// the user's FULL configured toolset — INCLUDING mutating tools. So a read-only /
// untrusted-content (ING-7) run MUST pass an EXPLICIT, non-empty minimal toolset,
// NEVER empty. `buildHermesCommand` refuses to produce a command when the
// effective toolset is empty (→ typed tool_policy_violation) so the subprocess is
// never spawned with an empty `-t`. Untrusted jobs additionally launch with
// `--safe-mode` (strips injected AGENTS.md / memory / MCP — ING-7 isolation).
//
// Real Hermes I/O lives behind an INJECTED `HermesTransport`; this module is a
// PURE command-build + result-map surface. NEVER throws across the boundary (§16).
// Real conformance (0 mutating tools under the pinned toolset) is the eval path
// (5.10), not a unit test.
import type { Result, AgentJob, ContextRef } from "@sow/contracts";
import { ok, err, effectiveAllowedTools, isToolPolicyConsistent } from "@sow/contracts";
import type { AgentResult } from "../ports/agent-result";
import {
  runtimeError,
  type AgentRuntimePort,
  type RuntimeError,
} from "../ports/agent-runtime-port";
import {
  isAborted,
  abortedBeforeDispatch,
  cancelledResult,
  completedResult,
} from "./runtime-support";

/** The open runtime id this adapter implements (§7 two-port split). */
export const HERMES_RUNTIME_ID = "hermes" as const;

/** Exit code the OS/`timeout` reports for a SIGTERM'd subprocess (Phase-0 spike). */
export const HERMES_SIGTERM_EXIT_CODE = 124 as const;

/**
 * Adapter configuration. `renderPrompt` resolves the job's context refs into the
 * `-q` prompt string — INJECTED so raw-content resolution stays a caller/boundary
 * concern, out of this pure surface; the default renders REFERENCES ONLY (no raw
 * content inlined). `provider`/`maxTurns` map onto Hermes's `--provider`/`--max-turns`.
 */
export interface HermesRuntimeConfig {
  /** Hermes executable (default "hermes"). */
  readonly bin?: string;
  /** Hermes backend provider passed as `--provider` (e.g. "openrouter"). Omitted if unset. */
  readonly provider?: string;
  /** Turn cap → budget (`--max-turns`). Default 1 (one-shot). */
  readonly maxTurns?: number;
  /** Ref → prompt resolution. Default: reference-only, redaction-safe. */
  readonly renderPrompt?: (job: AgentJob) => string;
}

/** The built subprocess command. `bin` + `args` are what the transport spawns. */
export interface HermesCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

/** The raw subprocess outcome the transport returns on a completed spawn. */
export interface HermesProcessResult {
  /** 0 = ok; 124 = SIGTERM (timeout/cancel) → cancel-with-no-side-effect. */
  readonly exitCode: number;
  /** Final JSON on stdout under `-Q` (empty when killed mid-inference). */
  readonly stdout: string;
  /** Diagnostic stream (session id etc.) — NEVER logged raw (may carry content). */
  readonly stderr: string;
  readonly runtimeSeconds: number;
}

/** Transport-level spawn failure kinds — mapped by the adapter onto RuntimeErrorKind. */
export const HermesSpawnErrorKind = [
  "not_installed",
  "spawn_failed",
  "timeout",
  "killed",
] as const;
export type HermesSpawnErrorKind = (typeof HermesSpawnErrorKind)[number];

export interface HermesSpawnError {
  readonly kind: HermesSpawnErrorKind;
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * The injected boundary that spawns the real Hermes subprocess. Substituted by a
 * mock in tests. Returns a typed Result — never throws.
 */
export interface HermesTransport {
  spawn(
    cmd: HermesCommand,
    signal?: AbortSignal,
  ): Promise<Result<HermesProcessResult, HermesSpawnError>>;
}

// --- prompt (reference-only default; redaction-safe) ------------------------

function defaultRenderPrompt(job: AgentJob): string {
  const refs = job.contextRefs.map((r: ContextRef) => `${r.refKind}:${r.ref}`).join("\n");
  return `capability:${job.capability}\nrefs:\n${refs}`;
}

// --- command build (the tested security surface) ----------------------------

/**
 * Build the one-shot Hermes command from an AgentJob, or a typed error if the job
 * cannot be launched SAFELY. PURE. Enforces, in order:
 * - the providerRoute must be a `hermes` RUNTIME route (else invalid_job);
 * - defense-in-depth ING-7: an untrusted job must be read-only + tool-consistent;
 * - **the effective toolset must be NON-EMPTY** — the banked security invariant:
 *   an empty `-t` silently falls back to the full (mutating) config toolset, so an
 *   empty effective toolset is REFUSED here and the subprocess is never spawned.
 * Untrusted / raw-content jobs get `--safe-mode` (ING-7 isolation).
 */
export function buildHermesCommand(
  job: AgentJob,
  config: HermesRuntimeConfig = {},
): Result<HermesCommand, RuntimeError> {
  const route = job.providerRoute;
  if (!("runtime" in route) || route.runtime !== HERMES_RUNTIME_ID) {
    return err(runtimeError("invalid_job", `job route is not a ${HERMES_RUNTIME_ID} runtime route`));
  }
  if (!isToolPolicyConsistent(job.toolPolicy)) {
    return err(
      runtimeError("tool_policy_violation", "read_only ToolPolicy admits mutation (inconsistent)"),
    );
  }
  const untrusted = job.trustLevel === "untrusted";
  const readOnly = job.toolPolicy.mode === "read_only";
  // ING-7: untrusted content must run read-only / no mutating tools.
  if (untrusted && (!readOnly || job.toolPolicy.allowsMutating)) {
    return err(
      runtimeError(
        "tool_policy_violation",
        "untrusted (ING-7) job must run read_only with no mutating tools",
      ),
    );
  }

  const effective = effectiveAllowedTools(job.toolPolicy);
  // ⚠ THE banked invariant: empty `-t` ⇒ full mutating fallback. Refuse to spawn.
  if (effective.length === 0) {
    return err(
      runtimeError(
        "tool_policy_violation",
        "empty Hermes toolset would fall back to the full (mutating) config toolset; " +
          "a read-only/untrusted run MUST pass an explicit non-empty toolset",
      ),
    );
  }
  const toolset = effective.join(",");

  const bin = config.bin ?? "hermes";
  const model = route.model;
  const maxTurns = config.maxTurns ?? 1;
  const renderPrompt = config.renderPrompt ?? defaultRenderPrompt;
  const prompt = renderPrompt(job);

  const args: string[] = ["chat", "-q", prompt, "-Q", "-t", toolset, "-m", model];
  if (config.provider !== undefined) args.push("--provider", config.provider);
  args.push("--max-turns", String(maxTurns));
  // Hide autonomous jobs from user session lists (spike --source tool).
  args.push("--source", "tool");
  // ING-7 isolation: strip injected AGENTS.md / memory / MCP for untrusted or
  // raw-content runs so injected content cannot reach a configured mutating MCP.
  if (untrusted || job.carriesRawContent) args.push("--safe-mode");

  return ok({ bin, args });
}

// --- process-result mapping -------------------------------------------------

function mapSpawnError(e: HermesSpawnError): RuntimeError {
  switch (e.kind) {
    case "not_installed":
      // Spawn-if-present: Hermes absent → runtime_unavailable, held retryable so
      // the ProviderMatrix routes elsewhere (REQ-NF-005 clean-install-without-Hermes).
      return runtimeError("runtime_unavailable", e.message, { retryable: e.retryable ?? true });
    case "spawn_failed":
      return runtimeError("transport_error", e.message, { retryable: e.retryable ?? true });
    case "timeout":
      return runtimeError("timeout", e.message, { retryable: e.retryable ?? false });
    case "killed":
      return runtimeError("cancelled", e.message, { retryable: false });
  }
}

/**
 * Construct the HermesRuntimeAdapter over an injected transport. Never throws;
 * every outcome is a typed Result. Emits only a candidate AgentResult.
 */
export function createHermesRuntime(
  transport: HermesTransport,
  config: HermesRuntimeConfig = {},
): AgentRuntimePort {
  return {
    runtimeId: HERMES_RUNTIME_ID,
    async runJob(
      job: AgentJob,
      signal?: AbortSignal,
    ): Promise<Result<AgentResult, RuntimeError>> {
      // Cancel before we build/spawn → no side effect (COST-1).
      if (isAborted(signal)) return abortedBeforeDispatch();

      const cmd = buildHermesCommand(job, config);
      if (cmd.ok === false) return cmd;

      const spawned = await transport.spawn(cmd.value, signal);
      if (spawned.ok === false) return err(mapSpawnError(spawned.error));

      const proc = spawned.value;
      const runtimeSeconds = proc.runtimeSeconds;

      // A cooperative cancel mid-inference: SIGTERM (exit 124) or an aborted
      // signal → zero committable output crosses the schema gate (COST-1).
      if (isAborted(signal) || proc.exitCode === HERMES_SIGTERM_EXIT_CODE) {
        return ok(cancelledResult(runtimeSeconds));
      }
      if (proc.exitCode !== 0) {
        return err(
          runtimeError("transport_error", `hermes exited with code ${proc.exitCode}`),
        );
      }

      const raw = proc.stdout.trim();
      if (raw.length === 0) {
        return err(runtimeError("malformed_output", "hermes produced no output on exit 0"));
      }
      let candidateOutput: unknown;
      try {
        candidateOutput = JSON.parse(raw);
      } catch {
        return err(runtimeError("malformed_output", "hermes stdout was not parseable JSON"));
      }
      // Only a synthesized, content-free diagnostic reaches logs (stderr may carry
      // raw content and is never emitted at default level — §16).
      return ok(
        completedResult(candidateOutput, { runtimeSeconds }, [
          { level: "debug", message: `hermes run completed (exit 0, ${runtimeSeconds}s)` },
        ]),
      );
    },
  };
}
