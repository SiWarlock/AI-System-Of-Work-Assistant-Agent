// @sow/evals — Phase-13 §13.1 gate (a): OSB anti-corruption write-path guard + config/osb.pin.
//
// The deterministic, non-HITL governance boundary proving safety rule 1 (one writer): no
// *-source.ts extractor (nor a future vendor/osb/** path) reaches the @sow/knowledge sole-writer /
// fs-vault / Tool-Gateway external-write surface. A pure denylist scan, made non-vacuous by a
// scannedCount>0 + a hardcoded count-pin; paired with a config/osb.pin whose subtree_sha sentinel
// forces a real content-SHA on any future vendoring (a bump is never silent). Mirrors config/gbrain.pin.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import { scanForWriteSurfaces, WRITE_SURFACE_TOKENS } from "../../src/osb/anti-corruption-guard";
import { parseOsbPin, validateOsbPin, OSB_SUBTREE_SENTINEL, type OsbPin } from "../../src/osb/pin";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const ADAPTERS_DIR = resolve(REPO_ROOT, "packages/integrations/src/connectors/adapters");
const OSB_PIN_PATH = resolve(REPO_ROOT, "config/osb.pin");

// The OSB emit-only source-extractor family — the guard's live scan surface. A HARDCODED count so a
// renamed/moved/deleted adapter (or a new extractor added without a deliberate bump HERE) fails the
// count-pin — the scan can never masquerade as "no violations" over a mis-globbed/shrunk surface.
const EXPECTED_EXTRACTOR_COUNT = 6;

function loadExtractorSources(): ReadonlyArray<{ path: string; content: string }> {
  return readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith("-source.ts"))
    .map((f) => ({ path: join(ADAPTERS_DIR, f), content: readFileSync(join(ADAPTERS_DIR, f), "utf8") }));
}

describe("Phase-13 §13.1 gate (a) — OSB anti-corruption write-path guard", () => {
  it("flags an @sow/knowledge sole-writer import (safety rule 1)", () => {
    const res = scanForWriteSurfaces([
      { path: "evil.ts", content: 'import { KnowledgeWriter } from "@sow/knowledge";\nconst x = 1;' },
    ]);
    const v = res.violations.find((x) => x.token === "@sow/knowledge");
    expect(v).toBeDefined();
    expect(v?.line).toBe(1);
    expect(res.scannedCount).toBe(1);
  });

  it("flags node:fs write ops (writeFile / createFsVault) — no direct vault write (§6)", () => {
    const res = scanForWriteSurfaces([
      { path: "evil.ts", content: "await writeFile(p, data);\nconst v = createFsVault(root);" },
    ]);
    expect(res.violations.some((x) => x.token === "writeFile")).toBe(true);
    expect(res.violations.some((x) => x.token === "createFsVault")).toBe(true);
  });

  it("flags a Tool-Gateway external-write reference (extractors are read/emit-only, §8)", () => {
    const res = scanForWriteSurfaces([
      {
        path: "evil.ts",
        content:
          'import type { ExternalWriteEnvelope } from "@sow/contracts";\nimport { x } from "../tools/adapters/calendar";',
      },
    ]);
    expect(res.violations.some((x) => x.token === "ExternalWriteEnvelope")).toBe(true);
    expect(res.violations.some((x) => x.token === "tools/adapters")).toBe(true);
  });

  it("EVERY denylist token is individually detected (data-driven backstop — the guard's whole catch-power; a new token auto-gets an assertion)", () => {
    for (const entry of WRITE_SURFACE_TOKENS) {
      const res = scanForWriteSurfaces([{ path: "synthetic.ts", content: entry.token }]);
      expect(
        res.violations.some((v) => v.token === entry.token),
        `denylist token "${entry.token}" was not self-detected`,
      ).toBe(true);
    }
  });

  it("a clean emit-only file has ZERO violations — sanctioned tokens (registerSource/payloadHash/readFile) and prose ('KnowledgeWriter', 'transform', 'renamed', 'filename', 'warm', 'form', standalone 'link') are NOT false-positived", () => {
    const clean = [
      'import { ok, err } from "@sow/contracts";',
      'import type { Result } from "@sow/contracts";',
      'import { payloadHash } from "../../hash/payload-hash";',
      'import type { RegisterSourceInput } from "../source-register";',
      "// EMIT-ONLY — downstream of registerSource(), ultimately KnowledgeWriter (the sole writer).",
      "// It NEVER writes the vault; a renamed field or transform is fine; readFile/readdir are read-only.",
      "// A warm cache form-fills the filename routing hint; a source link is metadata, never a write.",
      "const candidate: RegisterSourceInput = { contentHash: payloadHash({ a, b }) };",
    ].join("\n");
    const res = scanForWriteSurfaces([{ path: "clean-source.ts", content: clean }]);
    expect(res.violations).toEqual([]);
    expect(res.scannedCount).toBe(1);
  });

  it("flags a forbidden token even inside a COMMENT — the guard is a text scan (a write import can't hide behind a comment)", () => {
    const res = scanForWriteSurfaces([
      { path: "sneaky.ts", content: "const x = 1;\n// import { writeFile } from 'node:fs'; // TODO re-enable" },
    ]);
    const v = res.violations.find((x) => x.token === "writeFile");
    expect(v).toBeDefined();
    expect(v?.line).toBe(2);
  });

  it("an EMPTY scan set is never vacuously green — scannedCount === 0 (the live conformance below pins scannedCount to the real count so a mis-globbed surface fails)", () => {
    const res = scanForWriteSurfaces([]);
    expect(res.scannedCount).toBe(0);
    expect(res.violations).toEqual([]);
  });

  it("LIVE: the real *-source.ts extractors are clean — 0 violations AND scannedCount === EXPECTED_EXTRACTOR_COUNT (count-pinned, > 0)", () => {
    const files = loadExtractorSources();
    const res = scanForWriteSurfaces(files);
    expect(res.scannedCount).toBeGreaterThan(0);
    expect(res.scannedCount).toBe(EXPECTED_EXTRACTOR_COUNT);
    expect(res.violations).toEqual([]);
  });
});

describe("Phase-13 §13.1 gate (a) — config/osb.pin parser", () => {
  const VALID_PIN = [
    "# a comment",
    "",
    "osb_tag        = v0.11.1",
    "osb_repo       = https://github.com/eugeniughelbur/obsidian-second-brain.git",
    "subtree_sha    = PENDING_NO_SUBTREE",
    "status         = dormant_no_subtree",
    "validation_ref = docs/briefs/017-13.1-osb-anti-corruption-guard.md",
  ].join("\n");

  it("parses a valid pin (comments/blanks ignored) ⇒ OsbPin with tag v0.11.1 + sentinel subtree_sha", () => {
    const res = parseOsbPin(VALID_PIN);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.osbTag).toBe("v0.11.1");
    expect(res.value.subtreeSha).toBe(OSB_SUBTREE_SENTINEL);
    expect(res.value.osbRepo).toContain("obsidian-second-brain");
  });

  it("parses the REAL config/osb.pin ⇒ valid OsbPin (tag v0.11.1, sentinel subtree_sha)", () => {
    const text = readFileSync(OSB_PIN_PATH, "utf8");
    const res = parseOsbPin(text);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.osbTag).toBe("v0.11.1");
    expect(res.value.subtreeSha).toBe(OSB_SUBTREE_SENTINEL);
    expect(isOk(validateOsbPin(res.value))).toBe(true);
  });

  it("splits on the FIRST '=' only — a repo URL value containing '=' (query string) round-trips intact", () => {
    const res = parseOsbPin(
      [
        "osb_tag = v0.11.1",
        "osb_repo = https://example.test/osb.git?ref=main&depth=1",
        "subtree_sha = PENDING_NO_SUBTREE",
        "status = s",
        "validation_ref = r",
      ].join("\n"),
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.osbRepo).toBe("https://example.test/osb.git?ref=main&depth=1");
  });

  it("rejects a malformed line (no '=') ⇒ typed err, never a throw", () => {
    const res = parseOsbPin("osb_tag = v0.11.1\nthis line has no equals");
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("malformed_line");
  });

  it("rejects a pin missing a required key ⇒ typed err (a required field cannot silently default)", () => {
    // validation_ref missing.
    const res = parseOsbPin(
      "osb_tag = v0.11.1\nosb_repo = x\nsubtree_sha = PENDING_NO_SUBTREE\nstatus = s",
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("missing_key");
  });

  it("validateOsbPin rejects a bad subtree_sha (neither sentinel nor 40-hex) — a bump MUST record a real content-SHA (never silent)", () => {
    const bad: OsbPin = {
      osbTag: "v0.12.0",
      osbRepo: "https://x/y.git",
      subtreeSha: "not-a-real-sha",
      status: "s",
      validationRef: "r",
    };
    const res = validateOsbPin(bad);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("invalid_value");
  });

  it("validateOsbPin accepts a real 40-hex subtree_sha (a deliberate, recorded vendoring bump)", () => {
    const bumped: OsbPin = {
      osbTag: "v0.12.0",
      osbRepo: "https://x/y.git",
      subtreeSha: "a".repeat(40),
      status: "vendored",
      validationRef: "r",
    };
    expect(isOk(validateOsbPin(bumped))).toBe(true);
  });

  it("validateOsbPin rejects an empty osb_tag", () => {
    const bad: OsbPin = {
      osbTag: "  ",
      osbRepo: "x",
      subtreeSha: OSB_SUBTREE_SENTINEL,
      status: "s",
      validationRef: "r",
    };
    expect(isErr(validateOsbPin(bad))).toBe(true);
  });

  it("validateOsbPin rejects an empty status or validation_ref (present-but-blank silently defeats its purpose)", () => {
    const base: OsbPin = {
      osbTag: "v0.11.1",
      osbRepo: "https://x/y.git",
      subtreeSha: OSB_SUBTREE_SENTINEL,
      status: "s",
      validationRef: "r",
    };
    expect(isErr(validateOsbPin({ ...base, status: "" }))).toBe(true);
    expect(isErr(validateOsbPin({ ...base, validationRef: "   " }))).toBe(true);
  });
});
