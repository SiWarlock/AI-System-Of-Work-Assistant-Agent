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

## <a id="3"></a>3. Ground every connector's candidate wire shape on Context7 at authoring; back-verify any connector built from memory before that — a candidate authored from training memory can silently defeat its own design intent

**Date:** 2026-07-15.
**Source slice:** task 13.12 round 3 — the Google Drive/Calendar specs (Context7-grounded from the start) + the Asana Context7 correctness-verify (`6908b0b`), which caught a real candidate bug in the round-2 Asana adapter.

A dormant connector's wire shape is a DOCUMENTED CANDIDATE (arch_gap, fail-closed, confirmed at arming) — but "candidate" is not a license to guess. A candidate authored from training memory can be subtly WRONG in a way that silently defeats its own design intent, and the fail-closed parsing won't catch it because the response still parses. Concrete case: the round-2 Asana list query was authored without `opt_fields`; Asana's `GET /tasks` returns COMPACT records (`gid`+`name`) UNLESS fields are named, so `modified_at` — the change token the connector's `contentHash` was DESIGNED to dedupe on — was never returned, degrading the hash to a token-less raw record. Every test passed (the compact record parses fine); only a field-by-field diff against the authoritative Context7 shape surfaced it.

Rule of practice: (1) at authoring, resolve the vendor on Context7 (`resolve-library-id` → `query-docs`; a High-reputation vendor-doc source; WebFetch the vendor docs only as a fallback) and ground the candidate's endpoint/params/pagination/response-shape/id/fault-map on it — not memory or a single fetch. (2) Back-verify any connector built BEFORE this practice with a field-by-field diff; a CONFORMANT axis just gets a Context7-citation comment, a DRIFT axis a proper TDD correction (RED pinning the corrected candidate, still fail-closed/arch_gap). (3) A required-param the vendor enforces but that needs OWNER data (an Asana scope GID, a Google calendarId) is an arming-era gap — NAME it, don't guess it.

**Rule:** ground every connector candidate wire shape on Context7 at authoring (endpoint/params/pagination/response/id/fault-map — never training memory or a single fetch), and back-verify any connector built pre-Context7 with a field-by-field diff (conformant ⇒ citation comment; drift ⇒ a TDD correction, fail-closed) — a memory-authored candidate can silently defeat its own design intent (e.g. a missing `opt_fields` dropping the change token a dedupe hash relies on) while every test still passes; a vendor-required param needing owner data is a NAMED arming gap, not a guess.

## <a id="4"></a>4. Widen `mapPage(json)` → `mapPage(json, request)` additively when a connector pages by page-number/Link-header over a bare-array body — the body-only mapper needs the request cursor

**Date:** 2026-07-15.
**Source slice:** task 13.12 round 5 — the GitHub issues connector (`66b44ee`), the template's first page-number paginator.

The connector template's `mapPage` was born body-only (`mapPage(json)`) because the first connectors (Asana/Drive/Calendar/Granola) return the next-page token IN the response body (`next_page.offset` / `nextPageToken` / `{hasMore, cursor}`). GitHub REST breaks that assumption: it returns a **bare JSON array** and pages via `?per_page&page` + a Link header — the next page is a function of the CURRENT page number, which lives in the request cursor, not the body. A body-only mapper literally cannot compute it.

The fix is to widen the shared seam ADDITIVELY: `ConnectorHttpSpec.mapPage(json)` → `mapPage(json, request: TransportRequest)`, mirroring the existing `buildQuery(request)` signature. Two properties make it safe: (1) **backward-compat by contravariance** — a 1-arg `(json) => R` is assignable to the 2-arg type and the extra arg is a runtime no-op, so the existing specializations stay BYTE-unchanged and their suites stay green (that IS the proof); (2) **rule 7 by construction** — pass the token-free `TransportRequest` (`{cursor?, readScope}`), NEVER a request object carrying the Authorization header/token (the secret rides only `httpRequest.headers.Authorization`); pin it with a template test asserting the mapPage arg has no Authorization key and the token marker appears nowhere. Page-number pagination then: single-source the page size (`buildQuery` emits `per_page=${CONST}` and `mapPage` compares `len < CONST` — a drift wedges paging at page 1), `done = len < per_page`, `nextCursor = String(page+1)`, and a STRICT `^[1-9][0-9]*$` + `Number.isSafeInteger` cursor parse (a coercible `"1e2"` cursor must not become page 100). This pre-pays any future request-context need (R6 Linear's GraphQL cursor).

**Rule:** when a connector pages by page-number/Link-header over a bare-array body (no in-body cursor), widen the shared `mapPage(json)` seam ADDITIVELY to `mapPage(json, request)` rather than fork the template — backward-compatible by function-param contravariance (existing 1-arg mappers byte-unchanged + green = the proof) and rule-7-safe by passing only the token-free `TransportRequest` (pin: no Authorization key / token marker in the mapPage arg). Single-source `per_page` across `buildQuery` + the `done = len < per_page` comparison, and parse the page cursor STRICTLY (`^[1-9][0-9]*$`, no `Number()` coercion) so a tampered cursor fail-safes to page 1.

## <a id="5"></a>5. GraphQL-over-POST read connectors: a fixed query-only body, params via `variables` (never interpolation), fail-closed on the HTTP-200 `errors` array

**Date:** 2026-07-15.
**Source slice:** task 13.12 round 6 — the template POST+body extension (`8a97f44`) + the Linear GraphQL connector (`47fbf99`).

A GraphQL API (Linear) is a single `POST /graphql` with the operation in the JSON body — a different shape from the REST connectors, and it needs extra care: a GraphQL POST endpoint accepts queries AND mutations on the SAME url, and it returns HTTP 200 even on a query error. Three rules make a GraphQL read connector safe:

1. **Query-only, enforced at the SPEC (not the method).** Adding POST to the transport relaxes the type-level "GET ⇒ read-only" guarantee, and the transport can't inspect an opaque GraphQL body to tell a query from a mutation. So the read-only invariant (ING-7) is the SPEC's contract: a FIXED, compile-time, query-only GraphQL document const (a `query`, never a `mutation`/`subscription`) — no code path lets input reach the query text. Pin it with a test asserting the constructed body's query contains no `mutation`. GET stays the template default so no existing connector gains a write-method path; an in-code WARNING documents the relaxation for future POST-connector authors.
2. **Params via `variables`, built with `JSON.stringify` — never string interpolation.** Paging/filter params (cursor, page size) ride the GraphQL `variables` object, and the body is `JSON.stringify({query, variables})` — NEVER concatenating input into the query text. A `"`-bearing / mutation-injection cursor is then escaped verbatim into the variable value (JSON round-trips it) and the query is unchanged. Pin it with a nasty-cursor test (a real `mutation{…}` injection attempt) asserting the cursor lands in `variables.after` and never appears in the query text.
3. **Fail-closed on the HTTP-200 `errors` array.** A GraphQL endpoint returns HTTP 200 even on a query error (`{errors:[…]}`, possibly alongside partial `data`), so the transport's positive-2xx gate passes it. The mapper MUST check for a top-level `errors` BEFORE reading `data` and fail closed (a GraphQL error is not a page; partial data is dropped, not ingested). The HTTP status is NOT the error signal for GraphQL.

SSRF/rule-7 are inherited from the template (the guard runs on the final url method-agnostically; the token is Authorization-header-only, never in the body). A vendor whose auth is NOT a `Bearer` token (Linear personal API keys use a RAW `Authorization: <key>`) is an arming-era per-spec auth-scheme seam, not a build-time concern (the candidate assumes an OAuth2 Bearer token, template-compatible).

**Rule:** for a GraphQL-over-POST read connector, send a FIXED compile-time query-only body (a `query`, never a `mutation`; pinned by a no-`mutation` test), pass all params via `variables` built with `JSON.stringify` (never interpolate input into the query text; pinned by a mutation-injection-cursor test), and fail closed in the mapper on a top-level `errors` array BEFORE reading `data` (a GraphQL endpoint returns HTTP 200 on a query error, so the HTTP status is not the error signal). Read-only is the spec's contract + review, since the transport can't inspect an opaque body.

## <a id="6"></a>6. Untrusted-source content is admitted READ-ONLY at JOB ADMISSION (source-agnostic + fail-closed), NOT at the adapter — verify the admission gate, don't trust the adapter's doc

**Date:** 2026-07-15.
**Source slice:** task 13.12 round 8 — the OSB extractor Context7-verify + ING-7 admission pin (`f21b2b8`).

The source EXTRACTORS (web/podcast/youtube/file) consume UNTRUSTED external content (a prompt-injection surface), so ING-7 requires that any agent consuming that content runs READ-ONLY (no mutating tools). It is tempting to look for that enforcement in the adapter — but the adapters are pure emit-only mapper functions with no tool declaration, so there is NOTHING to strip there; their header comments only DOCUMENT the read-only posture. The real, non-bypassable enforcement lives at **JOB ADMISSION**: `admitJob` (broker step 1, before route/run/egress) gates on `job.trustLevel` (fail-closed — only an explicit `"trusted"` bypasses) AND `admitsMutating(toolPolicy)`, so `!trusted && mutating ⇒ DENY (UNTRUSTED_CONTENT_MUTATING_TOOL)`. Crucially it is **source-type-AGNOSTIC** — it gates on trust + mutation, not on which source produced the content — so it covers every untrusted job uniformly, with no per-source bypass to forget (stronger than a per-source allowlist). When a brief's named symbols are approximate (this brief said `untrustedJob`/`MUTATING_POLICY`; the real ones are `admitJob`/`admitsMutating`/`isTrusted`), TRACE the real code — don't pin against the brief's guess. Pin the enforcement with tests that (a) name the untrusted source types explicitly (a coverage tripwire — even if the gate is agnostic, the test documents the claim and guards against a future per-source bypass) and (b) fail against the plausible breaks (per-source allowlist, truthy-trust coercion, always-deny vacuity).

**Rule:** for untrusted-content read connectors/extractors, the ING-7 read-only guarantee is enforced at JOB ADMISSION (a source-agnostic, fail-closed-on-`trustLevel` `admitJob`-class gate), NOT in the adapter (which only documents it). VERIFY the admission gate by tracing the real symbols (a brief's names may be approximate) and PIN it with tests that name the untrusted source types + fail against per-source-allowlist / truthy-trust / always-deny breaks. A gap where untrusted content could be consumed by a non-read-only job is a safety Finding, not a local fix.
