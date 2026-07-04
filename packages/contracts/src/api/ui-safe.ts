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
// summary). 1024 mirrors the GCL gate's MAX_SUMMARY_VALUE_LEN. The line-terminator set
// covers the FULL Unicode newline family — not just `\r`/`\n` but the vertical tab
// (U+000B), form feed (U+000C), next-line (U+0085), and the line/paragraph separators
// (U+2028/U+2029) — because for UiSafeRecentChange this helper is the SOLE structural
// bound (no upstream sanitization gate, unlike GclProjection): a fragment that renders as
// a break in some surfaces must not slip through.
const uiSafeSummaryLine = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !/[\r\n\u000B\u000C\u0085\u2028\u2029]/.test(s), {
    message: "summary must be single-line",
  });

// An OPAQUE canonical reference id: a short scheme:token-style handle with NO path, URL, or
// whitespace characters — so a projector cannot smuggle a filesystem path (`/Users/…`) or URL
// (`https://…`) through an evidence ref (WS-8 / secrets #7). Allows `src:plan-abc123`,
// `sha256:deadbeef`, `abc123`; rejects anything containing `/` or whitespace. Capped short (an
// id, not free text). The remaining opacity/non-enumerability is a projector obligation.
const uiSafeOpaqueRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "evidence ref must be an opaque id (no path/URL/whitespace)");

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

// ── UiSafeRecentChange ───────────────────────────────────────────────────────
// A workspace-scoped "Recent activity" row (§9.5, Flow 5) — a committed knowledge
// mutation / audit-linked change the renderer lists under Today. The source is an
// AuditRecord, which carries a content-derived `payloadHash`, a principal `actor`, and
// internal `refs` — none may cross. So this shape carries only:
//   - `changeId`   : a projection-local opaque id MINTED BY THE PROJECTOR — the frozen
//                    AuditRecord carries no id of its own (it is stored under the
//                    operational store's implicit rowid, a storage-layer artifact outside
//                    the contract), so the projector assigns a stable, NON-ENUMERABLE
//                    changeId. It is the renderer's HANDLE for a future worker-mediated
//                    audit drill (the renderer never interprets it; the worker resolves it
//                    server-side AND re-checks scope-ownership on every drill — WS-8);
//   - `kind`       : a short display-category token (open string, like UiSafeDashboardCard
//                    `kind` — e.g. "commit"/"sync"/"approval"; a display hint, not content);
//   - `summary`    : ONE projector-built single-line line (actor + event + detail folded in
//                    and bounded by the projector — no raw AuditRecord field passthrough,
//                    mirroring UiSafeGclProjection's single bounded summary). PROJECTOR
//                    OBLIGATION (Lesson §5): redact-by-type every folded fragment; never
//                    fold raw `beforeSummary`/`afterSummary`/`payloadHash` or a cross-scope
//                    identity; `.safeParse` through this schema before emit;
//   - `occurredAt` : ISO datetime, from `AuditRecord.timestamps.occurredAt` (nested;
//                    NOT the internal `timestamps.recordedAt` persistence stamp) — for
//                    relative-time display + descending ordering.
// DROPPED from AuditRecord: `payloadHash` (content-derived — like UiSafeApproval),
// `actor` (principal identity — like UiSafeApproval), `refs` (internal refs — dropped as
// UiSafeHealthItem drops its own `auditRef`), `beforeSummary`/`afterSummary` (unbounded raw
// summaries). Carries NO `workspaceId` (mirrors UiSafeDashboardCard, so a pushed/cached row
// can never blend cross-scope; the worker scopes the query, not the row).
export interface UiSafeRecentChange {
  changeId: string;
  kind: string;
  summary: string;
  occurredAt: string;
}

export const UiSafeRecentChangeSchema = z
  .object({
    changeId: z.string().min(1),
    kind: z.string().min(1),
    summary: uiSafeSummaryLine,
    occurredAt: z.string().datetime(),
  })
  .strict();

// ── UiSafeProjectProgress ────────────────────────────────────────────────────
// The DETERMINISTIC progress of a project (§9.5, REQ-F-011): counts PARSED from real task
// state (GFM checkboxes) by the worker's `computePercent`/`countCheckboxes` — NEVER a
// model-inferred percentage. The renderer only DISPLAYS `percentComplete`; it never divides.
// The schema pins the STRUCTURE (integer counts, percent ∈ [0,100]); the CROSS-FIELD
// invariants are enforced worker-side at the re-validation boundary (an object-level `.refine`
// would collapse `.shape`, which the allowlist freeze test reads — Lesson §3: the gate is a
// composition, not the schema alone): (a) `percent === computePercent(counts)` — the worker
// owns `computePercent`, @sow/contracts is pure and cannot import it; (b) `completedCount <=
// totalCount`; (c) `totalCount === 0 ⇒ percent === 0` (a task-less project is 0%, never an
// inferred 100%). S2/S3 MUST re-derive + reject a mismatch before emit (REQ-F-011).
export interface UiSafeProjectProgress {
  completedCount: number;
  totalCount: number;
  percentComplete: number;
}

export const UiSafeProjectProgressSchema = z
  .object({
    completedCount: z.number().int().min(0),
    totalCount: z.number().int().min(0),
    percentComplete: z.number().int().min(0).max(100),
  })
  .strict();

// ── UiSafeProjectDashboard ───────────────────────────────────────────────────
// A dedicated Projects-surface card (§9.5, Flow 5, locked design §4.5). Carries the
// deterministic progress plus the project's evidence-backed prose (blockers / waiting items /
// next actions) and opaque evidence refs. The prose fields originate ONLY from a
// no-inference-gated `ValidatedNarrative` upstream; each entry is re-bounded single-line here
// (defense-in-depth — a multi-line entry is the shape of leaked raw content). `evidenceRefs`
// are OPAQUE canonical ids (never file paths / URLs — the GCL precedent dropped `sourceRefs`).
// DROPS `workspaceId` (the renderer knows the scope; a card can't self-misattribute — like
// UiSafeDashboardCard) and `progressSources` (per-source names can be file paths).
export interface UiSafeProjectDashboard {
  projectId: string;
  title: string;
  status: string;
  progress: UiSafeProjectProgress;
  blockers: readonly string[];
  waitingItems: readonly string[];
  nextActions: readonly string[];
  evidenceRefs: readonly string[];
  updatedAt: string;
}

export const UiSafeProjectDashboardSchema = z
  .object({
    projectId: z.string().min(1),
    title: uiSafeSummaryLine,
    status: z.string().min(1),
    progress: UiSafeProjectProgressSchema,
    // Array LENGTHS are capped (not just each element): the per-element single-line bound
    // alone is defeated by CHUNKING — a raw document re-assembled as N×single-line fragments
    // (also a §10 push-stream DoS). Each prose element is single-line ≤1024; evidenceRefs are
    // opaque-id-grammar (no path/URL). REDACT-BY-TYPE of the prose content itself (a raw
    // single-line secret/path/codename) is a downstream projector obligation (Lesson §5).
    blockers: z.array(uiSafeSummaryLine).max(50).readonly(),
    waitingItems: z.array(uiSafeSummaryLine).max(50).readonly(),
    nextActions: z.array(uiSafeSummaryLine).max(50).readonly(),
    evidenceRefs: z.array(uiSafeOpaqueRef).max(50).readonly(),
    updatedAt: z.string().datetime(),
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
  Exact<z.infer<typeof UiSafeRecentChangeSchema>, UiSafeRecentChange>,
  Exact<z.infer<typeof UiSafeProjectProgressSchema>, UiSafeProjectProgress>,
  Exact<z.infer<typeof UiSafeProjectDashboardSchema>, UiSafeProjectDashboard>,
] = [true, true, true, true, true, true, true, true];
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
  recentChange: ["changeId", "kind", "occurredAt", "summary"],
  projectProgress: ["completedCount", "percentComplete", "totalCount"],
  projectDashboard: [
    "blockers",
    "evidenceRefs",
    "nextActions",
    "progress",
    "projectId",
    "status",
    "title",
    "updatedAt",
    "waitingItems",
  ],
} as const;
