// spec(§6) — out-of-band-writer reconciliation (task 4.6): positive KnowledgeWriter
// attribution via kw_writer_sig + write-journal. A clean human-owned-REGION edit
// (or a verified KW write) clean-advances the base revision; any mutation that is
// NEITHER a verified KW write NOR a human-owned-region edit — including a NEW
// assistant-domain file — becomes a conflict-review System-Health item and NEVER
// auto-advances (closes the §6 out-of-band hidden-brain hole, REQ-S-NEW-008).
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import type { RevisionId, VaultSnapshot } from "../src/knowledge-writer/revision";
import {
  reconcileVault,
  computeMutations,
  fileContentSha,
  buildJournalView,
  assertReconcileVaultBootSafe,
  type WriteJournalEntry,
  type ReconcileDeps,
  type Attribution,
} from "../src/fs-watch/reconcile";
import { renderRegion } from "../src/markdown-vault/sections";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-07-01T00:00:00.000Z";

function snap(entries: Record<string, string>): VaultSnapshot {
  return new Map(Object.entries(entries));
}

// Deterministic health-item id minter (no ambient random — keeps tests stable).
function idMinter(): () => string {
  let n = 0;
  return () => `health-${++n}`;
}

function deps(
  journalEntries: readonly WriteJournalEntry[] = [],
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return {
    journal: buildJournalView(journalEntries),
    now: () => NOW,
    newHealthItemId: idMinter(),
    auditRef: "audit-reconcile-1",
    ...overrides,
  };
}

/** A committed write-journal entry positively attributing `content@path` to KW. */
function kwCommitted(path: string, content: string, revisionId: RevisionId): WriteJournalEntry {
  return {
    path,
    contentSha: fileContentSha(content),
    revisionId,
    kwWriterSig: `sig:${revisionId}:${path}`,
    state: "committed",
  };
}

// A note with one KW-owned assistant region plus human prose around it.
const withRegion = (human: string, regionBody: string): string =>
  `${human}\n\n${renderRegion("r1", regionBody)}\n`;

// ── the reconcile core ───────────────────────────────────────────────────────

describe("computeMutations — diff between base and on-disk snapshots", () => {
  it("classifies added / modified / removed and skips unchanged files", () => {
    const base = snap({ "a.md": "A", "b.md": "B", "c.md": "C" });
    const cur = snap({ "a.md": "A", "b.md": "B2", "d.md": "D" });
    const muts = computeMutations(base, cur);
    const byPath = new Map(muts.map((m) => [m.path, m.kind]));
    expect(byPath.get("a.md")).toBeUndefined(); // unchanged → not a mutation
    expect(byPath.get("b.md")).toBe("modified");
    expect(byPath.get("c.md")).toBe("removed");
    expect(byPath.get("d.md")).toBe("added");
  });
});

describe("reconcileVault — clean advances", () => {
  it("no on-disk change is a no-op; base revision is unchanged", () => {
    const base = snap({ "a.md": "A" });
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: base },
      deps(),
    );
    expect(out.kind).toBe("noop");
    expect(out.baseRevisionId).toBe(computeRevisionId(base));
    expect(out.conflicts).toHaveLength(0);
  });

  it("a verified KW write (journal sha + valid sig) clean-advances the base", () => {
    const base = snap({ "note.md": "old" });
    const cur = snap({ "note.md": "new-by-kw" });
    const rev = computeRevisionId(cur);
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps([kwCommitted("note.md", "new-by-kw", rev)]),
    );
    expect(out.kind).toBe("clean_advance");
    expect(out.baseRevisionId).toBe(rev);
    expect(out.attributions.every((a: Attribution) => a.class === "kw_write")).toBe(true);
    expect(out.conflicts).toHaveLength(0);
    expect(out.healthItems).toHaveLength(0);
  });

  // spec(§6) — REGRESSION (adversarial verify): an out-of-band ROLLBACK of a KW
  // note to a PRIOR KW-committed byte-state must NOT be misattributed as a fresh
  // KW write (which would clean-advance the base + silently lose the newer
  // content). It is a conflict-review — the lost-update guard.
  it("a rollback to a PRIOR KW state is a conflict, not a clean advance (no lost update)", () => {
    const v1 = "kw body one";
    const v2 = "kw body two";
    const rev1 = computeRevisionId(snap({ "note.md": v1 }));
    const rev2 = computeRevisionId(snap({ "note.md": v2 }));
    const base = snap({ "note.md": v2 }); // base = the newer (current) KW state
    const cur = snap({ "note.md": v1 }); // on-disk reverted to the OLDER KW state
    const out = reconcileVault(
      { baseRevisionId: rev2, baseSnapshot: base, currentSnapshot: cur },
      // journal chronological: v1 (older) then v2 (head).
      deps([kwCommitted("note.md", v1, rev1), kwCommitted("note.md", v2, rev2)]),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.conflicts[0]).toMatchObject({ reason: "rollback_to_prior_kw_state" });
    expect(out.baseRevisionId).toBe(rev2); // base NOT advanced to the stale rev
  });

  it("a human-owned-REGION edit (assistant regions byte-stable) clean-advances", () => {
    const base = snap({ "note.md": withRegion("Human intro.", "assistant body") });
    // Human edits their own prose; the assistant region is byte-identical.
    const cur = snap({ "note.md": withRegion("Human intro, revised.", "assistant body") });
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("clean_advance");
    expect(out.baseRevisionId).toBe(computeRevisionId(cur));
    expect(out.attributions[0]?.class).toBe("human_region_edit");
  });

  it("a NEW pure-human file (no assistant regions) clean-advances", () => {
    const base = snap({});
    const cur = snap({ "human-note.md": "Just my own notes." });
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("clean_advance");
    expect(out.attributions[0]?.class).toBe("human_region_edit");
  });

  it("a KW write LANDING while still pending (on-disk == pending sha) is clean", () => {
    const base = snap({ "note.md": "old" });
    const cur = snap({ "note.md": "kw-inflight" });
    const rev = computeRevisionId(cur);
    const pending: WriteJournalEntry = {
      path: "note.md",
      contentSha: fileContentSha("kw-inflight"),
      revisionId: rev,
      kwWriterSig: "sig:pending",
      state: "pending",
    };
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps([pending]),
    );
    expect(out.kind).toBe("clean_advance");
    expect(out.attributions[0]?.class).toBe("kw_write");
  });
});

describe("reconcileVault — conflict-review (never auto-advances)", () => {
  it("a NEW assistant-domain file KW never wrote → conflict, base withheld", () => {
    const base = snap({});
    const cur = snap({ "ghost.md": withRegion("intro", "fabricated brain fact") });
    const baseRev = computeRevisionId(base);
    const out = reconcileVault(
      { baseRevisionId: baseRev, baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.baseRevisionId).toBe(baseRev); // NEVER auto-advances
    expect(out.conflicts[0]?.class).toBe("conflict");
    expect(out.conflicts[0]).toMatchObject({ reason: "new_assistant_domain_file" });
    expect(out.healthItems[0]?.failureClass).toBe("conflict_review");
    expect(out.healthItems[0]?.state).toBe("open");
    expect(out.healthItems[0]?.auditRef).toBe("audit-reconcile-1");
  });

  it("an out-of-band edit to an assistant region (not a KW write) → conflict", () => {
    const base = snap({ "note.md": withRegion("intro", "original assistant body") });
    const cur = snap({ "note.md": withRegion("intro", "TAMPERED assistant body") });
    const baseRev = computeRevisionId(base);
    const out = reconcileVault(
      { baseRevisionId: baseRev, baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.baseRevisionId).toBe(baseRev);
    expect(out.conflicts[0]).toMatchObject({ reason: "unattributed_assistant_region" });
  });

  it("a concurrent external change to a path KW has PENDING → conflict", () => {
    const base = snap({ "note.md": "old" });
    // KW has an in-flight write for note.md → "kw-wants-this"; but on disk an
    // external writer put something ELSE there (the lost-update race).
    const cur = snap({ "note.md": "external-clobber" });
    const pending: WriteJournalEntry = {
      path: "note.md",
      contentSha: fileContentSha("kw-wants-this"),
      revisionId: computeRevisionId(snap({ "note.md": "kw-wants-this" })),
      kwWriterSig: "sig:pending",
      state: "pending",
    };
    const baseRev = computeRevisionId(base);
    const out = reconcileVault(
      { baseRevisionId: baseRev, baseSnapshot: base, currentSnapshot: cur },
      deps([pending]),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.baseRevisionId).toBe(baseRev);
    expect(out.conflicts[0]).toMatchObject({ reason: "concurrent_pending_write" });
  });

  it("an assistant-region file removed out-of-band → conflict (not silent loss)", () => {
    const base = snap({ "note.md": withRegion("intro", "assistant body") });
    const cur = snap({});
    const baseRev = computeRevisionId(base);
    const out = reconcileVault(
      { baseRevisionId: baseRev, baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.baseRevisionId).toBe(baseRev);
    expect(out.conflicts[0]).toMatchObject({ reason: "assistant_file_removed" });
  });

  it("malformed region markers cannot be attributed → conflict", () => {
    const base = snap({ "note.md": "intro" });
    const cur = snap({ "note.md": "intro\n<!-- kw:region:x -->\nunclosed" });
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.conflicts[0]).toMatchObject({ reason: "malformed_markers" });
  });

  it("a sha match with a NON-verifying sig is NOT attributed to KW → conflict", () => {
    const base = snap({ "note.md": withRegion("intro", "body-A") });
    const cur = snap({ "note.md": withRegion("intro", "body-B") });
    const rev = computeRevisionId(cur);
    // Journal claims the write, but the injected verifier rejects the sig
    // (positive attribution requires a VALID kw_writer_sig, not just a sha match).
    const out = reconcileVault(
      { baseRevisionId: computeRevisionId(base), baseSnapshot: base, currentSnapshot: cur },
      deps([kwCommitted("note.md", withRegion("intro", "body-B"), rev)], {
        verifyKwSig: () => false,
      }),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.conflicts[0]?.class).toBe("conflict");
  });

  it("a mix of one clean + one conflict withholds the base advance entirely", () => {
    const base = snap({ "human.md": "v1", "ghost-base.md": "x" });
    const cur = snap({
      "human.md": "v2", // clean human edit
      "ghost-base.md": "x",
      "ghost.md": withRegion("intro", "fabricated"), // NEW assistant file → conflict
    });
    const baseRev = computeRevisionId(base);
    const out = reconcileVault(
      { baseRevisionId: baseRev, baseSnapshot: base, currentSnapshot: cur },
      deps(),
    );
    expect(out.kind).toBe("conflict_review");
    expect(out.baseRevisionId).toBe(baseRev); // ANY conflict blocks the advance
    expect(out.conflicts).toHaveLength(1);
    expect(out.healthItems).toHaveLength(1);
  });
});

// spec(§6, safety rule 1) — task 24.13: reconcileVault has zero production callers
// today, but the module must not be silently wireable into a boot path while
// `defaultVerifyKwSig` (the non-cryptographic "any non-empty string" placeholder) is
// the active verifier — that is exactly the hidden-brain hole §6 exists to close.
// `assertReconcileVaultBootSafe` is the fail-fast guard a FUTURE composition root
// must call before constructing `ReconcileDeps` for a real fs-watch boot. Path A (a
// real HMAC verifier, mirroring provenance-stamp.ts) was rejected for this slice —
// brief 249 Step 2.5 — because reconcileVault has no live consumer to validate a real
// verifier against yet, and every one of this file's existing fixtures relies on the
// permissive placeholder via non-cryptographic `kwWriterSig` stand-ins.
describe("assertReconcileVaultBootSafe — 24.13 fail-fast boot guard (Path B)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  /**
   * Census the repo for `pattern` under `roots`, returning matching FILES (relative
   * paths, sorted). Mirrors `neutralizer-single-source.test.ts`'s `censusFiles`:
   * node_modules/dist excluded so a hoisted install or stale build output can't
   * produce a false hit; a grep fault yields `[]`, which fails the assertions below
   * (fail-closed — never a false green).
   */
  function censusFiles(pattern: string, roots: string): readonly string[] {
    let out = "";
    try {
      out = execSync(
        `grep -rlE '${pattern}' ${roots} --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist || true`,
        { cwd: repoRoot, encoding: "utf8" },
      );
    } catch {
      out = "";
    }
    return out.split("\n").filter(Boolean).sort();
  }

  it("boot_guard_fires_when_reconcile_vault_wired_with_placeholder_verifier — refuses to boot with no real verifier bound", () => {
    // A composition root constructing ReconcileDeps without binding a real verifier
    // falls back to the placeholder exactly like reconcileVault itself does
    // (`deps.verifyKwSig ?? defaultVerifyKwSig`) — this is that scenario, simulated.
    expect(() => assertReconcileVaultBootSafe()).toThrow(/placeholder/i);
  });

  it("boot_guard_silent_when_real_verifier_active — a bound non-placeholder verifier never trips the guard", () => {
    expect(() => assertReconcileVaultBootSafe(() => true)).not.toThrow();
  });

  it("boot_guard_silent_when_reconcile_vault_unreachable — zero production callers today, re-pinned as a standing census", () => {
    // The exact premise grep brief 249 re-confirmed before this slice was
    // implemented, now a standing CI trip-wire instead of a one-off check: if a
    // future slice wires a real apps/ caller without reading this file, THIS test
    // goes red immediately.
    expect(censusFiles("reconcileVault|runWakeReconcile|createVaultWatcher", "apps")).toEqual([]);
  });

  it("no_production_override_of_the_verifier_machinery_exists_yet — only reconcile.ts + its own test reference the sig-verification seam", () => {
    // The sibling premise grep, pinned the same way: no production code overrides
    // the verifier machinery today — only this module and its own test reference it.
    expect(censusFiles("verifyKwSig|KwSigVerifier|defaultVerifyKwSig", "packages apps")).toEqual(
      ["packages/knowledge/src/fs-watch/reconcile.ts", "packages/knowledge/test/reconcile.test.ts"].sort(),
    );
  });
});
