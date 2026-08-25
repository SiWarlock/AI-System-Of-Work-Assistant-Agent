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
// legs only. task PAID-GO34-RETRY (2026-08-25, same day): the owner fixed the root cause found
// by PAID-GO34 — `~/.gbrain/config.json` was missing `embedding_dimensions`, so gbrain's
// pre-engine-connect `configureGateway` fell back to `DEFAULT_EMBEDDING_DIMENSIONS = 1536`,
// which Voyage's `voyage-code-3` model rejects outright (it only permits {256,512,1024,2048}).
// That fix is RE-CONFIRMED live this session (`gbrain doctor --json` on the real brain: 1024
// dims, DB aligned) and is now folded into every SCRATCH brain too, unconditionally, inside
// `initScratchBrain` (`../src/gbrain/scratch-brain.ts`) — see that function's doc comment for
// the full trap + fix.
//
// That fix genuinely holds at the layer it targets: a scratch `gbrain put` no longer gets
// rejected by Voyage before any embedding is computed. But this session ALSO found — live,
// reading the installed `gbrain` 0.35.1.0 source at `/Users/dreddy/gbrain` (a different repo,
// not fixed here) — a SEPARATE, deeper, PGLite-specific defect one layer down: the
// embedded/PGLite schema hardcodes `embedding vector(1536)`
// (`src/core/schema-embedded.ts:139`) and never receives the dimension substitution the
// Postgres/Supabase engine path gets (`src/core/postgres-engine.ts:57`), regardless of
// `--embedding-dimensions`/config. So a fresh scratch PGLite brain's vector column is ALWAYS
// 1536-wide while `voyage-code-3` can only emit {256,512,1024,2048} — no value satisfies both.
// `put`/`embed` still fails on a fresh scratch brain, now one layer deeper: at the DB-insert
// step (pgvector: "expected 1536 dimensions, not 1024") AFTER a real, billed Voyage call
// succeeds. The "GO#3/GO#4 paid-embedding leg — REAL preflight probe" describe block below pins
// this NEW state (confirmed via 3 real, minimal, owner-authorized billed `put` attempts this
// session — each a single short sentence). GO#3(a)-(d) and GO#4's embedding-dependent half stay
// `it.todo`, now blocked by this NEW, more precise tooling defect — the injection primitive
// (`putScratchBrainPage`, the exact mechanism GO#3 names) cannot land ANY page on a fresh
// scratch brain today, so there is nothing yet to classify. GO#4's round-trip leg is extended
// instead in the direction that doesn't need embeddings at all: a real `gbrain import
// --no-embed` DB write (genuinely $0 — no Voyage call), corroborated against the same
// fs-extract oracle.
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
  runScratchGbrainImportNoEmbed,
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

  // task PAID-GO34-RETRY: extends the round-trip one link further — from a read-only fs walk to
  // a REAL DB write on a scratch brain — WITHOUT touching the paid-embedding path at all.
  // `--no-embed` makes zero Voyage calls (live-verified: `gbrain import --no-embed --json`
  // returns real `imported`/`chunks` counts with no network embedding call). The
  // embedding-dependent remainder of the round trip (doctor embeddings/embedding_provider GREEN)
  // is separately, precisely blocked — see the paid-embedding leg describe block below.
  it(
    "gbrain import --no-embed lands the SAME fixture into a scratch brain's REAL DB, and the persisted page count agrees with the fs-extract oracle (extends GO#4 toward the full round-trip, still $0)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sow-eval-extract-roundtrip-"));
      const home = await mkScratchGbrainHome();
      try {
        await writeFile(join(dir, "auth.md"), "---\nslug: auth\n---\n# Auth\nSee [[oauth]].\n", "utf8");
        await writeFile(join(dir, "oauth.md"), "---\nslug: oauth\n---\n# OAuth\n", "utf8");

        const extracted = await runFsExtractLinksDryRun(dir);
        expect(extracted).toBeDefined();
        if (extracted === undefined) return;

        await initScratchBrain(home);
        const imported = await runScratchGbrainImportNoEmbed(home, dir);
        expect(imported).toBeDefined();
        if (imported === undefined) return;

        // the fs-extract oracle's page count and the REAL scratch DB's post-import page count
        // agree — the round-trip now covers fs → real gbrain DB, not just a read-only fs walk.
        expect(imported.imported).toBe(extracted.pages_processed);
        expect(imported.errors).toBe(0);
      } finally {
        await rmScratchGbrainHome(home);
        await rm(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

describe.skipIf(!LIVE)(
  "12.7 GO#3/GO#4 paid-embedding leg — REAL preflight probe (task PAID-GO34-RETRY, owner-authorized Voyage spend)",
  () => {
    // The owner explicitly authorized REAL paid Voyage embedding spend for GO#3's four-shape
    // db_only/unstamped injection and GO#4's full round-trip (task PAID-GO34) — narrowly, embedding
    // spend for THESE TWO LEGS ONLY (root CLAUDE.md "nothing arms": no write_through_enabled flip, no
    // real-brain write, no key provisioning).
    //
    // task PAID-GO34 first measured this probe against the UNFIXED bug: every `put` was rejected
    // by Voyage's own API validation before any embedding was computed/billed ("voyage-code-3
    // supports output_dimension only in {256,512,1024,2048}, got 1536"). task PAID-GO34-RETRY
    // (same day) re-runs this probe after the owner fixed the root cause
    // (`~/.gbrain/config.json` now carries `embedding_dimensions`) and after `initScratchBrain`
    // was updated to fold the same fix into every scratch brain unconditionally.
    it(
      "a real `gbrain put` against a fresh, correctly-configured scratch brain — pins the CURRENTLY OBSERVED outcome of the owner-authorized embed spend",
      async () => {
        const home = await mkScratchGbrainHome();
        try {
          await initScratchBrain(home);
          const content =
            "---\nslug: paid-go34-retry-probe\ntype: note\n---\n# Probe\nOne short sentence to test the real embed path.\n";
          const result = await putScratchBrainPage(home, "paid-go34-retry-probe", content);

          // MEASURED LIVE this session (task PAID-GO34-RETRY), after the config fix: the ORIGINAL
          // defect (Voyage API-level rejection of the 1536 fallback) is CONFIRMED GONE — the
          // config fix holds. But `put` STILL fails, now one layer deeper: a real, billed Voyage
          // call succeeds and returns a genuine 1024-dim embedding, which then fails to persist
          // because the scratch PGLite brain's `content_chunks.embedding` column was created as
          // `vector(1536)` (a SEPARATE, PGLite-specific gbrain defect — the embedded schema never
          // receives the dimension substitution the Postgres/Supabase engine path gets; see
          // `initScratchBrain`'s doc comment in `../src/gbrain/scratch-brain.ts` for the full
          // trace with file:line citations). Reproduced identically 3/3 times this session on
          // fresh scratch brains — never the owner's real `~/.gbrain` (whose existing DB is
          // already 1024-wide, hence "DB aligned" in its own `doctor --json`).
          //
          // This assertion PINS that observed state as a positive control on the EXACT failure
          // mode (the pgvector dimension-mismatch message) AND a negative control ruling out the
          // OLD failure mode (asserting the API-rejection string is now ABSENT) — not a bare "it
          // still fails". If gbrain's PGLite schema-substitution defect is ever fixed upstream,
          // THIS assertion is what starts failing — the signal to come back and build
          // GO#3(a)-(d)/GO#4's live injection for real using `putScratchBrainPage`.
          expect(result.ok).toBe(false);
          expect(result.stderr).not.toContain("output_dimension");
          expect(result.stderr).toContain("expected 1536 dimensions, not 1024");
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
      "task PAID-GO34-RETRY (2026-08-25, same day): the owner FIXED the config-layer defect PAID-GO34 found (`~/.gbrain/config.json` missing `embedding_dimensions`) — re-confirmed live (`gbrain doctor --json` on the real brain: 1024 dims, DB aligned) and now folded into every scratch brain unconditionally (`initScratchBrain`, `../src/gbrain/scratch-brain.ts`). " +
      "STILL BLOCKED, now by a NEW, DIFFERENT, DEEPER tooling defect — confirmed live this session by reading the installed `gbrain` 0.35.1.0 source at `/Users/dreddy/gbrain` (a different repo, not this package's territory): the embedded/PGLite schema hardcodes `embedding vector(1536)` (`src/core/schema-embedded.ts:139`) and never receives the dimension substitution the Postgres/Supabase engine path gets (`src/core/postgres-engine.ts:57`) — regardless of `--embedding-dimensions`/config passed to `gbrain init --pglite`. So even after the config fix, a real Voyage call now SUCCEEDS (returns a genuine 1024-dim embedding — real, billed) but the DB INSERT then fails ('expected 1536 dimensions, not 1024', pgvector) because the column is still `vector(1536)`. Reproduced identically 3/3 times this session on fresh scratch brains — see the 'GO#3/GO#4 paid-embedding leg — REAL preflight probe' describe block above, which now pins this exact new state. " +
      "`putScratchBrainPage` — the exact mechanism shape (a) names — therefore cannot land ANY page on a fresh scratch brain today: there is nothing yet to classify. (a)-(d) cannot be built until the PGLite schema-substitution defect is fixed upstream (outside this repo, outside this package's territory — root CLAUDE.md: do not attempt to fix it here); when it is, `putScratchBrainPage` remains the ready-built injection primitive.",
  );

  it.todo(
    "GO#4 round-trip-lossless LIVE: a real KW-write → commit → import/sync → DB → rebuild-oracle → compare cycle, asserting SEMANTIC-field equality AND doctor embeddings/embedding_provider GREEN. " +
      "The fs-extract corroborating-oracle leg above IS built and live-verified (no embedding needed), and task PAID-GO34-RETRY extended it one link further: a real `gbrain import --no-embed` DB write on a scratch brain, corroborated against the same fs-extract oracle counts (genuinely $0 — `--no-embed` makes zero Voyage calls). " +
      "COST-AUTHORIZATION BLOCKER LIFTED for the embedding half (task PAID-GO34): the owner explicitly authorized real paid Voyage spend. " +
      "task PAID-GO34-RETRY: the owner fixed the config-layer defect PAID-GO34 found, re-confirmed live and folded into `initScratchBrain`. STILL BLOCKED, now for TWO independent reasons: (1) a NEW, deeper, PGLite-specific gbrain defect — the embedded schema's `embedding` column is hardcoded `vector(1536)` and never receives the dimension substitution the Postgres/Supabase path gets (see the GO#3 row above and the preflight-probe describe block for the full citation + live proof), so 'doctor embeddings/embedding_provider GREEN' is still not reachable on a scratch brain even though the config fix genuinely holds and a real embed call now succeeds; and (2) independently, unchanged from before, the full cycle also needs a live KnowledgeWriter→Temporal commit pipeline (apps/worker territory, outside this package). " +
      "The embedding authorization does not conjure a working PGLite schema, any more than it conjures a commit pipeline — both stay it.todo for their own precise reasons, not a blanket 'no gbrain'.",
  );

  it.todo(
    "GO#1-adjacent: ContainedSynthesisGate leak + common-mode-malicious-gbrain cases (§12.7's 'plus' bullets) — same BLOCKED reasons as GO#1/GO#3 above (needs the write-fence/OS-lockdown wiring + a real generative call).",
  );
});
