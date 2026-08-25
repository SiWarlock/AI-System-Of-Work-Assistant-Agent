// Task 13.2c — the DORMANT YouTube real-extract transport (the third source-extractor real-parse
// leg). `createYouTubeExtractTransport({run, allowedHosts})` over an INJECTED subprocess runner
// (argv → {code,stdout,stderr}) — SSRF-guarded, PINNED argv (watch url as its own trailing element,
// never shell-concatenated), transcript segments joined in DOCUMENT ORDER (never sorted), TOTAL
// never-throws (L11), fail-closed. Real spawn binds ONLY at §ARM-23 — every test injects a fake
// runner (no real subprocess).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  createYouTubeExtractTransport,
  type YouTubeRunner,
  type YouTubeRunResult,
} from "../src/connectors/adapters/youtube-extract-transport";

const WATCH_URL = "https://www.youtube.com/watch?v=abc123";
const ALLOWED = ["www.youtube.com"] as const;

function stdoutJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

const WELL_FORMED_PAYLOAD = {
  videoId: "abc123",
  watchUrl: WATCH_URL,
  title: "How the candidate-data gate works",
  channel: "System of Work",
  publishedAt: "2026-07-01",
  segments: [
    { text: "hello", start: 0, duration: 1 },
    { text: "world", start: 1, duration: 1 },
  ],
};

function spyRunner(impl: YouTubeRunner): { run: YouTubeRunner; calls: () => (readonly string[])[] } {
  const fn = vi.fn(impl);
  return { run: fn, calls: () => fn.mock.calls.map((c) => c[0]) };
}

const okResult = (payload: Record<string, unknown>): YouTubeRunResult => ({
  code: 0,
  stdout: stdoutJson(payload),
  stderr: "",
});

// ── argv PINNING — watchUrl as its OWN element, never shell-concatenated ──────
describe("createYouTubeExtractTransport — PINNED argv, watchUrl as a separate element", () => {
  it("calls run() with a FIXED argv vector; watchUrl is its own trailing element (never concatenated)", async () => {
    const { run, calls } = spyRunner(async () => okResult(WELL_FORMED_PAYLOAD));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    await transport({ watchUrl: WATCH_URL });
    expect(calls().length).toBe(1);
    const argv = calls()[0]!;
    expect(argv).toEqual(["youtube_extract.py", "--emit-json", WATCH_URL]);
    // watchUrl is a DISTINCT array element — not a substring of any earlier element (proves no
    // string-concatenation into a single shell-style command).
    expect(argv[0]!.includes(WATCH_URL)).toBe(false);
    expect(argv[argv.length - 1]).toBe(WATCH_URL);
  });
});

// ── SSRF guard BEFORE invoking run() ───────────────────────────────────────────
describe("createYouTubeExtractTransport — SSRF guard BEFORE run() (rule 5 / L4)", () => {
  it.each([
    ["loopback", "https://127.0.0.1/watch?v=x"],
    ["localhost", "https://localhost/watch?v=x"],
    ["private RFC-1918", "https://192.168.1.10/watch?v=x"],
    ["non-https", "http://www.youtube.com/watch?v=x"],
    ["non-allowlisted host", "https://evil.com/watch?v=x"],
  ])("a %s watch url ⇒ typed fault with ZERO run() calls (guard-before-spawn)", async (_label, watchUrl) => {
    const { run, calls } = spyRunner(async () => okResult(WELL_FORMED_PAYLOAD));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
    expect(calls().length).toBe(0); // NOTHING spawned — the SSRF guard ran first
  });

  it("an allowlisted https watch url ⇒ run() proceeds and resolves a video", async () => {
    const { run, calls } = spyRunner(async () => okResult(WELL_FORMED_PAYLOAD));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(true);
    expect(calls().length).toBe(1);
  });
});

// ── DOCUMENT ORDER — segments join in array order, never sorted/deduped ───────
describe("createYouTubeExtractTransport — transcript segments join in DOCUMENT ORDER", () => {
  it("segment order differs from ascending start time ⇒ output preserves ARRAY order (never sorted)", async () => {
    const payload = {
      ...WELL_FORMED_PAYLOAD,
      segments: [
        { text: "third", start: 20, duration: 1 },
        { text: "first", start: 0, duration: 1 },
        { text: "second", start: 10, duration: 1 },
      ],
    };
    const { run } = spyRunner(async () => okResult(payload));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.video.transcript).toBe("third first second"); // ARRAY order, NOT "first second third"
    }
  });

  it("a duplicate segment text is NOT deduped (kept in place, array order preserved)", async () => {
    const payload = {
      ...WELL_FORMED_PAYLOAD,
      segments: [
        { text: "echo", start: 0, duration: 1 },
        { text: "echo", start: 1, duration: 1 },
      ],
    };
    const { run } = spyRunner(async () => okResult(payload));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.video.transcript).toBe("echo echo"); // both kept, not collapsed to one
  });
});

// ── fail-closed: no_transcript / unreachable / TOTAL never-throws ─────────────
describe("createYouTubeExtractTransport — fail-closed codes + TOTAL never-throws (L11, rule 7)", () => {
  it("an empty segments[] ⇒ ok:false code 'no_transcript'", async () => {
    const { run } = spyRunner(async () => okResult({ ...WELL_FORMED_PAYLOAD, segments: [] }));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("no_transcript");
  });

  it("whitespace-only segment text ⇒ ok:false code 'no_transcript'", async () => {
    const { run } = spyRunner(async () => okResult({ ...WELL_FORMED_PAYLOAD, segments: [{ text: "   " }] }));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("no_transcript");
  });

  it("a non-zero exit code ⇒ ok:false code 'unreachable', stderr NEVER echoed (rule 7)", async () => {
    const { run } = spyRunner(async () => ({ code: 1, stdout: "", stderr: "SECRET_TOKEN leaked stuff" }));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unreachable");
      expect(res.message.includes("SECRET_TOKEN")).toBe(false);
    }
  });

  it("unparseable stdout ⇒ ok:false code 'unreachable', never throws", async () => {
    const { run } = spyRunner(async () => ({ code: 0, stdout: "not json{", stderr: "" }));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
  });

  it("malformed stdout (missing required fields) ⇒ ok:false code 'unreachable'", async () => {
    const { run } = spyRunner(async () => okResult({ videoId: "abc123" }));
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
  });

  it("a THROWING runner ⇒ redacted 'unknown' fault, never throws (raw cause discarded, rule 7)", async () => {
    const run: YouTubeRunner = async () => {
      throw new Error("SECRET-in-error boom /internal/path");
    };
    const transport = createYouTubeExtractTransport({ run, allowedHosts: [...ALLOWED] });
    const res = await transport({ watchUrl: WATCH_URL });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unknown");
      expect(res.message.includes("SECRET")).toBe(false);
    }
  });
});

// ── emit-only + dormant (source-scans) ────────────────────────────────────────
describe("youtube-extract-transport — emit-only (rule 1) + dormant (§ARM-23)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/adapters/youtube-extract-transport.ts", import.meta.url)),
    "utf8",
  );

  it("emit-only — no @sow/knowledge / fs-write import (L12 write-surface scan — import-anchored, not prose)", () => {
    for (const forbidden of ['from "@sow/knowledge"', 'from "node:fs"', 'from "fs"', "writeFile(", "createFsVault(", "copyFile("]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — the module spawns NO real subprocess (injected run is the sole seam)", () => {
    // Import-anchored / call-site-anchored (L12) — a doc comment naming `child_process.execFile` as
    // an ANALOGY for the injected `run`'s argv-array shape must not false-positive the scan.
    for (const forbidden of ["node:child_process", "execFile(", "execFileSync(", "spawn(", "exec("]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — no production caller CONSTRUCTS the transport (unbound seam; real bind = §ARM-23)", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("youtube-extract-transport.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createYouTubeExtractTransport("));
    expect(callers).toEqual([]); // zero production callers
  });
});
