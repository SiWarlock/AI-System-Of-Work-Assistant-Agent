// 13.8f-B — the meeting-path living-vault rewrite adapter: the composition-root half of §6 KN-10 for
// the MEETING closeout path (the meeting analog of 13.8d's `living-vault.ts` for the SOURCE path). It
// adapts `@sow/knowledge`'s `rewriteVaultForMeeting` onto the workflow-layer `MeetingVaultRewritePort`.
//
// dormancy-waiver(13.8f-B): arming runs through boot.ts `gateMeetingVaultRewrite` (strict `=== true`).
// The strict check lives at the composition root rather than in this file — "logic-in-package,
// wire-at-boot" — which is why this module carries the waiver marker instead of an `=== true` of its
// own.
//
// ⚠ STATE OF THE WIRING (do not read the line above as "already live"): `gateMeetingVaultRewrite` has NO
// call site in `bootWorker` yet, and nothing constructs the `MeetingRewriteDeps` the real rewrite needs
// (gbrain/reason/sections/newPlanId/newRunId). So `params.meetingVault` is never populated in the shipped
// composition, and the capability is inert by ABSENCE as well as by flag — mirrors living-vault.ts's own
// honesty about its wiring state (13.8d).
//
// 13.8f-C: `receipt.plans` (the sibling entity-page plans) now crosses this port too — carried out
// alongside `meetingNoteLinkMutations`, never committed here (the workflow commits them, after its own
// main-plan commit — see workflows/meetingCloseout.ts). `refusals` is now READ (13.8m-C, below) but
// NEVER crosses the port's return value — the shared `@sow/workflows` `MeetingVaultRewriteResult` type
// is out of this package's territory and stays exactly `{meetingNoteLinkMutations, plans}`; the
// refusal channel is consumed and emitted ENTIRELY INSIDE this adapter via an optional fire-and-forget
// sink (13.8m-B's own pattern in living-vault.ts). `groundedPaths` is still NEVER read anywhere in this
// file — see `MeetingVaultRewriteResult`'s own header in ports/meetingCloseout.ts.
//
// 13.8m-C — the MEETING-path refusals consumer. 13.8m-A (ingest-rewrite.ts) built the SOURCE-path
// producer; 13.8m-B (living-vault.ts) built the SOURCE-path worker consumer (a `recordRefusals`
// fire-and-forget sink over `{workspaceId, codes: GroundedPathRefusal[]}`). The MEETING path's producer
// (`rewriteVaultForMeeting`'s `MeetingRewriteReceipt.refusals`) has existed since 13.8g-B but had NO
// worker consumer — this closes that gap, INSIDE this adapter, never by widening the shared port type.
// ⛔ RULE-7 CONSTRAINT (13.8g-A's reviewer, re-stated for this channel): the SAME receipt also carries
// `groundedPaths`, which — unlike `refusals` (a closed 2-member code union, structurally name-free) —
// CAN contain attendee-derived LITERAL HUMAN NAMES (`normalizeAttendees` → `EntityRef.name` →
// `entitySlug` → `stubNotePathFor` → `people/<person-name>.md`). So 13.8m-B's exact sink shape is kept
// (code-only), but this channel does NOT reuse 13.8m-B's `codes: GroundedPathRefusal[]` array shape
// verbatim — instead it TALLIES per distinct code (`{workspaceId, code, count}`, one call per code),
// so nothing about *which specific path* was refused (an index into a name-bearing array, an order, a
// count-per-path) can ever be reconstructed from the audit trail. `groundedPaths` itself is NEVER read
// by this module, before or after this change.
//
// NO CONTAINMENT LAYER (unlike living-vault.ts, deliberately) — RE-VERIFIED, still true after 13.8g-B:
// `meetingNoteLinkMutations`' `srcPath` is, by construction, always the meeting note itself
// (`meeting-rewrite.ts:272`: `l.srcPath === meetingNotePath`) — never synthesized — and `dstSlug` is not
// treated as a raw filesystem path anywhere in the source-path precedent either (`living-vault.ts`'s own
// `touchedPaths()` never reads `.dstSlug`). 13.8g-B changes only what crosses IN (`entityRefs`/
// `identifierOnlyRefs`, below), never what crosses OUT — so this narrow cut still opens no new
// path-escape surface for a realpath-containment layer to close.
//
// 13.8g-B — `entityRefs`/`identifierOnlyRefs` are now threaded, via `normalizeAttendees` (13.8g-A) over
// the meeting's attendee data. `linkCandidates` remains NOT threaded (a real residual — nothing today
// supplies a workspace note-candidate list for `healLinks`; a future follow-up, not this slice's job).
// ✅ 13.8g-C leg B (DECIDED + LANDED): the real meeting-extraction schema gate
// (`meeting-extraction.ts`'s `createMeetingExtractionSchemaGate`) now reads contracts'
// `LIST_VALUED_EXTRACTION_FIELDS` and admits `attendees` as a capped, nesting-free `string[]` (additive
// over its prior scalar-or-TBD shape) — so a realistic validated extraction CAN carry attendees as an
// array, and this adapter's `normalizeAttendees` call reaches its array branch and yields real refs. See
// `meeting-vault.test.ts`'s `attendees_reach_the_rewrite_input_now_that_the_gate_admits_a_list` for the
// end-to-end proof (real gate + this adapter, not a stand-in).
import { rewriteVaultForMeeting, normalizeAttendees } from "@sow/knowledge";
import type { MeetingRewriteDeps, GroundedPathRefusal } from "@sow/knowledge";
import type { WorkspaceId, SourceRef, ProvenanceOrigin } from "@sow/contracts";
import type {
  MeetingVaultRewritePort,
  MeetingVaultRewriteResult,
} from "@sow/workflows/ports/meetingCloseout";

/**
 * Code-only meeting-path refusal audit (rule 7; 13.8m-C) — the workspace, ONE refusal `code`, and its
 * occurrence COUNT for this run (never a path/title/entity name; never the raw refused-path array).
 * `code` is the closed `GroundedPathRefusal` union (2 members today) — a value drawn from this type
 * cannot, by construction, carry a name/path/slug.
 */
export interface MeetingRefusalAudit {
  readonly workspaceId: WorkspaceId;
  readonly code: GroundedPathRefusal;
  readonly count: number;
}

export interface MeetingVaultAuditDeps {
  /**
   * 13.8m-C — optional best-effort audit sink (§6 KN-7 "rejected AND audited"), the MEETING-path analog
   * of `living-vault.ts`'s `recordRefusals`. Fired ONCE PER DISTINCT refusal `code` present in this
   * run's receipt (a tally, not a raw forward) — ONLY when `refusals` is non-empty, so a benign run
   * invokes it zero times (preserving the empty-vs-refused distinction). Never alters the returned
   * `MeetingVaultRewriteResult` and never escapes as an unhandled rejection, whether the sink throws
   * sync or rejects async (L25/L53 best-effort, byte-for-byte the discipline `living-vault.ts`'s
   * `emitRefusalAudit` already uses). Unbound (the shipped default) ⇒ zero invocations (L11
   * byte-equivalent).
   */
  readonly recordRefusals?: (audit: MeetingRefusalAudit) => Promise<unknown>;
}

/**
 * Best-effort, fire-and-forget: never throws, never awaited, never alters the caller's returned
 * `MeetingVaultRewriteResult` (L25/L53) — one call PER DISTINCT code in `refusals`, each carrying that
 * code's occurrence count this run. `GroundedPathRefusal` is a 2-member closed union, so tallying costs
 * at most 2 sink invocations regardless of how many paths were refused.
 */
function emitMeetingRefusalAudit(
  sink: MeetingVaultAuditDeps["recordRefusals"],
  workspaceId: WorkspaceId,
  refusals: readonly GroundedPathRefusal[],
): void {
  if (refusals.length === 0 || typeof sink !== "function") return;
  const tally = new Map<GroundedPathRefusal, number>();
  for (const code of refusals) tally.set(code, (tally.get(code) ?? 0) + 1);
  for (const [code, count] of tally) {
    try {
      void sink({ workspaceId, code, count }).catch(() => {});
    } catch {
      /* best-effort — a throwing sink must never alter the primary result. */
    }
  }
}

/**
 * Adapt the real `rewriteVaultForMeeting` onto {@link MeetingVaultRewritePort}. Maps the port's
 * arguments onto `MeetingRewriteInput` — `entityRefs`/`identifierOnlyRefs` are populated from the
 * meeting's attendee data (13.8g-B), normalized via `@sow/knowledge`'s `normalizeAttendees` (never from
 * "correlation signals" — `CorrelationSignals` runs BEFORE extraction and has no attendees field to
 * carry; see `IMPLEMENTATION_PLAN.md` `#### 13.8g`). `withheld` (code-only exclusion reasons) is
 * deliberately DROPPED, not threaded — surfacing it with no reader today would mint a fresh L106; its
 * future consumer is 13.8m. `linkCandidates` remains unthreaded (a genuine residual, not this slice's
 * job — see the module header). An armed run can now ground against real attendee-derived person
 * entities for real (13.8g-C leg B, module header) — no longer a "yields zero" residual. That the
 * capability still ships DORMANT is a SEPARATE fact (the boot gate/deps construction, unrelated to
 * whether this adapter's logic is correct) — mirrors `createIngestRewriteAdapter`'s own dormancy note
 * in living-vault.ts.
 */
export function createMeetingVaultPort(
  knowledgeDeps: MeetingRewriteDeps,
  audit?: MeetingVaultAuditDeps,
): MeetingVaultRewritePort {
  return {
    async rewrite(
      workspaceId: WorkspaceId,
      meetingNotePath: string,
      sourceRef: SourceRef,
      provenanceOrigin: ProvenanceOrigin,
      attendees?: unknown,
    ): Promise<MeetingVaultRewriteResult> {
      // 13.8g-C leg B (landed): `normalizeAttendees` requires Array.isArray — the real meeting-
      // extraction schema gate now ADMITS `attendees` as a string[] (contracts'
      // LIST_VALUED_EXTRACTION_FIELDS), so this reaches the array branch on a realistic validated
      // extraction and yields real refs. A non-array (a legacy scalar, or an un-gated caller) still
      // hits the non-array branch and yields empty — total either way.
      const { refs, identifierOnlyRefs } = normalizeAttendees(attendees);
      const receipt = await rewriteVaultForMeeting(
        {
          workspaceId,
          provenanceOrigin,
          meetingNotePath,
          sourceRefs: [
            {
              sourceId: String(sourceRef.sourceId),
              ...(sourceRef.span !== undefined ? { span: sourceRef.span } : {}),
            },
          ],
          entityRefs: refs,
          identifierOnlyRefs,
        },
        knowledgeDeps,
      );
      // 13.8m-C: fired BEFORE the narrowed return below, over the receipt's OWN `refusals` — never the
      // narrowed `result` value, so this observes every refusal regardless of what the port's return
      // shape keeps or drops.
      emitMeetingRefusalAudit(audit?.recordRefusals, workspaceId, receipt.refusals);
      // ⚠ EXCESS-PROPERTY NOTE (not adversarial, but real): this return is a literal object, so
      // TypeScript's excess-property check blocks an accidental extra key (e.g. `groundedPaths`,
      // `refusals`) at COMPILE TIME. That protection is SYNTACTIC — it applies to a fresh object
      // literal, not to a variable or an `as`-cast. `return receipt as MeetingVaultRewriteResult` (or
      // assigning the literal to a variable first) would silently widen the crossed shape with no
      // compiler error. Keep this a literal; never a passthrough cast of `receipt`.
      return { meetingNoteLinkMutations: receipt.meetingNoteLinkMutations, plans: receipt.plans };
    },
  };
}
