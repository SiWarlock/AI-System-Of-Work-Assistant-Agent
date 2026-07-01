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
import { isLoopbackEndpoint, processorOfRoute } from "../src/processors";

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
