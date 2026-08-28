// REACHABILITY-CLAIM DRIFT GUARD.
//
// ⛔ WHY THIS FILE EXISTS, and it is a finding about the codebase's METHOD rather than about
// any one symbol. This repo documents reachability heavily and carefully — "zero production
// callers", "no production entry point today", "NOT load-bearing today" — and those claims
// govern real safety gradings. On 2026-08-28 three of them were found stale in a single
// cluster, all in the REASSURING direction, all falsified by one event (Phase 25.1 wiring the
// output activities at the composition root):
//
//   • `proposeWindows.ts` — "NOT load-bearing today, zero production callers" on a WS-8 /
//     Flow-3 leakage guard.
//   • `visibility.ts` — a WS-8 reachability argument concluding "`sourceWorkspace` reaches
//     this function via NO production entry point today".
//   • `calendar-conflict.test.ts` — and task `### 24.47`, which asked for the eval comment to
//     be brought into line with the source, would have propagated the false one.
//
// ⭐⭐ THE PART THAT MADE THIS WORTH BUILDING RATHER THAN JUST FIXING: `visibility.ts` DID
// EVERYTHING RIGHT. It named its own re-derivation trigger in prose ("re-derive this note when
// that binding lands, don't inherit it as still true"), stated its METHOD, and pinned the
// commit it was taken at. The trigger fired anyway and nobody ran it, because
// ***NOTHING WATCHES A TRIGGER.*** A re-derivation condition written in prose is a REQUEST,
// not a MECHANISM. This file is the mechanism.
//
// WHAT IT DOES: for each symbol below it counts PRODUCTION call sites (src only, comments and
// the definition excluded) and asserts the count. Movement in EITHER direction reds — a claim
// becoming false, and equally a claim quietly becoming true again — and the failure message
// names the comment that has to be re-derived. It deliberately does not try to judge whether a
// count is "correct"; it only refuses to let one change in silence.
//
// ⚠ WHAT IT IS NOT: a call-graph analysis. A textual call-site count cannot see dynamic
// dispatch, re-exports under another name, or a symbol reached through an injected port. It is
// a TRIPWIRE on the specific measurement each comment actually made — which is the same
// measurement (grep-and-classify, src only) those comments state as their own METHOD, so the
// tripwire and the claim are commensurable. Where a comment's method differs, do not add it here.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** Production source roots — the same SRC-only boundary the audited comments use. */
const SRC_ROOTS = [
  "apps/desktop/main",
  "apps/desktop/preload",
  "apps/desktop/renderer",
  "apps/worker/src",
  "packages/contracts/src",
  "packages/db/src",
  "packages/domain/src",
  "packages/integrations/src",
  "packages/knowledge/src",
  "packages/policy/src",
  "packages/providers/src",
  "packages/workflows/src",
];

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a root that does not exist is caught by the positive control below
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const SRC_FILES: readonly string[] = SRC_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r), []));

/**
 * Is this line a comment line? LINE-LOCAL on purpose.
 *
 * ⛔ TWO EARLIER DRAFTS OF THIS WERE REGEX COMMENT-STRIPPERS AND BOTH WERE WRONG, which is
 * itself the argument for the shape below. The first collapsed a multi-line `/* … *\/` block to
 * a single line, corrupting every reported line number and MERGING real code lines. The second
 * preserved lines but could still run away: a `/*` inside a string or a regex literal swallows
 * everything to the next `*\/`, silently deleting real call sites — an UNDERCOUNT on an absence
 * guard, which is the direction that makes a stale claim look true.
 *
 * A line-local test cannot run away. It misses a trailing comment after code on the same line,
 * so a commented-out call may be counted — noise that REDS, which is the safe error for a
 * tripwire and is preferable to silence. Stated rather than left as a rough edge.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Call sites of `symbol` in production source, excluding comment lines and its own definition. */
function productionCallSites(symbol: string): string[] {
  const re = new RegExp(`\\b${symbol}\\b`);
  const defRe = new RegExp(
    `(export\\s+)?(async\\s+)?function\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b`,
  );
  const hits: string[] = [];
  for (const file of SRC_FILES) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (isCommentLine(line) || !re.test(line) || defRe.test(line)) return;
        hits.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`);
      });
  }
  return hits;
}

interface Claim {
  readonly symbol: string;
  /** Production call sites measured 2026-08-28. An `import` line counts — it is a real edge. */
  readonly sites: number;
  /** The comment(s) whose claim this pins. Named so a red says where to go. */
  readonly claimedAt: string;
  readonly says: string;
}

const CLAIMS: readonly Claim[] = [
  {
    symbol: "admitAndPersistProjection",
    sites: 0,
    claimedAt: "packages/policy/src/visibility.ts (the WS-8 reachability argument, WRITE leg)",
    says: "ZERO production callers; every call site is packages/knowledge/test/gcl-projection.test.ts",
  },
  {
    symbol: "resolveApprovedCrossWorkspaceSlice",
    sites: 0,
    claimedAt: "packages/policy/src/visibility.ts (READ leg 2) + packages/knowledge/src/gcl/projection.ts",
    says: "ZERO production callers of its own; ships behind a reachability waiver until 25.2/25.4",
  },
  {
    symbol: "createGclProjectionGate",
    sites: 2,
    claimedAt: "packages/policy/src/visibility.ts (READ leg 1)",
    says: "reached from createOutputWorkflowActivities — the leg that went LIVE and falsified the note's conclusion",
  },
  {
    symbol: "createProposeWindowsActivity",
    sites: 2,
    claimedAt: "packages/workflows/src/activities/proposeWindows.ts + the calendar-conflict eval suite",
    says: "the Flow-3 leakage guards' host: BOUND and REGISTERED, schedule trigger default-OFF (25.4)",
  },
  {
    symbol: "serveProjection",
    sites: 4,
    claimedAt: "packages/policy/src/visibility.ts (both READ legs terminate here)",
    says: "reached from gclProjectionGate (LIVE to the composition root) and crossWorkspaceRead (still dormant)",
  },
  {
    symbol: "createOutputWorkflowActivities",
    sites: 2,
    claimedAt: "packages/policy/src/visibility.ts",
    says: "the single event that falsified all three claims — it IS called from buildActivities.ts",
  },
];

describe("reachability-claim drift guard", () => {
  it("POSITIVE CONTROL: the scan actually reads production source", () => {
    // Without this, every count below would be 0 and every claim of absence would "hold"
    // vacuously — the exact failure this file exists to prevent, committed by the file itself.
    expect(SRC_FILES.length).toBeGreaterThan(500);
    expect(productionCallSites("createOutputWorkflowActivities").length).toBeGreaterThan(0);
    // …and that a symbol with call sites in MORE THAN ONE package is seen in both, so a scan
    // that silently stopped after the first root would red here.
    const spread = new Set(productionCallSites("serveProjection").map((s) => s.split("/")[0]));
    expect(spread.size).toBeGreaterThan(1);
    // ⚠ `bootWorker` was this control's first draft and it measures ZERO — correctly: it is an
    // exported entry point whose callers are the host/bin, outside these SRC roots. Recorded
    // because it looks like a scan failure and is not, and the next person will reach for it.
  });

  it("INSTRUMENT CONTROL: a symbol that does not exist scans to zero", () => {
    // Guards the other direction — a broken regex that matched everything would make every
    // count wrong in the passing direction for the absence claims.
    expect(productionCallSites("zzNoSuchSymbolAnywhereInThisRepo")).toEqual([]);
  });

  for (const c of CLAIMS) {
    it(`${c.symbol} has ${c.sites} production call site(s) — pins: ${c.says}`, () => {
      const sites = productionCallSites(c.symbol);
      expect(
        sites.length,
        `\nReachability DRIFT for \`${c.symbol}\`.\n` +
          `  expected ${c.sites} production call site(s), measured ${sites.length}:\n` +
          sites.map((s) => `    ${s}\n`).join("") +
          `\n  A prose claim about this symbol lives at:\n    ${c.claimedAt}\n` +
          `  and currently says: "${c.says}"\n\n` +
          `  ⛔ RE-DERIVE THAT COMMENT, then update this expectation — in that order.\n` +
          `  Do NOT just bump the number: on 2026-08-28 three such comments were stale in the\n` +
          `  REASSURING direction at once, one of them a WS-8 reachability argument, and the\n` +
          `  count moving is the only signal that a safety grading rested on a dead premise.\n`,
      ).toBe(c.sites);
    });
  }
});
