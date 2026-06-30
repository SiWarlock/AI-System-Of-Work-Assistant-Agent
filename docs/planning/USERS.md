# Users and Actors

Status: rough-draft planning artifact for `/arch-finalize`.

## Primary Human Actor

| Actor | Role | Goal | Can Do | Cannot Do | Failure State |
|---|---|---|---|---|---|
| Owner/operator | Single V1 user, admin, installer, reviewer | Stay oriented across employer work, personal business, and personal life while keeping memory owned and inspectable | Configure workspaces, run the app, approve/reject actions, edit Obsidian Markdown, enable egress, manage connectors, initiate deletion | Delegate app access to other users in V1; bypass safety gates without explicit configuration | Loses trust due to leakage, duplicate writes, bad routing, hidden state, or brittle install |

## Non-Human Actors

| Actor | Owns | Can Do | Cannot Do | Risk |
|---|---|---|---|---|
| Electron renderer | UI rendering and user interaction | Display dashboard, approvals, inboxes, project views, calendar, Copilot; call typed APIs | Access filesystem, DB, secrets, or raw connectors directly | XSS/renderer compromise |
| Electron main | Desktop lifecycle and secure bridge | Manage windows, preload IPC, app lifecycle, worker supervision | Own product workflows or semantic state | Over-privileged bridge |
| Control-plane worker | Local product orchestration | Run policies, routing, audit, read models, outboxes, tRPC API, workflow clients, provider brokering | Become semantic source of truth | Operational-state corruption |
| Temporal | Product workflow durability | Orchestrate workflows, retries, approval waits, schedules, resume after restart | Own GBrain internal jobs or semantic truth | Misconfigured local persistence or duplicate scheduling |
| Hermes cron/Kanban | User-defined autonomous automations | Fire automations through governed gateways | Write external systems or Markdown directly | Duplicate/ungoverned side effects |
| Agent Runtime Broker | Runtime and provider selection | Enforce job envelope, capability matrix, tool policy, cost/runtime caps, schema gates | Apply side effects directly | Provider overreach or bad routing |
| Model providers | LLM inference | Generate structured candidate outputs | Write data, call tools, bypass schema gate | Hallucination, egress, inconsistent schema behavior |
| KnowledgeWriter | Canonical semantic writer | Validate and apply Markdown mutations, preserve human-owned sections, trigger GBrain sync | Write external tasks/calendar state | Lost updates, malformed Markdown |
| Tool Gateway | External write governance | Apply idempotent external writes after policy/approval | Write semantic Markdown | Duplicate writes, unapproved changes |
| Connector Gateway | External read/sync governance | Pull external records, health, cursors, retries | Perform mutating external actions | Stale data, rate limits |
| GBrain | Derived retrieval/index/graph engine | Search, think, graph, timeline, schema-read, health, internal indexing/minions | Be canonical semantic truth or write Markdown directly | Hidden DB truth |
| Global Coordination Layer | Cross-workspace visibility gate | Store sanitized projections, identity map, busy/free, priorities, grouped global summaries | Store raw workspace content by default | Cross-workspace leakage |
| Obsidian | Human knowledge surface | Let user inspect and edit Markdown repos/vaults | Schedule workflows or run integrations | Manual edits racing KnowledgeWriter |
| Telegram bot | Remote capture/approval/notification | Receive captures, send summaries, handle approval actions from allowlisted sender | Expose unscoped data or apply writes without gateway | Sender spoofing or leaked approval |

## External Systems as Actors

| System | Direction | Authority | V1 Policy |
|---|---|---|---|
| Google Calendar | read/write | Scheduled events and availability | Private writes may be automatic by policy; shared/invite changes require approval |
| Todoist | read/write | Personal task completion/status | Self-owned tasks may be automatic by policy |
| Linear | read/write | Technical work execution | Shared/status changes require approval unless explicitly configured |
| Asana | read/write | General operations work | Shared/status changes require approval |
| Granola | read | Raw meeting transcript source | Read/source only in V1 |
| Google Drive/Docs | read/write | NotebookLM managed source docs and files | Managed writes through policy |
| NotebookLM | read/manual sync target | Notebook analysis workspace | V1 uses Drive-backed managed-docs fallback; direct API remains spike/future |
| GitHub | read/write with approval | Code/project source and links | Writes require approval unless explicit code mode is active |

## Human Permission Model

- [locked decision] V1 has no multi-user accounts or app roles.
- [locked decision] Employer/client/other people are represented through workspace policy, task/meeting objects, egress rules, and approval constraints, not as permissioned app users.
- [locked decision] Local app access relies on macOS user session plus Keychain-protected secrets.

## Provider Permission Model

- [locked decision] Each workspace defines allowed providers and egress processors.
- [locked decision] Employer Work raw cloud processing is denied until a workspace settings gate is explicitly enabled.
- [locked decision] Local providers are optional zero-egress paths when they pass conformance.

