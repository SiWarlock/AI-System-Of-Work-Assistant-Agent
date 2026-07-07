// WS-8 SEPARATION CERTIFICATION (owner decision 2026-07-06 — employer-work + personal in ONE shared brain).
//
// This is the end-to-end proof that the owner's decision is safe: ONE combined gbrain brain holds all THREE
// workspaces' content simultaneously (employer-work + personal-business + personal-life) plus unprefixed legacy,
// and NO foreign STRUCTURAL content crosses into any workspace's Copilot answer — for EVERY ask direction,
// through BOTH read paths:
//   • P1 — the LIVE multi-served retrieval, driven end-to-end through `answerCopilotQuestion` (retrieve →
//     enforceRetrievalScope → stub synthesis → the UI-safe candidate gate).
//   • P2 — the agentic proxy (`handleCopilotGbrainToolCall`: SC5a arg-police → exec → SC5b F2 redaction).
//
// It guards against a regression in either path. (A1 — a page whose BODY verbatim quotes another workspace —
// is the SEPARATE accepted ingest-time residual, not exercised here; this certifies STRUCTURAL separation.)
import { describe, it, expect } from "vitest";
import { ok, isOk, workspaceId } from "@sow/contracts";
import type { WorkspaceScopeRegistry, LegacyContentPolicy, CopilotWorkspaceScope } from "@sow/policy";
import {
  answerCopilotQuestion,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
  localWorkspacePosture,
  createFixtureRetrieval,
  type CopilotDeps,
  type WorkspacePosture,
} from "../../src/api/procedures/copilot";
import {
  createMultiServedGbrainRetrieval,
  type GbrainQueryExec,
} from "../../src/api/procedures/copilotGbrainSubprocess";
import {
  handleCopilotGbrainToolCall,
  type CopilotGbrainToolExec,
} from "../../src/api/procedures/copilotGbrainProxy";

// ── the combined-brain corpus: all three workspaces + unprefixed legacy, distinctively marked ─────────────
const raw = (slug: string, body: string, title: string): Record<string, unknown> => ({
  slug,
  chunk_text: body,
  title,
  source_id: "default",
  score: 0.9,
});
const CORPUS = [
  raw("personal-business/notes/pb1", "PB-BODY one", "PB-TITLE 1"),
  raw("personal-business/notes/pb2", "PB-BODY two", "PB-TITLE 2"),
  raw("employer-work/acme/ew1", "EW-BODY one", "EW-TITLE 1"),
  raw("employer-work/acme/ew2", "EW-BODY two", "EW-TITLE 2"),
  raw("personal-life/goals/pl1", "PL-BODY one", "PL-TITLE 1"),
  raw("sessions/041", "LEGACY-BODY", "LEGACY-TITLE"), // unprefixed ⇒ legacy ⇒ personal-business under {assign}
];

const REGISTRY: WorkspaceScopeRegistry = {
  descriptors: [
    { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
    { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
    { workspaceId: workspaceId("personal-life"), slugPrefixes: ["personal-life"] },
  ],
};
const ASSIGN_PB: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };

/** The distinctive markers of the OTHER two workspaces + legacy — none may appear in a given ask's answer. */
const FOREIGN_MARKERS: Record<string, readonly string[]> = {
  "personal-business": ["EW-", "PL-", "employer-work", "personal-life"], // legacy IS served to PB
  "employer-work": ["PB-", "PL-", "LEGACY-", "personal-business", "personal-life", "sessions/041"],
  "personal-life": ["PB-", "EW-", "LEGACY-", "personal-business", "employer-work", "sessions/041"],
};

describe("WS-8 SEPARATION CERTIFICATION — one combined brain, three workspaces, both read paths, every direction", () => {
  // ── P1 — the LIVE retrieval path, END-TO-END through answerCopilotQuestion ────────────────────────────
  const gbrainExec: GbrainQueryExec = async () => ok(CORPUS);
  const POSTURES: Record<string, WorkspacePosture> = {
    "personal-business": localWorkspacePosture("personal-business", "personal_business"),
    "employer-work": localWorkspacePosture("employer-work", "employer_work"),
    "personal-life": localWorkspacePosture("personal-life", "personal_life"),
  };
  const deps: CopilotDeps = {
    retrieval: createMultiServedGbrainRetrieval({
      exec: gbrainExec,
      registry: REGISTRY,
      policy: ASSIGN_PB,
      fallback: createFixtureRetrieval({}),
    }),
    synthesis: createStubSynthesis(), // cites EXACTLY the (scoped) retrieved sources — no model
    workspacePosture: createLocalWorkspacePosture(POSTURES),
    routeSelector: createLocalRouteSelector(),
  };

  const P1_EXPECTED: Record<string, readonly string[]> = {
    "personal-business": ["gbrain:personal-business:notes:pb1", "gbrain:personal-business:notes:pb2", "gbrain:sessions:041"],
    "employer-work": ["gbrain:employer-work:acme:ew1", "gbrain:employer-work:acme:ew2"],
    "personal-life": ["gbrain:personal-life:goals:pl1"],
  };

  for (const ws of ["personal-business", "employer-work", "personal-life"]) {
    it(`P1 answerCopilotQuestion(${ws}): cites ONLY ${ws}'s content — no foreign structural content in the answer`, async () => {
      const r = await answerCopilotQuestion(deps, { workspaceId: ws, question: "what's going on?" });
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      const cites = r.value.citations.map((c) => c.citationId).sort();
      expect(cites).toEqual([...P1_EXPECTED[ws]!].sort());
      // Belt-and-suspenders: NO foreign marker anywhere in the serialized UI-safe answer.
      const serialized = JSON.stringify(r.value);
      for (const marker of FOREIGN_MARKERS[ws]!) {
        expect(serialized).not.toContain(marker);
      }
    });
  }

  // ── P2 — the agentic proxy path (SC5a arg-police → exec → SC5b F2 redaction) ───────────────────────────
  const envelopeExec: CopilotGbrainToolExec = async () =>
    ok({ content: [{ type: "text", text: JSON.stringify(CORPUS) }] });
  const scopeFor = (ws: string): CopilotWorkspaceScope => ({
    servedWorkspaceId: workspaceId(ws),
    registry: REGISTRY,
    policy: ASSIGN_PB,
  });
  const P2_EXPECTED_SLUGS: Record<string, readonly string[]> = {
    "personal-business": ["personal-business/notes/pb1", "personal-business/notes/pb2", "sessions/041"],
    "employer-work": ["employer-work/acme/ew1", "employer-work/acme/ew2"],
    "personal-life": ["personal-life/goals/pl1"],
  };

  for (const ws of ["personal-business", "employer-work", "personal-life"]) {
    it(`P2 gbrain proxy query(${ws}): the model sees ONLY ${ws}'s hits — foreign hits dropped by the redactor`, async () => {
      const out = await handleCopilotGbrainToolCall(
        "mcp__gbrain__query",
        { query: "what's going on?" },
        { scope: scopeFor(ws), exec: envelopeExec },
      );
      const text = out.content[0]!.text;
      const survivors = JSON.parse(text) as Array<{ slug: string }>;
      expect(survivors.map((h) => h.slug).sort()).toEqual([...P2_EXPECTED_SLUGS[ws]!].sort());
      for (const marker of FOREIGN_MARKERS[ws]!) {
        expect(text).not.toContain(marker);
      }
    });
  }

  // ── the cross-pair that matters most: employer-work content NEVER reaches a personal ask (both paths) ──
  it("employer-work content is invisible to a personal-business ask on BOTH read paths (the owner's core concern)", async () => {
    const p1 = await answerCopilotQuestion(deps, { workspaceId: "personal-business", question: "q" });
    expect(isOk(p1)).toBe(true);
    if (isOk(p1)) expect(JSON.stringify(p1.value)).not.toContain("EW-");
    const p2 = await handleCopilotGbrainToolCall(
      "mcp__gbrain__query",
      { query: "q" },
      { scope: scopeFor("personal-business"), exec: envelopeExec },
    );
    expect(p2.content[0]!.text).not.toContain("EW-");
    expect(p2.content[0]!.text).not.toContain("employer-work");
  });
});
