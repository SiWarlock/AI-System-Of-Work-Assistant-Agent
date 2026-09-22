// The desktop worker host must NOT pass a `dispatchApproval` override to `bootWorker`. Linear slice 3+4.
//
// ⛔ WHY: until slice 3+4 the host passed a no-op here, so approving an external action sent nothing in every
// configuration. With no override, `bootWorker` binds the REAL guarded dispatcher. Re-adding any override —
// a no-op especially — would silently switch that off, and nothing else would notice: the drift guard counts
// the dispatcher's binding inside boot, which an override bypasses without moving (review 2026-09-22).
// A textual check on the host's own source, the same idiom the project uses for boot's arming locks.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST = readFileSync(join(__dirname, "..", "..", "worker-host", "index.ts"), "utf8");
const codeLines = HOST.split("\n").filter((l) => {
  const t = l.trim();
  return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
});

describe("worker host → bootWorker: no dispatchApproval override", () => {
  it("positive control: the host really does call bootWorker", () => {
    expect(codeLines.some((l) => l.includes("boot.bootWorker("))).toBe(true);
  });

  it("passes no `dispatchApproval` key — explicit (`dispatchApproval: …`) or shorthand (`dispatchApproval,`)", () => {
    // ⚠ A textual check cannot see a key returned by a spread helper defined in ANOTHER module (the config also
    // spreads `…ArmForward(config)` helpers). Those helpers are data-only arming forwards today; one that ever
    // returned a dispatch function would slip past this test. (Review 2026-09-22.)
    expect(codeLines.filter((l) => /\bdispatchApproval\b\s*[:,}]/.test(l))).toEqual([]);
    expect(codeLines.filter((l) => /\bdispatchApproval\b/.test(l))).toEqual([]); // not even referenced in code
  });
});
