# User and System Flows

Status: rough-draft planning artifact for `/arch-finalize`.

## Flow 1 - Meeting Closeout

Actor: owner/operator, scheduled connector sync, control-plane worker.
Trigger: completed Granola transcript detected by polling.
Preconditions: workspace/project registry configured; Granola and Calendar read connectors healthy or queued; GBrain workspace brain available or degraded; provider matrix configured.

Steps:
1. Connector Gateway pulls completed Granola transcript metadata and links, then emits a canonical source/meeting event.
2. Control plane correlates transcript to calendar event, workspace, project, attendees, and prior meeting history.
3. If routing confidence is low, item remains in Ingestion Inbox.
4. Runtime Broker builds a `meeting.close` AgentJob with workspace scope, read-only tool policy for untrusted transcript context, provider/model selection, budget, idempotency key, and output schema.
5. Agent returns structured meeting closeout result with evidence references.
6. Validator rejects missing evidence, inferred owners/dates, unsupported claims, ambiguous routing, schema failures, or mutating-tool policy violations.
7. KnowledgeWriter applies meeting/project/person/decision/daily/source note mutations to the workspace repo/vault.
8. Tool Gateway creates or proposes external actions with approval and idempotency.
9. GBrain re-index jobs run from committed Markdown.
10. Dashboard, Telegram, audit, and read models update.

Success State: one canonical meeting note, project/person/decision updates, proposed/applied actions, no duplicate external writes, auditable result.
Failure States: connector outage, ambiguous routing, provider schema failure, GBrain unavailable, KnowledgeWriter conflict, approval pending, Tool Gateway retry.
Security / Lifecycle Constraints: transcript is untrusted; source-processing agent has no mutating tools; replay is idempotent; Employer Work cloud egress requires workspace gate.

## Flow 2 - Daily Brief

Actor: Temporal schedule, control-plane worker, owner.
Trigger: durable daily schedule or wake catch-up.
Preconditions: schedule exists; GCL has sanitized projections; connectors may refresh opportunistically.

Steps:
1. Temporal schedule fires or catches up one collapsed missed run.
2. Connector Gateway refreshes calendars, tasks, project status, and recent meetings.
3. Workspace jobs update sanitized GCL projections as needed.
4. Briefing agent reads GCL for global context and workspace brains only within allowed scope.
5. KnowledgeWriter writes workspace-specific briefs to workspace repos where appropriate.
6. Global sanitized brief is written to Global/Coordination Markdown repo and dashboard read model.
7. Telegram receives short summary and link/status.

Success State: global and workspace briefs exist with links/citations and no raw cross-workspace leakage.
Failure States: missed schedule, stale connector, provider failure, GCL projection stale, write conflict.

## Flow 3 - Cross-Calendar Scheduling

Actor: owner via Mac Copilot or Telegram.
Trigger: request such as "Find a time for a doctor appointment next week."

Steps:
1. Intent router assigns Personal Life workspace and area unless user overrides.
2. GCL reads busy/free metadata across configured calendars and sanitized focus/deadline projections.
3. Assistant proposes windows with generic conflict explanations.
4. Private personal event is created automatically only if policy allows.
5. Shared/invite/external-message changes require approval through Approval Inbox.
6. Relevant Personal Life Markdown note may be updated through KnowledgeWriter.

Success State: safe scheduling proposal or event without revealing raw work details.
Failure States: calendar connector unavailable, insufficient availability metadata, approval pending.

## Flow 4 - Source Ingestion

Actor: owner, Telegram, desktop upload, URL/source adapters.
Trigger: captured link/file/voice/source or watched import.

Steps:
1. SourceEnvelope is registered with workspace hint, origin, type, hash, user tags, sensitivity, and routing hints.
2. Source adapter extracts content/metadata.
3. Router classifies workspace/project/sensitivity.
4. Low confidence items remain in Ingestion Inbox.
5. Source-processing agent runs under read-only tool policy and emits KnowledgeMutationPlan / ProposedAction only.
6. KnowledgeWriter applies approved semantic mutations.
7. Optional Drive-backed NotebookLM managed docs are updated through Tool Gateway/NotebookPort.
8. GBrain indexes committed Markdown.

Success State: source captured, routed, summarized, linked, and auditable.
Failure States: prompt injection detected, unsupported type, provider schema failure, connector outage, dedupe hit.

## Flow 5 - Project Sync and Progress

Actor: schedule, user, project registry.
Trigger: on demand, nightly, or after relevant event.

Steps:
1. Project registry resolves task systems, implementation plan path, aliases, and progress providers.
2. Deterministic parser reads checkboxes/status from IMPLEMENTATION_PLAN.md and/or external PM systems.
3. Agent synthesizes explanation of progress, blockers, waiting items, and next actions.
4. KnowledgeWriter updates project status sections.
5. Dashboard read model updates.

Success State: project dashboard shows deterministic progress with evidence and next actions.
Failure States: missing provider mapping, parse failure, stale external connector, ambiguous status.

## Flow 6 - Approval Flow

Actor: owner, Mac Approval Inbox, Telegram approval channel, Tool Gateway.
Trigger: action requires approval by policy.

Steps:
1. Tool Gateway records pending action with canonical object key, payload hash, required approval, and expiry/visibility metadata.
2. Mac app and/or Telegram display approval card.
3. Owner approves, edits, rejects, or defers.
4. Tool Gateway applies approved action idempotently or records rejection/deferral.
5. Audit and read models update exactly once.

Success State: single auditable state transition across Mac/Telegram.
Failure States: conflicting approvals, stale card, connector outage, precondition failure.

## Flow 7 - User-Initiated Cross-Store Deletion

Actor: owner.
Trigger: explicit delete/purge request for source, meeting, or project.

Steps:
1. Control plane validates explicit user intent.
2. Deletion plan identifies Markdown notes/sections, GBrain nodes/index entries, event-store records, read models, and external links.
3. KnowledgeWriter removes or tombstones canonical Markdown content while preserving unaffected human-owned sections.
4. GBrain purge/re-index removes derived state.
5. Event store tombstones audit rather than silently deleting history.
6. System Health reports completion or compensating failures.

Success State: no orphaned references or resurrected index entries.
Failure States: partial purge, write conflict, GBrain purge failure, dangling external refs.

## Flow 8 - Provider-Routed Agent Job

Actor: Runtime Broker, model provider adapters.
Trigger: workflow requests latent extraction/synthesis.

Steps:
1. Workflow submits AgentJob with capability, workspace, context refs, output schema, budgets, idempotency, and tool policy.
2. Runtime Broker evaluates workspace/capability matrix, egress policy, provider health, model availability, cost/runtime caps, and local/cloud preference.
3. Provider adapter calls Claude, OpenAI, OpenRouter, Ollama, or LM Studio.
4. Output is schema-validated.
5. Invalid output is rejected or retried within policy; no side effects happen before validation.

Success State: provider-neutral, schema-valid result.
Failure States: provider unavailable, model missing, schema failure, egress denied, budget exceeded.

