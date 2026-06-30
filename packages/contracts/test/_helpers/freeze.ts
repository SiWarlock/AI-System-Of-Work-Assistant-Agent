// Shared test helpers for ALL model schema-snapshot tests (1.3+ §12 freeze).
// Not src — node fs in a test helper is fine; the pure-package rule applies to
// src only.
import { expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Load a frozen field-name snapshot for a model (by kebab-case name) from
 * `packages/contracts/src/models/__snapshots__/<modelKebab>.snap`.
 * Throws a clear error if the snapshot is absent.
 */
export function loadFieldSnapshot(modelKebab: string): string[] {
  const url = new URL(
    `../../src/models/__snapshots__/${modelKebab}.snap`,
    import.meta.url,
  );
  if (!existsSync(url)) {
    throw new Error(
      `snapshot missing: ${modelKebab}.snap — generate it by running the model test with UPDATE_SNAP=1`,
    );
  }
  return JSON.parse(readFileSync(url, "utf8")) as string[];
}

/**
 * Freeze `value` to `fileUrl` as pretty JSON. Writes when the file is missing or
 * `UPDATE_SNAP` is set, then reads it back and asserts round-trip equality so a
 * drift from the frozen value fails the test.
 */
export function freezeGenerated(fileUrl: URL, value: unknown): void {
  if (!existsSync(fileUrl) || process.env["UPDATE_SNAP"]) {
    writeFileSync(fileUrl, JSON.stringify(value, null, 2) + "\n", "utf8");
  }
  const read = readFileSync(fileUrl, "utf8");
  expect(JSON.parse(read)).toEqual(value);
}
