// spec(§6 · §13 · task 4.7/4.20/11.3-a/11.3-b) — task 12.7 (startup VERSION-PIN check leg).
//
// The GBrain adapter's startup version-pin check MUST verify the running gbrain's SHA against
// `config/gbrain.pin`'s `gbrain_sha`, and a MISMATCH must degrade to read-only/index-only +
// surface a System Health item — never silently serve unpinned. `packages/knowledge`'s own
// unit suites (`test/gbrain-startup-verify.test.ts`, `apps/worker/test/gbrainStartupVerify.test.ts`)
// already pin this against CAPTURED fixture text — this suite is the eval-side ACCEPTANCE leg:
// it drives the REAL production probe against the ACTUAL installed gbrain 0.35.1.0 binary and
// the ACTUAL repo `config/gbrain.pin` file, so a real upstream drift (gbrain starts reporting a
// SHA, the pin's SHA/format changes, `gbrain` disappears from PATH) is caught here — a fixture
// snapshot can't catch that. Gated behind `SOW_GBRAIN_LIVE=1` (needs the real `gbrain` binary on
// PATH); the deterministic MISMATCH-must-degrade case runs UNGATED (pure, no exec).
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { HealthItemSchema } from "@sow/contracts";
import type { AuditId } from "@sow/contracts";
import {
  checkVersionPin,
  verifyGbrainStartup,
  createGbrainVersionProbe,
  parseGbrainPinFile,
  type RunningGbrainVersion,
  type VersionPinContext,
  type GbrainVersionProbe,
} from "@sow/knowledge";
import { gbrainStartupVerify, type GbrainStartupVerifyDeps } from "@sow/worker/gbrainStartupVerify";
import { runGbrainVersion } from "../src/gbrain/scratch-brain";

const LIVE = process.env["SOW_GBRAIN_LIVE"] === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PIN_PATH = resolve(REPO_ROOT, "config", "gbrain.pin");

const ctx: VersionPinContext = {
  now: () => "2026-07-01T00:00:00.000Z",
  auditRef: "audit-1222-version-pin" as AuditId,
};

// ── UNGATED: the deterministic "MISMATCH must degrade" acceptance (pure, no exec) ──────────

describe("12.7 startup version-pin check — MISMATCH must degrade (deterministic, task's own words)", () => {
  it("a running SHA that does not match the pin's SHA degrades to read_only_index_only, never serves", () => {
    const pin = {
      gbrainSha: "3933eb6a7915cb5495b8057b75567e2b1588b5ac",
      gbrainTag: "0.35.1.0",
      gbrainRepo: "https://github.com/garrytan/gbrain.git",
      indexSchemaVersion: 2,
      validatedOn: "2026-06-30",
      validationRef: "docs/design/gbrain-write-through-divergence.md",
      writeThroughEnabled: false,
    };
    const wrongSha: RunningGbrainVersion = { sha: "0000000000000000000000000000000000000f" };
    const r = checkVersionPin(pin, wrongSha, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.mode).toBe("read_only_index_only");
    expect(r.error.reason).toBe("sha_mismatch");
    expect(() => HealthItemSchema.parse(r.error.healthItem)).not.toThrow();
    expect(r.error.healthItem.state).toBe("open");
  });

  it("an UNAVAILABLE gbrain (probe returns undefined) also degrades — never fabricates a serving decision", async () => {
    const pin = {
      gbrainSha: "3933eb6a7915cb5495b8057b75567e2b1588b5ac",
      gbrainTag: "0.35.1.0",
      gbrainRepo: "https://github.com/garrytan/gbrain.git",
      indexSchemaVersion: 2,
      validatedOn: "2026-06-30",
      validationRef: "docs/design/gbrain-write-through-divergence.md",
      writeThroughEnabled: false,
    };
    const probe: GbrainVersionProbe = () => Promise.resolve(undefined);
    const r = await verifyGbrainStartup({ pin, probe, ctx });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("gbrain_unavailable");
    expect(r.error.mode).toBe("read_only_index_only");
  });
});

// ── LIVE (SOW_GBRAIN_LIVE=1): drive the REAL probe against the ACTUAL installed binary ─────

describe.skipIf(!LIVE)("12.7 startup version-pin check — LIVE against the real installed gbrain 0.35.1.0", () => {
  it("the real config/gbrain.pin parses to a contract-valid GbrainPin", async () => {
    const text = await readFile(PIN_PATH, "utf8");
    const parsed = parseGbrainPinFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.gbrainTag).toBe("0.35.1.0");
    expect(parsed.value.writeThroughEnabled).toBe(false); // ⛔ must stay false — never flip by hand
  });

  it(
    "verifyGbrainStartup against the REAL createGbrainVersionProbe() degrades (documented Finding, task 11.3-a: " +
      "gbrain 0.35.1.0 exposes NO commit SHA via `doctor --json`, so the real probe returns sha=undefined and " +
      "this ALWAYS fails closed to gbrain_unavailable on this build — re-verified live, not assumed)",
    async () => {
      const text = await readFile(PIN_PATH, "utf8");
      const parsed = parseGbrainPinFile(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const probe = createGbrainVersionProbe();
      const r = await verifyGbrainStartup({ pin: parsed.value, probe, ctx });

      // The real 0.35.1.0 binary reports no SHA ⇒ the composition MUST fail closed, never serve.
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.reason).toBe("gbrain_unavailable");
      expect(r.error.mode).toBe("read_only_index_only");
      expect(() => HealthItemSchema.parse(r.error.healthItem)).not.toThrow();
    },
    20_000,
  );

  it("the boot-level gbrainStartupVerify (the REAL production wiring) never throws and surfaces exactly one HealthItem for the live degrade", async () => {
    const surfaced: Array<{ readonly id: string; readonly failureClass: string }> = [];
    const deps: GbrainStartupVerifyDeps = {
      readPinText: () => readFile(PIN_PATH, "utf8"),
      probe: createGbrainVersionProbe(),
      surfaceHealth: (item) => {
        surfaced.push({ id: item.id, failureClass: item.failureClass });
        return Promise.resolve();
      },
      now: () => "2026-07-01T00:00:00.000Z",
      auditRef: "audit-1222-boot-verify",
    };
    await expect(gbrainStartupVerify(deps)).resolves.toBeUndefined(); // never throws
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.id).toBe("gbrain-version-pin:gbrain_unavailable");
  }, 20_000);

  it("gbrain --version reports the SAME release tag the pin records (0.35.1.0)", async () => {
    const [text, version] = await Promise.all([readFile(PIN_PATH, "utf8"), runGbrainVersion()]);
    const parsed = parseGbrainPinFile(text);
    expect(parsed.ok).toBe(true);
    expect(version).toBeDefined();
    if (!parsed.ok || version === undefined) return;
    expect(version).toContain(parsed.value.gbrainTag);
  });
});
