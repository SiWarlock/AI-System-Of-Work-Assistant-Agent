// spec(§6 KN-10/KN-12, safety rule 1) — 13.8k the GROUNDED-PATH SHAPE INVARIANT: every path entering
// the grounded set is shape-validated, WHOEVER produced it. 13.8j closed the stub-MINTING door by
// namespacing; this closes the other route to the same violation — `resolveEntity` returns
// `candidate.path` VERBATIM from an untrusted GBrain row, shape-guarded only as a non-empty string,
// so a poisoned row carrying `path: "index.md"` plus a faithfully-matching title resolves there and
// the model may then patch the writer-owned navigation catalog.
//
// The deliverable is the INVARIANT, not a guard at one call site: refusal is decided in ONE place
// (`admitGroundedPath`) that every producer routes through, pinned structurally so a second
// unguarded entry point fails.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { ok, workspaceId } from "@sow/contracts";
import type { ProvenanceOrigin, KnowledgeMutationPlan } from "@sow/contracts";
import { admitGroundedPath } from "../src/synthesis/grounded-path";
import { rewriteVaultForSource } from "../src/synthesis/ingest-rewrite";
import { rewriteVaultForMeeting } from "../src/synthesis/meeting-rewrite";
import {
  STRUCTURAL_INDEX_PATH,
  STRUCTURAL_LOG_POINTER_PATH,
  STRUCTURAL_LOGS_DIR,
} from "../src/markdown-vault/structural-files";

const admitted = (p: unknown): string | null => {
  const r = admitGroundedPath(p);
  return r.ok ? r.path : null;
};

// ── 1. the writer-owned structural surfaces are unreachable ──────────────────────────

describe("admitGroundedPath — KN-12 structural surfaces can never be grounded (safety rule 1)", () => {
  it("structural_surface_path_refused — index.md / log.md / Logs/<date>.md are writer-owned", () => {
    for (const p of ["index.md", "log.md", "Logs/2026-07-26.md", "Logs/anything.md"]) {
      const r = admitGroundedPath(p);
      expect(r.ok, `${p} was admitted`).toBe(false);
      expect(r.ok ? null : r.reason).toBe("structural_surface");
    }
  });

  it("owned_surface_set_is_derived_not_relisted — the guard traces to structural-files.ts, not a local list", () => {
    // A hand-copied list is the denylist-drift failure (L64/L65): if structural-files.ts gains or
    // renames a surface, the guard must inherit it rather than silently fall out of date.
    expect(admitGroundedPath(STRUCTURAL_INDEX_PATH).ok).toBe(false);
    expect(admitGroundedPath(STRUCTURAL_LOG_POINTER_PATH).ok).toBe(false);
    expect(admitGroundedPath(`${STRUCTURAL_LOGS_DIR}/2026-01-01.md`).ok).toBe(false);
    // the source file must not re-declare the literals — it imports them
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/synthesis/grounded-path.ts"),
      "utf8",
    );
    expect(src).toContain("structural-files");
    // strip comments first — the module header legitimately DISCUSSES index.md in prose; what must
    // not exist is a re-declared literal in CODE (that would be the hand-copied list, drifting).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.includes('"index.md"'), "re-listed index.md instead of importing it").toBe(false);
    expect(code.includes('"log.md"'), "re-listed log.md instead of importing it").toBe(false);
    expect(code.includes('"Logs"'), "re-listed the Logs dir instead of importing it").toBe(false);
    // non-vacuity: the detector does catch a re-listed literal in code
    expect('const OWNED = ["index.md"];'.includes('"index.md"')).toBe(true);
  });
});

// ── 2. a non-empty check is not a path check ─────────────────────────────────────────

describe("admitGroundedPath — shape-invalid paths are refused (a string is not a path)", () => {
  it("shape_invalid_paths_refused — absolute, traversal, separator, control, extension", () => {
    const invalid = [
      "/etc/passwd.md", // absolute
      "/index.md",
      "../secrets.md", // traversal
      "people/../../etc/x.md",
      "people/..",
      "people\\jane.md", // backslash separator
      "people/jane\u0000.md", // NUL
      "people/jane\n.md", // control char
      "people/jane\t.md",
      "", // empty
      "   ", // empty after trim
      "people/jane", // no .md
      "people/jane.txt",
      "people/jane.md.exe",
    ];
    for (const p of invalid) {
      expect(admitGroundedPath(p).ok, `${JSON.stringify(p)} was admitted`).toBe(false);
    }
    // non-string inputs are refused rather than coerced
    for (const p of [null, undefined, 42, {}, []]) {
      expect(admitGroundedPath(p as unknown).ok).toBe(false);
    }
  });

  it("legitimate_resolved_path_is_untouched — admitted paths come back BYTE-identical", () => {
    // The constraint that rules out the naive fix: grounding matches on exact strings, so a guard
    // that normalized/prefixed would silently break every match while looking like a success.
    for (const p of [
      "people/jane-doe.md",
      "projects/acme-api.md",
      "concepts/rate-limiting.md",
      "meetings/ws-a/2026-07-26-standup.md",
      "sources/ws-a/5090325d20ea3f748e7af417f3c85e79.md",
      "entities/whatever.md",
      "Some Folder/A Note With Spaces.md", // spaces are legal in a vault path
      "people/José Núñez.md", // non-ASCII is legal
    ]) {
      expect(admitted(p), `${p} should be admitted verbatim`).toBe(p);
    }
  });

  it("refusal_withholds_never_sanitizes — a refused path yields a REASON, never a repaired path", () => {
    // Sanitizing would invent a target the GBrain row never claimed (no-inference).
    const r = admitGroundedPath("../../index.md");
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]); // no `path`, no suggestion
    expect(JSON.stringify(r)).not.toContain("index");
  });

  it("withheld_reason_is_code_only — the refusal never echoes the candidate path (rule 7)", () => {
    // GBrain-derived content is untrusted and may carry PII / employer-work content.
    const secret = "people/secret-person-at-employer-internal.md";
    const r = admitGroundedPath(`/${secret}`);
    expect(r.ok).toBe(false);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("secret-person");
    expect(serialized).not.toContain("employer-internal");
    expect(["structural_surface", "unsafe_shape"]).toContain(r.ok ? "" : r.reason);
  });
});

// ── 2b. the guard covers the CANONICAL surfaces — pin that nothing overrides them ────

describe("the owned-surface constants are not overridden by any production caller (13.8k)", () => {
  it("no_production_caller_passes_a_custom_structural_path — the guard's coverage is complete in practice", () => {
    // The surfaces are still *parameterized* (`buildIndexSectionPatches(indexPath, …)`, and
    // `logsDir`/`pointerPath` opts), so a caller COULD name a structural path the guard doesn't know
    // about. Rather than widen the slice by making them non-configurable, pin that no production
    // call site overrides them: if a future caller genuinely needs a custom structural path, this
    // fails and THAT is the moment to decide whether the guard must learn about it.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const roots = ["packages/knowledge/src", "packages/workflows/src", "apps/worker/src", "apps/desktop/src", "apps/desktop/main"];
    const walk = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? e.name === "node_modules" || e.name === "dist"
              ? []
              : walk(join(dir, e.name))
            : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
              ? [join(dir, e.name)]
              : [],
        );
      } catch {
        return [];
      }
    };
    const CALL = /\b(buildIndexSectionPatches|buildOpLogMutations)\s*\(/;
    const LITERAL_ARG = /\b(buildIndexSectionPatches\s*\(\s*"|logsDir\s*:\s*"|pointerPath\s*:\s*")/;
    const scanned = roots.flatMap((r) => walk(join(repoRoot, r)));
    // the scan must have a SUBJECT — otherwise "no offenders" only proves the roots are wrong
    expect(scanned.length, "the production scan found no files — roots are misconfigured").toBeGreaterThan(100);
    const offenders = scanned
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return CALL.test(src) && LITERAL_ARG.test(src);
      });
    // NOTE today there are ZERO production callers of either builder, so this pin is ARMED for the
    // first one rather than policing an existing one. It is a per-FILE heuristic (a literal elsewhere
    // in a calling file would false-positive; a variable argument would be missed).
    expect(offenders, "a production caller names a structural path the guard cannot see").toEqual([]);
    // non-vacuity: the detector really does catch an overriding call
    expect(LITERAL_ARG.test('buildIndexSectionPatches("custom-index.md", sections)')).toBe(true);
    expect(LITERAL_ARG.test('buildOpLogMutations({ date, entry, logsDir: "Journal" })')).toBe(true);
  });
});

// ── 3. ONE enforcement point — what makes this an invariant, not a patched call site ──

describe("the grounded-path invariant has a SINGLE enforcement point (13.8k)", () => {
  it("invariant_has_one_enforcement_point — every grounded-set write routes through the guard", () => {
    // This is the difference between closing the CLASS and closing the instance: a future producer
    // that adds its own `grounded.add(...)` without admission must fail this pin.
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      );
    const files = walk(srcRoot);
    const mutations = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ file: f, line: i + 1, text: line }))
        .filter((l) => /\bgrounded\.add\(|\bgroundedPaths\.push\(/.test(l.text)),
    );
    expect(mutations.length, "grounded-set writes exist at all (non-vacuous)").toBeGreaterThan(0);
    // every one lives in the single admission helper's file, inside the guarded function
    for (const m of mutations) {
      expect(m.file.endsWith("meeting-rewrite.ts"), `grounded-set write outside the admission module: ${m.file}:${m.line}`).toBe(true);
    }
    const src = readFileSync(resolve(srcRoot, "synthesis/meeting-rewrite.ts"), "utf8");
    const lines = src.split("\n");
    const startLine = lines.findIndex((l) => l.includes("function admitInto")) + 1;
    expect(startLine, "the admission helper must exist").toBeGreaterThan(0);
    const endOffset = lines.slice(startLine - 1).findIndex((l, i) => i > 0 && l === "}");
    const endLine = startLine + endOffset;
    // LOCATION, not text: a text-inclusion check passed a write placed OUTSIDE the helper whose
    // source line happened to match one inside it — i.e. exactly the bypass this pin exists to catch.
    for (const m of mutations) {
      expect(
        m.line >= startLine && m.line <= endLine,
        `unguarded grounded-set write at ${m.file}:${m.line}`,
      ).toBe(true);
    }
    // and the helper must actually consult the guard — deleting the call must not leave this green
    expect(lines.slice(startLine - 1, endLine).join("\n")).toContain("admitGroundedPath(");
    // non-vacuity: the detector really does match the construction it polices
    expect(/\bgrounded\.add\(|\bgroundedPaths\.push\(/.test("      grounded.add(somePath);")).toBe(true);
  });
});

// ── 13.8l — the PROPERTY pin, spanning BOTH synthesis entry points ────────────────────
//
// ⚠ Deliberately NOT "admitGroundedPath is called on the source path" — that is a MECHANISM pin, and
// this task's own history is the L70 trap twice (13.8j applied a namespace through an object-literal
// lookup that `__proto__` walked back to the root; 13.8k called the admission on every path but
// returned true for an already-grounded one). Both times the mechanism was present and the property
// was false. So this drives the REAL entry points with a hostile corpus and asserts the property:
//
//     no writer-owned KN-12 surface can enter a synthesis output, by ANY route.

describe("the grounded-path invariant holds across BOTH synthesis paths (13.8l)", () => {
  const OWNED = [STRUCTURAL_INDEX_PATH, STRUCTURAL_LOG_POINTER_PATH, `${STRUCTURAL_LOGS_DIR}/2026-07-26.md`];
  const WS = workspaceId("ws-a"); // 24.92: real branded constructor, not an anonymous cast

  const planTargets = (plans: readonly KnowledgeMutationPlan[]): string[] =>
    plans.flatMap((p) => [
      ...p.creates.map((c) => c.path),
      ...p.patches.map((x) => x.path),
      ...p.frontmatterUpdates.map((f) => f.path),
      ...p.linkMutations.map((l) => l.srcPath),
    ]);

  it("no_owned_surface_enters_any_synthesis_output — SOURCE path, every mutation kind", async () => {
    for (const owned of OWNED) {
      for (const effect of ["new_note", "new_region", "refresh"] as const) {
        const receipt = await rewriteVaultForSource(
          {
            workspaceId: WS,
            provenanceOrigin: "ingestion" as ProvenanceOrigin,
            sourceRefs: [{ sourceId: "s1" }],
          },
          {
            gbrain: { workspaceId: WS, findCandidates: async () => ok([]) },
            reason: {
              reason: async () => ({
                regions: [{ notePath: owned, regionId: "hijack", body: "x", effect }],
                frontmatter: [{ notePath: owned, key: "owner", value: "x", evidenceRef: "s1#a" }],
                links: { srcPath: owned, refs: [{ title: "Anything" }] },
              }),
            },
            sections: { describe: () => ({ generatedRegionIds: ["hijack"] }) },
            structural: { build: () => ({}) },
            newPlanId: () => "p1",
            newRunId: () => "r1",
          },
        );
        expect(planTargets(receipt.plans), `SOURCE/${effect} leaked ${owned}`).not.toContain(owned);
      }
    }
  });

  it("no_owned_surface_enters_any_synthesis_output — MEETING path (13.8k's routes, re-pinned here)", async () => {
    for (const owned of OWNED) {
      const receipt = await rewriteVaultForMeeting(
        {
          workspaceId: WS,
          provenanceOrigin: "meeting_close" as ProvenanceOrigin,
          meetingNotePath: "meetings/m.md",
          sourceRefs: [{ sourceId: "s1" }],
          entityRefs: [{ name: "Anything", kind: "person" }],
        },
        {
          gbrain: {
            workspaceId: WS,
            // a POISONED row: faithfully matching title, but its path is a writer-owned surface
            findCandidates: async () => ok([{ path: owned, slug: "anything", title: "Anything", workspaceId: WS }]),
          },
          reason: {
            reason: async () => ({ regions: [{ notePath: owned, regionId: "hijack", body: "x", effect: "new_note" }] }),
          },
          sections: { describe: () => ({ generatedRegionIds: [] }) },
          newPlanId: () => "p1",
          newRunId: () => "r1",
        },
      );
      expect(planTargets(receipt.plans), `MEETING leaked ${owned}`).not.toContain(owned);
      expect(receipt.groundedPaths, `MEETING grounded ${owned}`).not.toContain(owned);
    }
  });

  it("non-vacuity — the SAME harness DOES admit a legitimate note, so the pins are not passing by refusing everything", async () => {
    const receipt = await rewriteVaultForSource(
      { workspaceId: WS, provenanceOrigin: "ingestion" as ProvenanceOrigin, sourceRefs: [{ sourceId: "s1" }] },
      {
        gbrain: { workspaceId: WS, findCandidates: async () => ok([]) },
        reason: {
          reason: async () => ({
            regions: [{ notePath: "notes/ordinary.md", regionId: "body", body: "x", effect: "new_note" }],
          }),
        },
        sections: { describe: () => ({ generatedRegionIds: [] }) },
        structural: { build: () => ({}) },
        newPlanId: () => "p1",
        newRunId: () => "r1",
      },
    );
    expect(planTargets(receipt.plans)).toContain("notes/ordinary.md");
  });
});
