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
import { runFsExtractLinksDryRun } from "../src/gbrain/scratch-brain";

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
      "BLOCKED (this leg only): (a)/(b) require a real `gbrain put`/`dream` call, which triggers a REAL PAID Voyage embedding-API write per this session's own `gbrain put --help` ('Chunks, embeds...') — out of scope for a read-only acceptance suite without explicit owner cost authorization (root CLAUDE.md 'nothing arms' / 'no real external write').",
  );

  it.todo(
    "GO#4 round-trip-lossless LIVE: a real KW-write → commit → import/sync → DB → rebuild-oracle → compare cycle, asserting SEMANTIC-field equality AND doctor embeddings/embedding_provider GREEN. " +
      "The fs-extract corroborating-oracle leg above IS built and live-verified (no embedding needed). " +
      "BLOCKED (the full cycle): needs real embeddings (real paid Voyage API write — same constraint as GO#3) PLUS a live KnowledgeWriter→Temporal commit pipeline (apps/worker territory). " +
      "ALSO: this session measured the REAL doctor `embedding_provider` check FLAKY against the pinned installed brain — two consecutive live `gbrain doctor --json` calls (no code change between them) flipped ok/'1024 dims, DB aligned' → warn/'Voyage model \"voyage-code-3\" supports output_dimension only in {256, 512, 1024, 2048}, got 1536' — so 'doctor embeddings/embedding_provider GREEN' is not currently a STABLE live precondition even where reachable; recorded here as a real Finding, not silently assumed green.",
  );

  it.todo(
    "GO#1-adjacent: ContainedSynthesisGate leak + common-mode-malicious-gbrain cases (§12.7's 'plus' bullets) — same BLOCKED reasons as GO#1/GO#3 above (needs the write-fence/OS-lockdown wiring + a real generative call).",
  );
});
