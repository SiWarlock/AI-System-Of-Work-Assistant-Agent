// 18.6 + 18.5 — the real content→workspace/project classifier (18.6) + the real
// correlation-signal producer (18.5), both fail-to-PARK per REQ-F-017 (routing surface):
// a confident registry/scorer match binds the resolved workspace+project; no-match /
// ambiguous / below-threshold ⇒ recordPark to the Ingestion Inbox (the §9.8 clarification
// surface) and a low signal carrying NO guessed projectId / invented binding. WS-8: the
// resolved workspace comes from the registry ENTRY, never a smuggled caller field.
//
// SAFE-BUILD: the classifier resolves through an injected ResolveRegistryPort and the
// producer through an injected CorrelationScorerPort — both FAKE/deterministic here; no
// real model call, endpoint, key, or spend. The shipped BOOT default binds the single
// boot workspace (byte-equivalent to the pre-18.6/18.5 spine); the real registry/inbox
// repo backing is a named reachability follow-up.
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk, isErr, validSourceEnvelope } from "@sow/contracts";
import type { SourceEnvelope, WorkspaceId, Result } from "@sow/contracts";
import type {
  RouteSignals,
  RouteError,
  SourceIngestionContext,
  CorrelationSignals,
  CorrelateError,
  MeetingCloseoutContext,
  ResolveRegistryPort,
  ProjectRegistryEntry,
  ProjectSyncContext,
  ResolveRegistryError,
} from "@sow/workflows";
import type {
  IngestionInboxProjectionPort,
  RecordParkInput,
  IngestionInboxProjectionError,
} from "../../src/api/projections/ingestionInboxProjection";
import {
  createContentProjectClassify,
  createRegistryContentResolver,
  createBootWorkspaceContentResolver,
  createCorrelationSignalProducer,
  createBootCorrelationScorer,
  type ContentResolver,
  type CorrelationScorerPort,
} from "../../src/composition/content-project-resolver";

// ── fixtures ────────────────────────────────────────────────────────────────
const WS_A = "ws-registry-A" as WorkspaceId;
const WS_CALLER = "ws-smuggled-caller" as WorkspaceId;

const source = (over: Partial<SourceEnvelope> = {}): SourceEnvelope => ({
  ...validSourceEnvelope,
  // The project-routing key the content classifier reads (Q3: routingHints.projectRef).
  routingHints: { projectRef: "acme-redesign" },
  ...over,
});
const srcCtx = (s: SourceEnvelope): SourceIngestionContext =>
  ({ source: s }) as unknown as SourceIngestionContext;
const meetCtx = (s: SourceEnvelope): MeetingCloseoutContext =>
  ({ source: s }) as unknown as MeetingCloseoutContext;

const registryEntry = (over: Partial<ProjectRegistryEntry> = {}): ProjectRegistryEntry =>
  ({
    projectId: "proj-42",
    workspaceId: WS_A,
    progressProviders: [],
    title: "Acme Redesign",
    slug: "acme-redesign",
    lifecycleState: "active",
    ...over,
  }) as ProjectRegistryEntry;

const fakeRegistry = (
  result: Result<ProjectRegistryEntry, ResolveRegistryError>,
  calls?: ProjectSyncContext[],
): ResolveRegistryPort => ({
  resolve: (ctx: ProjectSyncContext) => {
    calls?.push(ctx);
    return Promise.resolve(result);
  },
});

const fakePark = (): IngestionInboxProjectionPort & { parks: RecordParkInput[] } => {
  const parks: RecordParkInput[] = [];
  return {
    parks,
    recordPark: (input: RecordParkInput): Promise<Result<void, IngestionInboxProjectionError>> => {
      parks.push(input);
      return Promise.resolve(ok(undefined));
    },
    recordDisposition: () => Promise.resolve(ok(undefined)),
  };
};

const fakeScorer = (
  result: Result<{ confidence: number; workspaceId?: WorkspaceId; projectId?: string; reason?: string }, CorrelateError>,
): CorrelationScorerPort => ({
  score: () => Promise.resolve(result),
});

// ── 18.6 — content→project classifier ──────────────────────────────────────────
describe("createContentProjectClassify — registry-backed content→project resolution (18.6)", () => {
  it("classify_resolves_project_from_registry_match — a confident registry match binds the resolved project + workspace (spec §9)", async () => {
    const park = fakePark();
    const classify = createContentProjectClassify({
      resolve: createRegistryContentResolver({ resolve: fakeRegistry(ok(registryEntry())) }),
      park,
    });
    const res = await classify(srcCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workspaceId).toBe(WS_A);
    expect(res.value.projectId).toBe("proj-42");
    expect(res.value.confidence).toBeGreaterThanOrEqual(0.7); // clears the bind threshold
    expect(park.parks).toHaveLength(0); // a confident match does NOT park
  });

  it("classify_no_registry_match_parks_never_guesses — project_unknown ⇒ recordPark + NO guessed projectId (spec REQ-F-017)", async () => {
    const park = fakePark();
    const classify = createContentProjectClassify({
      resolve: createRegistryContentResolver({
        resolve: fakeRegistry(err({ code: "project_unknown", message: "no registry entry" })),
      }),
      park,
    });
    const res = await classify(srcCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.projectId).toBeUndefined(); // NEVER a guessed projectId
    expect(res.value.workspaceId).toBeUndefined(); // no binding on a park
    expect(res.value.confidence).toBeLessThan(0.7); // below the bind threshold ⇒ the route activity parks
    expect(park.parks).toHaveLength(1); // parked to the Ingestion Inbox (REQ-F-017 clarification surface)
    expect(park.parks[0]?.source.sourceId).toBe(validSourceEnvelope.sourceId);
  });

  it("classify_ambiguous_below_threshold_parks — a below-threshold resolution ⇒ park, no binding (spec REQ-F-017)", async () => {
    const park = fakePark();
    // A resolver that yields a low-confidence, workspace-less resolution (ambiguous).
    const ambiguous = { resolve: () => Promise.resolve(ok({ confidence: 0.3, reason: "ambiguous" })) };
    const classify = createContentProjectClassify({ resolve: ambiguous, park });
    const res = await classify(srcCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workspaceId).toBeUndefined();
    expect(res.value.projectId).toBeUndefined();
    expect(park.parks).toHaveLength(1);
  });

  it("classify_projectId_is_registry_resolved_not_caller — the bound projectId is the registry ENTRY's, not any caller field (spec 18.6 / AC4)", async () => {
    const park = fakePark();
    const classify = createContentProjectClassify({
      resolve: createRegistryContentResolver({ resolve: fakeRegistry(ok(registryEntry({ projectId: "proj-from-registry" }))) }),
      park,
    });
    // A caller tries to smuggle a projectId via routingHints — it MUST be ignored (only `projectRef` routes).
    const res = await classify(
      srcCtx(source({ workspaceId: WS_A, routingHints: { projectRef: "acme-redesign", projectId: "proj-smuggled" } })),
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.projectId).toBe("proj-from-registry"); // registry entry wins, never the caller hint
  });

  it("classify_workspace_from_registry_not_caller — WS-8: the bound workspace is the registry ENTRY's, a smuggled caller ws is ignored (spec WS-8 L30 L32)", async () => {
    const park = fakePark();
    const classify = createContentProjectClassify({
      resolve: createRegistryContentResolver({ resolve: fakeRegistry(ok(registryEntry({ workspaceId: WS_A }))) }),
      park,
    });
    // The source carries WS_CALLER; the registry entry resolves WS_A — the entry MUST win.
    const res = await classify(
      srcCtx(source({ workspaceId: WS_CALLER, routingHints: { projectRef: "acme-redesign", workspaceId: WS_CALLER } })),
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workspaceId).toBe(WS_A); // registry-resolved, never the smuggled caller ws
  });

  it("classify_binds_at_exact_threshold_boundary — confidence === threshold BINDS (classify + route activity agree; >= not >)", async () => {
    // The threshold value is applied in TWO sites (the classify's recordPark decision + the route
    // activity's outcome). Pin the exact boundary so a stray `>` vs `>=` can't split-brain them.
    const park = fakePark();
    const atBoundary = { resolve: () => Promise.resolve(ok({ confidence: 0.7, workspaceId: WS_A, projectId: "proj-42" })) };
    const classify = createContentProjectClassify({ resolve: atBoundary, park, threshold: 0.7 });
    const res = await classify(srcCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workspaceId).toBe(WS_A); // confidence === threshold ⇒ BIND
    expect(res.value.projectId).toBe("proj-42");
    expect(park.parks).toHaveLength(0); // not parked at the exact boundary
  });

  it.each([
    { label: "absent projectRef", hints: {} as Record<string, unknown> },
    { label: "blank projectRef", hints: { projectRef: "" } as Record<string, unknown> },
    { label: "non-string projectRef", hints: { projectRef: 42 } as Record<string, unknown> },
  ])(
    "classify_absent_or_malformed_projectRef_parks ($label) — no routing key ⇒ park, NEVER inferred (spec REQ-F-017 L5)",
    async ({ hints }) => {
      const park = fakePark();
      // The registry would MATCH — but with no valid routingHints.projectRef the resolver never
      // consults it (no inference); the classify parks.
      const classify = createContentProjectClassify({
        resolve: createRegistryContentResolver({ resolve: fakeRegistry(ok(registryEntry())) }),
        park,
      });
      const res = await classify(srcCtx(source({ workspaceId: WS_A, routingHints: hints })));
      expect(isOk(res)).toBe(true);
      if (!isOk(res)) return;
      expect(res.value.workspaceId).toBeUndefined();
      expect(res.value.projectId).toBeUndefined();
      expect(park.parks).toHaveLength(1);
    },
  );

  it("classify_resolver_err_returns_err_not_park — a ContentResolver fault propagates as a typed err (spec §16)", async () => {
    const park = fakePark();
    const failing: ContentResolver = {
      resolve: () => Promise.resolve(err({ code: "route_source_unavailable", message: "boom" })),
    };
    const res = await createContentProjectClassify({ resolve: failing, park })(srcCtx(source()));
    expect(isErr(res)).toBe(true); // a fault is a typed err, NOT a silent park or bind
    expect(park.parks).toHaveLength(0);
  });

  it("classify_is_total_on_a_rogue_resolver_throw — a throwing resolver ⇒ typed route_failed, never propagates (spec §16)", async () => {
    const park = fakePark();
    const rogue: ContentResolver = {
      resolve: () => {
        throw new Error("rogue resolver");
      },
    };
    const res = await createContentProjectClassify({ resolve: rogue, park })(srcCtx(source()));
    expect(isErr(res)).toBe(true); // RESOLVED (not thrown) — the classify is total
    if (!isErr(res)) return;
    expect(res.error.code).toBe("route_failed");
  });
});

// ── 18.5 — correlation-signal producer ─────────────────────────────────────────
describe("createCorrelationSignalProducer — confidence-scored meeting binding (18.5)", () => {
  it("correlation_producer_above_threshold_binds — a confident (fake-scored) correlation binds workspace+project (spec 18.5)", async () => {
    const park = fakePark();
    const produce = createCorrelationSignalProducer({
      scorer: fakeScorer(ok({ confidence: 0.95, workspaceId: WS_A, projectId: "proj-42" })),
      park,
    });
    const res = await produce(meetCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBeGreaterThanOrEqual(0.7);
    expect(res.value.workspaceId).toBe(WS_A);
    expect(res.value.projectId).toBe("proj-42");
    expect(park.parks).toHaveLength(0);
  });

  it("correlation_below_threshold_parks_clarification — a below-threshold score ⇒ park clarification, never an invented binding (spec REQ-F-017)", async () => {
    const park = fakePark();
    const produce = createCorrelationSignalProducer({
      scorer: fakeScorer(ok({ confidence: 0.2, reason: "low correlation" })),
      park,
    });
    const res = await produce(meetCtx(source({ workspaceId: WS_A })));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workspaceId).toBeUndefined(); // never an invented binding
    expect(res.value.projectId).toBeUndefined();
    expect(park.parks).toHaveLength(1);
  });

  it("correlation_scorer_is_injected_no_real_model_call — the scorer is the injected seam (deterministic); no real model/network (spec SAFE-BUILD)", async () => {
    const park = fakePark();
    const scoreSpy = vi.fn(() => Promise.resolve(ok({ confidence: 0.9, workspaceId: WS_A })));
    const produce = createCorrelationSignalProducer({ scorer: { score: scoreSpy }, park });
    await produce(meetCtx(source({ workspaceId: WS_A })));
    expect(scoreSpy).toHaveBeenCalledTimes(1); // the confidence comes ONLY through the injected scorer
  });

  it("correlation_scorer_err_returns_err_not_park — a scorer fault propagates as a typed err (spec §16)", async () => {
    const park = fakePark();
    const produce = createCorrelationSignalProducer({
      scorer: { score: () => Promise.resolve(err({ code: "correlation_source_unavailable", message: "boom" })) },
      park,
    });
    const res = await produce(meetCtx(source({ workspaceId: WS_A })));
    expect(isErr(res)).toBe(true); // a fault is a typed err, NOT a silent park or bind
    expect(park.parks).toHaveLength(0);
  });
});

// ── shipped BOOT defaults — byte-equivalent binding (do NOT flip the spine to park) ──
describe("boot defaults — byte-equivalent binding (18.6/18.5 dormant behind the default)", () => {
  it("boot_defaults_bind_byte_equivalent — the boot resolver + scorer bind the boot workspace, never park (spec byte-equivalence)", async () => {
    const park = fakePark();
    // 18.6 default: bind the single boot workspace confidently (no project, no registry).
    const classify = createContentProjectClassify({
      resolve: createBootWorkspaceContentResolver(WS_A),
      park,
    });
    const cRes = await classify(srcCtx(source({ workspaceId: WS_A })));
    expect(isOk(cRes)).toBe(true);
    if (!isOk(cRes)) return;
    expect(cRes.value.workspaceId).toBe(WS_A);
    expect(cRes.value.confidence).toBeGreaterThanOrEqual(0.7); // binds (spine still routes)
    // 18.5 default: the fixed confident correlation to the boot workspace.
    const produce = createCorrelationSignalProducer({
      scorer: createBootCorrelationScorer({ workspaceId: WS_A }),
      park,
    });
    const pRes = await produce(meetCtx(source({ workspaceId: WS_A })));
    expect(isOk(pRes)).toBe(true);
    if (!isOk(pRes)) return;
    expect(pRes.value.workspaceId).toBe(WS_A);
    expect(pRes.value.confidence).toBeGreaterThanOrEqual(0.7); // binds (meeting still closes out)
    expect(park.parks).toHaveLength(0); // the DEFAULT never parks — byte-equivalent
  });
});
