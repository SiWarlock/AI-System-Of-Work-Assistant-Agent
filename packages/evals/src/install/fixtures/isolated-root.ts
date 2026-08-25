// spec(§12 · §13 clean-install/doctor · REQ-NF-005) — task 11.7's ISOLATION primitive.
//
// "Clean environment" for this harness does NOT mean a fresh Mac (that was an over-statement in
// a prior report). It means: no state from THIS developer's machine leaks INTO the exercised
// install. Achieved IN-PROCESS by pointing the real machinery (the install doctor, `bootWorker`)
// at a fresh temp root created per run and torn down after, so the harness proves the documented
// install path works without a pre-existing `~/.sow`, brain, or config.
//
// Genuinely isolated by this fixture (each call mints a fresh, never-reused tree):
//   - `vaultDir`  — an empty Markdown vault root; `bootWorker`'s `vaultRoot` reads THIS, never the
//                   developer's own Obsidian vault.
//   - `dbPath`    — a not-yet-existing sqlite path under a fresh `dataDir`; the genesis migration
//                   (11.2) creates and migrates it from nothing, every run.
//   - `pinPath`   — a byte-identical COPY of the repo's real `config/gbrain.pin`; the boot-time
//                   pin-verify (11.3) reads this copy — nothing this harness does can touch or
//                   flip the real file (§ARM-GBRAIN: read-only copy, never written back).
//   - `lockPath`  — a not-yet-existing single-owner lockfile path (11.1's mechanism leg acquires
//                   it here, in isolation — see clean-install.acceptance.ts for why that is NOT
//                   the same as proving boot enforces it).
//
// NOT isolated, and cannot be, by an in-process harness (named explicitly rather than silently
// assumed away — these are pristine-HOST concerns, §13):
//   - the OS Keychain — a real first-run consent prompt only happens on an actual fresh macOS
//     account; nothing here simulates or bypasses it (rule 7 — this harness never touches Keychain).
//   - the global `node`/`pnpm`/`gbrain` toolchain — the install doctor's whole job is to READ the
//     REAL host PATH/binaries; faking that would defeat the check it exists to run.
//   - any other process already bound to a loopback port on this machine — the doctor's loopback
//     probe reports what it actually finds, never a fabricated "free".
import { mkdtemp, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to THIS file's own location (never `process.cwd()` — the shell's cwd
// persists across tool calls in this environment and a repo-relative path is an unchecked
// assumption). packages/evals/src/install/fixtures -> packages/evals/src/install -> packages/evals/src
// -> packages/evals -> packages -> REPO ROOT (5 levels up).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** The repo's real, canonical `config/gbrain.pin` — READ from here, NEVER written back to. */
export const REPO_GBRAIN_PIN_PATH: string = join(REPO_ROOT, "config", "gbrain.pin");

export interface IsolatedInstallRoot {
  /** The temp root this run's whole tree lives under. */
  readonly root: string;
  /** An empty, never-before-used Markdown vault root. */
  readonly vaultDir: string;
  /** The dir the operational sqlite file lives under (pre-created; the file itself does not yet exist). */
  readonly dataDir: string;
  /** Path to the operational sqlite file — created and migrated by the genesis migration on first open. */
  readonly dbPath: string;
  /** The dir holding the isolated `gbrain.pin` copy. */
  readonly configDir: string;
  /** A byte-identical copy of {@link REPO_GBRAIN_PIN_PATH} — read-only from this harness's own view. */
  readonly pinPath: string;
  /** Path to the single-owner lockfile probed by the isolated lock-mechanism leg. Not pre-created. */
  readonly lockPath: string;
  /** Removes the entire isolated tree. Idempotent — safe to call more than once. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Mint a fresh, isolated install root under the OS temp dir and copy the repo's real
 * `config/gbrain.pin` into it read-only. Never touches `~/.sow`, `process.env.HOME`, or any
 * path outside the returned tree. Each call returns a distinct root (no collision across
 * concurrent runs, since `mkdtemp` mints a unique suffix).
 */
export async function createIsolatedInstallRoot(): Promise<IsolatedInstallRoot> {
  const root = await mkdtemp(join(tmpdir(), "sow-clean-install-"));
  const vaultDir = join(root, "vault");
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const dbPath = join(dataDir, "operational.sqlite");
  const pinPath = join(configDir, "gbrain.pin");
  const lockPath = join(root, "single-owner.lock");

  await mkdir(vaultDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await cp(REPO_GBRAIN_PIN_PATH, pinPath); // read-only copy — the real file is never opened for write

  return {
    root,
    vaultDir,
    dataDir,
    dbPath,
    configDir,
    pinPath,
    lockPath,
    // `force: true` makes a missing target a silent no-op (Node's own documented `rm` contract),
    // which IS the idempotency the caller needs — no extra flag/guard required.
    cleanup: (): Promise<void> => rm(root, { recursive: true, force: true }),
  };
}
