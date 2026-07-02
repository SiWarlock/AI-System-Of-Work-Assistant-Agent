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
  RAW_CONTENT_MAX_LEN,
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

// ── positive-shape classifier — the fail-safe root-cause regression ──────────
// spec(§10.1: "an unrecognized/unclassifiable field defaults to redacted, never
// passed through" — a POSITIVE allowlist, NOT a length/multiline heuristic).
//
// adversarial-verify REFUTED the prior length heuristic (`looksLikeRawContent =
// includes("\n") || length > 512`): a SHORT SINGLE-LINE raw Employer-Work value
// (safety rule 5) or free-form diagnostic (safety rule 7) slipped through under an
// allowlisted field / inside an Error message. The classifier now passes a STRING
// ONLY if it is provably a bounded, whitespace-free STRUCTURED token; ANY free-form
// value (internal whitespace / over cap) is redacted regardless of length.
describe("redactRecord — positive-shape classifier (SHORT single-line raw is REDACTED)", () => {
  it("REDACTS a SHORT single-line raw Employer-Work value under an allowlisted field", () => {
    // one line, well under 512 chars, but free-form prose — must NOT pass through.
    const shortRaw = "acquire ACME for 1.2B keep it quiet";
    for (const field of ["status", "kind", "code", "failureClass", "errorMessage"]) {
      const out = redactRecord({ [field]: shortRaw });
      expect(out[field]).toBe(REDACTED_RAW);
      expect(String(out[field])).not.toContain("ACME");
    }
  });

  it("REDACTS a free-form diagnostic MESSAGE at DEFAULT level (no debug relaxation)", () => {
    const msg = "connection to the employer database was refused unexpectedly";
    const out = redactRecord({ errorMessage: msg });
    expect(out["errorMessage"]).toBe(REDACTED_RAW);
    const dbg = redactRecord({ errorMessage: msg }, { debug: true });
    expect(dbg["errorMessage"]).toBe(REDACTED_RAW);
  });

  it("redacts a free-form value at length 511, 512, AND 513 (no length-only pass path)", () => {
    // a free-form value (internal whitespace) is raw at EVERY length — the prior
    // off-by-one at exactly 512 (strict >) is gone; shape decides, not length.
    for (const len of [RAW_CONTENT_MAX_LEN - 1, RAW_CONTENT_MAX_LEN, RAW_CONTENT_MAX_LEN + 1]) {
      const freeForm = "word ".repeat(Math.ceil(len / 5)).slice(0, len);
      expect(freeForm.length).toBe(len);
      const out = redactRecord({ status: freeForm });
      expect(out["status"]).toBe(REDACTED_RAW);
    }
  });

  it("PASSES bounded structured tokens through: id, lower_snake enum, UPPER code, dotted event, ISO ts, number, boolean", () => {
    const out = redactRecord({
      correlationId: "corr-123",
      status: "completed", // lower_snake enum
      kind: "meeting_close", // lower_snake enum
      code: "REVISION_STALE", // UPPER_SNAKE code
      event: "workflow.status", // dotted event name
      ts: "2026-07-02T16:43:41.123Z", // ISO-8601 timestamp
      durationMs: 42, // number
      retryable: true, // boolean
    });
    expect(out["correlationId"]).toBe("corr-123");
    expect(out["status"]).toBe("completed");
    expect(out["kind"]).toBe("meeting_close");
    expect(out["code"]).toBe("REVISION_STALE");
    expect(out["event"]).toBe("workflow.status");
    expect(out["ts"]).toBe("2026-07-02T16:43:41.123Z");
    expect(out["durationMs"]).toBe(42);
    expect(out["retryable"]).toBe(true);
  });

  it("still scrubs a credential-shaped string under an allowlisted field to the credential marker", () => {
    const out = redactRecord({ code: "sk-Abc123Def456Ghi789Jkl" });
    expect(String(out["code"])).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(String(out["code"])).toContain(REDACTED_CREDENTIAL);
  });
});

describe("redactError — a SHORT single-line raw sentence in message/stack/cause is REDACTED", () => {
  it("REDACTS a short single-line raw sentence in an Error MESSAGE (not passed verbatim)", () => {
    const e = new Error("acquire ACME for 1.2B keep this internal");
    const out = redactError(e);
    expect(out.message).toBe(REDACTED_RAW);
    expect(out.message).not.toContain("ACME");
  });

  it("REDACTS a short single-line raw sentence embedded in the STACK", () => {
    const e = new Error("boom");
    e.stack = "employer roadmap Q3 revenue plan leaked into a stack frame";
    const out = redactError(e);
    if (out.stack !== undefined) {
      expect(out.stack).toBe(REDACTED_RAW);
      expect(out.stack).not.toContain("revenue");
    }
  });

  it("does NOT surface a free-form raw cause .code (a code with internal whitespace is not a safe token)", () => {
    const e = new Error("stale", { cause: { code: "the secret employer plan is to acquire ACME" } });
    const out = redactError(e);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("ACME");
  });
});

// ── per-field TYPE/vocabulary classifier — the whitespace-free residual ──────
// spec(§16, safety rule 5 / rule 7). Iteration-1 replaced the length heuristic
// with a purely SYNTACTIC token-shape gate (SAFE_STRUCTURED_TOKEN). Independent
// re-verify REFUTED it: a WHITESPACE-FREE raw value still passes shape alone —
// shape cannot tell `ACME` (raw employer codename) from `todoist` (safe enum),
// `824193` (OTP) from a count, or an opaque base64url token from an id. The gate
// must validate by TYPE per field (frozen-enum membership / id charset / number /
// timestamp), never by generic shape. A value is emitted UN-redacted ONLY when it
// is PROVABLY safe by type; every other whitespace-free token is REDACTED.
describe("redactRecord — whitespace-free raw leaks are REDACTED by per-field type gate", () => {
  it("REDACTS a single-word raw Employer-Work codename under a diagnostic field (shape ≠ safety)", () => {
    // `ACME` is a bounded, whitespace-free token (passes the old shape gate) but is
    // NOT a member of any frozen enum for these fields → raw content, must redact.
    for (const field of ["status", "kind", "code", "failureClass"]) {
      const out = redactRecord({ [field]: "ACME" });
      expect(out[field]).toBe(REDACTED_RAW);
      expect(String(out[field])).not.toContain("ACME");
    }
  });

  it("REDACTS a raw person surname / project name under a diagnostic field", () => {
    for (const field of ["status", "kind", "code"]) {
      const surname = redactRecord({ [field]: "Nakamura" });
      expect(surname[field]).toBe(REDACTED_RAW);
      const project = redactRecord({ [field]: "Redwood" });
      expect(project[field]).toBe(REDACTED_RAW);
    }
  });

  it("REDACTS an opaque secret with NO credential prefix (base64url token) under a NON-id field", () => {
    // a base64url bearer/session token: whitespace-free, no recognized prefix, so the
    // credential net misses it AND the old shape gate passed it. It is NOT a frozen
    // enum member and NOT under an id-named key → raw, must redact.
    const opaque = "dGhpcyImcyBhIHNlY3JldCBiZWFyZXIgdG9rZW4";
    for (const field of ["status", "code", "kind"]) {
      const out = redactRecord({ [field]: opaque });
      expect(out[field]).toBe(REDACTED_RAW);
      expect(String(out[field])).not.toContain(opaque);
    }
  });

  it("REDACTS a numeric OTP / PIN string under a NON-id field (shape ≠ count)", () => {
    // `824193` is a whitespace-free token that the old gate passed. A numeric STRING
    // under status/code is an OTP/PIN, not a numeric count → raw, must redact. (A real
    // numeric count is a `number`, not a string — see the number-passes test below.)
    for (const field of ["status", "code", "kind"]) {
      const out = redactRecord({ [field]: "824193" });
      expect(out[field]).toBe(REDACTED_RAW);
      expect(String(out[field])).not.toContain("824193");
    }
  });

  it("REDACTS a raw value under `providerId` — an enum field whose Id-suffix must NOT defeat enum validation (re-verify HIGH)", () => {
    // `providerId` ends in `Id` but is a FIXED categorical enum (ProviderId), not a
    // system-generated id. The dedicated enum case must win over the generic
    // id-named short-circuit, else a raw codename / OTP / opaque token leaks here.
    for (const raw of ["ACME", "824193", "dGhpcyImcyBhIHNlY3JldA"]) {
      const out = redactRecord({ providerId: raw });
      expect(out.providerId).toBe(REDACTED_RAW);
      expect(String(out.providerId)).not.toContain(raw);
    }
    // A real ProviderId member still passes (traceability preserved).
    expect(redactRecord({ providerId: "claude" }).providerId).toBe("claude");
    // A genuinely system-generated id under a NON-enum id field still passes.
    expect(redactRecord({ correlationId: "corr-123" }).correlationId).toBe("corr-123");
  });

  it("PASSES real frozen-enum members under their diagnostic fields", () => {
    const out = redactRecord({
      level: "info", // LogLevel member
      failureClass: "connector_unreachable", // FailureClass member
      state: "open", // HealthState member
      event: "workflow.status", // EventName member
      kind: "meeting_close", // ProvenanceOrigin member
      status: "completed", // known lifecycle status
      provider: "claude", // ProviderId member
      targetSystem: "todoist", // TargetSystem member
    });
    expect(out["level"]).toBe("info");
    expect(out["failureClass"]).toBe("connector_unreachable");
    expect(out["state"]).toBe("open");
    expect(out["event"]).toBe("workflow.status");
    expect(out["kind"]).toBe("meeting_close");
    expect(out["status"]).toBe("completed");
    expect(out["provider"]).toBe("claude");
    expect(out["targetSystem"]).toBe("todoist");
  });

  it("PASSES an UPPER_SNAKE code (has an underscore) but REDACTS a bare word under `code`", () => {
    expect(redactRecord({ code: "REVISION_STALE" })["code"]).toBe("REVISION_STALE");
    expect(redactRecord({ code: "AUTH_DENIED" })["code"]).toBe("AUTH_DENIED");
    // a bare word without an underscore is NOT a structured code → raw
    expect(redactRecord({ code: "ACME" })["code"]).toBe(REDACTED_RAW);
    expect(redactRecord({ code: "todoistlike" })["code"]).toBe(REDACTED_RAW);
  });

  it("PASSES a real id under an id-named field but REDACTS a bare word under a non-id field", () => {
    // §16: correlation/workflow-run/workspace/*Id/*Ref are system-generated ids and
    // are explicitly loggable; they pass on the bounded id charset.
    expect(redactRecord({ correlationId: "corr-123" })["correlationId"]).toBe("corr-123");
    expect(redactRecord({ workflowRunId: "wf-9" })["workflowRunId"]).toBe("wf-9");
    expect(redactRecord({ workspaceId: "employer-work" })["workspaceId"]).toBe("employer-work");
    // the SAME token `ACME` under a non-id diagnostic field is redacted
    expect(redactRecord({ status: "ACME" })["status"]).toBe(REDACTED_RAW);
  });

  it("PASSES numbers, booleans, null, and ISO-8601 timestamps by TYPE", () => {
    const out = redactRecord({
      durationMs: 42,
      count: 824193, // a real numeric count is a number, and passes
      retryable: false,
      ts: "2026-07-02T16:43:41.123Z",
    });
    expect(out["durationMs"]).toBe(42);
    expect(out["count"]).toBe(824193);
    expect(out["retryable"]).toBe(false);
    expect(out["ts"]).toBe("2026-07-02T16:43:41.123Z");
  });

  it("ACCEPTED RESIDUAL: a secret MIS-LABELLED under an id-named field passes (§16 call-site discipline)", () => {
    // Documented boundary: correlation/workflow-run ids are system-generated from the
    // id-builders and never carry raw content, so an id-named field passes on the id
    // charset. A caller that deliberately places a secret under `correlationId` bypasses
    // this — that is call-site discipline (secrets resolve only via SecretsPort), not a
    // classifier gap. This test PINS the accepted boundary so a future tightening is a
    // conscious choice, not an accident.
    const out = redactRecord({ correlationId: "abc123def456" });
    expect(out["correlationId"]).toBe("abc123def456");
  });
});

describe("redactError — a bare word is NOT accepted as a cause .code", () => {
  it("does NOT surface a bare single-word cause .code (ACME is not a structured code)", () => {
    const e = new Error("stale", { cause: { code: "ACME" } });
    const out = redactError(e);
    expect(out.causeCode).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("ACME");
  });

  it("does NOT surface a numeric OTP masquerading as a cause .code", () => {
    const e = new Error("stale", { cause: { code: "824193" } });
    const out = redactError(e);
    expect(out.causeCode).toBeUndefined();
  });

  it("still surfaces a real UPPER_SNAKE cause .code (REVISION_STALE / AUTH_DENIED)", () => {
    expect(redactError(new Error("s", { cause: { code: "REVISION_STALE" } })).causeCode).toBe(
      "REVISION_STALE",
    );
    expect(redactError(new Error("s", { cause: { code: "AUTH_DENIED" } })).causeCode).toBe(
      "AUTH_DENIED",
    );
  });
});
