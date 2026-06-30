# Product Brief

Status: rough-draft planning artifact for `/arch-finalize`.
Source PRD: `system_of_work_assistant_prd_v0_3.md` v0.3 Draft, dated 2026-06-28.
Planning mode: Expanded.
Build posture: production-grade.

## Product in One Sentence

The System of Work Assistant is a Mac-first, local-first, self-hosted personal operating system that routes meetings, sources, tasks, calendar commitments, and project memory across employer work, personal business, and personal life while preserving user-owned Obsidian-compatible Markdown as canonical semantic memory.

## What the Product Is

- [locked decision] A single-owner assistant for one power user who wants durable, inspectable memory across work and life.
- [locked decision] A local-first control plane that runs on the Mac when the Mac is awake, with hosted/always-on deployment deferred behind the same ports/adapters.
- [locked decision] A governed orchestration layer above external tools: Calendar, Todoist, Linear, Asana, Granola, Telegram, Google Drive/Docs, GitHub, YouTube/podcast/RSS sources, NotebookLM fallback paths, GBrain, Hermes, Claude/OpenAI/OpenRouter/local model providers, and Obsidian.
- [locked decision] A production-grade architecture with idempotency, approvals, audit trails, workspace isolation, prompt-injection defenses, retention/deletion workflows, cost/runtime caps, lifecycle recovery, and conformance tests in scope.
- [locked decision] A user-owned knowledge system: Markdown Git repositories are canonical; Obsidian remains a first-class human surface for reading and editing those repositories.

## What the Product Is Not

- [locked decision] Not a SaaS multi-tenant product in V1.
- [locked decision] Not a generic chatbot.
- [locked decision] Not a replacement for Calendar, Todoist, Linear, Asana, Granola, NotebookLM, GitHub, or Obsidian.
- [locked decision] Not a hidden database as semantic source of truth.
- [locked decision] Not an unrestricted agent runtime; all durable semantic writes route through KnowledgeWriter and all external write side effects route through Tool Gateway.
- [locked decision] Not an always-on hosted service until V1.1.

## Primary Problem

The user has meaningful commitments, sources, meetings, decisions, and tasks scattered across work, side projects, and personal life. Current tools each own a slice, but none provides a privacy-aware orchestration and memory layer that can understand relationships, close loops, preserve source evidence, and keep long-term knowledge inspectable in Markdown.

## Primary User

- [locked decision] One technical power user.
- [locked decision] The same person is owner, operator, administrator, and reviewer in V1.
- [locked decision] Future technically capable open-source users matter for installability, but they do not change the V1 actor model.

## Product Principles

- [locked decision] User-owned memory: long-term semantic knowledge lives in Markdown repos that Obsidian can open.
- [locked decision] One writer: KnowledgeWriter is the only autonomous semantic Markdown writer.
- [locked decision] External systems stay authoritative for their domains.
- [locked decision] Workspace-aware by default: every event/source/task/note is assigned to a workspace before durable processing.
- [locked decision] Global coordination without raw leakage.
- [locked decision] Deterministic before latent: code handles identity, policy, idempotency, progress, validation, and routing; agents handle extraction, synthesis, and explanation.
- [locked decision] Approvals are product state.
- [locked decision] Runtime and provider neutrality, with strict schema gates before side effects.

## Core Workflow

The primary V1 proof spine is meeting closeout:

1. A completed Granola transcript is detected by scheduled connector sync.
2. The control-plane worker correlates it to calendar event, workspace, project, attendees, and prior context.
3. GBrain retrieval runs only against the caller workspace brain.
4. The Agent Runtime Broker selects an allowed runtime/provider according to workspace, capability, egress, cost, and schema constraints.
5. The source-processing agent runs with read-only/no-mutating tools and returns a schema-validated result.
6. The validator rejects unsupported claims, ambiguous routing, inferred owners/dates, or schema failures.
7. KnowledgeWriter applies approved semantic Markdown mutations to the workspace repo/vault only.
8. Tool Gateway applies or proposes external side effects using idempotency keys, canonical object keys, preconditions, approval state, and write receipts.
9. Dashboard, Telegram, audit, read models, and GBrain re-index reflect the result.

## User-Confirmed Architecture Updates to PRD

- [locked decision] Replace the PRD's Tauri desktop shell with Electron.
- [locked decision] Electron renderer is unprivileged; Electron main is thin and supervises a dedicated Node/TypeScript control-plane worker.
- [locked decision] Use one Obsidian-compatible Markdown Git repo/vault per workspace.
- [locked decision] Use one GBrain brain per workspace; the Global Coordination Layer is the only cross-workspace coordination/read path.
- [locked decision] Add a separate sanitized Global/Coordination Markdown repo so global briefs/reviews remain inspectable in Obsidian.
- [locked decision] Use dual operational-store adapters from day one: SQLite local and standard Postgres hosted-compatible, managed through Drizzle.
- [locked decision] Use a TypeScript monorepo with pnpm workspaces and Turbo.
- [locked decision] Add ModelProviderPort with V1 support for Claude, OpenAI, OpenRouter, Ollama, and LM Studio.

## Acceptance Definition

V1 is accepted only when the PRD's real integration set works against production-grade gates. Stubs may support earlier phases but cannot replace final DoD behavior. The meeting-closeout spine proves the hardest path first, but full PRD V1 remains in scope and sequenced.

