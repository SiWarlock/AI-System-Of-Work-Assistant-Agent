// Mirror-parity guard for the credential-ref parser.
//
// `main/credential-provision.ts` cannot RUNTIME-import `@sow/worker` (desktop L17 — it stays
// externalized in the main bundle, so the specifier would resolve to raw `.ts` and crash at load).
// So its `parseCredentialRef` is a MIRROR of the worker's `parseKeychainRef`, and drift is caught
// here instead: this TEST file is never bundled, so it imports the canonical parser directly and
// asserts the two agree BOTH WAYS. Same shape as `dotenv-shadowing-parity.test.ts`.
//
// ⛔⛔ WHY THIS MATTERS MORE THAN A TYPICAL MIRROR. The two parsers sit on OPPOSITE SIDES of one
// credential: desktop's decides what may be WRITTEN, the worker's decides what may be READ. Drift is
// not a cosmetic inconsistency — it is a silent, permanent split:
//   • desktop ACCEPTS what the worker REJECTS ⇒ the credential is stored somewhere nothing can ever
//     read. The write reports success. The failure surfaces later as an unauthenticated vendor call.
//   • desktop REJECTS what the worker ACCEPTS ⇒ a legitimate ref cannot be provisioned in-app at all.
// The first is the dangerous direction, because it FAILS QUIETLY IN THE REASSURING DIRECTION — the
// user sees a green tick and believes the connector is configured.
// ⚠ A drifted CHARSET is worse still: this parser is the ref-injection guard in front of a
// `security(1)` exec, so a loosened mirror re-opens a boundary the original closed.
import { describe, it, expect } from "vitest";
import { parseKeychainRef } from "@sow/worker/secrets/keychain-adapter";
import { parseCredentialRef } from "../../main/credential-provision";

// A corpus spanning BOTH verdicts. A parity suite over only-valid inputs would pass against a mirror
// that accepts everything, which is the drift most likely to actually happen.
const CORPUS: readonly string[] = [
  // — expected VALID —
  "keychain://sow/kw-signing",
  "keychain://connector-write.personal-business/linear",
  "keychain://connector-write.employer-work/todoist",
  "keychain://connector-write.personal-life/drive",
  "keychain://telegram-bot.personal-business/bot",
  "keychain://providers/anthropic",
  "keychain://embeddings/voyage",
  "keychain://a/b",
  "keychain://com.sow.thing/account_1",
  "keychain://_leading.underscore/x",
  // — expected INVALID —
  "keychain://a/b/c", // three segments (the defect that shipped in 8ec9685f)
  "keychain://only-one",
  "keychain:///empty-service",
  "keychain://svc/", // empty account
  "keychain://./x",
  "keychain://../x",
  "keychain://x/..",
  "keychain://-leading/dash", // would reach `security` as a CLI OPTION
  "keychain://svc/-dash",
  "keychain://a b/c", // whitespace
  "keychain://a\tb/c",
  "keychain://a;rm -rf //c", // shell metacharacters
  "keychain://a/*", // outside the segment charset
  "keychain://a/b$c",
  "keychain://a/b`c`",
  "keychain://a|b/c",
  "https://evil/x", // wrong scheme
  "keychain:/a/b",
  "",
  "keychain://",
  `keychain://${"x".repeat(600)}/y`, // over the length bound
  `keychain://${"x".repeat(250)}/${"y".repeat(250)}`, // just under it
];

describe("credential-ref parser parity — the desktop mirror vs the worker's canonical parser", () => {
  it("agrees on the VERDICT for every ref in the corpus, both directions", () => {
    const disagreements = CORPUS.filter(
      (ref) => (parseCredentialRef(ref) === null) !== (parseKeychainRef(ref) === null),
    );
    expect(disagreements).toEqual([]);
  });

  it("agrees on the PARSED SERVICE AND ACCOUNT, not merely on accept/reject", () => {
    // Verdict parity alone would miss a mirror that splits `a.b/c` differently — which would write
    // the credential under a service the reader never looks up.
    for (const ref of CORPUS) {
      expect(parseCredentialRef(ref), ref).toEqual(parseKeychainRef(ref));
    }
  });

  it("the corpus is NON-VACUOUS — it contains both accepted and rejected refs", () => {
    // ⚠ Without this, a corpus that drifted to all-invalid would make both suites above pass while
    // proving nothing about the accepting half of the parser (`contracts L90`).
    const accepted = CORPUS.filter((r) => parseKeychainRef(r) !== null);
    const rejected = CORPUS.filter((r) => parseKeychainRef(r) === null);
    expect(accepted.length).toBeGreaterThanOrEqual(10);
    expect(rejected.length).toBeGreaterThanOrEqual(15);
  });
});
