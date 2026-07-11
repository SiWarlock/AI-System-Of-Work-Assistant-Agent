// Install-doctor REAL local probe collectors (tasks 11.5-a/b, §13).
//
// Phase-11 real-I/O: PURE data-mappers over INJECTED ports (a local-command exec + a loopback
// bind) that fill ProbeSnapshot fields the already-built pure `runDoctor` engine consumes.
//   • `collectPrerequisiteProbes` (11.5-a) — 5 fields: nodePnpm / temporalStartable /
//     gbrainStartable / gitRemotes / loopbackPorts.
//   • `collectSecurityProbes` (11.5-b) — 2 fields: filevault / keychain (macOS security).
// Same shape as C2/C3a: pure core + injected port + a thin real adapter (probe-adapters.ts).
// The 3 one-writer POSTURE fields (vaultAcl / gbrainMount / strayGbrainProcess) are 11.5-c.
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
  FilevaultProbe,
  KeychainProbe,
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
 * probe to its assume-worst shape. The macOS-security fields are filled by `collectSecurityProbes`
 * (11.5-b, below); the three one-writer POSTURE fields are the deferred 11.5-c slice — absent
 * fields ⇒ `runDoctor` fail-closes them.
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

/** The macOS-security collector's injected input — only the exec port (reused from 11.5-a). */
export interface SecurityProbeInput {
  readonly run: RunCommand;
}

/**
 * FileVault (full-disk encryption) status via `fdesetup status`. Fail-CLOSED: enabled ONLY on
 * the LINE-ANCHORED "FileVault is On" signal (an "On, but Conversion in progress…" still counts
 * — it IS on; a stray substring elsewhere in the output does NOT). A macOS TCC "Operation not
 * permitted" / ENOENT / nonzero / timeout / malformed output ⇒ NOT enabled (assume-worst →
 * finding), never a fabricated ok. `fdesetup status` emits English regardless of locale; were a
 * string ever localized, the probe would fail CLOSED (a missed advisory, the safe direction).
 */
async function probeFilevault(run: RunCommand): Promise<FilevaultProbe> {
  const r = await safeRun(run, { bin: "fdesetup", args: ["status"] });
  // Line-anchored (^…/m): the positive signal must START a line (as `fdesetup` prints it), so a
  // contrived multi-line output can't smuggle "FileVault is On" mid-line to fabricate enabled.
  return { enabled: r.ok && /^FileVault is On\b/im.test(r.stdout) };
}

/**
 * Keychain SUBSYSTEM REACHABILITY via `security list-keychains` — a READ-ONLY least-privilege
 * query: it lists the search-list keychain PATHS only, reading NO secret, unlocking nothing,
 * writing nothing (safety rule 7 — secrets resolve only through the SecretsPort). This is the
 * INSTALL prerequisite ("the `security` tool works + a keychain exists"); it deliberately does
 * NOT probe UNLOCK state — a locked-but-present keychain is the §16 RUNTIME degraded concern
 * (keychain-locked), handled elsewhere, NOT an install-doctor prerequisite. So `reachable` here
 * means the subsystem responds, and normally holds on a healthy macOS; it fail-closes only when
 * the tool is absent / TCC-denied / the search list is empty. Reachable ONLY on a clean
 * non-empty result; any fault ⇒ NOT reachable (assume-worst → finding).
 */
async function probeKeychain(run: RunCommand): Promise<KeychainProbe> {
  const r = await safeRun(run, { bin: "security", args: ["list-keychains"] });
  return { reachable: r.ok && r.stdout.trim().length > 0 };
}

/**
 * Collect the two macOS-security probes (FileVault + Keychain) into a partial ProbeSnapshot.
 * Reuses the injected {@link RunCommand} (11.5-a's real `execFile` adapter); NEVER throws;
 * fail-closes each probe to its assume-worst shape on any fault. LOCAL-ONLY (local macOS
 * tooling, no network).
 */
export async function collectSecurityProbes(input: SecurityProbeInput): Promise<Partial<ProbeSnapshot>> {
  const [filevault, keychain]: [FilevaultProbe, KeychainProbe] = await Promise.all([
    probeFilevault(input.run),
    probeKeychain(input.run),
  ]);
  return { filevault, keychain };
}

/**
 * Compose the real collectors into the pure engine: the prerequisite (11.5-a) + macOS-security
 * (11.5-b) probes are collected in parallel, merged, and fed to `runDoctor`. The doctor CLI /
 * repair COMMAND that calls this is a later 11.5 slice (a documented waiver, as with
 * `runDoctor`'s own build); the real adapters are exercised via the gated tests.
 */
export async function runPrerequisiteDoctor(input: PrerequisiteProbeInput): Promise<DoctorReport> {
  const [prerequisite, security] = await Promise.all([
    collectPrerequisiteProbes(input),
    collectSecurityProbes({ run: input.run }),
  ]);
  return runDoctor({ ...prerequisite, ...security });
}
