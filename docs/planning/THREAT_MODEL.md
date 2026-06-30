# Threat Model

Status: rough-draft planning artifact for `/arch-finalize`.

## Assets

- Raw Employer Work transcripts, meeting notes, project notes, people notes, and task context.
- Personal Life health/finance/family/admin notes.
- Personal Business/client/project notes.
- Markdown Git repositories and human-owned Obsidian sections.
- Provider API keys and connector OAuth tokens.
- Operational audit/event/approval/outbox database.
- GBrain per-workspace indices and derived graph.
- GCL sanitized projections and identity map.
- External write targets: Calendar, Todoist, Linear, Asana, Drive/Docs, GitHub, Telegram.

## Trust Boundaries

| Boundary | Crossing Data | Controls | Failure Mode |
|---|---|---|---|
| Electron renderer -> preload/main | UI commands and reads | context isolation, no Node integration, typed IPC | XSS invokes privileged operation |
| Renderer -> loopback worker API | dashboard queries, commands, subscriptions | loopback binding, origin/session checks, typed tRPC, no secrets in renderer | untrusted renderer accesses raw data |
| Worker -> provider/cloud | prompts, context refs, raw content when allowed | workspace/capability matrix, egress policy, provider allowlist, cost caps | raw Employer Work leaves device |
| Worker -> local provider | prompts/context to Ollama/LM Studio | local endpoint allowlist, conformance tests, no remote tunnel | local server misconfigured or model leaks via plugin |
| Workspace -> GCL | sanitized projections | visibility levels, projection schema, tests | raw workspace content copied globally |
| Agent output -> side effects | KnowledgeMutationPlan / ProposedAction | strict schema gate, validator, KnowledgeWriter, Tool Gateway | hallucinated output becomes durable |
| KnowledgeWriter -> Markdown | note mutations | source evidence, section ownership, compare-revision, secret scan | overwrites human section or writes secret |
| GBrain -> Markdown | derived output proposals | no direct write, read-only runtime MCP, parity checks | hidden brain / direct mutation |
| Tool Gateway -> external systems | writes to calendar/tasks/docs/etc. | approval, idempotency, preconditions, receipts | duplicate/unapproved external write |

## Threats and Mitigations

| Threat | Severity | Mitigation | Test |
|---|---|---|---|
| Prompt injection from transcripts, calendar descriptions, web/docs, NotebookLM, or Markdown | Critical | ING-7 read-only jobs, job-admission rejection for mutating tools, schema validation, no side effects before validation | Injection corpus across five PRD vectors |
| Workspace leakage through retrieval | Critical | per-workspace GBrain brains, no direct cross-brain queries, GCL-only projections | WS-7/WS-8 adversarial leakage suite |
| Employer Work cloud egress without consent | Critical | workspace settings gate, provider matrix, System Health display, audit | Egress acceptance test |
| Renderer privilege escalation | Critical | Electron context isolation, no Node integration, narrow preload, worker API not exposing secrets/raw data casually | Electron security review |
| Duplicate external writes | Critical | idempotency key, canonical object key, pre-write existence check, receipt store | replay/retry acceptance |
| Hidden GBrain semantic truth | Critical | Markdown canonical, GBrain read-only runtime MCP, write-through disabled/intercepted, parity quarantine | GBrain divergence test |
| Secrets written to Markdown or logs | High | Keychain, secret scan, log redaction, `.env` non-secret only | secret fixture tests |
| Provider returns malformed/hallucinated output | High | strict JSON Schema gate, evidence requirements, validation rejects | provider conformance tests |
| Local model endpoint is remote/proxied unexpectedly | High | explicit endpoint allowlist, no arbitrary provider URL for sensitive work without policy | local provider config tests |
| Manual Obsidian edit lost | High | compare-revision precondition and conflict review | concurrent write test |
| Cross-store deletion leaves orphan | High | deletion plan, compensating states, re-index verification | deletion acceptance |

## Security Defaults

- [locked decision] Single owner/operator; no V1 multi-user app roles.
- [locked decision] macOS user session + Keychain for secrets.
- [locked decision] Employer Work raw cloud egress off by default.
- [locked decision] Local providers can be selected for zero-egress paths only after conformance.
- [locked decision] Renderer has no direct secrets/filesystem/DB access.
- [locked decision] Cross-workspace global UX uses sanitized summaries and drill-down, never raw blended search by default.

## Required Security Artifacts During Implementation

- Provider capability/egress matrix.
- GCL projection schema and visibility-level tests.
- Electron preload API inventory.
- Tool policy/job-admission test suite.
- Secret scanning gate.
- Idempotency envelope tests.
- GBrain parity/rebuild tests.
- Workspace egress audit events.

