// spec(§12/§13 write-through enablement gate · task WT/4.19/4.20) — task 12.22.
//
// Central assertion: an issued `GbrainReadGrant` read token REJECTS every `scope:'write'` op
// (`put_page`/`add_link`/`add_tag`/`delete_page`/`restore_page`/`purge_deleted_pages`/…) against
// the ACTUAL pinned gbrain SHA — HTTP OAuth scope-lattice conformance, NEVER stdio `gbrain
// serve` (which has no scope gate at all). Driven against a REAL, running `gbrain serve --http
// --enable-dcr` 0.35.1.0 process — the production DCR + client_credentials + MCP-over-HTTP
// transport (`@sow/worker`'s `copilotGbrainHttp` module), never a fake fetch.
//
// ⛔ SAFETY: every mutating call in this suite targets a DISPOSABLE SCRATCH brain
// (`scratch-brain.ts`'s isolated `GBRAIN_HOME`) — NEVER the developer's real `~/.gbrain` brain.
// "Prove the rejection" costs nothing precisely because the write never lands; this suite never
// asserts a write SUCCEEDS.
//
// Gated behind `SOW_GBRAIN_LIVE=1` (needs the real `gbrain` binary on PATH + a free loopback
// port); the DEFAULT `pnpm test` run skips this describe block, matching this codebase's own
// convention for real-integration acceptance legs (e.g. `apps/worker`'s `SOW_P3_LIVE` gate).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import type { AuditId, WorkspaceId } from "@sow/contracts";
import {
  evaluateEnablementGate,
  resolveWriteThrough,
  pinValidatedForEnablement,
  parseGbrainPinFile,
  type EnablementConditions,
  type WriteThroughContext,
  type WriteThroughResolveInput,
} from "@sow/knowledge";
import {
  createGbrainDcrTokenProvider,
  createGbrainMcpToolCallExec,
  isLoopbackUrl,
  parseMcpSseBody,
} from "@sow/worker/api/procedures/copilotGbrainHttp";
import {
  mkScratchGbrainHome,
  rmScratchGbrainHome,
  initScratchBrain,
  startScratchGbrainHttpServe,
  runScratchGbrainDoctor,
  type ScratchGbrainServeHandle,
} from "../src/gbrain/scratch-brain";
import {
  KNOWN_WRITE_OPS,
  NAMED_BUT_ABSENT_WRITE_OPS,
  KNOWN_READ_OPS,
  KNOWN_ADMIN_ONLY_OPS,
  isLikelyMutatingToolName,
} from "../src/gbrain/mutating-mcp-ops";

const LIVE = process.env["SOW_GBRAIN_LIVE"] === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIN_PATH = resolve(__dirname, "..", "..", "..", "config", "gbrain.pin");
const MCP_PREFIX = "mcp__gbrain__";

describe.skipIf(!LIVE)("12.22 — write-through enablement gate: LIVE HTTP OAuth scope-lattice conformance", () => {
  let home: string;
  let serve: ScratchGbrainServeHandle;
  let readToken: string;

  beforeAll(async () => {
    home = await mkScratchGbrainHome();
    await initScratchBrain(home);
    serve = await startScratchGbrainHttpServe(home);
    expect(isLoopbackUrl(serve.baseUrl)).toBe(true); // never a non-loopback / off-box transport

    const tokenProvider = createGbrainDcrTokenProvider({ baseUrl: serve.baseUrl, scope: "read" });
    const tok = await tokenProvider.getToken(false);
    expect(isOk(tok)).toBe(true);
    if (isOk(tok)) readToken = tok.value;
  }, 60_000);

  afterAll(async () => {
    await serve?.stop();
    await rmScratchGbrainHome(home);
  });

  function exec(): ReturnType<typeof createGbrainMcpToolCallExec> {
    return createGbrainMcpToolCallExec({
      baseUrl: serve.baseUrl,
      tokenProvider: { getToken: () => Promise.resolve({ ok: true, value: readToken }) },
    });
  }

  // ── the core 12.22 assertion: every known write op is rejected ──────────────────────────

  it.each(KNOWN_WRITE_OPS)(
    "a read-scoped GbrainReadGrant token REJECTS %s (fails closed via the REAL server, never lands)",
    async (op) => {
      const r = await exec()(`${MCP_PREFIX}${op}`, {});
      expect(isErr(r), op).toBe(true);
      if (isErr(r)) expect(r.error.cause?.code, op).toBe("GBRAIN_HTTP_TOOL_ERROR");
    },
  );

  // ── WHY it's rejected: raw inspection proves scope enforcement, not a generic failure ────

  it("the rejection reason is SPECIFICALLY insufficient_scope (proves scope-based enforcement, not e.g. bad-args)", async () => {
    const res = await fetch(`${serve.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "put_page", arguments: {} } }),
    });
    const envelope = parseMcpSseBody(await res.text()) as { result?: { content?: Array<{ text?: string }> } };
    const text = envelope.result?.content?.[0]?.text ?? "";
    expect(text).toContain("insufficient_scope");
    expect(text).toContain("requires 'write' scope");
    expect(text).toContain('"your_scopes":["read"]'); // the server round-trips the ACTUAL requested scope
  });

  // ── the task's named op that does NOT exist as an MCP tool on this build (a real Finding) ──

  it.each(NAMED_BUT_ABSENT_WRITE_OPS)(
    "%s (named in 12.22's Done-when) is ABSENT from the real 0.35.1.0 MCP catalog — still rejected, but via unknown_operation, not insufficient_scope (documented Finding)",
    async (op) => {
      const res = await fetch(`${serve.baseUrl}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 98, method: "tools/call", params: { name: op, arguments: {} } }),
      });
      const envelope = parseMcpSseBody(await res.text()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
      expect(envelope.result?.isError).toBe(true); // still never executes
      const text = envelope.result?.content?.[0]?.text ?? "";
      expect(text).toContain("unknown_operation");
      // via the production exec too: still fails closed (isErr), same generic code either way.
      const r = await exec()(`${MCP_PREFIX}${op}`, {});
      expect(isErr(r)).toBe(true);
    },
  );

  // ── exhaustive sweep: EVERY tool the real catalog reports that looks mutating is rejected ──

  it("EXHAUSTIVE: every tool in the real tools/list catalog classified as mutating is rejected by the read-scoped token", async () => {
    const res = await fetch(`${serve.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 97, method: "tools/list", params: {} }),
    });
    const envelope = parseMcpSseBody(await res.text()) as { result?: { tools?: Array<{ name?: string }> } };
    const names = (envelope.result?.tools ?? []).map((t) => t.name).filter((n): n is string => typeof n === "string");
    expect(names.length).toBeGreaterThan(0); // positive control: the catalog call itself works

    const mutating = names.filter(isLikelyMutatingToolName);
    expect(mutating.length).toBeGreaterThanOrEqual(KNOWN_WRITE_OPS.length); // the sweep covers at least the named set

    for (const name of mutating) {
      const r = await exec()(`${MCP_PREFIX}${name}`, {});
      expect(isErr(r), name).toBe(true);
    }
  }, 30_000);

  // ── positive control: the SAME token still succeeds on read ops (discrimination is real) ──

  it.each(KNOWN_READ_OPS)("positive control: the SAME read-scoped token still SUCCEEDS on the read op %s", async (op) => {
    const args = op === "query" || op === "search" ? { query: "x" } : op === "get_tags" || op === "get_links" || op === "get_timeline" ? { slug: "nonexistent" } : {};
    const r = await exec()(`${MCP_PREFIX}${op}`, args);
    expect(isOk(r), op).toBe(true); // proves discrimination: the SAME token, a different verb, a clean result
  });

  // ── a THIRD scope tier this suite found live, not assumed: 'admin' (stricter than 'write') ──

  it.each(KNOWN_ADMIN_ONLY_OPS)(
    "%s requires 'admin' scope (a stricter tier than 'read', discovered live — a read grant correctly can't reach it either)",
    async (op) => {
      const res = await fetch(`${serve.baseUrl}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: op, arguments: {} } }),
      });
      const envelope = parseMcpSseBody(await res.text()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
      expect(envelope.result?.isError, op).toBe(true);
      const text = envelope.result?.content?.[0]?.text ?? "";
      expect(text, op).toContain("insufficient_scope");
      expect(text, op).toContain("requires 'admin' scope");
    },
  );

  // ── no token at all → 401 (a distinct auth boundary from the scope check) ──────────────

  it("no bearer token at all → 401 (authentication, not authorization — a distinct boundary)", async () => {
    const res = await fetch(`${serve.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 96, method: "tools/call", params: { name: "put_page", arguments: {} } }),
    });
    expect(res.status).toBe(401);
  });

  // ── doctor embeddings/embedding_provider status against the scratch brain (12.22's Done-when) ──

  it("records the live doctor embeddings/embedding_provider status against a DEDICATED scratch brain (reported, not force-asserted — see suite header note on live flakiness)", async () => {
    // A DEDICATED brain, not the shared `home` above: `gbrain doctor` was live-verified this
    // session to degrade to 3 non-DB checks (no embeddings/embedding_provider AT ALL, not even
    // a "skipped" status) when run concurrently against a PGLite file a `gbrain serve` process
    // already holds open — PGLite is single-connection. Real production `doctor` runs are never
    // concurrent with a `serve` against the same file, so this test mirrors THAT usage, not the
    // OAuth-conformance leg's shared `home`.
    const doctorHome = await mkScratchGbrainHome();
    let doctor: Awaited<ReturnType<typeof runScratchGbrainDoctor>>;
    try {
      await initScratchBrain(doctorHome);
      doctor = await runScratchGbrainDoctor(doctorHome);
    } finally {
      await rmScratchGbrainHome(doctorHome);
    }
    expect(doctor).toBeDefined();
    if (doctor === undefined) return;
    const embeddings = doctor.checks.find((c) => c.name === "embeddings");
    const embeddingProvider = doctor.checks.find((c) => c.name === "embedding_provider");
    // A fresh 0-page scratch brain trivially reports 100% coverage (0 of 0 missing) — this
    // assertion is about the CHECK EXISTING with a well-formed status, not a claim the live
    // embedding_provider network probe is always green (this session measured it flip
    // ok→warn against the real brain with NO code change — see 12.7's four-GO acceptance
    // suite header for the full finding).
    expect(embeddings?.status).toBeDefined();
    expect(["ok", "warn", "error"]).toContain(embeddingProvider?.status);
  }, 60_000);

  // ── writeThroughEnabled stays FALSE even though THIS ONE precondition is now live-proven ──

  it("writeThroughEnabled stays FALSE: readTokenRejectsWrite is now LIVE-proven true, but the OTHER 12.7 GO conditions + the real pin's PENDING_PHASE12 sentinel keep the gate closed", async () => {
    const pinText = await readFile(PIN_PATH, "utf8");
    const parsedPin = parseGbrainPinFile(pinText);
    expect(parsedPin.ok).toBe(true);
    if (!parsedPin.ok) return;
    expect(parsedPin.value.writeThroughEnabled).toBe(false); // ⛔ never flipped by hand

    const conditions: EnablementConditions = {
      pinValidated: pinValidatedForEnablement(parsedPin.value), // real: false (PENDING_PHASE12)
      pinShaMatchesRunning: false, // real: 0.35.1.0 exposes no SHA at all (see version-pin-live suite)
      goOneWriter: false, // 12.7 GO#1 — not live-proven this session (infra-gated, see 12.7 suite)
      goNoLostUpdate: false, // 12.7 GO#2 — not live-proven this session (deterministic leg: 12.23, DONE)
      goParityCatchesDbOnly: false, // 12.7 GO#3 — not live-proven this session (deterministic leg: 12.23, DONE)
      goRoundTripLossless: false, // 12.7 GO#4 — not live-proven this session (needs real embed cost)
      readTokenRejectsWrite: true, // ⭐ THIS suite's own live proof, above
      embeddingKeyGreen: false, // conservative: this session measured this check FLAKY live (see above)
      noCronOrAutopilot: true, // no cron/autopilot bound to a canonical brain in this scratch process
    };

    const gate = evaluateEnablementGate(conditions);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error.unmet).not.toContain("read_token_accepts_write"); // the ONE leg this suite proves
    expect(gate.error.unmet).toContain("pin_pending_validation");
    expect(gate.error.unmet).toContain("go1_one_writer_unproven");
    expect(gate.error.unmet).toContain("go4_round_trip_unproven");

    const ctx: WriteThroughContext = { now: () => "2026-07-01T00:00:00.000Z", auditRef: "audit-1222-live" as AuditId };
    const input: WriteThroughResolveInput = {
      workspaceId: "ws-eval-1222" as WorkspaceId,
      flagEnabled: true, // even IF someone flipped the persisted intent flag —
      conditions,
    };
    const resolved = resolveWriteThrough(input, ctx);
    expect(resolved.active).toBe(false); // — write-through never activates.
    expect(resolved.mode).toBe("markdown_provenanced_only");
    expect(resolved.reason).toBe("enablement_conditions_unmet");
  });
});
