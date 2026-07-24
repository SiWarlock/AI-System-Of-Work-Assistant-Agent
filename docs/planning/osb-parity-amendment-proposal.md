# OSB-Parity Amendment Proposal — Living Vault (auto-link + auto-update) + Governed /research

> **Status: DRAFT PROPOSAL — not yet merged into `ARCHITECTURE.md` / `IMPLEMENTATION_PLAN.md`.** Authored 2026-07-24. Additive roadmap scope ("add this to the plan and architecture" — owner). Written so the orchestrator's integration is **mechanical**: exact section text + anchor ids + task-line format matched to the live docs.
> **Do NOT let this file's presence flip any task state** — it is a planning artifact, not a build. A live owner-gated crossing (§ARM-18) owns the canonical docs; this proposal integrates at the next planning round.
> **Extends, does not replace:** [`PHASE-13-PROPOSAL-osb-inheritance.md`](./PHASE-13-PROPOSAL-osb-inheritance.md) (§13.8 living-vault synthesis · §13.9 NotebookLM) and [`osb-integration-architecture.md`](./osb-integration-architecture.md) (Truth→Index→Read). It expands §13.8 from a design sketch into buildable slices and adds the one genuinely-missing capability: a governed web-research provider.

The owner wants three OSB behaviors working **exactly as OSB does**, under SoW governance:

1. **Auto-linking** of docs to related entries (`[[wikilinks]]` + backlinks).
2. **Auto-updating** related entries (people / projects / concepts) when a source is ingested — *"the vault rewrites itself"*.
3. The **exact research commands** — `/research` and `/research-deep` — including their Perplexity (+ Grok) web-research flow that adds findings to the vault.

---

## PART 1 — Research dossier: how OSB actually does it (ground truth, anchored)

**Primary source (authoritative — the installed version):** cached plugin `~/.claude/plugins/cache/obsidian-second-brain/obsidian-second-brain/0.12.0/`.
**Secondary source (version-delta):** GitHub `eugeniughelbur/obsidian-second-brain`, currently **v0.14 "The Harvest"**. The core research/ingest/propagation flow is **stable across the 0.12→0.14 delta**; v0.14 adds Brave/Tavily free sources + secret detection + multi-turn brainstorm — none load-bearing for this proposal. Anchors below are to the cached 0.12.0 tree.

### Behavior 1 — Auto-linking (`[[wikilinks]]` + backlinks)

OSB auto-linking is **two mechanisms**, not one:

- **Generation-time link mandate (the primary mechanism).** Every vault-writing command enforces `references/ai-first-rules.md` **Rule 6 "Cross-links are mandatory"** (`ai-first-rules.md:51-58`): *"Every person, project, idea, decision, or concept referenced uses `[[wikilinks]]` so the graph is traversable."* The model **writes the links into the note body at authoring time** (`Sarah at [[People/Sarah Chen]] decided to ship [[Projects/Dashboard Refactor]]`). If a target doesn't exist, it creates a stub (`ai-first-rules.md:58`). Every command file repeats this rule in its `**AI-first rule:**` footer (e.g. `research.md:34`, `obsidian-ingest.md:118`).
- **Deterministic link healing (repair pass).** `scripts/heal_links.py` repoints broken Title→file links: a human-Title wikilink `[[Host iptables rules]]` whose file on disk is kebab-cased `host-iptables-rules.md` is rewritten to `[[host-iptables-rules|Host iptables rules]]` (`heal_links.py:8-9,147-156`). **Only certain matches auto-apply** — exact stem/alias match or a *faithful* slug match (`slugify` + `slug_is_faithful`, `heal_links.py:62-79`); a lossy slug (`C++`→`c`), a fuzzy `difflib` hit, or a 2+ candidate ambiguity is **never auto-applied** — it goes to AI triage (`triage_links.py`) (`heal_links.py:113-135`). Rewrites never touch code fences.
- **Backlinks are implicit / derived, not written.** OSB never writes a "backlinks" section. `scripts/link_graph.py` (`build_graph`, `link_graph.py:94-218`) computes the graph from resolved `[[wikilinks]]`: **in-degree = backlinks**, out-degree, hubs, orphans (degree 0), dangling links. Obsidian itself renders backlinks natively from the same forward links. Resolution folds em/en dashes but deliberately does **not** flatten spaces↔hyphens (`_norm`, `link_graph.py:50-58`).

**Net:** OSB "auto-linking" = *model writes `[[links]]` inline per the mandate* + *a deterministic healer fixes the ones that don't resolve* + *the graph/backlinks are derived, never authored*.

### Behavior 2 — Auto-update related entries ("the vault rewrites itself")

The load-bearing command is `/obsidian-ingest` (`commands/obsidian-ingest.md`). Its description is literally *"the vault rewrites itself around new knowledge. Every ingest updates entities, rewrites stale claims, synthesizes new concepts, and resolves contradictions"* (`obsidian-ingest.md:2`). The data flow:

1. **Classify + fetch** the source (article/PDF/transcript/YouTube/audio/image/text) (`obsidian-ingest.md:14-61`).
2. **Extract** entities (people/companies/tools/projects), concepts, claims, action items, quotes (`obsidian-ingest.md:62-68`).
3. **Save raw source immutably** to `raw/` (`type: source`, `content_hash`, verbatim body, preamble-exempt) (`obsidian-ingest.md:69-71`, `ai-first-rules.md:208-218`).
4. **REWRITE the vault — the critical step** (`obsidian-ingest.md:73-96`). Reads `index.md` first, then spawns **parallel subagents**:
   - **Entities agent** — for each person/company/tool: search the entities folder; **if found, REWRITE** (merge new + old, update role/context/interactions, add links — *"Don't just append — integrate"*); if not found, create.
   - **Concepts agent** — search concepts folder; if found, REWRITE with new evidence/examples/connections; if a **pattern spans 2+ sources**, create a new **synthesis page** connecting them.
   - **Projects agent** — update Recent Activity + Key Decisions.
   - **Contradictions agent** — for each claim, search for **conflicting** claims; on conflict, update the existing page to note the conflict + mark which is more recent/authoritative; if the new source **supersedes**, rewrite the old page and record what changed.
5. **Update structural files** — rebuild `index.md` (regenerate changed sections, not append); append an op-log line to `Logs/YYYY-MM-DD.md` or `log.md` (`obsidian-ingest.md:97-99`).
6. **Update today's daily note** with what was rewritten + contradictions resolved (`obsidian-ingest.md:101-106`).

The same "propagate to related pages" engine is `/obsidian-save` (`commands/obsidian-save.md:13-24` — parallel People/Projects/Tasks/Decisions/Ideas subagents, *"Search before creating — duplicate notes are vault rot"*) and `/obsidian-synthesize` (`commands/obsidian-synthesize.md` — a **scheduled** agent: cross-source, entity-convergence, concept-evolution, and **orphan-rescue** agents that *"Create the missing links"*, `obsidian-synthesize.md:16-42`). **Anti-fabrication governs all of it:** `ai-first-rules.md:71-83` — never assert absence without exhaustive search (false-absence is the #1 failure); **never invent facts/entities/dates — mark `TBD`**; recency marker + source URL on every external claim.

### Behavior 3 — `/research` and `/research-deep` (Perplexity + Grok → vault)

**External dependencies** (`.env.example`): `PERPLEXITY_API_KEY` (`/research`, `/research-deep`), `XAI_API_KEY` (Grok, the `x` gap-fill leg of `/research-deep`), models `PERPLEXITY_RESEARCH_MODEL=sonar-pro`, `PERPLEXITY_DEEP_MODEL=sonar-deep-research`, `GROK_MODEL=grok-4`. Endpoints: Perplexity `https://api.perplexity.ai/chat/completions` (OpenAI-compatible; `perplexity.py:10`), xAI `https://api.x.ai/v1/responses` with `tools:[{"type":"x_search"}]` Live Search (`grok.py:20,25-51`).

**`/research` (`commands/research.md` + `scripts/research/research.py`)** — mode auto-selected (`research.py:184-201`):
- **Paid** (key set): `perplexity.call(PROMPT_TEMPLATE, deep=False, max_tokens=4500)` returns a finished dossier — Summary / Key Facts (recency markers) / Timeline / Key Players / Contrarian Views / Further Reading / Open Questions / Sources (`research.py:21-60,114-181`). The **script itself** writes the AI-first note to `Research/Web/YYYY-MM-DD - <slug>.md` (`vault.write_note`, `vault.py:46-62`) + a log line (`vault.append_to_log`, `vault.py:130-136`).
- **Free** (no key / `--free`): `aggregate()` over key-less sources (DuckDuckGo, Wikipedia, HackerNews, Reddit, arXiv, Semantic Scholar; `--academic` restricts to arXiv/Semantic-Scholar/OpenAlex/CrossRef) and emits JSON; **the calling Claude synthesizes + writes the note** (`research.py:63-111`, `research.md:20-24`).

**`/research-deep` (`commands/research-deep.md` + `scripts/research/research_deep.py`)** — the **vault-first** 4-phase pipeline (paid, `research_deep.py:224-352`):
- **Phase 1 — vault scan** (identical in both modes; `vault_scan`, `research_deep.py:32-57`): keyword-scores notes under `wiki/Research/Knowledge/Projects/Ideas`, loads the top-8 baseline (`MAX_BASELINE_NOTES=8`).
- **Phase 2 — gap analysis:** `perplexity.call(GAP_PROMPT, deep=False)` emits a baseline summary + **3-5 targeted queries**, each tagged `web` or `x` (`research_deep.py:71-111`).
- **Phase 3 — gap-fill:** each `web` query → Perplexity; each `x` query → `grok.call(..., tools=[{"type":"x_search"}])` (`research_deep.py:245-275`).
- **Phase 4 — synthesis:** `perplexity.call(SYNTHESIS_PROMPT, model="sonar-reasoning-pro", max_tokens=16000)` produces a **delta vs baseline** with fixed sections: What's New / What's Confirmed / **Contradictions / Updates Needed** (naming `[[baseline path]]`) / Synthesis / **Recommended Vault Updates** / Open Questions (`research_deep.py:114-156,277-297`). Saved to `Research/Deep/`.
- **Phase 5 — propagation:** emits a JSON payload between `<<<RESEARCH_DEEP_PROPAGATION_PAYLOAD>>>` markers (`research_deep.py:330-349`); the calling Claude **runs `/obsidian-save` on the synthesis** to update people/projects/ideas — **grounding every `[[path]]` against the real vault first** (`research-deep.md:34-39` — the synthesis is LLM-generated and may name non-existent paths; *"A path appearing in the synthesis is never sufficient evidence that the note exists"*).

**Critical anti-fabrication rule (`research_deep.py:131,150`):** the synthesis may write a `[[path]]` **only** if that exact path was in the scanned baseline; anything else is *"Title" (new note)* — a wrong `[[path]]` fabricates a file. This is OSB's own version of SoW's no-inference gate.

**Structural files (`/obsidian-init`, `commands/obsidian-init.md`):** `index.md` = a catalog `- [[Note]] - description` read FIRST for navigation (`obsidian-init.md:18-22`); `log.md` = a thin pointer to per-day `Logs/YYYY-MM-DD.md` append-only op logs (`obsidian-init.md:23-27`). These are **vault-surface exempt** from the preamble/frontmatter rules (`ai-first-rules.md:227`).

---

## PART 2 — How SoW does each behavior under governance (the mapping)

SoW's hard constraints (root `CLAUDE.md` "Key safety rules") that every mapping lives inside: **(1)** KnowledgeWriter is the ONLY autonomous Markdown writer; every semantic mutation is a validated `KnowledgeMutationPlan`. **(2)** model output is *candidate data* until the JSON-Schema gate + `validateNoInference` (REQ-F-017 → never invent owners/dates, emit `TBD`). **(4)** workspace isolation (WS-8). **(5)** Employer-Work egress veto — a Perplexity/Grok call is **cloud egress**, fail-closed on employer-raw with ack OFF. **(6)** untrusted-content ING-7 read-only.

The relevant SoW primitives already exist (verified in-repo):

- `KnowledgeMutationPlan` (`packages/contracts/src/models/knowledge-mutation-plan.ts:48`): `{ planId, workspaceId, sourceRefs[]≥1, creates: NoteCreate[], patches: NotePatch[], linkMutations: LinkMutation[], frontmatterUpdates: FrontmatterPatch[], externalActionProposals[], confidence, requiresApproval, provenanceOrigin, … }`.
- `LinkMutation` (`packages/contracts/src/models/shared-shapes.ts:64-72`): `{ op: "add"|"remove", srcPath, dstSlug, field? }`. `KnowledgeWriter.applyLink` (`packages/knowledge/src/knowledge-writer/writer.ts:511-528`) inserts `[[dstSlug]]` into the note body, **dedup-on-present**; `remove` strips + tidies whitespace. → **This is the governed exact analog of an OSB inline wikilink.**
- `NotePatch` (`shared-shapes.ts:55-62`): `{ path, regionId, newBody }` — a **region-bounded** patch (KN-8), never a free-form edit. Human-owned regions (`@user`) are unforgeable; assistant regions are `@generated`/`kw:region` (task 13.7b, LESSON 14). → **the governed analog of "REWRITE the page but don't touch human sections".**
- `validateNoInference` (`packages/domain/src/validation/no-inference.ts`, task 1.11): a HARD reject — an owner/date field without a supporting evidence ref fails; unstated ⇒ `TBD`. → **the governed analog of OSB's anti-fabrication.**
- Egress veto: `EgressPolicy` (§5) + the broker's ordered gate (`§7`); the processor allowlist seam `SOW_EGRESS_ALLOWED_PROCESSORS` (task 18.31); §19.6 adds a per-backend embedding-egress predicate (G65). → **the research provider is a NEW cloud processor that must register here.**
- Backlinks are already derivable read-only: `KnowledgeWriter.applyLink` writes **only a forward wikilink on the source note — nothing writes a reciprocal `[[back]]` into the target** (`writer.ts:511-528`); backlinks are instead **derived into the GBrain graph** by `packages/knowledge/src/gbrain/derive/canonical-fact-deriver.ts` (`deriveCanonicalFacts` parses `[[wikilinks]]` from committed body + frontmatter into link facts) and answered via GBrain `get_backlinks` (KN-2). → **no "backlinks section" is authored; backlinks are a derived read, exactly as OSB — SoW already does this.**
- The source-ingestion producer already derives a `KnowledgeMutationPlan`: `runSourceIngestion` (`packages/workflows/src/workflows/sourceIngestion.ts:308`) step 6 `SourceBuildOutputsPort.build` derives the KMP from a validated extraction; `intakeGenerativeProposal` (`packages/knowledge/src/gbrain/remediation/generative-proposal-intake.ts:122`) is the built propose-only intake gate (candidate → schema-gate + `validateNoInference` + non-circular-evidence → KMP `provenanceOrigin='gbrain_proposal'`, `requiresApproval` forced true). → **the living-vault planner extends the single-note step 6 into a multi-entity update, reusing this gate.**

### Behavior 1 → governed auto-linking
The producer (the living-vault synthesis planner, §13.8) emits, for **each entity/project/concept the extracted content references**, a `LinkMutation{op:"add", srcPath:<the note being written>, dstSlug:<resolved canonical slug>}` into the `KnowledgeMutationPlan`. KnowledgeWriter's `applyLink` writes the `[[slug]]` (behaviorally identical to OSB's inline mandate, but routed through the sole writer + gate). **Backlinks** are *not* authored — they are read back through GBrain `get_backlinks` (derived, rebuildable, KN-2), matching OSB's implicit-backlink model. A **deterministic `LinkHealer`** (the governed port of `heal_links.py`) resolves a Title→canonical-slug and emits corrective `LinkMutation`s only on a **faithful/unambiguous** match; ambiguous → a proposed clarification, never an auto-heal (mirrors `triage_links.py`). This is the "additive/derived, confined ⇒ AUTO" tier already named in §13.8's autonomy taxonomy.

### Behavior 2 → governed "vault rewrites itself"
This **is** §13.8 living-vault synthesis, expanded into buildable slices. Each run is the three-phase SENSE→REASON→EFFECT already in §13.8: **SENSE** = a GBrain read (workspace-scoped, WS-8) that resolves the source's entities to existing canonical note paths (a new **`EntityResolver`** — SoW has none today; this is the governed analog of OSB's "search the entities folder, ground the path before writing"); **REASON** = a `ModelProviderPort` call over ServingGate-filtered, egress-veto'd context proposing the per-entity update; **EFFECT** = every change is a `NotePatch` (region-bounded, into a `@generated` region so a human `@user` section is structurally untouchable) / `FrontmatterPatch` / `LinkMutation` inside a `KnowledgeMutationPlan` → KnowledgeWriter → gbrain re-indexes from Markdown. **No-inference** (REQ-F-017) replaces OSB's honor-system anti-fabrication. **Contradiction resolution** = a patch that edits a **human-relevant claim** ⇒ the **PROPOSE** tier (§13.8 taxonomy); additive links/new-synthesis-notes ⇒ **AUTO** with a one-digest receipt + one-action batch-undo. Entity-path grounding replaces OSB's "a path from the synthesis is never proof it exists" with a hard resolve-or-`create`-stub step.

### Behavior 3 → governed `/research` + `/research-deep`
A **new governed Research / Web-Retrieval provider**: Perplexity Sonar + Grok Live Search become an **egress-classed `ModelProviderPort` processor** (not a raw model completion — it is a cloud web-retrieval call), routed through the broker's egress veto. The vault-first **Phase 1 scan is local/zero-egress** (a GBrain read). The gap-analysis / gap-fill / synthesis legs are **cloud egress** → gated: on `employer_work` with ack OFF they **fail closed** (no cloud fallback, rule 5) — the query text itself can carry employer context, so even "free" key-less sources egress the query and are gated the same way. The research note + the synthesis delta are **candidate data → gate → KnowledgeWriter** (never `path.write_text`, unlike OSB's `vault.write_note`). **Propagation** (`/research-deep` Phase 5) feeds the synthesis body into the **behavior-2 living-vault planner** — the "Recommended Vault Updates" bullets become candidate `NotePatch`/`LinkMutation`s, each entity-grounded via the `EntityResolver`, each landing propose-only-or-auto per the §13.8 tier. Real cloud egress + a **paid API key** are the owner-gated arming crossing (§ARM-RESEARCH; two standing hard lines — real external fetch + paid-key provisioning).

---

## PART 3 — Proposed canonical-doc amendments (ready to integrate)

> **⚠ For the orchestrator:** exact text below, matched to the live doc format + anchor convention. Do not edit `ARCHITECTURE.md`/`IMPLEMENTATION_PLAN.md` from this file — copy the blocks in at the next planning round.

### 3A — `ARCHITECTURE.md` additions

**(a) Append to §6 — Knowledge (after the GCL paragraph, before "Deletion"):**

> **Living-Vault Synthesis Engine (KN-10, REQ-F-021).** On every ingest (and on a schedule) the vault **rewrites itself around new knowledge** — related person/project/concept notes are updated, stale claims reconciled, new synthesis notes emerge — **entirely through KnowledgeWriter**. A confined synthesis planner runs SENSE→REASON→EFFECT: **SENSE** resolves the source's referenced entities to existing canonical note paths via the `EntityResolver` (a workspace-scoped GBrain read — WS-8; grounds a target before any write, so an LLM-named path can never fabricate a file); **REASON** proposes per-entity updates via a `ModelProviderPort` call over ServingGate-filtered, egress-veto'd context; **EFFECT** emits every change as a region-bounded `NotePatch` (into a `@generated`/`kw:region` region — a human `@user` section is structurally untouchable, KN-7/13.7b), `FrontmatterPatch`, or `LinkMutation` inside one `KnowledgeMutationPlan` → KnowledgeWriter → gbrain re-indexes from Markdown. The no-inference validator (REQ-F-017) replaces the upstream honor-system: an owner/date without an evidence ref is `TBD`, never invented. **Tiered autonomy (revises "generative = propose-only"):** additive/derived writes (new synthesis notes, links, backlinks, timelines, `@generated`-region refreshes) AUTO-apply — safe by confinement + attribution + reversibility; an edit changing a human-relevant claim (contradiction reconcile, status flip, entity merge) or any external side effect PROPOSES. One digest receipt per run with one-action batch-undo (revert the run's KnowledgeWriter revisions). A DB-only fact remains a parity defect (quarantined) — synthesis never writes the store.
>
> **Auto-link & backlink governance (KN-11, REQ-F-021).** Auto-linking is generation-time + deterministic-repair, both governed. The synthesis planner emits a `LinkMutation{op:'add', srcPath, dstSlug}` for every entity/project/concept the content references; `KnowledgeWriter.applyLink` inserts the `[[dstSlug]]` wikilink (dedup-on-present) — the governed analog of the upstream inline-wikilink mandate. **Backlinks are derived, never authored** — read back through the GBrain read surface (`get_backlinks`/`get_links`, KN-2), rebuildable from Markdown. A deterministic `LinkHealer` (the governed port of the upstream link-heal pass) repoints a Title→canonical-slug link and emits a corrective `LinkMutation` **only** on a faithful/unambiguous match; a lossy-slug, fuzzy, or 2+-candidate link becomes a proposed clarification, never an auto-heal.
>
> **Vault structural-file parity (KN-12).** `index.md` (a `- [[Note]] - description` navigation catalog, regenerated per changed section) and the append-only operation log (`log.md` pointer + per-day `Logs/YYYY-MM-DD.md`) are maintained by KnowledgeWriter as **vault-surface writes** (preamble/rich-frontmatter exempt, like `Home.md`/`catchup.md`), so the one-writer invariant (KN-4/KN-9) holds even for structural files. A synthesis/ingest run appends its op-log line and regenerates the changed `index.md` sections through the same sole writer.

**(b) Append to §7 — Provider & Runtime Broker (after the ⭐ OWNER DECISION subscription paragraph):**

> **Research / Web-Retrieval Provider (RES-1, REQ-F-022).** A distinct `ModelProviderPort` processor family for **cloud web-retrieval with citations** — Perplexity Sonar (`sonar-pro` / `sonar-reasoning-pro`; OpenAI-compatible `/chat/completions`) and Grok Live Search (xAI `/v1/responses`, `tools:[{type:'x_search'}]`) — plus a **free key-less source aggregator** (Wikipedia/HackerNews/arXiv/Reddit/Semantic-Scholar/DuckDuckGo; `--academic` restricts to scholarly). It is **egress-classed** (`egressClass` cloud): every call passes the broker's egress veto FIRST — an `employer_work` job with the egress acknowledgment OFF **fails closed**, no cloud fallback (rule 5); the query text itself is treated as potential employer content, so even key-less sources are gated identically. Retrieved dossiers/deltas are **candidate data → JSON-Schema gate + no-inference → `KnowledgeMutationPlan` → KnowledgeWriter** — the provider never writes Markdown. Citations are preserved verbatim as `sourceRefs`/frontmatter. Conformance-gated like every provider (§12); the paid key is resolved only through SecretsPort (§19.4). **Contract note:** RES-1 introduces new processor identities (`perplexity`, `xai`) — extending the `ProviderId` enum + `ProviderMatrix.capabilityDefaults`/`egressClass` is a **frozen-contract round** (Appendix A + schema-snapshot same round, per §13.5's discipline); the egress veto keys its allow-decision on these processor ids (`SOW_EGRESS_ALLOWED_PROCESSORS`), each vendor its OWN processor, never an alias. RES-1 is **built dormant** over faked transports; binding a real Perplexity/xAI transport + provisioning a paid key is the owner-gated crossing (§19.13 / §ARM-RESEARCH).
>
> **Research pipeline (RES-2, REQ-F-022 — the `/research-deep` shape).** `/research` is a single RES-1 dossier → candidate → KnowledgeWriter. `/research-deep` is **vault-first**: **(1)** a local/zero-egress GBrain scan for the baseline; **(2)** a gap-analysis RES-1 call emitting 3-5 `web`/`x` targeted queries; **(3)** gap-fill (Perplexity `web` + Grok `x`); **(4)** a synthesis delta (What's New / Confirmed / Contradictions / Recommended Vault Updates / Open Questions); **(5)** propagation — the "Recommended Vault Updates" become candidate mutations fed into the KN-10 living-vault planner, each entity-grounded (a synthesis-named path is never trusted; it is resolved-or-stubbed), each landing propose-only-or-auto per the KN-10 tier. Phase 1 is zero-egress; phases 2-4 are egress-gated cloud legs.

**(c) `ARCHITECTURE.md` §19 — new activation leg (Part II), after §19.12:**

> **### §19.13 — Research/Web-Retrieval Provider Go-Live + Living-Vault Scheduling**
>
> Closes **G-research, G-livingvault** — **HARD LINE (crossing 8, independent arc; owner confirm per crossing).** Arms the built-and-dormant RES-1 research provider by binding a real Perplexity/xAI HTTP transport behind a Keychain `SecretsAccessor` (§19.4) + provisioning the paid API key, then flips the research egress-processor allow-entry so `/research` + `/research-deep` reach the live cloud endpoints — every call still veto-gated (employer-work ack-OFF ⇒ fail closed, no cloud fallback). Independently, registers the built-and-dormant **living-vault synthesis** activity (KN-10, task 13.8) into the §19.12 scheduled bundle with LIFE-2 catch-up collapse, so the vault rewrites itself on a cadence (additive AUTO, human-relevant edits PROPOSE, one-digest/one-undo). Independent of the (1)-(6) chain; armable once §19.4 (Keychain) exists.
>
> - **Symbols:** `packages/providers/src/model-provider/research-provider.ts` (`createResearchProvider`, `createPerplexityTransport`/`createGrokLiveSearchTransport`, dormant), `packages/integrations/src/connectors/adapters/free-source-aggregator.ts`, `packages/knowledge/src/synthesis/` (`livingVaultSynthesisPlanner`, `EntityResolver`, `LinkHealer`), `apps/worker/src/temporal/workflows.ts` (register `researchDeep` + `livingVaultSynthesis`), `apps/worker/src/composition/backends.ts` (research egress-processor allow-entry + `WriteTransportGate`-style research arm).
> - **Activates:** §7 (RES-1/RES-2 provider + broker route), §5 (egress veto — research is a cloud processor; the query text is employer-content-bearing), §6 (KN-10/KN-11/KN-12 — synthesis writes only via KnowledgeWriter; backlinks derived), §9 (register + schedule researchDeep + livingVaultSynthesis, LIFE-2), §19.4 (paid research key via SecretsPort), §11 (surfaces the research + digest results).
> - **Invariant:** safety rule 5 employer-work raw egress veto (research cloud call fails closed on ack-OFF, no fallback; OpenRouter/Perplexity/xAI each its own processor, never an alias); rule 1 one-writer (synthesis + research findings land only via `KnowledgeMutationPlan` → KnowledgeWriter; a DB-only fact is a parity defect); rule 2 candidate-data + no-inference (REQ-F-017 — a synthesis-named vault path is grounded-or-stubbed, never fabricated; owners/dates `TBD`); rule 6 ING-7 (retrieved web/X content is untrusted → read-only extraction); rule 7 paid key via SecretsPort, never logged.
> - **Kind:** HARD-LINE/mixed (provider adapters + free aggregator + planner + scheduling are pure-build/dormant; binding the real Perplexity/xAI transport + paid key + the schedule flip are the crossing).

**(d) `ARCHITECTURE.md` §19.12 — amendment note (one line, into the §19.12 body):**

> *(amend)* The scheduled bundle additionally registers **`livingVaultSynthesis`** (KN-10) once §13.8 lands — additive synthesis writes AUTO-apply, human-relevant edits PROPOSE, per a default-OFF strict-`=== true` owner-confirmed arming per schedule (armed at §19.13).

**(e) `ARCHITECTURE.md` Spec Anchor Index — new rows:**

> | REQ-F-021 (new) | §6, §9, §13.8 | Living-vault synthesis: governed entity auto-update + auto-linking on ingest ("the vault rewrites itself"); tiered autonomy via KnowledgeMutationPlan (KN-10/KN-11/KN-12) |
> | REQ-F-022 (new) | §7, §5, §6, §8 | Governed web-research provider (/research, /research-deep) — egress-gated cloud web-retrieval (Perplexity/Grok) → candidate → KnowledgeWriter; vault-first gap analysis + propagation (RES-1/RES-2) |
> | §19.13 (Phase 26) | §7, §5, §6, §9, §19.4 | Research/Web-Retrieval provider go-live (real Perplexity/xAI transport + paid key) + living-vault synthesis scheduling [HARD-LINE crossing 8, independent arc] |

### 3B — `IMPLEMENTATION_PLAN.md` additions

**(i) EXPAND task 13.8 (currently one OPEN task) into buildable slices.** Replace the single 13.8 with 13.8a-e (keep the parent 13.8 header + its OWNER-DECISION prose; the slices are its buildable decomposition). All **dormant**, deterministic legs TDD, model legs eval-tested.

```
### 13.8a — EntityResolver (source entity → canonical vault note path, WS-8)
- [ ] OPEN
**Kind:** build · **Spec:** §6 (KN-10), §5 (WS-8) · **Depends:** P4 (GBrain adapter/index), 13.3 (retrieval) · **Blocks:** 13.8c, 13.8d, 13.14 (research propagation)
**Files:** packages/knowledge/src/synthesis/entity-resolver.ts (NEW) · test/entity-resolver.test.ts
Resolve a referenced entity (person/project/concept) to an EXISTING canonical note path via a workspace-scoped GBrain read (WS-8 — no cross-brain query, safety rule 4), returning a resolved path OR a "create-stub" decision — the governed analog of OSB's "ground the path before writing; a synthesis-named path is never proof the note exists". Deterministic given the GBrain read result: exact-slug/alias match resolves; ambiguous (2+) or lossy → withhold + flag (never a fabricated path). PURE over an injected GBrain read port; never-throws; fail-closed to "unresolved" on any fault. **Done-when:** the resolver maps a hit to its real path, withholds on ambiguity, and a WS-8 test proves it never resolves across workspaces.

### 13.8b — LinkHealer + governed auto-link LinkMutations (deterministic)
- [ ] OPEN
**Kind:** build · **Spec:** §6 (KN-11) · **Depends:** 13.8a, P4 (KnowledgeWriter applyLink) · **Blocks:** 13.8c
**Files:** packages/knowledge/src/synthesis/link-healer.ts (NEW) · test/link-healer.test.ts
The governed port of osb's heal_links.py: given a note's Title→slug references, emit corrective `LinkMutation{op:'add',srcPath,dstSlug}` ONLY on a faithful/unambiguous slug match (fold em/en dashes; do NOT flatten spaces↔hyphens; a lossy `C++`→`c`, fuzzy, or 2+-candidate match is withheld to a proposed clarification, never auto-healed). Backlinks are NOT authored — derived read-only via GBrain `get_backlinks` (KN-11). PURE, deterministic, never-throws; every emitted mutation flows through the KMP → KnowledgeWriter (never a direct write). **Done-when:** a faithful Title→kebab link heals via a LinkMutation, an ambiguous one is withheld, and no backlink section is ever authored.

### 13.8c — Confined synthesis planner (SENSE→REASON→EFFECT → KnowledgeMutationPlan)
- [ ] OPEN
**Kind:** build + eval-tested · **Spec:** §6 (KN-10), REQ-F-017 · **Depends:** 13.8a, 13.8b, 13.3, P5 (ModelProviderPort + egress veto), P4 (KnowledgeWriter) · **Blocks:** 13.8e, 13.14
**Files:** packages/knowledge/src/synthesis/planner.ts (NEW) · test/planner.test.ts · packages/evals/src/synthesis/ (NEW)
The confined planner: SENSE (EntityResolver over a workspace-scoped GBrain read) → REASON (a `ModelProviderPort` call over ServingGate-filtered, egress-veto'd context — employer-work ack-OFF ⇒ local model or fail closed) → EFFECT (every change a region-bounded `NotePatch` into a `@generated`/`kw:region`, `FrontmatterPatch`, or `LinkMutation` in ONE `KnowledgeMutationPlan`). No-inference (REQ-F-017): owner/date without evidence ⇒ TBD. TIER: additive/derived (new synthesis note, links, backlinks) → `requiresApproval:false` AUTO; a human-relevant claim edit (contradiction reconcile, status flip, entity merge) → `requiresApproval:true` PROPOSE. The `@user`-region confinement primitive (13.7b) is provably never overwritten. Deterministic assembly TDD; the model REASON leg eval-tested (packages/evals). **Done-when:** the planner emits a valid KMP, additive writes carry requiresApproval:false + human-relevant edits true, and a `@user` region is provably untouched.

### 13.8d — Living-vault ingest rewrite + structural-file parity (index/log)
- [ ] OPEN
**Kind:** build · **Spec:** §6 (KN-10/KN-12), REQ-F-021 · **Depends:** 13.8c, P4, P7 (ingestionTriage) · **Blocks:** 13.8e
**Files:** packages/knowledge/src/synthesis/ingest-rewrite.ts (NEW) · packages/knowledge/src/markdown-vault/structural-files.ts (NEW) · tests
Wire the planner into the ingestion path ("the vault rewrites itself" on ingest) by EXTENDING the existing producer — `runSourceIngestion` (`packages/workflows/src/workflows/sourceIngestion.ts:308`) step 6 `SourceBuildOutputsPort.build` today derives a SINGLE-note KMP; the living-vault rewrite makes it multi-entity: for each ingested source, resolve entities (13.8a) → plan updates (13.8c) → KnowledgeWriter. Structural-file parity (KN-12): index.md (regenerate changed `- [[Note]] - desc` sections) + append-only op-log (log.md pointer + Logs/YYYY-MM-DD.md) written as vault-surface writes through KnowledgeWriter (preamble-exempt). One digest receipt per run + one-action batch-undo (revert the run's KW revisions). **Done-when:** an ingest updates ≥1 existing related note (not just creates), index.md/log parity holds, and the run is batch-undoable.

### 13.8e — Scheduled living-vault synthesis activity (dormant; arms via §19.13)
- [ ] OWNER-GATED ⛔ Owner-Gates §ARM-RESEARCH
**Kind:** build · **Spec:** §6 (KN-10), §9 (schedule/LIFE-2) · **Depends:** 13.8c, 13.8d, P7 · **Blocks:** —
**Files:** apps/worker/src/temporal/ (livingVaultSynthesis activity + registration) · reuses §19.12 scheduled bundle
The scheduled analog of osb's /obsidian-synthesize: a Temporal-scheduled synthesis pass (cross-source patterns, entity convergence, orphan rescue → missing links) with LIFE-2 catch-up collapse, registered into the §19.12 bundle behind a default-OFF strict-`=== true` arming flag. Additive writes AUTO, human-relevant edits PROPOSE; digest + undo. Ships DORMANT — no schedule until §19.13 arming. **Done-when:** the activity + registration exist behind an OFF flag, a milestone test proves an armed run auto-applies additive + proposes human-relevant, and default boot registers no schedule.
```

**(ii) NEW Phase 13 tasks — the research provider (build dormant):**

```
### 13.13 — Research/Web-Retrieval provider (RES-1) — emit-only, dormant
- [ ] OPEN
**Kind:** build · **Spec:** §7 (RES-1), §5 (egress veto) · **Depends:** 13.1, P5 (ModelProviderPort + egress veto), P3 (EgressPolicy) · **Blocks:** 13.14
**Files:** packages/providers/src/model-provider/research-provider.ts (NEW) · packages/integrations/src/connectors/adapters/free-source-aggregator.ts (NEW) · tests
An egress-classed `ModelProviderPort` processor for cloud web-retrieval with citations: Perplexity Sonar (`sonar-pro`/`sonar-reasoning-pro`, OpenAI-compatible /chat/completions) + Grok Live Search (xAI /v1/responses, `x_search` tool) over an INJECTED faked transport (real HTTP = arming injection point, dormant, LESSON 11 pattern), plus a free key-less source aggregator. Every call is egress-classed cloud ⇒ the broker egress veto runs FIRST (employer-work ack-OFF ⇒ fail closed, NO cloud fallback — safety rule 5; the query text is employer-content-bearing so key-less sources gate identically). Output is candidate data (citations preserved verbatim); the provider NEVER writes Markdown. TOTAL never-throws over the untrusted transport. Conformance-gated (§12). **Done-when:** the provider returns candidate dossiers over a faked transport, an employer-work ack-OFF call fails closed (egress-leakage eval), and no path reaches a real endpoint or the write surface.

### 13.14 — /research + /research-deep governed flows (candidate → KW) — dormant
- [ ] OPEN
**Kind:** build + eval-tested · **Spec:** §7 (RES-2), §6, §5, REQ-F-017 · **Depends:** 13.13, 13.8a (EntityResolver), 13.8c (planner), P4 (KnowledgeWriter), P7 (workflow) · **Blocks:** §19.13
**Files:** packages/workflows/src/workflows/researchDeep.ts (NEW) · packages/knowledge/src/synthesis/research-propagation.ts (NEW) · packages/evals/src/research/ (NEW) · tests
/research = one RES-1 dossier → candidate gate → `KnowledgeMutationPlan` (a `Research/Web` note create) → KnowledgeWriter. /research-deep = vault-first 5-phase: (1) local/zero-egress GBrain baseline scan; (2) gap-analysis RES-1 call → 3-5 `web`/`x` queries; (3) gap-fill (Perplexity web + Grok x); (4) synthesis delta; (5) PROPAGATION — "Recommended Vault Updates" become candidate mutations fed into the 13.8c planner, each entity-grounded via 13.8a (a synthesis-named path is resolved-or-stubbed, NEVER fabricated — the governed form of osb's ground-before-write rule), landing propose-only-or-auto per the KN-10 tier. Phase 1 zero-egress; phases 2-4 egress-gated. Deterministic pipeline/routing TDD; the model synthesis legs eval-tested. Dormant over faked RES-1. **Done-when:** /research produces a candidate KW note, /research-deep scans→gaps→synthesizes→propagates over faked transports, a synthesis-named non-existent path never fabricates a file, and an employer-work ack-OFF run fails closed.
```

**(iii) `IMPLEMENTATION_PLAN.md` §ARM ledger — new entry (into "Owner gates & arming ledgers"):**

```
### §ARM-RESEARCH — research-provider go-live + living-vault scheduling (Phase 26; crossing 8, INDEPENDENT arc)

Posture: NOT part of the sequential (1)-(6) chain; gated only on Phase 17 (Keychain, §19.4); ~1 owner-confirmed round. Two standing hard lines cross here — real external fetch AND paid-API-key provisioning (Perplexity + xAI). Steps, IN ORDER: (1) provision `providers/perplexity` + `providers/xai` paid keys into macOS Keychain (`security add-generic-password`) via §19.4's ref convention; (2) CONFIRM the real Perplexity `/chat/completions` + xAI `/v1/responses` wire shapes against a live call, then bind the real `createPerplexityTransport`/`createGrokLiveSearchTransport` (dormant → real) behind the SecretsAccessor; (3) add the research processor to `SOW_EGRESS_ALLOWED_PROCESSORS` (each vendor its OWN processor id — perplexity/xai NEVER an alias, safety rule 5) — employer-work ack-OFF STILL fails closed by construction; (4) flip the default-OFF strict-`=== true` research arm; (5) register + schedule `livingVaultSynthesis` into the §19.12 bundle behind its own OFF flag. Even armed: research findings + synthesis land as `KnowledgeMutationPlan` → KnowledgeWriter (human-relevant edits PROPOSE); rollback = 1 flag. Arming-era residuals: confirm the real citation/wire shape at the binding (documented candidate, arch_gap); ING-7 read-only on retrieved web/X content; the query-text-carries-employer-content gate re-verified on the live endpoint.
```

**(iv) Phase-status / mapping-table rows** (orchestrator adds a `Phase 26` row to the at-a-glance table + a §19.13 row mirroring the §19.12 style — build-dormant in Phase 13 (13.13/13.14/13.8a-e), arm in Phase 26/§19.13).

---

## PART 4 — What's genuinely NEW vs already-partially-built (orchestrator map)

| Capability | Status in SoW today | Action |
|---|---|---|
| `KnowledgeMutationPlan` + `LinkMutation`/`NotePatch`/`FrontmatterPatch` primitives | **BUILT** (`shared-shapes.ts`, `writer.ts applyLink`) | **REUSE** — the exact governed substrate for behaviors 1 & 2 |
| No-inference validator (REQ-F-017) | **BUILT** (task 1.11) | **REUSE** — the governed anti-fabrication gate |
| `@user`/`@generated` region confinement | **BUILT** (task 13.7b, LESSON 14) | **REUSE** — makes AUTO-tier synthesis safe |
| §13.8 living-vault synthesis | **DESIGNED, OPEN** (one task, no code) | **EXPAND** → 13.8a-e (EntityResolver, LinkHealer, planner, ingest-rewrite+structural parity, scheduled activity) |
| `EntityResolver` (source entity → canonical path) | **ABSENT** | **CREATE** (13.8a) — the load-bearing gap for "vault rewrites itself" |
| `LinkHealer` (heal_links.py port) | **ABSENT** (link_graph named in 13.3, not built) | **CREATE** (13.8b) |
| Backlink derivation | **BUILT** (GBrain `get_backlinks`, KN-2) | **REUSE** — backlinks derived, never authored (matches OSB) |
| index.md / log.md / Logs/ parity | **ABSENT** | **CREATE** (13.8d / KN-12) |
| OSB source extractors (youtube/podcast/web/file) | **BUILT dormant** (13.2; arms §ARM-23) | **REUSE** — feed the ingest-rewrite path |
| Research provider (Perplexity/Grok) | **ABSENT** — no web-retrieval provider; ModelProviderPort has Claude/OpenAI/OpenRouter/Ollama/LM Studio only | **CREATE** (13.13 / RES-1) — the one wholly-new subsystem |
| `/research` + `/research-deep` flows | **ABSENT** (13.2 `web-source.ts` is an emit-only *extractor*, not the research pipeline) | **CREATE** (13.14 / RES-2) |
| Egress-veto processor allowlist seam | **BUILT** (`SOW_EGRESS_ALLOWED_PROCESSORS`, task 18.31) | **REUSE + EXTEND** — add perplexity/xai processor ids |
| Scheduled output-workflow bundle + LIFE-2 | **BUILT** (§19.12 / Phase 25) | **EXTEND** — register `livingVaultSynthesis` + `researchDeep` |
| Owner-gated cloud-egress + paid-key arming | **PATTERN BUILT** (§ARM-18/§ARM-23) | **CREATE** §ARM-RESEARCH (crossing 8) following the pattern |

**One-line summary of the shape:** behaviors 1 & 2 are an **expansion of the already-designed §13.8** onto already-built primitives (KMP/LinkMutation/NotePatch/no-inference/@user-confinement) + two new deterministic pieces (`EntityResolver`, `LinkHealer`) + structural-file parity; behavior 3 is the **one genuinely-new subsystem** — a governed egress-classed research provider (RES-1/RES-2) whose findings are candidate-data-in / KnowledgeWriter-out, armed behind a new owner-gated cloud-egress + paid-key crossing (§19.13 / §ARM-RESEARCH, crossing 8).
