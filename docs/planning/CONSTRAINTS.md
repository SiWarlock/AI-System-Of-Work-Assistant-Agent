# Constraints

Status: rough-draft planning artifact for `/arch-finalize`.

## Delivery Constraints

- [locked decision] Build posture is production-grade.
- [locked decision] Delivery is quality-gated incremental, not deadline-driven.
- [locked decision] Full PRD V1 remains in scope; meeting closeout is the first proof spine, not a scope cut.
- [locked decision] Stubs are permitted during earlier phases but cannot satisfy final DoD in place of real integrations.

## Platform Constraints

- [locked decision] V1 is Mac-first.
- [locked decision] Desktop shell is Electron, replacing the PRD's Tauri default.
- [locked decision] Electron renderer is unprivileged; privileged operations happen through preload IPC or the loopback worker API.
- [locked decision] Control-plane worker is Node/TypeScript.
- [locked decision] Monorepo is TypeScript-first, managed by pnpm workspaces and Turbo.

## Local-First / Hosted-Compatible Constraints

- [locked decision] V1 local control plane runs on the Mac and is active when the Mac is awake.
- [locked decision] Local services bind to loopback only.
- [locked decision] Hosted/always-on control plane is deferred, but standard Postgres operational storage support ships day one.
- [locked decision] Supabase is not an architecture dependency; it may host standard Postgres later.

## Storage Constraints

- [locked decision] Workspace Markdown repos are canonical semantic stores and must remain Obsidian-compatible.
- [locked decision] GBrain is derived and per-workspace.
- [locked decision] Operational store supports SQLite and standard Postgres through Drizzle.
- [locked decision] Temporal persistence is separate.
- [locked decision] GBrain PGLite is exclusively owned by GBrain.

## Security and Privacy Constraints

- [locked decision] Single owner/operator in V1; no app-level multi-user auth.
- [locked decision] macOS user session + Keychain secrets are sufficient for V1.
- [locked decision] Employer Work raw cloud egress requires workspace settings gate.
- [locked decision] Imported content is untrusted and cannot run with mutating tools.
- [locked decision] Cross-workspace raw retrieval is forbidden; use GCL.
- [locked decision] Renderer cannot access raw secrets, DB, filesystem, provider keys, or connectors directly.

## Provider Constraints

- [locked decision] V1 provider set: Claude, OpenAI, OpenRouter, Ollama, LM Studio.
- [locked decision] Local models are optional zero-egress path, not V1 critical release gate.
- [locked decision] Provider routing uses workspace + capability matrix.
- [locked decision] Strict JSON Schema gate is required before side effects.
- [research required] Provider-specific structured-output, tool-use, streaming, and local model capabilities must be verified in Phase 0 conformance spikes against pinned versions/models.

## Performance Budgets

Budgets explicitly stated by the PRD:

- Dashboard normal views: sub-2-second load after local cache warmup.
- KnowledgeWriter commit to GBrain search visibility: <=60s p95.
- KnowledgeWriter commit to dashboard read model visibility: <=10s p95.

Budgets not yet stated:

- [open question] Maximum concurrent agent jobs per local machine.
- [open question] Default per-job maxCostUsd per capability.
- [open question] Provider-specific timeout/retry defaults beyond PRD's maxRuntimeSeconds enforcement.

## Evaluation Constraints

- EVAL-1 corpora must exist and be versioned.
- Meeting closeout must reach 90%+ routing/project accuracy on the labeled corpus.
- Retrieval benchmark must reach 90%+ relevance.
- Workspace leakage target is zero raw Employer Work documents/sentences in personal outputs absent explicit link/permission.
- Duplicate external write target is zero in replay/retry tests.

