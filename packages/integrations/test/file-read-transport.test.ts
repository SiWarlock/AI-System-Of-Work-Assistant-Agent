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

  // ── 16.5 — PDF/doc binary parsing (closes G31) ──────────────────────────────
  // The transport gains a binary-parse path: a PDF/doc (detected by the `%PDF-` magic,
  // or any NUL-binary) is handed to an injected `parseBinary` extractor and its REAL
  // extracted text is emitted — instead of the blanket binary reject. The parse path is
  // ADDITIVE: it must NOT weaken root-confinement (an out-of-root file is rejected BEFORE
  // any read/parse), and a genuinely-unparseable binary (parser → null) still rejects typed.

  // A well-formed minimal single-page PDF with `text` in its content stream, correct
  // xref byte-offsets so pdf.js (via unpdf) extracts it. Pure ASCII (no NUL) — so the
  // transport must detect PDFs by the `%PDF-` magic, not by a NUL sniff.
  const buildMinimalPdf = (text: string): Buffer => {
    const streamContent = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    const objects: string[] = [
      `<< /Type /Catalog /Pages 2 0 R >>`,
      `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
      `<< /Length ${Buffer.byteLength(streamContent, "latin1")} >>\nstream\n${streamContent}\nendstream`,
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(body, "latin1"));
      body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefStart = Buffer.byteLength(body, "latin1");
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(body + xref + trailer, "latin1");
  };

  // A fake binary extractor with a call-log — proves the transport ROUTES binary bytes to
  // the parser deterministically (no dependency on the real pdf lib in the routing tests).
  const fakeExtractor = (result: string | null): { fn: (b: Uint8Array, h: { filename: string; mime?: string }) => Promise<string | null>; calls: Array<{ len: number; filename: string }> } => {
    const calls: Array<{ len: number; filename: string }> = [];
    return {
      calls,
      fn: async (b, h) => {
        calls.push({ len: b.length, filename: h.filename });
        return result;
      },
    };
  };

  it("pdf_file_extracts_real_text: a PDF routes to the parser and emits its extracted text — spec(§9)", async () => {
    await writeFile(join(root, "doc.pdf"), buildMinimalPdf("Hello SoW"));
    const parser = fakeExtractor("Hello SoW"); // deterministic parser — routing under test
    const transport = createFileReadTransport(root, { parseBinary: parser.fn });

    const res = await transport({ path: "doc.pdf" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.text).toBe("Hello SoW");
    expect(res.file.filename).toBe("doc.pdf");
    // the parser saw real in-root bytes (a whole PDF, not zero bytes)
    expect(parser.calls).toHaveLength(1);
    expect(parser.calls[0]!.len).toBeGreaterThan(20);
  });

  it("pdf_file_extracts_real_text (real unpdf default): extracts REAL text, not raw PDF source — spec(§9)", async () => {
    await writeFile(join(root, "real.pdf"), buildMinimalPdf("Hello SoW"));
    const transport = createFileReadTransport(root); // the REAL default extractor (unpdf)

    const res = await transport({ path: "real.pdf" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file.text).toContain("Hello SoW");
    // PROOF it was PARSED, not read as raw text: raw PDF source would carry these tokens.
    expect(res.file.text).not.toContain("endobj");
    expect(res.file.text).not.toContain("/Type /Catalog");
  });

  it("nul_only_file_still_rejects: a NUL-only non-PDF binary still rejects unknown (additive, not accept-all) — spec(§16)", async () => {
    await writeFile(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42])); // "A\0B", not a PDF
    const transport = createFileReadTransport(root); // real default — unpdf rejects a non-PDF

    const res = await transport({ path: "bin.dat" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown");
    expect("file" in res).toBe(false);
  });

  it("unparseable_pdf_rejects: a PDF the parser cannot extract (→ null) rejects unknown, never garbage/throw — spec(§16)", async () => {
    await writeFile(join(root, "image-only.pdf"), buildMinimalPdf("x"));
    const parser = fakeExtractor(null); // simulates an image-only / unextractable PDF
    const transport = createFileReadTransport(root, { parseBinary: parser.fn });

    const res = await transport({ path: "image-only.pdf" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown");
    expect(parser.calls).toHaveLength(1); // it TRIED to parse, then failed closed
  });

  it("extracted_text_over_cap_rejects: a compression-bomb-style over-cap extraction is rejected fail-closed — spec(§16)", async () => {
    await writeFile(join(root, "bomb.pdf"), buildMinimalPdf("x"));
    // A parser that amplifies far beyond MAX_EXTRACTED_TEXT_CHARS (32 MiB) — simulating a
    // deflate-bomb PDF within the input cap. The transport must bound the DOWNSTREAM flow.
    const huge = "a".repeat(32 * 1024 * 1024 + 1);
    const transport = createFileReadTransport(root, { parseBinary: async () => huge });

    const res = await transport({ path: "bomb.pdf" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown");
    expect(res.message).toContain("cap");
  });

  it("path_escape_still_rejects_root_confined: an out-of-root PDF rejects BEFORE any read/parse — spec(§9)", async () => {
    // A REAL PDF planted OUTSIDE root. The binary-parse path must NOT widen the read
    // surface: containment is asserted first, so the parser is NEVER handed these bytes.
    await writeFile(join(base, "secret.pdf"), buildMinimalPdf("TOP SECRET"));
    const parser = fakeExtractor("SHOULD NEVER RUN");
    const transport = createFileReadTransport(root, { parseBinary: parser.fn });

    const res = await transport({ path: "../secret.pdf" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unreachable"); // root-confinement guard unchanged
    expect("file" in res).toBe(false);
    expect(parser.calls).toHaveLength(0); // no bytes ever reached the parser
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
