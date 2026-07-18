// 18.24 step-6 (Commit B) — the composition-root wiring: the single-sourced local route (kills the L37
// transcription-drift), and `withSubscriptionExtractionArming` — the boot-side proof-spine post-processor
// (mirrors `withDurableRevisions`) that, ONLY when the `config.providerTransport` arming signal is effectively
// armed, swaps the source.process route to the cloud {runtime} subscription route + populates the source
// ContextRef the resolver derefs. DORMANT: the shipped default leaves `config.providerTransport` unset ⇒
// `armed=false` ⇒ params returned UNCHANGED (byte-equivalent). Reachability-WAIVERED (L11): the armed branch
// is exercised only at the owner ENABLE (step 6, HARD STOP).
import { describe, it, expect } from "vitest";
import {
  buildAutoIngestProofSpineParams,
  withSubscriptionExtractionArming,
} from "../../src/boot";
import {
  LOCAL_EXTRACTION_ROUTE,
  CLOUD_EXTRACTION_ROUTE,
} from "../../src/composition/extraction-route-gate";
import { SOURCE_CONTEXT_REF_KIND } from "../../src/composition/real-extraction-content-resolver";
import { AGENT_EXTRACTION_SCHEMA_ID, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID } from "@sow/contracts";
import type { ProviderRoute } from "@sow/contracts";

// `source.process` is a worker-internal capability arch_gap string, not in the branded `Capability` union
// (the source stores it behind an `as` cast) — read it back through a permissive record view for assertions.
const sourceRoute = (p: { resolved: { providerMatrix: { capabilityDefaults: unknown } } }): ProviderRoute =>
  (p.resolved.providerMatrix.capabilityDefaults as Record<string, ProviderRoute>)["source.process"]!;

describe("buildAutoIngestProofSpineParams — the source.process route is SINGLE-SOURCED (18.24 item iv, L5/L37)", () => {
  it("capability_defaults_single_sourced — capabilityDefaults['source.process'] IS the shared LOCAL_EXTRACTION_ROUTE constant (drift-guard) [spec(§19.5)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    const route = sourceRoute(params);
    // The boot literal, LOCAL_EXTRACTION_ROUTE, and source-extraction.ts DEFAULT_ROUTE are now ONE literal:
    // a change to the shared constant can never silently drift the boot copy (byte-equivalent to today's value).
    expect(route).toBe(LOCAL_EXTRACTION_ROUTE);
    expect(route).toStrictEqual({
      provider: "ollama",
      model: "local-default",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    });
  });

});

describe("withSubscriptionExtractionArming — co-gated route swap + source ContextRef (18.24 #3, dormant)", () => {
  it("arming_off_is_byte_equivalent — armed=false ⇒ params returned UNCHANGED (local route, no contextRefs) [spec(§19.5)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    expect(withSubscriptionExtractionArming(params, false)).toStrictEqual(params);
  });

  it("arming_off_undefined_params_stays_undefined — no proof-spine (auto-ingest off) ⇒ undefined (byte-equivalent) [spec(L2)]", () => {
    expect(withSubscriptionExtractionArming(undefined, true)).toBeUndefined();
  });

  it("arming_on_swaps_cloud_route_and_one_source_contextref — armed ⇒ source.process route=CLOUD + EXACTLY ONE {refKind:'source', ref:sourceRef.sourceId} [spec(§19.5/§5)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    const armed = withSubscriptionExtractionArming(params, true)!;
    // The extraction route swaps to the cloud {runtime} subscription route (re-triggers the §5 veto downstream).
    expect(sourceRoute(armed)).toStrictEqual(CLOUD_EXTRACTION_ROUTE);
    // Exactly ONE source ContextRef, and its ref is the ROUTING-BOUND ingestion identity (never content).
    const refs = armed.sourceIngestion!.contextRefs ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.refKind).toBe(SOURCE_CONTEXT_REF_KIND);
    expect(refs[0]!.ref).toBe(String(params.sourceIngestion!.sourceRef.sourceId));
  });

  it("arming_on_sourceid_is_routing_bound_never_content — the ContextRef ref == sourceIngestion.sourceRef.sourceId (WS-8 config identity, not a content field) [spec(L33/L45)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    const armed = withSubscriptionExtractionArming(params, true)!;
    // The parked-source reader derefs THIS id; it is the same id the source idempotencyKey + parkedReader use.
    // withSubscriptionExtractionArming reads ONLY sourceRef.sourceId (config binding) — no content field can influence it.
    expect(armed.sourceIngestion!.contextRefs![0]!.ref).toBe(
      String(params.sourceIngestion!.sourceRef.sourceId),
    );
    // The non-source fields of sourceIngestion are preserved (only contextRefs is added).
    expect(armed.sourceIngestion!.boundWorkspaceId).toBe(params.sourceIngestion!.boundWorkspaceId);
  });

  it("arming_on_without_sourceingestion_swaps_route_stamps_no_ref — armed + params w/o sourceIngestion ⇒ route swapped, NO ContextRef, no throw (resolver fails closed on zero refs, L60) [spec(§19.5)]", () => {
    const params = { ...buildAutoIngestProofSpineParams("ws-arm"), sourceIngestion: undefined };
    const armed = withSubscriptionExtractionArming(params, true)!;
    expect(sourceRoute(armed)).toStrictEqual(CLOUD_EXTRACTION_ROUTE); // route still swaps …
    expect(armed.sourceIngestion).toBeUndefined(); // … but nothing to stamp a ref on (safe)
  });
});

describe("withSubscriptionExtractionArming — co-gated outputSchemaId flip (18.27 / #13 Finding C, L57)", () => {
  it("arming_flips_outputschemaid_both_legs — armed ⇒ meeting AND source outputSchemaId both = sow:agent-extraction (so the candidate normalizes to agent_extraction not the KMP stand-in) [spec(§19.5/REQ-F-017)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    const armed = withSubscriptionExtractionArming(params, true)!;
    expect(armed.meetingJobInputs.outputSchemaId).toBe(AGENT_EXTRACTION_SCHEMA_ID);
    expect(armed.sourceIngestion!.outputSchemaId).toBe(AGENT_EXTRACTION_SCHEMA_ID);
  });

  it("unarmed_stays_kmp — armed=false ⇒ meeting outputSchemaId stays KMP + sourceIngestion.outputSchemaId undefined (byte-equivalent, AND-locked before the flip, L57) [spec(L2)]", () => {
    const params = buildAutoIngestProofSpineParams("ws-arm");
    const unarmed = withSubscriptionExtractionArming(params, false)!;
    expect(unarmed.meetingJobInputs.outputSchemaId).toBe(KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID);
    expect(unarmed.sourceIngestion!.outputSchemaId).toBeUndefined();
  });
});
