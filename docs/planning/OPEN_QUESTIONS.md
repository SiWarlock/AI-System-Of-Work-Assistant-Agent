# Open Questions

Status: rough-draft planning artifact for `/arch-finalize`.

## Must Resolve Before Final Architecture

| ID | Question | Why It Matters | Current Best Guess | Resolve By | Fallback |
|---|---|---|---|---|---|
| OQ-001 | What exact Electron packaging/signing/notarization target is required for V1? | Affects installer, permissions, sidecar/worker packaging | Direct GitHub/local build first; signing optional | `/arch-finalize` or install spike | Document unsigned local build path |
| OQ-002 | Which streaming primitive should the worker API use for status/events: tRPC subscriptions over WebSocket or SSE-style stream? | Affects local API implementation and reconnection behavior | tRPC procedures plus one push stream; final primitive chosen by spike | API spike | WebSocket if bidirectional events needed; SSE if one-way status only |
| OQ-003 | What exact default models should each provider use per capability? | Affects evals, cost, quality, and docs staleness | Do not lock in draft; require config + provider conformance | Provider spike | Disable provider/capability until selected |
| OQ-004 | What default maxRuntimeSeconds and maxCostUsd should each capability use? | Needed for budget enforcement | Use conservative unset maxCostUsd only where impossible; enforce runtime caps | Runtime policy design | Owner-configurable defaults with safe warnings |
| OQ-005 | What is the minimal EVAL-1 seed corpus size for first green build? | Determines evaluation workload | PRD default: >=20 transcripts and >=30 queries, owner-confirmable | Phase 0 build | Smaller smoke corpus plus expansion gate |
| OQ-006 | Which exact GBrain commit/tag is known-good? | Required for compatibility contract | Pin after GBrain spike | Phase 0 GBrain spike | Block GBrain-dependent phases |
| OQ-007 | Which Hermes integration surface is best: API server, TUI gateway, Python wrapper, Kanban, or hybrid? | Required for Hermes adapter conformance | Keep as PRD spike | Phase 0 Hermes spike | Claude/OpenAI path remains critical until Hermes passes |
| OQ-008 | Should provider/router secrets support only Keychain in V1, or also env-based dev injection? | Affects developer ergonomics and safety | Keychain for secrets; env only non-secret config | Security design | Dev-only secret injection behind explicit unsafe flag |

## Can Resolve During Implementation

| ID | Question | Why It Matters | Current Best Guess | Resolve By | Fallback |
|---|---|---|---|---|---|
| OQ-009 | Exact repo package names and folder layout. | Affects scaffold generation | Use `apps/desktop`, `apps/worker`, `packages/contracts`, `packages/domain`, `packages/db`, `packages/adapters`, `packages/workflows`, `packages/evals` | `/arch-finalize` | Adjust scaffold without changing contracts |
| OQ-010 | Whether global sanitized Markdown repo is an Obsidian vault by default or optional. | UX/setup | Default yes; it preserves inspectability | Install UX | DB-only GCL if user disables global vault |
| OQ-011 | Which source adapter ships first: YouTube or podcast. | PRD allows at least one operational or deferred with ticket | YouTube first due simpler URL/source flow | Source adapter phase | Podcast first if transcript availability better |
| OQ-012 | How deep to make NotebookLM managed Drive docs in V1. | Affects source-pack UX | Project brief, decisions, meetings, research, open questions docs | NotebookLM phase | Minimal managed doc pack |

## Resolved During Planning

| ID | Decision | Resolution |
|---|---|---|
| RQ-001 | Planning mode | Expanded |
| RQ-002 | Build posture | Production-grade |
| RQ-003 | Primary proof spine | Meeting closeout |
| RQ-004 | Human actor model | Single owner/operator only |
| RQ-005 | Markdown topology | Repo/vault per workspace |
| RQ-006 | GBrain topology | Brain per workspace |
| RQ-007 | Desktop shell | Electron |
| RQ-008 | Operational storage | SQLite + standard Postgres adapters from day one |
| RQ-009 | Model providers | Claude, OpenAI, OpenRouter, Ollama, LM Studio |

