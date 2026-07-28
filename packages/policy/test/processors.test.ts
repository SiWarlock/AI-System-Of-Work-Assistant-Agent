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
import { isAllowedRemoteEndpoint, isLoopbackEndpoint, isPrivateHost, processorOfRoute } from "../src/processors";

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

describe("processorOfRoute — TOTAL: a malformed identity denies, never throws (task #25)", () => {
  // `processorOfRoute` BRANDS the route's raw identity, and the brand constructor
  // throws on a blank/whitespace string. A route like `{provider: ""}` cannot come
  // from a type-checked construction, but it can arrive from a deserialized row or
  // a hand-built policy object — neither of which the brand ever policed.
  //
  // This module documents itself PURE and FAIL-CLOSED, and it is the identity layer
  // beneath the §5 egress veto. A throw here is not a safe crash: it hands the veto
  // an exception where it owes a typed decision, so the classification a rule-5 gate
  // depends on never happens. Malformed input must classify as EGRESS
  // (MALFORMED_ROUTE) — the same answer the neither/both-keys branches already give.
  for (const identity of ["", "   ", "\t"]) {
    for (const branch of ["provider", "runtime"] as const) {
      it(`a blank ${branch} (${JSON.stringify(identity)}) ⇒ EGRESS, not a throw`, () => {
        const route = {
          [branch]: identity,
          model: "m",
          endpoint: "https://remote.example.com",
          egressClass: "cloud",
        } as unknown as ProviderRoute;
        expect(() => processorOfRoute(route)).not.toThrow();
        expect(processorOfRoute(route)).not.toBeNull();
      });
    }
  }

  it("a blank identity CLAIMING loopback-local is still EGRESS — the claim never rescues it", () => {
    // The dangerous shape: a blank id on a genuine loopback endpoint. If a blank
    // identity ever resolved to null it would read as "non-egress", and the veto's
    // loopback fall-through would ALLOW raw employer content on an unidentifiable
    // route. Fail-closed means EGRESS here, not null.
    const route = {
      provider: "",
      model: "m",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    } as unknown as ProviderRoute;
    expect(() => processorOfRoute(route)).not.toThrow();
    expect(processorOfRoute(route)).not.toBeNull();
  });

  it("an identity read TWICE cannot launder a cloud provider to non-egress", () => {
    // ⛔ The sharpest shape. The identity is read through an untyped view, so a
    // route with an ACCESSOR can answer differently on each read: `openai` when
    // asked "is this a string / which processor?", `ollama` when asked "is this in
    // LOCAL_PROVIDERS?". Re-reading meant the membership test could pass for a
    // value the classification never saw — a CLOUD provider resolving to `null`
    // (non-egress), which walks straight through the §5 veto's loopback
    // fall-through carrying raw employer content. Capture-once closes it.
    // ⚠ The threshold is exact and load-bearing. Capture-once performs ONE read, so
    // the getter must flip on read TWO — the read a re-introduced membership
    // re-read would perform. A later threshold (">= 3") is never reached under
    // either version, and the test passes for both: green, and blind. Verified by
    // mutation, not by inspection.
    let reads = 0;
    const route = {
      model: "m",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
      get provider(): string {
        reads += 1;
        return reads >= 2 ? "ollama" : "openai";
      },
    } as unknown as ProviderRoute;
    expect(processorOfRoute(route)).not.toBeNull();
    expect(reads).toBe(1); // the capture-once property itself
  });

  it("a well-formed local route is the positive control — still null", () => {
    // Proves the totality fix did not simply make everything EGRESS.
    expect(processorOfRoute(providerRoute("ollama", "http://127.0.0.1:11434", "local"))).toBeNull();
  });

  it("the guard tracks the BRAND's predicate, not a list of blank-looking strings", () => {
    // Established empirically, not assumed: `makeId` rejects
    // `typeof raw !== "string" || raw.trim().length === 0`, and `String.prototype.trim`
    // strips FAR more than the space character — NBSP, BOM/ZWNBSP, the U+2000 quad
    // family, IDEOGRAPHIC SPACE, LINE/PARA SEPARATOR, VTAB and FORM FEED all trim to
    // empty and therefore all THROW. The original defect was one step past where
    // anyone looked, so the guard reuses the brand's OWN predicate rather than
    // enumerating blank forms — an enumeration here would be the unwinnable-denylist
    // pattern this project has retired twice, and every id below is one a denylist
    // written against `""` would have missed.
    for (const blank of [
      // ESCAPES, not literal characters: a raw newline inside a string literal is
      // a syntax error, and a syntax-broken test file reports `PASS (0)` — green,
      // and contributing nothing. Caught here by a suite count that DROPPED.
      " ", // U+0020 space
      "\t", // U+0009 tab
      "\n", // U+000A newline
      "\v", // U+000B vertical tab
      "\f", // U+000C form feed
      "\r", // U+000D carriage return
      "\u00A0", // NBSP
      "\uFEFF", // BOM / ZWNBSP
      "\u2000", // EN QUAD
      "\u3000", // IDEOGRAPHIC SPACE
      "\u2028", // LINE SEPARATOR
      "\u2029", // PARAGRAPH SEPARATOR
    ]) {
      const route = {
        provider: blank,
        model: "m",
        endpoint: "https://remote.example.com",
        egressClass: "cloud",
      } as unknown as ProviderRoute;
      const hex = `U+${(blank.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;
      expect(() => processorOfRoute(route), hex).not.toThrow();
      expect(processorOfRoute(route), hex).not.toBeNull();
    }

    // The complement, which keeps the above from reading as "anything odd is blank":
    // these are NOT whitespace per ECMA-262, so they do NOT trim away, the brand
    // ACCEPTS them, and they classify as ordinary EGRESS. Fail-closed either way.
    for (const notBlank of ["\u200B", "\u200D", "\u0000", "\u180E"]) {
      const route = {
        provider: notBlank,
        model: "m",
        endpoint: "https://remote.example.com",
        egressClass: "cloud",
      } as unknown as ProviderRoute;
      expect(() => processorOfRoute(route)).not.toThrow();
      expect(processorOfRoute(route)).not.toBeNull();
    }
  });
});

// ── the no-drift pin ─────────────────────────────────────────────────────────
describe("processorOfRoute — NO DRIFT: the totality fix moved no well-formed classification", () => {
  // ⛔ THE SAFETY-CRITICAL PIN of the totality slice. Making a throwing function
  // total is only safe if it changes throw→deny and NOTHING else: a well-formed
  // route that silently moved from EGRESS to non-egress would be a rule-5
  // regression wearing a totality fix as cover, and the suite would still be green
  // because the malformed cases are what everyone is looking at.
  //
  // Every row is a route the TYPE admits (no blank identity anywhere), asserted
  // against the classification it had BEFORE the fix.
  const rows: ReadonlyArray<readonly [string, ProviderRoute, "null" | "processor"]> = [
    ["local provider on loopback", providerRoute("ollama", "http://127.0.0.1:11434", "local"), "null"],
    ["local provider on localhost", providerRoute("lm_studio", "http://localhost:1234", "local"), "null"],
    ["runtime on loopback", runtimeRoute("http://127.0.0.1:9000", "local"), "null"],
    ["cloud provider, cloud class", providerRoute("claude", "https://api.anthropic.com", "cloud"), "processor"],
    ["openai cloud", providerRoute("openai", "https://api.openai.com", "cloud"), "processor"],
    ["openrouter cloud", providerRoute("openrouter", "https://openrouter.ai/api/v1", "cloud"), "processor"],
    ["runtime, cloud class", runtimeRoute("https://api.anthropic.com", "cloud"), "processor"],
    // The tunneled-local hole: 'local' CLAIM, remote endpoint ⇒ EGRESS. The single
    // most important row — if totality had made the claim authoritative, this flips.
    ["tunneled-local (remote endpoint)", providerRoute("ollama", "https://exfil.example.com:11434", "local"), "processor"],
    ["local-claiming host-suffix spoof", providerRoute("ollama", "http://127.0.0.1.attacker.com", "local"), "processor"],
    // A CLOUD provider id claiming loopback: identity wins over endpoint.
    ["cloud id on loopback", providerRoute("openai", "http://127.0.0.1:1234", "local"), "processor"],
  ];

  for (const [label, route, expected] of rows) {
    it(`${label} ⇒ ${expected} (unchanged)`, () => {
      const got = processorOfRoute(route);
      if (expected === "null") expect(got).toBeNull();
      else expect(got).not.toBeNull();
    });
  }
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

// ── isPrivateHost — SSRF private-range denylist (16.3) ───────────────────────────
// The vetted loopback predicate already beats the allowlist; `isPrivateHost` extends the
// SAME defense-in-depth denylist to RFC-1918, CGNAT, link-local (incl. the 169.254.169.254
// cloud metadata IP), IPv6 ULA/link-local, and internal hostname suffixes — so a
// MISCONFIGURED allowlist can never let a connector reach an internal/metadata endpoint.
describe("isPrivateHost — blocks private / link-local / metadata / ULA / internal (true)", () => {
  it.each([
    ["10.0.0.1", "RFC-1918 10/8"],
    ["10.255.255.255", "RFC-1918 10/8 upper"],
    ["172.16.0.1", "RFC-1918 172.16/12 lower"],
    ["172.31.255.255", "RFC-1918 172.16/12 upper"],
    ["192.168.1.1", "RFC-1918 192.168/16"],
    ["169.254.169.254", "link-local / cloud metadata IP"],
    ["169.254.0.1", "link-local 169.254/16"],
    ["100.64.0.1", "CGNAT 100.64/10"],
    ["127.0.0.1", "IPv4 loopback"],
    ["0.0.0.0", "0.0.0.0/8 this-host"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local fe80::/10"],
    ["fc00::1", "IPv6 ULA fc00::/7 (fc)"],
    ["fd12:3456::1", "IPv6 ULA fc00::/7 (fd)"],
    ["::ffff:10.0.0.1", "IPv4-mapped IPv6 of a private v4"],
    ["localhost", "localhost name"],
    ["foo.internal", ".internal suffix"],
    ["db.local", ".local (mDNS) suffix"],
    ["intranet", "single-label host (local search domain)"],
  ])("blocks %s (%s)", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });
});

describe("isPrivateHost — allows public hosts (false)", () => {
  it.each([
    ["8.8.8.8", "public v4"],
    ["1.1.1.1", "public v4"],
    ["172.15.0.1", "just below the 172.16/12 block"],
    ["172.32.0.1", "just above the 172.16/12 block"],
    ["192.169.0.1", "just outside 192.168/16"],
    ["169.253.0.1", "just outside 169.254/16"],
    ["100.63.0.1", "just below CGNAT 100.64/10"],
    ["100.128.0.1", "just above CGNAT 100.64/10"],
    ["app.asana.com", "public FQDN"],
    ["www.googleapis.com", "public FQDN"],
    ["2606:4700:4700::1111", "public IPv6"],
  ])("allows %s (%s)", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe("isAllowedRemoteEndpoint — SSRF: a private/metadata host is rejected EVEN IF allowlisted (denylist beats allowlist)", () => {
  it.each([
    ["https://169.254.169.254/latest/meta-data/", "169.254.169.254", "cloud metadata IP"],
    ["https://10.0.0.5/internal", "10.0.0.5", "RFC-1918"],
    ["https://192.168.0.1/admin", "192.168.0.1", "RFC-1918"],
    ["https://vault.internal/secret", "vault.internal", ".internal host"],
    ["https://[fd00::1]/x", "fd00::1", "IPv6 ULA"],
  ])("rejects %s even when %s is on the allowlist (%s)", (url, host) => {
    // A misconfigured spec that allowlisted the internal host must STILL be refused.
    expect(isAllowedRemoteEndpoint(url, [host])).toBe(false);
  });
});

// Adversarial SSRF-evasion vectors (security review, 16.3) — non-canonical encodings that a
// libc/inet_aton resolver or the OS could still route internally must FAIL CLOSED (private).
describe("isPrivateHost — adversarial non-canonical encodings fail closed (true)", () => {
  it.each([
    // Non-canonical IPv6 literals that reduce to an internal target.
    ["::ffff:a9fe:a9fe", "hex IPv4-mapped 169.254.169.254 (metadata)"],
    ["::ffff:7f00:1", "hex IPv4-mapped 127.0.0.1 (loopback)"],
    ["::ffff:0a00:0001", "hex IPv4-mapped 10.0.0.1 (RFC-1918)"],
    ["::ffff:169.254.169.254", "dotted IPv4-mapped metadata"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "fully-expanded ::1"],
    ["fe80::1%eth0", "link-local with a zone id"],
    ["FE80::1", "uppercase link-local"],
    // Legacy inet_aton IPv4 forms.
    ["0177.0.0.1", "octal 127.0.0.1"],
    ["127.1", "short-form 127.0.0.1"],
    ["10.1", "short-form 10.0.0.1"],
    ["0x7f.0.0.1", "hex-octet 127.0.0.1"],
    ["2130706433", "integer 127.0.0.1"],
    ["256.0.0.1", "oversized octet ⇒ fail-closed"],
    ["999.1.1.1", "oversized octet ⇒ fail-closed"],
    // Trailing-dot absolute FQDNs.
    ["localhost.", "trailing-dot localhost"],
    ["metadata.google.internal.", "trailing-dot .internal"],
    ["db.local.", "trailing-dot .local"],
    // Whitespace.
    [" 127.0.0.1", "leading-space loopback"],
  ])("blocks %s (%s)", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([["" as unknown as string, "empty"], [undefined as unknown as string, "undefined"], [null as unknown as string, "null"], [42 as unknown as string, "number"]])(
    "fail-closed on a malformed host %s (%s)",
    (host) => {
      expect(isPrivateHost(host)).toBe(true);
    },
  );
});

describe("isPrivateHost — a public IPv6 with a dotted low-32 tail is NOT over-blocked (false)", () => {
  it.each([
    ["2001:db8::10.0.0.1", "public 2001:db8:: whose low bits render as 10.0.0.1"],
    ["2606:4700:4700::1111", "public Cloudflare IPv6"],
  ])("allows %s (%s)", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
