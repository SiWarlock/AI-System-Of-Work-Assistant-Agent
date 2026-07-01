// spec(§7) — provider × capability × pinned-model conformance runner (task 5.10).
// Drives a ModelProviderPort adapter (ModelProviderPort raw extraction, REQ-I-001)
// through each conformance case and folds the produced candidate output into a
// ConformanceResult via the shared assessment core. The port itself is INJECTED —
// unit tests pass a MOCK port (no real API); real provider runs are the key-gated
// eval path (see runProviderConformanceIfKeyed). Never throws (§16): a typed
// provider Err or a budget cancel becomes a `failing` result, not an exception.
import type { ModelProviderPort, ProviderRequest } from "@sow/providers/ports/model-provider-port";
import { isErr } from "@sow/contracts";
import type { Capability, ContextRef, ProviderRoute, ConformanceResult } from "@sow/contracts";
import {
  assessCandidate,
  defaultConformanceGate,
  type ConformanceGate,
  type ConformanceSubject,
} from "./conformance-core";

/** One provider conformance case: the resolved route + pinned model, the capability
 * output schema (the gate target), and the reference input the adapter completes. */
export interface ProviderConformanceCase {
  readonly capability: Capability;
  readonly model: string;
  /** Resolved route (its `egressClass` classifies the subject local vs cloud). */
  readonly route: ProviderRoute;
  readonly outputSchemaId: string;
  readonly inputRefs: readonly ContextRef[];
  readonly idempotencyKey: string;
  readonly maxRuntimeSeconds: number;
}

/**
 * Run every case against `port`, producing one ConformanceResult per case.
 * `now` supplies the `checkedAt` timestamp (injected — deterministic in tests).
 * DETERMINISTIC given a deterministic port; the port is where the I/O lives.
 */
export async function runProviderConformance(
  port: ModelProviderPort,
  cases: readonly ProviderConformanceCase[],
  now: () => string,
  gate: ConformanceGate = defaultConformanceGate,
  signal?: AbortSignal,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of cases) {
    const subject: ConformanceSubject = {
      kind: "provider",
      subjectId: port.providerId,
      capability: c.capability,
      model: c.model,
      egressClass: c.route.egressClass,
      outputSchemaId: c.outputSchemaId,
    };
    const req: ProviderRequest = {
      route: c.route,
      model: c.model,
      capability: c.capability,
      inputRefs: c.inputRefs,
      outputSchemaId: c.outputSchemaId,
      budget: { maxRuntimeSeconds: c.maxRuntimeSeconds },
      idempotencyKey: c.idempotencyKey,
    };

    const res = await port.complete(req, signal);
    if (isErr(res)) {
      results.push(
        assessCandidate(subject, { ok: false, detail: `provider_error:${res.error.kind}` }, now(), gate),
      );
      continue;
    }
    const output = res.value;
    if (output.status === "cancelled") {
      // A cooperative cancel (e.g. budget breach) carries NO committable output —
      // it cannot be conformant (REQ-S-007 strict side-effect rule).
      results.push(assessCandidate(subject, { ok: false, detail: "cancelled" }, now(), gate));
      continue;
    }
    results.push(
      assessCandidate(subject, { ok: true, candidateOutput: output.candidateOutput }, now(), gate),
    );
  }
  return results;
}

/**
 * Key-gated wrapper for REAL provider runs (the eval path — like the SOW_PG_DOCKER
 * skip-by-default pattern). Returns `undefined` (skipped) unless `SOW_PROVIDER_CONFORMANCE`
 * is set, so the default `pnpm test` never hits a real API or requires a Keychain key.
 */
export async function runProviderConformanceIfKeyed(
  port: ModelProviderPort,
  cases: readonly ProviderConformanceCase[],
  now: () => string,
  gate: ConformanceGate = defaultConformanceGate,
  env: Record<string, string | undefined> = process.env,
): Promise<ConformanceResult[] | undefined> {
  if (!env["SOW_PROVIDER_CONFORMANCE"]) return undefined;
  return runProviderConformance(port, cases, now, gate);
}
