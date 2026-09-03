// ⛔⛔ SAFETY RULE 4 (workspace isolation) at the EXTERNAL-WRITE CREDENTIAL SEAM.
//
// THE DEFECT, found 2026-09-03 when the owner asked a product question — *"my Linear connection is
// going to be different in my personal workspace than my employer one"* — and the honest answer
// turned out to be that it could not be:
//
//     writeSecretRef("linear")  =>  "keychain://connector-write/linear"      // NO WORKSPACE
//
// The derivation keyed on the VENDOR ALONE, so `personal-business` and `employer-work` resolved
// THE SAME Keychain item. Two workspaces the whole system keeps apart everywhere else shared one
// external-write credential.
//
// ⭐⭐ AND THE WORKSPACE WAS NEVER MISSING — IT WAS DROPPED. This is the part worth carrying:
//   • `copilotPropose.ts:208` carries `workspaceId` as a *SERVER-BOUND* branded `WorkspaceId`,
//     with a comment naming safety rule 4 as the reason it must be server-bound.
//   • the `outbox` table persists `workspaceId text NOT NULL` — verified in the live sow.db.
// So the identity is proven at the top of the path and persisted at the bottom. It was dropped in
// exactly one in-memory hop: the Tool Gateway never handed it to the credential resolver.
// ⇒ this is not "introduce a workspace concept", it is "stop discarding one".
//
// ⭐ WHY `DispatchOptions` AND NOT THE ENVELOPE — the codebase's OWN precedent, not a new idea.
// `DispatchOptions.intentCreatedAt` documents it verbatim: `ExternalWriteEnvelope` is a FROZEN
// contract, amending it means re-cutting its schema snapshot, so a fact the dispatch needs but the
// envelope cannot hold "travels BESIDE the envelope rather than inside it". Same shape, same reason.
// (Measured: 93 files reference the envelope. That is the blast radius avoided.)
//
// ⛔ FAIL CLOSED, and this is what makes an OPTIONAL field safe. `workspaceId` is optional in the
// TYPE (so the ~186 existing dispatch sites still compile), but when the credential seam is ARMED
// and no workspace is supplied there is NO CREDENTIAL and therefore NO WRITE. Absence cannot yield
// an unscoped token. ⇒ you cannot obtain a write credential without naming a workspace, which is
// the property, expressed so that forgetting it fails rather than silently shares.
import { describe, it, expect, vi } from "vitest";
import { writeSecretRef } from "../src/tools/adapters/adapter-core";

describe("writeSecretRef — the credential ref is SCOPED BY WORKSPACE (safety rule 4)", () => {
  it("derives connector-write/<workspace>/<vendor> — the workspace is IN the key", () => {
    expect(writeSecretRef("linear", "personal-business")).toBe(
      "keychain://connector-write.personal-business/linear",
    );
    expect(writeSecretRef("todoist", "personal-life")).toBe(
      "keychain://connector-write.personal-life/todoist",
    );
    expect(writeSecretRef("drive", "employer-work")).toBe(
      "keychain://connector-write.employer-work/drive",
    );
  });

  it("⛔ THE CENTRAL CASE — the same vendor in two workspaces resolves TWO DIFFERENT refs", () => {
    // This is the owner's exact scenario and the one the old derivation got wrong.
    const personal = writeSecretRef("linear", "personal-business");
    const employer = writeSecretRef("linear", "employer-work");
    expect(personal).not.toBe(employer);
    // ⚠ And neither may be a PREFIX of the other — a prefix relation is how a scoped-lookup
    // implementation later "helpfully" falls back across the boundary (the sibling-prefix family
    // desktop L16 hit with `/vault` vs `/vault-evil`). Assert the separation structurally.
    expect(personal.startsWith(employer)).toBe(false);
    expect(employer.startsWith(personal)).toBe(false);
  });

  it("scopes the telegram bot ref too — the account wildcard stays, the workspace leads it", () => {
    // telegram's account is bound at §ARM-21, hence the `*`. The WORKSPACE is not the account, so
    // scoping it is orthogonal to that arming and must not wait for it.
    expect(writeSecretRef("telegram", "personal-life")).toBe("keychain://telegram-bot.personal-life/bot");
    expect(writeSecretRef("telegram", "employer-work")).toBe("keychain://telegram-bot.employer-work/bot");
  });

  it("⛔ never emits an UNSCOPED ref for any target in the closed set", () => {
    // Non-vacuity: enumerate the whole TargetSystem set rather than spot-checking, so a target
    // added later without a workspace segment cannot slip through this suite.
    const targets = ["asana", "calendar", "todoist", "linear", "drive", "github", "telegram"] as const;
    for (const t of targets) {
      const ref = writeSecretRef(t, "employer-work");
      expect(ref, `${t} must carry the workspace`).toContain("employer-work");
      expect(ref, `${t} must not be the legacy unscoped ref`).not.toBe(`keychain://connector-write/${t}`);
      // ⛔ AND IT MUST STILL PARSE. The first cut of this scoping put the workspace in a THIRD path
      // segment, which the resolver's two-segment parser rejects — every ref failed closed, silently,
      // and this suite was green throughout because it only compared strings. Two segments, checked
      // structurally here; the cross-package guard lives in
      // `apps/worker/test/secrets/write-ref-resolvability.test.ts`.
      expect(ref.slice("keychain://".length).split("/"), `${t} must be exactly 2 segments`).toHaveLength(2);
    }
    // Positive control on the loop itself — if `targets` were empty the assertions above would
    // vacuously pass and this suite would be green while checking nothing (`contracts L90`).
    expect(targets.length).toBe(7);
  });

  it("is PURE — no I/O, no secret, same input same output", () => {
    const spy = vi.fn(writeSecretRef);
    expect(spy("linear", "personal-business")).toBe(spy("linear", "personal-business"));
  });
});
