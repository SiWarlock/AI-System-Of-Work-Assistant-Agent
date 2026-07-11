// @sow/integrations — the REAL ROOT-confined node:fs file-read transport (make-it-real
// slice C2). These are the FIRST tests in the arc that touch real disk: every case
// runs over a real temp file/dir under the OS tmpdir (no Temporal, default suite).
//
// The safety crux is ROOT-CONFINEMENT: a path that resolves OUTSIDE the allowed root
// (../ traversal, an absolute path outside root, or a symlink whose realpath escapes
// root) MUST be rejected `unreachable` with NO bytes read — an arbitrary-file-read is
// unrepresentable. Binary (NUL-sniff) → `unknown`; ENOENT/dir → `unreachable`; empty →
// the transport returns empty text and the ADAPTER fails it closed (`empty_content`).
// Every fault is a typed closed `FileExtractResult` — the transport NEVER throws (§16).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileReadTransport } from "../src/connectors/adapters/file-read-transport";
import { extractFileSource } from "../src/connectors/adapters/file-source";

let base: string; // the temp base (root's parent — "outside" lives here)
let root: string; // the confined read root handed to the transport

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "sow-fileread-"));
  root = join(base, "root");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("createFileReadTransport — real ROOT-confined node:fs read", () => {
  it("reads a real UTF-8 file under root — spec(§9)", async () => {
    const contents = "# Hello\nreal file bytes";
    await writeFile(join(root, "note.md"), contents, "utf8");
    const transport = createFileReadTransport(root);

    const res = await transport({ path: "note.md" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.text).toBe(contents); // the REAL bytes, not a fake
    expect(res.file.filename).toBe("note.md");
    expect(res.file.path).toContain("note.md");
  });

  it("extracts a real non-empty file into a candidate through the adapter (positive anchor)", async () => {
    await writeFile(join(root, "doc.md"), "real content", "utf8");
    const transport = createFileReadTransport(root);

    const candidate = await extractFileSource(
      { sourceId: "src-doc", workspaceId: "ws-1", path: "doc.md", sensitivity: "normal" },
      transport,
    );

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(candidate.value.type).toBe("file");
    expect(candidate.value.origin).toContain("doc.md");
    expect(candidate.value.contentHash.length).toBeGreaterThan(0);
  });

  it("rejects a parent-traversal escape as unreachable, reading NO bytes — spec(§9)", async () => {
    // A REAL secret OUTSIDE root (sibling under base). It exists — so a broken guard
    // would happily read it; a sound guard rejects it before opening.
    await writeFile(join(base, "secret.txt"), "TOP SECRET — must never leak", "utf8");
    const transport = createFileReadTransport(root);

    const res = await transport({ path: "../secret.txt" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unreachable");
    // No `file` field on a rejection ⇒ the secret bytes were never surfaced.
    expect("file" in res).toBe(false);
  });

  it("rejects an absolute path outside root as unreachable — spec(§9)", async () => {
    const secretAbs = join(base, "secret-abs.txt");
    await writeFile(secretAbs, "ABSOLUTE SECRET", "utf8");
    const transport = createFileReadTransport(root);

    const res = await transport({ path: secretAbs }); // absolute, outside root

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unreachable");
    expect("file" in res).toBe(false); // the absolute-outside secret was never surfaced
  });

  it("rejects a symlink whose realpath escapes root as unreachable — spec(§9)", async () => {
    const secretTarget = join(base, "secret-link-target.txt");
    await writeFile(secretTarget, "LINKED SECRET", "utf8");
    await symlink(secretTarget, join(root, "escape-link")); // in-root name → out-of-root real
    const transport = createFileReadTransport(root);

    const res = await transport({ path: "escape-link" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unreachable");
  });

  it("treats a missing file (ENOENT) and a directory as unreachable, never throwing — spec(§16)", async () => {
    await mkdir(join(root, "subdir"), { recursive: true });
    const transport = createFileReadTransport(root);

    const missing = await transport({ path: "does-not-exist.md" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("unreachable");

    const dir = await transport({ path: "subdir" });
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.code).toBe("unreachable");
  });

  it("classifies a binary (NUL-byte) file as unknown, not garbage text — spec(§9)", async () => {
    await writeFile(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42])); // "A\0B"
    const transport = createFileReadTransport(root);

    const res = await transport({ path: "bin.dat" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown");
  });

  it("rejects an in-root file exceeding the max-bytes cap as unknown, never reading it unbounded — spec(§16)", async () => {
    // A file under root but larger than the (test-tiny) cap → typed reject, no unbounded
    // buffer. The default cap is a few MB for a text vault; the test uses a small cap so
    // it need not write megabytes.
    await writeFile(join(root, "big.md"), "x".repeat(4096), "utf8");
    const transport = createFileReadTransport(root, { maxBytes: 64 });

    const res = await transport({ path: "big.md" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown");
  });

  it("returns empty text for an empty file → the adapter fails it closed as empty_content — spec(§16)", async () => {
    await writeFile(join(root, "empty.md"), "", "utf8");
    const transport = createFileReadTransport(root);

    // The transport's own half of the contract: it returns ok with EMPTY text (emptiness
    // is the ADAPTER's decision, not the transport's).
    const raw = await transport({ path: "empty.md" });
    expect(raw.ok).toBe(true);
    if (raw.ok) expect(raw.file.text).toBe("");

    const candidate = await extractFileSource(
      { sourceId: "src-empty", workspaceId: "ws-1", path: "empty.md", sensitivity: "normal" },
      transport,
    );

    expect(candidate.ok).toBe(false);
    if (candidate.ok) return;
    expect(candidate.error.code).toBe("empty_content"); // no contentless candidate registered
  });
});
