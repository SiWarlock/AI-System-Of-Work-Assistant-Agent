// spec(§12) — shared fixtures for the worker-API §12 suites (Task 8.7).
//
// The leakage suite must drive the REAL 8.2 projectors + 8.5 stream with domain
// records that carry INJECTED sensitive fields — the exact classes safety rules
// name: Keychain references, provider prompts, AgentResult.logs, raw
// Employer-Work content, and secrets. The projectors copy ONLY the checked-in
// `UI_SAFE_ALLOWLIST` field names, so NONE of these may ever cross to a query
// response or a stream payload. These fixtures build valid base domain records
// and then TAINT them with those field classes so the suites can assert the
// boundary holds against an adversarial / over-broad upstream record.
//
// The injected values are recognisable SENTINELS so a leak is detectable by a
// deep scan of the projected object (substring search), independent of the field
// NAME the leak rode out under (a `...spread` bug would carry the value AND its
// key). Every sentinel is a distinct constant so a suite can attribute a leak.
import type { Approval, HealthItem, WorkflowRunRef } from "@sow/contracts";
import type { DashboardCardSourceInput } from "@sow/worker/api/stream/pushStream";

// ── Recognisable leak sentinels (the 5 forbidden content classes) ────────────
// Each is a distinct high-signal marker. A leak surfaces as the marker appearing
// anywhere in the JSON of a projected object / stream payload.

/** A macOS Keychain reference (safety rule 7 — secrets resolve via SecretsPort only). */
export const SENTINEL_KEYCHAIN_REF = "kc-ref://keychain/session-token-LEAK";
/** A raw provider prompt (must never reach the renderer — §10 / WS-8). */
export const SENTINEL_PROVIDER_PROMPT = "SYSTEM PROMPT: you are a helpful assistant LEAK";
/** An AgentResult.logs line (provider stderr / tool trace — never UI-safe). */
export const SENTINEL_AGENT_LOG = "agent.log line: token=hunter2 LEAK";
/** Raw Employer-Work content (safety rule 4/5 — never crosses to a Personal/UI surface). */
export const SENTINEL_EMPLOYER_RAW = "RAW EMPLOYER CONTENT: Q3 acquisition memo LEAK";
/** A bare secret value (safety rule 7 — never written to the renderer). */
export const SENTINEL_SECRET = "sk-live-DEADBEEF-super-secret-LEAK";

/** All five sentinels — a suite scans a projected object for ANY of them. */
export const ALL_SENTINELS: readonly string[] = [
  SENTINEL_KEYCHAIN_REF,
  SENTINEL_PROVIDER_PROMPT,
  SENTINEL_AGENT_LOG,
  SENTINEL_EMPLOYER_RAW,
  SENTINEL_SECRET,
];

// ── Base (valid) domain records ──────────────────────────────────────────────

/** A valid pending Approval (all frozen fields present). `actor`/`payloadHash` DROP. */
export function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1" as Approval["id"],
    actionRef: "act_1" as Approval["actionRef"],
    subjectKind: "external_action", // §13.10a — external-write card (actionRef only)
    workspaceId: "ws-001" as Approval["workspaceId"],
    status: "pending",
    actor: "user:alice", // DROPPED — approving-principal identity
    channel: "mac",
    payloadHash: "sha256:deadbeef", // DROPPED — content-derived hash
    expiresAt: "2026-07-02T12:00:00.000Z",
    ...overrides,
  };
}

/** A valid HealthItem. `message`/`auditRef`/refs DROP (message may echo raw/secret). */
export function baseHealthItem(overrides: Partial<HealthItem> = {}): HealthItem {
  return {
    id: "hi_1",
    failureClass: "connector_unreachable",
    severity: "warn",
    message: "raw provider stderr: secret-token=hunter2", // DROPPED — may echo content/secret
    auditRef: "aud_1" as HealthItem["auditRef"],
    openedAt: "2026-07-02T10:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

/** A valid WorkflowRunRef. `auditRefs` DROPS (internal audit trail). */
export function baseWorkflowRunRef(overrides: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    workflowId: "wf_1" as WorkflowRunRef["workflowId"],
    trigger: "manual",
    state: "running",
    idempotencyKey: "idem_1",
    auditRefs: ["aud_1" as WorkflowRunRef["auditRefs"][number]], // DROPPED — internal audit trail
    ...overrides,
  };
}

/** A valid dashboard-card source (the read-model projector input). */
export function baseDashboardCard(
  overrides: Partial<DashboardCardSourceInput> = {},
): DashboardCardSourceInput {
  return {
    cardId: "card_1",
    kind: "approvals",
    title: "Pending approvals",
    status: "warn",
    count: 3,
    updatedAt: "2026-07-02T11:00:00.000Z",
    ...overrides,
  };
}

// ── Tainted records — every base + the 5 injected sensitive field classes ────
// The taint is applied via `as unknown as T` because these EXTRA keys are absent
// from the frozen contract type — that is the whole point: an adversarial /
// over-broad upstream record can carry them, and the projector must NOT copy
// them. The base's own dropped fields (`actor`, `payloadHash`, `message`,
// `auditRef(s)`) are ALSO present so a suite can assert those never cross either.

/** The bag of injected sensitive fields shared by every tainted record. */
const TAINT = {
  keychainRef: SENTINEL_KEYCHAIN_REF,
  providerPrompt: SENTINEL_PROVIDER_PROMPT,
  logs: [SENTINEL_AGENT_LOG],
  employerRaw: SENTINEL_EMPLOYER_RAW,
  secret: SENTINEL_SECRET,
} as const;

/** A tainted Approval — carries all 5 sentinels plus its dropped fields. */
export function taintedApproval(overrides: Partial<Approval> = {}): Approval {
  return { ...baseApproval(overrides), ...TAINT } as unknown as Approval;
}

/** A tainted HealthItem — carries all 5 sentinels plus its dropped fields. */
export function taintedHealthItem(overrides: Partial<HealthItem> = {}): HealthItem {
  return { ...baseHealthItem(overrides), ...TAINT } as unknown as HealthItem;
}

/** A tainted WorkflowRunRef — carries all 5 sentinels plus its dropped fields. */
export function taintedWorkflowRunRef(overrides: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return { ...baseWorkflowRunRef(overrides), ...TAINT } as unknown as WorkflowRunRef;
}

/** A tainted dashboard-card source — carries all 5 sentinels. */
export function taintedDashboardCard(
  overrides: Partial<DashboardCardSourceInput> = {},
): DashboardCardSourceInput {
  return { ...baseDashboardCard(overrides), ...TAINT } as unknown as DashboardCardSourceInput;
}

/**
 * Deep-scan a projected object for ANY leaked sentinel. Returns the FIRST
 * sentinel found (for a redaction-safe case detail: the sentinel is a synthetic
 * marker, not a real secret) or `undefined` when clean. Scans the JSON form so a
 * leak riding out under ANY key/nesting is caught (a `...spread` bug carries both
 * the value and its key).
 */
export function findLeakedSentinel(projected: unknown): string | undefined {
  const json = JSON.stringify(projected);
  return ALL_SENTINELS.find((s) => json.includes(s));
}

/**
 * The dropped-but-non-sentinel field NAMES a projection must never carry, per
 * record kind. These are real domain fields (not synthetic sentinels) that are
 * OFF the allowlist — a suite asserts each is absent from the projected object.
 */
export const DROPPED_FIELD_NAMES = {
  approval: ["actor", "payloadHash"],
  healthItem: ["message", "auditRef", "parityReportRef", "factIdentity"],
  workflowRunRef: ["auditRefs"],
  dashboardCard: [] as string[],
} as const;
