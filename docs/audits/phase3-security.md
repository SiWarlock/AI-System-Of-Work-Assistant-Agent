# Phase 3 Security Audit — Policy, Security & Egress (`@sow/policy`)

- **Scope:** all of `packages/policy/src` (13 modules) + `packages/policy/test` (13 files).
- **Commit reviewed:** `bc18914` (working tree clean for `packages/policy`).
- **Gates:** `pnpm --filter @sow/policy exec vitest run` → **173 passed (13 files)**; `pnpm --filter @sow/policy typecheck` → **clean**.
- **Safety rules covered:** 4 (workspace isolation), 5 (Employer-Work egress veto), 6 (ING-7 tool-stripping), 7 (secrets/redaction) + general: input validation, fail-closed default-deny, injection/spoofing, prototype pollution, constant-time compare, unbounded loops.
- **Verdict: CLEAR.**

---

## Part A — Verification of the 5 previously-fixed findings (independent re-derivation, not fix-trust)

### #1 CRITICAL — `extractHost` loopback spoof → egress-veto bypass — **CLOSED**
`processors.ts::extractHost` now isolates the authority *before* stripping userinfo:
1. strip `scheme://` / protocol-relative `//`;
2. `firstSegment(s, "/?#\\")` — path/query/fragment/**backslash** (WHATWG special-scheme separator) cut FIRST;
3. only then `lastIndexOf('@')` userinfo strip within the authority;
4. bracketed-IPv6 / bare-IPv6 (≥2 colons) / `host:port` handling.

I re-derived the full adversarial matrix by hand — all resolve fail-closed to a REMOTE host (→ egress):
- `http://evil.com/@127.0.0.1`, `…/?k=@127.0.0.1`, `…/#@127.0.0.1`, `evil.com/@127.0.0.1` → host `evil.com`.
- backslash `http://evil.com\@127.0.0.1` → `\` cut at step 2 → `evil.com`.
- credential-prefix `http://127.0.0.1@evil.com` → userinfo strip → `evil.com`.
- `file://evil.com/…`, `unix://evil.com/…` → `isLoopbackEndpoint` file/unix-authority branch resolves the authority host and rejects (`evil.com` ∉ loopback).
- embedded tab/newline/trailing-dot/`0.0.0.0`/`127.1`/decimal-IP/IPv4-mapped-IPv6 → all **fail the anchored `^127\.\d+\.\d+\.\d+$` / exact-string match → not loopback** (safe direction; a remote host can never be coerced INTO an exact loopback literal).
- Genuine loopback (`127.0.0.1`, `localhost`, `[::1]`, `/var/run/*.sock`, `unix:/…`, `file:///…`) still classified local — no over-correction.

`processorOfRoute` gates non-egress on BOTH `egressClass==='local'` AND `isLoopbackEndpoint(endpoint)` proof AND (provider branch) membership in `LOCAL_PROVIDERS={ollama,lm_studio}` — a cloud provider id or a tunneled-'local' endpoint always egresses. The veto (`egress.ts`) denies `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` for every non-null processor with no cloud fallback. Regression: `adversarial-regressions.test.ts` #1 (7 spoof vectors × 3 assertions + genuine-loopback + remote-file/unix).

### #2 MED — endpoint userinfo creds leaked into audit refs — **CLOSED**
`egress.ts` and `provider-matrix.ts` emit `endpointHostRef(route.endpoint)` (host-only; scheme/userinfo/port/path stripped). `audit-signal.ts` adds `URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/` so any residual `user:pass@` ref is flagged by `isRedactionSafe`. Verified: `hunter2Pass` absent from emitted audit; the resolved-route decision VALUE still carries the credentialed endpoint (operational data for the broker — correct; the redaction boundary is the audit signal that reaches log/System-Health sinks, not the broker payload).

### #3 MED — approval auto-allow fail-open — **CLOSED**
`approval-policy.ts` uses `AUTO_ALLOW_ELIGIBLE_TARGETS = Set(["calendar"])` (allow-list, native `Set` → prototype-safe). Auto-allow requires ALL of: `resolvedOk` ∧ `dataOwner==='user'` ∧ `approvalPolicy==='auto_private'` ∧ target∈{calendar} ∧ `defaultVisibility==='isolated'`. Every other target (github/linear/asana/drive/telegram/todoist) requires approval. Regression #3 covers all six + the calendar auto-allow.

### #4 MED — `resolveRoute` prototype-member fail-open — **CLOSED**
`provider-matrix.ts` guards with `Object.hasOwn(matrix.capabilityDefaults, capability)`; `constructor/__proto__/toString/valueOf/hasOwnProperty` → `NO_ROUTE_FOR_CAPABILITY`. Regression #4 covers all five.

### #5 — `processorOfRoute` null/neither/both-key hardening — **CLOSED**
Reads the route through an untyped view; `null`/non-object → `processorId("MALFORMED_ROUTE")`; neither-key or both-keys → `MALFORMED_ROUTE` (egress, never non-egress). Malformed always resolves to an egress processor → denied downstream.

---

## Part B — New review (hunting past the verify pass)

### Safety-invariant pass
- **Rule 4 (workspace isolation):** `visibility.ts::denyDirectCrossWorkspaceRaw` fail-closed — missing ids → MALFORMED; cross-workspace raw denied absent a structurally-valid Level-3 link; `same-workspace` correctly excluded; the recorded approval ref is NOT echoed (`ref:approved-link:level3:recorded` only). `validateProjectionVisibility` rejects level > source default, unrecognized level (treated as over-exposure), workspaceId mismatch, malformed source posture. **PASS.**
- **Rule 5 (egress veto):** covered under #1; veto precedes the allowlist and can only narrow/deny; loopback-local (proc===null) is the sole survivor under employer+raw+ack-off. **PASS.**
- **Rule 6 (ING-7):** `admission.ts` — `isTrusted` fail-closed (only explicit `'trusted'`); `admitCandidateJob` composes ajv structural (1) + Zod `.refine` (2) + `admitJob` (3), closing the LESSONS §3 ajv-drops-`.refine` gap. **PASS.**
- **Rule 7 (secrets/redaction):** every module emits refs/hashes/codes only; `session-auth` never puts token bytes in a message/signal (uses `sha256:` launch ref); `isRedactionSafe` asserted across every module's test. **PASS.**

### General pass
- **Input validation / fail-closed:** every cross-boundary fn has an explicit malformed guard returning a typed DENY; no throw across a boundary. **Clean.**
- **Injection:** no SQL/command/path-concat/eval/dynamic-require; pure predicates. **Clean.**
- **Prototype pollution:** `Object.hasOwn` (matrix) + native `Set` (targets, hard-denials, local-providers); no user-keyed object writes. **Clean.**
- **Constant-time compare:** `verifySessionToken` length-guards then `crypto.timingSafeEqual`; length-reject leaks no content timing. **Clean.**
- **Unbounded loops:** only bounded iterations (`firstSegment` over a fixed delimiter set, 3-octet `.every`, array `.includes`); no user-controlled loop bound, no recursion. **Clean.**

### Observations (LOW / informational — no action required to CLEAR)

- **[low] audit-signal.ts — the runtime redaction guard is not wired into the emit path.** `assertRedactionSafe`/`isRedactionSafe` are invoked only from tests; the production decision constructors emit audits without a belt-and-suspenders assertion. Redaction currently holds **by construction** (host-only refs) and is test-verified for every module, so this is not a leak — but wiring `assertRedactionSafe` into `buildAuditSignal` (or the decision constructors) would make redaction defense-in-depth rather than convention-plus-tests. Action: `defer` (hardening, not a defect).
- **[info] admission.ts — `admitJob` (public export) trusts the `AgentJobSchema.refine` invariant `read_only ⇒ !allowsMutating`.** `admitsMutating` applies a `read_only` override that returns `false` first, so a hand-built `AgentJob` with `{mode:'read_only', allowsMutating:true}` reaching `admitJob` directly would be admitted as read-only. Mitigated: (a) `mode==='read_only'` genuinely forces non-mutation at execution; (b) the documented untrusted entry is `admitCandidateJob`, which runs the `.refine` (stage 2) and rejects that combo as MALFORMED before `admitJob`. Within the `AgentJob` type contract this cannot occur. No change required; noted so the execution layer keeps enforcing `mode` as authoritative.
- **[info] processors.ts — a `runtime` route with `egressClass:'local'` + loopback endpoint is classified non-egress even for a cloud-backed runtime (e.g. Claude Agent SDK).** This is by design: the runtime's control endpoint is loopback; the model calls it makes are separate `ProviderRoute`s each independently egress-vetoed. Assumption kept visible for the phase; not a finding.

---

## Escalation
No NEW critical or high finding. The 4 hard denials and the egress veto are enforced fail-closed; all 5 prior findings independently re-verified CLOSED.

**PHASE 3 SECURITY: CLEAR.**
