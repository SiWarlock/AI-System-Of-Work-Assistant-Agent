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
// NO CONTAINMENT LAYER (unlike living-vault.ts, deliberately): `meetingNoteLinkMutations`' `srcPath` is,
// by construction, always the meeting note itself (`meeting-rewrite.ts:272`: `l.srcPath === meetingNotePath`)
// — never synthesized — and `dstSlug` is not treated as a raw filesystem path anywhere in the source-path
// precedent either (`living-vault.ts`'s own `touchedPaths()` never reads `.dstSlug`). So this narrow cut
// opens no new path-escape surface for a realpath-containment layer to close.
import { rewriteVaultForMeeting } from "@sow/knowledge";
import type { MeetingRewriteDeps } from "@sow/knowledge";
import type { WorkspaceId, SourceRef, ProvenanceOrigin } from "@sow/contracts";
import type {
  MeetingVaultRewritePort,
  MeetingVaultRewriteResult,
} from "@sow/workflows/ports/meetingCloseout";

/**
 * Adapt the real `rewriteVaultForMeeting` onto {@link MeetingVaultRewritePort}. Maps the port's minimal
 * arguments onto `MeetingRewriteInput` — `entityRefs`/`identifierOnlyRefs`/`linkCandidates` are
 * intentionally NOT threaded here (13.8f-B's own Q3: strictly faked ports this slice; deriving real
 * entity refs from correlation signals is 13.8g-B's territory), so an armed run today would synthesize
 * against NO entity candidates and mostly produce a thin or empty result. That is acceptable only
 * because this ships DORMANT — it must be completed before the capability is armed (a future follow-up),
 * mirroring `createIngestRewriteAdapter`'s own documented residual in living-vault.ts.
 */
export function createMeetingVaultPort(knowledgeDeps: MeetingRewriteDeps): MeetingVaultRewritePort {
  return {
    async rewrite(
      workspaceId: WorkspaceId,
      meetingNotePath: string,
      sourceRef: SourceRef,
      provenanceOrigin: ProvenanceOrigin,
    ): Promise<MeetingVaultRewriteResult> {
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
        },
        knowledgeDeps,
      );
      return { meetingNoteLinkMutations: receipt.meetingNoteLinkMutations };
    },
  };
}
