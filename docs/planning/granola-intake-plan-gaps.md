# Granola Intake — Vision-vs-Plan Gap Analysis + Drafted Plan Additions

> **Scope.** Rigorous gap analysis of the *full* "Granola experience" the owner wants —
> *automatically pull new Granola transcripts → process → know which PROJECT → know which PEOPLE →
> relate to OTHER NOTES → create/UPDATE the appropriate vault files (person pages, project pages,
> index/log)* — against the CURRENT SoW plan (`IMPLEMENTATION_PLAN.md` + `ARCHITECTURE.md`).
> **Deliverable:** for each pipeline stage, its plan home OR a drafted task for a genuine gap
> (neither built nor planned). **Non-canonical** — the orchestrator integrates; this file edits
> nothing in `ARCHITECTURE.md` / `IMPLEMENTATION_PLAN.md`.
>
> **Method.** graphify + codegraph orientation → first-hand reads of the meeting-closeout producer
> (`buildOutputs.ts`), correlation (`correlateMeeting.ts`), the Granola connector, the 13.8a–e task
> text, ARCH §6 (KN-10/11/12) / §9 workflow-1 / §19.2/§19.3/§19.5/§19.10, and the §ARM-23 ledger,
> corroborated by a dedicated read-only code survey. Claims are anchored file:line / task-id.

---

## 1. Coverage table — each Granola pipeline stage → plan home or GAP

| # | Stage | What the owner wants | Built? | Current plan home | Verdict |
|--:|---|---|---|---|---|
| 1 | **PULL** (poll Granola for new notes) | auto-detect new transcripts on a cadence | dormant | **§ARM-23** — 23.1 bind `HttpTransport.send`, 23.2 credential/`tokenRef`, 23.7 wire-shape verify; poll engine 16.2 (`connectorPoll` + schedule) | ✅ HOME |
| 2 | **TRANSCRIPT-TEXT hydration** (metadata → body) | fetch the transcript body, not just `{id,title,owner,…}` | **not built** — `granola.ts:29-45` is `GET /v1/notes` metadata-only | **task 23.4** (Granola transcript/body second-hop `list→get`, → routed to the meeting dispatcher) — OPEN | ✅ HOME |
| 3 | **INGEST / dispatch** (record → meeting workflow) | route a completed-meeting record to the meeting machinery | dormant | 15.1 `connectorIngestionBridge` (`binding.kind:"meeting"` discriminator) + 15.9 `dispatchMeetingCloseout` | ✅ HOME |
| 4 | **EXTRACT** (transcript → structured fields) | pull owner/dates/decisions/action-items with evidence, no inference | built; live arming deferred | 7.6 meeting-closeout + 18.3/18.4 real extraction legs; live `meeting.close` arming = **§ARM-18 Finding-F** | ✅ HOME |
| 5 | **ROUTE-TO-PROJECT** (correlate → ws/project) | know which project; park when unsure | dormant; parks-when-unsure built | 18.5 `resolveSignals` + 18.6 content→project resolver + 14.6 registry; routing-quality eval = **§ARM-18** | ✅ HOME |
| 6 | **RESOLVE-PEOPLE** (attendees → person entities → person note paths) | know which people were in the meeting; map each to their person page | **absent** | 13.8a EntityResolver (generic person/project/concept resolver) is planned — but **no task extracts attendees or wires people into the meeting path**; no `personNotePath` exists (`noteSlug.ts` has only `projectNotePath`/`meetingNotePath`) | ⚠ **GAP-2** |
| 7 | **RELATE-TO-NOTES / auto-link** | link the meeting to related people/projects/concepts | not built (`synthesis/` dir absent) | 13.8b LinkHealer + 13.8c planner (OPEN) — **but wired only into the SOURCE path** (13.8d), not the meeting path | ⚠ **GAP-1** |
| 8 | **CREATE source/meeting note** | write the meeting note | **LIVE** | 7.6 / `buildOutputs.ts` (single `NoteCreate`/`NotePatch` + task proposals) | ✅ HOME |
| 9 | **UPDATE existing files** (person / project pages, index/log) | the vault rewrites itself around the new meeting | not built | 13.8d living-vault ingest rewrite + KN-12 index/log parity — **`runSourceIngestion` only**; the meeting producer is out of scope | ⚠ **GAP-1** (person/project/index/log on the meeting path) |
| 10 | **Scheduled autonomous synthesis** | periodic cross-source convergence | not built | 13.8e + **§ARM-RESEARCH** / Phase 26 (22.x arm) | ✅ HOME (owner-gated) |

**Verdict:** stages 1–5, 8, 10 have explicit homes. The genuine gaps cluster entirely on **one structural
fact**: the living-vault multi-entity synthesis engine (13.8) is framed around the **local file-watcher /
source-ingestion path only**, and the **Granola meeting flows through a *different* producer** that no task
extends — plus the **attendee→person** step that no task covers at all.

---

## 2. The load-bearing finding (why GAP-1/GAP-2 are real, not paper)

The two ingestion paths are **separate workflows that never converge** (code survey, first-hand):

- **Source path:** `runSourceIngestion` (`sourceIngestion.ts:308`) → `SourceBuildOutputsPort.build` → single note.
- **Meeting path (Granola):** `meetingCloseoutWorkflow` → `correlateMeeting` → `meeting.close` AgentJob →
  `validateCloseout` → **`buildOutputs.build`** (`activities/buildOutputs.ts:157-254`) → single note.

**13.8d's exact text names only the source producer** — *"EXTENDING the existing producer —
`runSourceIngestion` (`sourceIngestion.ts:308`) step 6 `SourceBuildOutputsPort.build` … makes it
multi-entity"* (`IMPLEMENTATION_PLAN.md:1462`). It does **not** name `buildOutputs.ts` / `BuildOutputsPort`
(the meeting producer). Granola transcripts route to the **meeting** dispatcher, not the source path
(15.9; 23.4 acceptance: *"Granola yields transcript text routed to the meeting dispatcher (15.9) not the
generic source path"*, `IMPLEMENTATION_PLAN.md:2235`). **⇒ Even with 13.8a–e fully built and Granola
armed, a pulled transcript produces exactly one meeting note + task proposals — no person page, no project
page, no auto-links.**

Direct proof from the production meeting producer (`buildOutputs.ts:232-250`): the derived
`KnowledgeMutationPlan` hardcodes **`linkMutations: []`** and **`frontmatterUpdates: []`**, and
`creates`/`patches` carry exactly the **one** meeting note. It never calls an EntityResolver (none exists;
`packages/knowledge/src/synthesis/` is absent).

Attendee proof (`correlateMeeting.ts` + projection): `CorrelationSignals` (`correlateMeeting.ts:33-39`)
carries `confidence`/`workspaceId?`/`projectId?`/`reason?` — **no attendee field**; correlation only
routes. Attendees surface **only** as plain strings rendered into the meeting-note body (`## Attendees`,
`meetingOutputs.ts:157,169-170`) — never parsed into people, never resolved, never written to a person
page. Whole-repo grep for `personNote`/`resolvePerson`/`peoplePage` = **0 non-test hits**. ARCH **§9
workflow-1 already specifies** the fan-out (*"KnowledgeWriter (meeting/project/**person**/decision/daily/
source)"*, `ARCHITECTURE.md:297`) — so the gap is an **unimplemented spec**, not a missing decision.

---

## 3. Drafted plan additions (genuine gaps only)

> Format mirrors the plan's task blocks. **No frozen-contract round** is required for either build task:
> attendees ride the already-open `AgentExtractionCandidate.fields` map (generic `Record<name,{value,
> evidenceRef?}>`, `sow:agent-extraction`), and person notes are ordinary `NoteCreate` paths. Both build
> **dormant/TDD** (deterministic legs) with the model leg eval-tested — no hard line for the build; live
> arming rides existing ledgers.

### 13.8f — Meeting-path living-vault rewrite (multi-entity synthesis on the meeting-closeout producer)  ⟵ GAP-1

**State:** OPEN (new) · **Kind:** build · **Spec:** §6 (KN-10/KN-11/KN-12), §9 (workflow-1 person/project fan-out), REQ-F-021 · **Depends:** 13.8a (EntityResolver), 13.8b (LinkHealer), 13.8c (planner), 13.8d (reuses `ingest-rewrite.ts` + `structural-files.ts`), 7.6 (meeting closeout) · **Blocks:** — (the Granola flagship; pairs with 13.8g)
**Cross-doc invariant:** none new — **implements** the already-revised §6 KN-10 stance + the already-written §9 workflow-1 KnowledgeWriter fan-out (`meeting/project/person/decision/daily/source`). No Appendix-A / schema-snapshot edit.
**Files:** `packages/workflows/src/activities/buildOutputs.ts` (extended: after the single meeting `NoteCreate`, run the 13.8c planner over the validated extraction to emit per-entity `NotePatch`/`FrontmatterPatch`/`LinkMutation` into ONE KMP) · `packages/knowledge/src/synthesis/meeting-rewrite.ts` (NEW; the meeting analog of 13.8d `ingest-rewrite.ts`, sharing its structural-file + digest/undo machinery) · tests.
The meeting closeout today derives a SINGLE-note KMP with `linkMutations:[]`/`frontmatterUpdates:[]`
hardcoded (`buildOutputs.ts:232-250`). This extends it, for each closed meeting, to: resolve the meeting's
referenced entities (attendees via 13.8g, plus the correlation-bound project + concepts named in the
transcript) via the 13.8a EntityResolver → plan per-entity updates via 13.8c → emit them, the meeting note,
and KN-12 index/log parity in ONE `KnowledgeMutationPlan` → KnowledgeWriter. **Tier (KN-10):** additive/
derived writes (new links, backlink-derivation, `@generated`-region refreshes on person/project pages)
AUTO; a human-relevant claim edit (status flip, entity merge) PROPOSES. `@user` regions provably untouched
(13.7b). One digest receipt + one-action batch-undo per run. Deterministic assembly TDD; the model REASON
leg eval-tested (`packages/evals`).
**Owner-gate/§ARM:** build is dormant (no crossing). Live auto-apply on **real** meetings arms with the
`meeting.close` live path (**§ARM-18 Finding-F**); the scheduled variant rides 13.8e / **§ARM-RESEARCH**.
**Done-when:** a closed meeting updates ≥1 existing related note (person/project) in addition to creating the
meeting note; auto-links emit via `LinkMutation`; index.md/log parity holds; a `@user` region is provably
never overwritten; the run is batch-undoable; and byte-equivalence with today holds when the planner
resolves zero entities (fail-closed — never a fabricated path).

### 13.8g — Attendee/participant extraction → person-entity resolution → person-page updates  ⟵ GAP-2

**State:** OPEN (new) · **Kind:** build + eval-tested · **Spec:** §6 (KN-10 EntityResolver, KN-11 links), §9 (workflow-1 attendee correlation + person write), REQ-F-017 (no invented attendees) · **Depends:** 13.8a (EntityResolver), 13.8f (meeting-path synthesis it feeds), 18.4 (meeting extraction leg) · **Blocks:** —
**Cross-doc invariant:** none new — attendees ride the open `AgentExtractionCandidate.fields` map (no schema-snapshot edit); a `personNotePath` is an ordinary vault path, not a frozen model.
**Files:** `packages/providers/src/model/extraction-request.ts` (`MEETING_EXTRACTION_PROMPT` extended to elicit attendees, each with a verbatim `evidenceRef`; unstated ⇒ omit, never invent — REQ-F-017) · `packages/knowledge/src/synthesis/attendee-resolver.ts` (NEW; a deterministic mapper: validated attendee fields → person-entity references → 13.8a EntityResolver → resolved person-note path OR create-stub) · `packages/workflows/src/activities/projections/noteSlug.ts` (NEW `personNotePath(workspaceId, name)` — WS-8 workspace-rooted, `safeNoteSlug`, mirrors `projectNotePath`) · tests + `packages/evals/src/synthesis/` (attendee-extraction eval).
Attendees are captured today only as free strings in the note body and dropped (`meetingOutputs.ts:157,
169-170`); `CorrelationSignals` has no attendee field. This adds the "know which PEOPLE" leg: the model
extracts attendee names as evidence-backed extraction fields (REQ-F-017 — an unsupported/inferred attendee
is `TBD`/omitted, HARD-rejected at `validateCloseout`, never invented); a deterministic resolver maps each
to an EXISTING person note via 13.8a (workspace-scoped GBrain read, WS-8 — never a cross-brain query, safety
rule 4) or a governed create-stub; 13.8f then updates/creates each person page (a `## Meetings` /
`@generated` region backlink to the meeting, attribution-stamped) and emits the `LinkMutation`s. Ambiguous
(2+) or lossy attendee matches are withheld to a proposed clarification, never a fabricated person page.
**Owner-gate/§ARM:** build dormant; live person writes arm with §ARM-18 (meeting live). No paid-key / real-egress crossing beyond the existing subscription-extraction one.
**Done-when:** a meeting with named attendees resolves each to their real person note (or a governed stub) and adds a meeting backlink to each person page; an ambiguous attendee is withheld (not fabricated); an inferred/unsupported attendee is `TBD`, never invented; a WS-8 test proves an attendee never resolves across workspaces.

### 23.8 — Granola flagship SPINE end-to-end verification (PULL → hydrate → closeout → multi-entity synthesis)  ⟵ GAP-3

**State:** OPEN (new) · **Kind:** verify (e2e + eval) · **Spec:** §19.2/§19.3/§19.10 (spine), §9 (workflow-1), §6 (KN-10) · **Depends:** 23.4 (hydration), 15.9 (dispatch), 13.8f, 13.8g · **Blocks:** —
**Cross-doc invariant:** none — a verification/acceptance task, not a producer.
**Files:** `apps/worker/test/integration/granola-spine-e2e.test.ts` (NEW; fake Granola record → hydrate → `dispatchMeetingCloseout` → correlate → `meeting.close` → validate → **multi-entity** buildOutputs → KnowledgeWriter, over a real local Temporal worker, fakes only) · `packages/evals/src/synthesis/granola-meeting.*` (routing + attendee-resolution quality).
The SPINE arc (Carry-forward #1) names *"connector→ingestion→content→gbrain end-to-end … Includes 13.10c
gmail-source content hydration"* (`IMPLEMENTATION_PLAN.md:75`) — it **under-specifies Granola**: it names
neither Granola transcript hydration (23.4) nor the meeting-synthesis fan-out (13.8f/g). This task is the
single integrating flagship that sequences and proves the whole Granola experience the owner asked for.
**Owner-gate/§ARM:** none for the fakes-only e2e; the live vendor run rides §ARM-23 (Granola crossing).
**Done-when:** the fakes-only e2e drives a Granola meeting all the way to a committed meeting note **plus**
≥1 person-page update **plus** the correlation-bound project-page update **plus** auto-links + index/log
parity, idempotent on replay (no duplicate write); the routing/attendee evals pass their recorded bars.

### Carry-forward #1 amendment (orchestrator to apply)

Amend the SPINE-arc bullet to name the Granola meeting flow explicitly, e.g. append: *"— for Granola the
spine is PULL (§ARM-23 23.1/23.2/23.4/23.7) → dispatch (15.9) → meeting closeout → **multi-entity
living-vault synthesis (13.8f + 13.8g)**, verified by 23.8; not only the gmail-source hydration."*

---

## 4. Is the full Granola vision fully planned once these land?

**YES — with 13.8f + 13.8g + 23.8 added, every stage of the owner's Granola vision has an explicit plan
home.** The pre-existing 13.8a–e decomposition already covers the *engine* primitives (EntityResolver,
LinkHealer, planner, ingest-rewrite, scheduled synthesis) and the source path; these three additions close
the **connector→synthesis integration** on the **meeting** path and the **attendee→person** leg — the exact
pieces the auto-ingest-framed 13.8 tasks and the source-only 13.8d do **not** reach.

**What remains buildable (no owner gate):** 13.8a–d, 13.8f, 13.8g, 23.8 — all deterministic/dormant TDD +
eval legs; build freely to completion.

**What stays owner-gated (unchanged by this proposal):**
- **PULL / hydration / wire-verify** — §ARM-23 (real Granola network I/O + `grn_` key), crossing 7.
- **Live `meeting.close` extraction + live person/project auto-writes on real meetings** — §ARM-18
  (Finding-F meeting live arming) + the subscription-extraction crossing (already sealed for source).
- **Scheduled autonomous synthesis (13.8e)** — §ARM-RESEARCH / Phase 26.
- **Auto-apply tier** — additive AUTO / human-relevant PROPOSE is a KN-10 default; even armed, human-relevant
  edits land as PENDING §9 Approvals (rollback = 1 flag).

**Honest caveat:** 13.8a, 13.8b, 13.8c, 13.8d themselves are still OPEN (unbuilt) — so 13.8f/13.8g inherit a
real dependency chain; they are the *last two rungs* of the living-vault ladder, not standalone. The gap this
analysis closes is that, as the plan stood, **those rungs terminated at the source path and never reached
Granola/meetings or people at all** — now they do.
