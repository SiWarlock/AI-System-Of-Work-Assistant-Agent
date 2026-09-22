// @sow/worker — the real HTTP client and the owner switch for Linear writes. Linear slice 2 of 6.
//
// Real network I/O lives HERE, at the composition root, not in @sow/integrations (whose adapters take
// injected deps and make no real calls, §16). This module supplies the two things the integrations
// sender needs to become real: a fetch-backed `HttpTransport`, and a `WriteTransportGate` whose factory
// routes Linear writes to `LINEAR_WRITE_SPEC` and refuses every other service.
//
// ⛔ OFF UNLESS THE OWNER TURNS IT ON (`SOW_LINEAR_WRITES`, read in Electron main and forwarded as plain
// data). With the switch on but no credential source, NO gate is built: a switch that cannot
// authenticate must not look armed. And `selectAdapterTransport` still requires `enabled === true` plus
// a factory, and constructs nothing until the gate is used.
//
// ⚠ ARMING THIS ALONE CREATES NO LINEAR ISSUE. It satisfies `gateProposeArming` precondition (4)
// (`writeTransportArmed`), but nothing proposes a Linear issue yet and approving an external write in the
// Approvals screen goes to a no-op dispatch (slices 3 and 5). Do not read "armed" as "writing".
import type { WriteSecretsAccessor } from "@sow/integrations";
import {
  createWriteHttpTransport,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "@sow/integrations/tools/adapters/write-http-transport";
import { LINEAR_WRITE_SPEC } from "@sow/integrations/tools/adapters/linear-write-spec";
import { createRoutedAdapterTransport } from "@sow/integrations/tools/adapters/routed-transport";
import type { WriteTransportGate } from "./backends";

/** A write that has not answered in this long is abandoned; the gateway then holds it for retry. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchHttpTransportOptions {
  readonly timeoutMs?: number;
  /** Injected for tests; production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A fetch-backed `HttpTransport`. `redirect: "manual"` is passed through, never followed: a
 * cross-origin 3xx would re-send the Authorization header verbatim. A timeout aborts the request and
 * REJECTS, which the write transport classifies as `unreachable` (held for retry) with the cause
 * discarded — never echoed (rule 7).
 */
export function createFetchHttpTransport(opts: FetchHttpTransportOptions = {}): HttpTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onOuterAbort);
      try {
        const res = await doFetch(req.url, {
          method: req.method,
          headers: { ...req.headers },
          ...(req.body !== undefined ? { body: req.body } : {}),
          redirect: req.redirect,
          signal: controller.signal,
        });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}

export interface LinearWriteGateDeps {
  /** The owner switch, already parsed strictly. Anything but `true` ⇒ no gate. */
  readonly enabled: boolean | undefined;
  /** The Keychain-backed credential source. Absent ⇒ no gate (fail closed). */
  readonly secrets: WriteSecretsAccessor | undefined;
  /** Injected for tests; production builds the fetch-backed client. */
  readonly http?: HttpTransport;
}

/**
 * The `WriteTransportGate` for Linear, or `undefined` when it must not arm. The factory is LAZY:
 * nothing is constructed, and no credential is touched, until `selectAdapterTransport` calls it.
 */
export function buildLinearWriteTransportGate(deps: LinearWriteGateDeps): WriteTransportGate | undefined {
  if (deps.enabled !== true) return undefined;
  const secrets = deps.secrets;
  if (secrets === undefined) return undefined;
  return {
    enabled: true,
    make: () =>
      createRoutedAdapterTransport({
        linear: createWriteHttpTransport(LINEAR_WRITE_SPEC, { http: deps.http ?? createFetchHttpTransport(), secrets }),
      }),
  };
}
