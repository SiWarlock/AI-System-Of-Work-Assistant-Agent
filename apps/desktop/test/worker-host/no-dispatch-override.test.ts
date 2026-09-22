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

  it("passes no `dispatchApproval` key (a comment may mention it; code may not)", () => {
    expect(codeLines.filter((l) => /\bdispatchApproval\s*:/.test(l))).toEqual([]);
  });
});
