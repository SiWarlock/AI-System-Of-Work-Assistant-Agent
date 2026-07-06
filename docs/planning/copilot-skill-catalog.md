# SoW Copilot Skill Catalog & Gap Analysis

> **Thesis — the gap is EXPOSURE/CATALOG, not machinery.** The SoW Copilot is a genuinely deep *governed control plane* (KnowledgeWriter as the sole autonomous Markdown writer, the Tool-Gateway external-write envelope, `copilot.propose_action` → §9.8 Approvals, WS-8 workspace scoping, ING-7 admission, the egress veto) — but the Copilot *itself* is cataloged with only a small tool set. Almost no repo capability is exposed as a Copilot skill. Phase 13.1–13.9 builds the engine room (extractors, retrieval, the Project model, provenance stamping) and adds **ZERO** entries to `packages/policy/src/copilot-tool-catalog.ts`; it is entirely ingestion/retrieval/synthesis *infra* (pull data in) and stops exactly at the catalog boundary. The governance rails already exist and are wired for the propose path — they are just structurally OFF and un-cataloged. So the work is deliberate: **catalog capabilities as skills, by governance class**, on rails that already exist.

**Source of truth.** This document is the **durable, in-repo source of truth** for the Copilot skill catalog / gap analysis. It supersedes the transient claude.ai artifact and the `~/.claude` memory `sow-copilot-skill-catalog` (both outside the repo, fragile). It is the synthesis of a **6-agent gap-analysis workflow** (4 deep-dive surveyors — gbrain repo, osb repo, SoW code, SoW plan — + a synthesis agent + a completeness critic) plus a direct read of the live catalog. The **task tracker** for turning this into shipped skills is `IMPLEMENTATION_PLAN.md` **§13.10** (Copilot Skill Catalog, Tier 0–5 by governance class). Keep the two in sync: **§13.10 tracks the work; this doc captures the analysis + BUILD STATUS.**

---

## 1. The two upstream repos

- **gbrain** (`garrytan/gbrain`, MIT, live v0.35.1.0) — a local-first personal knowledge brain (memory + hybrid-RAG retrieval + self-wiring typed-edge knowledge graph) over Markdown, operated *by* an AI agent. Ships **~55 versioned skills** over a **76-tool MCP surface** (retrieve → analyze → reason → takes → maintain → agent-ops), a dream-cycle over the Minions durable job queue, and MCP-over-HTTP (OAuth-2.1/DCR) — the surface SoW already consumes over `gbrain serve --http`.
- **obsidian-second-brain (osb)** (`eugeniughelbur/obsidian-second-brain`, ~v0.10–0.11.x) — a cross-CLI skill that turns an Obsidian vault into a self-rewriting AI-first second brain: **44 command playbooks** (Operations/Thinking-Tools/Context-Engine/Research), a Python research/extractor layer (`scripts/research/lib/` + **10 key-less source adapters**), a **10-tool vault MCP** (7 read/metadata + 3 write), and 4 scheduled + 1 background autonomous agents.

**Governance posture toward both:** the FETCH/ANALYZE/READ layers are inheritable as *candidate-data-in* under ING-7 read-only tool-stripping (+ egress veto for cloud-bearing ones); every WRITER and every autonomous agent must be re-expressed as a **propose-via-Approvals KnowledgeMutationPlan** — never inherited as a direct writer (one-writer / no-hidden-brain invariant).

---

## 2. The 6 governance classes — how a capability becomes a skill

The governance class is the **load-bearing axis**: it dictates the machinery a capability must route through before it can be a Copilot skill.

| Class | What it is | Machinery it routes through |
|---|---|---|
| **read-only** | Safe for an untrusted Copilot — no side effect. | Tool catalog entry (`copilot-tool-catalog.ts`, `mutating:false`) + runner allow-list + **ING-7** admission (untrusted ⇒ read-only tools only) + **WS-8** workspace scoping. No approval. |
| **synthesis** | Reason over retrieved content → a cited answer; no side effect. | **Candidate-data gate** (ajv∘Zod JSON-Schema) + **egress veto** (`vetoJobEgress`; Employer-Work raw content fails closed to a local model, never cloud fallback). Output is candidate data until it passes the gate. |
| **semantic-write** | Mutate canonical Markdown / graph / tags / facts. **The Copilot NEVER writes Markdown.** | Copilot proposes a **`KnowledgeMutationPlan`** → **§9.8 Approvals** (the missing **13.10a** bridge) → **KnowledgeWriter** `applyPlan` (the sole autonomous writer). Tiered-auto per 13.8 for additive/`@generated`-region writes. |
| **external-action** | A side effect on an external system (calendar, tracker, cloud grounding, publish). | **Tool-Gateway envelope** (idempotency key + canonical object key + pre-write existence probe + write receipt) → `copilot.propose_action` → **§9.8 Approvals** + **egress veto**. |
| **ingest-trigger** | Pull external content into the brain. | Extractor stays **emit-only** → candidate `SourceEnvelope` → **`registerSource`** → **KnowledgeWriter**. Untrusted content (web/YouTube/X/podcast/email) ⇒ **ING-7** read-only tool-strip at admission. |
| **not-a-copilot-skill** | We already have the governed equivalent, or it is governance-hostile. | Skip. (HITL primitive under every propose path; Temporal ≈ Minions; schema/skill authoring + cold-start = governed admin/migrations, not agent skills.) |

---

## 3. The catalog — by governance class

**Legend.** gbrain / osb: ✓ present, ✗ absent. Code: `built` / `partial` / `stub` / `no`. Plan: the §13.x task, or `—`. **BUILD STATUS:** `BUILT-DORMANT ✅` (cataloged + code, dormant behind `copilotAgentMode` OFF) · `BUILT` (live) · `cataloged-no-handler` (in catalog, no runtime binding) · `IN-PLAN` (a §13.x task exists) · `GAP` (in neither code nor Phase 13).

**Live catalog surface today** (`packages/policy/src/copilot-tool-catalog.ts`): **22 read tools + 1 propose tool = 23 tools.** That is the original **7 read** (6 gbrain reads: `search`/`graph`/`timeline`/`schema_read`/`health`/`contained_synthesis` + `vault.read`) plus **15 net-new reads** landed by the Tier-1 §13.10b slices, plus `copilot.propose_action`. (Note: the pre-Tier-1 surface was **8 tools** — 7 read + 1 propose — the "7-tool" figure in earlier prose was an arithmetic slip: 6 + 1 + 1 = 8.)

### 3.1 read-only

The cheapest, highest-leverage, lowest-risk class. Every entry is ING-7-safe, WS-8-scoped, zero approval.

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Machinery / recommendation |
|---|---|---|---|---|---|---|
| Hybrid semantic retrieval (`query`/`search`/`recall`) | ✓ | ✓ | partial | 13.3 | IN-PLAN (cataloged `gbrain.search`; live transport built-not-wired, default = fixture) | Flip the live gbrain http/OAuth transport on (needs `gbrain serve` + `VOYAGE_API_KEY` out-of-process) + land 13.3 as the real engine behind the cataloged tool. **expose-now.** |
| Direct page / chunk / slug read (`get_page`, `get_chunks`, `resolve_slugs`, `obsidian_read_note`) | ✓ | ✓ | stub | 13.4 / 13.10d | cataloged-no-handler (`vault.read` cataloged, NO runtime binding) | Bind a concrete `vault.read` handler + stand up the read-only vault MCP (13.10d); path-traversal-guarded, WS-8-scoped. |
| Graph neighborhood read (`get_backlinks`/`get_links`/`get_tags`/`get_timeline`) | ✓ | ✓ | partial | 13.4 / 13.10d | partial (`gbrain.graph`/`timeline` cataloged as **phantom names** — see gate d) | expose-now on the gbrain side once ids are de-phantomed; catalog the vault backlinks tool from 13.4. |
| Brain / vault introspection & health — READ half (`get_stats`/`get_health`/`get_versions`/`whoami`, `vault_health`) | ✓ | ✓ | partial | 13.4 / 13.10d | partial (`gbrain.health`/`schema_read` cataloged, phantom; `vault_health` IN-PLAN) | Diagnostics only. expose-now (gbrain) + catalog-extend the vault `vault_health`/`validate_note` read from 13.4. |
| **Graph anomaly / contradiction / orphan detection** (`find_contradictions`/`find_anomalies`/`find_orphans`) | ✓ | ✓ | built | 13.10b | **BUILT-DORMANT ✅** (`b186d82`) | Highest-leverage *no-inference* safety add (REQ-F-017): surface conflicts BEFORE answering, route to clarification instead of guessing. Take gbrain's READ shape, never osb `/reconcile` auto-resolve. (`traverse_graph` is NOT yet cataloged — it exists only as the phantom `gbrain.graph`, see §5.2(d).) |
| **Expert routing / whoknows** (`find_experts`) | ✓ | ✗ | built | 13.10b | **BUILT-DORMANT ✅** (`9c0ba53`) | Routes a question to who-in-the-brain knows it; pure read, ING-7-safe. |
| **Takes — opinions / predictions / calibration** (`takes_list`/`search`/`scorecard`/`calibration`) | ✓ | ✗ | built | 13.10b | **BUILT-DORMANT ✅** (`9c0ba53`) | The clearest personal-OS memory SoW entirely lacked. Track the owner's stated opinions/bets + score calibration over time. Pure read/analyze. |
| **Code intelligence** (`code_def`/`refs`/`callers`/`callees`/`flow`/`blast`; osb `architect_scan.py`) | ✓ | ✓ | built | 13.10b | **BUILT-DORMANT ✅** (`9c0ba53`) | Answer architecture/impact questions over the brain's indexed code graph instead of grep loops. `code_traversal_cache_clear` DELIBERATELY EXCLUDED (D8-destructive ⇒ fail-safe classifier treats it as mutating). osb commit-mining (`mine_commit_decisions.py`) is read-only → feeds a candidate ADR (semantic-write). |
| Recency / resume-context reads (`get_recent_salience`; `get_recent_transcripts`) | ✓ | ✓ | built | 13.10b | **BUILT-DORMANT ✅** `get_recent_salience` (`24174a3`); `get_recent_transcripts` **EXCLUDED** (LOCAL-ONLY — rejects remote http callers ⇒ dead allow-list entry) | "What was I just working on / what's hot" — the natural first input to the daily-briefing synthesis skill. (Critique: was mis-filed under health/diagnostics.) |
| Health / vault AUDIT half (orphans, broken links, missing frontmatter, citation check, `run_doctor` read; osb `vault_health.py`/`link_graph.py`) | ✓ | ✓ | partial | 13.4 | partial (orphans covered by `find_orphans` BUILT-DORMANT; vault `validate_note` IN-PLAN 13.10d) | The AUDIT half is read-only. Any FIX (`citation-fixer`/`frontmatter-guard`/`run_doctor` write) is **semantic-write** (see §3.3) — **do NOT treat the fixers as no-approval reads** (critique: the source matrix mis-set this whole row `read-only`). |
| Skill self-introspection (`list_skills` / `get_skill`) | ✗ | ✓ | no | 13.10d | IN-PLAN (folded into the vault-MCP slice) | *(Critique addition.)* The agent enumerating which skills it can invoke + reading a named skill's steps — the exact C6 skill-catalog-over-MCP pattern, zero write risk. Tier-1 read-only. |
| gbrain-advisor — "how to get more out of your brain" meta-advisory | ✓ | ✗ | no | — | GAP | *(Critique addition.)* A clean standalone read-only "what am I missing" coaching skill ("always asks before fixing"); was invisibly folded into the task-management row. |
| Schema READ (`schema_read` / `gbrain schema show`) | ✓ | ✗ | partial | — | partial (cataloged, phantom name) | The read-only slice of the brain-administration row (§3.6). Diagnostics only; the authoring/migration siblings are `not-a-copilot-skill`. |

### 3.2 synthesis

Candidate-data gate + egress veto; no side effect.

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Machinery / recommendation |
|---|---|---|---|---|---|---|
| **Multi-hop cited synthesis / Copilot Q&A** (`think`, `contained_synthesis`; osb thinking-tools) | ✓ | ✓ | built | partial | **BUILT** (§9.6 Copilot live end-to-end; `gbrain.contained_synthesis` cataloged) | This IS the shipped §9.6 Copilot. Enhance with `think`'s explicit "what the brain does NOT yet know" + conflict output → directly serves REQ-F-017 no-inference. 13.3 feeds it. |
| Strategic reading / concept synthesis / idea lineage (osb `/emerge` `/connect` `/idea-discovery`) | ✓ | ✓ | no | — | GAP | The flagship "second brain" value: applied playbooks, tiered concept maps, tracing how thinking evolved. Read+synthesis only. Tier-2. |
| Brain-augmented external web research (osb 10 key-less adapters + `perplexity`/`grok`; academic-verify) | ✓ | ✓ | no | 13.2 (partial) | GAP as an on-request skill | osb's key-less adapter pool (wikipedia/arxiv/crossref/duckduckgo/hackernews/reddit/openalex/semantic_scholar/devto/lobsters) is the single biggest clean *candidate-data-in* win. Cloud upgrade (Perplexity/Grok/13.9) is egress-bearing → **veto-gated per workspace, fail-closed for Employer-Work.** 13.2 frames it as ingestion, not an on-request skill. |
| Daily briefing & reports (osb `/recap`; gbrain `briefing`/`daily-task-prep`) | ✓ | ✓ | partial | — | GAP as a Copilot skill (§9.4 Today surface exists) | The natural FIRST synthesis skill: maps 1:1 onto §9.4 Today. Composes retrieval + `get_recent_salience` + calendar/meeting reads into a cited candidate briefing. |
| Cross-modal / second-model quality gate (`cross-modal-review`) | ✓ | ✗ | partial | — | GAP | A second-model verification layer that composes with the candidate-data JSON-Schema gate for higher-assurance answers. Later synthesis tier. |

### 3.3 semantic-write (Copilot → KnowledgeMutationPlan → §9.8 → KnowledgeWriter)

**The Copilot NEVER writes Markdown.** The whole class is blocked on the **missing 13.10a bridge**.

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Machinery / recommendation |
|---|---|---|---|---|---|---|
| **Semantic page write** (`put_page`, `delete`/`restore`/`revert`; osb `save_note`/`update_note`, `/save` `/log` `/daily`) | ✓ | ✓ | built | partial | **GAP — the sharpest gap.** Writer BUILT (KnowledgeWriter `applyPlan`); **NO Copilot→KMP path** (propose only builds an *external* `ProposedAction`) | Build the missing **13.10a** Copilot→`KnowledgeMutationPlan` propose path. Precondition: the **C5.4b** real `admitForServing`-backed provenance oracle (go-live gate). |
| Graph / tag / fact mutation (`add_link`, `add_tag`, `extract_facts`, `forget_fact`) | ✓ | ✓ | built | partial | GAP (same missing 13.10a path) | Edges/tags/facts mutate canonical truth → route as a KMP propose→Approvals, never gbrain's direct `add_link`/`extract_facts`. |
| Filing / taxonomy proposal-builder (`brain-taxonomist`, `eiirp`) | ✓ | ✗ | partial | — | GAP | Recommend a filing path + reasoning from the active schema BEFORE a write — exactly the shape of a KMP proposal-builder. Never a direct write. Tier-4. |
| On-request living-vault synthesis / link-build / reconcile (gbrain dream cycle; osb `/reconcile` `/synthesize` `/distill`) | ✓ | ✓ | partial | 13.8 | GAP as an on-request skill (13.8 wires it **background-only**) | Sharpest divergence: the SENSE→REASON→EFFECT planner is invocable on demand ("synthesize / build links / reconcile / organize X now") via 13.10a. Additive/`@generated`-region writes tiered-auto (13.8); human-truth edits + external effects PROPOSE. Never osb's silent auto-resolve. Port osb `/distill`'s block-provenance (`src: Bn`) + `@generated`/`@user` markers into KnowledgeWriter. |
| Health / vault FIX half (`citation-fixer`, `frontmatter-guard`, `run_doctor`; osb `heal_links`) | ✓ | ✓ | partial | 13.4 (partial) | GAP (propose-only) | *(Critique: the source matrix wrongly classed this half read-only — the DANGEROUS pole.)* Any fix mutates canonical truth ⇒ propose-only via KnowledgeWriter, never gbrain's direct fixer. |
| Task WRITES (vault task mutations; osb `/task`) | ✓ | ✓ | partial | — | GAP | Split from task-management: reads → read-only; vault task writes → KMP propose. No-inference: never invent owner/date (emit `TBD`). |
| Typed Project state transitions (gbrain project page-types; osb `/board` `/project` `/graduate`) | ✓ | ✓ | partial | 13.5 | GAP (needs the typed Project model) | Land **13.5** first (Project = 7th state machine; the desktop Projects page computes a server percent with NO typed model behind it). Then Project READS → expose-now; status/state transitions → KMP propose→Approvals. |

### 3.4 external-action (Tool-Gateway envelope → propose → §9.8 + egress veto)

Highest-risk; last. Reuses the **fully-built-but-OFF** propose machinery (`copilotProposeMode` flag OFF).

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Machinery / recommendation |
|---|---|---|---|---|---|---|
| Publishing — **shared-egress** half (gbrain `publish` password-protected HTML; `brain-pdf` shared) | ✓ | ✓ | no | — | GAP | True egress → subject to the Employer-Work egress veto. Not a near-term skill. *(Critique: the source matrix over-restricted the whole publishing row to external-action; only the shared half is egress.)* |
| Publishing — **local-export** half (osb `export_okf.py`/`/obsidian-export`; local `brain-pdf`) | ✓ | ✓ | no | — | GAP (near expose-now) | Local snapshot/file, **no external side effect** — a read/handoff surface. Near read-only; useful as a Copilot handoff surface. |
| Calendar operations (osb `/obsidian-calendar`) | ✗ | ✓ | partial | — | GAP (adapters built-not-wired) | Split: agenda **READS** → read-only (calendar read connector, built-not-wired); event **create/modify** → external-action through the Tool-Gateway envelope + propose→§9.8 + egress veto. |
| NotebookLM cloud grounding (osb `/notebooklm` → Gemini File Search) | ✗ | ✓ | no | 13.9 | IN-PLAN (13.9) | Gemini File Search as a `ModelProviderPort` cloud processor behind the Tool-Gateway envelope. Personal free; `employer_work` needs egress-ack ON else **FAIL CLOSED** (safety rule 5). Returned grounding is candidate → gate → KnowledgeWriter. |
| External-tracker writes (Todoist / Linear / Drive / GitHub / Telegram / Asana) | ✗ | ✓ | partial | 13.10 Tier-5 | GAP (adapters + propose machinery BUILT-but-OFF; none Copilot-exposed) | The write adapters + `copilot.propose_action` sink are built (built-not-wired, structurally OFF). Wire behind `copilotProposeMode` → Tool-Gateway → §9.8 + egress veto. Gated on the C5.4 go-live work. Phase 13 plans NONE of these (only NotebookLM). |

### 3.5 ingest-trigger (extractor emit-only → registerSource → KnowledgeWriter)

Untrusted content ⇒ ING-7 read-only tool-strip. The extractor stays emit-only; the **trigger** is the new skill.

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Machinery / recommendation |
|---|---|---|---|---|---|---|
| YouTube extractor + "summarize & register" trigger (osb `/youtube` + `video_frames.py`) | ✓ | ✓ | stub | 13.2 | built-but-stub (`youtube-source.ts` emit-only); **trigger uncataloged (GAP)** | Swap the real `YouTubeExtractTransport`, then catalog a "summarize & register this YouTube video" agent tool. Emit-only → registerSource → KnowledgeWriter; untrusted → ING-7 read-only. |
| Podcast extractor (osb `/podcast` + Whisper) | ✓ | ✓ | no | 13.2 | GAP (referenced in the taxonomy; no adapter file) | Build the podcast-source adapter (RSS/Whisper/show-notes fallback) + catalog an ingest-trigger skill. ING-7 read-only. |
| Web-article / RSS extractor (osb `/research` article path) | ✓ | ✓ | no | 13.2 (partial) | GAP (only the generic http url-source connector exists) | Build a dedicated article/RSS extractor + catalog an ingest-trigger skill. 13.2 covers research synthesis, not a dedicated article/RSS extractor. |
| Meeting / voice-note / transcript ingestion (osb `/catchup` Telegram voice) | ✓ | ✓ | partial | — | partial (Meeting-Closeout state machine + granola connector built) | Add a transcript extractor + ingest-trigger later. Port voice-note's "preserve exact phrasing, never paraphrase" discipline. Untrusted → ING-7. |
| Ambient signal capture / "capture as I work" (`/capture`; gbrain `signal-detector`) | ✓ | ✓ | stub | 13.6 | built-but-stub (`capture-source.ts` emit-only: coding_session trusted + telegram untrusted, sender-allowlisted); **trigger uncataloged (GAP)** | The auto-capture the owner explicitly wants. MUST enter as candidate-data → registerSource → KMP → KnowledgeWriter propose-only, NEVER gbrain `put_page` or osb's autonomous bg-agent. A "/capture this decision" Copilot trigger is the new ingest-trigger skill. |
| X / Twitter ingest (osb `/x-read` deep-read a post/thread; `/x-pulse` scan trends) | ✓ | ✓ | no | 13.10 Tier-3 | GAP | *(Critique addition — the entire social-media surface was mapped to NO row.)* Prompt-injection surface → ING-7 read-only tool-strip; fetch is candidate-data-in. An ingest-trigger / Tier-2 research skill. |
| Archive-crawler + webhook-transforms (gbrain: Dropbox/B2/email-export mining behind a `gbrain.yml` scan_paths allow-list) | ✓ | ✗ | no | — | GAP | *(Critique addition — was folded invisibly into the signal-capture row.)* An allow-list-gated ingest-trigger (ING-7 read-only); **partially answers the email-ingestion gap** rather than leaving email a pure NEW build. |
| Gmail / email connector | ✗ | ✗ | no | 13.10c | IN-PLAN (13.10c) | Absent from BOTH code and Phase 13 originally; owner decision 2026-07-05 "yes". A least-privilege read-scoped ingestion connector (email → candidate `SourceEnvelope` → registerSource → KnowledgeWriter); gbrain's archive-crawler pattern partly informs it. Untrusted → ING-7. |

### 3.6 not-a-copilot-skill

We already have the governed equivalent, or it is governance-hostile.

| Capability | gbrain | osb | Code | Plan | BUILD STATUS | Why skipped |
|---|---|---|---|---|---|---|
| Human-in-the-loop choice gate (`ask-user`) | ✓ | ✗ | built | yes | HAVE | SoW already has it (Approvals + `AskUserQuestion` + §9.8). It is the HITL primitive UNDER every propose path, not a standalone skill. *(Critique: in gbrain `ask-user` is a send-to-external-channel action; SoW re-expresses it as the internal HITL gate.)* |
| Durable job queue / scheduled orchestration (gbrain Minions; osb scheduled agents) | ✓ | ✓ | built | partial | HAVE | SoW's Temporal worker/workflows IS the governed equivalent. osb's autonomous scheduled WRITERS (morning/nightly/bg-agent) violate the one-writer / no-hidden-brain invariant and must be reimplemented as propose-only jobs; only osb's read-only Sunday health agent survives near-as-is. |
| Brain / skill administration & bootstrapping (`schema-author`, `skill-creator`/`skillify`, `migrate`, `cold-start`, `setup`, `soul-audit`; osb `/create-command`, `/init`, `bootstrap_vault.py`) | ✓ | ✓ | partial | — | HAVE (schema READ) / governance-hostile (authoring) | Schema READ is a read-only tool (see §3.1). Schema/skill authoring + migration + cold-start are governed admin/migrations, not agent skills; osb's self-editing `/learn` + self-installing `/create-command` are governance-hostile. A governed "propose a new skill via Approvals" analogue is a much-later possibility. |

---

## 4. Recommended rollout — Tier 0–5 (by governance class = wiring order)

Every write is human-gated, so this is **wiring order, not a safety gate.** Start read-only (near-zero risk), end external-action (highest risk).

- **Tier 0 — EXPOSE-NOW** (already built + governed, zero new governance). Flip the live gbrain read transport on (13.3 + `gbrain serve` + `VOYAGE_API_KEY`); bind a concrete `vault.read` handler; ship the §9.6 `think`-style cited Q&A with explicit "what the brain does NOT know" (REQ-F-017). — **BUILD: partial.** Live transport + `VOYAGE_API_KEY` confirmed present (owner 2026-07-05); §9.6 Copilot BUILT; `vault.read` handler still folded into the vault-MCP slice.
- **Tier 1 — CATALOG-EXTEND READ-ONLY** (biggest capability-per-risk win). The missing gbrain analysis reads + 13.4's 5 vault read tools + `list_skills`/`get_skill`. — **BUILD: gbrain-read portion DONE ✅** (`b186d82` / `9c0ba53` / `24174a3` — 14 analysis/intelligence reads + `get_recent_salience`, all BUILT-DORMANT). **Remaining:** the vault-MCP read surface (`obsidian_search`/`read_note`/`backlinks`/`vault_health`/`validate_note`) + `list_skills`/`get_skill` — need the read-only vault MCP server stood up first (**13.10d**).
- **Tier 2 — SYNTHESIS** (candidate gate + egress veto). Daily briefing (bound to §9.4 Today), strategic-reading / concept-synthesis / idea-lineage, cross-modal review, brain-augmented web research (osb's 10 key-less adapters as candidate-data-in; cloud upgrade veto-gated). — **BUILD: not started** (except the §9.6 Q&A spine, which is BUILT).
- **Tier 3 — INGEST-TRIGGER** (registerSource → KnowledgeWriter; untrusted → ING-7). Catalog "summarize & register this YouTube/URL/podcast/file" + "/capture this decision" + X `x_read`/`x_pulse`. Wire the YouTube stub's real transport; build the podcast + article/RSS adapters. — **BUILD: not started** (extractors emit-only; triggers uncataloged).
- **Tier 4 — SEMANTIC-WRITE** (propose-only; Copilot NEVER writes Markdown). **FIRST build the missing 13.10a Copilot→`KnowledgeMutationPlan` path.** Then the filing/taxonomy proposal-builder, on-request synthesis/link/reconcile (13.8 on-demand), Project/task state proposals (needs 13.5). — **BUILD: not started.** Hard precondition: the **C5.4b** real provenance-stamping serving oracle.
- **Tier 5 — EXTERNAL-ACTION** (highest risk, last). Wire the built-but-OFF write adapters (Calendar/Todoist/Linear/Drive/GitHub/Telegram) + NotebookLM (13.9) behind `copilot.propose_action` → Tool-Gateway envelope → §9.8 + egress veto (`copilotProposeMode`). — **BUILD: not started.** Gated on the C5.4 go-live blockers.

---

## 5. The two sharpest gaps + the ⚠ go-live gates

### 5.1 The two sharpest single gaps

1. **No Copilot → KnowledgeMutationPlan path exists at all (13.10a).** `copilot.propose_action` only builds an *external-write* `ProposedAction` — so the Copilot **cannot propose a Markdown/vault edit**. This one missing bridge blocks the ENTIRE semantic-write class (capture, filing, on-request synthesis, task/project writes) AND the 13.8 dream-cycle propose tier. Build: model supplies intent → server derives a validated `KnowledgeMutationPlan` → routes to §9.8 (or tiered-auto per 13.8). Files: `apps/worker/src/api/procedures/copilotProposeKnowledge.ts` (NEW) + a KMP-shaped propose tool.
2. **The gbrain analysis surface — now partly closed.** The highest-leverage, lowest-risk read tools (`find_contradictions`/`anomalies`/`orphans`, `find_experts`, `takes_*`, `code_*`) were in neither code nor Phase 13. **§13.10b landed the catalog** (`b186d82`/`9c0ba53`/`24174a3`, 14 analysis reads + `get_recent_salience`, all BUILT-DORMANT). What remains is the go-live gate below (WS-8 combined-brain partitioning) before `copilotAgentMode` can flip.

### 5.2 ⚠ 13.10 GO-LIVE GATES (before flipping `copilotAgentMode` — the catalog is DORMANT until ALL clear)

- **(a) WS-8 combined-brain partitioning.** The analysis reads enumerate the WHOLE brain with no workspace-scope arg (`find_orphans`/`find_anomalies` fully unscoped; `find_contradictions`' `slug` + the code tools' `source_id`/`all_sources` are model-suppliable → can TARGET another workspace). The real local gbrain is ONE combined brain (slug/tag-partitioned across all 3 workspaces). Cross-BRAIN isolation holds by construction (one served endpoint, no brain-selector, deny-all for non-served workspaces); **cross-WORKSPACE isolation does not** until per-workspace partitioning + server-enforced scope maps BOTH brain-pages AND code-source → workspace. Amplifies the pre-existing retrieval-seam WS-8 residual.
- **(b) `serve --http` allowedOps scoping.** Verify whether the endpoint gates its exposed MCP surface server-side by the frozen 6-member `GbrainReadGrant.allowedOps` enum. If YES, the new `find_*`/`takes_*`/`code_*` ops (outside it) are admitted-but-unreachable → go-live needs growing the FROZEN enum (cross-track Appendix-A change). The agentic MCP allow-list path bypasses the enum, so no contract change for SAFETY, only functionality.
- **(c) C6 governance eval** (`packages/evals` = eval-security track — coordinate). The propose/analysis-path grounding + leakage eval, incl. asserting the analysis tools stay dormant (or gain server scope) + that the UI-safe answer gate strips `find_contradictions`' `resolution_command` strings (which name mutating ops — inert today, catalog-excluded / deny-by-default).
- **(d) Phantom-name cleanup (pre-existing).** The existing `gbrain.graph`/`timeline`/`health`/`schema_read`/`contained_synthesis` catalog ids do NOT map to live gbrain MCP tool names (real: `traverse_graph` / `get_timeline` / `get_health`; there is no `schema_read`/`contained_synthesis` MCP tool). Inert phantoms under `canUseTool` deny-by-default; rename/prune in a later slice.

---

## 6. How this doc stays current

- **Update BUILD STATUS as each §13.10 slice lands.** When a tier or sub-slice ships, change its `GAP` / `IN-PLAN` / `built-but-stub` marker to `BUILT-DORMANT ✅` (with the commit hash) or `BUILT`, and clear the matching go-live gate when it closes.
- **`IMPLEMENTATION_PLAN.md` §13.10 is the task tracker; this doc is the analysis + status snapshot.** When they disagree, §13.10's checkboxes are authoritative for *what work is done*; this doc is authoritative for *the capability map + governance classification*. Keep the tier BUILD-STATUS markers here consistent with §13.10's `[x]`/`[ ]`.
- **Re-run the 6-agent gap analysis** when either upstream repo (gbrain / osb) ships a materially new skill class, or when the Copilot catalog surface changes shape (a new governance class, a new port). Fold new capabilities in as rows under the right §3.x class; fold critique corrections inline (as the X/Twitter, `list_skills`/`get_skill`, gbrain-advisor, recency-reads, and archive-crawler additions already are).
- **Provenance:** analysis from the 6-agent workflow (2026-07) + a direct read of `packages/policy/src/copilot-tool-catalog.ts`. This file supersedes the claude.ai artifact + the `~/.claude` memory `sow-copilot-skill-catalog`.
