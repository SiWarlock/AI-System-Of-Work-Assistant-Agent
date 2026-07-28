// §5 route → processor identity (REQ-S-002/S-005). The identity layer beneath
// the egress veto (3.4): it answers "does this route egress, and if so to WHICH
// processor?" so the veto/allowlist can reason over a stable processor id.
//
// PURE — no clock, network, or randomness. FAIL-CLOSED: the tunneled-local hole
// (a route that CLAIMS egressClass 'local' but points at a remote/proxied
// endpoint) is treated as EGRESS, never as safe-local. REDACTION-SAFE: this
// module returns ids only (a ProcessorId or null) — no content.
import type {
  EgressPolicy,
  ProcessorId,
  ProviderId,
  ProviderMatrix,
  ProviderRoute,
} from "@sow/contracts";
import { processorId } from "@sow/contracts";

// The ONLY provider ids that name a genuinely LOCAL (zero-egress) engine. A CLOUD
// provider id (claude/openai/openrouter) can NEVER be laundered into a
// non-egress route by an endpoint claim — the named provider identity wins.
const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["ollama", "lm_studio"]);

// ─── task 9.22 (option C): the two-axis zero-egress claim ─────────────────────
//
// `zeroEgressOnly` is what the app tells its owner about whether their content
// stays on their machine, so it is a POSITIVE SAFETY CLAIM: it is true only when
// BOTH axes hold, and every ambiguous input resolves to `false`. Two separate
// things must go wrong before the app can lie — which holds ONLY because axis 1
// additionally requires the provider matrix to be NON-VACUOUS (the owner's third
// conjunct). Without that, the single absence of provisioning would satisfy both
// axes at once and the pair would collapse to one.
//
// The predicates live HERE, beside LOCAL_PROVIDERS, so callers ASK a question
// instead of reading the set — the set's own contract is that provider IDENTITY
// decides locality (an endpoint claim can never launder a cloud id), and a caller
// re-implementing membership is how a second, weaker answer appears (contracts
// forbidden-pattern #6). LOCAL_PROVIDERS stays module-private.
//
// ⛔ AXIS 2 IS EMPTINESS, NOT LOCAL-MEMBERSHIP. In `egress.ts`, `egressVeto`'s
// normal-allowlist step denies an EGRESSING route whose processor is absent from
// `allowedProcessors`, so an EMPTY allowlist denies every egress route — the
// STRONGEST zero-egress state, not the weakest. And its final fall-through allows
// a genuine loopback-local route WITHOUT consulting the allowlist at all, so a
// local provider never needs to appear in it. Therefore an entry in an EGRESS
// allowlist — `ollama` included — can only mean a REMOTE endpoint approved as a
// destination. Reading `["ollama"]` as "local-only" would assert safety over
// precisely the config that means raw content is leaving. Do not re-invert this.
// (Deliberately cited by function + clause, not by line: a line reference here
// would rot into an argument that reads authoritative and points at nothing.)

/** True IFF `providers` is a DENSE array whose every member is a local zero-egress provider id. */
function everyProviderIsLocal(providers: unknown): boolean {
  if (!Array.isArray(providers)) return false;
  // NOT `.every` — `Array.prototype.every` SKIPS HOLES, so a sparse array would
  // report vacuously true and mint a safety claim out of junk. A hole is
  // malformed input, and malformed never yields a positive claim.
  for (let i = 0; i < providers.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(providers, i)) return false;
    const p: unknown = providers[i];
    if (typeof p !== "string" || p.length === 0) return false;
    if (!LOCAL_PROVIDERS.has(p as ProviderId)) return false;
  }
  // ...and the loop above only inspected `length` entries, so an array-like whose
  // `length` UNDER-reports its contents would hide the rest. Require the own index
  // keys to be exactly `0..length-1`: an unexamined member never rides through.
  return countOwnIndexKeys(providers) === providers.length;
}

/** How many own keys of `value` are canonical array indices (`"0"`, `"1"`, …). */
function countOwnIndexKeys(value: object): number {
  let n = 0;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (String(Number(key)) === key && Number(key) >= 0) n += 1;
  }
  return n;
}

/** True IFF every route configured in `capabilityDefaults` is a genuine loopback-local (non-egress) route. */
function everyCapabilityRouteIsLoopbackLocal(capabilityDefaults: unknown): boolean {
  if (capabilityDefaults === null || typeof capabilityDefaults !== "object") return false;
  if (Array.isArray(capabilityDefaults)) return false;
  const record = capabilityDefaults as Record<PropertyKey, ProviderRoute | undefined>;
  // EVERY own key (not `Object.values`/`Object.keys`) so a route hidden behind a
  // NON-ENUMERABLE or symbol-keyed own property is still inspected — an unexamined
  // route must never ride under a local-only claim. Own keys only, so no inherited
  // prototype member is ever read as a route.
  // The WHOLE scan runs under ONE try: `processorOfRoute` is total for every
  // route the TYPE admits, but it brands the route's raw identity string, and the
  // brand constructor THROWS on a blank one — so `{provider: ""}` (a shape only a
  // deserialized row can produce) escapes as an exception rather than a decision.
  // A throwing input is malformed input, and malformed can only ever mean `false`
  // here; a safety predicate that throws instead of denying is not fail-closed.
  try {
    for (const key of Reflect.ownKeys(record)) {
      const route = record[key];
      // `processorOfRoute` is the routing PROOF (null ⇔ genuinely non-egress); the
      // route's own `egressClass` is only a claim. A malformed/absent route yields
      // a non-null MALFORMED_ROUTE processor, so it fails closed here too.
      if (processorOfRoute(route as ProviderRoute) !== null) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * True IFF BOTH sets the local-only claim quantifies over are NON-EMPTY: at least
 * one allowed provider AND at least one capability route.
 *
 * Named for the property, not for a workflow: this is not "has the operator
 * finished setup" (it reads neither `localProviderPreference` nor
 * `rawCloudEgressEnabled` and validates no shape) — it is precisely
 * NON-VACUITY of the two universally-quantified conditions in
 * {@link isLocalOnlyProviderMatrix}.
 *
 * Both halves are required because each is independently vacuous — an empty
 * `allowedProviders` makes the subset test trivially true, an empty
 * `capabilityDefaults` makes "every route is loopback-local" trivially true — and
 * requiring only one leaves the same hole one level down: route resolution is
 * SOLELY `capabilityDefaults`, so a provider-listed-but-ROUTELESS matrix routes
 * nothing at all.
 *
 * The routes half counts OWN KEYS, not validated routes, which is deliberately
 * looser than it reads. It is sound only in COMPOSITION: the caller also requires
 * every own key to satisfy `processorOfRoute(...) === null`, so "≥1 own key" plus
 * "all keys are genuine loopback routes" together do imply ≥1 real local route.
 * This predicate is not safe to reuse alone as "has routes".
 *
 * ⚠ It DOES under-claim in one honest case: a matrix carrying only RUNTIME-branch
 * routes with an empty `allowedProviders` is a legitimate local-only posture
 * (runtime routes carry no provider and are exempt from the model's subset
 * refine), and it reads `false` here. That is accepted, not overlooked — such a
 * matrix is indistinguishable from a never-configured one, and under-claiming
 * safety is the only direction this field may err.
 */
function isNonVacuousProviderMatrix(matrix: ProviderMatrix): boolean {
  const providers: unknown = matrix.allowedProviders;
  if (!Array.isArray(providers) || providers.length === 0) return false;
  const routes: unknown = matrix.capabilityDefaults;
  if (routes === null || typeof routes !== "object") return false;
  // Under one try for the same reason the route scan is: enumerating a hostile
  // object's keys can THROW, and a safety predicate that throws where it should
  // deny is not fail-closed.
  //
  // `Reflect.ownKeys` (vs `Object.keys`) is NOT load-bearing for safety here — it
  // is deliberately no test's dependency. Either choice denies every hostile
  // shape; they differ only for a matrix whose ONLY route is symbol-keyed or
  // non-enumerable, where `Object.keys` would deny a genuine local route (an
  // under-claim, the safe direction) and neither can produce a spurious `true`.
  // It matches the scan below so the two agree on what counts as a route.
  try {
    return Reflect.ownKeys(routes).length > 0;
  } catch {
    return false;
  }
}

/**
 * AXIS 1 — the workspace's ROUTING pins local: the matrix is actually CONFIGURED,
 * every allowed provider is a local zero-egress engine, every configured capability
 * route is genuinely loopback-local, and raw cloud egress is verified OFF.
 *
 * `rawCloudEgressEnabled` is compared STRICTLY to `false` — an absent or
 * non-boolean flag is not a verified 'off'.
 *
 * ⭐ WHY NON-VACUITY IS A CONJUNCT AND NOT A SEPARATE CONCERN (owner ruling).
 * Both of the conditions above are VACUOUSLY satisfied by an EMPTY matrix, so
 * without this requirement an empty matrix would claim local-only. It must not:
 * an unconfigured workspace claims NOTHING, because the app does not yet know what
 * it routes and not-knowing may never render to its owner as reassurance.
 *
 * ⛔ AND TODAY, EVERY STORED WORKSPACE IS THAT CASE — so this predicate is
 * currently UNSATISFIABLE in production, by construction. `defaultWorkspace()`
 * seeds `{allowedProviders: [], capabilityDefaults: {}}`, and NO code path ever
 * writes a non-empty matrix (the only two writers of the workspace config store
 * are `provisionWorkspace`, which rebuilds from that default, and `egressRevoke`,
 * which touches `egressPolicy` only). So "empty matrix" is not merely the
 * never-provisioned workspace — it is every workspace. `false` is the honest
 * answer for all of them until a real matrix writer exists, and a consumer must
 * read that `false` as UNKNOWN, never as "cloud egress is possible".
 *
 * Pure; malformed ⇒ false. Total over every value the DECLARED type admits and
 * over the absent/wrong-typed shapes that reach it from a deserialized row (the
 * brand never policed those) — the guards below are load-bearing for exactly that
 * reason, not defensive decoration.
 */
export function isLocalOnlyProviderMatrix(matrix: ProviderMatrix): boolean {
  // `== null` covers null AND undefined; permitted against a non-nullable type
  // (the same guard shape `provider-matrix.ts` uses on its typed matrix param).
  if (matrix == null || typeof matrix !== "object") return false;
  if (matrix.rawCloudEgressEnabled !== false) return false;
  if (!isNonVacuousProviderMatrix(matrix)) return false;
  if (!everyProviderIsLocal(matrix.allowedProviders)) return false;
  return everyCapabilityRouteIsLoopbackLocal(matrix.capabilityDefaults);
}

/**
 * AXIS 2 — NO egress destination is approved: both allowlists are EMPTY, so the
 * §5 veto denies every egressing route.
 *
 * This is emptiness, NOT local-membership — see the ⛔ note above. Independent of
 * `employerRawEgressAcknowledged`: consent is not routing, and conflating the two
 * is the original defect this task removes.
 *
 * Pure; malformed ⇒ false (see {@link isLocalOnlyProviderMatrix} on totality).
 */
export function hasNoApprovedEgressDestination(policy: EgressPolicy): boolean {
  if (policy == null || typeof policy !== "object") return false;
  return (
    isEmptyProcessorList(policy.allowedProcessors) &&
    isEmptyProcessorList(policy.rawContentAllowedProcessors)
  );
}

/**
 * True IFF `list` is genuinely an EMPTY array. A non-array is malformed, never
 * "empty"; and a `length` of 0 is not taken on trust — an array-like carrying
 * members under a zeroed `length` would otherwise read as "no destinations
 * approved", which is the exact false assurance this predicate exists to prevent.
 */
function isEmptyProcessorList(list: unknown): boolean {
  return Array.isArray(list) && list.length === 0 && countOwnIndexKeys(list) === 0;
}

/**
 * The composed claim (task 9.22, owner-ruled option C): a workspace is
 * zero-egress-only IFF its routing pins local (axis 1) AND no egress destination
 * is approved (axis 2).
 *
 * ⛔ SCOPE — this answers "can a MODEL-PROVIDER route carry content off this
 * machine?", i.e. exactly the surface `egressVeto` governs. It says NOTHING about
 * connector reads or Tool-Gateway external writes, which reach the network on
 * their own paths and do not consult `egressPolicy.allowedProcessors`. Whatever
 * an operator-facing surface renders from this value must be worded to the same
 * scope; a broader promise ("nothing leaves this machine") would not be derived
 * from the state that governs it.
 *
 * The conjunction lives HERE rather than at each producer on purpose: two
 * producers each composing the axes themselves is the same two-sites-must-agree
 * arrangement this task exists to remove. Callers ask once.
 *
 * The parameter is structural, so a full `Workspace` satisfies it. Callers own
 * everything impure — the store read, the fault path, and the rule that an
 * unreadable workspace claims NOTHING (fail-closed to `false`, never the
 * strongest claim from the state you know least about).
 *
 * ⭐ THE AXES MUST FAIL INDEPENDENTLY, AND THE NON-VACUITY CONJUNCT IS WHAT KEEPS
 * THEM THAT WAY. Provisioning SEEDS both allowlists (`provisionWorkspace` seeds
 * `[claude]`), so "both allowlists empty" is NOT a deliberately-locked-down
 * workspace — it is the never-provisioned (or task-9.29-wiped) one, and that same
 * single absence leaves `providerMatrix` empty too. So without the non-vacuity
 * requirement in {@link isLocalOnlyProviderMatrix}, ONE missing event would
 * satisfy BOTH axes and this predicate would make its strongest claim about the
 * workspace it knows least about — exactly the collapse the two-axis design was
 * chosen to prevent. With it, an unconfigured workspace reports `false`: not yet
 * known, therefore not reassuring.
 *
 * ⛔ CONSEQUENCE FOR WHOEVER WIRES THIS: because no writer populates
 * `providerMatrix` today (see {@link isLocalOnlyProviderMatrix}), this predicate
 * returns `false` for every stored workspace. `false` therefore means UNKNOWN far
 * more often than it means "egress is possible", and a surface that renders it as
 * the latter would assert a posture it has not established — the same defect in
 * the opposite direction.
 *
 * Pure; absent/malformed either half ⇒ false.
 */
export function isZeroEgressOnlyWorkspace(w: {
  egressPolicy: EgressPolicy;
  providerMatrix: ProviderMatrix;
}): boolean {
  if (w == null || typeof w !== "object") return false;
  return isLocalOnlyProviderMatrix(w.providerMatrix) && hasNoApprovedEgressDestination(w.egressPolicy);
}

/** The substring before the earliest of `delimiters`, or the whole string if none occur. */
export function firstSegment(str: string, delimiters: string): string {
  let cut = str.length;
  for (const d of delimiters) {
    const i = str.indexOf(d);
    if (i >= 0 && i < cut) cut = i;
  }
  return str.slice(0, cut);
}

/**
 * Isolate the AUTHORITY (`host[:port]`, lowercased) from an endpoint / URL /
 * Origin string, or null if it can't be reduced to a non-empty authority.
 *
 * THIS IS THE Lesson-4-SAFE URL-authority isolator — the SINGLE vetted copy
 * (root CLAUDE.md Lesson 4). The ORDER of stripping is a SECURITY BOUNDARY:
 *   1. strip an explicit `scheme://` (or protocol-relative `//`) prefix,
 *   2. strip path / query / fragment — delimiter set `/?#\` (backslash is a
 *      path separator under the WHATWG special-scheme rule),
 *   3. strip userinfo — the LAST `@` separates userinfo from host.
 * Step 2 MUST precede step 3: an `@` that appears AFTER the first `/ ? # \` is
 * part of the path/query/fragment, NOT userinfo. Stripping userinfo first was
 * the loopback-spoof hole — `evil.com/@127.0.0.1` was misread as host
 * `127.0.0.1`. Do NOT reorder these steps.
 *
 * The PORT IS PRESERVED (unlike {@link extractHost}) — a port-aware allowlist
 * (e.g. the worker's Origin/Host allowlist whose entries carry `:port`) needs
 * `host:port` so an off-port caller does not collapse onto an on-port entry.
 * Bracketed / bare IPv6 literals are preserved as written (brackets kept).
 * Pure; never throws.
 */
export function extractAuthority(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;

  // Strip an explicit `scheme://` prefix, or a protocol-relative `//` prefix.
  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  const schemePrefix = scheme?.[0];
  if (schemePrefix !== undefined) {
    s = s.slice(schemePrefix.length);
  } else if (s.startsWith("//")) {
    s = s.slice(2);
  }

  // Isolate the AUTHORITY first: strip path / query / fragment. Backslash is a
  // path separator (WHATWG special-scheme rule), so it delimits too. This MUST
  // precede userinfo stripping — an `@` that appears AFTER the first `/ ? # \` is
  // part of the path/query/fragment, NOT userinfo. (Stripping userinfo first was
  // the loopback-spoof hole: `evil.com/@127.0.0.1` was misread as host 127.0.0.1.)
  s = firstSegment(s, "/?#\\");
  if (s.length === 0) return null;

  // Within the authority, strip userinfo (`user:pass@host`) — the LAST `@`
  // separates userinfo from host (WHATWG). The host[:port] is what remains.
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.length === 0) return null;

  return s.toLowerCase();
}

/**
 * Extract the bare host from an endpoint string, or null if unparseable — the
 * {@link extractAuthority} authority with the port stripped (and IPv6 brackets
 * removed). Handles `scheme://`, protocol-relative `//`, `user@`, `host:port`,
 * bracketed IPv6 (`[::1]:port`), bare IPv6 literals, and `/path?query#frag`.
 * Lowercased. Pure; never throws (returns null on anything it can't reduce).
 */
export function extractHost(raw: string): string | null {
  const authority = extractAuthority(raw);
  if (authority === null || authority.length === 0) return null;
  const s = authority;

  // Bracketed IPv6: `[::1]` or `[::1]:port` → the inner literal.
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return null;
    return s.slice(1, close);
  }

  const colons = (s.match(/:/g) ?? []).length;
  // A bare IPv6 literal (no brackets) has ≥2 colons and carries no port → as-is.
  if (colons >= 2) return s;
  // `host:port` → strip the single port.
  if (colons === 1) return s.slice(0, s.indexOf(":"));
  return s;
}

/**
 * True iff `host` is a loopback host: `localhost`, `::1` (and its long form), or
 * an address in the IPv4 127.0.0.0/8 range. The EXACT four-octet match on the
 * 127-range rejects the prefix/suffix spoofs `127.0.0.1.attacker.com` /
 * `localhost.evil.com` (extra labels ⇒ no match). `host` is expected already
 * lowercased (as {@link extractHost} / the worker bind-addr normalizer yield).
 * This is the SINGLE vetted loopback predicate (root CLAUDE.md Lesson 4). Pure.
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv4 loopback range 127.0.0.0/8. The EXACT four-octet match rejects the
  // prefix trick "127.0.0.1.attacker.com" (extra labels ⇒ no match).
  const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  return m.slice(1).every((oct) => {
    const n = Number(oct);
    return n >= 0 && n <= 255;
  });
}

/**
 * Parse an IPv6 literal to its 8 numeric hextets (0..65535), expanding a single `::` and an
 * optional trailing dotted-quad (`::ffff:1.2.3.4`), stripping a zone id (`%eth0`). Returns
 * `null` if it is not a well-formed IPv6 literal. Lower-cased input assumed. Pure.
 */
function parseIpv6Hextets(input: string): number[] | null {
  const core = (input.split("%")[0] ?? "").trim();
  if (!core.includes(":")) return null;

  // A trailing dotted-quad → two hextets appended after the `::` expansion.
  let s = core;
  const v4Tail: number[] = [];
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted !== null) {
    const idx = dotted.index ?? -1;
    if (idx < 0) return null; // defensive: a matched group always has an index
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    v4Tail.push(((o[0] as number) << 8) | (o[1] as number), ((o[2] as number) << 8) | (o[3] as number));
    s = s.slice(0, idx); // leaves a trailing ':' (e.g. "::ffff:")
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  } else if (s.includes(".")) {
    return null; // a stray dot that is not a valid trailing quad
  }

  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length - v4Tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...tail, ...v4Tail];
  } else {
    groups = [...head, ...v4Tail];
  }
  return groups.length === 8 ? groups : null;
}

/**
 * True iff `host` is a PRIVATE / non-publicly-routable target that must NEVER be reached by an
 * outbound connector read — the SSRF denylist that BEATS the allowlist (16.3; mirrors the
 * loopback reject, extended). Expects the host {@link extractHost} yields (scheme/userinfo/port
 * already stripped). Covers, defense-in-depth:
 *   • IPv4: RFC-1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), link-local incl. the
 *     cloud-metadata IP (169.254/16), `0.0.0.0/8`, loopback (127/8 — belt over {@link isLoopbackHost}).
 *     Any NON-canonical numeric-IPv4 form (octal `0177.0.0.1`, hex `0x7f.0.0.1`, short `127.1`,
 *     integer `2130706433`, >255 octet) that a libc/inet_aton resolver could map internally is
 *     FAIL-CLOSED (treated private) — only a clean public decimal dotted-quad is admitted.
 *   • IPv6: loopback/unspecified (`::1`/`::`, any zero-fill spelling), link-local (fe80::/10),
 *     ULA (fc00::/7), and IPv4-mapped/embedded (`::ffff:169.254.169.254`, hex `::ffff:a9fe:a9fe`)
 *     — reduced to the embedded v4 and re-checked. An unparseable IPv6 literal is FAIL-CLOSED.
 *   • Hostnames: `localhost` / `.internal` / `.local` / `.lan` / `.home.arpa` suffixes and a bare
 *     single-label host (resolves via a LOCAL search domain). A trailing FQDN dot is normalized.
 * Fail-CLOSED on empty / malformed. The SINGLE vetted private-range predicate (lives ONCE here per
 * {@link isAllowedRemoteEndpoint}). Host-string only — DNS-rebind + NAT64 (64:ff9b::/96) / 6to4
 * (2002::/16) embedded-v4 (which need gateway/relay infra to reach, not a direct connect) are left
 * to the Phase-23 real-send resolved-IP recheck. Pure.
 */
export function isPrivateHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0) return true; // fail-closed
  const h = host.toLowerCase().trim().replace(/\.+$/, ""); // normalize case, whitespace, trailing dot(s)
  if (h.length === 0) return true; // fail-closed (was only dots / whitespace)

  // Internal / mDNS / non-public hostname suffixes.
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".home.arpa")
  ) {
    return true;
  }

  // A numeric-IPv4 attempt: every dot-separated label is decimal/octal/hex numeric.
  if (!h.includes(":") && /^[0-9a-fx.]+$/.test(h) && /[0-9]/.test(h) && h.split(".").every((l) => /^(0x[0-9a-f]+|\d+)$/.test(l))) {
    const labels = h.split(".");
    const canonical =
      labels.length === 4 && labels.every((l) => /^\d{1,3}$/.test(l) && Number(l) <= 255);
    if (canonical) {
      const [a, b] = labels.map(Number) as [number, number, number, number];
      if (a === 0) return true; //                        0.0.0.0/8 "this host"
      if (a === 10) return true; //                       10.0.0.0/8
      if (a === 127) return true; //                      127.0.0.0/8 loopback (belt)
      if (a === 169 && b === 254) return true; //         169.254.0.0/16 link-local + cloud metadata
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; //         192.168.0.0/16
      if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
      return false; // a publicly-routable IPv4 literal
    }
    return true; // a NON-canonical numeric IPv4 form (octal/hex/short/integer/oversized) ⇒ fail-closed
  }

  // IPv6 literal.
  if (h.includes(":")) {
    const g = parseIpv6Hextets(h);
    if (g === null) return true; // unparseable IPv6 literal ⇒ fail-closed
    if (g.every((x) => x === 0)) return true; //                         :: unspecified
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
    if ((g[0] as number) >= 0xfe80 && (g[0] as number) <= 0xfebf) return true; // link-local fe80::/10
    if ((g[0] as number) >= 0xfc00 && (g[0] as number) <= 0xfdff) return true; // ULA fc00::/7
    // IPv4-mapped (`::ffff:a.b.c.d`) or -compatible (high 96 bits zero): reduce to the v4.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
      const g6 = g[6] as number;
      const g7 = g[7] as number;
      return isPrivateHost(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`);
    }
    return false; // a publicly-routable IPv6 literal
  }

  // A bare single-label host (no dot, not an IP) — resolves via a LOCAL search domain.
  if (!h.includes(".")) return true;

  return false; // a dotted public hostname (FQDN)
}

/**
 * True ONLY for a loopback endpoint — one that provably cannot leave the machine:
 * `localhost`, the 127.0.0.0/8 range, `::1`, or a unix-socket path (`/abs/path`
 * or `unix://…`). FALSE for any remote / proxied / DNS / all-interfaces
 * (`0.0.0.0`) host, and FALSE (fail-closed) for empty / unparseable input.
 *
 * `egressClass` is a CLAIM; this function is the PROOF the veto trusts. Adversarial
 * cases it must reject: the prefix trick (`127.0.0.1.attacker.com`), the suffix
 * trick (`localhost.evil.com`), `0.0.0.0` (remotely reachable), and a
 * protocol-relative `//evil.com`. Pure; never throws.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string") return false;
  const raw = endpoint.trim();
  if (raw.length === 0) return false;

  // Unix-domain-socket / file scheme. On-machine ONLY when it carries no REMOTE
  // authority. `unix://host/…` / `file://host/…` with a non-empty authority must
  // resolve to a loopback host (fail-closed against a remote-authority exfil
  // claim like `file://evil.com/…`); `file:///path` (empty authority) and the
  // non-`//` path forms below are on-machine.
  const fileAuthority = raw.match(/^(?:unix|file):\/\//i);
  if (fileAuthority !== null) {
    const authority = firstSegment(raw.slice(fileAuthority[0].length), "/?#\\");
    if (authority.length === 0) return true; // file:///path — empty authority
    const at = authority.lastIndexOf("@");
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    const host = firstSegment(hostPort, ":").toLowerCase();
    return host.length > 0 && isLoopbackHost(host);
  }
  // Unix domain socket / filesystem path — inherently on-machine. A single
  // leading "/" is an absolute path; "//" is a protocol-relative URL (NOT a
  // socket) and falls through to host parsing. `unix:`/`file:` (no `//authority`)
  // are explicit on-machine paths.
  if (raw.startsWith("unix:") || raw.startsWith("file:")) return true;
  if (raw.startsWith("/") && !raw.startsWith("//")) return true;

  const host = extractHost(raw);
  if (host === null) return false; // fail-closed: unparseable ⇒ not loopback
  return isLoopbackHost(host);
}

/**
 * True iff `endpoint` is an admissible OUTBOUND connector-egress target — the
 * INVERSE safety posture of {@link isLoopbackEndpoint}. A bearer-token-carrying
 * connector request (Asana; Granola / Drive / Calendar / … later) may egress
 * ONLY to an allowlisted, TLS, REMOTE host. Returns `true` IFF ALL hold:
 *   1. the scheme is exactly `https:` (a bearer token must never ride plaintext
 *      `http:`, and a protocol-relative `//host` carries no TLS guarantee ⇒ false);
 *   2. the endpoint reduces to a host ({@link extractHost} !== null);
 *   3. the host is NOT loopback ({@link isLoopbackHost} false) — SSRF-to-local
 *      defense: the 127.0.0.0/8 range, `localhost`, `::1`, and the prefix/suffix
 *      spoofs the vetted predicate already rejects;
 *   4. the host is on `allowedHosts` by EXACT whole-host match — a substring /
 *      suffix appearance of an allowlisted label (`app.asana.com.evil.com`,
 *      `evilapp.asana.com`) does NOT match.
 *
 * COMPOSES the SINGLE vetted parse primitives ({@link extractHost}, which itself
 * runs {@link extractAuthority}, and {@link isLoopbackHost}) — it MUST NOT
 * re-parse URLs (re-parsing was the loopback-spoof hole `evil.com/@127.0.0.1`
 * those primitives close; root CLAUDE.md Lesson 4). The `https://` scheme check
 * is on the RAW string — a scheme test, orthogonal to (not a re-parse of) the
 * host authority.
 *
 * `allowedHosts` entries are bare, lowercased hosts by contract; each is run
 * through the SAME `extractHost` (symmetric parse — both sides in one normal
 * form), so a `:port` / mixed-case / scheme-carrying entry resolves to its host,
 * and a null-extracting (empty / non-string) entry is skipped fail-closed.
 *
 * DEFENSE-IN-DEPTH scope: the exact-host allowlist is the PRIMARY control;
 * loopback-reject is layered on. The host compare is PORT-BLIND by design —
 * `extractHost` strips the port, so ANY port on an allowlisted host is admitted
 * (connectors hit vendor APIs on 443; a port-aware variant would compose the
 * port-preserving `extractAuthority` instead). DENYLIST (beats the allowlist, 16.3):
 * the layered {@link isLoopbackHost} reject PLUS {@link isPrivateHost} now block
 * RFC-1918 / CGNAT / link-local + cloud-metadata / IPv6 ULA+link-local / internal
 * hostnames — including non-canonical numeric IPv4 (octal/hex/short/integer) and
 * non-canonical IPv6 (compressed / hex IPv4-mapped) forms, which fail CLOSED — even
 * if a spec misconfigures its allowlist. ARCH_GAP (arming-era residual, NARROWED):
 * only DNS REBINDING remains — a hostname/host-STRING check cannot see the resolved
 * IP, so the injected REAL `HttpTransport` at the Phase-23 connector arming gate must
 * additionally pin/validate the RESOLVED IP (re-running `isPrivateHost` on it). Pure;
 * never throws.
 */
export function isAllowedRemoteEndpoint(
  endpoint: string,
  allowedHosts: readonly string[],
): boolean {
  if (typeof endpoint !== "string") return false;
  const raw = endpoint.trim();
  if (raw.length === 0) return false;

  // Scheme MUST be exactly `https://` (case-insensitive per RFC-3986 §3.1 — the
  // `://` requires two slashes, so `https:/x` and `https:x` reject). A bearer
  // token requires TLS: `http:`, a protocol-relative `//host`, or any other
  // scheme fails closed. Checked on the RAW string — the parse primitives strip
  // the scheme by design, so it can't be re-derived from the host.
  if (!/^https:\/\//i.test(raw)) return false;

  const host = extractHost(raw);
  if (host === null) return false; // fail-closed: unparseable ⇒ inadmissible
  if (isLoopbackHost(host)) return false; // SSRF-to-local defense (beats the allowlist)
  // SSRF private-range defense (16.3): RFC-1918 / CGNAT / link-local + cloud-metadata /
  // IPv6 ULA+link-local / internal hostnames are refused EVEN IF a misconfigured spec
  // allowlisted them — the denylist BEATS the allowlist, exactly like the loopback reject.
  if (isPrivateHost(host)) return false;

  // Exact whole-host match. Both sides pass through extractHost so the compare is
  // between two normal-form bare hosts; a non-string / null-extracting entry is
  // skipped (never admitted, never thrown on).
  for (const allowed of allowedHosts) {
    if (typeof allowed !== "string") continue;
    if (extractHost(allowed) === host) return true;
  }
  return false;
}

/**
 * A REDACTION-SAFE audit ref for a route endpoint: the HOST only (scheme,
 * userinfo, port, and path stripped). A `user:pass@host` basic-auth endpoint
 * therefore never leaks its credential into the audit / System-Health stream
 * (safety rule 7 / §16). Unparseable ⇒ a fixed marker. Pure.
 */
export function endpointHostRef(endpoint: string): string {
  const host = typeof endpoint === "string" ? extractHost(endpoint) : null;
  return `ref:endpoint-host:${host ?? "UNPARSEABLE"}`;
}

/**
 * The processor a route egresses to, or `null` for a genuine NON-EGRESS
 * loopback-local route.
 *
 * Returns `null` IFF ALL hold: `egressClass === 'local'` AND the endpoint is a
 * loopback endpoint AND the route is either a LOCAL provider (ollama / lm_studio)
 * or a runtime (a runtime bound to loopback). Otherwise the route EGRESSES and a
 * DISTINCT ProcessorId is returned:
 *   - provider branch → `processorId(provider)` — OpenRouter is its OWN processor
 *     (`'openrouter'`), NEVER an OpenAI alias; claude→'claude'; openai→'openai'; …
 *   - runtime branch  → `processorId(runtime)`.
 *
 * CRITICAL fail-closed edge (the tunneled-local hole): a route with
 * `egressClass === 'local'` but a NON-loopback / remote / proxied endpoint is
 * treated as EGRESS — it returns a processor, NOT null — so a 'local' claim can
 * never launder an exfiltration endpoint past the veto. Likewise a CLOUD provider
 * id claiming local+loopback still egresses (the named provider wins). Pure.
 */
export function processorOfRoute(route: ProviderRoute): ProcessorId | null {
  // Read through an untyped view so the fail-closed guards hold even for a value
  // the static ProviderRoute type would forbid (null / neither-key / both-keys) —
  // a malformed route must NEVER be classified non-egress.
  const r = route as unknown as {
    provider?: unknown;
    runtime?: unknown;
    endpoint?: unknown;
    egressClass?: unknown;
  } | null;
  if (r === null || typeof r !== "object") {
    return processorId("MALFORMED_ROUTE"); // egress, never non-egress
  }
  const hasProvider = typeof r.provider === "string";
  const hasRuntime = typeof r.runtime === "string";
  // A well-formed ProviderRoute is EXACTLY one of provider|runtime. Neither or
  // both ⇒ malformed ⇒ treated as EGRESS (closes the no-port loopback edge).
  if (hasProvider === hasRuntime) {
    return processorId("MALFORMED_ROUTE");
  }
  const identity = (hasProvider ? r.provider : r.runtime) as string;

  // Non-egress requires BOTH the 'local' claim AND loopback PROOF. egressClass
  // alone is never trusted — that is the tunneled-local hole.
  const loopbackLocal =
    r.egressClass === "local" &&
    typeof r.endpoint === "string" &&
    isLoopbackEndpoint(r.endpoint);

  if (loopbackLocal) {
    // A runtime bound to loopback is a genuine non-egress engine.
    if (hasRuntime) return null;
    // A provider-branch route is non-egress ONLY for a genuinely local provider;
    // a cloud provider id (claude/openai/openrouter) is a cloud processor by
    // identity even when it claims loopback (fail-closed).
    if (LOCAL_PROVIDERS.has(r.provider as ProviderId)) return null;
  }

  // Egress: a distinct processor id per destination. No aliasing.
  return processorId(identity);
}
