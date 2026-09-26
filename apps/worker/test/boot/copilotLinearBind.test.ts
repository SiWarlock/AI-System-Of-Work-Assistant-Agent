// bootWorker binds the Copilot's Linear filing path (Linear slice 5b.3b) — pinned on boot's own source, the idiom the
// other boot binding tests use (a full boot needs a live port). The handler's behaviour is pinned in
// test/api/procedures/copilotLinearPropose.test.ts; the runner's registration in copilotAgentSynthesis.test.ts.
//
// ⛔ WHAT THIS GUARDS: the Linear path must use the backends' own arming, team reader and people reader (built only in
// the armed branch — no Linear call while writes are off), and its sink must record the `copilot-linear` actor, which
// is what lets the card show the worker-resolved team, assignee and due date. It stays DORMANT: propose is behind the
// whole propose arc (gateProposeArming + copilotProposeMode + content trust).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOT = readFileSync(join(__dirname, "..", "..", "src", "boot.ts"), "utf8");

function block(): string {
  const start = BOOT.indexOf("const linearProposeDeps = {");
  expect(start).toBeGreaterThan(-1); // positive control: the binding exists
  return BOOT.slice(start, BOOT.indexOf("\n          };", start));
}

describe("bootWorker's Copilot Linear filing binding", () => {
  it("⛔ uses the backends' arming, team reader and people reader — never a reader built from the Keychain accessor", () => {
    const b = block();
    expect(b).toContain("armedFor: backends.armedFor,");
    expect(b).toContain("listLinearTeams: backends.listLinearTeams,");
    expect(b).toContain("linearPeople: backends.linearPeople,");
    for (const forbidden of ["keychainSecrets", "toWriteSecretsAccessor", "createLinearTeamsReader", "createLinearPeopleReader"]) {
      expect(b).not.toContain(forbidden);
    }
  });

  it("records the copilot-linear actor (so the card shows the resolved team, assignee and due date)", () => {
    const b = block();
    expect(b).toContain("actor: LINEAR_COPILOT_ACTOR,");
    expect(b).toContain("outbox: backends.repos.outbox,");
  });

  it("is handed to the agent runner beside the propose sink", () => {
    expect(BOOT).toMatch(/proposeSink,\s*\n\s*buildProposeMcpServer: createCopilotProposeMcpServer,\s*\n\s*linearProposeDeps,/);
  });
});
