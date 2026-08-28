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
  // 16.6 — the activity now takes a WS-8-scoped dedupe probe and binds the per-call source's
  // workspaceId (a fresh always-miss probe here isolates the fold behaviour from the dedupe store).
  const noDedupe = (_ws: string, _h: string): Promise<boolean> => Promise.resolve(false);

  it("a fresh, well-formed source → registered, carrying the validated envelope", async () => {
    const registerSource = (
      _input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({ outcome: "registered", envelope: makeSourceEnvelope() });
    const port = createRegisterSourceActivity({ registerSource, seenContentHash: noDedupe });

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
    const port = createRegisterSourceActivity({ registerSource, seenContentHash: noDedupe });

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
    const port = createRegisterSourceActivity({ registerSource, seenContentHash: noDedupe });

    const result = await port.register(makeSourceContext());

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("malformed_source");
  });

  it("restores the §8 gate's diagnostic message (SoW-authored: every SourceEnvelope field is an open string/branded-id check, never an enum a Zod issue could echo)", async () => {
    const registerSource = (
      _input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({
        outcome: "rejected",
        code: "MALFORMED",
        message: "source-envelope zod rejection: workspaceId: String must contain at least 1 character(s)",
      });
    const port = createRegisterSourceActivity({ registerSource, seenContentHash: noDedupe });

    const result = await port.register(makeSourceContext());

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // code crosses byte-identically — the driver switches on it.
    expect(result.error.code).toBe("malformed_source");
    // Restored (2026-08-27): SourceEnvelopeSchema's fields are all `.string().min(1)` /
    // branded ids (packages/contracts/src/models/source-envelope.ts), never a z.enum/z.literal,
    // so this gate's message never carries candidate-controlled content — an operator needs the
    // real reason to fix the offending source.
    expect(result.error.message).toBe(
      "source registration rejected: source-envelope zod rejection: workspaceId: String must contain at least 1 character(s)",
    );
  });

  it("two distinct malformed-source rejections render distinct messages (mutation-provable: a fixed literal would collapse both to one string)", async () => {
    const rejecting = (message: string) => (
      _input: RegisterSourceInput,
      _deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> =>
      Promise.resolve({ outcome: "rejected", code: "MALFORMED", message });

    const portA = createRegisterSourceActivity({
      registerSource: rejecting("source-envelope zod rejection: contentHash: String must contain at least 1 character(s)"),
      seenContentHash: noDedupe,
    });
    const portB = createRegisterSourceActivity({
      registerSource: rejecting("source-envelope schema violation (additionalProperties)"),
      seenContentHash: noDedupe,
    });

    const resultA = await portA.register(makeSourceContext());
    const resultB = await portB.register(makeSourceContext());

    expect(isOk(resultA)).toBe(false);
    expect(isOk(resultB)).toBe(false);
    if (isOk(resultA) || isOk(resultB)) return;
    expect(resultA.error.code).toBe("malformed_source");
    expect(resultB.error.code).toBe("malformed_source");
    expect(resultA.error.message).not.toBe(resultB.error.message);
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
    const port = createRegisterSourceActivity({ registerSource, seenContentHash: noDedupe });

    await port.register(makeSourceContext());

    expect(captured?.contentHash).toBe("hash-source-1");
    expect(captured?.origin).toBe("https://youtube.com/watch?v=abc");
  });

  it("register_threads_workspace_id_to_the_dedupe_probe: the WS-8-scoped probe receives the per-call source's (workspaceId, contentHash) [spec(§4)]", async () => {
    let probeArgs: { ws: string; hash: string } | undefined;
    const registerSource = (
      input: RegisterSourceInput,
      deps: RegisterSourceDeps,
    ): Promise<RegisterSourceResult> => {
      // registerSource passes only contentHash to its dep; the activity must have already bound the
      // source's workspaceId into that dep (WS-8: a hash is deduped only within its own workspace).
      return deps.seenContentHash(input.contentHash).then(() =>
        Promise.resolve({ outcome: "registered", envelope: makeSourceEnvelope() }),
      );
    };
    const port = createRegisterSourceActivity({
      registerSource,
      seenContentHash: (ws: string, hash: string): Promise<boolean> => {
        probeArgs = { ws, hash };
        return Promise.resolve(false);
      },
    });
    await port.register(makeSourceContext()); // source workspaceId = "ws-inbox", contentHash = "hash-source-1"
    expect(probeArgs).toEqual({ ws: "ws-inbox", hash: "hash-source-1" });
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

  it("R3 (24.73 restore round): the classifier's own `message` crosses, but `cause` stays dropped (narrower restore than the sibling activities)", async () => {
    // Unlike correlateMeeting.ts/routeToApproval.ts/deterministicProgress.ts/
    // buildGclProjection.ts (fully restored — their bound producers never carry a
    // real `cause`), routeSource.ts's real bound classifier
    // (`createContentProjectClassify`, apps/worker/composition/content-project-
    // resolver.ts) explicitly BINDS a raw thrown value as `cause` on its own fault
    // path, relying on THIS activity to strip it (its own comment names this
    // exact site) — a live safety property apps/worker's
    // contentProjectResolverRedaction.test.ts pins end-to-end. So only the
    // over-corrected `message` is restored here (via `dropCause`); `cause` is a
    // KEPT drop, same discipline as the DbError sites in approvalTransition.ts.
    const SECRET_POISON = "PZN9F3A1BSECRET-leak";
    const DSN_POISON = `postgres://u:${SECRET_POISON}@h/db`;
    const failure: RouteError = {
      code: "route_failed",
      message: "content classifier faulted",
      cause: { dsn: DSN_POISON },
    };
    const port = createRouteSourceActivity({
      classify: (): Promise<Result<RouteSignals, RouteError>> =>
        Promise.resolve({ ok: false, error: failure }),
    });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // code crosses byte-identically — the driver switches on it.
    expect(result.error.code).toBe("route_failed");
    // RESTORED: the classifier's own message crosses verbatim (mutation-proof —
    // a re-added full redaction would replace this with a different fixed literal).
    expect(result.error.message).toBe("content classifier faulted");
    // KEPT: cause is still dropped entirely (not merely emptied) and no poison
    // rides `message` — this is the real leak the sibling apps/worker pin guards.
    expect(Object.keys(result.error).sort()).toEqual(["code", "message"]);
    expect(JSON.stringify(result.error)).not.toContain(SECRET_POISON);
  });

  it("uses the default 0.7 threshold when none is injected", async () => {
    const port = portFor({ confidence: 0.7, workspaceId: WS });
    const result = await port.route(makeSourceContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.confidence).toBe("high");
  });
});
