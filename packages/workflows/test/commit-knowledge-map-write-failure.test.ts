// spec(§16) — task 24.23: `mapWriteFailure` (commitKnowledge.ts) is the ORIGIN
// instance of the L134 chain (24.23 → 24.30 → 24.36 → 24.38, closing last). A
// `default:` branch over the closed `WriteFailure.code` union silently absorbed
// `workspace_path_violation` (task 24.12) into `commit_failed`, so a workspace-scope
// rejection reported as a generic commit failure at the workflows boundary.
//
// SEVERITY, stated precisely because the compressed version is false: the WRITE IS
// STILL REJECTED (24.12's guard holds regardless of this bug) — only the REASON
// crossing the workflows boundary was lost. Guarantee holds, detection degraded.
import { describe, expect, it } from "vitest";
import { mapWriteFailure } from "../src/activities/commitKnowledge";
import type { WriteFailure, WriteSuccess } from "@sow/knowledge";

describe("24.23 — mapWriteFailure is exhaustive over WriteFailure.code", () => {
  it("workspace_path_violation_surfaces_as_itself — not flattened to commit_failed", () => {
    const failure: WriteFailure = {
      code: "workspace_path_violation",
      path: "sources/other-workspace/leaked.md",
    };
    expect(mapWriteFailure(failure)).toBe("workspace_path_violation");
  });

  it("existing_failure_codes_map_unchanged — regression pin, every pre-existing mapping is byte-identical", () => {
    const schemaRejected: WriteFailure = {
      code: "schema_rejected",
      stage: "zod",
      issues: [],
    };
    expect(mapWriteFailure(schemaRejected)).toBe("schema_rejected");

    const writeConflict: WriteFailure = {
      code: "write_conflict",
      expectedBaseRevision: "rev-a",
      onDiskRevision: "rev-b",
    };
    expect(mapWriteFailure(writeConflict)).toBe("write_conflict");

    const ownershipViolation: WriteFailure = {
      code: "ownership_violation",
      path: "sources/personal-business/note.md",
    };
    expect(mapWriteFailure(ownershipViolation)).toBe("ownership_violation");

    const secretFound: WriteFailure = {
      code: "secret_found",
      path: "sources/personal-business/note.md",
    };
    expect(mapWriteFailure(secretFound)).toBe("secret_found");

    const commitFailed: WriteFailure = {
      code: "commit_failed",
      path: "sources/personal-business/note.md",
      cause: new Error("disk full"),
    };
    expect(mapWriteFailure(commitFailed)).toBe("commit_failed");
  });
});

// spec(§16) — task 24.72 Leg B (consumer leg). Leg A widened `WriteFailure` with the two
// POST-COMMIT infrastructure faults: `audit_record_failed` / `revision_record_failed`. They are the
// ONLY members describing a state in which the Markdown write SUCCEEDED — every other member means
// nothing was committed — which is why each carries the `revisionId` that IS durable.
//
// ⛔ THE DISTINCTION MUST SURVIVE THE PORT. Collapsing either onto an existing code is the same
// absorption an exhaustive mapper exists to prevent, performed deliberately in a `case` instead of
// accidentally in a `default` (`contracts L134`'s origin instance is this very function). Task 24.58
// measured the downstream cost: `healthItemDedupeKey` is `${failureClass}|${subjectRef}`, so a
// collapse at the CODE layer propagates into dedupe-key collapse, where an acknowledged benign item
// can absorb a later critical one.
describe("24.72 Leg B — the two POST-COMMIT record faults survive the port distinctly", () => {
  it("audit_record_failed_surfaces_as_itself — never flattened onto commit_failed", () => {
    // Only `revisionId`'s BRAND is cast — the fixture stays typed as `WriteFailure` so a rename or
    // reshape of `AuditRecordFailed` reds here. An `as unknown as` on the whole object would
    // disconnect it from the member and degrade this to a string-in/string-out check.
    const failure: WriteFailure = {
      code: "audit_record_failed",
      revisionId: "rev-durable-1" as WriteSuccess["revisionId"],
      cause: new Error("audit sink unreachable"),
    };
    expect(mapWriteFailure(failure)).toBe("audit_record_failed");
  });

  it("revision_record_failed_surfaces_as_itself — never flattened onto commit_failed", () => {
    const failure: WriteFailure = {
      code: "revision_record_failed",
      revisionId: "rev-durable-2" as WriteSuccess["revisionId"],
      cause: new Error("revision store unreachable"),
    };
    expect(mapWriteFailure(failure)).toBe("revision_record_failed");
  });

  it("the_two_record_faults_are_DISTINCT_from_each_other_and_from_commit_failed", () => {
    // ⚠ HONEST SCOPE, corrected after review: this assertion is REDUNDANT, not discriminating. An
    // earlier comment here claimed "a mapper that collapsed any pair would pass both single-code
    // tests above" — FALSE: collapsing the pair onto either label fails the other single-code test
    // outright, and `commit_failed` is already pinned above. Distinctness is ENTAILED by tests that
    // already exist. Kept as a cheap belt that states the property directly, NOT as coverage —
    // claiming discriminating power it does not have would be this file's own defect (it is
    // `contracts L134`'s origin instance) committed in the comment instead of the code.
    const auditFailed: WriteFailure = {
      code: "audit_record_failed",
      revisionId: "rev-x" as WriteSuccess["revisionId"],
      cause: undefined,
    };
    const revisionFailed: WriteFailure = {
      code: "revision_record_failed",
      revisionId: "rev-x" as WriteSuccess["revisionId"],
      cause: undefined,
    };
    const commitFailed: WriteFailure = {
      code: "commit_failed",
      path: "sources/personal-business/note.md",
      cause: undefined,
    };

    const mapped = [
      mapWriteFailure(auditFailed),
      mapWriteFailure(revisionFailed),
      mapWriteFailure(commitFailed),
    ];
    expect(new Set(mapped).size).toBe(3);
  });
});
