# Evaluation Criteria

Status: rough-draft planning artifact for `/arch-finalize`.

## Project-Level Done

V1 is done when the system runs locally/self-hosted on a Mac, proves the meeting-closeout spine end to end, supports the full PRD V1 integration set, keeps Obsidian-compatible Markdown canonical, passes privacy/idempotency/eval gates, and remains installable by a technically capable open-source user.

## Acceptance Matrix

| Area | Criterion | Target | Test / Evidence |
|---|---|---|---|
| Meeting closeout | Correct routing and extraction | 90%+ on EVAL-1 meeting corpus | Versioned eval harness |
| Replay safety | Duplicate notes/tasks/events | 0 duplicates | Meeting replay and connector replay tests |
| Knowledge writes | Approved semantic writes persist or are visible in retry/error outbox | 100% | KnowledgeWriter acceptance |
| Obsidian compatibility | Repos remain valid and editable | 100% of test mutations | Markdown syntax + Obsidian reload smoke |
| GBrain parity (write-through, fail-closed) | DB-only/unstamped facts ever served as truth | 0 served (all quarantined as parity_defect); the 4 GO conditions green | §12 divergence suite (12.7) — bytes-from-Markdown + signed-stamp + allow-set + adversarial borrowed-stamp/forged-hash/malicious-gbrain |
| Write-through enablement | `writeThroughEnabled` flips ON only when proven | per-workspace, default OFF until 4 GO green + pin promoted + read-token-rejects-write | enablement-gate (12.22) + fail-closed (12.23) suites |
| Retrieval | Relevant context | 90%+ benchmark success | KN-10 retrieval eval |
| Workspace leakage | Raw Employer Work in personal/global outputs | 0 without explicit permission | WS-7 adversarial suite |
| Prompt injection | Mutating tool access from untrusted content | 0 | ING-7 job-admission tests |
| Calendar safety | Scheduling proposals check all configured availability | 100% | Doctor appointment flow |
| Approval visibility | Pending external side effects visible in Mac and/or Telegram | 100% | Approval flow e2e |
| Sleep/wake lifecycle | Missed schedules and in-flight workflows resume correctly | one collapsed run, no duplicate side effects | macOS sleep/restart tests |
| Contract freeze (Phase 1) | Every Appendix-A seam model has a frozen field-set snapshot + a registered, ajv-strict-compiling JSON Schema; field-sets match Appendix A; no drift | 27/27 frozen; registry compiles all; driftDetected=false | Per-model `spec(§)`-tagged snapshot tests + `registry-all.test.ts` (REQ-S-006 coverage) |
| Provider conformance | Provider output schema validity | 100% for accepted outputs | Provider matrix tests |
| Storage portability | SQLite and Postgres operational adapters behave equivalently | contract suite green on both | Drizzle migration/repository tests |
| Install reproducibility | Fresh install on clean Mac | success | Clean install script + sample workspace |

## Reviewer Rejection Conditions

- Raw cross-workspace retrieval exists outside the GCL.
- Any runtime/provider can write Markdown or external systems directly.
- GBrain is allowed to become semantic source of truth.
- Provider outputs can reach side-effect layers before schema validation.
- Electron renderer has direct access to filesystem, DB, secrets, or provider credentials.
- SQLite-only assumptions make Postgres adapter fake or untested.
- Final DoD is satisfied with mocks in place of real integrations.
- Architecture lacks stable anchors and shared-contract inventory for `/tasks-gen`.

## Phase-0 Spike Success Criteria

| Spike | Success Criteria | No-Go Branch |
|---|---|---|
| Electron shell + worker | Renderer/main/worker lifecycle, secure IPC, loopback worker API, restart handling | Reopen shell/process ADR |
| Storage adapters | Same repository contract passes against SQLite and Postgres | Reduce Postgres to V1.1 only or redesign storage abstraction |
| Provider conformance | Claude/OpenAI/OpenRouter/Ollama/LM Studio pass selected capability schemas or are scoped per capability | Provider remains configured but disabled for failing capabilities |
| GBrain round trip | No non-KnowledgeWriter Markdown mutation; parity and reindex pass | **Superseded by the 2026-06-30 write-through amendment:** write-through ships behind the fail-closed divergence layer (Phase-4 4.14–4.20); read-only/index-only is the per-workspace default-until-enabled fallback. Spec: `docs/design/gbrain-write-through-divergence.md`. |
| Hermes adapter | Bounded job with logs/cancel/schema/control passes | Claude/cloud provider path remains critical; Hermes tracked before DoD |
| Meeting synthetic | Full meeting closeout against fixture reaches notes/proposals/audit | Re-sequence meeting closeout risk before broad connectors |
| NotebookLM API | Supported direct CRUD/query/export documented | Drive-backed fallback remains V1 |

