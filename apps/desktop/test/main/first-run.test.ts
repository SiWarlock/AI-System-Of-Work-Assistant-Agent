import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { readOnboardingComplete, markOnboardingComplete, type FirstRunDeps } from "../../main/first-run";

// 9.17 — first-run gating. An authoritative, DURABLE onboarding-complete marker owned by Electron main,
// persisted under app-data (userData) so onboarding shows ONLY on a genuine first run — not on a transient
// empty registry (worker unreachable at boot). These pin the PURE, electron-free read/write (injected fs
// seam, zero real fs; LESSON 3/13/16): marker ABSENT ⇒ ok(false) (first run); PRESENT ⇒ ok(true); a genuine
// read/write IO fault ⇒ typed err (INCONCLUSIVE, never throws — §16); a malformed/empty file ⇒ ok(false)
// (empty=unset hygiene, LESSON 15). The marker gates only the onboarding MOUNT (renderer gate test), never
// the WS-8 isolation predicate.

const MARKER = "/userData/onboarding-complete.json";

/** An in-memory fs seam (a Map) — the whole suite touches zero real fs. `readFile` throws ENOENT when absent. */
function memFs(seed?: Record<string, string>): { files: Map<string, string>; deps: FirstRunDeps } {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const deps: FirstRunDeps = {
    fileExists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: (p, d) => {
      files.set(p, d);
    },
  };
  return { files, deps };
}

describe("readOnboardingComplete — authoritative durable first-run marker (pure, injected fs)", () => {
  it("marker_absent_is_first_run: no marker file ⇒ ok(false)", () => {
    // spec(§11) — first-run determination: an absent marker means a genuine first run (show onboarding).
    const { deps } = memFs();
    const r = readOnboardingComplete(MARKER, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(false);
  });

  it("marker_present_is_not_first_run: after markOnboardingComplete, read ⇒ ok(true) (durable across the read)", () => {
    // spec(§11) — first-run-only: once onboarded, the durable marker persists ⇒ never auto-show onboarding again.
    const { deps } = memFs();
    expect(isOk(markOnboardingComplete(MARKER, deps))).toBe(true);
    const r = readOnboardingComplete(MARKER, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(true);
  });

  it("read_fault_is_inconclusive_never_throws: an fs-read throw ⇒ typed err('read_fault'), not a throw", () => {
    // spec(§16) — a present-but-unreadable marker (permission/IO fault) is INCONCLUSIVE: a typed err the gate
    // maps to the registry-derived fallback — never a throw, never a lock-out. (LESSON 13/16 never-throws.)
    const deps: FirstRunDeps = {
      fileExists: () => true,
      readFile: () => {
        throw new Error("EACCES");
      },
      writeFile: () => undefined,
    };
    let r: ReturnType<typeof readOnboardingComplete>;
    expect(() => {
      r = readOnboardingComplete(MARKER, deps);
    }).not.toThrow();
    expect(isErr(r!)).toBe(true);
    if (isErr(r!)) expect(r!.error).toBe("read_fault");
  });

  it("write_fault_is_typed_never_throws: an fs-write throw ⇒ typed err('write_fault'), not a throw", () => {
    // spec(§16) — marking must never throw across the boundary; a write IO fault is a typed err.
    const deps: FirstRunDeps = {
      fileExists: () => false,
      readFile: () => {
        throw new Error("ENOENT");
      },
      writeFile: () => {
        throw new Error("ENOSPC");
      },
    };
    let r: ReturnType<typeof markOnboardingComplete>;
    expect(() => {
      r = markOnboardingComplete(MARKER, deps);
    }).not.toThrow();
    expect(isErr(r!)).toBe(true);
    if (isErr(r!)) expect(r!.error).toBe("write_fault");
  });

  it("mark_is_idempotent: marking twice writes identical content (no duplicate/partial state); read ⇒ ok(true)", () => {
    // spec(§11) — idempotent onboarding: a re-mark is a safe overwrite with byte-identical content. Also the
    // property the backfill leg relies on (a redundant backfill write is a safe no-op).
    const { files, deps } = memFs();
    const writes: string[] = [];
    const spyDeps: FirstRunDeps = { ...deps, writeFile: (p, d) => (writes.push(d), deps.writeFile(p, d)) };
    expect(isOk(markOnboardingComplete(MARKER, spyDeps))).toBe(true);
    expect(isOk(markOnboardingComplete(MARKER, spyDeps))).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(writes[1]); // identical content both times ⇒ idempotent
    expect(files.size).toBe(1); // one marker file, not duplicated
    const r = readOnboardingComplete(MARKER, deps);
    expect(isOk(r) && r.value).toBe(true);
  });

  it("malformed_or_empty_marker_is_unset: present-but-garbage ⇒ ok(false) (empty=unset hygiene, LESSON 15)", () => {
    // spec(§11) — a malformed / empty / wrong-shape / explicitly-false marker is NOT a completion signal;
    // it reads as unset (ok(false)), distinguishable from a genuine IO fault (which is err). Never throws.
    const cases: Record<string, boolean> = {
      "": false,
      "{ not json": false,
      "{}": false,
      '{"other":1}': false,
      '{"onboardingComplete":false}': false,
      '{"onboardingComplete":"true"}': false, // truthy-but-not-boolean-true ⇒ unset
      '{"onboardingComplete":true}': true,
    };
    for (const [raw, expected] of Object.entries(cases)) {
      const { deps } = memFs({ [MARKER]: raw });
      const r = readOnboardingComplete(MARKER, deps);
      expect(isOk(r)).toBe(true);
      if (isOk(r)) expect(r.value).toBe(expected);
    }
  });
});
