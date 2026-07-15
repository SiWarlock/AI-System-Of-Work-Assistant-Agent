// spec(§5) — route → processor identity (REQ-S-002/S-005). isLoopbackEndpoint is
// the tunneled-local hole's ONLY gate: egressClass is a CLAIM, a loopback
// endpoint is the PROOF. processorOfRoute returns null ONLY for a genuine
// non-egress loopback-local route (local provider / runtime bound to loopback);
// it returns a DISTINCT ProcessorId for every cloud endpoint (OpenRouter is its
// OWN processor, NEVER an OpenAI alias) and — fail-closed — for any egressClass
// 'local' route whose endpoint is remote/proxied/DNS (the tunneled-local hole).
import { describe, it, expect } from "vitest";
import type { ProviderRoute } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import { isAllowedRemoteEndpoint, isLoopbackEndpoint, processorOfRoute } from "../src/processors";

// ── route builders ───────────────────────────────────────────────────────────
const providerRoute = (
  provider: "claude" | "openai" | "openrouter" | "ollama" | "lm_studio",
  endpoint: string,
  egressClass: "local" | "cloud",
): ProviderRoute => ({ provider, model: "m", endpoint, egressClass });

const runtimeRoute = (
  endpoint: string,
  egressClass: "local" | "cloud",
): ProviderRoute => ({ runtime: "claude-agent-sdk", model: "m", endpoint, egressClass });

describe("isLoopbackEndpoint — genuine loopback (true)", () => {
  it.each([
    ["http://127.0.0.1:11434", "IPv4 loopback + scheme + port"],
    ["127.0.0.1:11434", "bare host:port"],
    ["127.0.0.1", "bare IPv4 loopback"],
    ["127.255.255.254", "127.0.0.0/8 upper range"],
    ["http://localhost:1234/v1", "localhost + path"],
    ["localhost", "bare localhost"],
    ["http://[::1]:11434", "bracketed IPv6 loopback + port"],
    ["::1", "bare IPv6 loopback literal"],
    ["/var/run/ollama.sock", "unix socket absolute path"],
    ["unix:///tmp/lmstudio.sock", "unix:// socket URL"],
  ])("true for %s (%s)", (endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(true);
  });
});

describe("isLoopbackEndpoint — remote / adversarial (false, fail-closed)", () => {
  it.each([
    ["https://api.anthropic.com", "cloud DNS host"],
    ["http://openrouter.ai/api/v1", "cloud DNS host + path"],
    ["http://127.0.0.1.attacker.com:11434", "prefix trick — loopback as a subdomain label"],
    ["http://localhost.evil.com", "suffix trick — localhost as a subdomain label"],
    ["http://0.0.0.0:11434", "all-interfaces bind is remotely reachable, NOT loopback"],
    ["http://10.0.0.5:11434", "private LAN host is remote, not loopback"],
    ["http://169.254.169.254", "link-local metadata endpoint is not loopback"],
    ["//evil.com/proxy", "protocol-relative URL is not a socket path"],
    ["", "empty string ⇒ not loopback (fail-closed)"],
    ["   ", "whitespace ⇒ not loopback (fail-closed)"],
  ])("false for %s (%s)", (endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(false);
  });
});

describe("processorOfRoute — genuine non-egress local ⇒ null", () => {
  it("ollama on loopback ⇒ null", () => {
    expect(processorOfRoute(providerRoute("ollama", "http://127.0.0.1:11434", "local"))).toBeNull();
  });
  it("lm_studio on loopback ⇒ null", () => {
    expect(processorOfRoute(providerRoute("lm_studio", "http://localhost:1234", "local"))).toBeNull();
  });
  it("runtime bound to loopback ⇒ null", () => {
    expect(processorOfRoute(runtimeRoute("http://127.0.0.1:9000", "local"))).toBeNull();
  });
});

describe("processorOfRoute — cloud endpoints ⇒ distinct processor id", () => {
  it("provider:'claude' ⇒ processorId('claude')", () => {
    expect(processorOfRoute(providerRoute("claude", "https://api.anthropic.com", "cloud"))).toBe(
      processorId("claude"),
    );
  });
  it("provider:'openai' ⇒ processorId('openai')", () => {
    expect(processorOfRoute(providerRoute("openai", "https://api.openai.com", "cloud"))).toBe(
      processorId("openai"),
    );
  });
  it("provider:'openrouter' ⇒ its OWN processor id, NEVER 'openai'", () => {
    const proc = processorOfRoute(providerRoute("openrouter", "https://openrouter.ai/api/v1", "cloud"));
    expect(proc).toBe(processorId("openrouter"));
    expect(proc).not.toBe(processorId("openai"));
  });
  it("runtime bound to a cloud endpoint ⇒ a non-null processor id (egress)", () => {
    expect(processorOfRoute(runtimeRoute("https://api.anthropic.com", "cloud"))).not.toBeNull();
  });
});

describe("processorOfRoute — tunneled-'local' hole ⇒ EGRESS (non-null), fail-closed", () => {
  it("egressClass 'local' + REMOTE endpoint ⇒ non-null processor (treated as egress)", () => {
    // The exfiltration hole: a 'local' claim pointing at a remote/proxied host.
    const proc = processorOfRoute(providerRoute("ollama", "https://exfil.example.com:11434", "local"));
    expect(proc).not.toBeNull();
    expect(proc).toBe(processorId("ollama"));
  });
  it("egressClass 'local' + prefix-trick loopback subdomain ⇒ non-null (treated as egress)", () => {
    expect(
      processorOfRoute(providerRoute("ollama", "http://127.0.0.1.attacker.com", "local")),
    ).not.toBeNull();
  });
  it("a CLOUD provider id claiming local+loopback ⇒ still egress (named provider wins, fail-closed)", () => {
    // provider:'openai' is a cloud processor by identity — a loopback endpoint
    // claim cannot launder it into a genuine non-egress route.
    expect(processorOfRoute(providerRoute("openai", "http://127.0.0.1:1234", "local"))).toBe(
      processorId("openai"),
    );
  });
});

// ── isAllowedRemoteEndpoint — OUTBOUND connector-egress SSRF admission ──────────
// spec(§5) EgressPolicy / authority-isolation + spec(§8) Connector & Tool Gateways.
// The INVERSE posture of isLoopbackEndpoint: a bearer-token-carrying connector
// request (Asana round; Granola/Drive/Calendar/… later) may egress ONLY to an
// allowlisted, TLS, remote host. Composes the SINGLE vetted parse primitives
// (extractHost / isLoopbackHost) — it must NEVER re-parse URLs (re-parsing was the
// loopback-spoof hole those primitives already close; root CLAUDE.md Lesson 4).
const ASANA = ["app.asana.com"] as const;

describe("isAllowedRemoteEndpoint — admits https + allowlisted remote host (true)", () => {
  it.each([
    ["https://app.asana.com/api/1.0/tasks", "host + path"],
    ["https://app.asana.com", "bare host, default 443"],
    ["https://app.asana.com:443/api/1.0/tasks?limit=1", "explicit :443 + query (port stripped by extractHost)"],
    ["https://app.asana.com:8443/api", "PORT-BLIND by design — extractHost strips ANY port ⇒ non-443 admitted"],
    ["https://APP.Asana.COM/api/1.0/users/me", "mixed-case host ⇒ lowercased whole-host match"],
    ["HTTPS://app.asana.com", "mixed-case https scheme (RFC-3986 §3.1 case-insensitive)"],
  ])("true for %s (%s)", (endpoint) => {
    expect(isAllowedRemoteEndpoint(endpoint, ASANA)).toBe(true);
  });
});

describe("isAllowedRemoteEndpoint — allowlist entries parsed through the SAME vetted extractor", () => {
  // Symmetric parse (Lesson 4 — one authority isolator, both sides): each entry
  // goes through extractHost too, so the compare is between two normal-form bare
  // hosts. A mixed-case / :port / scheme-carrying entry resolves to its host and
  // matches; a null-extracting entry is skipped fail-closed.
  it.each([
    ["https://app.asana.com/api", ["APP.Asana.COM"], "mixed-case entry"],
    ["https://app.asana.com/api", ["app.asana.com:443"], ":port entry ⇒ host"],
    ["https://app.asana.com", ["https://app.asana.com/x"], "scheme+path entry ⇒ host"],
  ])("true: %s matches entry %s (%s)", (endpoint, allow) => {
    expect(isAllowedRemoteEndpoint(endpoint, allow)).toBe(true);
  });

  it.each([
    ["", "empty-string entry ⇒ null-extract ⇒ skipped"],
    ["   ", "whitespace entry ⇒ null-extract ⇒ skipped"],
  ])("false: a null-extracting entry %s (%s) admits nothing", (badEntry) => {
    expect(isAllowedRemoteEndpoint("https://app.asana.com", [badEntry])).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — off-allowlist / substring spoofs (false)", () => {
  // Exact WHOLE-host compare, not substring/suffix: the allowlisted label appearing
  // as a subdomain (suffix spoof) or a substring (prefix spoof) does NOT match.
  it.each([
    ["https://evil.com/api", "off-allowlist host entirely"],
    ["https://app.asana.com.evil.com", "suffix spoof — allowlisted host as a leading label"],
    ["https://evilapp.asana.com", "prefix/substring spoof — allowlisted host as a substring"],
    ["https://asana.com", "parent domain is a DIFFERENT host, not on the allowlist"],
  ])("false for %s (%s)", (endpoint) => {
    expect(isAllowedRemoteEndpoint(endpoint, ASANA)).toBe(false);
  });

  it("empty allowlist ⇒ false even for a well-formed https remote host (nothing admitted by default)", () => {
    expect(isAllowedRemoteEndpoint("https://app.asana.com", [])).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — non-https / TLS required (false)", () => {
  // A bearer token must never ride plaintext; a protocol-relative `//host` carries
  // no TLS guarantee; any non-https scheme is rejected.
  it.each([
    ["http://app.asana.com", "plaintext http"],
    ["//app.asana.com/api", "protocol-relative — no scheme, no TLS guarantee"],
    ["ftp://app.asana.com", "non-http scheme"],
    ["ws://app.asana.com", "websocket scheme"],
    ["app.asana.com", "scheme-less bare host"],
    ["https:app.asana.com", "malformed https (no //authority) ⇒ not a TLS URL"],
  ])("false for %s (%s)", (endpoint) => {
    expect(isAllowedRemoteEndpoint(endpoint, ASANA)).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — SSRF-to-local: loopback rejected (false)", () => {
  // loopback-reject is INDEPENDENT of the allowlist — allowlisting the loopback host
  // itself still rejects, proving isLoopbackHost fires (not merely the allowlist).
  it.each([
    ["https://127.0.0.1", ["127.0.0.1"], "IPv4 loopback, even if allowlisted"],
    ["https://localhost", ["localhost"], "localhost, even if allowlisted"],
    ["https://[::1]", ["::1"], "bracketed IPv6 loopback, even if allowlisted"],
    ["https://127.255.255.254", ["127.255.255.254"], "127.0.0.0/8 upper range, even if allowlisted"],
    ["https://127.0.0.1:443", ["127.0.0.1"], "loopback with explicit port, even if allowlisted"],
  ])("false for %s (%s)", (endpoint, allow) => {
    expect(isAllowedRemoteEndpoint(endpoint, allow)).toBe(false);
  });

  // Loopback-LABEL spoofs are not loopback hosts (extra labels) — they reject on the
  // whole-host allowlist compare against a real allowlist.
  it.each([
    ["https://127.0.0.1.app.asana.com", "prefix trick — loopback literal as a leading label"],
    ["https://localhost.evil.com", "suffix trick — localhost as a leading label"],
  ])("false for %s (%s) against [app.asana.com]", (endpoint) => {
    expect(isAllowedRemoteEndpoint(endpoint, ASANA)).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — userinfo / path spoofs resolve to the true host (false)", () => {
  it("https://app.asana.com@127.0.0.1 ⇒ host is 127.0.0.1 (loopback), NOT app.asana.com", () => {
    // The last-@ userinfo strip (Lesson 4) yields host 127.0.0.1 ⇒ loopback-reject.
    expect(isAllowedRemoteEndpoint("https://app.asana.com@127.0.0.1", ASANA)).toBe(false);
    // even if the operator allowlists the loopback literal, loopback-reject holds.
    expect(isAllowedRemoteEndpoint("https://app.asana.com@127.0.0.1", ["127.0.0.1", "app.asana.com"])).toBe(false);
  });
  it("https://evil.com/@app.asana.com ⇒ host is evil.com (path-@), NOT app.asana.com", () => {
    // The authority is isolated BEFORE the userinfo strip, so the `@` in the PATH
    // never promotes app.asana.com to the host.
    expect(isAllowedRemoteEndpoint("https://evil.com/@app.asana.com", ASANA)).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — fail-closed on unparseable / non-string (false, never throws)", () => {
  it("empty / whitespace / non-string / garbage / empty-authority ⇒ false, never throws", () => {
    expect(isAllowedRemoteEndpoint("", ASANA)).toBe(false);
    expect(isAllowedRemoteEndpoint("   ", ASANA)).toBe(false);
    expect(isAllowedRemoteEndpoint(undefined as unknown as string, ASANA)).toBe(false);
    expect(isAllowedRemoteEndpoint(123 as unknown as string, ASANA)).toBe(false);
    expect(isAllowedRemoteEndpoint("https://", ASANA)).toBe(false); // empty authority
    expect(isAllowedRemoteEndpoint("not a url", ASANA)).toBe(false);
  });
  it("a non-string entry in the allowlist is ignored, not thrown on", () => {
    expect(
      isAllowedRemoteEndpoint("https://app.asana.com", [123 as unknown as string, "app.asana.com"]),
    ).toBe(true);
    expect(isAllowedRemoteEndpoint("https://app.asana.com", [123 as unknown as string])).toBe(false);
  });
});
