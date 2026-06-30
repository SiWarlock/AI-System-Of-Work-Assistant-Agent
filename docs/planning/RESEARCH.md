# Research

Status: rough-draft planning artifact for `/arch-finalize`.
Research date: 2026-06-29.

## Research Questions

| ID | Question | Why It Matters | Decision It Informs | Status |
|---|---|---|---|---|
| R-001 | Can Electron safely host a TypeScript-first local app with renderer isolation and IPC? | User replaced Tauri with Electron | Desktop shell/process model | Researched |
| R-002 | Does Temporal TypeScript fit durable local workflows/workers/schedules? | PRD depends on sleep/restart recovery | Workflow engine | Researched |
| R-003 | Can Drizzle support SQLite and Postgres with TypeScript schema/migration discipline? | User chose dual adapters day one | Operational storage | Researched |
| R-004 | Does tRPC fit typed local API and subscriptions? | User chose hybrid IPC + local worker API | App API boundary | Researched |
| R-005 | Are OpenAI/OpenRouter/Ollama/LM Studio suitable provider targets behind conformance tests? | User expanded provider set | ModelProviderPort | Researched at high level; conformance spike required |
| R-006 | Is NotebookLM direct API reliable enough for V1? | PRD defaults to Drive-backed fallback | NotebookPort | Research carried from PRD; spike required |
| R-007 | Can GBrain/Hermes capabilities be relied on without spikes? | PRD depends on both but names instability | GBrain/Hermes adapter decisions | Research carried from PRD; spikes required |

## Findings

### R-001 - Electron

Question: Can Electron safely host this app?

Findings:
- Electron has a main/renderer process model and documented IPC patterns through `ipcMain`/`ipcRenderer` plus preload scripts.
- Electron security docs warn against disabling `contextIsolation` and enabling Node integration in the renderer.
- The architecture can use Electron safely only if renderer is unprivileged, preload exposes a narrow typed bridge, and privileged operations stay in main/worker.

Sources:
- Electron security tutorial: https://www.electronjs.org/docs/latest/tutorial/security
- Electron IPC tutorial: https://www.electronjs.org/docs/latest/tutorial/ipc
- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model

Impact:
- Supports the user-confirmed Electron decision.
- Requires explicit renderer security constraints in `ARCHITECTURE_DRAFT.md`.

Decision implication:
- Use Electron, but keep main thin and run product logic in a dedicated Node/TypeScript control-plane worker.

Remaining risk:
- Packaging/supervision/signing details require Phase-0 shell spike.

### R-002 - Temporal TypeScript

Question: Does Temporal TypeScript support the workflow model?

Findings:
- Temporal TypeScript SDK separates client, workflow, activity, and worker packages.
- Worker-level features are Node-oriented, which matches the dedicated Node/TypeScript worker decision.
- Temporal's durable workflow model aligns with retries, approval waits, restart recovery, and schedules, but macOS sleep/wake behavior must be tested in the local topology.

Sources:
- Temporal TypeScript docs: https://docs.temporal.io/develop/typescript
- Temporal TypeScript SDK repository/docs: https://github.com/temporalio/sdk-typescript
- Temporal schedules docs: https://docs.temporal.io/develop/typescript/schedules

Impact:
- Supports Temporal as product workflow source of truth.
- Reinforces Node/TypeScript worker rather than Rust-owned workflow logic.

Decision implication:
- Keep Temporal and require sleep/wake/resume acceptance tests.

Remaining risk:
- Local Temporal persistence configuration and OS wake hooks require implementation validation.

### R-003 - Drizzle for SQLite/Postgres

Question: Can Drizzle support dual storage adapters?

Findings:
- Drizzle documents support for PostgreSQL and SQLite.
- Drizzle Kit can generate and apply migrations from TypeScript schema definitions.
- Drizzle is TypeScript-first and fits a monorepo contract package.

Sources:
- Drizzle overview: https://orm.drizzle.team/docs/overview
- Drizzle SQLite migrations: https://orm.drizzle.team/docs/migrations
- Drizzle PostgreSQL docs: https://orm.drizzle.team/docs/get-started-postgresql

Impact:
- Supports user-confirmed SQLite + Postgres day-one storage requirement.

Decision implication:
- Use Drizzle for operational store schemas/migrations, with a common repository contract tested against both dialects.

Remaining risk:
- SQLite/Postgres dialect differences still need contract tests; avoid provider-specific SQL in domain code.

### R-004 - tRPC

Question: Does tRPC fit the local worker API?

Findings:
- tRPC provides end-to-end TypeScript type-safe APIs using a shared router type.
- tRPC supports query, mutation, and subscription patterns through adapters/links.
- It is a strong fit for a TypeScript monorepo where Electron renderer and worker share contract types.

Sources:
- tRPC docs: https://trpc.io/docs
- tRPC repository/docs: https://github.com/trpc/trpc

Impact:
- Supports user-confirmed tRPC + event stream boundary.

Decision implication:
- Use tRPC for typed commands/queries; final streaming primitive (WebSocket subscription vs SSE-style stream) remains a Phase-0 detail.

Remaining risk:
- Need decide reconnection/backpressure semantics during app shell/API spike.

### R-005 - Model Providers

Question: Can Claude, OpenAI, OpenRouter, Ollama, and LM Studio be treated behind one provider layer?

Findings:
- Anthropic Claude Agent SDK is the PRD's reference runtime and offers a tool-permission-oriented coding-agent surface; it remains critical-path unless finalization changes that.
- OpenAI exposes structured-output/tool-capable API surfaces suitable for adapter investigation.
- OpenRouter exposes hosted model access behind an OpenAI-compatible style API, but provider behavior/model support varies and must be independently tested.
- Ollama and LM Studio expose local-model server APIs, including OpenAI-compatible paths, but local model quality/schema conformance must be tested per model/capability.

Sources:
- Anthropic Claude Code SDK docs: https://docs.anthropic.com/en/docs/claude-code/sdk
- OpenAI Structured Outputs guide: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI Responses API docs: https://platform.openai.com/docs/api-reference/responses
- OpenRouter docs: https://openrouter.ai/docs
- Ollama OpenAI compatibility docs: https://github.com/ollama/ollama/blob/main/docs/openai.md
- LM Studio local server docs: https://lmstudio.ai/docs

Impact:
- Supports ModelProviderPort, but only as a conformance-tested abstraction.

Decision implication:
- Add provider matrix and schema conformance gate; do not assume OpenAI-compatible endpoints are behaviorally identical.

Remaining risk:
- Provider pricing, model IDs, context limits, structured output fidelity, and tool-call behavior are volatile. Phase-0 provider conformance must pin exact provider/model pairs.

### R-006 - NotebookLM

Question: Is direct NotebookLM API a V1 dependency?

Findings:
- PRD already concludes direct API support remains a spike and V1 ships Drive-backed managed source docs.
- Architecture should not rely on unsupported browser automation or assumed direct source CRUD.

Sources:
- NotebookLM source help: https://support.google.com/notebooklm/answer/16215270
- NotebookLM help center: https://support.google.com/notebooklm

Impact:
- Supports Drive-backed NotebookLM fallback as V1.

Decision implication:
- Keep NotebookLMApiAdapter as V1.1/spike-gated.

Remaining risk:
- Drive doc refresh behavior and user workflow must be tested.

### R-007 - GBrain and Hermes

Question: Can GBrain/Hermes surfaces be locked without spikes?

Findings:
- PRD itself flags GBrain Minions/dream/ingestion/write-through and Hermes adapter surface as required but spike-gated.
- Architecture must not rely on unvalidated GBrain semantic write-back or a specific Hermes integration path.

Sources:
- GBrain repository: https://github.com/garrytan/gbrain
- GBrain docs referenced by PRD: retrieval, engines, brains/sources, minions, security.
- Hermes Agent docs referenced by PRD: https://hermes-agent.nousresearch.com/docs

Impact:
- Keeps GBrain required for retrieval/graph/health while gating write-back.
- Keeps Hermes required for V1 DoD but not critical path for first install.

Decision implication:
- Make Phase-0 GBrain and Hermes spikes explicit, with no-go branches.

Remaining risk:
- Version pinning and current capabilities must be revalidated before implementation tasks.

