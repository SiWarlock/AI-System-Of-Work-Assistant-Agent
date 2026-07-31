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
// NARROW CUT (13.8f-B): only `meetingNoteLinkMutations` crosses this port — the receipt's sibling
// entity-page `plans` are deliberately NOT read here at all (13.8f-C's territory: committing them is
// §9.8-Approvals-adjacent — the `requiresApproval !== false` AUTO/PROPOSE split belongs to task 13.8i —
// so this slice doesn't split that already-tracked task across two slices). `refusals`/`groundedPaths`
// are similarly not read — see `MeetingVaultRewriteResult`'s own header in ports/meetingCloseout.ts.
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
// ⚠ SCOPED CLAIM (13.8g-C, not yet decided): attendee refs are threaded, but the path yields ZERO refs
// today — the real meeting-extraction schema gate (`meeting-extraction.ts`'s `isPrimitiveOrTbd`) admits
// only scalars, so an array can never reach this adapter in a validated extraction; a realistic
// delimited string hits `normalizeAttendees`' non-array branch. Never state this as "attendees now
// update person pages" — see `packages/composition/meeting-vault.test.ts`'s own characterization pin.
import { rewriteVaultForMeeting, normalizeAttendees } from "@sow/knowledge";
import type { MeetingRewriteDeps } from "@sow/knowledge";
import type { WorkspaceId, SourceRef, ProvenanceOrigin } from "@sow/contracts";
import type {
  MeetingVaultRewritePort,
  MeetingVaultRewriteResult,
} from "@sow/workflows/ports/meetingCloseout";

/**
 * Adapt the real `rewriteVaultForMeeting` onto {@link MeetingVaultRewritePort}. Maps the port's
 * arguments onto `MeetingRewriteInput` — `entityRefs`/`identifierOnlyRefs` are populated from the
 * meeting's attendee data (13.8g-B), normalized via `@sow/knowledge`'s `normalizeAttendees` (never from
 * "correlation signals" — `CorrelationSignals` runs BEFORE extraction and has no attendees field to
 * carry; see `IMPLEMENTATION_PLAN.md` `#### 13.8g`). `withheld` (code-only exclusion reasons) is
 * deliberately DROPPED, not threaded — surfacing it with no reader today would mint a fresh L106; its
 * future consumer is 13.8m. `linkCandidates` remains unthreaded (a genuine residual, not this slice's
 * job — see the module header). An armed run can now ground against real attendee-derived person
 * entities in principle; in practice it yields zero today (13.8g-C, module header). That is acceptable
 * only because this ships DORMANT still — mirrors `createIngestRewriteAdapter`'s own documented residual
 * in living-vault.ts.
 */
export function createMeetingVaultPort(knowledgeDeps: MeetingRewriteDeps): MeetingVaultRewritePort {
  return {
    async rewrite(
      workspaceId: WorkspaceId,
      meetingNotePath: string,
      sourceRef: SourceRef,
      provenanceOrigin: ProvenanceOrigin,
      attendees?: unknown,
    ): Promise<MeetingVaultRewriteResult> {
      // 13.8g-C (not yet decided): `normalizeAttendees` requires Array.isArray — the real meeting-
      // extraction schema gate admits only scalars, so `attendees` can never be an array in a validated
      // extraction. This call is correct and total either way; it yields empty refs today.
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
      return { meetingNoteLinkMutations: receipt.meetingNoteLinkMutations };
    },
  };
}
