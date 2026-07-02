// Task 8.6 (a) — stream reconnect catch-up (snapshot-or-replay).
//
// On reconnect the client resumes from its last-ACKNOWLEDGED event id. This
// module turns that request into an explicit, typed RESUME PLAN over the bounded
// server-side replay buffer (8.5 `eventClasses.ts`), honouring the Phase-0 API
// spike (docs/spikes/0.5-api-stream.md, "Backpressure guard"):
//
//   - the replay WINDOW is the resume HORIZON (its size is the spike's
//     `DEFAULT_REPLAY_WINDOW` cursor, tunable via `StreamPublisherOptions`);
//   - a resume whose `lastEventId` is INSIDE the window ⇒ a LOSSLESS `replay` of
//     EXACTLY the events committed during the disconnect — none silently dropped,
//     none duplicated (contiguous seqs);
//   - a resume whose `lastEventId` is OVER-HORIZON (aged out of the window) ⇒ the
//     EXPLICIT `resync` signal ("resync from snapshot"), NEVER a silently-
//     truncated partial log that would leave the UI missing committed changes.
//
// This is a thin, PURE decision layer over `publisher.resumeOrResync` — the
// horizon + over-horizon detection already live in the bounded log; this module
// names the resume contract at the reconnection seam and exposes the horizon so
// the backpressure policy (`backpressure.ts`) shares ONE coherent horizon.
//
// §16: no throw across the boundary — `planResume` returns a typed `ResumePlan`.
import type { StreamEvent } from "@sow/contracts";
import type { StreamPublisher, ResumeOutcome } from "./eventClasses";

/**
 * The plan a reconnecting client is served:
 *   - `replay`: the exact events committed AFTER `lastEventId` still retained in
 *     the bounded window (lossless gap catch-up; contiguous seqs, no dup);
 *   - `resync`: the `lastEventId` aged out of the window (over-horizon) ⇒ the
 *     client MUST resync from a snapshot — a partial log would drop committed
 *     changes silently, so we never serve one.
 */
export type ResumePlan =
  | { readonly kind: "replay"; readonly events: readonly StreamEvent[] }
  | { readonly kind: "resync" };

/**
 * The resume HORIZON for this publisher — the size of its bounded replay window
 * (the Phase-0 spike's "window size = resume horizon"). A `lastEventId` older
 * than this many events behind the head is over-horizon and resolves to
 * `resync`. Exposed so the backpressure policy can align its outbound bound to
 * the SAME horizon rather than an independent ad-hoc constant.
 */
export function resumeWindow(publisher: StreamPublisher): number {
  return publisher.replayWindow();
}

/**
 * Plan a reconnect catch-up from the client's last-acknowledged event id.
 *
 * Delegates over-horizon detection to the bounded log's `resumeOrResync`
 * (which fails closed to `resync` whenever a lossless replay cannot be proven),
 * so a committed change is NEVER silently dropped: it is either replayed in the
 * gap or the client is told to resync from a snapshot.
 */
export function planResume(
  publisher: StreamPublisher,
  lastEventId: string | undefined,
): ResumePlan {
  const outcome: ResumeOutcome = publisher.resumeOrResync(lastEventId);
  if (outcome.kind === "replay") {
    return { kind: "replay", events: outcome.events };
  }
  return { kind: "resync" };
}
