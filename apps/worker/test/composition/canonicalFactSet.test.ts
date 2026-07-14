// Task 13.10 — reconcile-TRIGGER arc, piece C: buildCanonicalFactSet. spec(§6) spec(§12)
//
// buildCanonicalFactSet(reader, workspaceId) is the thin worker-side composition that produces piece A's
// req.canonicalSet: read the committed vault @ head via the injected CommittedVaultReader → run the pure
// deriveCanonicalFacts over the CanonicalVaultSnapshot → a 3-WAY fail-closed outcome that DISTINGUISHES:
//   • { kind: "derived", set }       — a readable vault derived cleanly (the canonical reference);
//   • { kind: "absent" }             — no/empty vault (reader undefined) OR a contract-violating reader
//                                       throw/reject → a BENIGN skip (piece D does not reconcile);
//   • { kind: "derive_error", error }— a structurally-broken vault (a real defect piece D routes to health).
// Collapsing derive_error into absent would DROP the defect signal, so the union keeps them distinct.
// Never throws. DORMANT + fakes only; LOCAL-fs only (the reader is injected), NOT a gbrain line.
//
// The reader is SYNC-or-ASYNC (CommittedVaultReader mirrors the loader's port) — the helper `await`s either.
// Fixtures mirror packages/knowledge/test/canonical-fact-deriver.test.ts (real deriveCanonicalFacts inputs).
import { describe, it, expect } from "vitest";
import { isOk, WorkspaceIdSchema, RevisionIdSchema, type WorkspaceId, type RevisionId } from "@sow/contracts";
import { deriveCanonicalFacts, type CanonicalVaultSnapshot } from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import { buildCanonicalFactSet } from "../../src/composition/canonicalFactSet";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");
const WS_STR = "ws-employer";

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  return { workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) };
}

describe("buildCanonicalFactSet — derives the canonical reference (spec §6)", () => {
  it("readable_snapshot_derives_factset", async () => {
    const snap = snapshot({ "p.md": "hi", "q.md": "[[p]]" });
    const expected = deriveCanonicalFacts(snap);
    expect(isOk(expected)).toBe(true);
    const outcome = await buildCanonicalFactSet(() => snap, WS_STR);
    expect(outcome.kind).toBe("derived");
    if (outcome.kind !== "derived" || !isOk(expected)) return;
    expect(outcome.set).toEqual(expected.value); // the deriver's output VERBATIM (workspaceId/revisionId/facts)
    expect(outcome.set.workspaceId).toBe(WS);
    expect(outcome.set.revisionId).toBe(REV);
  });

  it("async_reader_snapshot_derives_factset", async () => {
    // the reader is SYNC-or-ASYNC — a Promise-returning reader is awaited the same as a direct return
    const snap = snapshot({ "p.md": "hi" });
    const asyncReader: CommittedVaultReader = () => Promise.resolve(snap);
    const outcome = await buildCanonicalFactSet(asyncReader, WS_STR);
    expect(outcome.kind).toBe("derived");
  });
});

describe("buildCanonicalFactSet — fail-closed 3-way outcome (spec §12)", () => {
  it("reader_undefined_is_absent", async () => {
    // no vault mapped / empty vault / reader fault ⇒ absent — a BENIGN skip, no canonical reference to reconcile
    const outcome = await buildCanonicalFactSet(() => undefined, WS_STR);
    expect(outcome).toEqual({ kind: "absent" });
  });

  it("workspace_mismatch_snapshot_is_absent", async () => {
    // WS-8 read-back re-gate (Lesson 12): a reader that returns a snapshot stamped for a DIFFERENT workspace than
    // requested is never fed into the parity diff — it degrades to absent, never a cross-workspace canonical reference
    const foreign = snapshot({ "p.md": "hi" }); // stamped with WS ("ws-employer")
    const outcome = await buildCanonicalFactSet(() => foreign, "ws-personal");
    expect(outcome).toEqual({ kind: "absent" });
  });

  it("derive_error_is_distinguished", async () => {
    // a structurally-broken vault (two files → the same page slug ⇒ duplicate_fact_identity) is a real defect,
    // returned as derive_error — NOT collapsed into absent (piece D routes it to health, distinct from an empty vault)
    const broken = snapshot({ "dir1/dup.md": "one", "dir2/dup.md": "two" });
    const outcome = await buildCanonicalFactSet(() => broken, WS_STR);
    expect(outcome.kind).toBe("derive_error");
    if (outcome.kind !== "derive_error") return;
    expect(outcome.error.code).toBe("duplicate_fact_identity");
  });

  it("rejecting_reader_is_absent_not_throw", async () => {
    // a (contract-violating) reader that REJECTS ⇒ absent, never a throw across the boundary. `.resolves`
    // asserts non-throwing + the value UNCONDITIONALLY (a reject fails loudly, not vacuously — LESSONS.md §15).
    const rejecting: CommittedVaultReader = () => Promise.reject(new Error("vault read exploded"));
    await expect(buildCanonicalFactSet(rejecting, WS_STR)).resolves.toEqual({ kind: "absent" });
  });

  it("sync_throwing_reader_is_absent_not_throw", async () => {
    // the reader is sync-or-async, so a SYNCHRONOUS throw is also absorbed to absent (belt-and-suspenders guard)
    const throwing: CommittedVaultReader = () => {
      throw new Error("vault read threw synchronously");
    };
    await expect(buildCanonicalFactSet(throwing, WS_STR)).resolves.toEqual({ kind: "absent" });
  });
});
