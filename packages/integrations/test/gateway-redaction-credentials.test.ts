// §16 safety-rule-7 regression — the gateway redaction barrier must catch the
// credential shapes the adversarial-verify pass found leaking: a Google API key
// (`AIza…`) and any secret carried in a URL/query parameter (`?key=…`,
// `&access_token=…`). These are the shapes that trip NO fixed prefix and NO bare
// keyword, so the un-broadened detector emitted them verbatim to the log sink.
import { describe, it, expect } from "vitest";
import {
  redactString,
  isGatewayLogSafe,
  buildSafeConnectorLog,
} from "../src/redaction/gateway-log-redaction";

const GOOGLE_KEY = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";

describe("gateway redaction — Google API key (AIza…)", () => {
  it("a standalone Google API key is judged unsafe and scrubbed", () => {
    const raw = `auth failed with key ${GOOGLE_KEY}`;
    expect(isGatewayLogSafe(raw)).toBe(false);
    const out = redactString(raw);
    expect(out).not.toContain(GOOGLE_KEY);
    expect(isGatewayLogSafe(out)).toBe(true);
  });
});

describe("gateway redaction — secret in a URL/query parameter", () => {
  it("a Google API key echoed in a request URL is scrubbed but the URL path survives", () => {
    const raw = `request to https://www.googleapis.com/calendar/v3/events?key=${GOOGLE_KEY} failed with 401`;
    expect(isGatewayLogSafe(raw)).toBe(false);
    const out = redactString(raw);
    expect(out).not.toContain(GOOGLE_KEY);
    // The useful diagnostic (host + path) is preserved; only the secret is gone.
    expect(out).toContain("googleapis.com/calendar/v3/events");
    expect(out).toContain("401");
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("an opaque access_token in a query string is scrubbed", () => {
    const raw = "GET https://api.example.com/v1/items?access_token=abcDEF1234567890opaqueTOKENxyz";
    expect(isGatewayLogSafe(raw)).toBe(false);
    const out = redactString(raw);
    expect(out).not.toContain("abcDEF1234567890opaqueTOKENxyz");
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("an AWS/GCS SigV4 signed-URL signature param is scrubbed (L-1 hardening)", () => {
    const sig = "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7";
    const raw = `PUT https://bucket.s3.amazonaws.com/obj?X-Amz-Credential=AKIAEXAMPLE%2F20260701%2Fus-east-1&X-Amz-Signature=${sig}`;
    expect(isGatewayLogSafe(raw)).toBe(false);
    const out = redactString(raw);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("the safe connector log runs the diagnostic through redaction — the key never reaches the sink", () => {
    const safe = buildSafeConnectorLog({
      connectorId: "calendar",
      status: "unreachable",
      diagnostic: `GET https://www.googleapis.com/calendar/v3/events?key=${GOOGLE_KEY} → 401`,
    });
    expect(JSON.stringify(safe)).not.toContain(GOOGLE_KEY);
  });
});

describe("gateway redaction — no over-redaction (regression guard)", () => {
  it("a sha256 content hash is still judged safe (not a credential)", () => {
    const hash = "sha256:deadbeefcafebabe0123456789abcdef";
    expect(isGatewayLogSafe(hash)).toBe(true);
    expect(redactString(hash)).toBe(hash);
  });

  it("an opaque object key NOT in a credential param is left intact", () => {
    const s = "reused object cok_drive_abcdef1234567890 (no create issued)";
    expect(isGatewayLogSafe(s)).toBe(true);
    expect(redactString(s)).toBe(s);
  });

  it("a structured status code carrying the word token is not a false positive", () => {
    const s = "connector returned AUTH_TOKEN_INVALID";
    expect(isGatewayLogSafe(s)).toBe(true);
    expect(redactString(s)).toBe(s);
  });
});
