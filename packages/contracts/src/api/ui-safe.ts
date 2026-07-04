// UI-safe projection contracts (task 8.2, §10 UI-safe projections / WS-8 leakage
// gate). SECURITY-CRITICAL boundary surface: the renderer receives ONLY these
// narrow shapes over the §10 push stream — NEVER secrets, Keychain refs, raw
// Employer-Work content, provider prompts, or AgentResult.logs.
//
// DESIGN — STANDALONE interfaces, NOT `Pick<>` off the frozen models. A later
// field-add to Approval / HealthItem / WorkflowRunRef (all frozen seam models)
// must NOT silently widen the UI surface; a standalone interface + a checked-in
// UI_SAFE_ALLOWLIST are the source of truth. The Phase-8 worker projection
// functions (built later) map domain → UI-safe using ONLY the allowlisted names,
// and the contract test freezes each schema's field set against its allowlist so
// no field can be added without failing the freeze.
//
// PURE — imports only foundation primitives + shared enums (§2.5 import-direction
// root). No @trpc import here (the router itself is built in apps/worker later).
import { z } from "zod";
import {
  approvalStatusSchema,
  channelSchema,
  failureClassSchema,
  healthStateSchema,
  VisibilityLevelSchema,
} from "../models/shared-enums";
import type { ApprovalStatus, Channel, FailureClass, HealthState } from "../models/shared-enums";
import type { VisibilityLevel } from "../primitives/enums";

// A UI-safe display summary line: short + SINGLE-LINE. Multi-line / long-form is the
// shape of leaked raw content, so it is rejected at this seam too (defense in depth —
// the GCL gate already bounds sanitizedPayload values, this re-bounds the projected
// summary). 1024 mirrors the GCL gate's MAX_SUMMARY_VALUE_LEN.
const uiSafeSummaryLine = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !/[\r\n]/.test(s), { message: "summary must be single-line" });

// Compile-time exact-type equality (bidirectional assignability). Used to pin
// each schema's inferred output to its standalone interface without a
// `z.ZodType<T>` annotation (which would hide `.shape` from the freeze test).
// These UI-safe shapes carry no branded fields, so there is no TS4023 to dodge.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ── UiSafeApproval ───────────────────────────────────────────────────────────
// Approval-inbox card the renderer shows (§10/§11). ids + status + channel +
// timing only. DROPPED from the frozen Approval: `actor` (approving-principal
// identity) and `payloadHash` (a hash over the raw action payload — content-
// derived, kept off the UI surface).
export interface UiSafeApproval {
  id: string;
  actionRef: string;
  status: ApprovalStatus;
  channel: Channel;
  snoozeUntil?: string;
  expiresAt?: string;
}

// No `z.ZodType<T>` annotation: the schema infers as a `ZodObject`, which keeps
// `.shape` visible so the contract test can freeze the field set against
// UI_SAFE_ALLOWLIST. The `Exact<>` guard below pins the inferred output to the
// standalone `UiSafeApproval` interface (drift in either direction fails tsc).
export const UiSafeApprovalSchema = z
  .object({
    id: z.string().min(1),
    actionRef: z.string().min(1),
    status: approvalStatusSchema,
    channel: channelSchema,
    snoozeUntil: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

// ── UiSafeHealthItem ─────────────────────────────────────────────────────────
// System-Health card (OBS-1/OBS-2, §10/§11). failureClass + severity + lifecycle
// state + timing only. DROPPED from the frozen HealthItem: `message` (may echo
// raw content), `auditRef` / `parityReportRef` / `factIdentity` (internal refs
// that must not reach the renderer).
export interface UiSafeHealthItem {
  id: string;
  failureClass: FailureClass;
  severity: string;
  state: HealthState;
  openedAt: string;
  resolvedAt?: string;
}

export const UiSafeHealthItemSchema = z
  .object({
    id: z.string().min(1),
    failureClass: failureClassSchema,
    severity: z.string().min(1),
    state: healthStateSchema,
    openedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
  })
  .strict();

// ── UiSafeWorkflowRunRef ─────────────────────────────────────────────────────
// Workflow-run status card (§9/§10). workflowId + open §9 trigger/state strings
// + idempotencyKey only. DROPPED from the frozen WorkflowRunRef: `auditRefs`
// (the internal audit trail must not surface to the renderer).
export interface UiSafeWorkflowRunRef {
  workflowId: string;
  trigger: string;
  state: string;
  idempotencyKey: string;
}

export const UiSafeWorkflowRunRefSchema = z
  .object({
    workflowId: z.string().min(1),
    trigger: z.string().min(1),
    state: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

// ── UiSafeDashboardCard ──────────────────────────────────────────────────────
// A representative read-model dashboard card (§10/§11). Deliberately generic —
// short display strings + a count + a status token + a timestamp. There is no
// frozen `DashboardCard` seam model; this is a purpose-built UI read-model, so
// every field is chosen UI-safe from the start (no domain field to drop).
//   - `kind`   : which read-model this card summarizes (open string — the §10
//                read-model taxonomy is not a closed contract enum here).
//   - `status` : a short UI status token (open string — not the closed
//                Approval/Health lifecycle set; a display hint like "ok"/"warn").
export interface UiSafeDashboardCard {
  cardId: string;
  kind: string;
  title: string;
  status: string;
  count: number;
  updatedAt: string;
}

export const UiSafeDashboardCardSchema = z
  .object({
    cardId: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    count: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

// ── UiSafeGclProjection ──────────────────────────────────────────────────────
// The Global-Today (§9.4) cross-workspace item — the ONE UI-safe shape on the WS-8
// cross-workspace read path, so the highest workspace-isolation risk. A source
// GclProjection is ALREADY gate-sanitized, but its `sanitizedPayload` is an OPEN
// record (arbitrary keys) and its `sourceRefs` are INTERNAL refs — neither may cross
// verbatim. So this shape carries only KNOWN, bounded fields:
//   - `workspaceId`     : the source workspace (also the renderer's grouping key);
//   - `visibilityLevel` : the §5 level — DRIVES whether a raw drill-down is allowed;
//   - `projectionType`  : the open summary category (e.g. "deadlines");
//   - `summary`         : ONE short single-line sanitized summary (projector-built,
//                         re-bounded here — no raw payload passthrough);
//   - `drillable`       : whether the level permits a worker-mediated raw drill-down
//                         (an AFFORDANCE HINT only — the worker re-checks + enforces;
//                         the renderer is untrusted and merely hides/shows the link).
// DROPPED from GclProjection: `sanitizedPayload` (open record) + `sourceRefs`.
export interface UiSafeGclProjection {
  workspaceId: string;
  visibilityLevel: VisibilityLevel;
  projectionType: string;
  summary: string;
  drillable: boolean;
}

export const UiSafeGclProjectionSchema = z
  .object({
    workspaceId: z.string().min(1),
    visibilityLevel: VisibilityLevelSchema,
    projectionType: z.string().min(1),
    summary: uiSafeSummaryLine,
    drillable: z.boolean(),
  })
  .strict();

// ── Schema ⇄ interface parity guards (compile-time; erased at runtime) ───────
// Each asserts the schema's inferred output EXACTLY equals its standalone
// interface — so the interface and the runtime validator can never drift apart.
const _uiSafeParity: [
  Exact<z.infer<typeof UiSafeApprovalSchema>, UiSafeApproval>,
  Exact<z.infer<typeof UiSafeHealthItemSchema>, UiSafeHealthItem>,
  Exact<z.infer<typeof UiSafeWorkflowRunRefSchema>, UiSafeWorkflowRunRef>,
  Exact<z.infer<typeof UiSafeDashboardCardSchema>, UiSafeDashboardCard>,
  Exact<z.infer<typeof UiSafeGclProjectionSchema>, UiSafeGclProjection>,
] = [true, true, true, true, true];
void _uiSafeParity;

// ── Checked-in allowlist — THE source of truth ───────────────────────────────
// Each entry is the explicit, SORTED array of the exact field names permitted on
// that projection. The Phase-8 worker projection functions map domain → UI-safe
// using ONLY these names; the contract test freezes every schema's field set
// against its entry so a field cannot be silently added to the UI surface later.
export const UI_SAFE_ALLOWLIST = {
  approval: ["actionRef", "channel", "expiresAt", "id", "snoozeUntil", "status"],
  healthItem: ["failureClass", "id", "openedAt", "resolvedAt", "severity", "state"],
  workflowRunRef: ["idempotencyKey", "state", "trigger", "workflowId"],
  dashboardCard: ["cardId", "count", "kind", "status", "title", "updatedAt"],
  gclProjection: ["drillable", "projectionType", "summary", "visibilityLevel", "workspaceId"],
} as const;
