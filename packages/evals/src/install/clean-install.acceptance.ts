// spec(§12 · §13 clean-install/doctor · REQ-NF-005 · REQ-I-002/003 · §7 DoD) — task 11.7.
//
// The clean-install acceptance harness. Exercises the REAL install machinery (never a
// simulation — evals CONSUMES the worker's exported surface, it never edits it, mirroring the
// same discipline `doctor-prereqs.test.ts` documents) against an ISOLATED root (see
// `./fixtures/isolated-root.ts`), so a run proves the documented install path without a
// pre-existing `~/.sow`, brain, or config. "Clean environment" does NOT mean a fresh Mac — see
// the fixture's own doc comment for the exact isolation boundary.
//
// ⛔ OWNER-GATED §ARM-GBRAIN — this harness NEVER arms anything: `config/gbrain.pin` is
// READ-only-copied by the fixture (never written back, never the real file); every gbrain call
// made here is a read-only `--version`/`doctor --json` probe (never `serve`/`dream`/`autopilot`);
// `write_through_enabled` is never touched. Where a leg would require a real arming crossing to
// go further, it is built and left SKIPPED-WITH-REASON rather than taking the crossing.
//
// Three legs, each independently gated (or not) and independently REPORTED — a skip is always
// visible as `{kind:"skipped", reason}`, never a silent no-op (a suite that asserts around a gap
// is worse than one that names it):
//
//   1. `runIsolatedPrerequisiteDoctorLeg` — the REAL production install-doctor composition root
//      (`runInstallDoctor`, apps/worker/src/install/doctor-cli.ts) over the REAL local `execFile`/
//      loopback-bind adapters, pointed at the isolated vault. SOW_DOCTOR_REAL-gated — mirrors
//      apps/worker's own convention EXACTLY (its probe-collectors/doctor-cli tests use the same
//      flag) so the default `@sow/evals` suite never shells out or opens a socket.
//
//   2. `runBootToServingLeg` — the REAL `bootWorker` (apps/worker/src/boot.ts) against the
//      isolated `dbPath`/`vaultRoot`, with `gbrainStartupVerify.pinPath` pointed at the isolated
//      pin copy. A REAL sqlite file that does not exist until this call exercises 11.2's genesis-
//      migration-first-run; the REAL installed gbrain probed against the isolated pin copy
//      exercises 11.3's version-pin verify; and — as of `68ec73c9` (landed concurrently with this
//      slice, in the worker track's own territory) — `bootWorker` now calls
//      `acquireSingleOwnerLock` BEFORE the store opens, so this leg ALSO observes a real 11.1
//      acquisition (`lockAcquiredAtBoot`) over the isolated dbPath — all three inside the SAME
//      real boot, because that is literally what "post-install the boot sequence reaches a
//      serving state" means (§13: "the worker ... opens the operational SQLite by default").
//      SOW_API-gated — mirrors apps/worker/test/support/apiGate.ts EXACTLY (opens one loopback
//      port).
//
//   3. `runSingleOwnerLockLeg` — the REAL `acquireSingleOwnerLock` run IN ISOLATION over the
//      isolated lockfile path (a SEPARATE path from the one `bootWorker` derives from its own
//      `dbPath` — leg 2 above observes the boot-bound acquisition; this leg pins the primitive
//      itself, deterministically, with no env gate needed). What this leg does NOT and cannot
//      prove: `DOCTOR_CHECK_IDS` (a closed enum owned by `packages/contracts`) still has no
//      `single_owner_lock` member, so the install-doctor itself (leg 1) never reports a lock
//      finding even on a genuine refusal — that gap is named explicitly in {@link KNOWN_GAPS},
//      never asserted around.
//
// Depends: 11.1-11.6 per the plan's own `Depends:` line. 11.1's boot-caller gap CLOSED live
// during this slice (`68ec73c9`, worker track) — re-verified before writing this file, per the
// house discipline of re-deriving a claim from current source rather than trusting a stale one.
// 11.1's doctor-check gap and 11.6 (gbrain subprocess spawn) remain PARTIAL — this harness fails
// HONESTLY on those (there is no leg for a supervised gbrain subprocess, because nothing in the
// install path spawns one to exercise) rather than asserting around them.
import { createServer } from "node:net";
import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import type { AppConfig } from "@sow/contracts";
import { createLocalCommandRunner, createLoopbackBindProbe } from "@sow/worker/install/probe-adapters";
import { runInstallDoctor } from "@sow/worker/install/doctor-cli";
import { acquireSingleOwnerLock } from "@sow/worker/install/lock/singleOwnerLock";
import {
  diagnoseSingleOwnerLock,
  type SingleOwnerLockCheckResult,
} from "@sow/worker/install/lock/singleOwnerLockDoctorCheck";
import { bootWorker } from "@sow/worker/boot";
import type { WorkerOriginAllowlist } from "@sow/worker/api/auth/originAllowlist";
import type { TriageDispatchFn } from "@sow/worker/api/adapters/commands";
import type { DispatchApprovalFn } from "@sow/worker/api/procedures/commands";
import { mintSessionToken } from "@sow/policy";
import { createIsolatedInstallRoot, type IsolatedInstallRoot } from "./fixtures/isolated-root";

export type { IsolatedInstallRoot };

/** A leg that did not run — always carries a reason a human/CI can read, never a bare boolean. */
export interface SkippedLegResult {
  readonly kind: "skipped";
  readonly reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Leg 1 — the real prerequisite/security/posture doctor over the isolated root
// ─────────────────────────────────────────────────────────────────────────

export interface PrerequisiteDoctorLegResult {
  readonly kind: "ran";
  readonly rendered: string;
  readonly exitCode: number;
}

/** Binds an ephemeral loopback port, releases it immediately, and returns the port number — a
 *  real, positive-control target for the doctor's loopback-ports probe (never a hardcoded guess
 *  that could collide with something already running on this machine). */
function getEphemeralLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolvePromise(port));
    });
  });
}

/**
 * Runs the REAL production install-doctor (`runInstallDoctor`) over REAL local adapters,
 * pointed at the isolated vault/db. SOW_DOCTOR_REAL-gated (apps/worker's own convention) — the
 * default `@sow/evals` suite never shells out or binds a socket.
 */
export async function runIsolatedPrerequisiteDoctorLeg(
  root: IsolatedInstallRoot,
): Promise<PrerequisiteDoctorLegResult | SkippedLegResult> {
  if (process.env.SOW_DOCTOR_REAL !== "1") {
    return {
      kind: "skipped",
      reason:
        "SOW_DOCTOR_REAL!=1 — this leg shells out to local Node/pnpm/git/fdesetup/security and binds a " +
        "real loopback port; the default suite never does either (mirrors apps/worker's own SOW_DOCTOR_REAL " +
        "convention, e.g. apps/worker/test/install/probe-collectors.test.ts). Set SOW_DOCTOR_REAL=1 to run it.",
    };
  }

  const port = await getEphemeralLoopbackPort();
  const config: AppConfig = {
    operationalDbPath: root.dbPath,
    apiPort: port,
    vaultRootPaths: { "clean-install-acceptance": root.vaultDir },
  };
  const rendered: string[] = [];
  const exitCode = await runInstallDoctor({
    config,
    run: createLocalCommandRunner(),
    bindLoopback: createLoopbackBindProbe(),
    write: (out: string) => rendered.push(out),
    workerPrincipal: userInfo().username,
    // No real gbrain-mount/vault exists at the isolated path — the posture probes fail-close
    // honestly on that absence (finding/degraded), which is the CORRECT behavior for a genuinely
    // fresh install with no prior brain, not a defect in this harness.
    canonicalBrainPath: root.vaultDir,
    repoDir: root.vaultDir,
    localBackupAccepted: false,
  });

  return { kind: "ran", rendered: rendered.join("\n"), exitCode };
}

// ─────────────────────────────────────────────────────────────────────────
// Leg 2 — the real bootWorker, exercising 11.2 (migration first-run) + 11.3 (gbrain pin verify)
// ─────────────────────────────────────────────────────────────────────────

export interface BootToServingLegResult {
  readonly kind: "ran";
  readonly apiPort: number;
  readonly dbFileCreated: boolean;
  readonly temporalDegraded: boolean;
  readonly temporalDegradeCode?: string;
  readonly gbrainPinOutcome: "serving" | "degraded";
  readonly gbrainPinHealthItemIds: readonly string[];
  /** 11.1 — true iff `bootWorker`'s real `acquireSingleOwnerLock` call succeeded (no
   *  `single-owner-lock:not-held` HealthItem was minted). A fresh isolated root always starts
   *  with no lock held, so `true` is the expected outcome here. */
  readonly lockAcquiredAtBoot: boolean;
}

/** A deterministic, non-secret, in-process-only session token — never printed, logged, or
 *  persisted (rule 7); it authenticates nothing outside this harness's own ephemeral API server. */
function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}

async function waitForGbrainPinHealthItem(
  list: () => Promise<readonly { readonly id: string }[]>,
  timeoutMs: number,
): Promise<readonly { readonly id: string }[]> {
  const deadline = Date.now() + timeoutMs;
  // The startup verify is fired `void`-style (best-effort, §16) inside bootWorker, so it may not
  // have landed yet the instant boot resolves. Poll briefly rather than a flat sleep.
  for (;;) {
    const items = (await list()).filter((h) => h.id.startsWith("gbrain-version-pin:"));
    if (items.length > 0 || Date.now() >= deadline) return items;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Runs the REAL `bootWorker` against the isolated root, then closes it. SOW_API-gated (mirrors
 * apps/worker/test/support/apiGate.ts EXACTLY) — the default suite never opens a socket.
 */
export async function runBootToServingLeg(
  root: IsolatedInstallRoot,
): Promise<BootToServingLegResult | SkippedLegResult> {
  if (process.env.SOW_API !== "1") {
    return {
      kind: "skipped",
      reason:
        "SOW_API!=1 — this leg binds a real loopback port via bootWorker's startApiServer; the default " +
        "suite never opens a socket (mirrors apps/worker/test/support/apiGate.ts EXACTLY). Set SOW_API=1 to run it.",
    };
  }

  const token = mintSessionToken(fixedRng(0xc1));
  const allowlist: WorkerOriginAllowlist = { origins: ["app://sow"], hosts: ["127.0.0.1:0"] };
  const noopTriage: TriageDispatchFn = (input) =>
    Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } });
  const noopApprovalDispatch: DispatchApprovalFn = () => Promise.resolve({ ok: true, value: undefined });

  const booted = await bootWorker({
    sessionToken: token,
    allowlist,
    triageDispatch: noopTriage,
    dispatchApproval: noopApprovalDispatch,
    apiPort: 0, // ephemeral — this harness never routes a real request through the allowlist
    dbPath: root.dbPath, // a REAL sqlite file that does not exist yet — 11.2's genesis migration
    vaultRoot: root.vaultDir, // the isolated vault, never the developer's own
    gbrainStartupVerify: { pinPath: root.pinPath }, // the isolated pin copy, real gbrain probe — 11.3
  });

  try {
    const apiPort = booted.api.port;
    const dbFileCreated = await stat(root.dbPath)
      .then((s) => s.size > 0)
      .catch(() => false);

    const connectResult = await booted.connectTemporal();
    const temporalDegraded = !connectResult.ok;
    const temporalDegradeCode = !connectResult.ok ? connectResult.error.code : undefined;

    const pinItems = await waitForGbrainPinHealthItem(() => booted.backends.healthItems.list(), 2000);

    // 11.1 — bootWorker's real acquireSingleOwnerLock call ran synchronously BEFORE this leg
    // could observe anything (it happens before `assembleBackends`, so by the time `booted`
    // exists the outcome is already settled) — a refusal/fault mints a
    // `single-owner-lock:not-held`-auditRef HealthItem immediately, no polling needed.
    const allItems = await booted.backends.healthItems.list();
    const lockAcquiredAtBoot = !allItems.some((h) => h.auditRef === "single-owner-lock:not-held");

    return {
      kind: "ran",
      apiPort,
      dbFileCreated,
      temporalDegraded,
      temporalDegradeCode,
      gbrainPinOutcome: pinItems.length > 0 ? "degraded" : "serving",
      gbrainPinHealthItemIds: pinItems.map((h) => h.id),
      lockAcquiredAtBoot,
    };
  } finally {
    await booted.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Leg 3 — the single-owner-lock MECHANISM, in isolation (11.1 — the primitive, not the boot path)
// ─────────────────────────────────────────────────────────────────────────

export interface SingleOwnerLockLegResult {
  readonly kind: "ran";
  readonly acquired: boolean;
  readonly secondAcquireRefused: boolean;
  readonly diagnosis: SingleOwnerLockCheckResult;
  /** ALWAYS false — THIS leg runs the primitive over an isolated lockfile path independent of
   *  `bootWorker`; leg 2's `lockAcquiredAtBoot` is the field that observes the real boot-bound
   *  acquisition (bound live at `68ec73c9`, worker track). */
  readonly boundAtBoot: false;
  readonly gapNote: string;
}

// ⛔ CORRECTED 2026-08-28. This note described the OPPOSITE of the shipped behaviour for three days,
// and it was stale in the reassuring direction twice over — it said the check was missing (it is not)
// while the real defect was that the check was present and permanently WRONG.
const SINGLE_OWNER_LOCK_GAP_NOTE =
  "task 11.1: bootWorker calls acquireSingleOwnerLock as of `68ec73c9` (leg 2's lockAcquiredAtBoot " +
  "observes it for real). DOCTOR_CHECK_IDS gained its single_owner_lock member at `eed76756` " +
  "(2026-08-25) and runDoctor wires the check — this note previously said otherwise and was stale. " +
  "The real gap that followed: the standalone sow-doctor CLI never supplied the probe, so the " +
  "fail-closed diagnoser reported single_owner_lock_not_held on EVERY run and exited 1 even on a " +
  "healthy machine. Fixed by the runDoctor `lockObservable: false` scope — a standalone process " +
  "reports single_owner_lock_not_observable/degraded rather than asserting a verdict it cannot take. " +
  "This leg still exercises the lock MECHANISM (acquireSingleOwnerLock + diagnoseSingleOwnerLock) " +
  "over its OWN isolated lockfile path, independent of boot — it complements leg 2 rather than " +
  "substituting for it.";

/** Runs the REAL `acquireSingleOwnerLock` over the isolated lockfile path, in-process only —
 *  pure fs, no shell-out, no socket, no env gate needed. Always releases before returning. */
export function runSingleOwnerLockLeg(root: IsolatedInstallRoot): SingleOwnerLockLegResult {
  const first = acquireSingleOwnerLock(root.lockPath);
  // A second acquire attempt from the SAME process, while the first is still held, must be
  // physically refused (the OS-atomic O_CREAT|O_EXCL create) — the real GO-#1 guarantee.
  const second = acquireSingleOwnerLock(root.lockPath);
  const secondAcquireRefused = !second.ok;
  if (second.ok) second.release();

  const diagnosis = diagnoseSingleOwnerLock(
    first.ok ? { acquired: true } : { acquired: false, holderPid: first.holderPid },
  );
  if (first.ok) first.release();

  return {
    kind: "ran",
    acquired: first.ok,
    secondAcquireRefused,
    diagnosis,
    boundAtBoot: false,
    gapNote: SINGLE_OWNER_LOCK_GAP_NOTE,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level orchestration
// ─────────────────────────────────────────────────────────────────────────

/** The precise, named gaps this harness cannot yet close — read alongside every run, never
 *  silently absorbed into a passing report (§7 DoD — an acceptance suite must not falsely
 *  certify capability it has not proven). */
export const KNOWN_GAPS: readonly string[] = [
  "11.1: bootWorker DOES acquire the single-owner lock at boot (bound live at `68ec73c9`) AND, as " +
    "of task 24.1, that lock is now a PHYSICALLY-ENFORCED write fence: boot builds a per-commit " +
    "probe (install/lock/writeFenceProbe.ts) from the real acquire outcome, threads it through " +
    "ProofSpineParams.writeFence into KnowledgeWriterDeps, and atomicCommit REFUSES the commit " +
    "with `write_fence_breached` before staging a byte when the fence is down. What remains open " +
    "here is narrower and named: (a) `workerIsSoleVaultWriter` is a STATED fact, not a probed one " +
    "— no filesystem-ACL prober exists in this repo; and (b) the CONTINUOUS stray-writer sweep " +
    "(a ps/lsof scan feeding scanForStrayWriters) does not exist, so an empty process set is " +
    "passed and a stray write-capable gbrain process is not yet DETECTED. The lock half is " +
    "enforced; those two are not.",
  "11.6: no gbrain subprocess spawn is wired into bootWorker/boot.ts — createGbrainServeSupervisor " +
    "(apps/worker/src/gbrainServeSupervisor.ts) is never invoked from the install/boot path, so this " +
    "harness cannot exercise a supervised `gbrain serve` subprocess as part of the install.",
  "No provider runtime/capability matrix is configured or exercised by this harness's bootWorker " +
    "call, so REQ-I-002/003's '>=1 conformant provider for the exercised capability' clause is NOT " +
    "proven here — that needs a real provider matrix + job dispatch, outside this package's territory " +
    "(packages/providers, packages/policy) and deferred to a follow-up slice.",
  "The REQ-NF-004 loopback-only audit covers only the worker API port this harness's own bootWorker " +
    "call opens; Temporal and gbrain are not independently network-audited here (Temporal degrades " +
    "cleanly in this environment rather than connecting; gbrain is probed read-only, never bound as " +
    "a listening service by this harness).",
  "A genuinely pristine host (a first-run macOS Keychain consent prompt, a from-scratch " +
    "Node/pnpm/gbrain toolchain) cannot be simulated in-process — this harness isolates STATE " +
    "(vault/db/config), not the operating system.",
];

export interface CleanInstallAcceptanceResult {
  readonly isolatedRoot: string;
  readonly prerequisiteDoctor: PrerequisiteDoctorLegResult | SkippedLegResult;
  readonly bootToServing: BootToServingLegResult | SkippedLegResult;
  readonly singleOwnerLock: SingleOwnerLockLegResult;
  readonly knownGaps: readonly string[];
}

/** Runs all three legs against a fresh isolated root, then tears the root down unconditionally. */
export async function runCleanInstallAcceptance(): Promise<CleanInstallAcceptanceResult> {
  const root = await createIsolatedInstallRoot();
  try {
    const prerequisiteDoctor = await runIsolatedPrerequisiteDoctorLeg(root);
    const bootToServing = await runBootToServingLeg(root);
    const singleOwnerLock = runSingleOwnerLockLeg(root);
    return {
      isolatedRoot: root.root,
      prerequisiteDoctor,
      bootToServing,
      singleOwnerLock,
      knownGaps: KNOWN_GAPS,
    };
  } finally {
    await root.cleanup();
  }
}
