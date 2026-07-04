# Phase 13 — Source Extractors & Knowledge Ingestion (OSB inheritance) — PROPOSAL

> **Status: DRAFT PROPOSAL — not yet merged into `IMPLEMENTATION_PLAN.md`.**
> Authored 2026-07-04 from a code-verified review of `obsidian-second-brain` (v0.11.1, MIT) + the SoW gap analysis.
> Slots in **after** the current Phase-9 desktop dashboard slice (§9.5 Project dashboard) lands — **does not touch `apps/desktop`**. Owner reviews + merges into the live plan.
> Architecture at a glance: [`osb-integration-architecture.md`](./osb-integration-architecture.md) (truth → index → read).

## Why this phase exists

The three product pillars need capabilities that are **designed but absent from the plan** (gaps G1/G2/G3/G4/G8 — see `docs/planning/` gap analysis / MEMORY `sow-roadmap-gaps`): YouTube/podcast/file ingestion, real web-article ingestion, "capture as I work" project auto-update, and a typed Project model. All of these are **native to `obsidian-second-brain`** and its PRD lineage (`ING-3` explicitly says to *port YouTube/podcast extraction from Obsidian Second Brain*). This phase inherits them **under SoW governance**.

## The one governing rule (non-negotiable)

`obsidian-second-brain` is the anti-thesis of SoW governance: every capability writes the vault directly (`path.write_text`) and calls cloud LLMs unconditionally. We inherit its **fetch / read / analyze** layer and **never** its write layer:

> **Inherit osb's extractors + analyzers as `SourceIngestionPort` adapters that emit CANDIDATE DATA and never write. Route every model call through `ModelProviderPort` + the egress veto (fail-closed to local Ollama/LM Studio for employer-work ack-OFF). Every vault mutation flows `registerSource` (candidate gate) → `KnowledgeMutationPlan` → `KnowledgeWriter` (the sole writer) → Approval Inbox (propose-only by default). NEVER inherit a writer.**

The clean seam already exists on **both** sides: osb's `research.py --free` emits JSON and never touches the vault (its own test: *"saving to the vault is a separate concern"*), and SoW's `registerSource()` is a pre-extraction gate that already validates a candidate `SourceEnvelope` (ajv + Zod, `workspaceId` required, Flow-4 dedupe) before any durable effect. We connect osb's emit-JSON output to SoW's candidate gate.

## Reuse verdict per osb surface

| osb surface | Verdict | SoW landing |
|---|---|---|
| `lib/youtube.py`, `lib/podcast.py`, `lib/video_frames.py`, `lib/sources/*`, `aggregator.py` | **VENDOR-AND-WRAP** (pinned subprocess, emit-only) | `SourceIngestionPort` adapters |
| `architect_scan.py`, `mine_commit_decisions.py` (stdlib, already write nothing) | **VENDOR-AND-WRAP** | G4 candidate producers |
| `semantic_search.py`, `retrieval_eval.py` (local Ollama, RRF) | **VENDOR-AND-WRAP** | GBrain retrieval + `packages/evals` bar |
| `obsidian-mcp-server` search/read/backlinks/health | **MCP-READ-ONLY** (strip 3 write tools) | Connector Gateway read path |
| `/obsidian-distill` block-provenance, `@generated/@user` sentinels, no-inference prose | **ADOPT** | hardens candidate gate + KnowledgeWriter |
| `vault.py` writers, Project schema, model clients | **REIMPLEMENT** | KnowledgeWriter / `packages/domain` / ModelProviderPort |
| bg-agent, telegram-journal | **FORK-AND-GOVERN** (keep intent, rebuild governed) | see §13.6 |
| `/obsidian-synthesize` + scheduled agents (living vault) | **GOVERN — TIERED AUTONOMY** (owner decision, revised from propose-only) | see §13.8 |
| `notebooklm` cloud grounding | **GOVERN — WORKSPACE-GATED** (owner decision, NOT rejected) | see §13.9 |

---

## Task spine

### 13.1 — Anti-corruption layer + pin + eval-gate (do FIRST)
- **Files (NEW):** `config/osb.pin` (upstream release tag `v0.11.1` + content-SHA of the vendored subtree — the artifact has zero git tags, so pin the release + subtree hash), `vendor/osb/` (vendored vault-agnostic libs only — no commands, no writers), `packages/evals/src/osb/` (the 3-part gate).
- **Spec anchor:** mirrors the `config/gbrain.pin` + Hermes-pin re-validation precedent (LESSON providers#1; task 4.20).
- **Acceptance:** a version bump is a deliberate act that runs, and must pass, before it lands: **(a)** write-path CONFORMANCE — a grep-guard + boundary test proving no vendored path reaches a vault write; **(b)** EGRESS-LEAKAGE eval — no adapter reaches a cloud endpoint under employer-work ack-OFF; **(c)** RETRIEVAL eval reusing osb's own `retrieval_eval.py` case format (bar: hybrid recall@10 ≥ osb's measured ~0.91 on realistic queries, no regression). ACL rule: SoW depends only on `SourceIngestionPort`, never on osb's command surface.

### 13.2 — Source extractor adapters (emit-only) — G1/G2/G3
- **Files (NEW):** `packages/integrations/src/connectors/adapters/youtube.ts` (G1), `podcast.ts` (G3), `web-research.ts` (G2), `file-source.ts` (G3-file/PDF). Each shells out to the pinned vendored Python **in an added `--emit-json` / `--no-save` mode** (a one-line patch to the vendored copy that strips the `vault.write_note` tail).
- **Spec anchor:** `ING-2`/`ING-3` (P1); `SourceEnvelope.type` catalog (`youtube_video`, `podcast`, `web_article`, `file` — the `type` field is an open string today, so no frozen-contract change; **OQ-011** names YouTube first-to-ship and its `§20.1` DoD demands "≥1 YouTube-or-podcast adapter operational or a deferral ticket" — this closes that live DoD gap).
- **Acceptance:** each adapter's output is a candidate `SourceEnvelope` that passes `registerSource()`; nothing writes the vault; the summarize/transcription step (Grok/Perplexity/Whisper) is a `ModelProviderPort` call the egress veto can fail closed; `--visual` YouTube frames + local Whisper stay zero-egress. Transcript fetch is untrusted content → the extraction agent runs read-only (ING-7).

### 13.3 — Local retrieval + eval harness (GBrain-aligned) — semantic auto-linking
- **Files (NEW):** `packages/knowledge/src/gbrain/local-embed.ts` (wraps vendored `semantic_search.py` behind `ModelProviderPort(Ollama/LM Studio)`), `packages/evals/src/retrieval/` (port of `retrieval_eval.py`).
- **Spec anchor:** GBrain (derived, read-only, rebuildable-from-Markdown); egress veto.
- **Acceptance:** embedding index lives OUTSIDE the canonical Markdown tree (rebuildable artifact); default backend is local Ollama; the `openai` cloud embed backend is denied for employer-work; retrieval-eval is wired as the pin re-validation bar (§13.1c).

### 13.4 — MCP-read-only vault connector (per workspace)
- **Files (NEW):** `packages/integrations/src/connectors/adapters/obsidian-vault-mcp.ts` (registers ONLY `obsidian_search`/`read_note`/`backlinks`/`vault_health`/`validate_note`).
- **Acceptance:** the 3 write tools (`save_note`/`update_note`/`capture`) are NOT registered — no MCP path can write Markdown (KN-4/KN-9); one server process per workspace vault (isolation); reads go through the Connector Gateway.

### 13.5 — Typed Project model + state machine — G8
- **Files (NEW):** `packages/contracts/src/models/project.ts` (+ schema + snapshot), `packages/domain/src/state/project.ts` (7th state machine), a `project_capture` / `project_sync` member on `ProvenanceOrigin` (`shared-enums.ts`).
- **Spec anchor:** `REQ-F-011`; DOMAIN_MODEL Project entity; adopt osb's Project frontmatter schema + **bi-temporal timeline** (event-time vs transaction-time; status appended, never overwritten) — but ADD the enforced state machine osb lacks (osb has status enums + recency inference, no transitions).
- **Governance note:** this is a **frozen-contract round** — requires `ARCHITECTURE.md` Appendix A + schema-snapshot edits in the same round (owner + orchestrator territory). Unblocks the Phase-9 §9.5 Project dashboard, which is currently blocked on exactly this contract-shape decision.

### 13.6 — Governed "capture as I work" write-through source — G4  ★ (see design below)
- **Files (NEW):** `packages/integrations/src/connectors/adapters/coding-session.ts` (session → candidate `SourceEnvelope`, `type: 'coding_session'`), `vendor/osb/architect_scan.py` + `mine_commit_decisions.py` wrappers, a repo→workspace map, a session-end/commit trigger that POSTs to the worker's loopback API.
- **Spec anchor:** G4 (greenfield); reuses the certified `ingestionTriage` spine + Approval Inbox + approval matrix.
- **Acceptance:** see the design section below. **No autonomous unattended writer**; capture is propose-only by default; employer-repo sessions extract on a local zero-egress model or fail closed.
- **Prototype (folded per owner 2026-07-04):** a single `capture-source` adapter proves BOTH triggers through one governed spine — git-driven (`coding_session`, `trustLevel: trusted`) AND telegram mobile (`telegram_capture`, `trustLevel: untrusted` → downstream ING-7 read-only, sender-allowlisted → fail-closed on unknown sender). Both emit-only → candidate `SourceEnvelope` → real `registerSource()` gate. `packages/integrations/src/connectors/adapters/capture-source.ts` (+ test).

### 13.7 — Adopt the governance-hardening primitives
- Block-provenance distillation `(src: Bn)` + segregated-inference → strengthen the candidate gate / no-inference validator.
- `@generated`/`@user` sentinel-marker refresh → KnowledgeWriter's marker-bounded human-section preservation (already a KnowledgeWriter concept; adopt osb's exact marker vocabulary for Obsidian-compat).

---

## §13.6 design — Governed "capture as I work" (the reimplemented bg-agent)

**We keep osb's capability, discard its mechanism.** osb's bg-agent fires on Claude Code's PostCompact, then spawns an unattended `claude --dangerously-skip-permissions` agent that writes the vault directly with cloud models. SoW rebuilds the *same capability* on the certified spine:

```
coding session  ──trigger──▶  coding-session SOURCE adapter
                              │  (type:'coding_session', origin=repo, workspaceId=mapped, sensitivity)
                              ▼
                         registerSource()  ── candidate gate (ajv+Zod, workspaceId required, dedupe)
                              ▼
                    read-only extraction agent (ING-7)  ── ModelProviderPort + EGRESS VETO
                              │  employer repo + ack OFF ⇒ local Ollama/LM Studio ONLY, else FAIL CLOSED
                              ▼
                    candidate facts (decisions/entities/project-status/tasks/questions)
                              ▼
                         candidate gate + NO-INFERENCE (missing owner/date ⇒ TBD, never invented)
                              ▼
                         KnowledgeMutationPlan  ──▶  KnowledgeWriter.applyPlan()
                              │  (preserve human sections, compare-revision, secret-scan-REJECT)
                              ▼
                    Approval Inbox (Mac + Telegram)  ──  PROPOSE-ONLY by default
                              │  approval matrix decides auto-apply vs confirm, per trust tier
                              ▼
                         canonical Obsidian Markdown  (+ optional Tool-Gateway external writes)
```

**Why this is nearly free:** the certified `ingestionTriage` workflow already runs *source → extract → candidate → plan → KnowledgeWriter → propose*. Governed capture = **(a)** a `coding_session` source adapter, **(b)** a trigger that emits the source, **(c)** a repo→workspace map, **(d)** local-model extraction wiring, **(e)** an approval-matrix tier for capture. Minimal new invention.

**Trigger — ship in trust order (deterministic first):**
1. **Git-driven (deterministic, no LLM, highest trust):** on commit / on a schedule, `mine_commit_decisions.py` + `architect_scan.py` emit decision/architecture candidate sources derived from git *facts*. No inference, no egress → can safely auto-apply.
2. **Session-end / PostCompact hook (the real "as I work"):** a Claude Code / Hermes hook POSTs the session summary + cwd to the worker's **loopback tRPC** (session-token authed) as a candidate source. The hook writes NOTHING — it hands a candidate to the governed worker (the exact inversion of osb's skip-permissions writer).
3. **Explicit `/capture` command / desktop button** — user-initiated.
4. **Mobile (Telegram) quick-capture — the phone front door.** Voice / photo / PDF / forwarded link / text → candidate source via the ALREADY-BUILT `telegram-capture` connector → `registerSource()`. The bot writes nothing. Telegram-specific governance: **ING-7 read-only extraction on all inbound** (untrusted content / injection surface), transcription+vision via `ModelProviderPort`+egress veto (local Whisper/vision for employer-work, else fail closed), sender allowlist + size/rate limits, no-inference stubs (`TBD`/`type: stub`), workspace routing per chat/tag. Symmetric with the Telegram **approval** channel (`Approval.channel='telegram'`) — capture-in + approve-out on one surface. This forks osb's `telegram_journal.py` capability; its direct-write always-on cloud bot mechanism is discarded.

**Workspace routing:** cwd/repo → workspace via a repo→workspace map (osb's soft `job:` field, hardened). `workspaceId` is REQUIRED at `registerSource` (scoped-before-durable) and selects BOTH the target vault AND the egress policy — an employer repo capture can never egress to cloud with ack off.

**Propose-only + the approval matrix (the governed "while you sleep"):** capture runs while you work/sleep, but lands as **proposed** mutations in the Approval Inbox — you review a queue, you never wake to silent rewrites. The approval matrix tiers it: deterministic git-derived decisions can auto-apply; LLM-inferred project-status/people changes need one tap. Raise the auto-apply threshold per category as trust grows.

### Owner decisions for §13.6
1. **Auto-apply aggressiveness:** propose-only-always (safest) · **tiered by trust (recommended:** git-facts auto, LLM-inferences proposed) · eventually-trusted-auto.
2. **First trigger to ship:** **git-driven deterministic (recommended** — zero egress/inference risk) → then the session-end hook → then explicit command.
3. **`ProvenanceOrigin`:** reuse `'ingestion'` (no contract change, fine for the prototype) vs add a dedicated `'session_capture'` origin (frozen-contract round, better audit provenance). Recommend adding it in the §13.5 contract round.

---

## §13.8 design — Autonomous synthesis (living vault), safe by CONFINEMENT — G-synthesis  ★ OWNER DECISION (2026-07-04)

**Revised from "generative = propose-only" → "generative = confined-auto, propose only for human-truth edits."** Blanket propose-only causes approval fatigue (queue clutter → rubber-stamping), which is *less* safe. Autonomous synthesis is safe when it is **confined + attributed + reversible** — all of which KnowledgeWriter already guarantees — so it satisfies "one writer / no hidden brain" (KN-4/KN-9) WITHOUT a human in every loop (it still routes through KnowledgeWriter, never a second/direct writer; the candidate gate + no-inference still apply; the egress veto still governs the synthesizing model).

**Write-class autonomy taxonomy (the approval matrix does this):**

| Class | Examples | Autonomy | Safety basis |
|---|---|---|---|
| Additive / derived, confined | new `Synthesis — X.md`; new `[[links]]`; backlinks; timelines; index rebuild | **AUTO** | writes only new notes / `@generated` regions — structurally cannot touch a human `@user` section; attributed; reversible |
| In-place edit of assistant-owned region | refresh a `@generated` block | **AUTO** | sentinel-bounded; human regions untouchable |
| Edit changing a human-relevant claim | reconcile a contradiction that rewrites a stated fact; flip project status; merge entities | **PROPOSE** (or auto-with-undo) | affects canonical truth |
| External side effect | create Linear issue / calendar event | **PROPOSE** (approval matrix) | envelope + receipt |

**Anti-clutter mechanisms (files NEW):** `packages/knowledge/src/synthesis/` (the confined synthesis planner → KnowledgeMutationPlans), `apps/worker` scheduled synthesis activity.
- **Digest, not a queue:** a synthesis run does not file N inbox cards — it writes, then posts ONE receipt (`"+14 links, +3 synthesis notes, 1 contradiction flagged — [review] [undo batch]"`). "Undo batch" = revert the run's KnowledgeWriter revisions (one action).
- **Confident auto, ambiguous propose:** clear-winner reconciliations auto-apply; only genuinely ambiguous conflicts become inbox items (mirrors osb's Conflict-note behavior, but reversible).
- **Acceptance:** every autonomous write routes through `KnowledgeWriter.applyPlan` (never a direct writer); `@user` regions provably untouched; full audit + one-action batch-undo; the synthesizing model obeys the workspace egress veto (employer-work ack-OFF ⇒ local model).

## §13.9 design — NotebookLM cloud grounding, WORKSPACE-GATED — G-notebooklm  ★ OWNER DECISION (2026-07-04)

**NOT rejected — gated by workspace + the egress acknowledgment.** Safety rule 5 does not ban cloud upload; it bans *employer-work raw content with ack OFF*. That is an owner-controlled dial, not a wall.
- **personal_business / personal_life:** NotebookLM works freely (cloud allowed by policy for these workspaces).
- **employer_work:** works with the per-workspace **egress acknowledgment ON** (explicit, logged consent — exactly what the ack exists to grant); with it OFF it fails closed (the one non-negotiable line — and still the owner's switch).

**Files (NEW):** `packages/integrations/src/tools/adapters/notebooklm-ground.ts` (Gemini File Search as a cloud processor on `ModelProviderPort`, behind the Tool Gateway envelope).
- **Scoped to the current workspace's notes ONLY** (workspace isolation — no cross-workspace bleed; the GCL rule still forbids raw cross-workspace content in one call). Improves on osb's flat-vault 12-note grab.
- Upload is an external side effect → Tool Gateway (idempotency + receipt; ephemeral store force-deleted after, as osb already does).
- The returned grounded synthesis is **candidate data → gate → KnowledgeWriter** — the produced note is governed like any other.
- **Acceptance:** an employer-work invocation with ack OFF FAILS CLOSED (egress-leakage eval); a personal-workspace invocation succeeds; upload never includes another workspace's notes.

---

## Sequencing & non-disruption
- Runs **after** Phase-9 §9.5 (Project dashboard) lands. §13.5 (typed Project contract) is the natural bridge — it unblocks that dashboard, so coordinate the frozen-contract round with the desktop track rather than racing it.
- Nothing here edits `apps/desktop`. Order within the phase: **13.1 → 13.2/13.3/13.4 (parallel) → 13.5 → 13.6 → 13.7.**

## Risks
- osb's fast/bursty cadence (8 releases in 9 weeks; breaking changes in MINOR bumps) — mitigated by the ACL (§13.1) depending only on the vault-agnostic libs + the eval-gate.
- New Python subprocess runtime + supply-chain surface — mitigated by pin + osb's own Dependabot/OpenSSF Scorecard, and by keeping the subprocess emit-only (no writes, no keys it doesn't need).
- §13.5 is a frozen-contract round (cross-track) — must be orchestrated, not done solo mid-flight.
