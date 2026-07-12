// Install-doctor one-writer POSTURE collectors (task 11.5-c, §13 / REQ-S-NEW-008 / safety rule 1).
// SAFETY-CRITICAL.
//
// Produces the three one-writer POSTURE ProbeSnapshot fields the pure engine (checks/posture.ts)
// already diagnoses fail-closed — a writable/mispointed brain mount or a stray write-capable
// gbrain process re-opens the hidden-brain hole (GO #1). This module only PRODUCES the fields
// (never touches the diagnosers). Real LOCAL macOS checks over the reused injected RunCommand:
//   • vaultAcl            — `/bin/ls -lde -- <vaultDir>` → the worker is the SOLE fs write principal
//                           (owner + POSIX mode + EXTENDED ACLs — the vector `fs.stat` mode bits miss)
//   • gbrainMount         — `/sbin/mount` → the brain mount is read-only AND at the canonical point
//   • strayGbrainProcess  — `/bin/ps` scan → each write-capable gbrain writer bound to the canonical
//                           brain, classified into a CLOSED STRAY_GBRAIN_OPS label
//
// Invariants:
//   • NEVER THROWS (§16) — every sub-probe runs under a TOTAL guard (safeRun); a thrown/absent/
//     nonzero/timeout/malformed result folds to the assume-worst shape.
//   • FAIL-CLOSED (Lesson 8) — `true`/`ok` ONLY on an EXPLICIT, cleanly-parsed green signal; ANY
//     doubt (unparseable ACL grammar, an unrecognized permission token, an unresolvable brain
//     binding) assumes the UNSAFE state. A `ps` fault OMITS the strayGbrainProcess field so the
//     engine's `p == null` branch fails it closed (we cannot confirm "no stray writer").
//   • REDACTION-SAFE BY CONSTRUCTION (safety rule 7) — the stray probe emits ONLY the classified
//     StrayGbrainOp label; a raw `ps` line / argv / path / secret NEVER leaves the collector.
//   • LOCAL-ONLY — `ls`/`mount`/`ps` are local macOS queries; no network. Absolute bins pin the
//     system tools (no PATH-hijack of a security probe). No shell (fixed argv arrays).
//   • NO INFERENCE — vaultDir / canonicalBrainPath / workerPrincipal are CONFIG (a policy
//     decision), never probed or derived (workerPrincipal is the boot-resolved username, not a
//     `process.getuid()` read inside this pure collector).
import type {
  ProbeSnapshot,
  VaultAclProbe,
  GbrainMountProbe,
  StrayGbrainProcessProbe,
  StrayGbrainProcess,
  StrayGbrainOp,
} from "./probe-snapshot";
import type { RunCommand } from "./probe-collectors";
import { safeRun } from "./probe-run";

/** The posture collector's injected input — the exec port + the CONFIG paths/principal (no inference). */
export interface PostureProbeInput {
  readonly run: RunCommand;
  /** The canonical vault directory whose ACL is checked (config, not probed). */
  readonly vaultDir: string;
  /** The canonical brain path a stray writer / mount is checked against (config, not probed). */
  readonly canonicalBrainPath: string;
  /** The OS principal (username) the worker runs as — the sole legitimate vault writer (config). */
  readonly workerPrincipal: string;
}

// The macOS security-posture tools at their fixed system paths (absolute — no PATH-hijack surface).
const LS_BIN = "/bin/ls";
const MOUNT_BIN = "/sbin/mount";
const PS_BIN = "/bin/ps";

// ── vault-acl ────────────────────────────────────────────────────────────────

/**
 * The macOS ACL permission tokens that are provably READ-ONLY (grant no write/modify/delete). An
 * allow entry to a foreign principal is safe ONLY if EVERY perm is in this set; any perm outside
 * it — including an UNRECOGNIZED token — is treated as write-capable (unknown grammar ⇒ assume-worst).
 */
const READ_ONLY_ACL_PERMS: ReadonlySet<string> = new Set([
  "read",
  "execute",
  "readattr",
  "readextattr",
  "readsecurity",
  "list",
  "search",
  "file_inherit",
  "directory_inherit",
  "limit_inherit",
  "only_inherit",
]);

/**
 * True IFF an extended-ACL line GRANTS write to a principal other than the worker. A `deny` entry
 * restricts (never grants) → not a foreign write. An `allow` to `user:<worker>` is the worker
 * granting itself → fine. An `allow` to a group or a foreign user is a foreign write UNLESS every
 * permission is provably read-only. An UNPARSEABLE line ⇒ true (assume-worst — never silently skipped).
 */
function aclLineGrantsForeignWrite(line: string, worker: string): boolean {
  const body = line.replace(/^\s*\d+:\s*/, "").trim();
  const m = body.match(/^(user|group):(\S+)\s+(allow|deny)\b\s*(.*)$/i);
  if (m === null) return true; // unparseable ACL entry ⇒ assume-worst (it could grant write)
  const kind = (m[1] ?? "").toLowerCase();
  const principal = m[2] ?? "";
  const action = (m[3] ?? "").toLowerCase();
  const permsStr = m[4] ?? "";
  if (action === "deny") return false; // a deny restricts, never grants
  if (kind === "user" && principal === worker) return false; // the worker granting itself is fine
  // A grant to a group or a foreign user: foreign-write UNLESS EVERY perm is provably read-only.
  const perms = permsStr
    .split(/[,\s]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0);
  const allReadOnly = perms.length > 0 && perms.every((p) => READ_ONLY_ACL_PERMS.has(p));
  return !allReadOnly; // not-all-read-only (incl. an unknown token / an empty perm list) ⇒ foreign write
}

/**
 * Parse `ls -lde <vaultDir>` → true IFF the worker is the SOLE write principal: owner is the worker
 * AND no group/other POSIX write bit AND every extended-ACL entry is a deny / a worker allow / a
 * foreign READ-ONLY allow. ANY unparseable/foreign-write state ⇒ false (fail-closed).
 */
function parseVaultAclSoleWrite(stdout: string, worker: string): boolean {
  const lines = stdout
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  const header = (lines[0] ?? "").trim();
  const cols = header.split(/\s+/);
  const mode = cols[0];
  const owner = cols[2];
  if (mode === undefined || owner === undefined) return false;
  if (owner !== worker) return false;
  // Strip a trailing ACL/xattr/other marker (+, @, .) from the mode string.
  const modeBits = mode.replace(/[@+.]+$/, "");
  if (modeBits.length !== 10) return false; // a real mode is EXACTLY 10 chars post-marker; else assume-worst
  // group-write bit = index 5, other-write bit = index 8 (d + owner[1-3] + group[4-6] + other[7-9]).
  if (modeBits[5] === "w" || modeBits[8] === "w") return false;
  // The remaining lines are extended-ACL entries — none may grant write to a non-worker principal.
  for (const line of lines.slice(1)) {
    if (!/^\s*\d+:/.test(line)) return false; // an unexpected non-ACL trailing line ⇒ assume-worst
    if (aclLineGrantsForeignWrite(line, worker)) return false;
  }
  return true;
}

/** The vault-ACL probe for ONE vault dir — exported so a multi-vault caller folds it per-vault (11.5-d). */
export async function probeVaultAcl(
  run: RunCommand,
  vaultDir: string,
  workerPrincipal: string,
): Promise<VaultAclProbe> {
  // `--` end-of-options separator precedes the positional vaultDir (Lesson 19 residual): a config
  // path that happens to start with `-` rides as the positional path, never parsed as an `ls` flag.
  const r = await safeRun(run, { bin: LS_BIN, args: ["-lde", "--", vaultDir] });
  return { workerIsSoleWritePrincipal: r.ok && parseVaultAclSoleWrite(r.stdout, workerPrincipal) };
}

// ── gbrain-mount ───────────────────────────────────────────────────────────────

/** Normalize a path for comparison (strip a trailing slash, keeping root "/"). */
function normPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}
function pathEquals(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}
/** True IFF `prefix` is `full` or a parent directory of it (path-component prefix, not substring). */
function isPathPrefix(prefix: string, full: string): boolean {
  const p = normPath(prefix);
  const f = normPath(full);
  if (p === f) return true;
  if (p === "/") return f.startsWith("/");
  return f.startsWith(p + "/");
}

/**
 * Parse `mount` output → the gbrain-mount posture. The BACKING mount is the one whose mount-point is
 * the LONGEST path-prefix of the canonical brain path; `readOnly` = that mount's read-only flag;
 * `mountPointCanonical` = that mount-point EXACTLY equals the canonical path (a dedicated mount, not
 * the brain merely sitting inside a broader writable mount). No backing mount ⇒ assume-worst {false,false}.
 */
function parseGbrainMount(stdout: string, brainPath: string): GbrainMountProbe {
  let best: { readonly mountPoint: string; readonly readOnly: boolean } | undefined;
  for (const line of stdout.split("\n")) {
    // Each line: "<device> on <mountpoint> (<flags>)". Slice on " on " / " (" / ")" to tolerate spaces.
    const onIdx = line.indexOf(" on ");
    const parenIdx = line.lastIndexOf(" (");
    const closeIdx = line.lastIndexOf(")");
    if (onIdx < 0 || parenIdx <= onIdx || closeIdx <= parenIdx) continue;
    const mountPoint = line.slice(onIdx + 4, parenIdx).trim();
    if (mountPoint.length === 0) continue;
    if (!isPathPrefix(mountPoint, brainPath)) continue;
    // `>=` so that among mounts at the SAME point the LAST listed (the effective/top mount) wins —
    // a writable mount stacked over a read-only one at the canonical path is not masked (fail-closed).
    if (best === undefined || mountPoint.length >= best.mountPoint.length) {
      const flags = line
        .slice(parenIdx + 2, closeIdx)
        .split(/,\s*/)
        .map((f) => f.trim());
      best = { mountPoint, readOnly: flags.includes("read-only") };
    }
  }
  if (best === undefined) return { readOnly: false, mountPointCanonical: false };
  return { readOnly: best.readOnly, mountPointCanonical: pathEquals(best.mountPoint, brainPath) };
}

async function probeGbrainMount(run: RunCommand, canonicalBrainPath: string): Promise<GbrainMountProbe> {
  const r = await safeRun(run, { bin: MOUNT_BIN, args: [] });
  if (!r.ok) return { readOnly: false, mountPointCanonical: false };
  return parseGbrainMount(r.stdout, canonicalBrainPath);
}

// ── stray-gbrain-process ───────────────────────────────────────────────────────

// The recognized brain-selection flags — a value pointing ELSEWHERE means bound to a different brain.
const BRAIN_FLAGS = ["--brain", "--brain-path", "--db", "--database", "--data-dir"];
// The subset of BRAIN_FLAGS whose value is a SEPARATE following token (`--brain /p`), so that value
// is not mistaken for the subcommand when it precedes it (`gbrain --brain /p serve`).
const VALUE_FLAGS: ReadonlySet<string> = new Set(BRAIN_FLAGS);

function binBasename(t: string): string {
  const idx = t.lastIndexOf("/");
  return idx >= 0 ? t.slice(idx + 1) : t;
}

/**
 * The gbrain subcommand — the first bare token, skipping flags AND the separate-token value of a
 * recognized value-flag (so `gbrain --brain /p serve` yields `serve`, not `/p`). gbrain's grammar is
 * subcommand-first (`gbrain <command> [options]`), so this is robust to global flags before the command.
 */
function subcommandOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i += 1; // skip the separate-token value of a recognized value-flag
      continue;
    }
    return a;
  }
  return undefined;
}

/** Map a gbrain arg list to a write-capable {@link StrayGbrainOp} (the CLOSED set) or undefined (read-only/other). */
function writeCapableOp(args: readonly string[]): StrayGbrainOp | undefined {
  const sub = subcommandOf(args);
  if (sub === undefined) return undefined;
  switch (sub) {
    case "serve":
      return "serve";
    case "autopilot":
      return "autopilot";
    case "dream":
      return "dream";
    case "jobs": {
      // Only `jobs work` (the write-capable worker) — a plain `jobs` listing is read-only.
      const after = args.slice(args.indexOf("jobs") + 1).filter((a) => !a.startsWith("-"));
      return after[0] === "work" ? "jobs_work" : undefined;
    }
    case "sync":
      // Only `sync --install-cron` (the persistent scheduled writer) is in the closed set.
      return args.includes("--install-cron") ? "sync_install_cron" : undefined;
    default:
      return undefined; // query / search / call / plain sync|jobs / … — not a write-capable stray op
  }
}

/**
 * The value of the first recognized brain-selection flag, or undefined when none is resolvable. A
 * flag whose following token is absent or is itself a flag (`--brain --http`) yields undefined —
 * an unresolvable binding folds to fail-closed-stray rather than mis-reading a flag as the value.
 */
function extractBrainArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    for (const f of BRAIN_FLAGS) {
      if (a === f) {
        const v = args[i + 1];
        return v !== undefined && !v.startsWith("-") ? v : undefined;
      }
      if (a.startsWith(f + "=")) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

/**
 * True IFF the process is bound to the CANONICAL brain: a recognized brain flag path-EQUALS it, OR a
 * bare token path-equals it, OR there is NO resolvable brain arg (implicit default ⇒ fail-closed: we
 * cannot prove it is NOT the canonical brain). A recognized brain flag pointing ELSEWHERE ⇒ false.
 */
function boundToCanonical(args: readonly string[], canonicalBrainPath: string): boolean {
  const explicit = extractBrainArg(args);
  if (explicit !== undefined) return pathEquals(explicit, canonicalBrainPath);
  if (args.some((a) => pathEquals(a, canonicalBrainPath))) return true;
  return true; // no resolvable brain arg ⇒ fail-closed stray
}

/**
 * Classify one `ps` command line into a stray {@link StrayGbrainOp}, or undefined (not a stray writer).
 * The classifier keys on the EXECUTABLE token (`ps -o command` argv[0]). A launcher-wrapped writer
 * surfaces as a bare `gbrain …` line regardless — `env`/`nice`/`nohup`/`stdbuf` exec-REPLACE themselves
 * (their argv becomes gbrain's), and `sudo`/`doas` fork a child running gbrain — so the executable
 * check catches it without launcher parsing; a `grep gbrain …` (grep is the executable) is correctly
 * not classified. (This is safer than a launcher-skip that could mis-land on a launcher's own flag.)
 */
function classifyStrayGbrainLine(line: string, canonicalBrainPath: string): StrayGbrainOp | undefined {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const execTok = tokens[0];
  if (execTok === undefined || binBasename(execTok) !== "gbrain") return undefined;
  const args = tokens.slice(1);
  const op = writeCapableOp(args);
  if (op === undefined) return undefined;
  return boundToCanonical(args, canonicalBrainPath) ? op : undefined;
}

/**
 * Scan `ps` for write-capable gbrain writers bound to the canonical brain. Emits ONLY the classified
 * op labels (redaction-safe — no raw line/argv/path). A `ps` fault OMITS the field (returns undefined)
 * so the engine fail-closes it (we cannot confirm "no stray writer").
 */
async function probeStrayGbrain(
  run: RunCommand,
  canonicalBrainPath: string,
): Promise<StrayGbrainProcessProbe | undefined> {
  const r = await safeRun(run, { bin: PS_BIN, args: ["-Axww", "-o", "command="] });
  if (!r.ok) return undefined;
  const strayProcesses: StrayGbrainProcess[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const op = classifyStrayGbrainLine(line, canonicalBrainPath);
    if (op !== undefined) strayProcesses.push({ op });
  }
  return { strayProcesses };
}

// ── collector ────────────────────────────────────────────────────────────────

/**
 * Collect the three one-writer POSTURE probes into a partial ProbeSnapshot. Pure over the injected
 * port; NEVER throws; fail-closes each probe. `strayGbrainProcess` is OMITTED on a `ps` fault so the
 * engine fail-closes it (an absent probe ⇒ finding). Redaction-safe by construction.
 */
export async function collectPostureProbes(input: PostureProbeInput): Promise<Partial<ProbeSnapshot>> {
  const [vaultAcl, gbrainMount, strayGbrainProcess]: [
    VaultAclProbe,
    GbrainMountProbe,
    StrayGbrainProcessProbe | undefined,
  ] = await Promise.all([
    probeVaultAcl(input.run, input.vaultDir, input.workerPrincipal),
    probeGbrainMount(input.run, input.canonicalBrainPath),
    probeStrayGbrain(input.run, input.canonicalBrainPath),
  ]);
  return {
    vaultAcl,
    gbrainMount,
    ...(strayGbrainProcess !== undefined ? { strayGbrainProcess } : {}),
  };
}
