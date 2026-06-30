# Requirements

Status: rough-draft planning artifact for `/arch-finalize`.

## Functional Requirements

| ID | Requirement | Source | Priority | Acceptance Signal | Related Flow |
|---|---|---|---|---|---|
| REQ-F-001 | Support Employer Work, Personal Business, Personal Life, and Global Coordination Layer boundaries. | explicit - PRD §6.1, §9.1 WS-1..WS-8 | must-ship | Workspace routing and leakage suites pass | All |
| REQ-F-002 | Assign every durable event/source/meeting/task/note/project to a workspace before durable processing. | explicit - PRD §9.1 WS-2 | must-ship | No unscoped durable records in tests | All |
| REQ-F-003 | Keep semantic knowledge in Obsidian-compatible Markdown Git repos. | explicit - PRD §1.1, §4.2, §9.2 KN-3 | must-ship | Obsidian opens repos; writes remain valid Markdown | Meeting, source, brief |
| REQ-F-004 | Use one Markdown repo/vault per workspace plus a sanitized Global/Coordination Markdown repo. | user-confirmed | must-ship | Workspace repos isolated; global brief inspectable | Brief, GCL |
| REQ-F-005 | Use one GBrain brain per workspace, with cross-workspace reads only through GCL. | user-confirmed + explicit PRD §9.1 WS-8 | must-ship | Agents cannot issue direct cross-brain queries | Global search/brief |
| REQ-F-006 | KnowledgeWriter shall be the only autonomous semantic Markdown writer. | explicit - PRD §9.2 KN-4/KN-9, §14 | must-ship | Direct GBrain/runtime Markdown write attempts are rejected | Knowledge write |
| REQ-F-007 | Meeting closeout shall ingest Granola transcripts and produce notes, decisions, project updates, tasks, calendar proposals, and summaries. | explicit - PRD §5.3, §9.4, §11.1 | must-ship | Meeting closeout replay acceptance passes | Meeting |
| REQ-F-008 | Daily/weekly/monthly briefs shall be generated, saved, displayed, and leakage-safe. | explicit - PRD §9.7 BRF-1..3, §11.4 | must-ship | Brief acceptance and WS-7 leakage tests pass | Brief |
| REQ-F-009 | Cross-calendar scheduling shall respect all configured availability sources without exposing raw details. | explicit - PRD §6.4, §11.2, §20.1 | must-ship | Doctor appointment flow avoids conflicts | Scheduling |
| REQ-F-010 | Source ingestion shall support configured capture/source types through SourceEnvelope and reviewable routing. | explicit - PRD §9.6 ING-1..7, §11.3 | must-ship | Source adapter tests and injection tests pass | Source ingestion |
| REQ-F-011 | Project sync shall derive progress deterministically from IMPLEMENTATION_PLAN.md and external PM systems. | explicit - PRD §9.5 PRJ-3/4, §11.5 | must-ship | No model-only progress percentages | Project sync |
| REQ-F-012 | Approval inbox shall support approve/edit/reject/defer from Mac and Telegram exactly once. | explicit - PRD §8.1, §8.2, §20.1 | must-ship | Approval flow e2e passes | Approval |
| REQ-F-013 | User-initiated deletion shall purge/tombstone source/meeting/project across Markdown, GBrain, and event store. | explicit - PRD §9.10 RET-2, §16.4 | must-ship | Retention purge acceptance passes | Deletion |
| REQ-F-014 | Hermes cron/Kanban automations may run but must route semantic writes through KnowledgeWriter and external writes through Tool Gateway. | explicit - PRD §9.3 RT-7 | must-ship | Hermes standalone automation acceptance passes | Automation |
| REQ-F-015 | V1 shall support ModelProviderPort providers for Claude, OpenAI, OpenRouter, Ollama, and LM Studio. | user-confirmed | must-ship | Provider conformance tests pass for required capabilities | Agent jobs |
| REQ-F-016 | KnowledgeWriter shall preserve human-owned note sections and bound assistant-generated regions with explicit start/end markers and stable IDs; overwrite of a human-owned region is rejected and audited. | explicit - PRD §9.2 KN-7/KN-8, §14.3 (added by /arch-finalize from coverage gap) | must-ship | Human-section preservation acceptance passes | Knowledge write |
| REQ-F-017 | Extraction shall never infer task owners or due dates when unstated; unknowns are emitted as TBD or routed for clarification (validator hard-reject). | explicit - PRD §9.4 MTG-4 (added by /arch-finalize) | must-ship | No inferred owners/dates in meeting-closeout eval | Meeting |
| REQ-F-018 | Assistant-held raw capture shall have a configurable retention policy with a documented default (raw audio deleted after audited synthesis; other raw payloads pruned after a configurable window, default 30 days); automated pruning never deletes human-owned sections or derived semantic notes. | explicit - PRD §9.10 RET-1/RET-3, §16.4 (added by /arch-finalize) | must-ship | Retention default + prune-safety tests | Deletion/retention |
| REQ-F-019 | GBrain shall provide the knowledge-engine capability surface required by V1: search, think/synthesis, typed graph, timelines, schema-read, and health (read/query only at the runtime MCP boundary). | explicit - PRD §9.2 KN-2 (added by /arch-finalize) | must-ship | GBrain capability + read-only-MCP tests | Retrieval/brief |
| REQ-F-020 | The system shall support user-approved explicit cross-workspace links (§6.3 Level 3) recorded in the GCL identity map. | explicit - PRD §9.1 WS-5 (added by /arch-finalize) | should-ship (P1) | Cross-workspace link approval test | Global/links |

## Non-Functional Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-NF-001 | Production-grade hardening is in scope: validation, error paths, idempotency, observability, secrets, retry/outbox, deploy/rollback. | user-confirmed build posture + PRD §17 | must-ship | Phase gates include hardening rows |
| REQ-NF-002 | Dashboard normal views target sub-2-second load after local cache warmup. | explicit - PRD §17 Performance | must-ship | Performance smoke/benchmark |
| REQ-NF-003 | KnowledgeWriter commit to GBrain search visibility target <=60s p95 and dashboard read-model visibility <=10s p95. | explicit - PRD §5.4, §17 Observability | must-ship | Sync-latency benchmark |
| REQ-NF-004 | Local-first V1 opens no inbound public ports; local services bind loopback only. | explicit - PRD §17 Network exposure | must-ship | Network binding audit |
| REQ-NF-005 | Fresh install on clean Mac succeeds with documented prerequisites. | explicit - PRD §5.4, §20.1 | must-ship | Clean install acceptance |
| REQ-NF-006 | Local workflows survive restart/sleep via durable Temporal state and idempotent resume. | explicit - PRD §9.8 LIFE-1..7, §20.1 | must-ship | Sleep/wake acceptance |

## Data Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-D-001 | Markdown is canonical semantic data; GBrain is derived and rebuildable. | explicit - PRD §10.1, §14.5 | must-ship | Full re-index recovers semantic nodes |
| REQ-D-002 | Operational store holds events, audit, approvals, outboxes, connector cursors, provider conformance status, and dashboard read models. | inferred + user-confirmed dual store | must-ship | SQLite/Postgres contract tests |
| REQ-D-003 | Operational store shall support SQLite and standard Postgres adapters from day one through Drizzle. | user-confirmed | must-ship | Migration and repository contract tests pass on both |
| REQ-D-004 | Temporal persistence is separate from operational store. | inferred from PRD §1.1/§19.1 | must-ship | No app tables in Temporal DB |
| REQ-D-005 | GBrain PGLite is owned by GBrain process only and never reused as app operational DB. | explicit - PRD §19.1 + user-confirmed | must-ship | Process ownership test |

## Security Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-S-001 | Imported/untrusted content agents run with read-only/no-mutating tool policy and are rejected at job admission if they declare mutating tools. | explicit - PRD §9.6 ING-7, §16.1 | must-ship | Prompt-injection acceptance |
| REQ-S-002 | Employer Work raw cloud egress is blocked until workspace settings gate is enabled and visible in System Health. | explicit - PRD §16.5 + user-confirmed UX | must-ship | Egress acceptance |
| REQ-S-003 | Secrets are stored in macOS Keychain in V1; `.env` is dev-only non-secret config. | explicit - PRD §1.1, §19.1 | must-ship | Secret scan and config tests |
| REQ-S-004 | Electron renderer has no direct filesystem/DB/secrets access. | user-confirmed Electron decision | must-ship | IPC/security review |
| REQ-S-005 | Provider routing obeys workspace/capability matrix and egress policy. | user-confirmed | must-ship | Provider policy tests |
| REQ-S-006 | All provider outputs pass strict JSON Schema gates before KnowledgeWriter or Tool Gateway receives them. | user-confirmed | must-ship | Schema rejection tests |
| REQ-S-007 | Every agent job enforces maxRuntimeSeconds and, when set, maxCostUsd: breach cancels the job, records and surfaces it, and leaves no partial uncommitted side effect; the Broker applies a configurable default cap to uncapped LLM jobs. | explicit - PRD §9.11 COST-1/COST-2, §5.4, §20.1 (added by /arch-finalize) | must-ship | Budget-cap acceptance (cancel, no partial side effect) |

## UX Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-UX-001 | Mac app provides dashboard, workspace tabs, project view, Copilot, ingestion inbox, approval inbox, calendar view, recent changes, and system health. | explicit - PRD §8.1 | must-ship | UI smoke and e2e flows |
| REQ-UX-002 | Global surfaces show sanitized grouped summaries with drill-down into workspace context. | user-confirmed | must-ship | Global search/brief UX test |
| REQ-UX-003 | Obsidian remains a first-class surface for workspace repos and sanitized global coordination Markdown. | explicit + user-confirmed | must-ship | Notes visible/editable in Obsidian |
| REQ-UX-004 | Telegram supports capture, approval, brief notifications, and workflow failure alerts via allowlisted sender. | explicit - PRD §8.2 | must-ship | Telegram acceptance |
| REQ-UX-005 | First-run onboarding offers user-selectable workspace presets (Simple/Professional/Founder/Advanced) that scaffold workspaces, repos, and brains. | explicit - PRD §9.1 WS-6 (added by /arch-finalize) | should-ship (P1) | Preset onboarding test |

## Integration Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-I-001 | Claude, OpenAI, OpenRouter, Ollama, and LM Studio provider adapters must pass conformance for supported capabilities. | user-confirmed | must-ship | Provider conformance matrix |
| REQ-I-002 | Claude Agent SDK remains a reference/critical-path cloud runtime unless explicitly superseded during finalization. | explicit - PRD §13.5 | must-ship | Claude bounded workflow test |
| REQ-I-003 | Hermes adapter is required and DoD-tested, but not required for baseline fresh install. | explicit - PRD §13.5, §20.2 | must-ship | Hermes adapter conformance before V1 DoD |
| REQ-I-004 | NotebookLM direct API remains spike/future; V1 ships Drive-backed managed-doc path. | explicit - PRD §12.2, §18.3 | must-ship | Drive-backed sync test |
| REQ-I-005 | External connectors must queue/retry during outages and surface health. | explicit - PRD §9.8, §9.9 | must-ship | Connector outage tests |

## Testing Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-T-001 | Ship EVAL-1 corpora and harness for meeting closeout, retrieval, and leakage metrics. | explicit - PRD §9.12, §20.1 | must-ship | Reproducible eval run |
| REQ-T-002 | Contract/eval-heavy test posture is required. | user-confirmed | must-ship | Phase gates reference contract/eval suites |
| REQ-T-003 | Adapter conformance tests cover runtime, provider, connector, storage, KnowledgeWriter, and GBrain contracts. | inferred production-grade | must-ship | Conformance suite green |

## Deferred / Future Requirements

| ID | Requirement | Source | Priority | Acceptance Signal |
|---|---|---|---|---|
| REQ-DEF-001 | Hosted always-on control plane while Mac sleeps. | explicit - PRD §18.3 | deferred V1.1 | Hosted-plane ADR |
| REQ-DEF-002 | NotebookLM direct API adapter if validated. | explicit - PRD §18.3 | deferred V1.1 | API spike pass |
| REQ-DEF-003 | Gmail, Slack, advanced OCR/PDF, richer project templates, aggregate spend caps, deeper pruning controls. | explicit - PRD §18.3 | deferred V1.1+ | Future planning |

