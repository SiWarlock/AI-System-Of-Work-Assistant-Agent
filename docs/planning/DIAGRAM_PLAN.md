# Diagram Plan

Status: rough-draft planning artifact for `/arch-finalize`.

## Full-Scope Architecture Diagram

Purpose: show the complete local-first architecture from Electron UI through worker, Temporal, storage, provider routing, gateways, Markdown/GBrain, GCL, and external systems.

Must show:

- Electron renderer/main/preload split.
- Dedicated Node/TypeScript control-plane worker.
- Temporal product workflows.
- Operational store with SQLite/Postgres adapters.
- KnowledgeWriter to per-workspace Markdown repos.
- Per-workspace GBrain brains.
- GCL DB and Global/Coordination Markdown repo.
- ModelProviderPort providers.
- Connector Gateway and Tool Gateway.
- External systems.

Spec anchors: `ARCHITECTURE.md §2`, §3..§13.
Format: Mermaid `flowchart TD`.
Priority: P0.

> Note (`/arch-finalize`): spec anchors below reference the finalized `ARCHITECTURE.md`. Draft §2–§13, §2.5, §17, Appendix A are stable (see `docs/gap-audits/anchor-remap.md`).

## Sub-Diagrams

### 1. Meeting Closeout Sequence

Purpose: clarify the primary proof spine.

Must show:

- Granola polling.
- Calendar/project correlation.
- Workspace-scoped GBrain retrieval.
- AgentJob provider routing and schema validation.
- KnowledgeWriter commit.
- Tool Gateway proposals/writes.
- GBrain re-index.
- Dashboard/Telegram/audit updates.

Spec anchors: §6, §7, §8, §9, §10, §12.
Format: Mermaid `sequenceDiagram`.
Priority: P0.

### 2. Workspace Isolation and GCL Visibility Gate

Purpose: show how global UX works without raw cross-workspace retrieval.

Must show:

- Three workspace repos/vaults.
- Three workspace GBrain brains.
- GCL sanitized projection path.
- Global/Coordination Markdown repo.
- Drill-down into one workspace context.
- Denied direct cross-brain agent query.

Spec anchors: §5, §6, §11, §12.
Format: Mermaid `flowchart`.
Priority: P0.

### 3. Provider Routing and Egress

Purpose: show provider/capability matrix and egress enforcement.

Must show:

- AgentJob envelope.
- Workspace provider matrix.
- Employer Work egress gate.
- Claude/OpenAI/OpenRouter cloud providers.
- Ollama/LM Studio local providers.
- Strict schema gate before side effects.

Spec anchors: §5, §7, §12.
Format: Mermaid `flowchart`.
Priority: P0.

### 4. KnowledgeWriter and GBrain Parity

Purpose: show Markdown as canonical and GBrain as derived.

Must show:

- KnowledgeMutationPlan.
- Validation/ownership/secret scan.
- Atomic Markdown commit.
- GBrain sync/re-index queue.
- Parity check.
- DB-only fact quarantine.

Spec anchors: §6, §12.
Format: Mermaid `sequenceDiagram`.
Priority: P0.

### 5. External Write Envelope

Purpose: make idempotency and approval mechanics concrete.

Must show:

- ProposedAction.
- Approval required/auto-allowed split.
- canonical object key.
- pre-write existence check.
- write receipt.
- replay path reusing receipt/matched object.

Spec anchors: §8, §9, §12.
Format: Mermaid `stateDiagram-v2` or `sequenceDiagram`.
Priority: P0.

### 6. Operational Storage Split

Purpose: prevent source-of-truth confusion.

Must show:

- Operational DB SQLite/Postgres adapters.
- Temporal persistence separate.
- GBrain PGLite separate.
- Markdown repos canonical.
- Keychain secrets separate.

Spec anchors: §4, §6, §13.
Format: Mermaid `flowchart`.
Priority: P1.

### 7. Parallel Build Track DAG

Purpose: help `/tasks-gen` derive team tracks.

Must show:

- Contract track first.
- Worker, knowledge, providers-integrations, desktop, eval-security tracks.
- Shared contracts crossing tracks.
- Integration/merge order.

Spec anchors: §2.5, §17, Appendix A.
Format: Mermaid `flowchart TD`.
Priority: P1.

### 8. Threat Boundary Map

Purpose: support security review.

Must show:

- Renderer boundary.
- Worker API boundary.
- Cloud provider egress boundary.
- Local provider boundary.
- GCL projection boundary.
- Tool Gateway boundary.
- KnowledgeWriter boundary.

Spec anchors: §5, §7, §8, §12 and `THREAT_MODEL.md`.
Format: Mermaid `flowchart` with trust-boundary annotations.
Priority: P1.

### 9. Cross-Store Deletion Saga (added by `/arch-finalize`)

Purpose: make the user-initiated deletion saga and its compensation concrete.

Must show:

- Deletion plan build from explicit intent.
- Ordered steps: Markdown tombstone via KnowledgeWriter (commit point) → GBrain purge/re-index → event-store tombstone → read-model/external-ref reconciliation.
- Per-step idempotency and compensating/retry states on partial failure.
- No orphan / no resurrection invariant.

Spec anchors: §9 (workflow 9), §6, §16.
Format: Mermaid `stateDiagram-v2`.
Priority: P0.

### 10. AgentJob & Approval State Machines (added by `/arch-finalize`)

Purpose: pin the lifecycle states the gap audit found unspecified in the architecture (normative in `DOMAIN_MODEL.md`).

Must show:

- AgentJob: created → admitted → provider_selected → running → schema_validated → accepted | rejected | cancelled_budget | failed_retryable | failed_terminal.
- Approval: pending → approved | edited | rejected | deferred | expired, with deferred → pending (snooze) / deferred → expired.

Spec anchors: §7, §9, §3, `DOMAIN_MODEL.md`.
Format: Mermaid `stateDiagram-v2`.
Priority: P1.

### 11. Worker Supervision & Lifecycle (added by `/arch-finalize`)

Purpose: show the Electron-main supervision contract and degraded modes.

Must show:

- Main → spawn/supervise worker; restart-with-backoff; crash-loop threshold → "worker down" System Health state.
- Lease re-acquisition (LIFE-1) on respawn; in-flight recovery via Temporal resume + write envelope.
- Degraded modes: Temporal-unavailable, Keychain-locked, DB-unavailable.

Spec anchors: §16, §13, §9, §4.
Format: Mermaid `stateDiagram-v2` or `flowchart`.
Priority: P1.

