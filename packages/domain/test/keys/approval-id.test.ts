// The ONE derivation of a pending external-action approval's id. Linear slice 3, step 1.
//
// ⛔ WHY THIS EXISTS (rule 3): two derivations shipped side by side. The proof-spine gateway minted
// `approval:<idempotencyKey>` (no workspace), while the approval-flow activity and the Copilot propose
// sink minted `idem_<sha256>` over { idempotencyKey, workspace }. The gateway's `isApproved` looks a
// card up by ITS form, so a card recorded by the other form is invisible to it, and the gateway then
// records a SECOND pending card. It does not happen today only because nothing routes the Approvals
// screen through the gateway yet; slice 3 is what would route it. So the ids are unified first.
import { describe, it, expect } from "vitest";
import { approvalIdFor, buildIdempotencyKey } from "../../src/index";

describe("approvalIdFor — the single approval-id minter", () => {
  it("equals the approval-flow activity's derivation (idem_ fold over the key AND the workspace)", () => {
    const id = approvalIdFor({ idempotencyKey: "idem_abc", workspace: "employer-work" });
    expect(String(id)).toBe(
      buildIdempotencyKey({ operation: "approval.pending", identity: { idempotencyKey: "idem_abc", workspace: "employer-work" } }),
    );
  });

  it("⛔ rule 4: the same envelope key in two workspaces gives two different ids", () => {
    const a = approvalIdFor({ idempotencyKey: "idem_abc", workspace: "employer-work" });
    const b = approvalIdFor({ idempotencyKey: "idem_abc", workspace: "personal-life" });
    expect(a).not.toBe(b);
  });

  it("is replay-stable, and is never the retired `approval:<key>` form", () => {
    const once = approvalIdFor({ idempotencyKey: "idem_abc", workspace: "employer-work" });
    expect(approvalIdFor({ idempotencyKey: "idem_abc", workspace: "employer-work" })).toBe(once);
    expect(String(once).startsWith("approval:")).toBe(false);
    expect(String(once)).toMatch(/^idem_[0-9a-f]{64}$/);
  });
});
