// Install-doctor write-through one-writer POSTURE diagnosers (task 11.5, §13 / REQ-S-NEW-008 / safety rule 1).
// SAFETY-CRITICAL. These three checks enforce that the worker is the SOLE writer of the canonical vault + brain:
//   • vault_acl               — the worker is the sole OS write principal on the vault directory (filesystem ACL)
//   • gbrain_readonly_mount   — the brain is mounted READ-ONLY / immutable-snapshot at the canonical path
//   • stray_gbrain_process    — no write-capable gbrain process (serve/sync --install-cron/autopilot/jobs work/
//                               dream) is bound to a canonical brain
// FAIL CLOSED: only an EXPLICIT green probe resolves `ok`. A false/writable/mispointed/detected-stray state OR an
// absent/unknown/malformed probe ⇒ a DISTINCT `finding` (a writable/mispointed mount or a stray writer re-opens
// GO #1 — never a silent ok). The stray-process finding names the CLASSIFIED op label only (redaction-safe by
// construction — an unrecognized op is reported as "unrecognized-writer", never echoing raw args/secrets).
import type { DoctorCheckResult } from "@sow/contracts";
import { okResult, findingResult } from "./environment";
import { STRAY_GBRAIN_OPS } from "../probe-snapshot";
import type { VaultAclProbe, GbrainMountProbe, StrayGbrainProcessProbe, StrayGbrainProcess } from "../probe-snapshot";

export function diagnoseVaultAcl(p: VaultAclProbe | undefined): DoctorCheckResult {
  // ok ONLY on an explicit true — absent (null/undefined)/unknown ⇒ fail-closed finding. `!= null` makes the
  // diagnoser individually null-safe (surfaces its OWN variant, not the generic probe_error), independent of
  // runDoctor's safeCheck backstop.
  if (p != null && p.workerIsSoleWritePrincipal === true) return okResult("vault_acl");
  return findingResult("vault_acl", "vault_acl_not_worker_exclusive");
}

export function diagnoseGbrainMount(p: GbrainMountProbe | undefined): DoctorCheckResult {
  // ok ONLY when BOTH read-only AND canonically mounted — a writable OR mispointed OR absent mount ⇒ finding.
  if (p != null && p.readOnly === true && p.mountPointCanonical === true) return okResult("gbrain_readonly_mount");
  return findingResult("gbrain_readonly_mount", "gbrain_mount_writable_or_mispointed");
}

const KNOWN_STRAY_OPS: ReadonlySet<string> = new Set(STRAY_GBRAIN_OPS);

/**
 * Build a redaction-safe detail naming the DISTINCT classified op labels only. An op not in the closed
 * `STRAY_GBRAIN_OPS` set (a malformed probe) is reported as "unrecognized-writer" — never echoed. Dedup keeps the
 * detail bounded (≤ the 5 known labels + one placeholder) regardless of how many stray rows the probe carries.
 */
function strayDetail(procs: readonly StrayGbrainProcess[]): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const pr of procs) {
    const op = pr !== null && typeof pr === "object" ? pr.op : undefined;
    const label = typeof op === "string" && KNOWN_STRAY_OPS.has(op) ? op : "unrecognized-writer";
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return `detected gbrain writers: ${labels.join(", ")}`;
}

export function diagnoseStrayGbrainProcess(p: StrayGbrainProcessProbe | undefined): DoctorCheckResult {
  // Fail-closed on an absent (null/undefined)/malformed probe — we cannot confirm "no stray writer", so we must
  // assume one. `== null` (not `=== undefined`) makes this individually null-safe (surfaces its own variant).
  if (p == null || !Array.isArray(p.strayProcesses)) {
    return findingResult("stray_gbrain_process", "stray_gbrain_writer_detected");
  }
  if (p.strayProcesses.length === 0) return okResult("stray_gbrain_process");
  return findingResult("stray_gbrain_process", "stray_gbrain_writer_detected", strayDetail(p.strayProcesses));
}
