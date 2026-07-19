// 18.33 — the COMMITTED Lesson-64 armed-auto-ingest DRY-RUN (the go/no-go). Env-gated behind a DEDICATED gate
// (SOW_L64_DRYRUN) so BOTH the default `pnpm test` suite AND the `-live` (SOW_TEMPORAL) suite skip it — Option B
// drives the armed ACTIVITIES deterministically (NO Temporal), so a Temporal gate would read misleadingly. The
// go/no-go is the explicit, self-documenting command:
//
//     SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts
//
// It boots the worker ARMED for the subscription-extraction path — `gateSubscriptionOnlyExtraction({enabled:true})`
// over a FAKE $0 completion + FAKE content resolver + FAKE reachability check — with the 18.31 egress-allowlist
// seam populated (`buildAutoIngestProofSpineParams(WS, [<claude-agent-sdk>])`) and the 18.24 arming transform
// applied (`withSubscriptionExtractionArming(params, true)` flips source.process → CLOUD_EXTRACTION_ROUTE +
// outputSchemaId → sow:agent-extraction + stamps the {refKind:"source"} ContextRef). It then drops ONE benign
// non-employer `.md` on the watched vault and drives the REAL source-ingestion activities end-to-end —
// broker (admission → egress-veto → schema-gate → the REAL subscription run leg over the fake completion) →
// validateNoInference → sole KnowledgeWriter `applyPlan` → a real note in a real fs vault.
//
// This is Lesson 64's go/no-go: it proves an ARMED run PRODUCES A NOTE (broker-accepts + note-produced), not
// spend-and-produce-nothing (candidate → schema_rejected → EMPTY → no note). $0 / no real subscription call:
// `createClaudeSubscriptionCompletion` is NEVER wired — the fake is the only completion source; every gate
// (admission / egress-veto / schema / no-inference) runs REAL.
//
// COMPOSITION TIE (anti-drift, lead ask): the allowlist value derives from the canonical
// `CLOUD_EXTRACTION_ROUTE.runtime` constant (NOT a magic string) — one worker-side source of truth for "the
// value that produces a note". The armed plain-data shape uses the same worker-owned types the desktop 18.32
// forward targets (`AutoIngestGateOpts.egressAllowedProcessors` via the 18.31 seam + `BootConfig.subscriptionArm`),
// so tsc breaks on any field drift. The desktop is processor-AGNOSTIC (it forwards an opaque owner-set string);
// this slice owns the `claude-agent-sdk` → note semantic — no hand-mirrored value to drift. See brief 146 / the
// 18.32 `arming-forward` test.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isOk, isErr, ok, workspaceId, sourceId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { SourceEnvelope } from "@sow/contracts";
import type { AgentExtraction, SourceIngestionContext, SourceIngestionInput } from "@sow/workflows";
import type {
  ClaudeSubscriptionCompletion,
  CompletionRequest,
} from "@sow/providers";
import { createFileReadTransport } from "@sow/integrations/connectors/adapters/file-read-transport";

import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { buildAutoIngestProofSpineParams, withSubscriptionExtractionArming } from "../../src/boot";
import {
  gateSubscriptionOnlyExtraction,
  type SubscriptionArmingWiring,
} from "../../src/composition/subscription-extraction-arming";
import { CLOUD_EXTRACTION_ROUTE } from "../../src/composition/extraction-route-gate";
import type { ExtractionContentResolver } from "../../src/composition/subscription-extraction-runner";
import {
  createVaultWatchHandler,
  type VaultDispatch,
  type Realpath,
} from "../../src/watch/vaultWatcher";
import { deriveSourceNotePath, SOURCE_NOTE_SUBTREE } from "../../src/composition/sourceNotePath";

// ── deterministic constants ─────────────────────────────────────────────────────
const WS = "ws-armed-dryrun";
const NOW = "2026-07-19T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SRC_ID = sourceId("src-armed-standup");
const CONTENT_HASH = "sha256:armed-standup";
const BENIGN_MD = "# Standup\nAlex will refactor the auth module by Friday.\n";

// COMPOSITION TIE — the canonical worker-side processor id for "the value that produces a note" derives from
// the frozen `CLOUD_EXTRACTION_ROUTE.runtime` constant (extraction-route-gate.ts), NOT a magic string. A route
// change to a different runtime would move this value AND the egress-veto's `processorOfRoute` in lockstep.
const EXTRACTION_PROCESSOR = (CLOUD_EXTRACTION_ROUTE as unknown as { runtime: string }).runtime;

// ── the agent_extraction candidates the FAKE completion emits ─────────────────────
/** VALID: `owner` evidence-backed (passes validateNoInference), `dueDate` = TBD sentinel (no evidence needed). */
const VALID_AGENT_EXTRACTION = {
  fields: {
    owner: { value: "Alex", evidenceRef: "standup#L1" },
    dueDate: { value: TBD },
  },
} as const;
/** OWNER-ONLY: `dueDate` is ABSENT ⇒ the frontmatter projection fills TBD (never invents — REQ-F-017). */
const OWNER_ONLY_EXTRACTION = {
  fields: { owner: { value: "Alex", evidenceRef: "standup#L1" } },
} as const;

// ── fakes — the ONLY seams; every gate runs REAL. $0: costUsd 0, no real SDK/network. ─────────────────
/** A fake $0 subscription completion returning a fixed agent_extraction candidate; records its calls. */
function fakeArm(candidate: unknown): { wiring: SubscriptionArmingWiring; completionCalls: CompletionRequest[] } {
  const completionCalls: CompletionRequest[] = [];
  const completion: ClaudeSubscriptionCompletion = {
    complete: (req) => {
      completionCalls.push(req);
      return Promise.resolve(ok({ structuredOutput: candidate, costUsd: 0 }));
    },
  };
  // A fake content resolver returns the body directly (bypasses the parked-reader late-bind, L63) — the fake
  // completion ignores it anyway; it only needs to resolve `ok` so the run leg proceeds.
  const content: ExtractionContentResolver = { resolve: () => Promise.resolve(ok(BENIGN_MD)) };
  const wiring = gateSubscriptionOnlyExtraction(
    { enabled: true },
    {
      makeCompletion: () => completion,
      makeContentResolver: () => content,
      // "reachable": both dims true ⇒ the health probe admits (never a real SDK/login probe).
      checkReachable: () => ({ loginPresent: true, sdkReachable: true }),
      now: () => 1000,
    },
  );
  if (wiring === undefined) throw new Error("expected an armed wiring (enabled:true)");
  return { wiring, completionCalls };
}

/** The ARMED proof-spine params: the 18.31 egress-allowlist seam populated + the 18.24 arming transform applied. */
function armedParams(allowlist: readonly string[]): ProofSpineParams {
  const withAllowlist = buildAutoIngestProofSpineParams(WS, allowlist);
  const armed = withSubscriptionExtractionArming(withAllowlist, true);
  if (armed === undefined) throw new Error("expected armed proof-spine params");
  return armed;
}

const ctxFor = (): SourceIngestionContext => ({
  source: {
    sourceId: SRC_ID,
    workspaceId: workspaceId(WS),
    origin: "file://vault/standup.md",
    contentHash: CONTENT_HASH,
    type: "note",
    sensitivity: "normal",
    routingHints: {},
    body: BENIGN_MD,
  } as SourceEnvelope,
  workspaceId: workspaceId(WS),
  envelopes: [],
});

/** Every `.md` under `root` that lives in the reserved KnowledgeWriter output subtree (the produced notes). */
function producedNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel === "" ? root : join(root, rel))) {
      const childRel = rel === "" ? entry : join(rel, entry);
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (entry.endsWith(".md") && childRel.startsWith(`${SOURCE_NOTE_SUBTREE}/`)) out.push(childRel);
    }
  };
  walk("");
  return out;
}

const identityRealpath: Realpath = (p) => Promise.resolve(p);

// ─────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!process.env.SOW_L64_DRYRUN)("18.33 — armed auto-ingest dry-run (Lesson-64 go/no-go, $0 fake completion)", () => {
  it("armed_autoingest_benign_source_produces_note_fake_completion — a benign .md dropped on the watched vault, ARMED (fake $0 completion), produces a REAL note through broker→agent_extraction gate→validateNoInference→KnowledgeWriter — spec(§19.5/§7/§6, L64)", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-armed-note-"));
    const { wiring, completionCalls } = fakeArm(VALID_AGENT_EXTRACTION);
    const backends = await assembleBackends({
      now: () => NOW,
      vaultRoot,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      providerTransport: wiring.providerTransport, // ← selectProviderRunner picks the REAL subscription runner
    });
    try {
      // The 18.31 seam populates the egress allowlist with the CANONICAL cloud processor id.
      const acts = buildProofSpineActivities(backends, armedParams([EXTRACTION_PROCESSOR]));

      // Drop a benign .md on the watched vault; the REAL watcher captures it (filter + root-confined transport
      // read + policy binding) and dispatches. The dispatch records the captured input; we then drive the ARMED
      // source activities from that REAL captured context — proving the dropped file flows into the armed path.
      await writeFile(join(vaultRoot, "standup.md"), BENIGN_MD, "utf8");
      let captured: SourceIngestionInput | undefined;
      const dispatch: VaultDispatch = (input) => {
        captured = input;
        return Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: true, deduped: false }));
      };
      const handler = createVaultWatchHandler(
        { vaultRoot, workspaceId: WS, sensitivity: "normal" },
        { transport: createFileReadTransport(vaultRoot), dispatch },
      );
      const outcome = await handler.capture("standup.md");
      expect(outcome.kind).toBe("dispatched"); // the real watcher captured + dispatched the dropped .md
      if (captured === undefined) throw new Error("expected a captured dispatch");

      // Drive the ARMED activities from the REAL captured context. The production Temporal workflow binds the
      // routing-bound workspace (WS-2) onto the context before the activity; this harness drives the activities
      // directly, so replicate that ONE binding (the vaultWatcher-live e2e pins `context.workspaceId ===` the
      // policy-bound workspace). Every gate below (broker admission → egress-veto → schema → no-inference →
      // KnowledgeWriter) runs REAL; only the completion/resolver are faked.
      const boundCtx: SourceIngestionContext = { ...captured.context, workspaceId: workspaceId(WS) };
      const run = await acts.sourceRunAgentJob(boundCtx);
      expect(isOk(run)).toBe(true);
      if (!isOk(run)) return;
      const validated = acts.meetingValidate(run.value);
      expect(isOk(validated)).toBe(true);
      if (!isOk(validated)) return;
      const built = await acts.sourceBuildOutputs(
        validated.value,
        workspaceId(WS),
        { sourceId: boundCtx.source.sourceId, contentHash: boundCtx.source.contentHash },
        boundCtx.source.body ?? BENIGN_MD,
      );
      expect(isOk(built)).toBe(true);
      if (!isOk(built)) return;
      const commit = await acts.sourceCommit(built.value.plan);
      expect(isOk(commit)).toBe(true);

      // A REAL note was produced under the reserved output subtree (broker ACCEPTED + note PRODUCED, not
      // schema_rejected → EMPTY → no note — the L64 go/no-go).
      const notes = producedNotes(vaultRoot);
      expect(notes.length).toBe(1);
      const note = readFileSync(join(vaultRoot, notes[0]!), "utf8");
      expect(note).toContain("owner");
      expect(note).toContain("Alex"); // the evidence-backed reconstructed value

      // $0 / no real call: the FAKE completion was the sole run-leg source (costUsd 0, exactly one invocation);
      // `createClaudeSubscriptionCompletion` is never wired (the fake is `makeCompletion`).
      expect(completionCalls.length).toBe(1);
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("armed_autoingest_absent_datum_is_TBD_not_invented — the fake candidate OMITS dueDate ⇒ the produced note's frontmatter carries the TBD sentinel, never an invented value — spec(REQ-F-017)", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-armed-tbd-"));
    const { wiring } = fakeArm(OWNER_ONLY_EXTRACTION);
    const backends = await assembleBackends({
      now: () => NOW,
      vaultRoot,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      providerTransport: wiring.providerTransport,
    });
    try {
      const acts = buildProofSpineActivities(backends, armedParams([EXTRACTION_PROCESSOR]));
      const run = await acts.sourceRunAgentJob(ctxFor());
      expect(isOk(run)).toBe(true);
      if (!isOk(run)) return;
      const extraction: AgentExtraction = run.value;
      expect(extraction.fields.owner?.value).toBe("Alex");

      const validated = acts.meetingValidate(extraction);
      expect(isOk(validated)).toBe(true);
      if (!isOk(validated)) return;
      const built = await acts.sourceBuildOutputs(
        validated.value,
        workspaceId(WS),
        { sourceId: SRC_ID, contentHash: CONTENT_HASH },
        BENIGN_MD,
      );
      if (!isOk(built)) return;
      const commit = await acts.sourceCommit(built.value.plan);
      expect(isOk(commit)).toBe(true);

      const notes = producedNotes(vaultRoot);
      expect(notes.length).toBe(1);
      const note = readFileSync(join(vaultRoot, notes[0]!), "utf8");
      // The ABSENT dueDate is projected as the TBD sentinel (never invented, REQ-F-017).
      expect(note).toContain("dueDate");
      expect(note).toContain(TBD);
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("armed_autoingest_note_does_not_refire_watcher — the ARMED-produced note under sources/<ws>/ is EXCLUDED by the real watcher (no write→re-ingest loop) — spec(§9 / L37 G6)", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-armed-norefire-"));
    const { wiring } = fakeArm(VALID_AGENT_EXTRACTION);
    const backends = await assembleBackends({
      now: () => NOW,
      vaultRoot,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      providerTransport: wiring.providerTransport,
    });
    try {
      const acts = buildProofSpineActivities(backends, armedParams([EXTRACTION_PROCESSOR]));
      const run = await acts.sourceRunAgentJob(ctxFor());
      if (!isOk(run)) throw new Error("armed run expected to accept");
      const validated = acts.meetingValidate(run.value);
      if (!isOk(validated)) throw new Error("validate expected to pass");
      const built = await acts.sourceBuildOutputs(
        validated.value,
        workspaceId(WS),
        { sourceId: SRC_ID, contentHash: CONTENT_HASH },
        BENIGN_MD,
      );
      if (!isOk(built)) throw new Error("build expected to pass");
      await acts.sourceCommit(built.value.plan);

      const notes = producedNotes(vaultRoot);
      expect(notes.length).toBe(1);
      const producedPath = notes[0]!;
      // The produced note path is the REAL derived output path (producer + watcher share SOURCE_NOTE_SUBTREE).
      const derived = deriveSourceNotePath(workspaceId(WS), { sourceId: SRC_ID, contentHash: CONTENT_HASH });
      expect(derived.ok && derived.value).toBe(producedPath);

      // The real watcher EXCLUDES that produced note ⇒ no second dispatch (the feedback loop is broken).
      let dispatched = 0;
      const dispatch: VaultDispatch = (input) => {
        dispatched += 1;
        return Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: true, deduped: false }));
      };
      const handler = createVaultWatchHandler(
        { vaultRoot, workspaceId: WS, sensitivity: "normal" },
        { transport: createFileReadTransport(vaultRoot), dispatch, realpath: identityRealpath },
      );
      const outcome = await handler.capture(producedPath);
      expect(outcome).toEqual({ kind: "ignored", reason: "output_subtree" });
      expect(dispatched).toBe(0);
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("armed_autoingest_denied_without_egress_allowlist — the SAME armed boot with an EMPTY egress allowlist ⇒ the cloud route is DENIED at the egress veto ⇒ NO note (the 18.31 allowlist is load-bearing; non-vacuity control for the note above, L7) — spec(§5)", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "sow-armed-deny-"));
    const { wiring, completionCalls } = fakeArm(VALID_AGENT_EXTRACTION);
    const backends = await assembleBackends({
      now: () => NOW,
      vaultRoot,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      providerTransport: wiring.providerTransport,
    });
    try {
      // EMPTY allowlist — the ONLY diff from the produce-note test. The armed cloud {runtime} route reaches the
      // egress veto with no processor allowlisted ⇒ PROCESSOR_NOT_ALLOWED ⇒ the run leg is never reached.
      const acts = buildProofSpineActivities(backends, armedParams([]));
      const run = await acts.sourceRunAgentJob(ctxFor());
      expect(isErr(run)).toBe(true);
      // No note committed, and the run leg (the fake completion) was NEVER reached (denied upstream at the veto).
      expect(producedNotes(vaultRoot).length).toBe(0);
      expect(completionCalls.length).toBe(0);
    } finally {
      backends.close();
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
