// Test fixture ONLY (task 11.1/24.1) — run in a SEPARATE OS process (via `node --experimental-strip-types`)
// to prove `acquireSingleOwnerLock` PHYSICALLY refuses a second live holder, not merely reports a finding.
// Imports the REAL production module (never a reimplementation) so the child exercises the exact code the
// single-owner-lock test pins. Prints one JSON line to stdout: { ok, holderPid? }.
import { acquireSingleOwnerLock } from "@sow/worker/install/lock/singleOwnerLock";

const lockPath = process.argv[2];
if (typeof lockPath !== "string" || lockPath.length === 0) {
  console.error("usage: acquire-lock-child.ts <lockPath>");
  process.exit(2);
}

const result = acquireSingleOwnerLock(lockPath);
if (result.ok) {
  console.log(JSON.stringify({ ok: true }));
  // Hold the lock (REF'd — keeps the process alive) until the parent signals us or a 10s failsafe fires,
  // so the parent has a real window to spawn a COMPETING acquisition attempt against a genuinely live
  // holder. SIGTERM releases cleanly (proves clean-exit release, not just process death).
  const failsafe = setTimeout(() => {
    result.release();
    process.exit(0);
  }, 10_000);
  process.on("SIGTERM", () => {
    clearTimeout(failsafe);
    result.release();
    process.exit(0);
  });
} else {
  console.log(JSON.stringify({ ok: false, holderPid: result.holderPid }));
  process.exit(0);
}
