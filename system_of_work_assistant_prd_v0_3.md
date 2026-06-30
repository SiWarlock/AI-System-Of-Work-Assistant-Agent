# System of Work Assistant — Product Requirements Document

> A Mac-first, open-source, self-hosted assistant for personal life, side projects, and employer work — built on an Obsidian-compatible Markdown brain, GBrain, Temporal, Hermes, and Claude Agent SDK.

**Document purpose:** define the product, architecture, requirements, boundaries, risks, and implementation plan for the first product-quality single-user release.

**Version:** v0.3 Draft  **Date:** 2026-06-28  **Supersedes:** v0.2 (see `system_of_work_assistant_prd_v0_2.md`; v0.1 is the faithful PDF transcription)

---

## Changelog (v0.2 → v0.3)

v0.3 folds in all eight Appendix-A sign-off items (verified in the v0.2 review) and reworks the Hermes-scheduler decision per owner direction. New requirement sets: **ING-7** (untrusted-content agents run tool-stripped, rejected at job admission), **WS-8** (the Global Coordination Layer is the single cross-workspace Visibility Gate; GBrain retrieval is workspace-scoped; no cross-brain agent queries), **§9.10 RET-1..3** (data retention + user-initiated cross-store deletion; minimal V1 core, pruning-tuning → V1.1), **§9.11 COST-1/COST-2** (per-job budget enforcement; aggregate spend-cap → V1.1), **§9.12 EVAL-1** (versioned evaluation corpora that make the §5.4 statistical metrics measurable), **§16.4 Data Retention & Deletion** and **§16.5 Third-Party Egress Policy** (Employer Work raw content needs an explicit egress acknowledgment; new `Workspace.egressPolicy`), and a tightened §16.2 auto-write row. §18.1 resequences the external-write envelope into Phase 1 (A8). **RT-7 reworked (owner direction):** Hermes cron/Kanban MAY run as standalone autonomous automations, but all their external side effects route through the Tool Gateway (envelope + idempotency + approval) and all semantic writes through KnowledgeWriter — duplicate-write safety and the one-writer invariant are enforced by the gateways, not by forbidding a second scheduler; Temporal remains the source of truth for product workflows. Appendix A is now a resolution log; Appendix B records the RT-7 resolution. The §19.1 retention open question is resolved by RET-1.

---

## Changelog (v0.1 → v0.2)

v0.2 reconciles the PRD to the binding **local-first V1 topology** decision and hardens the **GBrain dependency**, **without cutting any V1 scope** (the full Definition of Done is preserved; risky items are *gated/sequenced*, not removed). It is the product of a 7-lens adversarial review (architecture coherence, local-first/lifecycle, dependency realism, security/privacy, requirements quality, deliverability, knowledge integrity) with each finding independently verified.

Key changes:
- **Local-first made explicit.** New §1.1 deployment-topology rows; §4.1 vision qualified; all event ingress flipped to poll-based (Telegram long-polling default, webhooks → V1.1); loopback-only network-exposure NFR; §17 offline behavior rewritten for a local control plane; hosted control plane (true 24/7) added to §18.3 V1.1 behind the same ports/adapters.
- **New §9.8 Lifecycle & Availability (LIFE-1..7)** — the biggest gap local-first exposes — threaded through §11, §17, §5.4, §19, §20.1, §20.2, §21, and the §18.1 phase plan.
- **GBrain "full surface vs read-heavy" contradiction resolved.** GBrain is READ-required; semantic write-back is GATED behind Phase-0 spikes with a named READ-ONLY fallback that still satisfies the DoD. New KN-9 (no direct GBrain Markdown writes) and KN-10 (retrieval relevance); read-only GBrain MCP for runtimes; defined parity/reconciliation (§14.2, §14.5); GBrain version pin + contract gate; dream/Minions default-off.
- **Architecture completed.** §7.3 ports↔adapters fully mapped (adds SourceIngestionPort, SecretsPort, deployment-topology adapters); §7.2 defines Tool Gateway and Connector Gateway; §7.1 diagram redrawn with GBrain as a cross-cutting read service.
- **Runtimes.** Claude Agent SDK named the default reference runtime; Hermes a required, DoD-tested but install-opt-in adapter (new §13.5); Temporal the sole scheduler (RT-7 in v0.2 — SUPERSEDED by the v0.3 RT-7 rework, which permits gateway-routed Hermes cron/Kanban autonomous schedulers).
- **Decisions promoted** from §19.1 open questions: Temporal local+persistent, GBrain single-owner PGLite, Keychain secrets, dream default-off.
- **Traceability closed:** orphan metric→requirement→test chains completed (KN-10, WS-7, quantified sync window, parity/divergence, human-section preservation, §9.9 Observability).
- **Connector realism:** MCP connectors are remote and need client-side pre-write existence checks; NotebookLM Drive-backed is the committed V1 path (API deferred to V1.1, auto-sync claim corrected).

**Eight items that would add new scope or touch settled product/privacy decisions are NOT applied** — they are carried in **Appendix A** for owner sign-off (tool-stripping enforcement, data retention/deletion, cross-workspace Visibility Gate, third-party egress policy, autonomy-default tightening, cost/budget enforcement, evaluation corpora, idempotency phase-resequencing). **Appendix B** records conflict resolutions that warrant owner awareness (notably RT-7 disabling Hermes cron/Kanban autonomy by default — this v0.2 default was REVERSED in v0.3; see the v0.2→v0.3 changelog and RT-7).

---

# 1. Document Control

| Field | Value |
|---|---|
| Document | System of Work Assistant PRD |
| Version | v0.3 Draft |
| Primary user model | Single user, product-quality, open-source installable later |
| Primary platform | Mac-first desktop application |
| Canonical semantic knowledge | Obsidian-compatible Markdown Git repositories |
| Knowledge engine | GBrain required in V1 |
| Agent runtimes | Hermes Agent adapter and Claude Agent SDK adapter in V1 |
| Workflow engine | Temporal for cross-system workflows |
| Status | Draft for architectural review and implementation planning |

## 1.1 Decision Summary

| Decision | Direction |
|---|---|
| Product posture | Single-user first, open-source/self-hosted, product-quality architecture. |
| Workspace model | Three default logical workspaces: Employer Work, Personal Business / Side Projects, Personal Life, plus a Global Coordination Layer. |
| Knowledge store | Markdown Git repos are canonical; Obsidian opens them as human-facing workspaces. |
| GBrain | Required in V1 as the read/index/retrieval/graph/schema/synthesis/health engine (search, think, typed graph, schema-read, timeline, MCP, health/doctor); its derived store is rebuildable from Markdown and is never authoritative. GBrain self-write-through to Markdown is disabled (KN-9); Minions/dream/ingestion outputs are PROPOSALS that round-trip through KnowledgeWriter. Semantic write-back is GATED behind the Phase-0 GBrain Round Trip + Full Capability Bridge spikes (§19) and enabled only on a parity pass; otherwise GBrain runs READ-ONLY to the Markdown brain (read-heavy default, see §21). Internal Minion jobs (sync/embed/extract/index/health) run regardless. |
| Runtimes | Both Hermes and Claude Agent SDK are V1 runtime adapters behind AgentRuntimePort. Claude Agent SDK is the DEFAULT reference runtime (universally installable; native structured outputs and tool permissions); Hermes is the validated, REQUIRED, DoD-tested alternate but is not required to be running for a baseline fresh-install acceptance test (§20.1) to pass. |
| Workflow durability | Temporal owns cross-system PRODUCT-workflow orchestration, approval waits, and retries. External-write EXECUTION (envelope + idempotency + approval) is owned by the Tool Gateway for all callers — Temporal workflows or Hermes cron/Kanban automations (RT-7). |
| GBrain jobs | GBrain Minions own GBrain-internal maintenance, indexing, dream, extraction, and embed jobs. |
| NotebookLM | Run API spike; fallback is Drive-backed managed source documents. |
| External systems | Calendar, Todoist, Linear, Asana, Granola, Telegram, Google Drive/Docs, GitHub, YouTube, Podcast/RSS are first-class V1 or V1-adjacent targets. |
| Deployment topology | V1 = LOCAL-FIRST: the control plane, Temporal, and GBrain run on the Mac and are active whenever the Mac is awake. True 24/7 (processing while the Mac is asleep) is deferred to a V1.1 hosted control plane behind the SAME ports/adapters, so the move is configuration, not a rewrite. |
| Temporal deployment | Temporal LOCAL dev server (with persistent SQLite storage) in V1; Temporal Cloud documented as a V1.1 hosted-plane option behind the same workflow port. |
| GBrain deployment | GBrain runs locally in V1 (PGLite) as a single control-plane-managed CLI/subprocess or localhost-bound sidecar that exclusively owns the PGLite file; GBrainAdapter targets this local boundary behind KnowledgePort; any GBrain MCP surface is bound to localhost. Networked/hosted GBrain is a V1.1 config change. |
| Secrets storage | macOS Keychain is the default secret store in V1 via a pluggable SecretsPort/KeychainSecretsAdapter; .env is dev-only/non-secret config. |

---

# 2. Table of Contents

- 1. Document Control
- 2. Table of Contents
- 3. Executive Summary
- 4. Product Vision, Principles, and Goals
- 5. Users, Use Cases, and Success Metrics
- 6. Workspace and Privacy Model
- 7. System Architecture
- 8. Product Surfaces and User Experience
- 9. Functional Requirements
- 10. Data Model and Canonical Objects
- 11. Core Workflows
- 12. Integration Requirements
- 13. Agent Runtime Strategy
- 14. Knowledge System: Obsidian + GBrain + KnowledgeWriter
- 15. Obsidian Second Brain Capability Coverage
- 16. Security, Privacy, and Safety Requirements
- 17. Non-Functional Requirements
- 18. Implementation Plan and Milestones
- 19. Research Spikes and Open Questions
- 20. Acceptance Criteria
- 21. Risks and Mitigations
- 22. References
- Appendix A. Resolution Log (Appendix-A items folded into v0.3)
- Appendix B. Conflict Resolutions for Owner Awareness

---

# 3. Executive Summary

The System of Work Assistant is a Mac-first, open-source, self-hosted personal operating system for managing employer work, side projects, and personal life. It combines a human-readable Markdown knowledge base with a strong AI knowledge engine, durable workflows, controlled agent runtimes, and integrations with the tools where operational work already happens.

The product is not a generic chatbot and not a replacement for Calendar, Todoist, Linear, Asana, Granola, NotebookLM, or Obsidian. It is an orchestration and memory layer that understands how those systems relate to projects, meetings, tasks, decisions, sources, and reviews.

> **North star:** every meaningful meeting, source, decision, task, and project update should land in the correct workspace, update the correct project memory, route the right operational actions, and remain inspectable in user-owned Markdown.

## 3.1 Core Thesis

- The assistant should be single-user and self-hosted in V1, but architected so other users can install it from GitHub later.
- The canonical semantic memory is an Obsidian-compatible Markdown Git repository, not a hidden app database.
- GBrain is required in V1 as the knowledge engine for retrieval, graph, schema, health, Minions, dream cycle (gated/default-off in V1 — see §14.4/§16.2), and MCP access.
- Hermes Agent and Claude Agent SDK are both runtime adapters in V1; neither is the source of truth.
- Temporal owns cross-system product-workflow orchestration, approvals, and retries; external-write execution is owned by the Tool Gateway for all callers (Temporal or Hermes automations, per RT-7).
- A custom KnowledgeWriter is the only semantic Markdown writer.
- Separate workspaces protect data boundaries; a Global Coordination Layer enables scheduling and priority intelligence across them.

## 3.2 What This Product Must Do

| Scenario | Expected Assistant Behavior |
|---|---|
| Granola meeting about a side project | Identify the Personal Business workspace and project, create/update the meeting note, update the project, extract explicit tasks, propose calendar follow-ups, and refresh the dashboard. |
| Doctor appointment request | Route to Personal Life, check global availability across personal/business/work calendars, create a personal calendar event or task according to policy. |
| Employer work meeting | Route to Employer Work, keep raw details inside that workspace, update the work project and people notes, route tasks to Linear or Asana. |
| YouTube or podcast source | Use source-specific extraction, classify workspace/project, create a research note, update relevant project/concept pages, and sync to NotebookLM if mapped. |
| Implementation project | Parse IMPLEMENTATION_PLAN.md and/or Linear project status, compute deterministic progress, summarize blockers and next actions. |
| Morning brief | Produce one global brief with workspace-specific sections, conflicts, priorities, overdue work, and suggested plan without leaking sensitive raw data across workspaces. |

---

# 4. Product Vision, Principles, and Goals

## 4.1 Vision

Create an assistant that keeps the user oriented across work, side projects, and personal life. In V1 the control plane runs locally on the Mac and is active whenever the Mac is awake; processing while the Mac is asleep (true 24/7) is deferred to a V1.1 hosted control plane behind the same ports/adapters (see §18.3). The assistant should know what projects exist, what was decided, what commitments were made, what sources matter, which tasks are critical, which meetings are upcoming, and how to avoid conflicts across workspaces.

## 4.2 Product Principles

| Principle | Meaning |
|---|---|
| User-owned memory | Long-term semantic knowledge lives in Markdown Git repositories that can be opened in Obsidian. |
| One writer | All durable semantic note changes flow through KnowledgeWriter. No competing autonomous file writers. |
| External systems stay authoritative | Calendar owns time, Todoist owns personal task completion, Linear/Asana own collaborative work status, Granola owns raw meeting transcripts. |
| Workspace-aware by default | Every event, source, task, and note belongs to a workspace before it belongs to a project. |
| Global coordination without leakage | Availability and priorities can be coordinated across workspaces without exposing raw confidential content. |
| Runtime-neutral execution | Hermes and Claude Agent SDK are adapters. Workflows do not depend on one specific agent runtime. |
| Deterministic before latent | Use code for identity, routing, counting, idempotency, policy, and progress. Use agents for judgment, synthesis, and explanation. |
| Approvals are product state | Pending actions are persisted, auditable, and visible in Mac and Telegram interfaces. |
| Open-source installability | V1 is built for one user, but with clean install, configuration, and documentation paths for later users. |

## 4.3 Goals

- Provide a unified daily operating system for employer work, side projects, and personal life.
- Automatically route meeting transcripts, captured thoughts, files, links, videos, podcasts, tasks, and calendar requests to the correct workspace and project.
- Maintain high-quality project memory, decisions, people context, meeting history, sources, and reviews.
- Offer a sleek Mac dashboard and Copilot interface for briefs, tasks, project health, calendar, approvals, ingestion, and recent changes.
- Use Telegram as a remote interface for capture, questions, approvals, and notifications.
- Preserve user ownership and inspectability through Obsidian-compatible Markdown.
- Use GBrain for advanced search, typed graph, schema, synthesis, Minions, dream cycle (gated/default-off in V1 — see §14.4/§16.2), and health.
- Support both Hermes and Claude Agent SDK as V1 runtime adapters; Claude Agent SDK is the default reference runtime and the only runtime required for a fresh install (Hermes is a required, DoD-tested but opt-in adapter).

## 4.4 Non-Goals for V1

- No SaaS multi-tenant billing, organization administration, or team onboarding in V1.
- No autonomous email or external messaging sends in V1.
- No unsupported browser automation against NotebookLM unless a validated spike proves it safe and reliable.
- No attempt to replace Todoist, Linear, Asana, Google Calendar, Granola, Obsidian, or NotebookLM.
- No arbitrary direct writes by Hermes, Claude, GBrain dream jobs, or external MCP clients into the Markdown brain.
- No model-only project progress percentages; progress must derive from structured providers or deterministic evidence.
- No single global unscoped memory search across employer work and personal data by default.

---

# 5. Users, Use Cases, and Success Metrics

## 5.1 Primary User

The V1 user is a single power user who manages employer work, personal business/side projects, and personal life. The user is comfortable with developer-style installation and values ownership, extensibility, automation, and transparency over consumer-app simplicity.

## 5.2 Future Users

The project should be installable by other technically capable users from GitHub. V1 should therefore include configuration presets and clear deployment paths, even if the initial product is not packaged as a commercial SaaS or App Store app.

## 5.3 Core Use Cases

| Use Case | Description | V1 Priority |
|---|---|---|
| Meeting closeout | Turn a Granola transcript into meeting notes, decisions, project updates, tasks, calendar proposals, and people context. | P0 |
| Daily brief | Unify calendars, tasks, project status, critical deadlines, waiting items, and suggested plan across workspaces. | P0 |
| Project dashboard | Show project health, progress, next actions, blockers, recent changes, and linked sources. | P0 |
| Task routing | Route commitments to Todoist, Linear, or Asana based on workspace, project, and task type. | P0 |
| Calendar coordination | Create/suggest events while checking conflicts across personal, business, and employer contexts. | P0 |
| Ingestion inbox | Capture links, files, voice, YouTube, podcasts, PDFs, and raw thoughts with reviewable routing. | P1 |
| NotebookLM sync | Maintain project-specific source packs in NotebookLM via API if validated, otherwise Drive-managed docs. | P1 |
| Weekly/monthly review | Summarize progress, decisions, recurring blockers, commitments, and project adjustments. | P1 |
| Implementation plan progress | Parse IMPLEMENTATION_PLAN.md and external PM status for technical projects. | P1 |
| Open-source install | Provide docs and scripts so other users can run the system locally/self-hosted. | P1 |

## 5.4 Success Metrics

| Metric | Target for V1 |
|---|---|
| Meeting closeout accuracy | 90%+ of processed meetings routed to the correct workspace and project in the EVAL-1 meeting-closeout set. |
| Duplicate prevention | 0 duplicate external tasks/calendar events in replay/retry tests. |
| Knowledge write reliability | 100% of approved semantic writes are present in Markdown or visible in retry/error outbox. |
| Calendar conflict safety | 100% of scheduling proposals check all configured availability sources. |
| Approval visibility | 100% of pending external side effects appear in Mac app and/or Telegram approval inbox. |
| Retrieval usefulness | GBrain search/think returns relevant project/person/decision context for 90%+ of the EVAL-1 retrieval benchmark queries (verified by KN-10). |
| Workspace isolation | 0 raw employer-work documents surface in personal workspace outputs without explicit permission (verified by WS-7). |
| Wake resumption | Each schedule with missed ticks during a sleep/restart window runs exactly once (collapsed) on next wake within the catch-up window, with 0 duplicate external side effects and 0 lost in-flight workflows in sleep/restart resume-replay tests. |
| Knowledge sync latency | 95th-percentile time from KnowledgeWriter commit to GBrain-search visibility ≤60s (and to dashboard read model ≤10s) across test runs. |
| Markdown/GBrain parity | 0 unreconciled GBrain-DB-only semantic facts remain after parity reconciliation in an audited sample; 100% of induced DB-only divergences are detected by parity checks; GBrain index is reconstructible from Markdown with 100% of semantic nodes recovered on full re-index. |
| Install reproducibility | Fresh install path succeeds on a clean Mac dev environment with documented prerequisites, exercising the default Claude Agent SDK runtime only (Hermes not required for fresh install). |
| Budget enforcement | 100% of jobs exceeding maxRuntimeSeconds or maxCostUsd are cancelled and recorded with no partial uncommitted side effect (COST-1). |

---

# 6. Workspace and Privacy Model

Workspace boundaries follow ownership, confidentiality, and default tool routing — not simply whether something feels like work. Side projects are work-like but personally owned, so they should not be mixed with employer work.

## 6.1 Default Workspaces

| Workspace | Purpose | Default Tools | Default Visibility |
|---|---|---|---|
| Employer Work | Official job/company projects, meetings, tasks, people, decisions, and confidential work data. | Work calendar, Granola work account, Linear, Asana, work NotebookLM/Drive if approved. | Metadata-only outside workspace by default. |
| Personal Business / Side Projects | Income-generating side projects, indie software, consulting, content, clients, and personally owned professional work. | Personal calendar, Todoist, personal Linear/Asana if configured, Granola personal, NotebookLM/Drive. | Sanitized summaries may coordinate globally. |
| Personal Life | Health, home, finance, family, relationships, learning, admin, and personal goals. | Personal calendar, Todoist, optional Drive/NotebookLM. | Metadata-only or sanitized summaries by default. |
| Global Coordination Layer | Not a normal workspace. Stores availability, conflict metadata, cross-workspace priorities, identity map, and sanitized summaries. | Reads coordination metadata from all workspaces. | Visible to assistant for planning but not a raw content store; it is the single cross-workspace read path / Visibility Gate (WS-8). |

## 6.2 Workspace versus Project versus Area

| Concept | Definition | Examples |
|---|---|---|
| Workspace | Trust, ownership, routing, and policy boundary. | Employer Work; Personal Business; Personal Life. |
| Area | Ongoing responsibility inside a workspace with no finish line. | Health, Finance, Product, Consulting, Learning. |
| Project | Finite outcome with status, meetings, tasks, decisions, sources, and progress. | Launch Atlas beta; File taxes; Prepare Q3 roadmap. |
| Task | Actionable commitment owned by a person/system, often managed in Todoist, Linear, or Asana. | Send Maya architecture diagram by Friday. |
| Source | Imported information artifact that may update knowledge. | Granola transcript, PDF, YouTube video, podcast, web article. |

## 6.3 Cross-Workspace Visibility Levels

| Level | Name | Allowed Cross-Workspace Use |
|---|---|---|
| 0 | Isolated | No cross-workspace access. Use for journals, sensitive work strategy, medical details, secrets. |
| 1 | Coordination metadata | Busy/free blocks, due dates, generic priority labels, non-sensitive deadlines. |
| 2 | Sanitized summary | High-level summary without raw details, such as "critical work deadline this week". |
| 3 | Explicit link | User-approved relationship between projects, people, or sources across workspaces. |
| 4 | Full access | Explicitly allowed for a specific user request or workflow; never default for employer work. |

## 6.4 Cross-Workspace Scheduling Requirement

> The assistant must be able to schedule personal events while respecting employer-work and side-project commitments without exposing raw work content.

```
Example:
User: "Find a time for a doctor appointment next week."

Route:
- Workspace: Personal Life
- Area: Health
- Calendar destination: personal calendar

Global coordination reads:
- Personal calendar busy/free
- Personal Business focus blocks and deadlines
- Employer Work busy/free only, not meeting transcripts

Result:
- Suggest available windows
- Explain conflicts generically
- Create private event automatically if policy allows
```

---

# 7. System Architecture

## 7.1 High-Level Architecture

```
                         User Interfaces
       Mac App | Telegram | Obsidian | Webhooks (V1.1) | Schedules
                                |
                                v   (events / ingress)
       +------------------------------------------------------+
       |               Assistant Control Plane                |  --R--+
       |  Events | Temporal Workflows | Policy | Approvals     |       |
       |  Audit | Routing | Global Coordination Layer          |       |
       +----------------------------+-------------------------+        |
                                    v                                  |
       +------------------------------------------------------+        |
       |                 Agent Runtime Broker                 |  --R--+
       |  HermesRuntimeAdapter | ClaudeAgentSdkRuntimeAdapter |       |
       |  (read-only GBrain MCP) | Deterministic Workers      |       |
       +----------------------------+-------------------------+        |
                                    v                                  |
       +------------------------------------------------------+        |
       |             Deterministic Application Layer          |        |
       |  KnowledgeWriter (sole autonomous Markdown writer)   |        |
       |  Tool Gateway (external writes) | Connector Gateway   |        |
       |  (external reads) | Project Registry                 |        |
       +-------+------------------------------+---------------+        |
               v (autonomous semantic writes)  v (reads / writes)      |
  +----------------------------+      +-----------------------------+   |
  | Markdown Knowledge Repos   |      |       External Systems      |   |
  | Opened in Obsidian         |      | Calendar|Todoist|Linear|    |   |
  | (user also edits manually) |      | Asana|Granola|Drive|        |   |
  +-------------+--------------+       | NotebookLM|GitHub|Telegram  |   |
                | indexed FROM Markdown+-----------------------------+   |
                | (write-through sync via GBrain Minions)               |
                v                                                       |
  +-----------------------------------------------------------+ <--R---+
  |                  GBrain Knowledge Engine                  |
  |  Search | Think | Graph | Schema | Timeline | Health (R)  |
  |  Minions | Dream | Embed | Extract (GBrain-internal only) |
  +-----------------------------------------------------------+

Legend:
  solid down arrows  = write / orchestration flow
  --R--> into GBrain = retrieval via KnowledgePort (read-only)
  GBrain is indexed FROM Markdown (write-through sync via GBrain Minions)
    and QUERIED BY higher layers.
  The ONLY autonomous semantic writer of the Markdown brain is KnowledgeWriter.
  No higher layer writes GBrain's store directly (only GBrain-internal Minions).
```

> **V1 topology note:** the control plane, Temporal, and GBrain run locally on the Mac. In V1 all external event ingress is poll-based — Telegram long-polling plus scheduled connector sync; the Webhooks(V1.1) and Schedules triggers fire only while the Mac is awake. Reachable-from-anywhere webhook ingress and guaranteed scheduled execution arrive with the V1.1 hosted control plane (§1.1 Deployment topology, §8.2, §17 Network exposure).

## 7.2 Component Responsibilities

| Component | Owns | Does Not Own |
|---|---|---|
| Assistant Control Plane | Event ingress, Temporal workflows, policy, approvals, idempotency, routing, audit, notifications, dashboard read models. | Semantic knowledge truth or raw external records. |
| Agent Runtime Broker | Runtime selection, job envelope, capability matching, cost/time limits, result validation. | Model reasoning itself or durable state. |
| Hermes Adapter | Hermes agent execution, messaging gateway, MCP-heavy work, subagents, runtime-local capabilities. | Cross-system workflow truth or unrestricted writes. |
| Claude Agent SDK Adapter | First-party Claude runtime execution, structured outputs, tool permissions, hooks, subagents. | Global orchestration or direct external writes outside policy. |
| KnowledgeWriter | Validated semantic Markdown mutations, conflict handling, revision recording, write-through, GBrain sync trigger. | External task/calendar state. |
| Connector Gateway | Outbound READ sync from external systems (calendar/task/transcript/source pulls), connector auth and credential scoping, rate-limit and retry on reads, connector health/reachability signals. | External WRITE side effects, approval policy, semantic Markdown writes. |
| Tool Gateway | ALL external WRITE side effects via the external-write envelope (idempotency key, canonical object key, preconditions, write receipt); approval enforcement before sensitive/shared writes; dispatch of writes to CalendarPort/TaskPort/NotebookPort adapters. | Semantic Markdown writes (owned by KnowledgeWriter), model reasoning, read/sync (owned by Connector Gateway). |
| GBrain | Retrieval, graph, schema, MCP, Minions, dream cycle, health, derived index, semantic query/synthesis. | Final approval policy or exclusive semantic truth. |
| Obsidian | Human-facing Markdown editing, browsing, graph, visual inspection, manual correction. | Runtime, scheduler, queue, integrations. |
| Temporal | Cross-system workflows, retries, approval waits, external-side-effect orchestration. | GBrain-internal indexing jobs. |
| GBrain Minions | GBrain-internal jobs: sync, embed, extract, dream, health. | Calendar/Todoist/Linear/Asana write orchestration. |

## 7.3 Ports and Adapters

```
Core ports:
- AgentRuntimePort
- KnowledgePort
- KnowledgeWriterPort
- CalendarPort
- TaskPort
- MeetingTranscriptPort
- SourceIngestionPort
- NotebookPort
- ApprovalPort
- NotificationPort
- ProjectRegistryPort
- SecretsPort

V1 adapters (by owning port):
- AgentRuntimePort   -> HermesRuntimeAdapter, ClaudeAgentSdkRuntimeAdapter
- KnowledgePort      -> GBrainAdapter  (retrieval/query/graph/timeline/schema-read/
                        health/MCP; durable semantic writes route through
                        KnowledgeWriterPort, NEVER this adapter)
- KnowledgeWriterPort-> MarkdownKnowledgeWriter
- CalendarPort       -> GoogleCalendarAdapter
- TaskPort           -> TodoistAdapter, LinearAdapter, AsanaAdapter
- MeetingTranscriptPort -> GranolaAdapter
- SourceIngestionPort   -> TelegramCaptureAdapter, FileUploadAdapter, UrlAdapter,
                           YouTubeAdapter, PodcastRssAdapter, PdfOcrAdapter,
                           DriveDocsAdapter, GitHubAdapter
                           (Granola transcripts enter ingestion via
                            MeetingTranscriptPort -> GranolaAdapter)
- NotebookPort       -> NotebookLMDriveAdapter (V1) or NotebookLMApiAdapter
                        (V1.1, after spike)
- NotificationPort   -> TelegramNotifyAdapter, MacAppNotifier
- ApprovalPort       -> TelegramApprovalAdapter, MacApprovalAdapter
- ProjectRegistryPort-> LocalProjectRegistryAdapter (Markdown frontmatter-backed)
- SecretsPort        -> KeychainSecretsAdapter (V1; 1Password CLI and other
                        providers V1.1; .env is dev-only/non-secret, never a secret store)

Deployment-topology adapters (selected by CONFIGURATION, not code):
- WorkflowHostAdapter   (V1 local Temporal dev server | V1.1 remote/Cloud)
- EventIngressAdapter   (V1 long-poll | V1.1 webhook)
- InstanceLeaseAdapter  (V1 local single-instance lock | V1.1 shared lease backend)

Notes:
- The single Telegram transport is decomposed into capture/notify/approval role adapters.
- GBrain's full surface (Minions/dream/embed/extract) runs as GBrain-INTERNAL jobs,
  not via KnowledgePort; only retrieval/query is exposed.
- WRITE/mutating ops on CalendarPort/TaskPort/NotebookPort are performed ONLY by the
  Tool Gateway, and READ/sync ONLY by the Connector Gateway. No workflow/agent calls a
  write adapter directly; the external-write envelope and idempotency key are held by
  the Tool Gateway.
```

## 7.4 Runtime Decision

The system will build Option B foundation from day one: a control plane above replaceable runtimes. Hermes is not the orchestrator; it is one agent runtime adapter. Claude Agent SDK is also a V1 adapter. The product avoids a custom low-level model loop in V1, but builds the runtime-neutral broker and governance layer required to add or replace runtimes later.

Control-plane location is a deployment variable, not an architectural one. Three seams are selected behind stable interfaces by configuration: the workflow host (WorkflowHostAdapter — local Temporal dev server in V1, remote/Cloud in V1.1), the event-ingress mode (EventIngressAdapter — long-poll in V1, webhook in V1.1), and single-active-instance ownership (InstanceLeaseAdapter — a local lock in V1). The V1.1 hosted control plane therefore changes configuration plus these three adapters only; the connector, runtime, knowledge, and workflow-logic layers are unchanged. This is what makes "config, not a rewrite" a structural property rather than an aspiration.

---

# 8. Product Surfaces and User Experience

## 8.1 Mac Desktop App

The Mac app is the primary human interface. It should be built with Tauri, React, and TypeScript. Initial distribution can be direct GitHub install/build, with signed/notarized builds later if useful.

| Surface | Purpose |
|---|---|
| Global Today Dashboard | Unified calendar, top priorities, conflicts, overdue/critical items, waiting items, suggested plan. |
| Workspace Tabs | Filter views by Employer Work, Personal Business, Personal Life, or All. |
| Project Dashboard | Project health, deterministic progress, blockers, next actions, recent changes, meetings, decisions, sources. |
| Copilot | Ask questions, run workflows, explain project state, process sources, prepare meetings. |
| Ingestion Inbox | Review sources from Telegram, files, URLs, YouTube, podcasts, PDFs, Granola, Drive, GitHub. |
| Approval Inbox | Approve, edit, reject, or defer external actions and sensitive knowledge mutations. |
| Calendar View | Unified availability, workspace filters, conflicts, focus blocks, follow-ups. |
| Recent Changes | Audit timeline for notes, projects, tasks, calendar events, sources, jobs, approvals. |
| System Health | Connector status, GBrain health, workflow failures, queue depth, failed writes, cost, sync lag. |

## 8.2 Telegram

Telegram is a remote interaction and approval channel. It supports capture, quick questions, brief delivery, meeting preparation, approval buttons, and status notifications. Long-polling (outbound getUpdates) is the V1 default: a local Mac has no publicly reachable endpoint for webhook callbacks and opens no inbound port. Webhook delivery requires an internet-reachable inbound port and is deferred to the V1.1 hosted control plane (see §17 Network exposure); a user may self-host an outbound tunnel to opt into webhooks at their own risk, which is not a supported V1 path. The Telegram adapter supports both behind the same ingress abstraction.

- Text capture and commands.
- Voice memo capture and transcription pipeline.
- Photo/document/link ingestion.
- Approval cards with inline buttons.
- Brief notifications and workflow failure alerts.
- Strict sender allowlist and workspace-aware routing.

## 8.3 Obsidian

Obsidian remains a first-class user surface. It opens the Markdown repositories, allowing the user to inspect and edit what the assistant believes. Obsidian is not the integration runtime or scheduler.

- Editable project, meeting, decision, person, daily, review, source, and research notes.
- Human-owned sections that the assistant must not overwrite.
- Assistant-managed sections bounded by explicit markers.
- Optional Bases/views for projects, meetings, tasks, reviews, and sources.
- Graph visualization and manual correction.

---

# 9. Functional Requirements

## 9.1 Workspace and Identity Requirements

| ID | Requirement | Priority |
|---|---|---|
| WS-1 | System shall support at least three logical workspaces: Employer Work, Personal Business, Personal Life. | P0 |
| WS-2 | Every event, source, meeting, task, note, and project shall be assigned a workspace before durable processing. | P0 |
| WS-3 | System shall maintain global coordination metadata for availability, deadlines, cross-workspace priorities, and identity matching. | P0 |
| WS-4 | System shall prevent raw Employer Work content from appearing in other workspaces by default. WS-7 is the verification mechanism for this guarantee. | P0 |
| WS-5 | System shall support user-approved explicit cross-workspace links. | P1 |
| WS-6 | Open-source users shall be able to choose Simple, Professional, Founder/Side Project, or Advanced workspace presets. | P1 |
| WS-7 | The system shall pass an adversarial leakage suite in which, absent an explicit user-approved cross-workspace link (§6.3 Levels 0–2; cf. WS-5), 0 raw Employer Work documents or sentences surface in Personal Business or Personal Life outputs — briefs, Copilot answers, and Global Coordination Layer metadata. | P0 |
| WS-8 | GBrain retrieval shall be workspace-scoped by default (bound to the caller workspace's gbrainBrainId/gbrainSourceId, §10.2). All cross-workspace reads — Global Coordination Layer, global/daily briefs, cross-workspace summaries — shall pass through the Global Coordination Layer acting as the single Visibility Gate, which applies §6.3 levels and emits only Level-1/Level-2 content by default; Level-0 is deny-by-default at the boundary. Agents shall not issue direct cross-brain GBrain queries (single-brain caller-workspace queries remain allowed); the GCL is the sole cross-workspace read path. WS-8 is the enforcement mechanism behind the WS-7 outcome. | P0 |

## 9.2 Knowledge and Retrieval Requirements

| ID | Requirement | Priority |
|---|---|---|
| KN-1 | GBrain shall be required in V1 as the knowledge engine. | P0 |
| KN-2 | GBrain shall provide search, think/synthesis, graph traversal, timelines, schema, health, MCP, Minions, and dream-cycle capabilities. | P0 |
| KN-3 | Semantic knowledge shall be represented in Markdown Git repositories that can be opened in Obsidian. | P0 |
| KN-4 | KnowledgeWriter shall be the only direct writer for durable semantic Markdown changes. | P0 |
| KN-5 | If GBrain or an agent proposes a semantic change, it shall submit a KnowledgeMutationPlan rather than writing directly. | P0 |
| KN-6 | Every approved semantic change shall be auditable and linked to source evidence where available. | P0 |
| KN-7 | Human-owned note sections shall not be overwritten by the assistant. | P0 |
| KN-8 | Assistant-generated note sections shall use explicit start/end markers and stable IDs. | P1 |
| KN-9 | GBrain shall be configured to perform NO direct writes to the canonical Markdown repositories. GBrain's native Markdown write-through, extraction-to-file, and dream-to-file paths shall be disabled or, where not disable-able on the pinned version, intercepted at the filesystem/process boundary and rejected. Any GBrain-originated semantic content (Minion extraction, dream synthesis) reaches Markdown ONLY as a KnowledgeMutationPlan submitted to KnowledgeWriter (KN-4, KN-5, §4.4, §14.4). The GBrain database is a derived index of Markdown (§10.1), never an independent semantic origin. | P0 |
| KN-10 | GBrain retrieval shall return at least one relevant project/person/decision/source context item for 90%+ of a fixed benchmark query set (the §5.4 benchmark query set / EVAL-1 retrieval benchmark; corpus assembled in Phase 0). | P0 |

## 9.3 Runtime and Workflow Requirements

| ID | Requirement | Priority |
|---|---|---|
| RT-1 | System shall expose an AgentRuntimePort with Hermes and Claude Agent SDK adapters in V1. | P0 |
| RT-2 | Agent jobs shall specify workspace, capability, context references, tool policy, max runtime, max cost, output schema, and idempotency key. | P0 |
| RT-3 | Agent results shall be validated against schema before side effects occur. | P0 |
| RT-4 | Temporal shall orchestrate cross-system workflows and approval waits. | P0 |
| RT-5 | GBrain Minions shall be used for GBrain-internal jobs only unless explicitly bridged through control-plane policy. | P0 |
| RT-6 | Hermes cron and Kanban may be supported through the Hermes adapter but shall not replace Temporal as the system workflow source of truth. (See RT-7: Hermes cron/Kanban may run autonomously, but all their side effects are gateway-routed so they cannot bypass idempotency, approval, or the one-writer invariant.) | P1 |
| RT-7 | Temporal is the source of truth for product workflows. Hermes cron and Hermes Kanban MAY operate as autonomous schedulers for user-defined automations, but EVERY external side effect they produce shall route through the Tool Gateway (external-write envelope: idempotency key, canonical object key, preconditions, write receipt; approval policy) and EVERY durable semantic write through KnowledgeWriter (KN-4/KN-5/KN-9) — never via direct vendor API/MCP write tools. Duplicate-write safety and the one-writer invariant are therefore enforced by the gateways regardless of which scheduler fired, so Hermes-local automations cannot produce duplicate, ungoverned, or hidden-brain writes. GBrain Minions cron is restricted to brain-internal maintenance (sync, embed, extract, dream, health) and shall not issue external writes or KnowledgeWriter mutations except through the controlled bridge (RT-5, §14.4, KN-9). The control plane shall enforce a single active instance (LIFE-1) and cap concurrent agent runs against a single-machine resource budget (§13.1 maxRuntimeSeconds/maxCostUsd job caps and §21 cost controls). | P0 |

## 9.4 Meeting Requirements

| ID | Requirement | Priority |
|---|---|---|
| MTG-1 | System shall ingest Granola meetings and correlate them to calendar events, workspaces, projects, attendees, and prior meeting history. | P0 |
| MTG-2 | System shall create or update one canonical meeting note per meeting. | P0 |
| MTG-3 | System shall extract explicit decisions, explicit commitments, risks, open questions, follow-ups, and project state changes. | P0 |
| MTG-4 | System shall never infer task owners or due dates when not stated; unknowns shall be marked TBD or routed for clarification. | P0 |
| MTG-5 | System shall update project notes, person notes, decision records, and daily notes through KnowledgeWriter. | P0 |
| MTG-6 | System shall route task proposals to Todoist, Linear, or Asana according to workspace/project policy. | P0 |
| MTG-7 | System shall propose calendar follow-ups and apply low-risk writes automatically only when policy allows. | P0 |

## 9.5 Project and Task Requirements

| ID | Requirement | Priority |
|---|---|---|
| PRJ-1 | All projects shall share a common project model across workspaces. | P0 |
| PRJ-2 | Projects shall have stable IDs, workspace IDs, aliases, status, outcome, owner, task system mapping, calendar mapping, source mapping, and progress providers. | P0 |
| PRJ-3 | Technical projects shall support IMPLEMENTATION_PLAN.md progress providers. | P1 |
| PRJ-4 | Projects shall display deterministic progress derived from providers, not invented model percentages. | P0 |
| TASK-1 | Personal-life and personal-business tasks shall route to Todoist by default unless project policy overrides. | P0 |
| TASK-2 | Technical work tasks shall route to Linear when configured. | P0 |
| TASK-3 | Operations/general work tasks shall route to Asana when configured. | P0 |
| TASK-4 | Tasks assigned to other people or shared systems shall require approval unless explicitly configured otherwise. | P0 |

## 9.6 Ingestion Requirements

| ID | Requirement | Priority |
|---|---|---|
| ING-1 | All sources shall enter through a canonical ingestion event with source ID, workspace, content hash, origin, content type, user tags, sensitivity, and routing hints. | P0 |
| ING-2 | System shall support Granola transcripts, Telegram messages/files/voice, desktop file upload, URLs, YouTube, podcasts/RSS, PDFs, images/OCR, web articles, GitHub/code sources, and Drive docs. | P1 |
| ING-3 | YouTube and podcast extraction behavior from Obsidian Second Brain shall be ported into source adapters. | P1 |
| ING-4 | Low-confidence routing shall remain in the ingestion inbox rather than being guessed. | P0 |
| ING-5 | Imported content shall be treated as untrusted and shall not be allowed to issue instructions to agents or tools. | P0 |
| ING-6 | The system shall deduplicate by content hash, external ID, source URI, and workflow idempotency key. | P0 |
| ING-7 | Any agent execution consuming untrusted imported content — including `source.ingest` AND `meeting.close` and any capability whose context includes transcripts, sources, web/video/podcast extractions, or NotebookLM outputs — shall run under a read-only toolPolicy with zero KnowledgeWriter / Tool Gateway / Connector Gateway / external-write tools. The control plane shall REJECT at job admission any such job declaring a mutating tool. These agents emit changes only as KnowledgeMutationPlan / ProposedAction (KN-5). | P0 |

## 9.7 Calendar, NotebookLM, and Brief Requirements

| ID | Requirement | Priority |
|---|---|---|
| CAL-1 | System shall read all configured calendars for global availability and conflict detection. | P0 |
| CAL-2 | Private focus blocks and non-shared reminders may be created automatically when policy allows. | P0 |
| CAL-3 | Inviting others, changing shared meetings, or cancelling meetings shall require approval. | P0 |
| NLM-1 | NotebookLM API spike shall determine whether direct notebook/source management is possible. The direct-API path is a V1.1 candidate gated on the spike outcome (§18.3), NOT a V1 deliverable. | P0 (spike) |
| NLM-2 | V1 ships the Drive-backed managed-docs path: the system shall sync project notebooks through managed Google Drive docs/sheets/markdown exports that the user adds to NotebookLM notebooks. NotebookLMApiAdapter is deferred to V1.1, contingent on the §18.3 spike. | P0 |
| BRF-1 | System shall generate global and workspace-specific daily, weekly, and monthly briefs. | P0 |
| BRF-2 | Briefs shall be saved to Markdown and displayed in the Mac dashboard. | P0 |
| BRF-3 | Briefs shall cite or link supporting notes, tasks, calendar events, and sources where practical. | P1 |

## 9.8 Lifecycle & Availability Requirements

Local-first V1: the control plane runs on the Mac (§1.1 Deployment topology) and is inactive while the Mac is asleep. These requirements make recurring P0 flows correct across sleep/wake/restart and are topology-portable — the V1.1 hosted plane satisfies them behind the same ports/adapters.

| ID | Requirement | Priority |
|---|---|---|
| LIFE-1 | Single active instance via an exclusive lease (file lock or Temporal task-queue lease); a second launch attaches read-only or refuses to start workers, never a second control-plane/Temporal scheduler instance (a Hermes cron/Kanban automation scheduler per RT-7 is permitted; its side effects are de-duplicated at the Tool Gateway / KnowledgeWriter, not by forbidding it); a stale lock is recoverable on restart. | P0 |
| LIFE-2 | Durable schedules with catch-up: recurring workflows (daily/weekly/monthly brief, connector sync, review, health) use durable Temporal schedules with a configured catch-up window + overlap policy; firings missed during sleep/shutdown are detected on wake and executed exactly once within a configurable max-staleness window (run the most recent missed occurrence, coalesce older ones — run-once-collapsed, not per-missed-tick), tagged with the intended date. | P0 |
| LIFE-3 | In-flight Temporal workflows interrupted by sleep/quit/restart resume from durable state and complete with exactly-once external side effects via the §16.1 write envelope (idempotency key, canonical object key, preconditions, write receipt); no duplicate notes, tasks, or calendar events on resume. | P0 |
| LIFE-4 | When a connector is unreachable, inbound syncs queue and retry with bounded exponential backoff and outbound external writes hold in the retry/write outbox until reconnect; both surface in System Health with no silent drops. | P0 |
| LIFE-5 | Clock-jump correctness: catch-up uses persisted last-run bookkeeping (monotonic where available), not naive "fire if now≥target", surviving NTP wall-clock correction on wake without duplicate or skipped firings. | P1 |
| LIFE-6 | Wake hooks: the control plane subscribes to OS sleep/wake/power and network-reachability events to trigger catch-up evaluation and connector resync promptly on wake. | P1 |
| LIFE-7 | The system records and displays, per scheduled workflow, the last successful run and the next scheduled run. | P1 |

## 9.9 Observability Requirements

| ID | Requirement | Priority |
|---|---|---|
| OBS-1 | System Health shall display, at minimum: connector status, GBrain health, workflow run status (last run, next run, failed runs), queue depth, failed or blocked KnowledgeWriter write-throughs, GBrain sync lag, agent cost, and approval backlog. | P0 |
| OBS-2 | Each failure class — connector unreachable, failed/blocked write-through, budget (maxCostUsd) breach, missed or late schedule, and schema-validation rejection — shall surface a distinct System Health item that links to its audit record and persists until the underlying condition is resolved or explicitly acknowledged. | P0 |

## 9.10 Data Retention & Deletion Requirements

V1 ships a minimal core: a documented default retention policy plus a user-initiated cross-store deletion workflow. Deeper pruning-policy tuning is deferred to V1.1. See §16.4.

| ID | Requirement | Priority |
|---|---|---|
| RET-1 | Assistant-HELD raw capture (voice memos, recorded/uploaded audio, OCR intermediates, cached payloads) shall have a configurable retention policy with a documented default. Externally-authoritative sources (e.g., Granola transcripts, §10.1) are kept as links, not re-stored. Default: raw audio is deleted after audited synthesis; other raw payloads are pruned after a configurable window (default 30 days). | P0 |
| RET-2 | A user-initiated deletion workflow shall purge a source/meeting/project across Markdown (via KnowledgeWriter, preserving the one-writer invariant), the GBrain index/graph, and the control-plane event store, and tombstone the audit trail. As an explicit user action it is exempt from the §16.2 "deletion requires approval" default and is logged per §16.3. | P0 |
| RET-3 | Automated retention pruning shall never delete human-owned note sections (§14.3) or derived semantic notes, and is distinct from §16.2 autonomous-deletion controls. Pruning-policy tuning beyond the documented defaults is deferred to V1.1. | P1 |

## 9.11 Cost & Budget Requirements

| ID | Requirement | Priority |
|---|---|---|
| COST-1 | Every agent job shall ENFORCE maxRuntimeSeconds and, when set, maxCostUsd: exceeding either cancels the job, records it (§16.3), surfaces it (§8.1 / §9.9 OBS-2), and leaves no partial uncommitted side effect. | P0 |
| COST-2 | The Agent Runtime Broker shall apply a configurable DEFAULT cap to LLM-calling jobs that lack one (§13.1 maxCostUsd remains optional on the contract). | P1 |

Aggregate per-workspace/global daily/monthly spend caps with auto-pause are deferred to V1.1 (§18.3).

## 9.12 Evaluation & Measurement Requirements

| ID | Requirement | Priority |
|---|---|---|
| EVAL-1 | V1 shall ship a versioned evaluation set that computes the statistical §5.4 metrics via a repeatable evaluation harness: (a) labeled meeting-closeout transcripts with gold workspace/project/decision/task labels, (b) a retrieval benchmark of queries with gold relevant-doc sets (the KN-10 benchmark), and (c) an adversarial cross-workspace leakage set (reused by the §16/§19 red-team tests and WS-7). Default corpus sizes: ≥20 transcripts, ≥30 queries (owner-confirmable). The corpus is drafted in Phase 0 (§18.1). | P0 |

---

# 10. Data Model and Canonical Objects

## 10.1 Source of Truth Matrix

| Data | Authoritative System | Representation in Assistant |
|---|---|---|
| Scheduled events | Google Calendar | Calendar snapshot, meeting note link, project/date references. |
| Personal task status | Todoist | Task reference, project next action, commitment summary. |
| Technical work execution | Linear | External task/project link, project progress provider. |
| General operations work | Asana | External task/project link, project status provider. |
| Raw meeting transcript | Granola | Transcript link/source record, meeting synthesis, decisions, commitments. |
| Semantic project knowledge | Markdown Git repository | Project notes, decisions, meeting summaries, sources, reviews. |
| Search/graph/index | GBrain derived database | Derived index, fully rebuildable from Markdown and approved external records; any non-rebuildable semantic state is a tracked defect, not steady state (see §14.5). GBrain's native DB-first Markdown write-through is disabled/intercepted per KN-9, so GBrain does not write the canonical Markdown; Markdown is authoritative, and any DB-only semantic fact is quarantined and the GBrain index is re-built from Markdown (§14.1, §14.5, §21). |
| Workflow state | Control plane / Temporal | Operational state only; not semantic memory. |
| Notebook analysis | NotebookLM / Drive | Managed source docs and returned insights ingested as sources. |

## 10.2 Core Object Sketches

```
Workspace {
  id: string
  name: string
  type: employer_work | personal_business | personal_life
  dataOwner: employer | user | client
  defaultVisibility: isolated | coordination | sanitized | full
  gbrainBrainId?: string
  gbrainSourceId?: string
  calendars: CalendarAccount[]
  taskSystems: TaskSystemMapping
  notebookPolicy: NotebookPolicy
  egressPolicy: EgressPolicy   // permitted external processors (§16.5)
}

Project {
  id: string
  workspaceId: string
  name: string
  aliases: string[]
  kind: employer_project | side_income | client | life_admin | learning | code
  status: active | paused | completed | archived | someday
  outcome: string
  definitionOfDone?: string
  taskSystem: todoist | linear | asana | none
  externalProjectRefs: ExternalRef[]
  calendarAliases: string[]
  notebookMappings: NotebookMapping[]
  progressProviders: ProgressProvider[]
}

KnowledgeMutationPlan {
  planId: string
  workspaceId: string
  sourceRefs: SourceRef[]
  creates: NoteCreate[]
  patches: NotePatch[]
  linkMutations: LinkMutation[]
  frontmatterUpdates: FrontmatterPatch[]
  externalActionProposals: ProposedAction[]
  confidence: number
  requiresApproval: boolean
}
```

## 10.3 Project Frontmatter Example

```yaml
---
assistant-id: project_atlas
workspace-id: personal-business
type: project
project-kind: side-income
status: active
owner: user
outcome: "Launch the Mac-first system-of-work assistant MVP"

task-system: linear-personal
linear-project-id: lin_proj_123
asana-project-id: null
todoist-project-id: todoist_456

calendar-aliases:
  - Atlas
  - System of Work Assistant

granola-folder-id: granola_atlas
notebooklm-key: atlas-research
google-drive-folder-id: drive_folder_789
repository-path: ~/Projects/system-of-work-assistant
implementation-plan: IMPLEMENTATION_PLAN.md

cross-workspace-visibility: sanitized
---
```

---

# 11. Core Workflows

## 11.1 Meeting Closeout Workflow

1. The scheduled connector sync (polling; see §11.4 step 2) detects a completed Granola transcript and emits a transcript-completed event into the control plane. In V1 this trigger is poll-based, not a push webhook.
2. Workflow correlates transcript to calendar event, workspace, project, and attendees.
3. Workflow gathers GBrain context for project, people, prior meetings, decisions, open tasks, and relevant sources.
4. AgentRuntimeBroker selects Hermes or Claude Agent SDK according to job policy.
5. Agent returns structured MeetingCloseResult with decisions, commitments, project updates, people updates, risks, open questions, and proposed external actions.
6. Validator rejects unsupported claims, inferred owners, missing evidence, and ambiguous project routing.
7. KnowledgeWriter updates meeting, project, person, decision, daily, and source notes.
8. Tool Gateway creates low-risk external actions or requests approval for sensitive/shared changes; the Tool Gateway (not the agent) holds the idempotency key and external-write envelope, guaranteeing the replay-safety asserted in the Acceptance note.
9. GBrain sync/index/dream jobs run as appropriate.
10. Dashboard and Telegram summarize the result.

> **Resumption:** if the Mac sleeps or the worker restarts mid-workflow, Temporal resumes the run on wake and the external actions in steps 7–9 are guarded by the idempotency key / write envelope (LIFE-3, §16.1), so resumption produces no duplicate notes, tasks, or calendar events.

> **Acceptance:** replaying the same meeting event must not create duplicate meeting notes, tasks, or calendar events.

## 11.2 Scheduling a Personal Appointment

1. User asks via Mac Copilot or Telegram to schedule an appointment.
2. Intent router assigns Personal Life workspace and Health area unless user specifies otherwise.
3. Global Coordinator fetches busy/free metadata across Personal Life, Personal Business, and Employer Work calendars.
4. Assistant proposes windows that avoid conflicts and respect buffers.
5. If event has no invitees and policy allows, system creates event automatically in the personal calendar.
6. If invitees, external notifications, or sensitive details are involved, system requests approval.
7. Daily note and relevant area/project note are updated if the appointment affects commitments or plans.

## 11.3 Source Ingestion Workflow

1. Source arrives from desktop, Telegram, URL, YouTube, podcast, Drive, GitHub, Granola, or watched folder.
2. Ingestion service registers SourceEnvelope, validates content type, computes hash, and applies safety policy.
3. Source-specific adapter extracts content and metadata.
4. Router classifies workspace, project, tags, sensitivity, and desired processing depth.
5. Low-confidence items remain in Ingestion Inbox.
6. Agent extracts knowledge delta: summary, claims, decisions, commitments, entities, dates, contradictions, links.
7. KnowledgeWriter applies approved note mutations.
8. Optional NotebookLM sync updates project-managed source documents.
9. GBrain indexes and graph-links the new/changed knowledge.

## 11.4 Daily Brief Workflow

1. A durable Temporal schedule fires the daily brief at the user-configured time. Because the V1 control plane is local, if the Mac was asleep/off at fire time the most recent missed occurrence runs once on next wake within the catch-up window (LIFE-2), collapsed (not replayed per missed day) and tagged with the intended brief date.
2. Connector sync refreshes calendars, Todoist, Linear, Asana, and recent Granola events.
3. GBrain retrieves active projects, waiting items, critical facts, recent changes, and relevant timeline entries; any cross-workspace assembly goes through the Global Coordination Layer Visibility Gate (WS-8), not raw cross-brain search.
4. Briefing agent creates a global brief with workspace sections and citations/links.
5. Brief is written to Markdown and dashboard read model.
6. Telegram sends a short summary and link to dashboard.

## 11.5 Project Sync Workflow

1. Workflow runs on demand, nightly, or after relevant events.
2. Project registry resolves external task systems and progress providers.
3. Deterministic progress parser reads IMPLEMENTATION_PLAN.md checkboxes or external project status.
4. Agent synthesizes explanation of progress, blockers, risks, waiting items, and next actions.
5. KnowledgeWriter updates project current status and dashboard projection.
6. External writes are proposed only when needed and governed by approval policy.

---

# 12. Integration Requirements

## 12.1 Required V1 Integrations

| Integration | Role | Default Write Policy |
|---|---|---|
| GBrain | Knowledge engine, retrieval, graph, MCP, Minions, dream, health. | Internal maintenance allowed; semantic writes through KnowledgeWriter. |
| Obsidian Markdown Repo | Human-facing knowledge workspace. | KnowledgeWriter only, plus user manual edits. |
| Hermes Agent | Runtime adapter, messaging/gateway, MCP-heavy execution, subagents. | No direct durable semantic or external writes without gateway. |
| Claude Agent SDK | Runtime adapter for structured Claude jobs. | Tool permissions and control-plane approvals. |
| Google Calendar | Scheduled commitments and availability. | Private user-only writes automatic; shared/invite writes approval. |
| Granola | Meeting transcript source. | Read/source only in V1. |
| Todoist | Personal tasks. | Self-owned task creation may be automatic. |
| Linear | Technical project execution. | Self-assigned task creation may be automatic; shared changes approval. |
| Asana | General operations project execution. | Shared task/status changes approval. |
| Telegram | Remote interface and approvals. | No external system changes except approval commands. |
| Google Drive/Docs | NotebookLM managed docs and shared source files. | Managed doc updates via policy. |
| NotebookLM | Project-specific analysis workspace. | API spike; fallback is Drive-managed source docs. |
| GitHub | Source repo context, open-source install, code project linking. | Repo writes approval unless user explicitly works in code mode. |
| YouTube/Podcast/RSS | Research/source ingestion. | Read/extract only; knowledge writes through KnowledgeWriter. |

> **Connector reachability (local-first).** Linear, Asana, and Granola are remote vendor services reached over the network with OAuth (the referenced integration surface for each is the vendor's MCP server: R24 Linear, R23 Asana, R26 Granola); they are not local. Like all external connectors (Google Calendar, Todoist, Drive, GitHub, Telegram), they are subject to the connector-unreachable queue/retry path and offline degradation defined in §9.8 and §17. When a connector is unreachable the affected reads/writes queue and retry on reconnect rather than failing the workflow.

## 12.2 NotebookLM Approach

NotebookLM direct API support remains an explicit spike. V1 uses the Drive-backed sync path as its committed deliverable: the assistant creates and updates managed Drive docs that the user adds to NotebookLM notebooks. NotebookLMApiAdapter remains a V1.1 candidate, gated on the spike outcome (§18.3); no public notebook/source-management API is assumed for V1.

```
Drive-backed NotebookLM fallback:
Project Atlas
  -> 00 Project Brief Google Doc
  -> 01 Decision Log Google Doc
  -> 02 Meeting Digest Google Doc
  -> 03 Research and Sources Google Doc
  -> 04 Open Questions Google Doc
  -> User adds these docs to NotebookLM once
  -> Assistant updates Docs; the user (or the assistant, where a supported
     re-sync action exists) refreshes the NotebookLM sources --
     continuous auto-sync of arbitrary Drive docs is NOT assumed
```

---

# 13. Agent Runtime Strategy

## 13.1 Runtime-Neutral Contract

```
AgentJob {
  id: string
  workflowRunId: string
  workspaceId: string
  capability: meeting.close | daily.brief | project.sync | source.ingest | task.route | notebooklm.sync
  prompt: string
  contextRefs: ContextRef[]
  outputSchema: JsonSchema
  toolPolicy: ToolPolicy
  maxRuntimeSeconds: number
  maxCostUsd?: number
  idempotencyKey: string
}

AgentResult {
  jobId: string
  runtime: hermes | claude-agent-sdk | deterministic
  status: succeeded | failed | needs_clarification | needs_approval
  output: object
  citations: SourceRef[]
  proposedActions: ProposedAction[]
  knowledgeMutationPlan?: KnowledgeMutationPlan
  logs: AgentLogEntry[]
}
```

## 13.2 Hermes Adapter Requirements

- Support bounded Hermes runs via the best validated surface: API server, TUI gateway, Python wrapper, or Kanban bridge.
- Support MCP tool access, but prefer routing mutating tools through the Tool Gateway.
- MCP tool policy denies all GBrain write/ingest tools by default; mutating tools are reachable only through the Tool Gateway, and only KnowledgeWriter triggers GBrain semantic sync.
- Support structured-output validation externally even if Hermes does not natively guarantee schema outputs.
- Support progress events, stop/cancel, and logs when available.
- Hermes cron and Kanban MAY run as standalone autonomous automations; their external side effects route through the Tool Gateway and their semantic writes through KnowledgeWriter (RT-7), so they cannot produce duplicate, ungoverned, or hidden-brain writes. They are not the product workflow source of truth (Temporal is). Kanban/subagent fan-out (§13.4) is available both standalone and when driven by a Temporal-owned job.
- Support workspace-scoped prompts and tool policies.

## 13.3 Claude Agent SDK Adapter Requirements

- Use TypeScript SDK in V1 to align with Tauri/React/TypeScript stack.
- Use JSON Schema structured outputs for workflow results.
- Use permission modes, tool allow/deny, canUseTool, hooks, and MCP server configuration.
- Configure tool allow/deny and canUseTool to deny GBrain write/ingest MCP tools by default, mirroring the read-only GBrain MCP policy in §14.4.
- Support session persistence and external transcript mirroring where feasible.
- Support sandboxed execution via process override or containerization spike.
- Use as fallback or preferred runtime for high-structure jobs that require strict output schema.

## 13.4 Runtime Selection Policy

> **Default reference runtime:** Claude Agent SDK is the default/reference runtime for a baseline open-source install (see §13.5). The per-job preferences in the table below are optimizations applied only when Hermes is also configured; they are not install requirements and preserve runtime-neutral execution (§4.2).

| Job Type | Preferred Runtime | Rationale |
|---|---|---|
| Strict structured extraction | Claude Agent SDK | Native structured-output and permission surface. |
| Messaging-native interaction | Hermes | Already lives on messaging channels and supports gateway interactions. |
| MCP-heavy exploratory task | Hermes or Claude SDK | Select based on tool reliability and workspace policy. |
| Parallel research fanout | Hermes subagents/Kanban or Claude SDK subagents | Capability-specific spike decides default. |
| Deterministic parsing/progress | Deterministic worker | No LLM required for checkbox counts, hashes, IDs, or policy. |

## 13.5 Default Runtime

Claude Agent SDK is the DEFAULT reference runtime for V1. A fresh open-source install is fully operational on Claude Agent SDK alone — no Hermes installation is required for a successful first run, and the Tauri/React/TypeScript stack (§13.3) aligns natively with it. HermesRuntimeAdapter remains a REQUIRED, DoD-tested adapter (RT-1; §19 Hermes Adapter Surface spike; §20.2) but is OPT-IN: installing Hermes is not a prerequisite for the §20.1 open-source install test to pass. When Hermes is not installed, the Runtime Selection Policy (§13.4) falls back to Claude Agent SDK for every job type — including Messaging-native interaction — so a Claude-SDK-only install remains fully functional across all V1 surfaces, including Telegram.

---

# 14. Knowledge System: Obsidian + GBrain + KnowledgeWriter

## 14.1 Knowledge Ownership

Markdown is canonical for semantic knowledge. GBrain is required for indexing, retrieval, graph, schema, synthesis, health, and internal jobs. The control plane stores workflow state, approvals, and audit, but not durable semantic knowledge.

## 14.2 KnowledgeWriter Requirements

- Accept only structured KnowledgeMutationPlans.
- Resolve note IDs and prevent duplicate pages.
- Validate workspace, source evidence, frontmatter, links, and generated-section ownership.
- Preserve user-owned sections.
- Perform three-way merge or create conflict review item when necessary.
- Write to Markdown atomically.
- Record revision, actor, source event, workflow run, and idempotency key.
- Trigger GBrain sync/index/dream jobs as appropriate.
- The atomic Markdown write is the durability commit point; GBrain index/sync is an asynchronous, idempotent, retryable follow-on keyed by the recorded revision id, and never gates or rolls back a committed Markdown write.
- Run a parity check between Markdown (canonical) and the GBrain index on every write and on a periodic schedule: every GBrain semantic node must trace to a Markdown source span, and every assistant-managed Markdown block must be represented in the index. Markdown is authoritative on divergence — a GBrain node with no Markdown provenance is quarantined and surfaced in System Health as a "DB-only semantic fact" defect and, if it is genuine new knowledge, queued as a KnowledgeMutationPlan (KN-5); a stale/missing index entry triggers re-index from Markdown.
- A failed or lagging GBrain index/sync enqueues a re-index outbox item and surfaces as GBrain sync lag in System Health (§9.9, §17) — distinct from a failed Markdown write-through; both share the §16.1 retry outbox and parity checks.
- For each note's read-modify-write window apply a compare-revision precondition; reject the write and raise a conflict review item if the on-disk revision changed since read, so concurrent KnowledgeWriter operations or out-of-band GBrain write-through cannot silently lose updates.
- On control-plane wake, pending KnowledgeWriter writes are applied before queued GBrain index jobs, and index jobs re-derive from current Markdown by revision id rather than replaying stale queued deltas.
- Run a blocking secret scan on every mutation: reject (do not write) any mutation containing credential-shaped strings and surface it as a System Health review item rather than silently redacting.
- Expose failed write-through items in System Health until resolved.

## 14.3 Note Ownership Markers

```
## Current status
<!-- assistant:generated:project-status:start -->
Generated status goes here.
<!-- assistant:generated:project-status:end -->

## My notes
Human-owned content goes here. The assistant may read but not overwrite.
```

## 14.4 GBrain Capability Use in V1

| GBrain Capability | V1 Use |
|---|---|
| Search/query/think | Used by all workflows to locate project, person, decision, meeting, source, and concept context. |
| Typed graph | Used to connect projects, people, meetings, decisions, sources, and workspaces. |
| Schema packs | Custom assistant schema pack defines page types/link types for the system. |
| MCP | Read/query/graph ONLY. The GBrain MCP surface exposed to any runtime (Hermes or Claude SDK) is restricted to non-mutating tools: search, think/synthesis, graph traversal, timeline, schema read, health. No GBrain ingest or mutate tool is ever exposed to a runtime. All durable semantic mutations (including any GBrain ingest or dream output) MUST be expressed as a KnowledgeMutationPlan and applied by KnowledgeWriter. |
| Minions | Used for sync, embed, extract, dream, health, and other GBrain-internal jobs; per KN-9 these jobs never write the canonical Markdown working tree directly (they maintain derived index/embedding/health state only). |
| Dream cycle | Disabled by default in V1; native dream-to-file write-through disabled (KN-9). Runs propose-only — emits KnowledgeMutationPlans to KnowledgeWriter — and only after the §19 GBrain Full Capability Bridge spike passes (opt-in behind a config flag until validated). Durable semantic outputs always go through KnowledgeWriter, never DB-first into canonical Markdown. See §16.2, §19.1, §21. |
| Health/doctor | Displayed in System Health and used by maintenance workflows. |
| Ingestion contract | Evaluated and used where stable; adapter may bridge canonical ingestion events to GBrain ingestion. |

## 14.5 Parity and Reconciliation

The GBrain index must be fully reconstructible from Markdown plus approved external records at any time. A reconstruction that loses semantic content is a tracked defect, not acceptable steady state. If the Phase-0 GBrain Round Trip spike (§18.1 Phase 0; §19) cannot demonstrate parity-safe write-through, GBrain operates READ-ONLY to the Markdown brain (retrieval and indexing only, no DB-only semantic truth, GBrain re-synced from Markdown) until parity is validated — consistent with "GBrain read-heavy until validated" (§21). GBrain remains required in V1 (KN-1); only durable write-through is gated.

---

# 15. Obsidian Second Brain Capability Coverage

The build should take the useful capabilities from Obsidian Second Brain, but not run the original repository as an independent writer. The useful parts become workflow semantics, source adapters, and skill specifications routed through the new control plane, GBrain, and KnowledgeWriter.

## 15.1 Capability Inventory and Disposition

| OSB Capability | Disposition in This Build | Priority |
|---|---|---|
| /obsidian-world context loading | Port as Workspace/Global Context Loader using GBrain search and project registry. | P0 |
| /obsidian-project | Port project creation/update semantics into Project Workflow. | P0 |
| /obsidian-task | Port task triage/routing semantics into Task Router for Todoist/Linear/Asana. | P0 |
| /obsidian-meeting | Port meeting preparation and meeting-note semantics. | P0 |
| /obsidian-agenda / schedule / calendar | Port calendar agenda, conflict, focus-gap, attendee-context, and scheduling policies. | P0 |
| /obsidian-save | Port as Session Checkpoint workflow. Hermes/Claude sessions submit durable knowledge candidates. | P0 |
| /obsidian-ingest | Replace with canonical ingestion workflow; retain semantic extraction and routing ideas. | P0 |
| /youtube | Port source-specific YouTube extractor as YouTubeAdapter. | P1 |
| /podcast | Port RSS/transcript/Whisper fallback behavior as PodcastAdapter. | P1 |
| /obsidian-review / recap / daily | Port daily close, weekly review, monthly review, and recap semantics. | P0/P1 |
| Background agent | Replace with Temporal Session Checkpoint + GBrain dream/maintenance bridge. | P0 |
| Four scheduled agents | Implement as product workflows: morning, nightly, weekly, health; add monthly. | P0/P1 |
| /obsidian-architect | Port into Implementation Plan / GitHub / codebase progress workflow. | P1 |
| /notebooklm | Replace/extend with NotebookLM sync workflow and API spike; retain vault-grounded synthesis concept. | P1 |
| AI-first note rules | Incorporate into custom schema pack and KnowledgeWriter validations. | P0 |
| Bi-temporal facts | Blend with GBrain timelines/takes and schema fields. | P1 |
| Telegram catchup | Implement as Telegram capture + Ingestion Inbox workflow. | P1 |
| Research/X/web/youtube/podcast workflows | Port high-value source adapters after meeting/project core flows. | P1/P2 |

## 15.2 Explicit Non-Adoption

- Do not allow original OSB slash commands to directly rewrite the Markdown brain in production.
- Do not run OSB background agent independently from GBrain dream or Temporal workflows.
- Do not keep separate OSB and GBrain knowledge stores.
- Do not duplicate task ownership between Obsidian notes and Todoist/Linear/Asana.
- Do not assume every source should deep-rewrite many existing notes; use ingestion profiles and policy.

---

# 16. Security, Privacy, and Safety Requirements

## 16.1 Threat Model

| Threat | Mitigation |
|---|---|
| Prompt injection from transcripts, calendar descriptions, docs, web pages, NotebookLM outputs, or Markdown sources | Treat imported content as untrusted data; source-processing agents lack mutating tools (enforced by ING-7: empty mutating-tool policy + control-plane job-admission rejection); use prompt-injection scanning and policy gates. |
| Workspace leakage | Separate workspace credentials, GBrain brain/source scope, visibility levels, and synthetic adversarial tests; enforced by the WS-8 Visibility Gate (single cross-workspace read path, deny-by-default Level-0, no direct cross-brain queries). |
| Duplicate external writes on retry | External write envelope with idempotency key, canonical object key, preconditions, and write receipt. Vendor create-tools for the write connectors (e.g., Linear, Asana — whether via MCP or REST/GraphQL) do not accept native idempotency keys, so the layer MUST perform a pre-write existence check by canonical object key / external ID before every create and reuse the matched object on hit. (Granola is read/source-only in V1.) See ING-6 and the §5.4 duplicate-prevention metric. |
| Unapproved shared changes | Approval required for invites, shared meeting changes, assigning others, shared PM status changes, deletion, and external messages. |
| Runtime writes semantic content into the GBrain DB via MCP, bypassing KnowledgeWriter (hidden brain) | Expose only a read-only GBrain MCP capability set to runtimes; mutating GBrain tools reachable solely via the Tool Gateway; KnowledgeWriter is the sole trigger of GBrain semantic sync; parity check that the GBrain DB holds no durable semantic content absent from Markdown or an approved external record (enforces KN-9). |
| Secrets in Markdown | Secrets stored only in the macOS Keychain via SecretsPort — never in `.env`, never in a Markdown repo. KnowledgeWriter and a Git pre-commit hook run a blocking secret scan over Markdown repos; any credential-shaped match blocks the write/commit. Repos ship with a `.gitignore` excluding `.env` and other secret/config files. |
| Agent runtime overreach | Runtimes receive tool policies; mutating tools route through Tool Gateway and KnowledgeWriter. |
| Corrupted knowledge writes | Atomic writes, revisions, diff/audit, retry outbox, conflict review, and GBrain parity checks (defined in §14.2 / §14.5). |
| Open-source install misconfiguration | Safe defaults, loopback-only binding (enforced per §17 Network exposure NFR), explicit token scopes, install doctor, health dashboard. |

## 16.2 Autonomy Policy

| Action | Default V1 Policy |
|---|---|
| Read notes, calendar, tasks, meetings, source docs | Automatic, workspace-scoped. |
| Write Markdown brain notes | Automatic only when ALL hold: low-risk, evidence-backed, content has PASSED prompt-injection scanning (§16.1, ING-5/ING-7), submitted as a KnowledgeMutationPlan (KN-5) and applied by KnowledgeWriter (KN-4), and the write is intra-workspace. Any cross-workspace note write requires approval regardless of risk (WS-4/WS-5/WS-8). Always audited. |
| Create private personal task | Automatic if explicit user commitment or user request. |
| Create private focus block | Automatic if no invitees and no conflict. |
| Create self-assigned Linear/Asana task from explicit commitment | Automatic or low-friction approval depending workspace policy. |
| Invite other people to events | Approval required. |
| Assign task to someone else | Approval required. |
| Modify shared project status | Approval required. |
| Delete/archive notes or tasks | Approval required. |
| Send email/message externally | Denied in V1 unless a future feature enables explicit approval. |
| Resolve ambiguous contradictions | Approval required. |
| GBrain dream / Minion-originated semantic note write | Disabled by default in V1; propose-only via KnowledgeMutationPlan + KnowledgeWriter (approval per policy), gated by the §19 GBrain Full Capability Bridge spike; never written DB-first into the canonical Markdown brain. |

## 16.3 Audit Requirements

- Every workflow run has an ID, workspace, trigger, actor, and idempotency key.
- Every agent job records runtime, input context references, output schema, result, cost, and logs where available.
- Every KnowledgeWriter mutation records before/after diff or patch summary.
- Every external write records tool, target system, payload hash, approval ID if any, result, and external object ID.
- Every failed write or sync remains visible until resolved.

## 16.4 Data Retention & Deletion

The system minimizes retained raw material and gives the user a hard delete. Retention applies only to assistant-HELD copies (voice/audio, OCR intermediates, cached payloads); externally-authoritative records (Granola transcripts, Calendar events) are referenced by link, not re-stored (§10.1). Defaults (RET-1): raw audio is deleted after audited synthesis; other raw payloads are pruned after a configurable window (default 30 days). A user-initiated deletion (RET-2) purges a source/meeting/project across Markdown (via KnowledgeWriter), the GBrain index/graph, and the event store, and tombstones the audit trail. Automated pruning never touches human-owned note sections (§14.3) or derived semantic notes (RET-3). Deeper retention/pruning policy controls are V1.1.

## 16.5 Third-Party Egress Policy

Each Workspace declares an `egressPolicy` (§10.2) naming the external processors permitted to receive raw content: the configured cloud-LLM runtime (Claude Agent SDK → Anthropic API, or a cloud Hermes endpoint) and mapped Google Drive / NotebookLM. Unlisted processors receive metadata only. Personal Business and Personal Life default to permitting the configured cloud-LLM runtime plus mapped Drive/NotebookLM. **Employer Work defaults to NO third-party egress of raw content**: cloud-LLM processing of raw Employer Work content requires an explicit, surfaced per-workspace egress acknowledgment (default off). Enforcement is at the Tool Gateway / Agent Runtime Broker before content leaves the device; current egress permissions are shown in System Health. Note: the Claude Agent SDK adapter constitutes Anthropic-API egress (§13.3); zero-egress operation would require a local-only model. Because the V1 employer meeting-closeout flow uses a cloud runtime, the Employer Work branch of that DoD flow (§20.2) requires this egress acknowledgment to be enabled.

---

# 17. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Reliability | Meeting closeout, brief generation, and message intake survive worker restarts and transient connector failures without duplicate writes; and survive Mac sleep/wake and shutdown/restart, firing missed schedules exactly once on wake (see §9.8 LIFE-1..LIFE-4). |
| Performance | Dashboard loads from read models without requiring live LLM calls; normal views target sub-2-second load after local cache warmup. |
| Offline behavior | In V1 the control plane runs locally on the Mac — there is no remote control plane that can be degraded. The Mac app reads local Markdown/Obsidian state at all times, independent of network/connector status. When external connectors or the network are unreachable while the local control plane is up, inbound syncs are queued and outbound external writes are held and retried on reconnect (LIFE-4). When the Mac is asleep or shut down, no control-plane processing occurs; on wake/restart, missed schedules catch up (LIFE-2) and in-flight Temporal workflows resume without duplicate side effects (LIFE-3). Processing while the Mac is asleep is deferred to the V1.1 hosted control plane. |
| Lifecycle & availability | LOCAL control plane in V1: on wake/restart the system performs missed-schedule catch-up (one coalesced run per schedule), resumes in-flight Temporal workflows with exactly-once side effects, assumes a single active instance, and queues connector-unreachable writes for reconciliation (§9.8). True sleep-through 24/7 is deferred to the V1.1 hosted control plane (§18.3). |
| Network exposure (local-first V1) | All control-plane, Temporal, GBrain, and Mac-app backend services SHALL bind to loopback (127.0.0.1) only; V1 opens no inbound network ports. Telegram delivery uses outbound long-polling. Webhook/inbound ingress is deferred to the V1.1 hosted control plane behind the same ports/adapters (ingress) abstraction (a user may self-host an outbound tunnel to a loopback-bound endpoint at their own risk; not a supported V1 path). |
| Extensibility | All integrations and runtimes use adapter interfaces. |
| Portability | Knowledge remains understandable Markdown even if the app is removed. |
| Observability | Expose workflow status, queue depth, connector health, GBrain health, GBrain sync lag (target: index visibility ≤60s and dashboard read model ≤10s from KnowledgeWriter commit; exceedances surfaced in System Health), failed-write/retry-outbox depth, cost, errors, and approval backlog. |
| Installability | Open-source users can install with documented local dev path and optional Docker Compose services. |
| Maintainability | Pin GBrain to a specific known-good commit/tag, recorded as an exact SHA in repo config; likewise pin Hermes, Claude Agent SDK, and Temporal CLI versions. Maintain a GBrain compatibility contract test: index a fixture Markdown repo, run search/graph/health, apply a KnowledgeWriter write, then re-read and assert no Markdown corruption and the expected query results on the fixture corpus. This contract test, with per-runtime smoke tests and an upgrade checklist, MUST pass before any pinned-runtime version bump (GBrain in particular) is accepted. |
| Privacy | Workspace boundaries are enforced in runtime prompts, tool scopes, storage, and dashboard filters. |

---

# 18. Implementation Plan and Milestones

## 18.1 Recommended Build Sequence

| Phase | Scope | Exit Criteria |
|---|---|---|
| 0. Architecture spikes | Hermes adapter path, Claude SDK adapter, GBrain round-trip, NotebookLM API, meeting closeout synthetic test. | Spike reports with go/no-go, constraints, and the branch each no-go triggers, classified by criticality: **CRITICAL-PATH GATES** — (a) GBrain round-trip [no-go ⇒ read-only-GBrain branch; KnowledgeWriter remains sole semantic writer; GBrain read-heavy/read-only per §21 until validated]; (b) Claude SDK adapter [no-go ⇒ V1 blocked, escalate]; (c) meeting-closeout synthetic [no-go ⇒ re-sequence/de-risk Phase 4]. **PARALLEL-TRACK** — Hermes adapter [required, DoD-tested (§20.2); no-go does NOT block the critical path (Claude SDK carries Phase 4+) but stays tracked/escalated, not deferred]. **NON-BLOCKING** — NotebookLM API [no-go ⇒ Drive-backed fallback, already the V1 default (NLM-2); gates no phase]. Each consuming phase cites its spike result: Phase 2 (GBrain round-trip), Phase 3 (Hermes + Claude SDK), Phase 4 (meeting-closeout synthetic), Phase 9 (NotebookLM API). GBrain known-good version selected and pinned (SHA recorded in repo config). Draft the EVAL-1 evaluation corpora (meeting-closeout labels, retrieval benchmark, adversarial leakage set) and the red-team injection corpus. |
| 1. Foundation | Control plane skeleton, data model, workspace registry, project registry, event store, audit, KnowledgeMutationPlan schema; single-active-instance lock (only one control-plane instance holds the scheduler/worker lease) and durable schedule state with a configured Temporal Schedule catch-up window + overlap policy (Skip/BufferOne) recording missed fire-times across sleep/restart windows (LIFE-1/LIFE-2); plus a bootstrap install script + documented prerequisites verified on a clean Mac via a scripted clean-environment check (CI where practical) from Phase 1 onward, kept green as later phases add Temporal, GBrain, runtimes, Tauri, and connectors. The external-write envelope PRIMITIVE/schema (idempotency key, canonical object key, precondition fields, write-receipt record) and approval-state persistence are built here as a reusable library, exercised against a connector STUB. | Can register workspaces/projects and persist workflow events; on restart, a schedule whose fire-time elapsed while down runs exactly once (collapsed), and a second concurrent control-plane instance fails to acquire the lease; the external-write envelope library passes idempotent replay against a stub. |
| 2. Knowledge substrate | Markdown repos, Obsidian-compatible structure, GBrain PGLite, GBrainAdapter, KnowledgeWriter prototype. | Obsidian edit → GBrain search → KnowledgeWriter update → Obsidian valid Markdown; GBrain compatibility contract test green against the pinned version; round-trip satisfies §19 (a)–(d) before acceptance, otherwise proceed in the Phase-0 read-only fallback. |
| 3. Runtime adapters | HermesRuntimeAdapter and ClaudeAgentSdkRuntimeAdapter with structured result validation. | ClaudeAgentSdkRuntimeAdapter (V1 reference runtime) passes the bounded test workflow first and unblocks Phase 4. HermesRuntimeAdapter is built in parallel and must pass the identical adapter-conformance test before V1 DoD; Phase 4+ may proceed on Claude SDK alone if Hermes lags, but Hermes remains a required V1 deliverable. |
| 4. Meeting closeout MVP | Granola + Calendar correlation + project/person context + tasks/actions + notes; in-flight Temporal workflows interrupted by sleep/restart resume from durable state and reuse idempotency keys (LIFE-3, §16.1) so no external side effect is duplicated on resume. Live external writes run dry-run/preview in Phase 4 against connector stubs (live write replay-safety is bound in Phase 5). | One real or synthetic meeting closes end-to-end with no duplicate notes/tasks/calendar PROPOSALS on replay against stubs. |
| 5. Task/calendar connectors | Todoist, Linear, Asana, Google Calendar write policies, approval UI, and Telegram approval channel (long-poll bot, strict sender allowlist, approval cards with inline buttons, workflow-failure alerts); in-flight workflows resume on wake without duplicating external side effects (LIFE-3). | Live connector adapters bind the Phase-1 envelope to real systems; external writes are idempotent end-to-end and approval-gated; a shared-action approval can be approved or rejected from Telegram and is audited exactly once. |
| 6. Mac app MVP | Dashboard, Copilot, Ingestion Inbox, Approval Inbox, Project view, Calendar view. | User can operate the system from Mac UI; the same shared-action approval can be approved or rejected from BOTH the Mac Approval Inbox and Telegram, with a single idempotent audit record (closes §20.2 "Approval inbox works from Mac and Telegram" and §20.1 Approval flow). |
| 7. Briefs/reviews | Morning brief, daily close, weekly review, monthly review, health workflow; on-wake catch-up: daily/brief schedules missed during a sleep/restart window run once on next wake, collapsed (one brief), not replayed per missed day (LIFE-2). | Briefs generated, saved to Markdown, and displayed; after a simulated multi-hour sleep spanning the scheduled brief time, exactly one catch-up brief is produced on wake with no duplicate external writes. |
| 8. Source adapters | YouTube, podcast, PDF/OCR, GitHub/code, Drive docs. | Sources route correctly and update knowledge through KnowledgeWriter. |
| 9. NotebookLM | Drive-managed source documents are the committed V1 path; the direct-API path is a V1.1 candidate only if the Phase 0 spike validates it. | Project pack syncs to NotebookLM via Drive-managed docs. |
| 10. Install hardening & presets | Polish setup docs, sample workspace presets, example config, optional local Docker Compose — building on the clean-install path kept green since Phase 1. | Fresh install from GitHub still succeeds on a clean Mac, now with presets and the sample-workspace demo — satisfying the §20.1 open-source-install test, the §20.2 "run locally/self-hosted" DoD bullet, and the §5.4 install-reproducibility metric. |

**GBrain Round Trip gate (Phase 0 → Phase 2).** KnowledgeWriter is the sole Markdown writer in BOTH outcomes (KN-4/KN-9). GO requires §19 (a)–(d): GBrain's best-effort Markdown write-through is disabled/contained so it never competes with KnowledgeWriter, the round-trip is lossless, and GBrain controlled-layer outputs (dream/Minions) are accepted only as KnowledgeMutationPlans; on GO, GBrain's write-through is enabled, while dream/Minion semantic write-back remains separately gated behind the §19 Full Capability Bridge spike and a config flag (§14.4) until validated. NO-GO ⇒ GBrain ships READ-ONLY (search/think/graph/schema/timeline/health and GBrain's own rebuildable index only), re-synced FROM Markdown after each KnowledgeWriter write, with dream/Minion semantic write-back disabled. The NO-GO read-only branch is the DEFAULT until GO is proven and alone satisfies §20.2.

## 18.2 V1 Scope

- Mac-first Tauri app from source or local build, direct signing optional.
- Three logical workspaces with global coordination metadata.
- Markdown Git repos opened in Obsidian.
- GBrain PGLite required, accessed through a single GBrain-owning process (local CLI/subprocess or localhost sidecar) so the single-writer PGLite file is never opened by multiple processes; Postgres/Supabase migration path documented.
- Hermes and Claude Agent SDK runtime adapters (Claude Agent SDK is the default reference runtime; Hermes is a required, DoD-tested but opt-in adapter).
- Temporal (LOCAL dev server with persistent SQLite storage) workflows for core cross-system flows, so in-flight workflow history survives Mac sleep/restart.
- Granola, Google Calendar, Todoist, Linear, Asana, Telegram, Google Drive/Docs, GitHub.
- Meeting closeout, daily brief, project dashboard, task routing, calendar coordination, approvals.
- KnowledgeWriter and one-writer semantic write policy.
- GBrain full READ/retrieval/graph/schema/synthesis/health surface available through the controlled layer, subject to the no-direct-write configuration (KN-9); semantic write-back (dream/Minions output) is read-heavy by default and gated/propose-only behind the Phase-0 GBrain Round Trip + Full Capability Bridge spikes (§19), enabled only on a parity pass. If those spikes are NO-GO, GBrain ships READ-ONLY to the Markdown brain (KnowledgeWriter owns 100% of Markdown writes, GBrain re-indexed from Markdown); this still satisfies the V1 DoD (§20.2).

## 18.3 V1.1 and Future Scope

| Release | Candidate Features |
|---|---|
| V1.1 | Single-user hosted/always-on control-plane deployment — the assistant stays active while the Mac is asleep (the deferred true 24/7 capability from the V1 local-first decision), enabled purely by configuration behind the existing ports/adapters with no rewrite, including remote/Temporal Cloud (WorkflowHostAdapter), public webhook ingress (EventIngressAdapter), and a shared instance-lease backend (InstanceLeaseAdapter); NotebookLM direct API if validated; richer Hermes Kanban; Postgres/Supabase migration; 1Password/pluggable secret providers; remote/sidecar GBrain deployment; Gmail; Slack; advanced OCR/PDF; improved installer; project templates; aggregate per-workspace/global spend caps with auto-pause (extends COST-1/COST-2); deeper data-retention/pruning policy controls (extends RET-1..3). |
| V1.2 | Multi-machine sync hardening, mobile companion, more PM integrations, advanced GBrain schema packs, richer cross-workspace summaries. |
| Future | Optional multi-user/team mode, hosted deployment templates, plug-in marketplace, additional runtimes, enterprise security profiles. |

---

# 19. Research Spikes and Open Questions

| Spike | Question | Acceptance Criteria |
|---|---|---|
| Hermes Adapter Surface | Which Hermes surface is best for bounded structured jobs: API server, TUI gateway, Python wrapper, Kanban, or hybrid? | Run one meeting-close mock through Hermes with schema validation, stop/cancel, logs, and controlled tools. |
| Claude SDK Adapter | Can Claude SDK run the same mock workflow with permissions, structured outputs, and MCP/GBrain context? | Adapter returns identical schema and obeys tool policy. |
| GBrain Round Trip | Can a Markdown repo opened in Obsidian remain canonical while GBrain indexes and controlled writes update it? | GO requires ALL of: (a) after an Obsidian edit + GBrain sync, an fs-watch audit shows zero Markdown mutations by any process other than KnowledgeWriter (verifies the one-writer / no-hidden-brain invariant against GBrain's DB-first write-through); (b) a GBrain index/Minion job running concurrently with a KnowledgeWriter write produces no lost update and no malformed Markdown; (c) a GBrain-DB-only fact injected out-of-band is flagged by the Markdown↔GBrain parity check; (d) Markdown stays syntactically valid AND semantically lossless after the round-trip. On NO-GO, GBrain ships READ-ONLY per the Phase-0 gate. |
| GBrain Full Capability Bridge | How should GBrain dream/Minions submit semantic outputs through KnowledgeWriter? | Spike must demonstrate (a) GBrain can be configured to never touch the Markdown working tree (fs-watch/audit shows zero non-KnowledgeWriter mutations during a combined dream+Minion run) AND (b) GBrain-originated semantic deltas can be captured and re-emitted as KnowledgeMutationPlans to KnowledgeWriter. Until this spike passes, dream/Minion semantic write-back stays disabled (propose-only behind a config flag). If neither (a) nor (b) is achievable on the pinned version, GBrain ships read-only/index-only and the Phase-0 gate records this as the V1 default. |
| NotebookLM API | Is direct notebook/source CRUD/query/export possible through supported API? | Document official API feasibility; otherwise lock Drive-backed fallback. |
| Granola Connector | What is the best supported way to pull transcripts, metadata, summaries, decisions, and actions? | One transcript ingests with external ID and calendar correlation. |
| Cross-Workspace Policy | What metadata can safely coordinate across workspaces? | Adversarial tests prove personal/work leakage rules; adversarial tests also prove that no injected source can drive a cross-workspace disclosure or external send (red-team injection corpus covering the five §16.1 vectors plus the cross-workspace exfiltration case). |
| Implementation Progress | Can IMPLEMENTATION_PLAN.md plus Linear status produce robust technical project progress? | Parse real plan and cross-check with Linear without invented percentages. |
| Sleep/Wake Lifecycle | Do Temporal durable schedules + catch-up and in-flight resume behave correctly across real macOS sleep, lid-close, and restart on the local plane? | Sleeping the Mac through a scheduled brief and a mid-run meeting-closeout yields exactly one coalesced brief on wake for the correct date and a closeout that resumes to completion once, with zero duplicate external side effects. |
| Control-plane portability | Are the workflow-host, event-ingress, and instance-lease seams config-selectable without touching workflow/connector code? | On a throwaway environment, flip WorkflowHostAdapter to an alternate Temporal endpoint and swap EventIngressAdapter (poll→stub webhook) by config only; the meeting-close mock runs unmodified with no source changes outside the three adapters. |
| Cross-store deletion | Can a user-initiated purge atomically (or compensatably) remove an entity from Markdown, the GBrain index/graph, and the event store without orphans? | Deleting a seeded source/meeting/project leaves no trace in any store and no dangling links; re-indexing from Markdown does not resurrect it. |
| Evaluation corpus | Can a minimal labeled corpus + harness compute the §5.4 statistical metrics reproducibly? | EVAL-1 corpora (meeting-closeout labels, retrieval benchmark, leakage set) drive the §20.1 evaluation-set test with stable numbers across runs. |

## 19.1 Remaining Open Questions

**Resolved** by the local-first deployment decision and the no-hidden-brain invariant — no longer open:

1. **Temporal:** V1 ships the bundled Temporal LOCAL dev server (`temporal server start-dev`) with PERSISTENT storage via `--db-filename` (SQLite under app data); the in-memory default is NOT used so workflow history survives Mac sleep/restart. Temporal Cloud is a V1.1 config option behind the WorkflowHostAdapter.
2. **GBrain process model:** V1 runs GBrain locally as a control-plane-managed CLI/subprocess or localhost sidecar; exactly ONE process owns the PGLite file (PGLite is single-connection embedded Postgres — concurrent openers corrupt it), so the control plane, Minions, and any CLI invocations reach the brain through GBrain's API/MCP and never open the DB file directly. MCP remains GBrain's knowledge interface regardless of process model. Remote/sidecar-container deployment is a V1.1 option.
3. **Secrets:** V1 stores user secrets in the macOS Keychain via a pluggable SecretsPort; `.env` is dev-only; 1Password CLI and other providers are V1.1 adapters.
4. **GBrain dream/autopilot:** autonomous dream/Minion semantic write-back is DISABLED by default in V1 (propose-only via KnowledgeMutationPlan, gated on the §19 Full Capability Bridge spike).
5. **Retention:** RET-1 sets the default — raw audio is deleted after audited synthesis; other assistant-held raw payloads are pruned after a configurable window (default 30 days). Deeper pruning-policy tuning is V1.1 (§9.10, §16.4).

**Still open:**

- Should personal-business be its own GBrain brain or a source inside a personal-owned brain at initial install?
- Should Markdown repos be one repo per workspace or a monorepo with workspace subdirectories?

---

# 20. Acceptance Criteria

## 20.1 End-to-End Acceptance Tests

| Test | Pass Criteria |
|---|---|
| Meeting closeout replay | Same Granola event processed twice yields one meeting note, one set of tasks, one set of calendar proposals, one audit trail. (Proposal/note replay-safety verified at Phase 4 via the Phase-1 envelope against stubs; live external-write replay-safety verified at Phase 5.) |
| Workspace routing | Synthetic work, side-project, and personal-life meetings route to correct workspaces and project notes. |
| Cross-calendar scheduling | Doctor appointment workflow reads global busy/free and avoids work and side-project conflicts. |
| Knowledge write | Approved project update appears in Markdown on KnowledgeWriter commit and in Obsidian on reload; the derived surfaces (GBrain search and dashboard read model) appear within the configured sync window (default targets from KnowledgeWriter commit: GBrain search ≤60s, dashboard ≤10s). A write whose derived surfaces exceed the window fails the test and is surfaced in System Health. |
| Approval flow | Shared calendar invite proposal appears in Mac and Telegram, can be edited, approved, rejected, and audited. |
| Project progress | Implementation plan parser computes progress from checkbox evidence and displays next unchecked task. |
| Prompt injection | Injection delivered through each §16.1 vector — (a) Granola transcript, (b) calendar event description, (c) web/YouTube/podcast source text, (d) NotebookLM/Drive returned doc, (e) an existing Markdown note. For every vector: the source-processing agent runs with an empty/read-only toolPolicy so no external write or message send occurs (§16.1, ING-5, ING-7); any proposed semantic change is emitted only as a KnowledgeMutationPlan and does not auto-apply (KN-5); and an exfiltration payload instructing cross-workspace disclosure or external send produces 0 cross-workspace leakage (WS-4) and 0 external action (§16.2). A red-team injection corpus covering these five vectors plus the cross-workspace exfiltration case is a Phase-0 deliverable exercised by the §19 Cross-Workspace Policy spike. |
| Open-source install | A clean machine can run the documented install and execute the sample workspace demo on the default Claude Agent SDK runtime, without installing Hermes. |
| Sleep-through-brief & resume | With the Mac asleep across the scheduled brief time and a meeting-closeout interrupted mid-side-effect, on wake the brief runs exactly once for the intended date, the closeout resumes from its last durable step, there are 0 duplicate notes/tasks/calendar events, and queued connector syncs drain. |
| Retrieval relevance | GBrain search/think returns at least one relevant context item for ≥90% of the §5.4 benchmark query set; misses are logged to System Health. (verifies §5.4 Retrieval usefulness, KN-10) |
| Workspace leakage | Adversarial suite confirms that, with no approved cross-workspace link (§6.3 Levels 0–2; cf. WS-5), 0 raw Employer Work documents or sentences appear in Personal Business / Personal Life outputs or Global Coordination Layer reads. (verifies §5.4 Workspace isolation, WS-4/WS-7) |
| GBrain write-through parity & divergence detection | After a KnowledgeWriter mutation + GBrain index, a parity check confirms Markdown semantic content matches what GBrain indexed; a deliberately induced GBrain-DB-only write is detected and either reconciled to Markdown via KnowledgeWriter or quarantined and surfaced as a "DB-only semantic fact" defect in System Health; no such write becomes durable canonical state without Markdown provenance; re-indexing GBrain from Markdown recovers every semantic node with none lost. |
| Human-section preservation | An assistant write through KnowledgeWriter to a note with a human-owned section (§14.3 markers) updates only the assistant-generated section; the human-owned section is byte-identical before and after; an attempted overwrite is rejected and recorded in the audit trail (KN-7, §16.3). |
| System Health surfacing | Inducing a connector outage, a failed write-through, and a missed/late schedule each produces a distinct, correctly-typed System Health item that links to the audit record and persists until the condition is resolved. |
| Retention purge | A user-initiated deletion of a source/meeting/project removes it from Markdown (via KnowledgeWriter), the GBrain index/graph, and the event store, tombstones the audit trail, and leaves no orphaned references; human-owned sections of surviving notes are untouched. (RET-2/RET-3) |
| Budget cap | A job exceeding maxRuntimeSeconds or maxCostUsd is cancelled, recorded, and surfaced in System Health with no partial uncommitted external side effect. (COST-1, OBS-2) |
| Evaluation set | The EVAL-1 corpora exist and the harness computes the §5.4 meeting-closeout, retrieval (KN-10), and leakage (WS-7) metrics reproducibly across runs. |
| Hermes standalone automation | A Hermes cron/Kanban automation that attempts an external write or note change has its side effect routed through the Tool Gateway (idempotent, approval-gated) and its semantic write through KnowledgeWriter; a replayed automation produces no duplicate external action and no direct Markdown/GBrain write. (RT-7) |
| Egress acknowledgment | With Employer Work egress acknowledgment OFF, no raw Employer Work content reaches a third-party processor (cloud LLM/Drive/NotebookLM); enabling it permits the employer meeting-closeout flow; the current state is shown in System Health. (§16.5) |

## 20.2 Definition of Done for V1

- The user can run the system locally/self-hosted with documented setup.
- Mac app shows global and workspace-specific dashboard data.
- Claude SDK is the V1 reference runtime and carries the meeting-closeout critical path, which is not gated on Hermes. Both the Hermes and Claude SDK adapters can execute bounded jobs, and Hermes must pass the same bounded-job adapter-conformance suite for V1 DoD (required, not optional).
- GBrain is required, configured, and providing search/think/graph/health (read-only retrieval/graph/health is sufficient for the V1 DoD; GBrain-originated durable Markdown writes are NOT a DoD requirement).
- Markdown repos can be opened in Obsidian and remain valid after system writes.
- Granola meeting closeout works end-to-end (the Employer Work branch requires the §16.5 egress acknowledgment to be enabled).
- Google Calendar, Todoist, Linear, and Asana writes are governed by policy and idempotency.
- Daily brief and weekly review are generated and saved.
- Approval inbox works from Mac and Telegram.
- At least one YouTube or podcast source adapter is operational or explicitly deferred with a ticket.
- After a sleep/restart window, missed schedules catch up exactly once on wake (collapsed, not per-missed-day) and in-flight workflows resume without duplicate side effects; only one control-plane instance is active at a time.
- User-initiated cross-store deletion (RET-2) and the default retention policy (RET-1) work; pruning-policy tuning is deferred to V1.1.
- Every agent job enforces its runtime/cost caps (COST-1).
- The EVAL-1 evaluation set exists and computes the §5.4 statistical metrics (meeting-closeout, retrieval, leakage).
- Untrusted-content agents are tool-stripped and rejected at job admission if they declare a mutating tool (ING-7); cross-workspace reads pass only through the Visibility Gate (WS-8).

---

# 21. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Over-complex architecture | Slow delivery and brittle integration. | Phase sequence starts with meeting closeout; defer non-essential connectors. |
| GBrain write-through divergence | Hidden DB truth or stale Markdown. | One-writer policy (KN-4/KN-9 disable GBrain native write-through); parity checks (§14.2/§14.5); write outbox; GBrain read-heavy/read-only until validated. If the phase-0 GBrain Round Trip / Full Capability Bridge spike (§19) fails go/no-go, V1 ships GBrain READ-ONLY to the Markdown brain (retrieval/graph/timeline/health and GBrain's own rebuildable index only; no GBrain/Minion/dream-originated semantic Markdown writes; index rebuilt from Markdown on schedule); dream/Minion write-back deferred to V1.1. DoD §20.2 still met. |
| Hermes integration instability | Runtime adapter unreliable. | Also ship Claude Agent SDK adapter; keep runtime broker pluggable; critical path routes through Claude SDK so Hermes lag is a parallel-track risk, not a Phase-4 blocker. |
| Availability gap (local-first) | Control plane on a sleeping/off Mac misses P0 schedules or suspends in-flight workflows. | Durable schedules with catch-up (coalesced, max-staleness), single-active-instance lease, idempotent in-flight resume via write envelope, connector retry/queue outbox, wake hooks (§9.8 LIFE-1..6); deferred true 24/7 moves to the V1.1 hosted control plane behind the same ports/adapters. |
| Workspace leakage | Privacy/security failure. | Visibility levels, scoped prompts/tools, synthetic leakage tests. |
| Duplicate external writes | Bad calendar/task state. | Idempotency keys, write receipts, Temporal workflow state, precondition checks. |
| NotebookLM API unavailable | Direct sync impossible. | Drive-backed managed source docs fallback. |
| Too much autonomy too early | User trust loss. | Default sensitive writes to approval; expose clear audit and undo/correction paths. |
| Open-source install burden | Other users cannot adopt. | Presets, sample config, doctor command, local dev mode. |
| Cost explosion | High API bills. | Runtime budgets, maxCostUsd, job caps, GBrain local PGLite, cache, deterministic first. |
| Prompt injection | Unsafe actions or corrupted notes. | Untrusted source handling, tool gateway, approval policy, sandboxing, red-team tests. |

---

# 22. References

The PRD is based on user-provided deep research results, direct repository review, and public project/vendor documentation. The following references should be revisited during implementation spikes.

| ID | Source | URL |
|---|---|---|
| R1 | Hermes Agent README | https://github.com/NousResearch/hermes-agent |
| R2 | Hermes Programmatic Integration Docs | https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration |
| R3 | Hermes MCP Feature Docs | https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp |
| R4 | Hermes Cron Feature Docs | https://hermes-agent.nousresearch.com/docs/user-guide/features/cron |
| R5 | Hermes Delegation/Subagents Docs | https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation |
| R6 | Hermes Kanban Feature Docs | https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban |
| R7 | Claude Agent SDK Overview | https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-overview |
| R8 | Claude Agent SDK TypeScript Reference | https://docs.anthropic.com/en/docs/claude-code/sdk/typescript |
| R9 | Claude Agent SDK Permissions and Tool Use | https://docs.anthropic.com/en/docs/claude-code/sdk/permissions |
| R10 | Claude Agent SDK Hooks | https://docs.anthropic.com/en/docs/claude-code/sdk/hooks |
| R11 | GBrain Repository | https://github.com/garrytan/gbrain |
| R12 | GBrain Retrieval Architecture | https://github.com/garrytan/gbrain/blob/main/docs/architecture/RETRIEVAL.md |
| R13 | GBrain Engines Documentation | https://github.com/garrytan/gbrain/blob/main/docs/ENGINES.md |
| R14 | GBrain Brains and Sources | https://github.com/garrytan/gbrain/blob/main/docs/architecture/brains-and-sources.md |
| R15 | GBrain Minions Deployment Guide | https://github.com/garrytan/gbrain/blob/main/docs/guides/minions-deployment.md |
| R16 | GBrain Cron Schedule Guide | https://github.com/garrytan/gbrain/blob/main/docs/guides/cron-schedule.md |
| R17 | GBrain Security Notes | https://github.com/garrytan/gbrain/blob/main/SECURITY.md |
| R18 | Obsidian Second Brain Repository | https://github.com/eugeniughelbur/obsidian-second-brain |
| R19 | NotebookLM Sources Help | https://support.google.com/notebooklm/answer/16215270 |
| R20 | NotebookLM Notebook and Artifact Help | https://support.google.com/notebooklm/answer/16206563 |
| R21 | Temporal Workflow Concepts | https://docs.temporal.io/workflows |
| R22 | Telegram Bot API | https://core.telegram.org/bots/api |
| R23 | Asana MCP Server Docs | https://developers.asana.com/docs/using-asanas-mcp-server |
| R24 | Linear MCP Docs | https://linear.app/docs/mcp |
| R25 | Todoist Developer Docs | https://developer.todoist.com/rest/v2/ |
| R26 | Granola MCP Docs | https://docs.granola.ai/help-center/sharing/integrations/mcp |

## 22.1 Notes on Evidence Level

- Hermes and Claude Agent SDK capabilities should be revalidated against pinned versions during implementation.
- GBrain Minions, dream, ingestion, and schema-pack internals remain required V1 capabilities but need integration spikes before being relied on for production writes.
- NotebookLM direct API remains unconfirmed; Drive-backed managed sources are the default fallback.
- Vendor APIs for Granola, Calendar, Todoist, Linear, Asana, Drive, and Telegram should be checked during connector implementation for current rate limits, scopes, and endpoint behavior.

---

# Appendix A. Resolution Log — Appendix-A Items Folded Into v0.3

**Status: ALL EIGHT ACCEPTED** and folded into the v0.3 body (owner sign-off, 2026-06-28). A2 (retention) and A6 (cost) were scoped to a minimal V1 core with their aggressive parts deferred to V1.1 (§18.3); A1, A3, A4, A5, A7, A8 were accepted in full.

Where each landed: **A1** → ING-7 (§9.6) + §16.1 + §20.1; **A2** → §9.10 RET-1..3 + §16.4 + §17 + §19 spike + §20.1 test + §19.1 resolved; **A3** → WS-8 (§9.1) + §6.1 + §11.4 + §16.1; **A4** → §16.5 + `Workspace.egressPolicy` (§10.2) + §20.1/§20.2; **A5** → §16.2 auto-write row; **A6** → §9.11 COST-1/COST-2 + §5.4 + §20.1 (aggregate spend-cap → V1.1); **A7** → §9.12 EVAL-1 + §18.1 Phase 0 + §19 + §20.1 + §5.4 wording; **A8** → §18.1 Phases 1/4/5 + §20.1 replay note.

The table below is retained as the historical record of each item and the rationale that originally required sign-off (the "Why it needs sign-off" column).

| # | Area | Proposed change (summary) | Why it needs sign-off |
|---|---|---|---|
| A1 | Tool-stripping enforcement (new ING-7, §16.1, §20.1) | Make "agents consuming untrusted content run with a read-only toolPolicy" a P0 functional requirement with a control-plane **job-admission gate** that rejects any such job declaring a mutating tool — covering `meeting.close` (the primary transcript path), not just `source.ingest`. | Generalizes an asserted control into a new enforced control surface across multiple capabilities; a real new admission gate, not a wording fix. (The §20.1 injection test already stands via §16.1/ING-5/KN-5/WS-4.) |
| A2 | Data Retention & Deletion (new §9.10 + §16.4 + NFR + spike + test) | Configurable retention for assistant-HELD raw capture (default recommendation: delete raw audio after audited synthesis; prune other raw payloads after 30–90 days); a user-initiated cross-store deletion workflow (Markdown via KnowledgeWriter, GBrain index/graph, event store, audit tombstone); automated pruning distinct from §16.2 autonomous-deletion. | Adds a substantial new subsystem (cross-store purge + retention) and sets privacy defaults (delete-audio-after-synthesis, window length) — genuine owner decisions; resolves the still-open §19.1 retention question. |
| A3 | Cross-Workspace Visibility Gate (new WS-8, §6.1, §11.4, §16.1, §17) | GBrain retrieval workspace-scoped by default; all cross-workspace reads pass through the Global Coordination Layer as the **single Visibility Gate** applying §6.3 levels; agents may not issue cross-brain queries; the GCL is the sole cross-workspace read path. | New mandatory P0 enforcement obligation + hard cross-brain-query prohibition; the **mechanism** behind the WS-7 outcome test. (Number it WS-8; WS-7 stays the leakage suite.) |
| A4 | Third-Party Egress Policy (new §16.5, §10.2 `Workspace.egressPolicy`) | Each workspace declares permitted external processors (cloud LLM, Drive/NotebookLM); Employer Work defaults to **no third-party egress of raw content**, requiring an explicit surfaced opt-in; enforced at the Tool Gateway / Runtime Broker before content leaves the device. | New governance subsystem + data-model field; interacts with the DoD — the V1 employer meeting-closeout flow uses a runtime that egresses, so "Employer Work egress off by default" gates a DoD branch on an informed opt-in. A real privacy/product decision. |
| A5 | Autonomy tightening (§16.2 "Write Markdown brain notes" row) | Make auto-write conditional on ALL of: low-risk, evidence-backed, **injection-scan passed**, via KnowledgeMutationPlan+KnowledgeWriter, and **intra-workspace**; any cross-workspace note write requires approval regardless of risk. | Mostly restates existing controls but tightens a settled autonomy default; confirm alongside the autonomy posture. |
| A6 | Cost/budget enforcement (new COST-1/COST-2, §5.4, §20.1) | COST-1 (P0): every agent job enforces maxRuntimeSeconds and, when set, maxCostUsd (overrun cancels, records, surfaces, leaves no partial side effect). COST-2 (P1): broker applies a configurable default cap to uncapped LLM jobs. Flag an aggregate per-workspace/global daily/monthly spend cap with auto-pause as V1.1 candidate. | COST-1 is largely consistency, but the aggregate spend-cap is net-new capability and the question of making §13.1 `maxCostUsd` required is a runtime-contract decision. Owner decides how much budget enforcement is in V1. |
| A7 | Evaluation corpora (new EVAL-1, §18.1, §19, §20.1, §5.4 wording) | V1 ships a versioned evaluation set computing the statistical §5.4 metrics: labeled meeting-closeout transcripts (gold workspace/project/decision/task), a retrieval benchmark (gold relevant docs), and the adversarial leakage set; default sizes ≥20 transcripts, ≥30 queries. | New P0 deliverable + numeric commitments. The AUTO KN-10/WS-7 tests reference a "benchmark/adversarial corpus" that EVAL-1 formalizes; if deferred, the author must still name a minimal Phase-0 corpus (KN-10 already says "corpus assembled in Phase 0"). |
| A8 | Idempotency phase-resequencing (§18.1 Phases 1/4/5) | Add the external-write envelope **primitive/schema** + approval-state persistence to Phase 1 as a reusable library against a connector stub; Phase 4 proves no duplicate notes/tasks/calendar **proposals** on replay (live writes dry-run/preview in Phase 4); Phase 5 binds the envelope to real systems with live write-receipt replay. | Rewrites §18.1 phase boundaries/exit criteria (a build-plan resequencing); cuts no scope but reordering the V1 plan is the delivery owner's call. **Note:** if accepted, merge with the AUTO Telegram-approval clause in the Phase 5 exit cell. |

---

# Appendix B. Conflict Resolutions for Owner Awareness

The review surfaced eight conflicts; six were resolved mechanically inside the body. Two warrant explicit awareness:

- **RT-7 reworked — Hermes cron/Kanban autonomy RETAINED (owner direction, resolving Conflict 7).** v0.2 had disabled Hermes cron/Kanban autonomy by default; v0.3 reverses that per owner direction (the owner runs Hermes continuously). Hermes cron/Kanban MAY run as standalone autonomous automations, but RT-7 now requires every external side effect to route through the Tool Gateway (envelope + idempotency + approval) and every durable semantic write through KnowledgeWriter. Duplicate-write safety and the one-writer invariant are therefore enforced by the gateways, not by forbidding a second scheduler; Temporal remains the source of truth for *product* workflows. A §20.1 "Hermes standalone automation" test verifies the gateway routing. (This is the larger change v0.2 flagged as out-of-scope; it is now the chosen V1 design.)
- **§20.2 adapter DoD bullet rewritten (Conflict 3).** Two findings preferred leaving the bullet unchanged to preserve DoD; two preferred naming Claude the critical-path runtime. Resolved toward the rewrite because it explicitly **keeps Hermes REQUIRED** (must pass the conformance suite for DoD) while assigning Claude the critical path — satisfying both "keep full DoD" and "default reference runtime." If you prefer minimal DoD edits, we can instead leave §20.2 unchanged and carry the default-runtime designation only in §1.1/§13.5/§18.2.

Other resolved ID/numbering decisions: **KN-9** = GBrain no-direct-write (load-bearing invariant); **KN-10** = retrieval relevance. **WS-7** = adversarial leakage suite (outcome); a proposed Visibility-Gate mechanism would be **WS-8** (Appendix A3). **§9.8** = Lifecycle & Availability; **§9.9** = Observability; any accepted Appendix-A requirements append as §9.10+.
