<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (KnowledgeWriter, GBrain & GCL)

> Full prose for every lesson logged during work in `packages/knowledge/`. The compact index lives in `packages/knowledge/CLAUDE.md` "Lessons logged" table.
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

## <a id="1"></a>1. A read-only external HTTP transport is a real-I/O adapter behind a mockable transport+secrets seam — SSRF-guard before auth+dispatch reusing the single vetted predicate, token fails closed even when the accessor THROWS, redacted typed faults carry only safe detail, the wire shape is a documented candidate

**Date:** 2026-07-14.
**Source slice:** 13.10 dormant arming-prep Item 2a `cdbb389` (brief 066) — the real `GbrainReadClient` HTTP transport over `gbrain serve --http`.

A read-only external HTTP transport (a `GbrainReadClient` over the loopback `gbrain serve --http`) is built as a real-I/O adapter behind a mockable seam: an injected transport (`send(req, signal?)`) + an injected `SecretsPort`-shaped accessor, both FAKED in unit tests (zero real network / process / Keychain, so the build never touches the real store) and left UNBOUND at boot (`makeDbAdapter → undefined`) so the shipped default is byte-equivalent and the consuming reconcile path degrades (`complete=false`) until the owner binds the real transport at arming.

Four safety properties, each pinned. (1) The SSRF/egress guard runs BEFORE token resolution + dispatch and REUSES the single vetted authority-isolated loopback predicate (`@sow/policy isLoopbackEndpoint`, which `loopbackBind` already reuses) + the caller allowlist — never a re-mirrored copy (a safety predicate lives once — worker Lesson 17; isolate the URL authority before extracting the host — contracts Lesson 4; a spoofed loopback / empty allowlist fails closed). (2) The bearer token is resolved from the grant's `tokenRef` via the injected accessor, header-only, never inlined/logged — and it fails closed not only on a typed `SecretUnavailable` (locked/missing/denied) but ALSO on a THROWING accessor: a real Keychain-backed adapter can THROW rather than return a Result, so wrap the accessor call so an asymmetric-trust escape becomes a redacted `token_unavailable` with NO dispatch (the security-review MEDIUM). (3) A fault is a REDACTED typed error carrying ONLY safe detail (an HTTP status number / the `SecretUnavailable.reason` / an `endpointHostRef` — never the token, raw body, or raw cause), gated by a POSITIVE 2xx check so a non-numeric status fails closed. (4) The vendor wire shape (op→path + the response envelope) is a DOCUMENTED CANDIDATE with a greppable `arch_gap` + a deferred Finding — parsed fail-closed, NEVER hardcoded-as-confirmed (worker Lesson 21: RUN the real surface before trusting its shape; here the real gbrain serve is owner-gated, so confirmation defers to the arming binding). Because the consuming read adapter already provides the `Result` boundary (it wraps `invoke` in try/catch → `transport_fault`), `invoke` may THROW its redacted fault rather than carrying a second Result layer.

**Rule:** build a read-only external HTTP transport as a real-I/O adapter behind a mockable transport+secrets seam (faked in tests, unbound at boot ⇒ byte-equivalent, degrades until the owner binds it); run the SSRF/loopback guard BEFORE auth+dispatch REUSING the single vetted authority-isolated predicate (never re-mirror a safety predicate); resolve the token from a SecretsPort seam header-only + never logged, failing closed on a typed unavailable AND on a THROWING accessor (a real Keychain adapter can throw — wrap it); map every fault to a REDACTED typed error carrying only safe detail (status/reason/host-ref, never token/body/cause) behind a POSITIVE 2xx gate; and treat the vendor wire shape as a DOCUMENTED CANDIDATE (arch_gap + deferred Finding, fail-closed parse, never hardcoded-as-confirmed) until the real surface is run at arming.
