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
import {
  scanForWriteSurfaces,
  WRITE_SURFACE_TOKENS,
  isConnectorAdapterScanFile,
} from "../../src/osb/anti-corruption-guard";
import { parseOsbPin, validateOsbPin, OSB_SUBTREE_SENTINEL, type OsbPin } from "../../src/osb/pin";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const ADAPTERS_DIR = resolve(REPO_ROOT, "packages/integrations/src/connectors/adapters");
const OSB_PIN_PATH = resolve(REPO_ROOT, "config/osb.pin");

// The FULL Connector Gateway read edge — every connectors/adapters/*.ts except the index.ts barrel
// (extractors + the vault read surface + the connector adapters + base.ts), all write-free by
// architecture. A HARDCODED count so a renamed/moved/deleted adapter, or a NEW adapter added without a
// deliberate bump HERE, fails the count-pin — the scan can never masquerade as "no violations" over a
// mis-globbed/shrunk surface (Lesson 12 non-vacuity).
// ACKNOWLEDGED read-edge (one-time cross-track bump — C2 / task 11.8): file-read-transport.ts is the
// 17th connectors/adapters read-edge. An INDEPENDENT orchestrator-dispatched Step-8 security review
// CERTIFIED it write-free (0 write surfaces; only realpath/stat/readFile) + candidate-data-only
// (emit-only; the read STOPS at registerSource(), never writes Markdown/vault/KnowledgeWriter —
// Safety Rule 1 + Lesson-12 hold). orch7 CERTIFY, 2026-07-11.
// RECONCILE → eval-security: this one-time cross-track pin bump + the DEFERRED guard-PATTERN prose-FP
// fix (the `symlink` token → a call-context anchor) belong to the eval-security track.
// +1: round-7 gmail.ts, read-only GET connector — orch21-authorized per providers Lesson 2 family
// +1: 13.13 free-source-aggregator.ts, dormant candidate-data research connector (read-edge) — main-orch-authorized;
//     write-free per eval-security's OWN scanForWriteSurfaces (0 violations, the deciding CERTIFY) + provint #34
//     all-7-invariant security review (candidate-data-only, one-writer-safe), 2026-07-25.
// +1: 13.2a web-fetch-transport.ts, dormant SSRF-guarded read-only web-fetch transport (emit-only; real fetch = §ARM-23) —
//     write-free per eval-security's OWN scanForWriteSurfaces (0 violations, the deciding CERTIFY); its doc-comment
//     `@sow/knowledge` prose is now correctly NOT flagged (L12: the token is the QUOTED import specifier), 2026-07-26.
// +5 (2026-08-25, 21 → 26): the parallel-autobuild round landed five NEW read-edge adapters. The pin FIRED as
//     designed (`expected 26 to be 21`) — this bump is the deliberate, per-file review it exists to force. Each was
//     re-scanned with eval-security's OWN scanForWriteSurfaces and is write-free:
//       coding-session-capture.ts    — lexical repo-path/origin verifier, emit-only; ZERO fs ops. Its ONLY hit was a
//                                      doc-comment PROSE "no fs/symlink resolution" — a guard-pattern FALSE POSITIVE,
//                                      not a write. Closed HERE by anchoring the `symlink` token to a CALL (the
//                                      long-deferred prose-FP fix this header already owed to eval-security), with a
//                                      no-weakening test proving every real symlink CALL form still trips.
//       gmail-source.ts              — Gmail ingestion source adapter (candidate-data emit-only). 0 hits.
//       oauth-token.ts               — OAuth refresh loop / token seam. 0 hits.
//       podcast-extract-transport.ts — podcast extractor transport (emit-only). 0 hits.
//       youtube-extract-transport.ts — YouTube extractor transport (emit-only). 0 hits.
//     The scan is proven to have INSPECTED (not merely counted) every one of the 26 — see the NON-VACUITY test below,
//     which mutates each file's own content and asserts the violation is attributed back to THAT path.
// The pinned SET, not just the size: a rename or a swap (one added + one deleted) keeps the count at 26 but shows up
// here as a named diff, so the next reader can tell an INTENDED addition from a regression.
const EXPECTED_CONNECTOR_ADAPTER_FILES: ReadonlyArray<string> = [
  "asana.ts",
  "base.ts",
  "calendar.ts",
  "capture-source.ts",
  "coding-session-capture.ts",
  "drive.ts",
  "file-read-transport.ts",
  "file-source.ts",
  "free-source-aggregator.ts",
  "github.ts",
  "gmail-source.ts",
  "gmail.ts",
  "granola.ts",
  "http-transport.ts",
  "linear.ts",
  "oauth-token.ts",
  "obsidian-vault-mcp.ts",
  "podcast-extract-transport.ts",
  "podcast-source.ts",
  "telegram-capture.ts",
  "todoist.ts",
  "url-source.ts",
  "web-fetch-transport.ts",
  "web-source.ts",
  "youtube-extract-transport.ts",
  "youtube-source.ts",
];
// Kept as a LITERAL (not `…FILES.length`) on purpose: two independent statements of the same fact, cross-checked
// below, so a careless edit to the list alone still trips the numeric pin.
const EXPECTED_CONNECTOR_ADAPTER_COUNT = 26;

function loadConnectorAdapterSources(): ReadonlyArray<{ path: string; content: string }> {
  return readdirSync(ADAPTERS_DIR)
    .filter(isConnectorAdapterScanFile)
    .map((f) => ({ path: join(ADAPTERS_DIR, f), content: readFileSync(join(ADAPTERS_DIR, f), "utf8") }));
}

describe("Phase-13 §13.1 gate (a) — OSB anti-corruption write-path guard", () => {
  it("flags an @sow/knowledge sole-writer import (safety rule 1)", () => {
    const res = scanForWriteSurfaces([
      { path: "evil.ts", content: 'import { KnowledgeWriter } from "@sow/knowledge";\nconst x = 1;' },
    ]);
    const v = res.violations.find((x) => x.token.includes("@sow/knowledge"));
    expect(v).toBeDefined();
    expect(v?.line).toBe(1);
    expect(res.scannedCount).toBe(1);
  });

  it("L12 no-weakening: EVERY idiomatic @sow/knowledge import form still trips (quote-preceded); backtick/bare PROSE does NOT (closes the web-fetch-transport doc-comment FP)", () => {
    // Every real import specifier is quote-preceded (' or ") — the tightened token catches all 12 idiomatic forms.
    const realImports = [
      'import { KnowledgeWriter } from "@sow/knowledge";',
      "import { KnowledgeWriter } from '@sow/knowledge';",
      'import type { KnowledgeMutationPlan } from "@sow/knowledge";',
      'import * as kw from "@sow/knowledge";',
      'import kw from "@sow/knowledge";',
      'import "@sow/knowledge";',
      'export { writer } from "@sow/knowledge";',
      'export * from "@sow/knowledge";',
      'const kw = require("@sow/knowledge");',
      'const kw = await import("@sow/knowledge");',
      "const kw = await import('@sow/knowledge');",
      'import { w } from "@sow/knowledge/knowledge-writer";', // deep subpath
    ];
    for (const form of realImports) {
      const res = scanForWriteSurfaces([{ path: "evil.ts", content: form }]);
      expect(
        res.violations.some((v) => v.token.includes("@sow/knowledge")),
        `real @sow/knowledge import form must STILL trip (no weakening): ${form}`,
      ).toBe(true);
    }
    // Backtick-fenced / bare PROSE mentions (as in web-fetch-transport.ts's line-27 doc comment) are NOT imports.
    const prose = [
      "// imports no `@sow/knowledge`/fs-write (the L12 write-surface scan stays green).",
      "// downstream of registerSource(), ultimately the @sow/knowledge sole writer (KN-4).",
      "/* the @sow/knowledge package is the only autonomous Markdown writer. */",
    ];
    for (const line of prose) {
      const res = scanForWriteSurfaces([{ path: "clean.ts", content: line }]);
      expect(
        res.violations.some((v) => v.token.includes("@sow/knowledge")),
        `backtick/bare @sow/knowledge PROSE must NOT trip: ${line}`,
      ).toBe(false);
    }
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

  it("LIVE: the FULL connectors/adapters read edge is clean — 0 violations AND scannedCount === EXPECTED_CONNECTOR_ADAPTER_COUNT (count-pinned, > 0)", () => {
    const files = loadConnectorAdapterSources();
    const res = scanForWriteSurfaces(files);
    expect(res.scannedCount).toBeGreaterThan(0);
    expect(res.scannedCount).toBe(EXPECTED_CONNECTOR_ADAPTER_COUNT);
    expect(res.violations).toEqual([]);
  });

  it("the count-pin and the file-set pin state the SAME fact — the scanned set is EXACTLY the pinned set (a rename/swap holds the count but shows as a named diff)", () => {
    expect(EXPECTED_CONNECTOR_ADAPTER_FILES.length).toBe(EXPECTED_CONNECTOR_ADAPTER_COUNT);
    const scanned = readdirSync(ADAPTERS_DIR).filter(isConnectorAdapterScanFile).sort();
    expect(scanned).toEqual([...EXPECTED_CONNECTOR_ADAPTER_FILES].sort());
  });

  it("NON-VACUITY: the live scan INSPECTED each file's CONTENT, it did not merely COUNT files — mutating any one adapter's own content trips a violation attributed back to THAT path", () => {
    const files = loadConnectorAdapterSources();
    expect(files.length).toBe(EXPECTED_CONNECTOR_ADAPTER_COUNT);
    for (const f of files) {
      expect(f.content.length, `${f.path}: content must have been READ (non-empty)`).toBeGreaterThan(0);
      const mutated = scanForWriteSurfaces([{ path: f.path, content: `${f.content}\nawait writeFile(p, d);` }]);
      expect(
        mutated.violations.some((v) => v.path === f.path && v.token === "writeFile"),
        `${f.path}: the scan must inspect THIS file's content (a silently-skipped file would report 0 violations)`,
      ).toBe(true);
    }
  });

  it("L12 no-weakening (symlink): every idiomatic fs symlink CALL still trips; a bare PROSE 'symlink' mention does NOT (closes the coding-session-capture.ts doc-comment FP)", () => {
    const realCalls = [
      "await symlink(target, linkPath);",
      "symlinkSync(target, linkPath);",
      "await fsp.symlink(target, linkPath);",
      "await fs.promises.symlink(target, linkPath);",
      'const { symlink } = await import("node:fs/promises");\nawait symlink(a, b);',
    ];
    for (const form of realCalls) {
      const res = scanForWriteSurfaces([{ path: "evil.ts", content: form }]);
      expect(
        res.violations.some((v) => v.token === "symlink("),
        `real fs symlink CALL must STILL trip (no weakening): ${form}`,
      ).toBe(true);
    }
    // Doc-comment prose ABOUT not resolving symlinks (coding-session-capture.ts line 48) is not a write.
    const prose = [
      " * Normalize a repo path for EXACT-SEGMENT comparison: purely lexical (no fs/symlink",
      "// no symlink resolution is performed — the compare is lexical.",
      "/* a symlink would change the answer, so we never follow one. */",
    ];
    for (const line of prose) {
      const res = scanForWriteSurfaces([{ path: "clean.ts", content: line }]);
      expect(
        res.violations.some((v) => v.token.startsWith("symlink")),
        `bare PROSE 'symlink' must NOT trip: ${line}`,
      ).toBe(false);
    }
  });

  it("the Finding's file is now COVERED — obsidian-vault-mcp.ts is in the scanned read-edge set (closes the naming-convention coverage bound)", () => {
    const scanned = readdirSync(ADAPTERS_DIR).filter(isConnectorAdapterScanFile);
    expect(scanned).toContain("obsidian-vault-mcp.ts");
    // and the extractors + a representative connector adapter + the read-edge infra are covered too.
    expect(scanned).toContain("web-source.ts");
    expect(scanned).toContain("calendar.ts");
    expect(scanned).toContain("base.ts");
  });

  it("isConnectorAdapterScanFile selects the read edge — every .ts adapter, NEVER the index.ts barrel or a non-.ts file", () => {
    expect(isConnectorAdapterScanFile("asana.ts")).toBe(true);
    expect(isConnectorAdapterScanFile("obsidian-vault-mcp.ts")).toBe(true);
    expect(isConnectorAdapterScanFile("base.ts")).toBe(true);
    expect(isConnectorAdapterScanFile("index.ts")).toBe(false); // the pure re-export barrel is excluded
    expect(isConnectorAdapterScanFile("README.md")).toBe(false);
    expect(isConnectorAdapterScanFile("calendar.js")).toBe(false);
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
