// spec(safety rule 7 / task 24.73 §16 never-throw sweep, ROUND 2) — REDACT: close
// the rule-7 leaks in three MORE registered Temporal activities this package owns:
//   • reindexGbrain.ts        → registered `meetingReindex`
//   • buildGclProjection.ts   → registered `dailyBriefUpdateProjections` +
//     `periodReviewUpdateProjections`
//   • deterministicProgress.ts → registered `projectSyncParseProgress`
//
// THE ARCHITECTURAL FACT: registering a function as a Temporal activity turns its
// return value into durable, REPLAYED workflow history — a log sink under safety
// rule 7. All three activities here forward an INJECTED port's Result verbatim on
// failure — `deps.client.reindex()`, `deps.source.project()`, `deps.reader.read()`
// — so a raw `cause` (a provider/HTTP error carrying a URL+token, a DB driver error
// carrying a DSN, an fs error carrying an absolute vault path) rode straight
// through before this fix. Because the injected port's `message` is equally
// out-of-this-package-controlled, the fix rebuilds `message` too (mirrors
// `refreshConnectors.ts`'s `redactConnectorRefreshError`) — so both hostile
// `cause` AND hostile `message` are pinned here.
//
// Each suite drives the activity through a HOSTILE injected dependency that fails
// carrying POISON — a secret marker, a foreign-DSN marker, a REAL Node fs error
// with a stack trace + an absolute path as OWN ENUMERABLE properties, or the
// poison embedded directly in `message` — and asserts the poison is ABSENT from
// `JSON.stringify` of the WHOLE activity result, while the stable, closed `code`
// still crosses byte-identically (every workflow driver switches on it).
//
// R3 (24.73 restore round, 2026-08-27): section (A) reindexGbrain.ts is UNCHANGED —
// its redaction guards a real forwarded `WriteFailure`/DbError and is correct, kept.
// Sections (B) buildGclProjection.ts and (C) deterministicProgress.ts's
// `redact*Error` functions were DELETED — both guarded a fault path whose only
// production binding is a hardcoded fixed-literal stub (buildGclProjection.ts has
// ZERO production callers at all; deterministicProgress.ts's `projectSyncParse.reader`
// is a "WP4: activity-registration scope only" placeholder) — so the redaction
// protected nothing while costing the operator a real diagnostic. Their suites below
// are rewritten to pin the RESTORED forward instead of the deleted redaction.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { createReindexActivity } from "../src/activities/reindexGbrain";
import type { ReindexActivityDeps, GbrainReindexAck } from "../src/activities/reindexGbrain";
import type { ReindexError } from "../src/ports/meetingCloseout";
import { createBuildGclProjectionActivity } from "../src/activities/buildGclProjection";
import type { BuildGclProjectionDeps, CandidateProjection } from "../src/activities/buildGclProjection";
import type { DailyBriefContext, UpdateProjectionsError } from "../src/ports/dailyBrief";
import { createDeterministicProgressActivity } from "../src/activities/deterministicProgress";
import type {
  DeterministicProgressActivityDeps,
  RawProgressSource,
} from "../src/activities/deterministicProgress";
import type { ProjectSyncContext, ParseProgressError } from "../src/ports/projectSync";

// ---------------------------------------------------------------------------
// Shared hostile fixtures (mirrors redaction-boundary-r7.test.ts)
// ---------------------------------------------------------------------------

const SECRET_POISON = "PZN9F3A1BSECRET-leak";
const URL_TOKEN_POISON = `https://api.example.com/v1?token=${SECRET_POISON}`;
const DSN_POISON = `postgres://u:${SECRET_POISON}@h/db`;
const POISON_DIR_NAME = "sow-r7-round2-poison-does-not-exist";
const MESSAGE_POISON = `driver said: ${DSN_POISON}`;

/**
 * A REAL Node fs ENOENT error — carries an absolute path + a stack trace, and
 * (unlike a bare `new Error(...)`, whose `message`/`stack` are NON-enumerable)
 * exposes `.path`/`.code`/`.errno`/`.syscall` as OWN ENUMERABLE properties.
 */
function realFsPoison(): NodeJS.ErrnoException {
  const poisonPath = path.join(os.tmpdir(), POISON_DIR_NAME, "SECRETMARKER.md");
  try {
    fs.readFileSync(poisonPath);
    throw new Error("unreachable: poison path must not exist");
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
}

function expectNoPoison(serialized: string): void {
  expect(serialized).not.toContain(SECRET_POISON);
  expect(serialized).not.toContain(URL_TOKEN_POISON);
  expect(serialized).not.toContain(DSN_POISON);
  expect(serialized).not.toContain(POISON_DIR_NAME);
}

// ===========================================================================
// (A) reindexGbrain.ts — createReindexActivity: registered `meetingReindex`
// ===========================================================================

function makeHostileReindexDeps(error: ReindexError): ReindexActivityDeps {
  return {
    client: {
      reindex: (): Promise<Result<GbrainReindexAck, ReindexError>> => Promise.resolve(err(error)),
    },
  };
}

describe("createReindexActivity — SAFETY RULE 7: no raw cause/message crosses the registered `meetingReindex` boundary", () => {
  it("a poisoned URL+token `cause` on a reindex_failed client error never crosses — code still reindex_failed", async () => {
    const activity = createReindexActivity(
      makeHostileReindexDeps({ code: "reindex_failed", message: "boom", cause: { url: URL_TOKEN_POISON } }),
    );
    const r = await activity.reindex("rev-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("reindex_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a poisoned DSN-carrying `cause` never crosses", async () => {
    const activity = createReindexActivity(
      makeHostileReindexDeps({ code: "reindex_failed", message: "boom", cause: { dsn: DSN_POISON } }),
    );
    const r = await activity.reindex("rev-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });

  it("a REAL Node fs error as `cause` (stack + absolute path) never crosses", async () => {
    const activity = createReindexActivity(
      makeHostileReindexDeps({ code: "reindex_failed", message: "boom", cause: realFsPoison() }),
    );
    const r = await activity.reindex("rev-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });

  it("a poisoned client-authored `message` (no cause at all) never crosses either", async () => {
    const activity = createReindexActivity(
      makeHostileReindexDeps({ code: "reindex_failed", message: MESSAGE_POISON }),
    );
    const r = await activity.reindex("rev-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("reindex_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });
});

// ===========================================================================
// (B) buildGclProjection.ts — createBuildGclProjectionActivity: registered
//     `dailyBriefUpdateProjections` / `periodReviewUpdateProjections`
// ===========================================================================

const BRIEF_CTX: DailyBriefContext = { scopes: [] };

function makeHostileProjectionDeps(error: UpdateProjectionsError): BuildGclProjectionDeps {
  return {
    source: {
      project: (): Promise<Result<readonly CandidateProjection[], UpdateProjectionsError>> =>
        Promise.resolve(err(error)),
    },
    gate: {
      // never reached — the source fails before any candidate is gated.
      admit: (c) => Promise.resolve(ok({ ...c, sourceRefs: [...c.sourceRefs] })),
    },
  };
}

describe("createBuildGclProjectionActivity — R3 (24.73 restore round): the source-failure diagnostic forwards VERBATIM", () => {
  // This activity's port is DORMANT (this file's own header, restated in the R3
  // note above: zero production callers, no real ProjectionSource bound anywhere)
  // — a redaction here guarded nothing while costing the operator the real
  // diagnostic. `candidates.error` — code, message, AND cause — now forwards
  // exactly as the injected source built it. Restored for consistency with the
  // sibling gate-rejection branch, which already forwarded `decision.error.reason`
  // unredacted even before this round.
  it("forwards the source's message + cause verbatim — code still projection_stale (mutation-proof)", async () => {
    const activity = createBuildGclProjectionActivity(
      makeHostileProjectionDeps({
        code: "projection_stale",
        message: "workspace ws-1 projection stale: upstream brain read timed out after 5s",
        cause: { upstreamStatus: 504 },
      }),
    );
    const r = await activity.update(BRIEF_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("projection_stale");
      // RESTORED: a re-added redaction would replace these with a fixed literal /
      // strip cause, failing these assertions.
      expect(r.error.message).toBe("workspace ws-1 projection stale: upstream brain read timed out after 5s");
      expect(r.error.cause).toEqual({ upstreamStatus: 504 });
    }
  });
});

// ===========================================================================
// (C) deterministicProgress.ts — createDeterministicProgressActivity: registered
//     `projectSyncParseProgress`
// ===========================================================================

const SYNC_CTX: ProjectSyncContext = { projectRef: "proj-1" };

function makeHostileReaderDeps(error: ParseProgressError): DeterministicProgressActivityDeps {
  return {
    reader: {
      read: (): Promise<Result<readonly RawProgressSource[], ParseProgressError>> => Promise.resolve(err(error)),
    },
  };
}

describe("createDeterministicProgressActivity — R3 (24.73 restore round): the reader-failure diagnostic forwards VERBATIM", () => {
  // The only production-bound reader (buildActivities.ts's `projectSyncParse.reader`)
  // is a hardcoded fixed-literal stub today ("no plan/provider progress source
  // wired yet") — a redaction here guarded nothing while costing the operator the
  // real diagnostic once a real reader is wired. `read.error` — code, message, AND
  // cause — now forwards exactly as the injected reader built it.
  it("forwards the reader's message + cause verbatim — code still parse_failed (mutation-proof)", async () => {
    const activity = createDeterministicProgressActivity(
      makeHostileReaderDeps({
        code: "parse_failed",
        message: "plan doc unreadable: IMPLEMENTATION_PLAN.md checksum mismatch",
        cause: { expectedChecksum: "abc", actualChecksum: "def" },
      }),
    );
    const r = await activity.parse(SYNC_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("parse_failed");
      // RESTORED: a re-added redaction would replace these with a fixed literal /
      // strip cause, failing these assertions.
      expect(r.error.message).toBe("plan doc unreadable: IMPLEMENTATION_PLAN.md checksum mismatch");
      expect(r.error.cause).toEqual({ expectedChecksum: "abc", actualChecksum: "def" });
    }
  });

  it("connector_stale / ambiguous_status codes also forward verbatim (not just parse_failed)", async () => {
    const stale = createDeterministicProgressActivity(
      makeHostileReaderDeps({ code: "connector_stale", message: "linear-1 cursor is 9 days stale" }),
    );
    const staleRes = await stale.parse(SYNC_CTX);
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) {
      expect(staleRes.error.code).toBe("connector_stale");
      expect(staleRes.error.message).toBe("linear-1 cursor is 9 days stale");
    }

    const ambiguous = createDeterministicProgressActivity(
      makeHostileReaderDeps({ code: "ambiguous_status", message: "unrecognized checkbox marker in plan.md" }),
    );
    const ambiguousRes = await ambiguous.parse(SYNC_CTX);
    expect(ambiguousRes.ok).toBe(false);
    if (!ambiguousRes.ok) {
      expect(ambiguousRes.error.code).toBe("ambiguous_status");
      expect(ambiguousRes.error.message).toBe("unrecognized checkbox marker in plan.md");
    }
  });
});
