// Task 21.1 + 21.2 — the per-`TargetSystem` write-adapter ROUTING REGISTRY (pure
// logic; the worker binds it at the composition root). This suite pins:
//
//   • 21.2 — `buildWriteAdapterRegistry(deps)` constructs an EXHAUSTIVE
//     `Record<TargetSystem, TargetWriteAdapter>` by calling all SEVEN built-but-
//     uncalled vendor factories over the INJECTED transport (this IS "wire the 7
//     factories") — each target's adapter is the one tagged with that target.
//   • 21.1 — `selectWriteAdapter(registry, targetSystem)` routes by target and
//     FAILS CLOSED (typed `unregistered_target`) on any unknown/unregistered value.
//     The lookup is PROTOTYPE-SAFE (`Object.hasOwn`): `"__proto__"`/`"constructor"`/
//     `"prototype"` must NOT fail OPEN to a truthy prototype member (providers L13).
//   • Dormancy (§ARM-21) — the module constructs NOTHING real: it only uses the
//     injected transport, so the shipped default (stub transport) reaches only the
//     stub, never a real vendor. No real-transport path is reachable from here.
//   • The `createUnroutedWriteAdapter()` sentinel fails closed on every op (the
//     defense-in-depth placeholder the worker puts on the deps bundle; a routed
//     dispatch overrides it, an UNrouted one writes nothing).
//   • `dispatchRouted(...)` selects the vendor adapter by `action.targetSystem`,
//     overrides `deps.adapter` with the registry pick, and FAILS CLOSED (rejected)
//     WITHOUT dispatching on an unregistered target.
import { describe, it, expect, vi } from "vitest";
import { TargetSystem } from "@sow/contracts";
import type { Result, ProposedAction, ExternalWriteEnvelope } from "@sow/contracts";
import type { TargetWriteAdapter, AdapterError } from "../src/tools/adapter-port";
import type { AdapterDeps } from "../src/tools/adapters/adapter-core";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportResponse,
} from "../src/tools/adapters/transport";
import type { ExternalWriteDeps, ExternalWriteResult } from "../src/tools/gateway";
import {
  buildWriteAdapterRegistry,
  selectWriteAdapter,
  createUnroutedWriteAdapter,
  dispatchRouted,
  type WriteAdapterRegistry,
  type WriteAdapterRoutingError,
} from "../src/tools/write-adapter-registry";
import { InMemoryReceiptStore, makeProposedAction, makeEnvelope } from "./support/fakes";

const CLOCK = "2026-07-01T00:00:00.000Z";
const clock = (): string => CLOCK;

// A deterministic in-memory stub transport mirroring the worker's
// `createStubAdapterTransport`: a create yields `stub-obj:<targetSystem>:<key>`
// (idempotent within the process) — the id NAMESPACE carries the request's
// targetSystem, which is how we PROVE per-target routing (the asana adapter tags
// its request "asana", so its receipt id says "asana"), and how we prove the
// STUB (never a real vendor) answered.
function makeStubTransport(): {
  transport: AdapterTransport;
  calls: AdapterTransportRequest[];
} {
  const objects = new Map<string, { externalObjectId: string }>();
  const calls: AdapterTransportRequest[] = [];
  const transport: AdapterTransport = (req: AdapterTransportRequest): Promise<TransportResponse> => {
    calls.push(req);
    const key = req.canonicalObjectKey;
    if (req.op === "query") {
      const hit = objects.get(key);
      return Promise.resolve(
        hit === undefined
          ? { ok: true, object: null }
          : { ok: true, object: { externalObjectId: hit.externalObjectId } },
      );
    }
    if (req.op === "create") {
      const existing = objects.get(key);
      if (existing !== undefined) {
        return Promise.resolve({
          ok: true,
          object: { externalObjectId: existing.externalObjectId },
          deduped: true,
        });
      }
      const externalObjectId = `stub-obj:${req.targetSystem}:${key}`;
      objects.set(key, { externalObjectId });
      return Promise.resolve({ ok: true, object: { externalObjectId } });
    }
    const externalObjectId =
      objects.get(key)?.externalObjectId ?? `stub-obj:${req.targetSystem}:${key}`;
    objects.set(key, { externalObjectId });
    return Promise.resolve({ ok: true, object: { externalObjectId } });
  };
  return { transport, calls };
}

const stubDeps = (transport: AdapterTransport): AdapterDeps => ({ transport, clock });

// A full ExternalWriteDeps whose non-adapter fields are inert — dispatchRouted only
// reads `action.targetSystem` and SPREADS deps (overriding `adapter`), so the store
// / approval fns are never exercised when a spy dispatch is injected.
function makeRoutingDeps(adapter: TargetWriteAdapter): ExternalWriteDeps {
  return {
    adapter,
    receiptStore: new InMemoryReceiptStore(),
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ({ ok: true, value: undefined }) as Result<unknown, unknown>,
    isApproved: async () => false,
    audit: async () => {},
    clock,
  };
}

describe("buildWriteAdapterRegistry — 21.2 wire the seven vendor factories", () => {
  it("builds an EXHAUSTIVE registry keyed by every TargetSystem, each adapter tagged with its target", () => {
    const { transport } = makeStubTransport();
    const registry = buildWriteAdapterRegistry(stubDeps(transport));
    // Exhaustive: exactly the seven enum members, no more, no less.
    expect(Object.keys(registry).sort()).toEqual([...TargetSystem].sort());
    for (const target of TargetSystem) {
      expect(registry[target].targetSystem).toBe(target);
    }
  });

  it("each of the seven adapters is wired over the INJECTED transport (create → that target's stub receipt)", async () => {
    const { transport } = makeStubTransport();
    const registry = buildWriteAdapterRegistry(stubDeps(transport));
    for (const target of TargetSystem) {
      const env = makeEnvelope({ targetSystem: target, canonicalObjectKey: `cok:${target}` });
      const res = await registry[target].create(env, { title: "x" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // The receipt id carries THIS target — proves the target's own adapter (not a
        // single shared todoist adapter) handled the write over the injected stub.
        expect(res.value.externalObjectId).toBe(`stub-obj:${target}:cok:${target}`);
      }
    }
  });
});

describe("selectWriteAdapter — 21.1 route by target, fail closed on unknown", () => {
  const registry: WriteAdapterRegistry = buildWriteAdapterRegistry(
    stubDeps(makeStubTransport().transport),
  );

  it("routes each of the seven targets to its OWN vendor adapter", () => {
    for (const target of TargetSystem) {
      const res = selectWriteAdapter(registry, target);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(registry[target]);
        expect(res.value.targetSystem).toBe(target);
      }
    }
  });

  it("an unknown / unregistered target fails closed with a typed `unregistered_target`", () => {
    const res = selectWriteAdapter(registry, "notavendor" as unknown as (typeof TargetSystem)[number]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Code-only (rule 7): the fault must NOT echo the untrusted target value.
      expect(res.error).toEqual({ code: "unregistered_target" } satisfies WriteAdapterRoutingError);
    }
  });

  // Providers L13: a bare `registry[key]` lookup returns a truthy PROTOTYPE member for
  // these keys — a fail-OPEN routing to `Object.prototype.toString`/etc. `Object.hasOwn`
  // closes it. A tampered `action.targetSystem` of "__proto__"/"constructor" must FAIL CLOSED.
  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"])(
    "prototype-pollution key (%s) fails closed — never a fail-open truthy hit",
    (evil) => {
      const res = selectWriteAdapter(registry, evil as unknown as (typeof TargetSystem)[number]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unregistered_target");
    },
  );

  it("all seven registered adapter shapes are well-formed stub WriteReceipts through the registry", async () => {
    for (const target of TargetSystem) {
      const selected = selectWriteAdapter(registry, target);
      expect(selected.ok).toBe(true);
      if (!selected.ok) continue;
      const env = makeEnvelope({ targetSystem: target, canonicalObjectKey: `shape:${target}` });
      // null → create → dedupe: the full stub round-trip shape.
      const miss = await selected.value.existenceCheck(env.canonicalObjectKey, env);
      expect(miss.ok && miss.value === null).toBe(true);
      const created = await selected.value.create(env, { title: "x" });
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.value.externalObjectId).toBe(`stub-obj:${target}:shape:${target}`);
        expect(created.value.recordedAt).toBe(CLOCK);
      }
      const again = await selected.value.create(env, { title: "x" });
      expect(again.ok && again.value.externalObjectId === `stub-obj:${target}:shape:${target}`).toBe(true);
    }
  });
});

describe("dormancy (§ARM-21) — no real transport is reachable from the registry", () => {
  it("every registered target resolves over the INJECTED stub — ids are stub-namespaced, never real", async () => {
    const { transport, calls } = makeStubTransport();
    const registry = buildWriteAdapterRegistry(stubDeps(transport));
    // Building the registry touches the transport ZERO times (it only calls the pure
    // vendor factories) — the module constructs nothing real.
    expect(calls).toHaveLength(0);
    for (const target of TargetSystem) {
      const env = makeEnvelope({ targetSystem: target, canonicalObjectKey: `d:${target}` });
      const res = await registry[target].create(env, {});
      expect(res.ok).toBe(true);
      // The id is stub-namespaced (the injected stub answered). The LOAD-BEARING
      // dormancy proof is the call-count assertions below (build touches the transport
      // zero times; every write goes through the single injected seam) — the module
      // constructs no transport of its own.
      if (res.ok) expect(res.value.externalObjectId.startsWith("stub-obj:")).toBe(true);
    }
    // Every write went through the ONE injected transport (the sole seam).
    expect(calls.length).toBe(TargetSystem.length);
  });
});

describe("createUnroutedWriteAdapter — fail-closed sentinel", () => {
  it("every op fails closed with a typed `rejected` (never a silent write)", async () => {
    const sentinel = createUnroutedWriteAdapter();
    const env = makeEnvelope({ targetSystem: "todoist" });
    const existence = await sentinel.existenceCheck(env.canonicalObjectKey, env);
    const create = await sentinel.create(env, { title: "x" });
    const update = await sentinel.update(env, { title: "x" });
    for (const res of [existence, create, update]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect((res.error as AdapterError).code).toBe("rejected");
    }
  });
});

describe("dispatchRouted — select by action.targetSystem, override deps.adapter, fail closed on unknown", () => {
  const registry: WriteAdapterRegistry = buildWriteAdapterRegistry(
    stubDeps(makeStubTransport().transport),
  );

  it("selects the vendor adapter by action.targetSystem and dispatches WITH it (overriding the deps adapter)", async () => {
    let capturedTarget: string | undefined;
    let capturedDeps: ExternalWriteDeps | undefined;
    const spyDispatch = vi.fn(
      (
        _env: ExternalWriteEnvelope,
        _action: ProposedAction,
        deps: ExternalWriteDeps,
      ): Promise<ExternalWriteResult> => {
        capturedTarget = deps.adapter.targetSystem;
        capturedDeps = deps;
        return Promise.resolve({ status: "created", receipt: { externalObjectId: "x", recordedAt: CLOCK } });
      },
    );
    // deps carries the fail-closed SENTINEL — dispatchRouted MUST override it with the pick.
    const deps = makeRoutingDeps(createUnroutedWriteAdapter());
    const action = makeProposedAction({ targetSystem: "asana" });
    const env = makeEnvelope({ targetSystem: "asana" });

    const out = await dispatchRouted(registry, env, action, deps, spyDispatch);

    expect(spyDispatch).toHaveBeenCalledTimes(1);
    expect(capturedTarget).toBe("asana"); // registry pick, NOT the sentinel
    // The spread overrides ONLY `adapter` — every other dep passes through by reference.
    expect(capturedDeps?.receiptStore).toBe(deps.receiptStore);
    expect(capturedDeps?.clock).toBe(deps.clock);
    expect(capturedDeps?.requireApproval).toBe(deps.requireApproval);
    expect(out).toEqual({ status: "created", receipt: { externalObjectId: "x", recordedAt: CLOCK } });
  });

  it("an env/action targetSystem MISMATCH fails closed WITHOUT dispatching (defense-in-depth)", async () => {
    const spyDispatch = vi.fn((): Promise<ExternalWriteResult> => {
      throw new Error("dispatch must NOT be called on an env/action targetSystem mismatch");
    });
    const deps = makeRoutingDeps(createUnroutedWriteAdapter());
    const action = makeProposedAction({ targetSystem: "asana" });
    const env = makeEnvelope({ targetSystem: "github" }); // diverges from the action

    const out = await dispatchRouted(registry, env, action, deps, spyDispatch);

    expect(spyDispatch).not.toHaveBeenCalled();
    expect(out.status).toBe("rejected");
  });

  it("an unregistered target fails closed (rejected) WITHOUT dispatching", async () => {
    const spyDispatch = vi.fn((): Promise<ExternalWriteResult> => {
      throw new Error("dispatch must NOT be called on an unregistered target");
    });
    const deps = makeRoutingDeps(createUnroutedWriteAdapter());
    const action = makeProposedAction({ targetSystem: "notavendor" as unknown as ProposedAction["targetSystem"] });
    const env = makeEnvelope();

    const out = await dispatchRouted(registry, env, action, deps, spyDispatch);

    expect(spyDispatch).not.toHaveBeenCalled();
    expect(out.status).toBe("rejected");
  });
});

// ── C3 — dispatchRouted must FORWARD DispatchOptions to the gateway ───────────
//
// The routed path is what the worker's approved-dispatch and outbox drain actually
// call, so if `opts` stops here the ordering guard is silently dead everywhere it
// matters most — the approval path included. A dropped forward is invisible: every
// other test still passes, because nothing else observes it. Hence this pin.
describe("dispatchRouted — forwards DispatchOptions (C3 ordering)", () => {
  const { transport } = makeStubTransport();
  const registry = buildWriteAdapterRegistry(stubDeps(transport));

  function spyDispatch() {
    const seen: (unknown | undefined)[] = [];
    const fn = (async (_env, _action, _deps, opts) => {
      seen.push(opts);
      return { status: "reused", receipt: { externalObjectId: "x", recordedAt: clock() } };
    }) as typeof dispatchRouted extends never ? never : Parameters<typeof dispatchRouted>[4];
    return { fn, seen };
  }

  it("passes `intentCreatedAt` straight through to the injected dispatch", async () => {
    const action = makeProposedAction({ targetSystem: "drive" });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: action.canonicalObjectKey });
    const spy = spyDispatch();
    await dispatchRouted(registry, env, action, makeRoutingDeps(registry.drive), spy.fn, {
      intentCreatedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(spy.seen).toEqual([{ intentCreatedAt: "2026-06-30T00:00:00.000Z" }]);
  });

  it("passes `undefined` when no options are given — a fresh dispatch is never ordered", async () => {
    const action = makeProposedAction({ targetSystem: "drive" });
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: action.canonicalObjectKey });
    const spy = spyDispatch();
    await dispatchRouted(registry, env, action, makeRoutingDeps(registry.drive), spy.fn);
    expect(spy.seen).toEqual([undefined]);
  });
});
