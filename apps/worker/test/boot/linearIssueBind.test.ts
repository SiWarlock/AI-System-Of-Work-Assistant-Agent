// bootWorker binds the Linear issue FORM's port (Linear slice 5a, part 3) — pinned on boot's own source, the idiom
// externalApprovalDispatchBind.test.ts uses (a full boot needs a live port). The port's behaviour for each input is
// pinned in test/composition/linearIssue.test.ts.
//
// ⛔ WHAT THIS GUARDS (owner decision 2026-09-25): the team list is read from Linear ONLY while Linear writes are on.
// The port must therefore be bound with the backends' own arming and the gate's own lister — never a lister built from
// boot's Keychain accessor, which exists whatever the switch says and would read the key with writes off.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOT = readFileSync(join(__dirname, "..", "..", "src", "boot.ts"), "utf8");

function block(): string {
  const start = BOOT.indexOf("createLinearIssuePort({");
  expect(start).toBeGreaterThan(-1); // positive control: the binding exists
  return BOOT.slice(start, BOOT.indexOf("\n  });", start));
}

describe("bootWorker's Linear issue form binding", () => {
  it("⛔ is bound with per-workspace arming and the GATE's lister — never one built from the Keychain accessor", () => {
    const b = block();
    expect(b).toContain("armedFor: backends.armedFor,");
    expect(b).toContain("listLinearTeams: backends.listLinearTeams,");
    for (const forbidden of ["keychainSecrets", "toWriteSecretsAccessor", "createLinearTeamsReader"]) expect(b).not.toContain(forbidden);
  });

  it("records the owner's form as the card's actor — never the Copilot's", () => {
    const b = block();
    expect(b).toContain("createApprovalsProposeSink({");
    expect(b).toContain("actor: LINEAR_FORM_ACTOR,");
    expect(b).toContain("outbox: backends.repos.outbox,"); // the saved action + envelope the approval later sends
  });

  it("reaches the API server", () => {
    const api = BOOT.slice(BOOT.indexOf("const api = await startApiServer({"));
    expect(api.slice(0, api.indexOf("\n  });"))).toContain("    linearIssue,\n");
  });
});
