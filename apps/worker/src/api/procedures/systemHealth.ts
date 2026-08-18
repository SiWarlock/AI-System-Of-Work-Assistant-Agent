// Task 8.3 — System Health query surface (OBS-2 typed HealthItems as
// UiSafeHealthItem, audit-linked ref-only; REQ-S-002 Employer-Work egress status).
//
// READ-ONLY tRPC query procedures (no side effects — §13). The System Health query
// surfaces the OBS-2 typed HealthItems (open / acknowledged / resolved) as
// UiSafeHealthItem — audit-linked but REF-ONLY, never raw: the 8.2 projector
// DROPS `message` (may echo raw content / a secret), `auditRef`, `parityReportRef`,
// and `factIdentity` (internal refs). The Employer-Work egress-acknowledgment
// status (REQ-S-002) is surfaced via this System-Health / workspace-settings query
// so the UI can show whether raw Employer-Work egress is OFF (fail-closed default).
//
// Every procedure runs behind the 8.1 auth gate (8.2 `authedResolver`), returns a
// `Result<T, FailureVariant>` (never throws across the boundary — §16), and an
// unknown / out-of-scope workspace returns the port's typed not-found err — never
// a partial raw leak.
//
// The data is injected through {@link SystemHealthQueryPort}; the fake is the
// unit-test seam, the real @sow/db binding is the integrator step.
//
// Input validation uses tRPC's PLAIN-FUNCTION validator (no zod dependency in the
// worker): a malformed transport payload is a bad request handled redaction-safely
// by the 8.2 `errorFormatter` net; a well-formed-but-UNKNOWN workspace is the
// port's typed `err(FailureVariant)` returned as DATA (never a throw — §16).
import {
  ok,
  REDACTED_FIELD,
  type Result,
  type FailureVariant,
  type HealthItem,
  type UiSafeHealthItem,
} from "@sow/contracts";
import { redactString } from "@sow/domain";
import { router, publicProcedure, authedResolver } from "../router";
import { toUiSafeHealthItem } from "../projections/uiSafe";

// ── UI-safe egress status (REQ-S-002) ─────────────────────────────────────────

/**
 * The UI-safe Employer-Work egress-status read-model (REQ-S-002). Purpose-built
 * UI shape:
 *   - `workspaceId`                    : which workspace this status is for;
 *   - `employerRawEgressAcknowledged`  : is raw Employer-Work egress ACK'd ON?
 *                                        (OFF ⇒ raw content is local-only / veto);
 *   - `zeroEgressOnly`                 : is this workspace pinned to a local
 *                                        zero-egress provider (fail-closed)?
 * There is no frozen seam model for this projection (like `DashboardCardSource`,
 * it is a §10 read-model construct), so it is defined here as a standalone shape.
 *
 * ⛔ UI-SAFETY IS **NOT** A PROPERTY OF THIS TYPE — IT IS A PROPERTY OF THE
 * PROJECTION FUNCTION THAT BUILDS IT (`### 24.102`, safety rule 7). Stated on the
 * type deliberately, because the type is what a reader has in hand:
 *   - `employerRawEgressAcknowledged` / `zeroEgressOnly` are booleans, so a
 *     CONTRACT-CONFORMING port cannot put content in them. ⚠ The type is ERASED at
 *     runtime, so that is an assumption about the binding, not an enforced gate.
 *   - `workspaceId` is a PASS-THROUGH STRING carrying whatever the port supplies.
 *     It is NOT safe by construction and needs a gate at every sink that serves it.
 * ⛔ THIS FILE'S `toUiSafeEgressStatus` GATES IT. `egressCommands.ts` HAS ITS OWN
 * IDENTICALLY-NAMED `toUiSafeEgressStatus` THAT DOES **NOT** — same type, same
 * renderer, verbatim pass-through. ⚠ Do not read the gate below as covering this
 * type everywhere it is produced; it covers ONE producer.
 * ⛔ AND DO NOT "FIX" THE SIBLING BY COPYING THIS GATE INTO IT: its value is served
 * by the REVOKE path, where `foldStatus` folds a diverged id into a FAILURE message
 * ("the posture on screen is UNCHANGED") — so a revoke that actually LANDED would
 * report failure, on the fail-safe OFF control for employer raw egress. That is a
 * safety-rule-5 regression wearing the shape of a tidy-up. Raised at Step 9.
 */
export interface UiSafeEgressStatus {
  workspaceId: string;
  employerRawEgressAcknowledged: boolean;
  zeroEgressOnly: boolean;
}

// ── Port ──────────────────────────────────────────────────────────────────────

/**
 * The System-Health read-model source. READ-ONLY; each method returns a typed
 * `Result`. `healthItems` hands back FROZEN {@link HealthItem} records — the
 * procedure does the UI-safe projection, so the redaction boundary lives in ONE
 * place (the 8.2 projector). `egressStatus` returns the UI-safe egress shape; the
 * procedure RE-PROJECTS it to the allowlisted fields (defense-in-depth — an
 * over-broad port result cannot leak an extra field). An unknown workspace is the
 * port's typed not-found err (fail-closed, no partial raw leak), NOT a throw.
 *
 * The integrator binds this to the @sow/db read-models + the egress-policy read;
 * unit tests inject a fake.
 */
export interface SystemHealthQueryPort {
  /** OBS-2 typed HealthItems across the lifecycle (open / acknowledged / resolved). */
  readonly healthItems: () => MaybeAsyncResult<readonly HealthItem[]>;
  /** Employer-Work egress-acknowledgment status; unknown workspace → typed err. */
  readonly egressStatus: (
    workspaceId: string,
  ) => MaybeAsyncResult<UiSafeEgressStatus>;
}

/**
 * A port result delivered synchronously (the in-memory unit-test fake) or async (the
 * real @sow/db / health-surface binding at boot). Each resolver `await`s it before
 * projecting and `authedResolver` already awaits an async handler — so the same
 * router serves both. Mirrors the async-tolerant widening on `ReadModelQueryPort`.
 */
type MaybeAsyncResult<T> = Result<T, FailureVariant> | Promise<Result<T, FailureVariant>>;

/** Dependencies for {@link buildSystemHealthRouter}. */
export interface SystemHealthRouterDeps {
  readonly systemHealth: SystemHealthQueryPort;
}

// ── Input shape + plain-function validator (§3 universal boundary rule) ───────

/** A workspace-scoped query input. */
export interface WorkspaceInput {
  readonly workspaceId: string;
}

/** tRPC plain-function validator narrowing an unknown payload → WorkspaceInput. */
function parseWorkspaceInput(value: unknown): WorkspaceInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  const workspaceId = source["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    // Transport-level malformed payload — mapped redaction-safely by the 8.2
    // errorFormatter net. "Unknown workspace" is NOT this path (that is the
    // port's typed Result err).
    throw new Error("invalid_input");
  }
  return { workspaceId };
}

// ── Internal helper (pure) ────────────────────────────────────────────────────

/** Map a port's HealthItem `Result` through the UI-safe health-item projector. */
function projectHealthItems(
  r: Result<readonly HealthItem[], FailureVariant>,
): Result<readonly UiSafeHealthItem[], FailureVariant> {
  return r.ok ? ok(r.value.map(toUiSafeHealthItem)) : r;
}

/**
 * Reconstruct a UI-safe egress status from ONLY the three allowlisted fields.
 *
 * ⛔ THIS ALLOWLISTS **FIELDS**, NOT **VALUES** — the two are different guarantees
 * and conflating them is what `### 24.102` was filed about. The reconstruction
 * means a port (or a future @sow/db binding) returning an OVER-BROAD object
 * cannot ride an EXTRA FIELD out to the renderer (defense-in-depth). It says
 * nothing, on its own, about what is INSIDE an allowlisted field.
 *
 * So the VALUE is handled separately: `workspaceId` is passed through the
 * canonical §16 redactor (`@sow/domain`), which SUBSTITUTES rather than refuses.
 * ⛔ IT HAS **THREE** OUTCOMES, NOT TWO — the third is the most likely real shape:
 *   1. no credential shape          ⇒ returned VERBATIM (the whole live population);
 *   2. the value IS a credential    ⇒ whole value becomes `REDACTED_CREDENTIAL`;
 *   3. a credential EMBEDDED in a longer id (`ws-sk-ant-…`, the plausible legacy
 *      shape) ⇒ PARTIAL substitution — `ws-` survives, the token is replaced. The
 *      result is neither frozen marker. Secret material is still removed.
 *   …and a value that still trips the net after scrubbing is dropped WHOLE to
 *   `REDACTED_FIELD` (the fail-safe).
 *
 * ⛔⛔ THE COST THIS IMPOSES, STATED BECAUSE IT WAS NOT IN THE PHRASE THE OWNER
 * PRICED: the fail-safe fires on a SENSITIVE KEYWORD, not only on a credential, so
 * a BENIGN id that merely contains one is dropped whole. MEASURED, not theorised —
 * `client-secret-audit`, `bearer-bonds`, `passphrase-team`, `my-api-key-ws` and
 * `acme-credential-review` all become `REDACTED_FIELD` while holding no secret.
 * ⇒ such a workspace's egress posture STOPS RENDERING (see the divergence note
 * below). ⚠ No live id is affected — the three real ids and the known legacy
 * shapes are byte-identical through this call — but that is a statement about a
 * MEASURED SAMPLE, not about the id space, which `onboarding.ts` leaves open.
 *
 * ⛔ WHY REDACTION AND NOT A SHAPE / BRAND CHECK — DO NOT "UPGRADE" THIS: a shape
 * check at a SERVE boundary converts a legacy non-conforming id from RENDERABLE
 * to UNRENDERABLE, which is the availability cost the owner priced and REJECTED
 * (`### 24.84`). Redaction keeps the response served for every id that does not
 * trip the redactor — which is every live id and every known legacy shape, pinned.
 *
 * ⚠ CONSEQUENCE WORTH KNOWING BEFORE YOU EDIT (rule-5-adjacent, `### 24.108`):
 * when the value IS credential-shaped, the served id necessarily DIFFERS from the
 * one the caller requested, and a client that compares them will fail closed —
 * so that workspace's egress posture does not render. That is the intended
 * direction (showing nothing beats rendering a credential), not an oversight.
 *
 * Pure + TOTAL: no throw for any input, including an off-contract one.
 */
function toUiSafeEgressStatus(status: UiSafeEgressStatus): UiSafeEgressStatus {
  return {
    // `redactString` is total over `string` — but this type is ERASED at runtime
    // and this function's whole premise is that an off-contract port can supply
    // anything, so an unguarded call would THROW on a non-string and turn a
    // SERVED response into `degraded_unavailable`. Fail safe, not loud.
    workspaceId:
      typeof status.workspaceId === "string"
        ? redactString(status.workspaceId)
        : REDACTED_FIELD,
    employerRawEgressAcknowledged: status.employerRawEgressAcknowledged,
    zeroEgressOnly: status.zeroEgressOnly,
  };
}

/** Map a port's egress-status `Result` through the UI-safe egress reconstruction. */
function projectEgressStatus(
  r: Result<UiSafeEgressStatus, FailureVariant>,
): Result<UiSafeEgressStatus, FailureVariant> {
  return r.ok ? ok(toUiSafeEgressStatus(r.value)) : r;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Build the read-only System-Health router the integrator mounts under the
 * appRouter (e.g. `appRouter.systemHealth`). Both procedures are tRPC `.query()`
 * (read-only, §13), wrapped in the 8.2 `authedResolver` (auth gate + §16 typed
 * boundary), and return UI-safe projections wrapped in `Result`.
 */
export function buildSystemHealthRouter(deps: SystemHealthRouterDeps) {
  const { systemHealth } = deps;
  return router({
    /** OBS-2 typed HealthItems projected to UI-safe (audit-linked ref-only). */
    items: publicProcedure.query(
      authedResolver<undefined, readonly UiSafeHealthItem[]>(
        async (): Promise<Result<readonly UiSafeHealthItem[], FailureVariant>> =>
          projectHealthItems(await systemHealth.healthItems()),
      ),
    ),

    /** Employer-Work egress-acknowledgment status (REQ-S-002); unknown ws → err.
     *  Re-projected to the allowlisted egress FIELDS, and the `workspaceId` VALUE
     *  is redaction-gated at the sink — see `toUiSafeEgressStatus` for the bound. */
    egressStatus: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, UiSafeEgressStatus>(
        async (_ctx, input): Promise<Result<UiSafeEgressStatus, FailureVariant>> =>
          projectEgressStatus(await systemHealth.egressStatus(input.workspaceId)),
      ),
    ),
  });
}

/** The mounted-router type (for the integrator's `AppRouter` composition). */
export type SystemHealthRouter = ReturnType<typeof buildSystemHealthRouter>;
