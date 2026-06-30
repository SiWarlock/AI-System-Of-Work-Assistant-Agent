# Assumptions

Status: rough-draft planning artifact for `/arch-finalize`.

| ID | Assumption | Category | Why It Matters | Validation Path | Fallback |
|---|---|---|---|---|---|
| ASM-001 | The owner accepts Electron's larger footprint in exchange for TypeScript-first control-plane ergonomics. | Product/tech | Replaces PRD Tauri default | User confirmed during planning | Reopen shell ADR |
| ASM-002 | The owner wants Obsidian as an ongoing first-class surface, not just an export format. | Product/data | Drives repo/vault shape and KnowledgeWriter constraints | User correction confirmed | No fallback; load-bearing |
| ASM-003 | One repo/vault and one GBrain brain per workspace is acceptable setup overhead. | Privacy/data | Strengthens workspace isolation | User confirmed | Source-scoped personal brain model |
| ASM-004 | The GCL can provide useful global UX using sanitized projections and drill-down. | UX/privacy | Keeps global surfaces useful without raw blending | Prototype global brief/search | Add explicit workspace-selection UX |
| ASM-005 | Dual SQLite/Postgres operational storage is worth V1 complexity. | Storage/delivery | Adds hosted-compatible adapter burden | User confirmed | SQLite local only + V1.1 Postgres |
| ASM-006 | Drizzle can represent the needed common subset across SQLite and Postgres without brittle dialect divergence. | Storage/tooling | Required by dual-adapter plan | Phase-0 migration/repository spike | Kysely/SQL or provider-specific repos |
| ASM-007 | Claude, OpenAI, OpenRouter, Ollama, and LM Studio can be normalized behind provider conformance by capability. | Runtime/provider | Provider breadth is a user-confirmed V1 requirement | Provider matrix spike | Disable failing provider/capability pairs |
| ASM-008 | Local models can be useful for optional zero-egress paths but are not reliable enough to gate V1 critical release. | Privacy/runtime | Avoids making local quality a blocker | Local provider evals | Cloud-with-ack remains critical path |
| ASM-009 | macOS user session plus Keychain is sufficient local auth for single-owner V1. | Security/UX | Avoids separate app login/PIN scope | Security review | Add app lock in later release |
| ASM-010 | Provider/API docs and capabilities will move; architecture should lock conformance tests, not brittle model claims. | Research | Prevents stale docs from becoming contract | Phase-0 research refresh and pins | Disable/replace provider adapter |
| ASM-011 | GBrain's write-capable surfaces can be disabled, contained, or kept out of runtime exposure. | Knowledge | Needed for no-hidden-brain invariant | GBrain round-trip/full capability bridge spikes | Read-only GBrain branch |
| ASM-012 | Final V1 will use real integrations, with stubs limited to earlier phases. | Delivery | Prevents mock-based false acceptance | Acceptance gates | Reduce V1 scope only by explicit owner decision |

