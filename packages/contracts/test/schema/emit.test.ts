// 13.8g-C — self-test for the `emitJsonSchema` catchall-`propertyNames` POLICY
// (see `src/schema/emit.ts`'s own header for the full rationale). Uses INLINE
// fixture Zod schemas (not a model) to prove the MECHANISM directly: the rule
// fires for a real (non-never) catchall and is INERT everywhere else. The
// census below is what keeps the policy's own no-op claim for every OTHER
// model from quietly going stale as new models are added.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import { emitJsonSchema, RESERVED_CATCHALL_KEY_PATTERN } from "../../src/schema/emit";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

describe("emitJsonSchema — catchall propertyNames policy (13.8g-C)", () => {
  it("merges propertyNames onto an object schema with a REAL (non-never) catchall", () => {
    const schema = z.object({ a: z.string().optional() }).catchall(z.number());
    const result = emitJsonSchema(schema, "sow:fixture-catchall") as {
      propertyNames?: { pattern?: string };
    };
    expect(result.propertyNames?.pattern).toBe(RESERVED_CATCHALL_KEY_PATTERN);
  });

  // Both-anchored non-vacuity: prove the MECHANISM is narrow by execution, not by
  // the grep-based census below (a census proves no OTHER model is affected TODAY;
  // this proves the rule ITSELF cannot fire on a shape that has no catchall).
  it("is INERT for a `.strict()` object with no catchall at all", () => {
    const schema = z.object({ a: z.string().optional() }).strict();
    const result = emitJsonSchema(schema, "sow:fixture-strict") as {
      propertyNames?: unknown;
    };
    expect(result.propertyNames).toBeUndefined();
  });

  it("is INERT for a plain (default strip-mode) object with no catchall", () => {
    const schema = z.object({ a: z.string().optional() });
    const result = emitJsonSchema(schema, "sow:fixture-plain") as {
      propertyNames?: unknown;
    };
    expect(result.propertyNames).toBeUndefined();
  });

  it("is INERT for a `z.record` (a DIFFERENT container that already carries its own propertyNames via its key schema, unrelated to this policy)", () => {
    // z.record's propertyNames comes from ITS OWN key-schema emission (unaffected by
    // this policy, which only ever looks at ZodObject + a real catchall). Confirms
    // this rule doesn't ALSO fire redundantly (or wrongly) on the other container
    // shape the codebase uses for open key-sets.
    const schema = z.record(z.string(), z.number());
    const result = emitJsonSchema(schema, "sow:fixture-record") as {
      propertyNames?: { pattern?: string };
    };
    // z.record with a plain z.string() key has no reserved-key pattern of its own —
    // absence here just proves this POLICY didn't inject one; it isn't testing
    // z.record's own (separate, pre-existing) propertyNames mechanism.
    expect(result.propertyNames?.pattern).not.toBe(RESERVED_CATCHALL_KEY_PATTERN);
  });

  // ── Census: pins WHERE `.catchall(` is used today, so the "zero other models
  // affected" blast-radius argument this policy's placement rests on cannot
  // quietly become false as new models are added. Both-anchored (`\.catchall\s*\(`
  // requires a preceding `.` AND an immediate `(`), so a bare identifier or a
  // property reference without a call cannot inflate the count.
  const CATCHALL_CALL_RE = /\.catchall\s*\(/;

  function loadRealFiles(pkgRelativeDir: string): { path: string; content: string }[] {
    const listed = execFileSync("git", ["ls-files", "--", pkgRelativeDir], {
      cwd: join(REPO_ROOT, "packages/contracts"),
      encoding: "utf8",
    })
      .split("\n")
      .filter((p) => p.endsWith(".ts"));
    return listed.map((p) => ({
      path: p,
      content: readFileSync(join(REPO_ROOT, "packages/contracts", p), "utf8"),
    }));
  }

  it("census: exactly agent-extraction.ts uses `.catchall(` under src/models/ + src/provider/ today", () => {
    const modelsFiles = loadRealFiles("src/models");
    const providerFiles = loadRealFiles("src/provider");
    // Non-vacuity per directory: a silently broken/mistyped pathspec for EITHER
    // directory must not hide behind the other still returning files (the
    // combined-then-length-checked form this replaces couldn't tell the two apart).
    expect(modelsFiles.length).toBeGreaterThan(0);
    expect(providerFiles.length).toBeGreaterThan(0);
    const files = [...modelsFiles, ...providerFiles];
    const withCatchall = files.filter((f) => CATCHALL_CALL_RE.test(f.content)).map((f) => f.path);
    expect(withCatchall).toEqual(["src/models/agent-extraction.ts"]);
  });
});
