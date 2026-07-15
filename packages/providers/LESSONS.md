<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (providers, policy & integration gateways)

> Full prose for every lesson logged during work in `packages/providers/`. The compact index lives in `packages/providers/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. Hermes empty toolset → full mutating fallback — read-only Hermes runs MUST pass an explicit minimal toolset

**Date:** 2026-06-30.
**Source slice:** Phase-0 spike 0.3 — Hermes adapter surface (`docs/spikes/0.3-hermes-surface.md`).

During the Phase-0 Hermes adapter-surface spike (run live against the installed Hermes 0.17.0 via OpenRouter/DeepSeek-V4-Pro), the bounded meeting-close mock confirmed Hermes can be driven as a one-shot CLI subprocess with controlled tools (`hermes chat -q <prompt> -Q -t <toolset> -m <model> --provider <p> --max-turns N`), and that `-Q` emits clean parseable JSON, stop/cancel works (a SIGTERM mid-inference exits 124 with zero stdout → nothing reaches the schema gate = COST-1 cancel-with-no-partial-side-effect), and `-t clarify` restricts the run to a minimal toolset.

The sharp caveat: Hermes's `oneshot.py` `_normalize_toolsets` returns `None` for an **empty** `-t`, which falls back to the user's **full configured toolset — including mutating tools.** So "I passed `-t`, therefore the run is contained" is **false** when the toolset is empty: an empty toolset is maximally permissive, not minimally. This directly threatens the ING-7 untrusted-content invariant (a job consuming imported/untrusted content must run read-only / no mutating tools) and the candidate-data gate (a mutating Hermes tool could create an external side effect outside the Tool Gateway envelope).

Apply this when wiring the `HermesRuntimeAdapter`: a read-only or untrusted-content (ING-7) Hermes run MUST construct an **explicit minimal toolset** (seeded at a known read-only set, e.g. `clarify`) and assert it is **non-empty** before dispatch; admission must reject a Hermes `AgentJob` whose resolved toolset is empty or whose `ToolPolicy.allowsMutating` disagrees with the passed `-t`. Open edge case: the toolset semantics are a Hermes-version-specific behavior (observed on 0.17.0) — re-verify against the pinned Hermes version in the §12 runtime-adapter conformance suite, and treat a version bump as a re-validation trigger.

**Rule:** A read-only / untrusted-content (ING-7) Hermes run MUST pass an explicit, asserted-non-empty minimal toolset; an empty `-t` silently falls back to the user's full (mutating) config toolset.

## <a id="2"></a>2. A real read-only connector HTTP transport is a reusable `createConnectorHttpTransport(spec, deps)` over a vetted OUTBOUND SSRF predicate; connectors specialize with a per-vendor spec; the real transport+secrets stay UNBOUND at boot

**Date:** 2026-07-15.
**Source slice:** task 13.12 connector round 2 — slice 1 `c2c6525` (`@sow/policy` `isAllowedRemoteEndpoint`) + slice 2 `47c55c2` (`@sow/integrations` `createConnectorHttpTransport` + `createAsanaHttpTransport`).

The V1 connector adapters are built read-only over an injected `ConnectorTransport` (`makeConnector` base), but the only real transport in the tree was `createFileReadTransport` — every remote adapter was dormant. Giving them a real read-only HTTP transport is TWO reusable pieces, both mirroring the GbrainReadClient (knowledge Lesson 1) but for the OUTBOUND direction.

**(A) The SSRF predicate is the OUTBOUND INVERSE of the loopback guard.** gbrain's transport requires LOOPBACK (`isLoopbackEndpoint`); a connector requires an ALLOWLISTED REMOTE host and must REJECT loopback (SSRF-to-local). `isAllowedRemoteEndpoint(endpoint, allowedHosts)` = https + exact whole-host allowlist + non-loopback, **composed once** from the vetted `extractHost`/`isLoopbackHost` (root CLAUDE.md Lesson 4 — a safety predicate lives once; never re-parse a URL, because the parse is where the `evil.com/@127.0.0.1` userinfo-spoof holes live and are already closed). The exact-host allowlist is the primary control; loopback-reject is defense-in-depth. A hostname allowlist alone CANNOT catch DNS-rebinding — resolved-IP pinning + an `isPrivateHost` (RFC-1918/link-local/ULA) predicate are documented `arch_gap` residuals finalized when the real transport (which does the actual DNS resolution) binds at arming.

**(B) The transport is a reusable template, not a per-connector one-off.** `createConnectorHttpTransport(spec, deps): ConnectorTransport` runs: SSRF-guard-FIRST on the FINAL constructed URL (not just the base — so a crafted/tampered cursor can never smuggle an authority) → token from an injected `SecretsAccessor` (Authorization-header-only, never logged, fail-closed even when the accessor THROWS) → GET only (ING-7 read-only — type the method as the literal `"GET"` with no body) → a positive-2xx gate (a non-integer status fails closed) → parse → `spec.mapPage`. Every fault RETURNS a REDACTED typed `TransportFailure` (never throws across the `ConnectorTransport` seam; never the token/body/raw-cause — rule 7). The per-vendor `spec` carries `{baseUrl, allowedHosts, resourcePath, buildQuery, mapPage}`; the spec callbacks are WRAPPED in try/catch so a future throwing specialization can't escape unredacted (a reusable-boundary hardening). Reuse the canonical `payloadHash` for the `contentHash` (never hand-roll). `readScope` stays on the ADAPTER (`makeConnector({readScope})` → `request.readScope`), NOT the spec — a dual source drifts. The vendor wire shape is a documented `arch_gap` candidate (parsed fail-closed — a missing/renamed field is a `TransportFailure`, never a false page), confirmed at arming.

**Dormancy:** the real `HttpTransport` + `SecretsAccessor` + vendor token stay UNBOUND at boot (zero production importers ⇒ byte-equivalent); binding a real transport (real external network I/O) is the owner's arming HARD LINE. `@sow/integrations` does not depend on `@sow/providers`, so the small `HttpTransport`/`SecretsAccessor` seams are re-declared locally (mirror GbrainReadClient's same-reason re-declaration).

**Rule:** build a real read-only connector HTTP transport as a reusable `createConnectorHttpTransport(spec, deps)` producing a `ConnectorTransport` — SSRF-guard (the vetted OUTBOUND-inverse `isAllowedRemoteEndpoint`, composed once, never re-parse) on the FINAL url BEFORE token+dispatch · token header-only/fail-closed-even-on-throw · redacted typed `TransportFailure` behind a positive-2xx gate · wrapped spec callbacks · vendor wire shape a documented `arch_gap` candidate · ING-7 GET-only · `payloadHash` for the contentHash · `readScope` single-sourced at the adapter; the real transport+secrets stay UNBOUND at boot (byte-equivalent), and every connector specializes it with a per-vendor spec.
