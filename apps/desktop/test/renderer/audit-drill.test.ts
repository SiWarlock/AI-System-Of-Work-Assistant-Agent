// 9.41 leg C — the renderer audit-drill caller. The renderer only REQUESTS — the worker
// (`query.auditDrill`) re-derives the AuditRecord server-side and re-checks WS-8 scope-ownership.
// A denial (err Result), a transport error, AND a malformed-but-ok / schema-invalid runtime value
// (desktop L46 — worker output is candidate data to the renderer too) all fold to { ok: false } so
// nothing raw/partial is ever surfaced, and the three are INDISTINGUISHABLE to the caller.
import { describe, it, expect } from "vitest";
import { createAuditDrill } from "../../renderer/lib/audit-drill";

// A minimal fake tRPC client exposing only query.auditDrill.query.
function fakeClient(queryImpl: (input: unknown) => Promise<unknown>): never {
  return { query: { auditDrill: { query: queryImpl } } } as never;
}

const VALID_SUMMARY = { event: "note_created", occurredAt: "2026-07-20T10:00:00.000Z" };

describe("createAuditDrill", () => {
  it("resolves_a_permitted_drill_to_its_summary", async () => {
    const drill = createAuditDrill(fakeClient(() => Promise.resolve({ ok: true, value: VALID_SUMMARY })));
    const r = await drill("ws-employer", "chg-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary).toEqual(VALID_SUMMARY);
  });

  it("folds_denial_transport_throw_and_malformed_ok_all_to_not_ok", async () => {
    const denial = createAuditDrill(
      fakeClient(() =>
        Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "DRILL_NOT_PERMITTED" } } }),
      ),
    );
    const thrown = createAuditDrill(fakeClient(() => Promise.reject(new Error("socket down"))));
    const malformed = createAuditDrill(fakeClient(() => Promise.resolve({ ok: true, value: "not-an-object" })));

    // Each independently yields { ok: false }...
    expect((await denial("ws-employer", "chg-1")).ok).toBe(false);
    expect((await thrown("ws-employer", "chg-1")).ok).toBe(false);
    expect((await malformed("ws-employer", "chg-1")).ok).toBe(false);

    // ...and are byte-identical to each other (no probe-oracle distinguishing denial/fault/malformed).
    const [d, t, m] = await Promise.all([
      denial("ws-employer", "chg-1"),
      thrown("ws-employer", "chg-1"),
      malformed("ws-employer", "chg-1"),
    ]);
    expect(d).toEqual({ ok: false });
    expect(t).toEqual({ ok: false });
    expect(m).toEqual({ ok: false });
  });

  it("a_schema_invalid_summary_is_dropped_not_rendered", async () => {
    // desktop L46 — worker output is candidate data to the renderer too; re-validate through the
    // SAME contract schema (UiSafeAuditDrillSummarySchema, .strict()) even on an { ok: true } result.
    const extraKey = createAuditDrill(
      fakeClient(() => Promise.resolve({ ok: true, value: { ...VALID_SUMMARY, auditRef: "leak-vector" } })),
    );
    expect((await extraKey("ws-employer", "chg-1")).ok).toBe(false);

    // event is uiSafeToken-bounded (<=64 chars, single-line) — an over-length value fails the gate.
    const oversizedEvent = createAuditDrill(
      fakeClient(() => Promise.resolve({ ok: true, value: { event: "x".repeat(65), occurredAt: VALID_SUMMARY.occurredAt } })),
    );
    expect((await oversizedEvent("ws-employer", "chg-1")).ok).toBe(false);

    // occurredAt must be a real ISO datetime.
    const badTimestamp = createAuditDrill(
      fakeClient(() => Promise.resolve({ ok: true, value: { event: VALID_SUMMARY.event, occurredAt: "not-a-date" } })),
    );
    expect((await badTimestamp("ws-employer", "chg-1")).ok).toBe(false);
  });

  it("re_gate_never_over_rejects_a_legitimately_maximal_event", async () => {
    // Companion to the oversized-event case above (code-quality review): proves the re-gate isn't
    // ACCIDENTALLY stricter than the contract — a future edit that tightened the cap would still
    // pass "the too-long case is rejected" while silently breaking every maximal-length audit event.
    // Mirrors copilot-ask.test.ts's re_gate_never_over_rejects_producer_output idiom.
    const atCap = createAuditDrill(
      fakeClient(() => Promise.resolve({ ok: true, value: { event: "x".repeat(64), occurredAt: VALID_SUMMARY.occurredAt } })),
    );
    const r = await atCap("ws-employer", "chg-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.event).toBe("x".repeat(64));
  });
});
