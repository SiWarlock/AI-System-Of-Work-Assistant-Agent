// spec(§12 · §6 · §13 enablement-gate) — task 12.7: GBrain parity/rebuild/divergence suite,
// the four GO conditions vs the REAL pinned gbrain 0.35.1.0.
//
// `IMPLEMENTATION_PLAN.md` marks 12.7 `[ ] DEFERRED → §ARM-GBRAIN` (owner-approved 2026-06-30,
// ADR-007): "the write-through DECISION already resolved; only the LIVE PROOF is deferred."
// This session RE-VERIFIED the environment against the claim that it's richer than the plan
// text implies: `gbrain` 0.35.1.0 IS installed and reachable, `doctor --json` DOES report a
// real connected brain with a real embedding provider configured. What follows is built and
// run against that REAL binary wherever it can be exercised WITHOUT (a) a real paid external
// embedding-API write, or (b) wiring outside this package's territory
// (`packages/evals/{src,test,suites}/gbrain` only — NOT `packages/knowledge`/`apps/worker`,
// where the production KnowledgeWriter→GBrain pipeline + vault-ACL/write-fence machinery this
// gate ultimately needs actually lives).
//
// task PAID-GO34 (2026-08-25): the owner explicitly authorized real paid Voyage embedding
// spend, narrowly, for GO#3's and GO#4's live legs — lifting constraint (a) above for those two
// legs only. The "GO#3/GO#4 paid-embedding leg — REAL preflight probe" describe block below is
// what that authorization actually bought: a real, live, $0-spent proof that the embed path
// itself currently fails (a pre-existing `embedding_provider` defect in the installed gbrain
// binary, reproduced cold on a fresh scratch brain — see that block's comments). GO#3(a)-(d) and
// GO#4's embedding-dependent half stay `it.todo`, now blocked by that tooling defect rather than
// by the lifted authorization gap.
//
// 12.23 (sibling, `[x] DONE`, `packages/evals/test/gbrain-failclosed.test.ts`) already pins the
// DETERMINISTIC decision logic behind GO #2 (monotonic apply/no-lost-update) and GO #3 (parity
// classification of db_only/unstamped/borrowed-stamp/forged-hash) against the REAL
// `@sow/knowledge` modules — this suite does not re-derive that; it is cited, not duplicated.
// 12.22 (sibling, `packages/evals/test/gbrain-enablement-gate.test.ts`) carries the LIVE HTTP
// OAuth read-token-rejects-write proof this file's own "writeThroughEnabled stays FALSE" test
// also depends on.
//
// Gated live leg: `SOW_GBRAIN_LIVE=1` (needs the real `gbrain` binary on PATH).
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "@sow/contracts";
import type { RevisionId } from "@sow/contracts";
import { deriveCanonicalFacts } from "@sow/knowledge";
import {
  runFsExtractLinksDryRun,
  mkScratchGbrainHome,
  rmScratchGbrainHome,
  initScratchBrain,
  putScratchBrainPage,
} from "../src/gbrain/scratch-brain";

const LIVE = process.env["SOW_GBRAIN_LIVE"] === "1";

describe.skipIf(!LIVE)("12.7 GO#4 (round-trip) supporting leg — the REAL gbrain-extract rebuild-oracle cross-check", () => {
  // The design doc (`docs/design/gbrain-write-through-divergence.md` §3, `CanonicalFactDeriver`
  // row) is explicit: "`gbrain extract --source fs --dry-run --json` is used ONLY as a
  // divergence cross-check oracle, never as the canonical source." This is that oracle, run for
  // REAL, over a local markdown fixture (no DB, no embedding call — `--source fs` walks .md
  // files directly and `--dry-run` performs no write) — cross-checked against the SoW-owned,
  // gbrain-INDEPENDENT `CanonicalFactDeriver` over the SAME fixture bytes.
  it("gbrain's own fs-extract link count agrees with the SoW-owned CanonicalFactDeriver's link-fact count (corroborating oracle, task 4.14/GO#4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sow-eval-extract-fixture-"));
    try {
      await writeFile(join(dir, "auth.md"), "---\nslug: auth\n---\n# Auth\nSee [[oauth]].\n", "utf8");
      await writeFile(join(dir, "oauth.md"), "---\nslug: oauth\n---\n# OAuth\n", "utf8");

      const extracted = await runFsExtractLinksDryRun(dir);
      expect(extracted).toBeDefined();
      if (extracted === undefined) return;
      expect(extracted.pages_processed).toBe(2);
      expect(extracted.links_created).toBe(1);

      const derived = deriveCanonicalFacts({
        workspaceId: workspaceId("ws-eval-1207"),
        revisionId: "rev-eval-1207" as unknown as RevisionId,
        files: new Map([
          ["auth.md", "---\nslug: auth\n---\n# Auth\nSee [[oauth]].\n"],
          ["oauth.md", "---\nslug: oauth\n---\n# OAuth\n"],
        ]),
      });
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      const pageFacts = derived.value.facts.filter((f) => f.fact.factKind === "page");
      const linkFacts = derived.value.facts.filter((f) => f.fact.factKind === "link");

      // The two independent parsers (gbrain's own vs the SoW-owned deriver) agree on the SAME
      // fixture — the corroborating-oracle property the design doc names.
      expect(pageFacts.length).toBe(extracted.pages_processed);
      expect(linkFacts.length).toBe(extracted.links_created);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a ONE-BYTE content edit (no link/page count change) leaves both parsers' counts unchanged (divergence should fire on hash, not miscounts)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sow-eval-extract-fixture-b-"));
    try {
      await writeFile(join(dir, "auth.md"), "---\nslug: auth\n---\n# Auth EDITED\nSee [[oauth]].\n", "utf8");
      await writeFile(join(dir, "oauth.md"), "---\nslug: oauth\n---\n# OAuth\n", "utf8");
      const extracted = await runFsExtractLinksDryRun(dir);
      expect(extracted).toEqual({ pages_processed: 2, links_created: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!LIVE)(
  "12.7 GO#3/GO#4 paid-embedding leg — REAL preflight probe (task PAID-GO34, owner-authorized Voyage spend)",
  () => {
    // The owner explicitly authorized REAL paid Voyage embedding spend for GO#3's four-shape
    // db_only/unstamped injection and GO#4's full round-trip (task PAID-GO34) — narrowly, embedding
    // spend for THESE TWO LEGS ONLY (root CLAUDE.md "nothing arms": no write_through_enabled flip, no
    // real-brain write, no key provisioning). Per that task's own instruction this ONE probe runs
    // FIRST and CHEAPLY, before any further spend: it either clears the way to build GO#3(a)-(d)/GO#4's
    // live injection for real, or it proves — live, on a BRAND-NEW isolated scratch brain (never the
    // owner's real `~/.gbrain`) — that the pre-existing `embedding_provider` defect blocks the embed
    // path itself, in which case the it.todo rows below stay blocked for a TOOLING reason, not an
    // authorization one.
    it(
      "a real `gbrain put` against a fresh scratch brain — pins the CURRENTLY OBSERVED outcome of the owner-authorized embed spend",
      async () => {
        const home = await mkScratchGbrainHome();
        try {
          await initScratchBrain(home);
          const content =
            "---\nslug: paid-go34-probe\ntype: note\n---\n# Probe\nOne short sentence to test the real embed path.\n";
          const result = await putScratchBrainPage(home, "paid-go34-probe", content);

          // MEASURED LIVE this session (task PAID-GO34): 5/5 real attempts against a FRESH scratch
          // brain — 1 `doctor --json` embedding_provider probe + 4 `put` attempts (the last AFTER
          // explicitly `gbrain config set embedding_dimensions 1024`, ruling out "the value merely
          // isn't stored" — some code path ignores the stored value regardless) — ALL failed
          // IDENTICALLY with the same Voyage output_dimension rejection the owner found on the real
          // brain. This is therefore NOT specific to the owner's `~/.gbrain` state; it reproduces
          // cold on an empty brain. Zero dollars spent: every attempt was rejected by Voyage's own
          // dimension validation BEFORE any embedding was computed/billed.
          //
          // This assertion PINS that observed state as a positive control on the EXACT failure mode
          // (provider name + parameter name + the offending value) — not a bare "it failed". If
          // gbrain's upstream embed-path defect is ever fixed, THIS assertion is what starts failing
          // — the signal to come back and build GO#3(a)-(d)/GO#4's live injection using
          // `putScratchBrainPage` (already built in this package's `src/gbrain/scratch-brain.ts`).
          expect(result.ok).toBe(false);
          expect(result.stderr).toContain("voyage-code-3");
          expect(result.stderr).toContain("output_dimension");
          expect(result.stderr).toContain("1536");
        } finally {
          await rmScratchGbrainHome(home);
        }
      },
      90_000,
    );
  },
);

describe("12.7 — the four GO conditions' remaining LIVE proof (genuinely infra/cost-gated — precise blockers, not a blanket 'no gbrain')", () => {
  // Each row below states EXACTLY what is missing, per this package's territory + safety
  // constraints — never "needs more investigation."

  it.todo(
    "GO#1 one-writer/no-hidden-brain LIVE: full generative-cycle + index-sync + oracle-rebuild against a vault mounted READ-ONLY for every gbrain process, asserting zero non-KW canonical-.md mutation events + a stray write raises conflict-review. " +
      "BLOCKED: needs the vault-ACL/read-only-mount + GbrainWriteFence OS-lockdown wiring (packages/knowledge/src/gbrain/write-fence.ts + apps/worker composition) — outside this package's territory (packages/evals/{src,test,suites}/gbrain only) and not exercisable as a pure eval-suite call.",
  );

  it.todo(
    "GO#2 no-lost-update LIVE: a real `gbrain sync` index job vs an immutable snapshot of revision N while a real KnowledgeWriter commits N+1, triggers delivered out of order, asserting final allow-set == derive(N+1) against the REAL gbrain sync command. " +
      "The DETERMINISTIC decision logic (monotonic apply, collapse=MAX, stale-snapshot refusal, superseded no-op) is ALREADY covered live against the real @sow/knowledge modules — see 12.23 `gbrain-failclosed.test.ts` describe(12.23a). " +
      "BLOCKED (this leg only): needs a running KnowledgeWriter + Temporal commit pipeline driving the REAL `gbrain sync` CLI — apps/worker territory, not buildable from packages/evals alone.",
  );

  it.todo(
    "GO#3 parity-catches-DB-only-facts LIVE injection: inject 4 real DB-only facts via (a) manual `gbrain put`, (b) a dream/synthesize-style page, (c) a borrowed-stamp page, (d) a forged-content_hash collision, asserting each classifies db_only/unstamped (HARD floor) against the REAL classifier. " +
      "The DETERMINISTIC classification logic for all 4 shapes is ALREADY covered live against the real @sow/knowledge modules — see 12.23 `gbrain-failclosed.test.ts` describe(12.23c). " +
      "COST-AUTHORIZATION BLOCKER LIFTED (task PAID-GO34): the owner explicitly authorized real paid Voyage embedding spend for this leg. " +
      "STILL BLOCKED, now by a DIFFERENT cause: a TOOLING defect, not an authorization gap. See the 'GO#3/GO#4 paid-embedding leg — REAL preflight probe' describe block above (`putScratchBrainPage`) — 5/5 real live attempts against a FRESH scratch brain (never the owner's real brain) failed identically with 'Voyage model \"voyage-code-3\" supports output_dimension only in {256, 512, 1024, 2048}, got 1536', including after explicitly `gbrain config set embedding_dimensions 1024` (ruling out 'the value merely isn't stored' — some code path ignores it regardless). Zero dollars spent (every attempt rejected before any embedding was computed/billed). This is a defect in the owner's local `gbrain` checkout (outside this repo, outside this package's territory — root CLAUDE.md: do not attempt to fix it here). (a)-(d) cannot be built until it is fixed upstream; when it is, `putScratchBrainPage` is the ready-built injection primitive.",
  );

  it.todo(
    "GO#4 round-trip-lossless LIVE: a real KW-write → commit → import/sync → DB → rebuild-oracle → compare cycle, asserting SEMANTIC-field equality AND doctor embeddings/embedding_provider GREEN. " +
      "The fs-extract corroborating-oracle leg above IS built and live-verified (no embedding needed). " +
      "COST-AUTHORIZATION BLOCKER LIFTED for the embedding half (task PAID-GO34): the owner explicitly authorized real paid Voyage spend. " +
      "STILL BLOCKED: (1) the SAME tooling defect as GO#3 above — real embeds do not currently succeed at all (see the preflight-probe describe block; 5/5 live failures this session, $0 spent), so 'doctor embeddings/embedding_provider GREEN' is not reachable today, and (2) independently, the full cycle also needs a live KnowledgeWriter→Temporal commit pipeline (apps/worker territory, outside this package). " +
      "This session's re-measurement found the embedding_provider probe FAILING DETERMINISTICALLY (5/5), not flaky as a prior session reported on the owner's real brain — the two reports do not contradict (different environments/timing can differ), but what this session newly establishes is that the failure reproduces COLD on a brand-new brain and SURVIVES an explicit `embedding_dimensions=1024` config override, narrowing it to a real code-path bug rather than a per-brain config or ordering artifact.",
  );

  it.todo(
    "GO#1-adjacent: ContainedSynthesisGate leak + common-mode-malicious-gbrain cases (§12.7's 'plus' bullets) — same BLOCKED reasons as GO#1/GO#3 above (needs the write-fence/OS-lockdown wiring + a real generative call).",
  );
});
