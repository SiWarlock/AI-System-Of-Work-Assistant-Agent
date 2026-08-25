// Task 24.97 leg (b) — pin the workspace-read-gate's fail-closed disposition by test. This
// file did not exist before this slice; the falsified "ONLY path is an out-of-band edit"
// comment at `workspace-read-gate.ts:5-18` survived specifically BECAUSE there was no test
// forcing anyone to re-derive the threat model against the current code. See that file's
// rewritten docblock for the two-population account (out-of-band corruption vs. a pre-brand
// legacy row) this test file pins.
//
// NOT a red-green TDD cycle for new logic: `parseStoredWorkspace`/`parseStoredWorkspaceList`
// already re-validate every stored row against the full `WorkspaceSchema` (task 9.36) and
// already fail closed — that behavior predates this slice and is UNCHANGED here. What this
// slice adds is the missing test coverage (this file) and a corrected threat-model comment.
// So most cases below are expected to PASS the moment they are written, against the
// pre-existing implementation — that is reported honestly rather than dressed up as a
// red-first cycle it is not. Each case is proven load-bearing separately (see the mutation
// log in the implementer's final report) rather than trusted on inspection alone.
import { describe, expect, it } from "vitest";
import { isErr, isOk, validWorkspace } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { parseStoredWorkspace, parseStoredWorkspaceList } from "../../src/adapters/workspace-read-gate";

/**
 * Build a stored-row-shaped plain object from `validWorkspace`, with `id` and BOTH nested
 * `workspaceId`s set to the same value — i.e. referentially CONSISTENT, so the only possible
 * violation is the id's own SHAPE. Returns `unknown` (matching `parseStoredWorkspace`'s
 * parameter) rather than `Workspace`, deliberately: a legacy-shaped id could never satisfy
 * `WorkspaceIdSchema`, so building it as a typed `Workspace` would require a brand cast the
 * caller doesn't need — `parseStoredWorkspace` accepts an untrusted, unbranded stored row.
 */
function legacyShapedRow(id: string): unknown {
  return {
    ...validWorkspace,
    id,
    egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: id },
    providerMatrix: { ...validWorkspace.providerMatrix, workspaceId: id },
  };
}

describe("parseStoredWorkspace", () => {
  it("POSITIVE CONTROL: a conforming row parses ok with the referential pin intact — every negative case below is meaningless if this fails", () => {
    const result = parseStoredWorkspace(validWorkspace);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) throw new Error("unreachable — asserted above");
    expect(result.value).toEqual(validWorkspace);
    expect(result.value.id).toBe(result.value.egressPolicy.workspaceId);
    expect(result.value.id).toBe(result.value.providerMatrix.workspaceId);
  });

  describe("legacy-shape rows (pre-brand ids that were never out-of-band edits)", () => {
    it("rejects an uppercase id — `WorkspaceIdSchema`'s regex is lowercase-only", () => {
      const result = parseStoredWorkspace(legacyShapedRow("WS-LEGACY"));
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("unreachable — asserted above");
      expect(result.error.code).toBe("stored_row_schema_violation");
      // Not coerced/normalised: a rejected row carries no `.value` at all — the branch above
      // narrows `result` to `Err`, so there is no coerced workspace to inspect, by construction.
      expect("value" in result).toBe(false);
    });

    it("rejects an id containing an underscore — the regex allows only `[a-z0-9-]`", () => {
      const result = parseStoredWorkspace(legacyShapedRow("ws_legacy_001"));
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("unreachable — asserted above");
      expect(result.error.code).toBe("stored_row_schema_violation");
      expect("value" in result).toBe(false);
    });

    it("rejects an id over 64 characters — otherwise-conforming shape, length alone violates", () => {
      const longId = "a".repeat(65);
      const result = parseStoredWorkspace(legacyShapedRow(longId));
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("unreachable — asserted above");
      expect(result.error.code).toBe("stored_row_schema_violation");
      expect("value" in result).toBe(false);
    });
  });

  it("FOREIGN NESTED ID: id valid, egressPolicy.workspaceId points at a different (also validly-shaped) workspace — the original motivating case", () => {
    const foreign = {
      ...validWorkspace,
      id: "ws-001" as WorkspaceId,
      egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: "ws-002" as WorkspaceId },
      // providerMatrix left consistent with `id` — isolates the violation to the one field.
    };
    const result = parseStoredWorkspace(foreign);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) throw new Error("unreachable — asserted above");
    expect(result.error.code).toBe("stored_row_schema_violation");
  });

  it("OPACITY: the raw ZodError stays confined to `cause`; `message` is a fixed, generic string carrying no field values from the row (safety rule 7)", () => {
    // Uppercase AWS-access-key-shaped id: fails `WorkspaceIdSchema`'s lowercase-only regex
    // (so this genuinely exercises the legacy-shape rejection path), and is credential-shaped
    // on its face — exactly the kind of value rule 7 says must never reach a message.
    const credentialShapedId = "AKIAIOSFODNN7EXAMPLE";
    const result = parseStoredWorkspace(legacyShapedRow(credentialShapedId));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) throw new Error("unreachable — asserted above");
    // Duck-typed rather than `instanceof ZodError`: packages/db does not (and per this
    // package's territory, should not) take a direct `zod` dependency just for this check —
    // `@sow/contracts` is the only place that owns the Zod schema itself.
    expect(result.error.cause).toBeTruthy();
    expect(Array.isArray((result.error.cause as { issues?: unknown }).issues)).toBe(true);
    expect(result.error.message).toBe(
      "stored workspace row failed re-validation at the repository read boundary",
    );
    expect(result.error.message).not.toContain(credentialShapedId);
  });

  it("GET-BEFORE-UPSERT STRANDING: a legacy-shape row STRANDS a get-before-upsert caller — the read fails closed, so no revoke can be written over it", () => {
    // Models `apps/worker/src/composition/egressRevoke.ts`'s `revokeEgressAck` (another
    // agent's territory — not edited here): its step (1) is a get-before-upsert whose GET
    // reads a stored workspace row through exactly this gate before it will upsert the
    // fail-safe OFF posture. A legacy-shaped row makes that GET return `err`
    // (`stored_row_schema_violation`), so `revokeEgressAck` returns early and NEVER reaches
    // its upsert — the emergency egress-off control cannot be exercised for that workspace.
    // This is the ACCEPTED consequence of the fail-closed decision (workspace-read-gate.ts's
    // rewritten docblock), remediable only by task 24.106 (open, owner-deprioritised on a
    // zero-occurrence measurement). This test does NOT claim readability is restored — only
    // that the read half of the sequence fails closed, which is what strands the caller.
    const result = parseStoredWorkspace(legacyShapedRow("ws_stranded_legacy"));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) throw new Error("unreachable — asserted above");
    expect(result.error.code).toBe("stored_row_schema_violation");
  });
});

describe("parseStoredWorkspaceList", () => {
  it("all-conforming rows parse ok, in order", () => {
    const second = {
      ...validWorkspace,
      id: "ws-002" as WorkspaceId,
      egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: "ws-002" as WorkspaceId },
      providerMatrix: { ...validWorkspace.providerMatrix, workspaceId: "ws-002" as WorkspaceId },
    };
    const result = parseStoredWorkspaceList([validWorkspace, second]);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) throw new Error("unreachable — asserted above");
    expect(result.value.map((w) => w.id)).toEqual(["ws-001", "ws-002"]);
  });

  it("REJECTS THE WHOLE CALL on the first legacy-shape row, not merely the bad row — existing rationale (no per-row drop, no silent undercount)", () => {
    const result = parseStoredWorkspaceList([validWorkspace, legacyShapedRow("WS-LEGACY")]);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) throw new Error("unreachable — asserted above");
    expect(result.error.code).toBe("stored_row_schema_violation");
  });
});
