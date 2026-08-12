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
import type { WriteFailure } from "@sow/knowledge";

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
