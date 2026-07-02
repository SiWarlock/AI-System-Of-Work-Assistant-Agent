// spec(§9) — task 7.7 SOURCE-INGESTION ACTIVITIES: registerSource + routeSource.
//
// These unit-test the two 7.7-specific activities that implement the port seam with
// INJECTED effects (the real adapters folded to the closed error vocabulary), so the
// worker-wiring wave can swap in the concrete @sow/integrations / classifier without
// changing the driver. The derive-from-validated activities (validate / buildOutputs
// / commit / propose / index) are the shared 7.6 activities, already covered by
// meeting-activities.test.ts.
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  RegisterSourceInput,
  RegisterSourceDeps,
  RegisterSourceResult,
} from "@sow/integrations";
import { createRegisterSourceActivity } from "../src/activities/registerSource";
import { createRouteSourceActivity } from "../src/activities/routeSource";
import type { RouteSignals } from "../src/activities/routeSource";
import type { RouteError } from "../src/ports/sourceIngestion";
import { makeSourceContext, makeSourceEnvelope } from "./support/source-fakes";
import { workspaceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";

// --- registerSource activity -----------------------------------------------

describe("spec(§9) registerSource activity — register-then-dedupe, folds to the port union", () => {
  const noDedupe: RegisterSourceDeps = { seenContentHash: () => Promise.resolve(false) };

  it("a fresh, well-formed source → registered, carrying the validated envelope", async () => {
    const registerSource = (
      _input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({ outcome: "registered", envelope: makeSourceEnvelope() });
    const port = createRegisterSourceActivity({ registerSource, deps: noDedupe });

    const result = await port.register(makeSourceContext());

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.outcome).toBe("registered");
  });

  it("a known contentHash → dedupe_hit (the driver treats it as a no-op)", async () => {
    const registerSource = (
      input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({ outcome: "dedupe_hit", contentHash: input.contentHash });
    const port = createRegisterSourceActivity({ registerSource, deps: noDedupe });

    const result = await port.register(makeSourceContext());

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.outcome).toBe("dedupe_hit");
      if (result.value.outcome === "dedupe_hit") {
        expect(result.value.contentHash).toBe("hash-source-1");
      }
    }
  });

  it("a MALFORMED rejection folds onto the typed malformed_source error", async () => {
    const registerSource = (
      _input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({ outcome: "rejected", code: "MALFORMED", message: "blank workspaceId" });
    const port = createRegisterSourceActivity({ registerSource, deps: noDedupe });

    const result = await port.register(makeSourceContext());

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("malformed_source");
  });

  it("maps the context source VERBATIM into the register input (no inference)", async () => {
    let captured: RegisterSourceInput | undefined;
    const registerSource = (
      input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> => {
      captured = input;
      return Promise.resolve({ outcome: "registered", envelope: makeSourceEnvelope() });
    };
    const port = createRegisterSourceActivity({ registerSource, deps: noDedupe });

    await port.register(makeSourceContext());

    expect(captured?.contentHash).toBe("hash-source-1");
    expect(captured?.origin).toBe("https://youtube.com/watch?v=abc");
  });
});

// --- routeSource activity ---------------------------------------------------

describe("spec(§9 inv-1) routeSource activity — never auto-routes below threshold", () => {
  const WS = workspaceId("ws-routed") as WorkspaceId;

  function portFor(signals: RouteSignals, threshold?: number) {
    return createRouteSourceActivity({
      classify: () => Promise.resolve({ ok: true, value: signals }),
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }

  it("high confidence + resolved workspace → high (WS-2 bind)", async () => {
    const port = portFor({ confidence: 0.9, workspaceId: WS, projectId: "proj-1" });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confidence).toBe("high");
      if (result.value.confidence === "high") {
        expect(result.value.workspaceId).toBe(WS);
        expect(result.value.projectId).toBe("proj-1");
      }
    }
  });

  it("sub-threshold confidence → low (Ingestion Inbox), NO workspace even if one was guessed", async () => {
    const port = portFor({ confidence: 0.4, workspaceId: WS, reason: "ambiguous" });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confidence).toBe("low");
      // The union forbids reading a workspaceId off a low outcome — proven by type +
      // the queuedForReview marker.
      if (result.value.confidence === "low") {
        expect(result.value.queuedForReview).toBe(true);
        expect(result.value.reason).toBe("ambiguous");
      }
    }
  });

  it("at/above threshold but NO resolved workspace → low (never guesses a workspace)", async () => {
    const port = portFor({ confidence: 0.95 });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.confidence).toBe("low");
  });

  it("a classifier failure surfaces as a typed RouteError (never throws)", async () => {
    const failure: RouteError = { code: "route_failed", message: "classifier down" };
    const port = createRouteSourceActivity({
      classify: (): Promise<Result<RouteSignals, RouteError>> =>
        Promise.resolve({ ok: false, error: failure }),
    });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("route_failed");
  });

  it("uses the default 0.7 threshold when none is injected", async () => {
    const port = portFor({ confidence: 0.7, workspaceId: WS });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.confidence).toBe("high");
  });
});
