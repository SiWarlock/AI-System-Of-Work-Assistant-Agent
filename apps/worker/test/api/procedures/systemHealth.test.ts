// Task 8.3 — System Health query surface (OBS-2 typed HealthItems as UiSafeHealthItem,
// audit-linked ref only; REQ-S-002 Employer-Work egress status). TDD RED-first.
//
// The System Health query surfaces the OBS-2 typed HealthItems (open / acknowledged
// / resolved) as UiSafeHealthItem — audit-linked but ref-only, NEVER raw: the
// projection DROPS `message`, `auditRef`, `parityReportRef`, `factIdentity`. The
// Employer-Work egress status (REQ-S-002) is surfaced here / via workspace settings.
import { describe, it, expect } from "vitest";
import {
  UI_SAFE_ALLOWLIST,
  REDACTED_CREDENTIAL,
  REDACTED_FIELD,
  isErr,
  isOk,
  ok,
  err,
  failure,
  type Result,
  type FailureVariant,
  type HealthItem,
} from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";
import {
  buildSystemHealthRouter,
  type SystemHealthQueryPort,
} from "../../../src/api/procedures/systemHealth";

function fieldSet(obj: object): string[] {
  return Object.keys(obj).sort();
}
function asRecord(obj: object): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

const AUTHED_CTX: ApiContext = {
  auth: ok<AuthedContext>({ authenticated: true }),
};

function fakeHealthItem(state: HealthItem["state"], resolvedAt?: string): HealthItem {
  return {
    id: `hi_${state}`,
    failureClass: "connector_unreachable",
    severity: "warn",
    message: "raw provider error text — must never reach the renderer", // DROPPED
    auditRef: "aud_1" as HealthItem["auditRef"], // DROPPED (ref only, never inlined)
    openedAt: "2026-06-30T00:00:00.000Z",
    state,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    parityReportRef: "rep_1" as HealthItem["parityReportRef"], // DROPPED
    factIdentity: "fact_1" as HealthItem["factIdentity"], // DROPPED
  };
}

const KNOWN_WORKSPACE = "ws_employer";
const UNKNOWN_WORKSPACE = "ws_missing";

function fakePort(overrides: Partial<SystemHealthQueryPort> = {}): SystemHealthQueryPort {
  const base: SystemHealthQueryPort = {
    healthItems: (): Result<readonly HealthItem[], FailureVariant> =>
      ok([
        fakeHealthItem("open"),
        fakeHealthItem("acknowledged"),
        fakeHealthItem("resolved", "2026-06-30T01:00:00.000Z"),
      ]),
    egressStatus: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok({
            workspaceId,
            employerRawEgressAcknowledged: false,
            zeroEgressOnly: true,
          })
        : err(
            failure("validation_rejected", "workspace not found", {
              cause: { code: "WORKSPACE_NOT_FOUND" },
            }),
          ),
  };
  return { ...base, ...overrides };
}

function makeCaller(port: SystemHealthQueryPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ health: buildSystemHealthRouter({ systemHealth: port }) });
  const factory = createCallerFactory(appRouter);
  return factory(ctx);
}

describe("buildSystemHealthRouter — OBS-2 typed HealthItems as UiSafeHealthItem", () => {
  it("returns typed health items across open / acknowledged / resolved states", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.map((h) => h.state).sort()).toEqual([
        "acknowledged",
        "open",
        "resolved",
      ]);
    }
  });

  it("projects each item to UI-safe fields ONLY (message / auditRef / parityReportRef / factIdentity dropped)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      for (const item of res.value) {
        // A resolved item carries the optional `resolvedAt`; open/acknowledged do
        // not — so the field set is a SUBSET of the allowlist, never a superset.
        const allowed = new Set<string>(UI_SAFE_ALLOWLIST.healthItem);
        for (const name of fieldSet(item)) {
          expect(allowed.has(name)).toBe(true);
        }
        // The audit link is ref-only — the raw internal refs never inline.
        expect(asRecord(item).auditRef).toBeUndefined();
        expect(asRecord(item).parityReportRef).toBeUndefined();
        expect(asRecord(item).factIdentity).toBeUndefined();
        // The raw message (may echo content/secret) never crosses.
        expect(asRecord(item).message).toBeUndefined();
      }
    }
  });

  it("a resolved item carries resolvedAt; an open item omits it", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.items();
    if (isOk(res)) {
      const open = res.value.find((h) => h.state === "open")!;
      const resolved = res.value.find((h) => h.state === "resolved")!;
      expect(asRecord(open).resolvedAt).toBeUndefined();
      expect(resolved.resolvedAt).toBeDefined();
    }
  });
});

describe("buildSystemHealthRouter — Employer-Work egress status (REQ-S-002)", () => {
  it("surfaces the egress-acknowledgment status for a KNOWN workspace", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.egressStatus({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(KNOWN_WORKSPACE);
      expect(res.value.employerRawEgressAcknowledged).toBe(false);
      expect(res.value.zeroEgressOnly).toBe(true);
    }
  });

  it("an UNKNOWN workspace returns a typed not-found err, never a partial leak", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.health.egressStatus({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("validation_rejected");
      expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("an over-broad port result cannot leak extra fields — only the allowlisted egress fields cross", async () => {
    // A port (or a future @sow/db binding) that returns an OVER-BROAD object with
    // an extra, non-UI-safe key must not ride that key out to the renderer. The
    // procedure reconstructs the egress status from ONLY the allowlisted fields.
    const leakyValue = {
      workspaceId: KNOWN_WORKSPACE,
      employerRawEgressAcknowledged: true,
      zeroEgressOnly: false,
      // Adversarial extra keys the port must NOT be able to leak through.
      rawEmployerContent: "secret quarterly numbers",
      keychainRef: "kc-ref://keychain/session-token",
    };
    const leakyPort = fakePort({
      egressStatus: () =>
        ok(leakyValue) as ReturnType<SystemHealthQueryPort["egressStatus"]>,
    });
    const caller = makeCaller(leakyPort);
    const res = await caller.health.egressStatus({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // Only the three allowlisted fields cross — the injected keys are gone.
      expect(fieldSet(res.value)).toEqual([
        "employerRawEgressAcknowledged",
        "workspaceId",
        "zeroEgressOnly",
      ]);
      expect(asRecord(res.value).rawEmployerContent).toBeUndefined();
      expect(asRecord(res.value).keychainRef).toBeUndefined();
      // The allowlisted values are preserved verbatim.
      expect(res.value.workspaceId).toBe(KNOWN_WORKSPACE);
      expect(res.value.employerRawEgressAcknowledged).toBe(true);
      expect(res.value.zeroEgressOnly).toBe(false);
    }
  });
});

describe("buildSystemHealthRouter — §16 boundary", () => {
  it("a port that THROWS is converted to a typed degraded err, never crossing the boundary", async () => {
    const caller = makeCaller(
      fakePort({
        healthItems: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await caller.health.items();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("degraded_unavailable");
      expect(res.error.message).not.toContain("boom");
    }
  });
});

// ── `### 24.102` — the egress-status OUTPUT sink (safety rule 7) ───────────────
//
// `UiSafeEgressStatus` is a bare TS interface — ERASED at runtime — and
// `toUiSafeEgressStatus` is a FIELD allowlist that passed `workspaceId` through
// VERBATIM. The allowlist pins above prove an over-broad port cannot add a FIELD;
// they say nothing about the VALUE inside an allowlisted field. These pins cover
// the VALUE.
//
// ⛔ The remedy is REDACTION AT THE SINK, not a shape/brand check: an id that
// fails a shape check would become UNRENDERABLE, which is the availability cost
// the owner priced and REJECTED (`### 24.84`). Redaction serves the response and
// scrubs only what is credential-shaped.
describe("buildSystemHealthRouter — `### 24.102` egress-status OUTPUT sink (rule 7)", () => {
  // spec(§16) — the canonical redactor scrubs a recognized credential TOKEN to the
  // frozen marker. Asserts the marker (WHY it changed), not merely `!== input`.
  it("a credential-shaped workspaceId is REDACTED before it reaches the projection output", async () => {
    const credentialShaped = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";
    const port = fakePort({
      egressStatus: () =>
        ok({
          workspaceId: credentialShaped,
          employerRawEgressAcknowledged: true,
          zeroEgressOnly: false,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({
      workspaceId: KNOWN_WORKSPACE,
    });
    // Fail-closed is NOT the remedy here — the response is still SERVED.
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(REDACTED_CREDENTIAL);
      // The secret material itself never crosses, in any form.
      expect(res.value.workspaceId).not.toContain("sk-ant-api03");
      // Redacting the id must not disturb the other allowlisted values.
      expect(res.value.employerRawEgressAcknowledged).toBe(true);
      expect(res.value.zeroEgressOnly).toBe(false);
    }
  });

  // spec(§16) — L196: the credential fixture above is a CONJUNCTION (credential-
  // shaped AND scrubbable-to-a-marker). This pins the OTHER conjunct separately:
  // a value that trips the sensitive-KEYWORD net has no scrubbable token, so the
  // fail-safe drops the WHOLE field. Different code path, different marker.
  it("a keyword-bearing workspaceId is dropped WHOLE (fail-safe), not partially scrubbed", async () => {
    const port = fakePort({
      egressStatus: () =>
        ok({
          workspaceId: "my-secret-ws",
          employerRawEgressAcknowledged: false,
          zeroEgressOnly: true,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({
      workspaceId: KNOWN_WORKSPACE,
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(REDACTED_FIELD);
      expect(res.value.workspaceId).not.toContain("secret");
    }
  });

  // spec(§5) — THE OWNER-PRICED AVAILABILITY GUARANTEE, and it is a pin, not an
  // oversight. Every live workspace id AND the brand-non-conforming legacy shapes
  // must still be SERVED and still render VERBATIM. A remedy that rejected or
  // altered any of these would be the availability break the owner rejected.
  it.each([
    ["employer-work"],
    ["personal-business"],
    ["personal-life"],
    ["ws_employer"],
    // ⚠ `ws-acme` and the `ACME` LIMITATION pin below assert the SAME behaviour
    // from opposite sides — here it is a guarantee to PRESERVE, there it is a bound
    // not to widen silently. Change one and the other REDs; that is intended.
    ["ws-acme"],
  ])("a live / legacy non-conforming id (%s) still renders VERBATIM", async (id) => {
    const port = fakePort({
      egressStatus: () =>
        ok({
          workspaceId: id,
          employerRawEgressAcknowledged: false,
          zeroEgressOnly: true,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({ workspaceId: id });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(id);
    }
  });

  // spec(§16) — THE DOCBLOCK'S STATED BOUND, MADE EXECUTABLE. The sink's coverage
  // is credential-SHAPE, not sensitivity: `audit-signal.ts` concedes an employer
  // project codename passes, and it does. This pin exists so the docblock cannot
  // silently become an overclaim — if a future change broadens coverage, this
  // test REDS and the docblock must be rewritten in the same commit.
  // ⛔ It asserts a LIMITATION deliberately; do not "fix" it by widening silently.
  it("does NOT claim to catch a non-credential-shaped employer codename — the stated bound", async () => {
    const port = fakePort({
      egressStatus: () =>
        ok({
          workspaceId: "ACME",
          employerRawEgressAcknowledged: false,
          zeroEgressOnly: true,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({
      workspaceId: KNOWN_WORKSPACE,
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe("ACME");
    }
  });

  // spec(§5) — ⛔ RULE-5-ADJACENT CONSEQUENCE, MADE EXECUTABLE RATHER THAN LEFT AS
  // PROSE. Redaction leaves every benign id byte-identical, so for the whole live
  // population the response echoes the request. For a CREDENTIAL-SHAPED id it does
  // NOT: the served value diverges from the value the caller asked with.
  //
  // That divergence is load-bearing downstream. `apps/desktop`'s `foldStatus`
  // compares the wire's `workspaceId` against the caller's own input and FAILS
  // CLOSED on mismatch ⇒ for such a workspace the egress posture does not render
  // at all. The egress-posture surface is how a human sees whether Employer-Work
  // raw egress is ON (safety rule 5), so this converts "posture visible" into
  // "posture unavailable" for exactly the hazard population.
  //
  // ⭐ Fail-closed is the CORRECT direction — showing nothing beats rendering a
  // credential — but it is written down HERE, as a pin, so the consequence travels
  // with the behaviour instead of living only in a decision packet. `### 24.108`
  // owns the `foldStatus` side; nothing in `apps/desktop` is touched by this slice.
  it("a redacted workspaceId DIVERGES from the request value (rule-5-adjacent, deliberate)", async () => {
    const credentialShaped = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";
    // A realistic port echoes back the workspace's own id, so request and response
    // carry the SAME string before the sink runs.
    const port = fakePort({
      egressStatus: (workspaceId) =>
        ok({
          workspaceId,
          employerRawEgressAcknowledged: true,
          zeroEgressOnly: false,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({
      workspaceId: credentialShaped,
    });
    // Still SERVED — the remedy is redaction, never refusal.
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // THE DIVERGENCE, asserted directly: what is served is not what was asked.
      expect(res.value.workspaceId).not.toBe(credentialShaped);
      expect(res.value.workspaceId).toBe(REDACTED_CREDENTIAL);
      // The rest of the posture is intact — only the id is substituted.
      expect(res.value.employerRawEgressAcknowledged).toBe(true);
      expect(res.value.zeroEgressOnly).toBe(false);
    }
  });

  // ⚠ UNCHANGED-BEHAVIOUR FENCE, not coverage of this slice: it exercises
  // `parseWorkspaceInput`, which this slice does not touch, and passes identically
  // with the redaction removed. It is here so a later edit cannot weaken fail-closed.
  // spec(§16) — fail-closed unchanged: a malformed transport payload is still
  // rejected at the plain-function validator, and it is rejected for the STATED
  // reason (`invalid_input`), never as a bare falsity (`### 24.101`).
  it("a malformed payload stays REJECTED at the validator, with its reason", async () => {
    const caller = makeCaller(fakePort());
    await expect(
      caller.health.egressStatus({ workspaceId: "" } as unknown as { workspaceId: string }),
    ).rejects.toThrow(/invalid_input/);
  });

  // spec(§16) — THE SINK MUST BE TOTAL. The type is erased at runtime and the
  // suite above already proves ports return off-contract objects, so a non-string
  // `workspaceId` is reachable. `redactString` is total over `string` only and
  // THROWS on anything else — which `authedResolver` would convert into
  // `degraded_unavailable`, turning a previously-SERVED response into a failure.
  it.each([[123], [null], [undefined], [{ a: 1 }]])(
    "an off-contract non-string workspaceId (%s) is dropped, never thrown",
    async (bad) => {
      const port = fakePort({
        egressStatus: () =>
          ok({
            workspaceId: bad,
            employerRawEgressAcknowledged: false,
            zeroEgressOnly: true,
          }) as unknown as ReturnType<SystemHealthQueryPort["egressStatus"]>,
      });
      const res = await makeCaller(port).health.egressStatus({
        workspaceId: KNOWN_WORKSPACE,
      });
      // Served, not degraded — the sink absorbs it.
      expect(isOk(res)).toBe(true);
      if (isOk(res)) {
        expect(res.value.workspaceId).toBe(REDACTED_FIELD);
      }
    },
  );

  // spec(§16) — THE THIRD REDACTION OUTCOME, and the most plausible real shape: a
  // credential EMBEDDED in a longer id is scrubbed IN PLACE. Neither frozen marker
  // is the whole value. Pinned because the docblock now claims exactly this, and
  // the two whole-value pins above cannot demonstrate it.
  it("an EMBEDDED credential is scrubbed in place, preserving the surrounding id", async () => {
    const port = fakePort({
      egressStatus: () =>
        ok({
          workspaceId: "ws-sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
          employerRawEgressAcknowledged: false,
          zeroEgressOnly: true,
        }),
    });
    const res = await makeCaller(port).health.egressStatus({
      workspaceId: KNOWN_WORKSPACE,
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe(`ws-${REDACTED_CREDENTIAL}`);
      expect(res.value.workspaceId).not.toContain("sk-ant-api03");
    }
  });

  // spec(§5) — ⛔ THE AVAILABILITY COST, MADE EXECUTABLE. The fail-safe fires on a
  // SENSITIVE KEYWORD, not only on a credential, so a BENIGN id containing one is
  // dropped whole ⇒ that workspace's egress posture stops rendering. No live id is
  // affected, but the id space is open (`onboarding.ts`), so this is a real cost on
  // an unmeasured population — pinned so it is a known behaviour, not a surprise.
  // ⛔ Do NOT "fix" this by narrowing the redactor here: a second, local credential
  // heuristic is exactly the divergence `### 24.110` was filed for.
  it.each([["client-secret-audit"], ["bearer-bonds"], ["my-api-key-ws"]])(
    "a BENIGN id containing a sensitive keyword (%s) is dropped whole — a real availability cost",
    async (benign) => {
      const port = fakePort({
        egressStatus: (workspaceId) =>
          ok({
            workspaceId,
            employerRawEgressAcknowledged: false,
            zeroEgressOnly: true,
          }),
      });
      const res = await makeCaller(port).health.egressStatus({ workspaceId: benign });
      expect(isOk(res)).toBe(true);
      if (isOk(res)) {
        expect(res.value.workspaceId).toBe(REDACTED_FIELD);
      }
    },
  );
});
