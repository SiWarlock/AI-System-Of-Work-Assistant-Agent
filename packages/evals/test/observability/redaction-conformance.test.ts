// §12 CONFORMANCE — REDACTION adversarial corpus (task 10.8 suite 1; §5 / §16 /
// safety rule 7). This is a CROSS-CUTTING conformance suite, not a per-slice unit
// test: it drives the REAL @sow/domain redact API + the REAL worker createLogger
// chokepoint against an adversarial corpus and asserts the load-bearing property:
//
//   NO credential-shaped string and NO raw-content field (a provider prompt, raw
//   Employer-Work content, or an AgentResult.logs body) reaches ANY sink at the
//   default level — INCLUDING via an Error's message / stack / cause chain.
//
// It further asserts:
//   (a) the ALLOWLIST fail-safe — an UNKNOWN structured field is redacted whole
//       (a denylist would silently pass it);
//   (b) the debug flag STILL keeps Employer-Work raw content redacted (§5): the
//       `debug` option NEVER unlocks raw content, it only widens NON-content
//       diagnostics.
//
// The SUT is imported, never re-implemented: @sow/domain {redactString, redactRecord,
// redactError, RAW_CONTENT_MAX_LEN} + @sow/worker createLogger over a capturing sink.
import { describe, expect, it } from "vitest";
import {
  redactString,
  redactRecord,
  redactError,
  RAW_CONTENT_MAX_LEN,
} from "@sow/domain";
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "@sow/contracts";
import type { LogRecord } from "@sow/contracts";
import { createLogger, type LogSink } from "@sow/worker/observability/logger";

// ── the adversarial corpus ─────────────────────────────────────────────────────
// Concrete secret-shaped and raw-content-shaped values a provider/agent boundary
// could try to smuggle into a log. Each is a value that MUST NOT appear verbatim
// at any sink. Kept as data so the same corpus drives the string, record, error,
// and logger paths uniformly.

/** Credential-shaped secrets (API keys, PEM, JWT, URL basic-auth). */
const CREDENTIAL_CORPUS: readonly string[] = [
  "sk-ABCDEF0123456789abcdef", // OpenAI-style API key
  "sk_live_ABCDEF0123456789", // Stripe-style live key
  "xoxb-0000-1111-AAAAbbbbCCCCdddd", // Slack bot token
  "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", // GitHub PAT
  "AKIA0123456789ABCDEF", // AWS access key id
  "eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", // JWT
  "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", // PEM
  "postgres://user:hunter2@db.internal:5432/app", // URL basic-auth
  "the password is hunter2", // sensitive keyword (unredactable → whole drop)
  "my api_key: shhh", // sensitive keyword
];

/** A distinctive secret token we assert never appears anywhere in a sink. */
const SECRET_NEEDLE = "SUPERSECRETNEEDLE1234567890";

/** Raw Employer-Work / prompt content — multi-line and/or over-length. */
const rawEmployerBody =
  "MEETING NOTES — ACME acquisition (EMPLOYER CONFIDENTIAL)\n" +
  "Attendees: alice, bob\nDecision: proceed with the deal at $1.2B\n" +
  "Next steps: legal review of the term sheet";
const overLongBody = "x".repeat(RAW_CONTENT_MAX_LEN + 10);

/**
 * SHORT single-line raw values — the adversarial-verify refutation. Each is under
 * 512 chars and has NO newline, so the prior length/multiline heuristic let them
 * pass; a POSITIVE-shape classifier must redact them (free-form prose, not a
 * bounded structured token). Distinctive needle: SHORTRAWNEEDLE.
 */
const shortSingleLineRaw: readonly string[] = [
  "acquire ACME then keep SHORTRAWNEEDLE quiet", // employer plan (safety rule 5)
  "connection to the database was refused SHORTRAWNEEDLE", // free-form diagnostic
  "employer roadmap Q3 SHORTRAWNEEDLE revenue plan", // employer confidential
];
const SHORT_RAW_NEEDLE = "SHORTRAWNEEDLE";

/**
 * WHITESPACE-FREE raw values — the iteration-2 residual. Each is a single bounded
 * token with NO whitespace, so the SYNTACTIC token-shape gate (iteration 1) let it
 * pass; a PER-FIELD TYPE gate must redact it because it is not a frozen-enum member
 * for its field, not an id under an id-named key, and (for `code`) not a structured
 * code. Distinctive needle: WSFREENEEDLE embedded so we can assert it never survives.
 */
const whitespaceFreeRaw: readonly string[] = [
  "WSFREENEEDLE", // raw employer codename / project / surname
  "824193", // numeric OTP / PIN string
  "dGhpcyImWSFREENEEDLEc2VjcmV0", // opaque base64url bearer/session token
];
const WSFREE_NEEDLE = "WSFREENEEDLE";

/** Every marker that stands in for a redacted value (a redacted output is one of these). */
const MARKERS: readonly string[] = [REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD];

/** True iff a rendered string still contains a raw secret/content substring. */
function containsRawSecret(haystack: string): boolean {
  if (haystack.includes(SECRET_NEEDLE)) return true;
  // any credential corpus value that is NOT itself a marker leaking through
  for (const c of CREDENTIAL_CORPUS) {
    // A whole-line sensitive-keyword phrase is dropped, not substring-matched;
    // assert the DISTINCTIVE secret token part never survives.
    if (c.startsWith("sk-") || c.startsWith("sk_live") || c.startsWith("xoxb-") || c.startsWith("ghp_") || c.startsWith("AKIA") || c.startsWith("eyJ")) {
      if (haystack.includes(c)) return true;
    }
  }
  if (haystack.includes("hunter2")) return true;
  if (haystack.includes("ACME acquisition")) return true;
  if (haystack.includes(SHORT_RAW_NEEDLE)) return true;
  if (haystack.includes(WSFREE_NEEDLE)) return true;
  if (haystack.includes("824193")) return true;
  return false;
}

describe("§12 redaction conformance — credential-shaped strings never reach a sink (§5/§16)", () => {
  it("redactString scrubs EVERY credential corpus value (no verbatim secret survives)", () => {
    for (const raw of CREDENTIAL_CORPUS) {
      const out = redactString(raw);
      expect(containsRawSecret(out)).toBe(false);
      // the output is either a marker-bearing scrub or a whole-field drop
      const isRedacted = MARKERS.some((m) => out.includes(m)) || out === REDACTED_FIELD;
      expect(isRedacted).toBe(true);
    }
  });

  it("redactString is idempotent (a second pass never re-leaks or corrupts)", () => {
    for (const raw of CREDENTIAL_CORPUS) {
      const once = redactString(raw);
      const twice = redactString(once);
      expect(twice).toBe(once);
      expect(containsRawSecret(twice)).toBe(false);
    }
  });
});

describe("§12 redaction conformance — raw-content fields never reach a sink (§5)", () => {
  it("redactRecord drops raw Employer-Work / prompt bodies under an allowlisted field", () => {
    // `errorMessage` is allowlisted but re-screened: a multi-line raw body under it
    // is still redacted to REDACTED_RAW (structural, key-name-independent).
    const rec = redactRecord({ errorMessage: rawEmployerBody });
    expect(rec["errorMessage"]).toBe(REDACTED_RAW);
    expect(containsRawSecret(JSON.stringify(rec))).toBe(false);
  });

  it("redactRecord drops an over-length body to REDACTED_RAW", () => {
    const rec = redactRecord({ errorMessage: overLongBody });
    expect(rec["errorMessage"]).toBe(REDACTED_RAW);
  });

  it("ALLOWLIST fail-safe: an UNKNOWN field is redacted whole (denylist would leak it)", () => {
    const rec = redactRecord({
      promptText: `here is the raw prompt ${SECRET_NEEDLE}`,
      rawBody: rawEmployerBody,
      apiKey: "sk-ABCDEF0123456789abcdef",
    });
    // none of these field names are on the allowlist → each dropped whole, value unseen
    expect(rec["promptText"]).toBe(REDACTED_FIELD);
    expect(rec["rawBody"]).toBe(REDACTED_FIELD);
    expect(rec["apiKey"]).toBe(REDACTED_FIELD);
    // the structure is preserved (keys present) but no value survives
    expect(Object.keys(rec).sort()).toEqual(["apiKey", "promptText", "rawBody"]);
    expect(containsRawSecret(JSON.stringify(rec))).toBe(false);
  });

  it("allowlisted traceability fields pass through only when NOT secret-shaped", () => {
    const rec = redactRecord({ correlationId: "corr-123", workspaceId: "ws-abc" });
    expect(rec["correlationId"]).toBe("corr-123");
    expect(rec["workspaceId"]).toBe("ws-abc");
    // but a credential-shaped value under an allowlisted key is STILL scrubbed
    const scrubbed = redactRecord({ correlationId: "sk-ABCDEF0123456789abcdef" });
    expect(containsRawSecret(String(scrubbed["correlationId"]))).toBe(false);
  });
});

describe("§12 redaction conformance — Error / stack / cause paths never leak (§16 closes unlogged-egress)", () => {
  it("redactError scrubs a secret embedded in an Error message", () => {
    const e = new Error(`provider call failed with key sk-ABCDEF0123456789abcdef`);
    const red = redactError(e);
    expect(containsRawSecret(red.message)).toBe(false);
    // Safer positive-shape posture: a free-form message (internal whitespace) is
    // NOT a bounded structured token, so after the credential is scrubbed the whole
    // message is dropped to REDACTED_RAW rather than emitted as scrubbed prose. Any
    // of the three markers is acceptable — none carries the secret.
    expect(
      red.message.includes(REDACTED_CREDENTIAL) ||
        red.message === REDACTED_RAW ||
        red.message === REDACTED_FIELD,
    ).toBe(true);
  });

  it("redactError drops a raw multi-line Employer-Work body embedded in a message to REDACTED_RAW", () => {
    const e = new Error(rawEmployerBody);
    const red = redactError(e);
    expect(red.message).toBe(REDACTED_RAW);
    expect(containsRawSecret(red.message)).toBe(false);
  });

  it("redactError scrubs a secret in the STACK, never surfaces a raw cause object", () => {
    const e = new Error("outer");
    // a secret hidden in the stack (a common leak vector)
    e.stack = `Error: outer\n    at leak (sk-ABCDEF0123456789abcdef)\n    at run`;
    // a cause carrying a raw message + secret — only the stable `.code` may survive
    (e as { cause?: unknown }).cause = {
      code: "REVISION_STALE",
      message: `raw cause ${SECRET_NEEDLE}`,
      stack: "secret stack",
    };
    const red = redactError(e);
    expect(red.stack === undefined || containsRawSecret(red.stack)).toBe(false);
    // the whole redacted projection carries no secret from the cause object
    expect(containsRawSecret(JSON.stringify(red))).toBe(false);
    // only the stable cause code (no secret) survived, if any
    if (red.causeCode !== undefined) {
      expect(red.causeCode).toBe("REVISION_STALE");
    }
  });

  it("redactError is total on a non-Error thrown value (never throws, scrubs the credential)", () => {
    // A non-Error thrown value is coerced to its string form and scrubbed. The
    // credential-shaped token MUST be gone. Under the positive-shape posture this
    // free-form message (internal whitespace) is dropped whole to REDACTED_RAW
    // after the credential scrub — strictly safer than emitting scrubbed prose.
    const red = redactError(`sk-ABCDEF0123456789abcdef ${SECRET_NEEDLE}`);
    expect(red.message.includes("sk-ABCDEF0123456789abcdef")).toBe(false);
    expect(containsRawSecret(red.message)).toBe(false);
    expect(
      red.message.includes(REDACTED_CREDENTIAL) ||
        red.message === REDACTED_RAW ||
        red.message === REDACTED_FIELD,
    ).toBe(true);
  });
});

describe("§12 redaction conformance — the worker createLogger chokepoint has NO raw path", () => {
  function capturingLogger(): { logger: ReturnType<typeof createLogger>; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const sink: LogSink = (r) => records.push(r);
    return { logger: createLogger(sink), records };
  }

  it("info() with unknown+secret fields emits NOTHING raw to the sink", () => {
    const { logger, records } = capturingLogger();
    logger.info("provider.call", {
      correlationId: "corr-1",
      fields: {
        promptText: `raw prompt ${SECRET_NEEDLE}`,
        apiKey: "sk-ABCDEF0123456789abcdef",
        rawBody: rawEmployerBody,
      },
    });
    expect(records).toHaveLength(1);
    const rendered = JSON.stringify(records[0]);
    expect(containsRawSecret(rendered)).toBe(false);
    // the unknown fields are dropped whole
    const f = records[0]?.fields ?? {};
    expect(f["promptText"]).toBe(REDACTED_FIELD);
    expect(f["apiKey"]).toBe(REDACTED_FIELD);
    expect(f["rawBody"]).toBe(REDACTED_FIELD);
  });

  it("errorFrom() redacts an Error carrying a secret in its message + cause before the sink", () => {
    const { logger, records } = capturingLogger();
    const e = new Error(`boom sk-ABCDEF0123456789abcdef`);
    (e as { cause?: unknown }).cause = { code: "AUTH_DENIED", message: `secret ${SECRET_NEEDLE}` };
    logger.errorFrom("provider.error", e, { correlationId: "corr-2" });
    expect(records).toHaveLength(1);
    const rendered = JSON.stringify(records[0]);
    expect(containsRawSecret(rendered)).toBe(false);
    // the stable cause code is safe to surface (no secret)
    const f = records[0]?.fields ?? {};
    if (f["code"] !== undefined) expect(f["code"]).toBe("AUTH_DENIED");
  });

  it("every corpus secret, driven through the logger, is absent from every sink record", () => {
    const { logger, records } = capturingLogger();
    for (const secret of [...CREDENTIAL_CORPUS, rawEmployerBody, overLongBody]) {
      logger.warn("adversarial", { fields: { note: secret, leaked: secret } });
      logger.errorFrom("adversarial.err", new Error(`wrapped ${secret}`));
    }
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(containsRawSecret(JSON.stringify(r))).toBe(false);
    }
  });
});

describe("§12 redaction conformance — the debug flag NEVER unlocks Employer-Work raw content (§5)", () => {
  it("redactRecord({debug:true}) STILL redacts raw Employer-Work content to REDACTED_RAW", () => {
    const plain = redactRecord({ errorMessage: rawEmployerBody });
    const debug = redactRecord({ errorMessage: rawEmployerBody }, { debug: true });
    // the raw body is REDACTED_RAW at BOTH levels — debug does not widen it
    expect(plain["errorMessage"]).toBe(REDACTED_RAW);
    expect(debug["errorMessage"]).toBe(REDACTED_RAW);
    expect(debug).toEqual(plain);
    expect(containsRawSecret(JSON.stringify(debug))).toBe(false);
  });

  it("redactRecord({debug:true}) STILL drops an unknown field carrying raw content (no denylist relaxation)", () => {
    const debug = redactRecord(
      { employerRawContent: rawEmployerBody, apiKey: "sk-ABCDEF0123456789abcdef" },
      { debug: true },
    );
    expect(debug["employerRawContent"]).toBe(REDACTED_FIELD);
    expect(debug["apiKey"]).toBe(REDACTED_FIELD);
    expect(containsRawSecret(JSON.stringify(debug))).toBe(false);
  });
});

describe("§12 redaction conformance — SHORT single-line raw never reaches a sink (positive-shape)", () => {
  it("redactRecord redacts a SHORT single-line raw value under EVERY allowlisted diagnostic field", () => {
    // adversarial-verify: the prior length/multiline heuristic let these through.
    for (const raw of shortSingleLineRaw) {
      for (const field of ["status", "kind", "code", "failureClass", "errorMessage"]) {
        const rec = redactRecord({ [field]: raw });
        expect(rec[field]).toBe(REDACTED_RAW);
        expect(containsRawSecret(JSON.stringify(rec))).toBe(false);
      }
    }
  });

  it("redactRecord redacts a free-form value at length 511, 512, AND 513 (no length-only pass path)", () => {
    for (const len of [RAW_CONTENT_MAX_LEN - 1, RAW_CONTENT_MAX_LEN, RAW_CONTENT_MAX_LEN + 1]) {
      const freeForm = ("word " + SHORT_RAW_NEEDLE + " ").repeat(len).slice(0, len);
      expect(freeForm.length).toBe(len);
      const rec = redactRecord({ status: freeForm });
      expect(rec["status"]).toBe(REDACTED_RAW);
      expect(containsRawSecret(JSON.stringify(rec))).toBe(false);
    }
  });

  it("redactError redacts a SHORT single-line raw sentence in an Error message / stack", () => {
    for (const raw of shortSingleLineRaw) {
      const e = new Error(raw);
      const red = redactError(e);
      expect(red.message).toBe(REDACTED_RAW);
      expect(containsRawSecret(JSON.stringify(red))).toBe(false);
    }
  });

  it("logger chokepoint redacts SHORT single-line raw under an allowlisted field before the sink", () => {
    const records: LogRecord[] = [];
    const sink: LogSink = (r) => records.push(r);
    const logger = createLogger(sink);
    for (const raw of shortSingleLineRaw) {
      logger.warn("adversarial.short-raw", { fields: { status: raw, code: raw } });
    }
    expect(records.length).toBe(shortSingleLineRaw.length);
    for (const r of records) {
      expect(containsRawSecret(JSON.stringify(r))).toBe(false);
    }
  });

  it("Employer-Work SHORT raw stays redacted even at the debug flag (§5 — no debug relaxation)", () => {
    for (const raw of shortSingleLineRaw) {
      const plain = redactRecord({ status: raw });
      const debug = redactRecord({ status: raw }, { debug: true });
      expect(plain["status"]).toBe(REDACTED_RAW);
      expect(debug["status"]).toBe(REDACTED_RAW);
      expect(containsRawSecret(JSON.stringify(debug))).toBe(false);
    }
  });
});

describe("§12 redaction conformance — WHITESPACE-FREE raw never reaches a sink (per-field type gate)", () => {
  it("redactRecord redacts a whitespace-free raw value under EVERY allowlisted diagnostic field", () => {
    // iteration-2 re-verify: the syntactic token-shape gate passed these single
    // bounded tokens. A per-field TYPE gate must redact them — none is a frozen-enum
    // member for its field, none is an id under an id-named key, none is a code.
    for (const raw of whitespaceFreeRaw) {
      for (const field of ["status", "kind", "code", "failureClass"]) {
        const rec = redactRecord({ [field]: raw });
        expect(rec[field]).toBe(REDACTED_RAW);
        expect(containsRawSecret(JSON.stringify(rec))).toBe(false);
      }
    }
  });

  it("redactRecord passes a real frozen-enum member / id / number, so the gate is not over-broad", () => {
    const rec = redactRecord({
      level: "info",
      failureClass: "connector_unreachable",
      state: "open",
      event: "workflow.status",
      provider: "claude",
      targetSystem: "todoist",
      kind: "meeting_close",
      status: "completed",
      correlationId: "corr-123",
      count: 42,
    });
    expect(rec["level"]).toBe("info");
    expect(rec["failureClass"]).toBe("connector_unreachable");
    expect(rec["state"]).toBe("open");
    expect(rec["event"]).toBe("workflow.status");
    expect(rec["provider"]).toBe("claude");
    expect(rec["targetSystem"]).toBe("todoist");
    expect(rec["kind"]).toBe("meeting_close");
    expect(rec["status"]).toBe("completed");
    expect(rec["correlationId"]).toBe("corr-123");
    expect(rec["count"]).toBe(42);
  });

  it("redactError never surfaces a bare-word or numeric cause .code (only a structured code)", () => {
    expect(redactError(new Error("s", { cause: { code: "WSFREENEEDLE" } })).causeCode).toBeUndefined();
    expect(redactError(new Error("s", { cause: { code: "824193" } })).causeCode).toBeUndefined();
    expect(redactError(new Error("s", { cause: { code: "REVISION_STALE" } })).causeCode).toBe(
      "REVISION_STALE",
    );
  });

  it("logger chokepoint redacts whitespace-free raw under an allowlisted field before the sink", () => {
    const records: LogRecord[] = [];
    const sink: LogSink = (r) => records.push(r);
    const logger = createLogger(sink);
    for (const raw of whitespaceFreeRaw) {
      logger.warn("adversarial.wsfree", { fields: { status: raw, code: raw, kind: raw } });
    }
    expect(records.length).toBe(whitespaceFreeRaw.length);
    for (const r of records) {
      expect(containsRawSecret(JSON.stringify(r))).toBe(false);
    }
  });
});

// ── the DoD gate entry (wiringFactory) ─────────────────────────────────────────
// A single named predicate the phase-exit harness can call to assert the whole
// corpus is clean — the machine-checkable DoD gate for suite 1.
export function redactionConformanceHolds(): boolean {
  const corpus = [
    ...CREDENTIAL_CORPUS,
    rawEmployerBody,
    overLongBody,
    ...shortSingleLineRaw,
    SECRET_NEEDLE,
  ];
  for (const raw of corpus) {
    if (containsRawSecret(redactString(raw))) return false;
    if (containsRawSecret(redactError(new Error(raw)).message)) return false;
  }
  // SHORT single-line raw under an allowlisted diagnostic field is redacted whole.
  for (const raw of shortSingleLineRaw) {
    if (redactRecord({ status: raw })["status"] !== REDACTED_RAW) return false;
  }
  // WHITESPACE-FREE raw (codename / OTP / opaque token) under a diagnostic field is
  // redacted by the per-field type gate — the syntactic shape gate let it pass.
  for (const raw of whitespaceFreeRaw) {
    if (redactRecord({ status: raw })["status"] !== REDACTED_RAW) return false;
    if (redactError(new Error("s", { cause: { code: raw } })).causeCode !== undefined) return false;
  }
  const rec = redactRecord({ promptText: `raw ${SECRET_NEEDLE}`, errorMessage: rawEmployerBody });
  if (rec["promptText"] !== REDACTED_FIELD) return false;
  if (rec["errorMessage"] !== REDACTED_RAW) return false;
  const debug = redactRecord({ errorMessage: rawEmployerBody }, { debug: true });
  return debug["errorMessage"] === REDACTED_RAW;
}
