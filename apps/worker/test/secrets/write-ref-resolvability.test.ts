// ⛔⛔ THE GUARD THAT WAS MISSING, AND ITS ABSENCE COST A SHIPPED DEFECT THE SAME DAY.
//
// `writeSecretRef` (@sow/integrations) COMPOSES the external-write credential ref.
// `parseKeychainRef` (this package) is what actually RESOLVES it at runtime. They live in different
// packages, and NOTHING checked that a ref one produces is a ref the other accepts.
//
// ⭐⭐ WHY EVERY OTHER TEST MISSED IT — the transferable part. The credential-seam suites all inject a
// FAKE `WriteSecretsAccessor` (`getSecret: async () => ok("faketoken")`) which returns a token for ANY
// string. So they proved the ref was DERIVED correctly, THREADED correctly, and PASSED to the accessor
// correctly — and could not observe that the resulting string is unresolvable. ⇒ **a green end-to-end
// test over a fake boundary measures the plumbing, never the contract at the far side of it.**
//
// This is the `contracts L118` proxy shape once more: "the accessor was called with the right ref" is a
// proxy for "the credential resolves", and it is right until the ref format itself is wrong.
//
// ⛔ THE CONSTRAINT, measured not assumed: `parseKeychainRef` requires EXACTLY TWO `/`-separated
// segments, each matching /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/ — so it bars `*`, bars a third segment, and
// bars a leading `-`. A ref that fails it returns `null` and the resolver FAILS CLOSED with no backend
// call, which is safe but silent: the write simply never authenticates.
import { describe, it, expect } from "vitest";
import { writeSecretRef } from "@sow/integrations";
import { parseKeychainRef } from "../../src/secrets/keychain-adapter";

const TARGETS = ["asana", "calendar", "todoist", "linear", "drive", "github", "telegram"] as const;
// Real workspace ids from the live store — `-` inside the id is the interesting case, since the
// composed service segment also uses `-`.
const WORKSPACES = ["personal-business", "employer-work", "personal-life"] as const;

describe("every composed write-credential ref must PARSE with the resolver's own parser", () => {
  it("control: a known-good ref parses, so the instrument is not simply returning null for everything", () => {
    // ⚠ POSITIVE CONTROL FIRST. Without it, a parser that rejected every input would make the whole
    // suite below fail in a way that looks like a composition bug rather than a broken instrument.
    const control = parseKeychainRef("keychain://sow/kw-signing");
    expect(control).not.toBeNull();
    expect(control?.service).toBe("sow");
    expect(control?.account).toBe("kw-signing");
  });

  it("⛔ EVERY (target × workspace) ref resolves to a real (service, account) pair", () => {
    const unparseable: string[] = [];
    for (const t of TARGETS) {
      for (const w of WORKSPACES) {
        const ref = writeSecretRef(t, w);
        if (parseKeychainRef(ref) === null) unparseable.push(ref);
      }
    }
    expect(unparseable).toEqual([]);
    // Non-vacuity: the loop must actually have run the full cross-product.
    expect(TARGETS.length * WORKSPACES.length).toBe(21);
  });

  it("the workspace and the vendor land in DIFFERENT parsed fields — scoping survives the parse", () => {
    // Scoping that exists only in the composed string but collapses at the parse would give two
    // workspaces the same (service, account) pair and therefore the same Keychain item — the exact
    // isolation bug this scoping was introduced to fix, reintroduced one layer down.
    const personal = parseKeychainRef(writeSecretRef("linear", "personal-business"));
    const employer = parseKeychainRef(writeSecretRef("linear", "employer-work"));
    expect(personal).not.toBeNull();
    expect(employer).not.toBeNull();
    expect([personal?.service, personal?.account]).not.toEqual([employer?.service, employer?.account]);
  });
});
