// Slice 1 (task 13.10) — the external-write transport OWNER-GATE (§8 external-write
// envelope; safety rule 3). The outbound per-target write client (`AdapterTransport`)
// must default to the deterministic in-memory STUB and may be swapped for a real vendor
// transport ONLY by deliberate owner config — never by editing a hardcoded call site.
//
// These tests pin the pure `selectAdapterTransport(gate?)` seam (the unit-testable gate
// per §2.5 vote #2) + the `assembleBackends({})` default-path wiring:
//   • default / gate-absent ⇒ the STUB (byte-equivalent shipped default; Lesson 8).
//   • the real factory is NEVER invoked on any OFF path (factory-spy zero-invocation;
//     Lesson 11/23) — nothing real is constructed by the shipped default.
//   • STRICT `=== true` — a truthy-but-not-`true` enable (`1`, `"true"`, `{}`, …) does
//     NOT arm (no truthy-coerce false-arming vector; Lesson 23).
//   • AND-composed OFF-locks — BOTH the strict flag AND an owner-injected factory are
//     required; missing/false either ⇒ stub (adversarial pairwise-defeat; Lesson 8).
//   • gate ON (flag `=== true` AND factory present) ⇒ the real transport is selected
//     (factory invoked once) — the seam is a live capability, not a dead no-op.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AdapterTransport, AdapterTransportRequest } from "@sow/integrations";
import type { TargetSystem } from "@sow/contracts";
import {
  assembleBackends,
  selectAdapterTransport,
  type ProofSpineBackends,
} from "../../src/composition/backends";

// A minimal `create` request the stub answers with a deterministic `stub-obj:…` id
// (and dedupes on a second create for the same key). Observing that response is how we
// prove the STUB — not the real transport — was selected.
const createReq = (key: string): AdapterTransportRequest => ({
  op: "create",
  targetSystem: "todoist" as TargetSystem,
  canonicalObjectKey: key,
  idempotencyKey: `idem:${key}`,
  identity: { key },
});

// A distinctively-shaped fake "real" transport so a selected-real response is
// unambiguous (its ids never collide with the stub's `stub-obj:` namespace).
const fakeRealTransport: AdapterTransport = () =>
  Promise.resolve({ ok: true, object: { externalObjectId: "real:vendor:42" } });

// The stub's deterministic create id for a given key/target.
const stubId = (key: string): string => `stub-obj:todoist:${key}`;

describe("selectAdapterTransport — external-write transport owner-gate", () => {
  it("default (no gate) selects the deterministic stub transport", async () => {
    const t = selectAdapterTransport(undefined);
    const first = await t(createReq("k1"));
    expect(first).toEqual({ ok: true, object: { externalObjectId: stubId("k1") } });
    // A second create dedupes (idempotent within the process) — the stub's signature.
    const second = await t(createReq("k1"));
    expect(second).toEqual({
      ok: true,
      object: { externalObjectId: stubId("k1") },
      deduped: true,
    });
  });

  it("gate off (flag absent) never invokes the real factory ⇒ stub", async () => {
    const make = vi.fn<() => AdapterTransport>(() => {
      throw new Error("real transport factory must not be constructed on the OFF path");
    });
    const t = selectAdapterTransport({ make });
    expect(make).not.toHaveBeenCalled();
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  it("gate off (flag === false) never invokes the real factory ⇒ stub", async () => {
    const make = vi.fn<() => AdapterTransport>(() => {
      throw new Error("real transport factory must not be constructed on the OFF path");
    });
    const t = selectAdapterTransport({ enabled: false, make });
    expect(make).not.toHaveBeenCalled();
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  // STRICT `=== true`: no truthy-coerce false-arming vector (Lesson 23).
  it.each([
    ["number 1", 1],
    ['string "true"', "true"],
    ['string "false"', "false"], // truthy yet obviously not `true` — the sharpest false-arming vector
    ['string "yes"', "yes"],
    ['string "1"', "1"],
    ["empty object", {}],
    ["empty array", []],
  ])("truthy-but-not-true enable (%s) ⇒ stub, factory not invoked", async (_label, truthy) => {
    const make = vi.fn<() => AdapterTransport>(() => {
      throw new Error("truthy-but-not-true must not arm the real transport");
    });
    const t = selectAdapterTransport({
      enabled: truthy as unknown as boolean,
      make,
    });
    expect(make).not.toHaveBeenCalled();
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  it("flag === true but NO factory ⇒ stub (AND-lock: both required)", async () => {
    const t = selectAdapterTransport({ enabled: true });
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  // Type-robust `make` lock: a JSON-sourced config could carry a non-function `make`.
  // It must fail CLOSED to the stub (never throw at boot), symmetric with strict `=== true`.
  it.each([
    ["null make", null],
    ["string make", "createTransport"],
    ["number make", 0],
    ["object make", {}],
  ])("flag === true but non-function make (%s) ⇒ stub (fail-closed, no throw)", async (_label, badMake) => {
    const t = selectAdapterTransport({
      enabled: true,
      make: badMake as unknown as () => AdapterTransport,
    });
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  it("factory present but flag off ⇒ stub, factory not invoked (AND-lock: both required)", async () => {
    const make = vi.fn<() => AdapterTransport>(() => {
      throw new Error("factory alone (flag off) must not arm the real transport");
    });
    const t = selectAdapterTransport({ make });
    expect(make).not.toHaveBeenCalled();
    expect(await t(createReq("k"))).toMatchObject({
      ok: true,
      object: { externalObjectId: stubId("k") },
    });
  });

  it("flag === true AND factory present ⇒ the real transport is selected (factory invoked once)", async () => {
    const make = vi.fn<() => AdapterTransport>(() => fakeRealTransport);
    const t = selectAdapterTransport({ enabled: true, make });
    expect(make).toHaveBeenCalledTimes(1);
    const resp = await t(createReq("k"));
    expect(resp).toEqual({ ok: true, object: { externalObjectId: "real:vendor:42" } });
  });
});

describe("assembleBackends — default path assembles the write adapter (wiring smoke)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  // The call-site swap (`createStubAdapterTransport()` → `selectAdapterTransport(...)`)
  // leaves default assembly intact: `assembleBackends({})` still yields the todoist write
  // adapter. (That the default SELECTS the stub is pinned deterministically by the
  // pure-helper tests above; this is a wiring smoke that the swap didn't break assembly.)
  it("assembleBackends({}) still assembles the todoist writeAdapter", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    expect(backends.writeAdapter.targetSystem).toBe("todoist");
  });
});
