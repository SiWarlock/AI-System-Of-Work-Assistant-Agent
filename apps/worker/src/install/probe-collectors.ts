// Install-doctor REAL prerequisite-probe collectors (task 11.5-a, §13).
//
// The first Phase-11 real-I/O slice: `collectPrerequisiteProbes` is a PURE data-mapper over
// two INJECTED ports (a local-command exec + a loopback bind) that fills FIVE ProbeSnapshot
// fields (nodePnpm / temporalStartable / gbrainStartable / gitRemotes / loopbackPorts) the
// already-built pure `runDoctor` engine consumes. Same shape as C2/C3a: pure core + injected
// port + a thin real adapter (probe-adapters.ts).
//
// Invariants:
//   • NEVER THROWS (§16) — every sub-probe runs its injected check under a TOTAL guard; a
//     missing binary, a non-zero exit, a timeout, a malformed output, or a thrown port all
//     fold to the probe's ASSUME-WORST shape — never an uncaught throw.
//   • FAIL-CLOSED (Lesson 8) — a fault is the assume-worst value (unsatisfied / not startable
//     / no remote / port occupied), NEVER a fabricated "ok". The pure diagnosers own the
//     status mapping (temporal/gbrain → tolerated `degraded`; node/pnpm/git/loopback →
//     `finding`); this collector only reports the raw booleans.
//   • LOCAL-ONLY — the exec port runs local `--version` / `git remote -v` (no fetch); the bind
//     port binds 127.0.0.1. No network / external / cloud call (the arc's hard line).
//   • NO INFERENCE — `localBackupAccepted` is a CONFIG input (a policy decision), never probed.
import { runDoctor } from "./doctor";
import type { DoctorReport } from "@sow/contracts";
import type {
  ProbeSnapshot,
  NodePnpmProbe,
  TemporalStartableProbe,
  GbrainStartableProbe,
  GitRemotesProbe,
  LoopbackPortsProbe,
} from "./probe-snapshot";

/** A FIXED local command to run — a bin + an argv ARRAY (never a shell string / caller-interpolated). */
export interface CommandRequest {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/** The typed outcome of a local command — a clean exit-0 with stdout, or an enumerable fault (never a throw). */
export type CommandOutcome =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly code: "not_found" | "nonzero_exit" | "timeout" | "unknown";
      readonly message: string;
    };

/** The injected local-exec port (a real `execFile` adapter in production, a fake in tests). */
export type RunCommand = (req: CommandRequest) => Promise<CommandOutcome>;

/** The outcome of a loopback bind probe — bindable (free) or not (in-use / assume-worst on fault). */
export interface LoopbackBindOutcome {
  readonly bindable: boolean;
}

/** The injected loopback-bind port (a real `net` bind on 127.0.0.1 in production, a fake in tests). */
export type ProbeLoopbackBind = (port: number) => Promise<LoopbackBindOutcome>;

/** The collector's injected inputs — the two ports + the local config the probes need. */
export interface PrerequisiteProbeInput {
  readonly run: RunCommand;
  readonly bindLoopback: ProbeLoopbackBind;
  /** The loopback ports the app needs free (worker API / Temporal / gbrain). */
  readonly loopbackPorts: readonly number[];
  /** The local git repo dir to read remotes from (`git remote -v` cwd — no fetch). */
  readonly repoDir: string;
  /** The owner explicitly accepted local-only backup (§16) — from config, NOT a probe. */
  readonly localBackupAccepted: boolean;
}

/** The minimum satisfied Node major (the stack pins Node 22 LTS). */
export const NODE_MIN_MAJOR = 22;
/** The minimum satisfied pnpm major (workspaces stack). */
export const PNPM_MIN_MAJOR = 8;

/** Run an injected command TOTALLY — even a thrown port becomes a typed fault (§16 never-throw). */
async function safeRun(run: RunCommand, req: CommandRequest): Promise<CommandOutcome> {
  try {
    return await run(req);
  } catch {
    return { ok: false, code: "unknown", message: "exec_threw" };
  }
}

/**
 * The leading version major from a `--version` output (`v22.4.1` / `9.6.0` → 22 / 9), or
 * undefined when unparseable — a malformed output is UNSATISFIED, never a fabricated pass.
 */
function versionMajor(stdout: string): number | undefined {
  const m = stdout.trim().match(/^v?(\d+)/);
  if (m === null) return undefined;
  const major = Number(m[1]);
  return Number.isFinite(major) ? major : undefined;
}

/** True IFF the command succeeded AND its parsed major meets the floor (present + new enough). */
function satisfiesFloor(outcome: CommandOutcome, floor: number): boolean {
  if (!outcome.ok) return false;
  const major = versionMajor(outcome.stdout);
  return major !== undefined && major >= floor;
}

async function probeNodePnpm(run: RunCommand): Promise<NodePnpmProbe> {
  const [node, pnpm] = await Promise.all([
    safeRun(run, { bin: "node", args: ["--version"] }),
    safeRun(run, { bin: "pnpm", args: ["--version"] }),
  ]);
  return {
    nodeSatisfied: satisfiesFloor(node, NODE_MIN_MAJOR),
    pnpmSatisfied: satisfiesFloor(pnpm, PNPM_MIN_MAJOR),
  };
}

/** Presence probe: a successful `<bin> --version` ⇒ startable; any fault ⇒ not startable. */
async function probeStartable(run: RunCommand, bin: string): Promise<{ readonly startable: boolean }> {
  const r = await safeRun(run, { bin, args: ["--version"] });
  return { startable: r.ok };
}

async function probeGitRemotes(
  run: RunCommand,
  repoDir: string,
  localBackupAccepted: boolean,
): Promise<GitRemotesProbe> {
  // LOCAL-ONLY: `git remote -v` reads the repo's own config — it performs NO network fetch.
  const r = await safeRun(run, { bin: "git", args: ["remote", "-v"], cwd: repoDir });
  return { hasRemote: r.ok && r.stdout.trim().length > 0, localBackupAccepted };
}

async function probeLoopbackPorts(
  bind: ProbeLoopbackBind,
  ports: readonly number[],
): Promise<LoopbackPortsProbe> {
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const outcome = await bind(port);
        return { port, occupied: !outcome.bindable };
      } catch {
        // A thrown bind fails CLOSED to "occupied" (assume-worst) — never a fabricated "free".
        return { port, occupied: true };
      }
    }),
  );
  return { occupiedPorts: results.filter((r) => r.occupied).map((r) => r.port) };
}

/**
 * Collect the FIVE prerequisite probes into a partial {@link ProbeSnapshot} the pure
 * `runDoctor` engine consumes. Pure over the injected ports; NEVER throws; fail-closes each
 * probe to its assume-worst shape. The other five snapshot fields (macOS-security + one-writer
 * POSTURE) are the deferred 11.5-b/c slices — absent here ⇒ `runDoctor` fail-closes them.
 */
export async function collectPrerequisiteProbes(
  input: PrerequisiteProbeInput,
): Promise<Partial<ProbeSnapshot>> {
  const [nodePnpm, temporalStartable, gbrainStartable, gitRemotes, loopbackPorts]: [
    NodePnpmProbe,
    TemporalStartableProbe,
    GbrainStartableProbe,
    GitRemotesProbe,
    LoopbackPortsProbe,
  ] = await Promise.all([
    probeNodePnpm(input.run),
    probeStartable(input.run, "temporal"),
    probeStartable(input.run, "gbrain"),
    probeGitRemotes(input.run, input.repoDir, input.localBackupAccepted),
    probeLoopbackPorts(input.bindLoopback, input.loopbackPorts),
  ]);
  return { nodePnpm, temporalStartable, gbrainStartable, gitRemotes, loopbackPorts };
}

/**
 * Compose the real collector into the pure engine: `collectPrerequisiteProbes → runDoctor`.
 * The doctor CLI / repair COMMAND that calls this is a later 11.5 slice (a documented waiver,
 * as with `runDoctor`'s own build); the real adapters are exercised via the gated test.
 */
export async function runPrerequisiteDoctor(input: PrerequisiteProbeInput): Promise<DoctorReport> {
  return runDoctor(await collectPrerequisiteProbes(input));
}
