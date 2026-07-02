// spec(§16, safety rule 7) — the canonical PURE domain redactor (task 10.1).
//
// Tests the three chokepoint primitives against a secret-fixture corpus:
//   (a) redactString  — credential-scrub + fail-safe drop.
//   (b) redactRecord  — field-level ALLOWLIST classifier: an unrecognized field
//       defaults to REDACTED (never passed through); output is structurally stable.
//   (c) redactError   — strips a secret/prompt/raw embedded in an Error's
//       message / stack / cause chain, exposing only a typed cause code.
//
// The domain layer is the single source of truth; providers depend on it.
import { describe, it, expect } from "vitest";
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "@sow/contracts";
import {
  redactString,
  isRedactionSafe,
  redactRecord,
  redactError,
  SAFE_FIELD_ALLOWLIST,
} from "../../src/redaction/redact";

// ── secret-fixture corpus ────────────────────────────────────────────────────
const CREDENTIAL_FIXTURES: readonly string[] = [
  "sk-Abc123Def456Ghi789Jkl", // OpenAI-style
  "sk_live_0123456789abcdefghij", // Stripe live
  "xoxb-123456789012-abcdefghijkl", // Slack bot
  "ghp_0123456789abcdef0123456789abcdef0123", // GitHub PAT
  "AKIA0123456789ABCDEF", // AWS access key id
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SIGNpartHere", // JWT
];

describe("redactString — credential-shaped scrubbing (moved from providers)", () => {
  it("scrubs each credential token and yields a redaction-safe string", () => {
    for (const secret of CREDENTIAL_FIXTURES) {
      const out = redactString(`call failed token=${secret} tail`);
      expect(out).not.toContain(secret);
      expect(isRedactionSafe(out)).toBe(true);
    }
  });

  it("uses the frozen REDACTED_CREDENTIAL marker for an in-line credential", () => {
    const out = redactString("key sk-Abc123Def456Ghi789Jkl here");
    expect(out).toContain(REDACTED_CREDENTIAL);
    expect(out).toContain("key");
    expect(out).toContain("here");
  });

  it("scrubs a full PEM private-key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEArandombytes\n-----END RSA PRIVATE KEY-----";
    const out = redactString(`loaded ${pem} ok`);
    expect(out).not.toContain("MIIEowIBAAKCAQEArandombytes");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(isRedactionSafe(out)).toBe(true);
  });

  it("scrubs URL userinfo basic-auth credentials, preserving the host", () => {
    const out = redactString("connecting to https://alice:s3cr3tpw@host.local/api");
    expect(out).not.toContain("alice:s3cr3tpw@");
    expect(out).toContain("host.local");
    expect(isRedactionSafe(out)).toBe(true);
  });

  it("fail-safe DROPS a field that stays unsafe after scrubbing (no raw leak)", () => {
    const out = redactString("db password=hunter2 rejected");
    expect(out).toBe(REDACTED_FIELD);
    expect(out).not.toContain("hunter2");
    expect(isRedactionSafe(out)).toBe(true);
  });

  it("returns a clean diagnostic string unchanged and is idempotent", () => {
    const clean = "route resolved provider=claude capability=meeting.close status=completed";
    expect(redactString(clean)).toBe(clean);
    const once = redactString("key sk-Abc123Def456Ghi789Jkl and password=hunter2");
    expect(redactString(once)).toBe(once);
  });

  it("every marker is itself redaction-safe", () => {
    for (const m of [REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD]) {
      expect(isRedactionSafe(m)).toBe(true);
    }
  });
});

describe("redactRecord — field-level ALLOWLIST classifier (fail-safe default REDACT)", () => {
  it("passes an allowlisted safe scalar field through unchanged", () => {
    const out = redactRecord({ correlationId: "corr-123", status: "completed" });
    expect(out["correlationId"]).toBe("corr-123");
    expect(out["status"]).toBe("completed");
  });

  it("REDACTS an UNRECOGNIZED field by default (denylist is insufficient)", () => {
    // `promptBody` is not a benign shape, but even a totally innocuous-looking
    // unknown field name must default to redacted — allowlist, not denylist.
    const out = redactRecord({ someUnknownField: "whatever value" });
    expect(out["someUnknownField"]).toBe(REDACTED_FIELD);
  });

  it("keeps every input key present (structurally stable: field present, value replaced)", () => {
    const input = { correlationId: "c1", mysteryField: "x", event: "workflow.status" };
    const out = redactRecord(input);
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
    expect(out["mysteryField"]).toBe(REDACTED_FIELD);
  });

  it("REDACTS a credential-shaped value even under an allowlisted field name", () => {
    const out = redactRecord({ status: "sk-Abc123Def456Ghi789Jkl" });
    expect(out["status"]).not.toContain("sk-Abc123Def456Ghi789Jkl");
    // an allowlisted field carrying a credential is scrubbed via the credential marker
    expect(String(out["status"])).toContain(REDACTED_CREDENTIAL);
  });

  it("REDACTS raw-content-shaped values (multi-line / over-length) as REDACTED_RAW", () => {
    const multiline = "line one of a transcript\nline two of the raw body\nline three";
    const out = redactRecord({ status: multiline });
    expect(out["status"]).toBe(REDACTED_RAW);
    expect(String(out["status"])).not.toContain("transcript");
  });

  it("a raw Employer-Work field stays redacted even behind a debug flag (§5)", () => {
    const raw = "Confidential employer roadmap Q3 milestones and headcount plan for the org";
    // debug=true must NOT unlock raw content
    const out = redactRecord({ rawContent: raw }, { debug: true });
    expect(String(out["rawContent"])).not.toContain("headcount");
    expect(out["rawContent"] === REDACTED_RAW || out["rawContent"] === REDACTED_FIELD).toBe(true);
  });

  it("the allowlist is a non-empty set of known-safe field names", () => {
    expect(SAFE_FIELD_ALLOWLIST.size).toBeGreaterThan(0);
    expect(SAFE_FIELD_ALLOWLIST.has("correlationId")).toBe(true);
  });

  it("recurses into nested objects, defaulting unknown nested fields to redacted", () => {
    const out = redactRecord({
      fields: { status: "ok", secretHandle: "sk-Abc123Def456Ghi789Jkl" },
    });
    const nested = out["fields"] as Record<string, unknown>;
    expect(nested["status"]).toBe("ok");
    expect(String(nested["secretHandle"])).not.toContain("sk-Abc123Def456Ghi789Jkl");
  });
});

describe("redactError — strip secret/prompt/raw from message + stack + cause", () => {
  it("redacts a secret embedded in the error message", () => {
    const e = new Error("upstream rejected key sk-Abc123Def456Ghi789Jkl");
    const out = redactError(e);
    expect(out.message).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(isRedactionSafe(out.message)).toBe(true);
  });

  it("redacts a secret embedded in the stack trace", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n  at handler (password=hunter2:1:1)\n  at run (x:2:2)";
    const out = redactError(e);
    if (out.stack !== undefined) {
      expect(out.stack).not.toContain("hunter2");
      expect(isRedactionSafe(out.stack)).toBe(true);
    }
  });

  it("redacts a secret in a nested cause chain but exposes a typed cause code", () => {
    const inner = new Error("db failed with token sk_live_0123456789abcdefghij");
    const outer = new Error("write failed", { cause: inner });
    const out = redactError(outer);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk_live_0123456789abcdefghij");
  });

  it("exposes only the .code of a typed cause, never the raw cause object", () => {
    const typedCause = { code: "REVISION_STALE", secretDetail: "sk-Abc123Def456Ghi789Jkl" };
    const e = new Error("stale", { cause: typedCause });
    const out = redactError(e);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(serialized).not.toContain("secretDetail");
    // the stable code survives for diagnostics
    expect(serialized).toContain("REVISION_STALE");
  });

  it("redacts a raw prompt embedded in the message even when it is multi-line", () => {
    const e = new Error("SYSTEM: you are an agent\nUSER: employer secret roadmap details");
    const out = redactError(e);
    expect(out.message).not.toContain("employer secret roadmap");
    expect(isRedactionSafe(out.message)).toBe(true);
  });

  it("accepts a non-Error thrown value without throwing across the boundary", () => {
    const out = redactError("raw thrown string with sk-Abc123Def456Ghi789Jkl");
    expect(out.message).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(isRedactionSafe(out.message)).toBe(true);
  });
});
