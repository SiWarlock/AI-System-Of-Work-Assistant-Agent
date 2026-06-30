# Domain Model

Status: rough-draft planning artifact for `/arch-finalize`.

## Core Entities

| Entity | Definition | Key Fields | Source of Truth |
|---|---|---|---|
| Workspace | Trust, ownership, routing, provider, egress, and policy boundary | id, name, type, dataOwner, visibility, gbrainBrainId, markdownRepo, egressPolicy, providerMatrix | Control-plane config + workspace Markdown frontmatter where applicable |
| Global Coordination Layer | Sanitized cross-workspace coordination projection and visibility gate | identity map, busy/free, deadlines, sanitized summaries, priority metadata | Control-plane operational DB; sanitized Markdown copy for briefs/reviews |
| Project | Finite outcome inside a workspace | id, workspaceId, aliases, status, outcome, external refs, progress providers | Workspace Markdown frontmatter + external systems for their own state |
| Area | Ongoing responsibility inside a workspace | id, workspaceId, name, policies, source mappings | Workspace Markdown |
| Source | Imported information artifact | id, workspaceId, origin, content hash, type, external ref, sensitivity | Control-plane source record; raw source stays external where authoritative |
| Meeting | Source-backed conversation/event | id, workspaceId, calendarEventRef, transcriptRef, attendees, projectRefs | Granola/calendar for raw records; Markdown for synthesis |
| Task / Commitment | Actionable work item | id, owner, due date, workspace, project, external refs, status | Todoist/Linear/Asana for task status; Markdown for semantic summary |
| Decision | Durable choice with context | id, workspaceId, projectId, evidence refs, status | Markdown via KnowledgeWriter |
| Person | Workspace-scoped person context | id, workspaceId, aliases, external IDs, notes, links | Workspace Markdown; GCL identity map stores sanitized cross-workspace links |
| KnowledgeMutationPlan | Proposed semantic mutation | planId, workspaceId, sourceRefs, creates, patches, links, frontmatter, confidence, approval flag | Agent output until KnowledgeWriter commit |
| ProposedAction | Proposed external side effect | actionId, target system, canonical object key, payload, approval policy, idempotency key | Control-plane operational DB until Tool Gateway receipt |
| AgentJob | Governed model/runtime invocation | id, workflowRunId, workspaceId, capability, contextRefs, toolPolicy, provider policy, schema, budgets | Control-plane operational DB |
| ProviderProfile | Model provider configuration | provider, endpoint, model, capabilities, egress class, cost caps, schema conformance status | Control-plane config/DB; secrets in Keychain |
| WorkflowRun | Durable product workflow instance | workflow id, trigger, state, idempotency key, audit refs | Temporal + control-plane audit |
| Approval | Human decision on sensitive action | id, actionRef, status, actor, channel, payload hash | Control-plane operational DB |
| AuditRecord | Immutable operational trace | actor, event, refs, before/after summary, timestamps | Control-plane operational DB |

## Relationships

- Workspace owns projects, areas, sources, meetings, decisions, person notes, provider policy, egress policy, and one GBrain brain.
- Workspace maps to one Obsidian-compatible Markdown Git repo/vault.
- GBrain brain indexes only its workspace Markdown repo and approved external records.
- GCL stores sanitized projections emitted from workspace-owned jobs; it does not store raw workspace content by default.
- Project links to task systems, calendar aliases, notebook mappings, sources, meetings, decisions, and progress providers.
- AgentJob may produce KnowledgeMutationPlan and ProposedAction but never applies them directly.
- KnowledgeWriter commits semantic mutations; Tool Gateway commits external side effects.

## State Machines

### Source

`captured -> classified -> queued_for_review | processing -> proposed -> applied | rejected | failed_retryable | failed_terminal`

Forbidden transitions:
- `captured -> applied` without classification and policy validation.
- `processing -> external_write` from source-processing agent.

### Meeting Closeout

`detected -> correlated -> context_loaded -> agent_extracted -> validated -> knowledge_committed -> external_actions_pending | external_actions_applied -> summarized`

Failure/recovery states:
`needs_routing_review`, `provider_failed`, `schema_rejected`, `write_conflict`, `approval_pending`, `outbox_retry`, `completed_with_warnings`.

### Knowledge Mutation

`planned -> validated -> conflict_checked -> approved_if_required -> committed_to_markdown -> gbrain_sync_queued -> indexed | sync_lagging | parity_defect`

### Proposed External Action

`proposed -> approval_required | auto_allowed -> precondition_checked -> dispatched -> receipt_recorded | retry_queued | rejected | expired`

### Agent Job

`created -> admitted -> provider_selected -> running -> schema_validated -> accepted | rejected | cancelled_budget | failed_retryable | failed_terminal`

### Approval

`pending -> approved | edited | rejected | deferred | expired`

## Business Rules and Invariants

- [locked decision] Markdown is canonical semantic truth.
- [locked decision] Obsidian remains a supported human-facing editor for each workspace repo/vault and for sanitized global coordination notes.
- [locked decision] KnowledgeWriter is the only autonomous semantic Markdown writer.
- [locked decision] GBrain is derived and rebuildable; DB-only semantic facts are defects.
- [locked decision] Agents consuming untrusted content have no mutating tools.
- [locked decision] All provider outputs are schema-gated before side effects.
- [locked decision] All external writes pass through Tool Gateway and idempotency envelope.
- [locked decision] Cross-workspace raw retrieval is forbidden; GCL is the visibility gate.
- [locked decision] Employer Work raw cloud egress is blocked until workspace setting is enabled.
- [locked decision] Local models are optional zero-egress path, not the V1 critical release gate.
- [locked decision] Operational store is separate from Temporal persistence and separate from GBrain PGLite.

## Glossary

- Workspace: privacy and routing boundary.
- Vault/repo: Obsidian-compatible Markdown Git repository for a workspace or sanitized global coordination.
- Brain: one GBrain instance/index scope per workspace.
- GCL: Global Coordination Layer, the only cross-workspace visibility gate.
- Canonical object key: deterministic identity used to prevent duplicate external writes.
- Provider matrix: workspace + capability configuration for model providers and egress.

