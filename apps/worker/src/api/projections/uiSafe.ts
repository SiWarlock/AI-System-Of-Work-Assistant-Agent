// Task 8.2 (b) — PURE UI-safe projection functions (WS-8 / §10 leakage boundary).
//
// THE single boundary where a frozen domain record becomes a renderer-visible
// shape. Each projector maps a domain record → its UI-safe shape by copying ONLY
// the field names enumerated in the checked-in `UI_SAFE_ALLOWLIST` (from
// @sow/contracts — the source of truth). Secrets, Keychain refs, raw
// Employer-Work content, provider prompts, `AgentResult.logs`, and ANY
// non-allowlisted field can NEVER cross: the projector NAMES each output field
// explicitly, so a field that is present on the input but absent from the
// allowlist is simply never read. A `...spread` of the domain record is FORBIDDEN
// here — an adversarially-injected extra key would ride out. This is why the RED
// spec feeds each projector a record carrying an extra sensitive field and
// asserts the projected object has ONLY allowlisted names.
//
// PURE — no @trpc, no I/O, no throw. Deterministic field-copy only.
import type {
  Approval,
  HealthItem,
  TargetSystem,
  WorkflowRunRef,
  GclProjection,
  SourceEnvelope,
  UiSafeApproval,
  UiSafeHealthItem,
  UiSafeWorkflowRunRef,
  UiSafeDashboardCard,
  UiSafeGclProjection,
  UiSafeIngestionItem,
  UiSafeScheduleEntry,
} from "@sow/contracts";
import { collapseToSummaryLine, UiSafeScheduleEntrySchema } from "@sow/contracts";
import { permitsRawDrillDown } from "@sow/policy";

/**
 * Copy an OPTIONAL field only when it is defined — so an absent optional field is
 * OMITTED from the projection (no `undefined`-valued key) rather than set to
 * `undefined`. Keeps the projected object minimal and its field set a clean
 * subset of the allowlist. Generic over the target key so the assignment is typed.
 */
function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Project an {@link Approval} to a {@link UiSafeApproval}. Copies ONLY the
 * allowlisted names (`id`, `actionRef?`, `subjectKind`, `status`, `channel`,
 * `snoozeUntil?`, `expiresAt?`, `targetSystem?`, `workspaceId`). DROPS `actor`
 * (approving-principal identity), `payloadHash` (content-derived hash), and
 * `planRef` (the opaque semantic subject ref) — and any other field present on
 * the record. Branded ids are narrowed to plain strings for the renderer.
 *
 * §9.8 enrichment:
 *   - `workspaceId` — server-set attribution ALREADY on the Approval record
 *     itself (WS-4/WS-7 — `approval.ts`'s own header: bound at record time,
 *     never a client/model value). Copied through UNCONDITIONALLY; every
 *     Approval carries one.
 *   - `targetSystem` — the external system an `external_action` card's BOUND
 *     `ProposedAction` writes to. `Approval` itself carries only `actionRef`
 *     (a ref), not the `ProposedAction` record the ref points to, so this pure
 *     projector cannot resolve `targetSystem` on its own — the CALLER supplies
 *     it (resolved from the bound ProposedAction store; additive-optional
 *     parameter, so every existing single-arg call site stays valid and keeps
 *     omitting it). Gated on `subjectKind === "external_action"`, not merely
 *     the caller's own discipline: a `semantic_mutation` card has NO
 *     `ProposedAction` to resolve one from, so a caller-supplied value is
 *     dropped defensively for that subject kind — "absent for
 *     semantic_mutation" is a guarantee of THIS function, not a convention.
 */
export function toUiSafeApproval(approval: Approval, targetSystem?: TargetSystem): UiSafeApproval {
  const out: UiSafeApproval = {
    id: approval.id,
    // §13.10a Slice H — the card discriminator (external_action vs semantic_mutation): a frozen
    // 2-value enum (no content) the renderer branches card shapes on. Always present on the Approval.
    subjectKind: approval.subjectKind,
    status: approval.status,
    channel: approval.channel,
    workspaceId: approval.workspaceId,
  };
  // §13.10a — actionRef is optional (present for an external_action card, absent for a
  // semantic_mutation card, which carries a planRef that is NOT surfaced — planRef is an opaque
  // idempotency key). Omit when absent so the projection stays a clean subset of the allowlist.
  assignIfDefined(out, "actionRef", approval.actionRef);
  assignIfDefined(out, "snoozeUntil", approval.snoozeUntil);
  assignIfDefined(out, "expiresAt", approval.expiresAt);
  if (approval.subjectKind === "external_action") {
    assignIfDefined(out, "targetSystem", targetSystem);
  }
  return out;
}

/**
 * Project a {@link HealthItem} to a {@link UiSafeHealthItem}. Copies ONLY the
 * allowlisted names (`id`, `failureClass`, `severity`, `state`, `openedAt`,
 * `resolvedAt?`). DROPS `message` (may echo raw content / a secret), `auditRef`,
 * `parityReportRef`, and `factIdentity` (internal refs) — and any other field.
 */
export function toUiSafeHealthItem(item: HealthItem): UiSafeHealthItem {
  const out: UiSafeHealthItem = {
    id: item.id,
    failureClass: item.failureClass,
    severity: item.severity,
    state: item.state,
    openedAt: item.openedAt,
  };
  assignIfDefined(out, "resolvedAt", item.resolvedAt);
  return out;
}

/**
 * Project a {@link WorkflowRunRef} to a {@link UiSafeWorkflowRunRef}. Copies ONLY
 * the allowlisted names (`workflowId`, `trigger`, `state`, `idempotencyKey`).
 * DROPS `auditRefs` (the internal audit trail) — and any other field.
 */
export function toUiSafeWorkflowRunRef(ref: WorkflowRunRef): UiSafeWorkflowRunRef {
  return {
    workflowId: ref.workflowId,
    trigger: ref.trigger,
    state: ref.state,
    idempotencyKey: ref.idempotencyKey,
  };
}

/**
 * Source shape for the dashboard-card projector. There is no frozen
 * `DashboardCard` seam model (§10 read-model cards are a UI construct), so the
 * projector's INPUT is defined here as the superset the worker's read-model layer
 * produces. The projector still copies ONLY the allowlisted names — a broader
 * input (extra keys) is narrowed to the UI-safe shape. Every field on
 * `UiSafeDashboardCard` is UI-safe by construction (no domain secret to drop),
 * but the explicit copy keeps the boundary discipline uniform across projectors.
 */
export interface DashboardCardSource {
  cardId: string;
  kind: string;
  title: string;
  status: string;
  count: number;
  updatedAt: string;
}

/**
 * Project a {@link DashboardCardSource} to a {@link UiSafeDashboardCard}. Copies
 * ONLY the allowlisted names (`cardId`, `kind`, `title`, `status`, `count`,
 * `updatedAt`). Any extra key on the source is not read — nothing else crosses.
 */
export function toUiSafeDashboardCard(card: DashboardCardSource): UiSafeDashboardCard {
  return {
    cardId: card.cardId,
    kind: card.kind,
    title: card.title,
    status: card.status,
    count: card.count,
    updatedAt: card.updatedAt,
  };
}

/**
 * Build ONE short single-line display summary from an (already gate-sanitized)
 * GclProjection `sanitizedPayload`. Prefer an explicit `summary`/`headline` string;
 * else join the scalar values; and if the payload yields nothing, fall back to
 * `projectionType` so the summary is NEVER empty (the UI-safe schema requires min 1).
 * Newlines are collapsed to spaces (single-line seam) and the result is capped at the
 * 1024 the UI-safe schema allows. The payload values are ALREADY bounded by the §6 GCL
 * gate, so this only reshapes them for display — no raw content is introduced.
 */
function buildGclSummary(payload: Record<string, unknown>, fallback: string): string {
  const preferred = payload["summary"] ?? payload["headline"];
  let text: string;
  if (typeof preferred === "string" && preferred.trim().length > 0) {
    text = preferred;
  } else {
    const parts: string[] = [];
    for (const v of Object.values(payload)) {
      if (typeof v === "string" && v.trim().length > 0) parts.push(v);
      else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    }
    text = parts.join(" · ");
  }
  const oneLine = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const summary = oneLine.length > 0 ? oneLine : fallback;
  return summary.length > 1024 ? summary.slice(0, 1024) : summary;
}

/**
 * Project a {@link GclProjection} (the WS-8 cross-workspace read path — the highest
 * isolation risk) to a {@link UiSafeGclProjection}. Copies ONLY the allowlisted names
 * (`workspaceId`, `visibilityLevel`, `projectionType`, `summary`, `drillable`) and
 * DERIVES the two non-copied fields:
 *   - `summary`   — a bounded single-line display line from `sanitizedPayload` (the
 *                   open record itself NEVER crosses — see {@link buildGclSummary});
 *   - `drillable` — the shared §5 gate `permitsRawDrillDown` (full-only), so the
 *                   affordance HINT can never diverge from the worker's enforcement.
 * DROPS `sanitizedPayload` (open record) and `sourceRefs` (internal refs) entirely.
 */
export function toUiSafeGclProjection(projection: GclProjection): UiSafeGclProjection {
  return {
    workspaceId: projection.workspaceId,
    visibilityLevel: projection.visibilityLevel,
    projectionType: projection.projectionType,
    summary: buildGclSummary(projection.sanitizedPayload, projection.projectionType),
    drillable: permitsRawDrillDown(projection.visibilityLevel),
  };
}

/**
 * Project a {@link SourceEnvelope} (the frozen ingestion source-register record, §8/§9) to a
 * {@link UiSafeIngestionItem} — the §9.7 ingestion-inbox row. Copies ONLY the allowlisted names
 * (`sourceId`, `type`, `sensitivity`) by EXPLICIT field copy (no `...spread`) + DERIVES a bounded
 * single-line `summary` from the SAFE `type` display token via `collapseToSummaryLine`.
 *
 * EMPTY-UNTIL-PRODUCER: the summary is the safe source `type` token; a real write-time producer
 * supplies a redaction-by-type display title (root CLAUDE.md Lesson §5) — NEVER the raw `origin`.
 *
 * DROPS every raw ref on the record: `origin` (a source URI / filesystem path — the GCL / #7 raw-ref
 * precedent), `contentHash` (content-derived — dropped like UiSafeApproval's payloadHash),
 * `routingHints` (an open record — dropped like GclProjection's sanitizedPayload), and `workspaceId`
 * (the renderer knows its scope — mirrors UiSafeDashboardCard/UiSafeRecentChange). This projector is
 * the drop-rules SEAM the DEFERRED write-time ingestion producer calls; the read path re-validates
 * every served row through `UiSafeIngestionItemSchema` regardless (defense-in-depth).
 */
export function toUiSafeIngestionItem(source: SourceEnvelope): UiSafeIngestionItem {
  // `type` is an open `min(1)` token — a whitespace-only value collapses to "" and would fail the
  // read boundary's `uiSafeSummaryLine` gate, fail-closing the WHOLE inbox. Fall back to a non-empty
  // placeholder so a degenerate source stays visible rather than taking the surface offline.
  const summary = collapseToSummaryLine(source.type) || "source";
  return {
    sourceId: source.sourceId,
    type: source.type,
    sensitivity: source.sensitivity,
    summary,
  };
}

/**
 * Source shape for the §9.9a calendar-schedule projector (Flow 3 / REQ-F-009). There is no frozen
 * seam for a raw busy window (availability is a cross-workspace read the GCL gate sanitizes), so the
 * projector's INPUT is defined here as the superset the availability source yields (mirrors
 * `DashboardCardSource`): a sanitized busy window carrying, at most, a GENERIC reason. `sourceId`
 * records WHICH calendar/connector produced it — and the projector DROPS it (WS-8: which workspace is
 * busy WHEN is itself a cross-workspace timing leak).
 */
export interface ScheduleWindowSource {
  /** WHICH availability source produced the window — DROPPED by the projector (WS-8 attribution). */
  readonly sourceId?: string;
  /** ISO-8601 window start. */
  readonly start: string;
  /** ISO-8601 window end. */
  readonly end: string;
  /** OPTIONAL GENERIC sanitized reason — the ONLY conflict text that may surface (never raw detail). */
  readonly genericReason?: string;
}

/**
 * Project a sanitized busy {@link ScheduleWindowSource} to a {@link UiSafeScheduleEntry} — the §9.9a
 * drop-seam the DEFERRED write-time producer calls. Copies ONLY `start`/`end` (→ `busy: true` — a busy
 * window is busy by definition) and DERIVES a single-line `conflictExplanation` from the SAFE
 * `genericReason` via `collapseToSummaryLine` (L5 projector obligation — never a raw event field
 * passthrough). Everything else on the source — `sourceId` (WHICH calendar), any adversarial extra key
 * (a raw title/attendee/body) — is NEVER read, so no source/workspace/timing attribution can ride out
 * (WS-8). Enforces the ui-safe.ts-DEFERRED cross-field invariant `start <= end` AT WRITE: an inverted /
 * unparseable window returns `null` (the producer drops it) rather than emitting a nonsensical entry.
 * The `busy === false ⇒ conflictExplanation` absent invariant holds by construction here (busy is
 * always `true`); the read-side `sanitizeCalendar` re-gates BOTH against a tampered stored row.
 */
export function toUiSafeScheduleEntry(window: ScheduleWindowSource): UiSafeScheduleEntry | null {
  const out: UiSafeScheduleEntry = { start: window.start, end: window.end, busy: true };
  if (window.genericReason !== undefined) {
    const line = collapseToSummaryLine(window.genericReason);
    // collapseToSummaryLine returns "" for a whitespace-only reason — OMIT rather than emit an empty
    // conflictExplanation (which would fail the frozen `uiSafeSummaryLine.min(1)` at read → whole-degrade).
    if (line.length > 0) out.conflictExplanation = line;
  }
  // (1) Write-validity == read-validity: validate the projected entry against the SAME frozen
  //     `UiSafeScheduleEntrySchema` the read-side `sanitizeCalendar` re-gates with (full-ISO `.datetime()`
  //     start/end + the single-line conflictExplanation bound). A window whose projected entry would fail
  //     the read schema (a date-only / non-ISO bound) is DROPPED HERE — never stored — so a single
  //     malformed window can never poison the WHOLE calendar via `sanitizeCalendar`'s whole-degrade-to-empty.
  if (!UiSafeScheduleEntrySchema.safeParse(out).success) return null;
  // (2) The ui-safe.ts-DEFERRED cross-field invariant the structural schema can't carry: `start <= end`.
  //     Both bounds are now valid `.datetime()` values, so `Date.parse` yields a finite instant — a
  //     CHRONOLOGICAL compare, never lexicographic (which diverges under variable fractional-second
  //     precision; the `sanitizeRecentChanges` rationale). `busy === false ⇒ conflictExplanation` absent
  //     holds by construction here (busy is always `true`).
  if (Date.parse(window.start) > Date.parse(window.end)) return null;
  return out;
}
