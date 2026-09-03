// ⛔⛔ THE TWO ENDS OF ONE CREDENTIAL MUST AGREE ON ITS NAME.
//
// The Connectors surface decides where a pasted key is WRITTEN (`connectorCredentialRef`). The Tool
// Gateway decides where the write path LOOKS for it (`writeSecretRef`). They live in different
// packages and the renderer deliberately does not depend on `@sow/integrations` at runtime, so the
// derivation is a MIRROR — and a mirror between two ends of a credential is the highest-consequence
// kind there is:
//
//   • drift ⇒ the key is stored at a ref nothing reads. THE UI REPORTS SUCCESS. The user believes the
//     connector is configured, and the failure surfaces much later as an unauthenticated vendor call
//     with no obvious link back to the field they filled in.
//
// ⭐ THIS EXACT CLASS ALREADY BIT, ON THIS FEATURE, ON 2026-09-03: the first workspace-scoped ref used
// a THIRD path segment, the resolver's parser takes exactly two, and nothing compared the composed
// string against the parser that had to accept it — so all 21 refs failed closed, silently, with a
// fully green suite. String agreement ACROSS a package boundary is never self-evident. Assert it.
import { describe, it, expect } from "vitest";
import { writeSecretRef } from "@sow/integrations";
import { connectorCredentialRef, isWriteTarget } from "../../renderer/lib/connector-credential-ref";
import { KNOWN_CONNECTORS } from "../../renderer/lib/connector-catalog";

const WORKSPACES = ["personal-business", "employer-work", "personal-life"] as const;

describe("connectorCredentialRef parity — the UI writes where the gateway reads", () => {
  it("⛔ matches writeSecretRef BYTE-FOR-BYTE for every write-target connector × workspace", () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const c of KNOWN_CONNECTORS) {
      if (!isWriteTarget(c)) continue;
      for (const w of WORKSPACES) {
        compared += 1;
        const ui = connectorCredentialRef(w, c);
        const gateway = writeSecretRef(c as Parameters<typeof writeSecretRef>[0], w);
        if (ui !== gateway) mismatches.push(`${c}@${w}: ui=${ui} gateway=${gateway}`);
      }
    }
    expect(mismatches).toEqual([]);
    // ⚠ NON-VACUITY. If `isWriteTarget` ever returned false for everything — a plausible refactor
    // slip — the loop would compare NOTHING and this suite would pass while guarding nothing
    // (`contracts L90`). Six write targets across three workspaces.
    expect(compared).toBe(18);
  });

  it("names the read-only connectors honestly — granola and gmail are NOT write targets", () => {
    // Not pedantry: the surface uses this to avoid implying a write capability that does not exist,
    // and a key stored for one of these is a slot the write path will never consult.
    expect(isWriteTarget("granola")).toBe(false);
    expect(isWriteTarget("gmail")).toBe(false);
    expect(isWriteTarget("linear")).toBe(true);
    expect(isWriteTarget("todoist")).toBe(true);
  });

  it("two workspaces never share a ref for the same vendor (safety rule 4, at the UI end)", () => {
    const personal = connectorCredentialRef("personal-business", "linear");
    const employer = connectorCredentialRef("employer-work", "linear");
    expect(personal).not.toBe(employer);
    expect(personal.startsWith(employer)).toBe(false);
    expect(employer.startsWith(personal)).toBe(false);
  });
});
