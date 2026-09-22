// @sow/worker — the real HTTP client and the owner switch for Linear writes. Linear slice 2 of 6.
//
// Real network I/O lives HERE, at the composition root, not in @sow/integrations (whose adapters take
// injected deps and make no real calls, §16). This module supplies the two things the integrations
// sender needs to become real: a fetch-backed `HttpTransport`, and a `WriteTransportGate` whose factory
// routes Linear writes to `LINEAR_WRITE_SPEC` and refuses every other service.
//
// ⛔ OFF UNLESS THE OWNER TURNS IT ON (`SOW_LINEAR_WRITES`, read in Electron main and forwarded as plain
// data). With the switch on, NO gate is built unless a workspace's Linear key actually RESOLVES from the
// Keychain: a switch that cannot authenticate must not look armed. ⛔ CORRECTED 2026-09-21 (review,
// upheld 3/3): the first cut only checked that a credential ACCESSOR existed, and the host always
// builds one, so the switch reported ARMED with no key at all — the construction-vs-resolution defect
// `resolveProvenanceArming` exists to prevent. `selectAdapterTransport` still requires `enabled === true`
// plus a factory, and constructs nothing until the gate is used.
//
// ⚠ ARMING THIS ALONE CREATES NO LINEAR ISSUE. It satisfies `gateProposeArming` precondition (4)
// (`writeTransportArmed`), and since Linear slice 3+4 approving an external write in the Approvals screen
// really sends it (`externalApprovalDispatch.ts`). But nothing proposes a Linear issue yet (slice 5), so there
// is nothing to approve. Do not read "armed" as "writing".
import { writeSecretRef, type WriteSecretsAccessor } from "@sow/integrations";
import {
  createWriteHttpTransport,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "@sow/integrations/tools/adapters/write-http-transport";
import { LINEAR_WRITE_SPEC } from "@sow/integrations/tools/adapters/linear-write-spec";
import { createRoutedAdapterTransport } from "@sow/integrations/tools/adapters/routed-transport";
import type { WriteTransportGate } from "./backends";
import { WELL_KNOWN_COPILOT_WORKSPACES } from "../api/procedures/copilotClaudeSynthesis";

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

/**
 * The workspaces whose Linear key the switch looks for. The onboarding wizard sets each workspace id to
 * the scope for its type (`scopeForType`) and the demo seed uses the same three ids. A dev-provisioned
 * id outside them is never looked up, so it cannot arm the switch (fails closed). A key saved after
 * boot arms on the next start.
 */
export const LINEAR_ARMING_WORKSPACES: readonly string[] = WELL_KNOWN_COPILOT_WORKSPACES.map((w) => w.id);

export interface LinearWriteArmingDeps {
  /** The owner switch, already parsed strictly. Anything but `true` ⇒ not armed, no key read. */
  readonly enabled: boolean | undefined;
  /** The Keychain-backed credential source. Absent ⇒ not armed (fail closed). */
  readonly secrets: WriteSecretsAccessor | undefined;
  /** Where to look for a key. Production passes `LINEAR_ARMING_WORKSPACES`. */
  readonly workspaceIds: readonly string[];
  /** Injected for tests; production builds the fetch-backed client. */
  readonly http?: HttpTransport;
}

/** Why the switch did not arm. Each is a different owner remedy — never collapse them. */
export type LinearNotArmedReason = "switch_off" | "no_secrets_gate" | "no_credential_resolved";

export type LinearWriteArmingOutcome =
  | { readonly armed: true; readonly gate: WriteTransportGate; readonly workspaces: readonly string[] }
  | { readonly armed: false; readonly reason: LinearNotArmedReason };

/** Does this workspace's Linear key resolve to a non-blank value? The value is discarded (rule 7). */
async function linearKeyResolves(secrets: WriteSecretsAccessor, workspaceId: string): Promise<boolean> {
  try {
    const got = await secrets.getSecret(writeSecretRef("linear", workspaceId));
    return got.ok && got.value.trim().length > 0;
  } catch {
    return false; // a throwing accessor must degrade, not crash boot
  }
}

/**
 * Decide whether Linear writes are armed. TOTAL — never throws (it runs during host startup). Arms only
 * when at least one workspace's key RESOLVES; `workspaces` names those, so the operator can see which.
 * A workspace without a key is still refused at dispatch (`credential_missing`) — arming names no one.
 * The factory is LAZY: no sender is built until `selectAdapterTransport` calls it.
 */
export async function resolveLinearWriteArming(deps: LinearWriteArmingDeps): Promise<LinearWriteArmingOutcome> {
  if (deps.enabled !== true) return { armed: false, reason: "switch_off" };
  const secrets = deps.secrets;
  if (secrets === undefined) return { armed: false, reason: "no_secrets_gate" };
  const workspaces: string[] = [];
  for (const ws of deps.workspaceIds) {
    if (await linearKeyResolves(secrets, ws)) workspaces.push(ws);
  }
  if (workspaces.length === 0) return { armed: false, reason: "no_credential_resolved" };
  return {
    armed: true,
    workspaces,
    gate: {
      enabled: true,
      // The router below serves Linear only and refuses every other system, so say so: every other
      // system's approved writes then wait instead of being closed as rejected (Linear slice 3+4 review).
      targets: ["linear"],
      make: () =>
        createRoutedAdapterTransport({
          linear: createWriteHttpTransport(LINEAR_WRITE_SPEC, { http: deps.http ?? createFetchHttpTransport(), secrets }),
        }),
    },
  };
}

/** Operator-facing and redaction-safe: a closed reason, or workspace ids. Never a key, never a ref. */
export function describeLinearWriteArming(outcome: LinearWriteArmingOutcome): string {
  if (outcome.armed) {
    return `linear writes: SENDER ARMED for ${outcome.workspaces.join(", ")} (nothing proposes Linear issues yet)`;
  }
  const fix: Record<LinearNotArmedReason, string> = {
    switch_off: "SOW_LINEAR_WRITES is not on",
    no_secrets_gate: "no Keychain credential source",
    no_credential_resolved: "no workspace's Linear key resolved from the Keychain: missing, locked, or blank",
  };
  return `linear writes: NOT ARMED (${outcome.reason} — ${fix[outcome.reason]})`;
}
