# Risks

Status: rough-draft planning artifact for `/arch-finalize`.

| ID | Risk | Category | Severity | Likelihood | Mitigation | Fallback | Must Appear in Architecture |
|---|---|---|---|---|---|---|---|
| RISK-001 | Cross-workspace raw data leakage | Security/privacy | Critical | Medium | Brain/vault per workspace, GCL-only cross-workspace path, WS-7 evals, provider policy | Disable global raw drill-down until fixed | Yes |
| RISK-002 | Prompt injection causes unsafe action | Security | Critical | High | ING-7 job-admission gate, read-only tool policy, schema validation, no side effects before validation | Ingestion inbox review-only mode | Yes |
| RISK-003 | GBrain becomes hidden semantic source of truth | Data integrity | Critical | Medium | Disable/intercept write-through, read-only runtime MCP, parity checks, re-index from Markdown | GBrain read-only branch | Yes |
| RISK-004 | Duplicate external writes on replay/retry | Data/integration | Critical | Medium | Tool Gateway envelope, idempotency key, canonical object key, pre-write existence checks, receipts | Approval-only preview mode | Yes |
| RISK-005 | Electron renderer compromise reaches secrets/data | Security | Critical | Medium | Context isolation, no Node integration, narrow preload IPC, loopback API auth/origin checks | IPC-only lockdown | Yes |
| RISK-006 | Provider schema behavior varies or fails | Runtime/provider | High | High | Strict schema gate, provider conformance matrix, per-capability enablement | Disable failing provider/capability pair | Yes |
| RISK-007 | Local models underperform on critical extraction | Runtime/provider | High | High | Optional zero-egress path, eval gating, not release-critical | Use cloud provider with egress acknowledgment | Yes |
| RISK-008 | Dual SQLite/Postgres support creates dialect drift | Storage | High | Medium | Drizzle schema discipline, repository contract tests on both, avoid dialect-specific domain code | Temporarily mark Postgres unsupported before DoD only by owner decision | Yes |
| RISK-009 | Temporal local/sleep behavior differs from expectations | Lifecycle | High | Medium | macOS sleep/wake tests, persistent local Temporal, catch-up logic, outbox replay | Manual resume/health repair path | Yes |
| RISK-010 | Hermes adapter unstable | Runtime | Medium | Medium | Keep critical path on Claude/cloud provider; Hermes conformance before DoD | Track Hermes as required but non-critical until pass | Yes |
| RISK-011 | NotebookLM direct API unavailable | Integration | Medium | High | Drive-backed managed docs V1 path | Defer direct API to V1.1 | Yes |
| RISK-012 | Scope too broad for first usable release | Scope | High | High | Meeting closeout proof spine, quality gates, parallel after contracts | Explicit owner-approved scope cut | Yes |
| RISK-013 | Open-source install burden too high | DX | High | Medium | Clean install test from Phase 1, doctor command, presets, docs | Developer-only install for internal alpha | Yes |
| RISK-014 | Cost overruns from provider breadth | Cost | Medium | Medium | Per-job runtime/cost caps, provider matrix defaults, System Health cost visibility | Disable expensive providers by default | Yes |
| RISK-015 | Raw Employer Work cloud egress happens accidentally | Privacy | Critical | Medium | Workspace settings gate, provider allowlist, System Health, tests | Employer Work cloud providers disabled | Yes |
| RISK-016 | Obsidian manual edits race KnowledgeWriter | Data integrity | High | Medium | compare-revision preconditions, conflict review items, atomic writes | Queue mutation for manual resolution | Yes |
| RISK-017 | Contract-freeze bottleneck blocks parallel tracks | Delivery | Medium | High | Small contract track first, explicit Appendix A model inventory | Serial build until contracts stabilize | Yes |
| RISK-018 | Current external docs/API claims drift | Research | Medium | High | Phase-0 research refresh and version pins | Disable affected adapter until revalidated | Yes |

## Highest-Risk Areas for `/arch-finalize`

1. Validate that Electron decision is reflected everywhere PRD still says Tauri.
2. Check GBrain brain-per-workspace + GCL design against every cross-workspace flow.
3. Ensure provider matrix does not weaken Employer Work egress guarantees.
4. Ensure SQLite/Postgres dual support is not superficial.
5. Ensure final DoD does not rely on stubs for real integration acceptance.

