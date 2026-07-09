# Session 050 — §13.10a live-wiring step 1: concrete `readNoteProjectId` (frontmatter codec + create-clobber existence probe)

**Date:** 2026-07-08 · **Operator:** solo (worker + knowledge tracks, full workflow) · **HEAD at start:** `4184a5f` · **HEAD at end:** `459553f`

## Goal
Build the first of the three remaining §13.10a live-wiring steps (per handoff `sow-kmp-bridge-finish` + `docs/team-handoffs/002-…`): the CONCRETE `readNoteProjectId` the on-approval semantic executor injects — read a note's frontmatter `projectId`, UNESCAPED via the inverse of the KnowledgeWriter's `serializeScalar` (gate 1-C left it a documented dormant port). The bridge stays DORMANT; nothing wired to a live model.

## What shipped (TDD; adversarially reviewed; repo-wide 31/31 after each cross-package change)

### Knowledge — frontmatter codec · `dc5b0a9` (frontmatter suite +10; knowledge 367)
`packages/knowledge/src/knowledge-writer/frontmatter.ts` (NEW): extracted the on-disk frontmatter format codec (`serializeScalar`, `parseNote`, `composeNote`, quoting helpers) OUT of `writer.ts` into one module so the forward serializer and its inverse cannot drift; `writer.ts` now imports them (region/link projection stays in the writer; move is behavior-preserving — existing writer tests green). Added:
- **`deserializeScalar`** — the exact inverse of `serializeScalar` over its string range. Round-trip property `deserializeScalar(serializeScalar(v)) === v` pinned by test; the reviewer fuzzed 65K BMP code points + 300K random strings → **zero** round-trip failures.
- **`readFrontmatterField(content, key)`** — parse ∘ deserialize; the deterministic core of gate 1's reader. Normalizes an UNTRUSTED note (strip leading BOM, fold CRLF/CR→LF, tolerate an EOF close-fence) BEFORE `parseNote`; the writer's own `parseNote` is left byte-exact so its read→re-emit round-trip is untouched (normalization is reader-only).
- Barrel-exports `serializeScalar` / `deserializeScalar` / `readFrontmatterField`.

### Worker — concrete reader + create-clobber existence probe · `459553f` (worker 863)
- `apps/worker/src/api/adapters/noteProjectIdReader.ts` (NEW): `createNoteProjectIdReader(readNote)` → the executor's `NoteProjectIdReader` port (reads the frontmatter `projectId` UNESCAPED) + `createNoteExistsProbe(readNote)` → the new `NoteExistsProbe`. Both WS-8-scoped over an injected `WorkspaceNoteRead`; read faults fold to a redaction-safe `FailureVariant` (only a bounded cause code crosses); never throw.
- `apps/worker/src/api/procedures/semanticMutationDispatch.ts`: added the `NoteExistsProbe` port + `noteExists` dep; the gate-1 CREATE guard now keys on **REAL note existence**, not `projectId` presence.

## Adversarial review (general-purpose Agent, security + code-quality) — 2 passes
- **Pass 1:** codec inverse + redaction **CLEAN** (fuzzed). One real **MEDIUM**: the executor's CREATE-clobber guard used `readNoteProjectId`'s `undefined` as an existence proxy → an existing note lacking/mis-framing `projectId` (or CRLF/BOM/EOF-framed) read as "free" → `renderCreate` would silently OVERWRITE it (a data-loss false-accept on the exact path gate 1 protects). Plus 2 LOWs (reader `parseNote` framing brittleness; `readFrontmatterField` call outside the adapter try/catch).
- **Fix (this session, not deferred):** added the dedicated `NoteExistsProbe` (real existence, framing-independent by construction — it never parses frontmatter); made `readFrontmatterField` tolerant of CRLF/BOM/EOF framing (reader-only); hardened both adapters to run the extract inside try + fail closed on a non-string read (never report "free" on ambiguity).
- **Pass 2 (narrow re-review): SHIP.** MEDIUM closed with correct fail-closed semantics; no new false-accept/false-reject; the empty-but-present-file → reject is the safe direction; normalization can't cause a PATCH false-accept (writer escapes CR/LF inside values; BOM strip only touches the note's first char = the fence); redaction + never-throws intact. 49/49 across the three affected test files.

## G4 wiring reminder (carry to live wiring)
The runner (G4) must build BOTH `createNoteProjectIdReader` and `createNoteExistsProbe` from the SAME WS-8-scoped `WorkspaceNoteRead` and inject both into the executor deps — `noteExists` is a required field, so TS strict flags an omission at the composition site.

## State at close
§13.10a bridge still **DORMANT**. Live-wiring **step 1 of 3 DONE** (`dc5b0a9` + `459553f`, pushed at close-out). Remaining: **G3** (providers SDK-MCP adapter `createCopilotProposeKnowledgeMcpServer`) → **G4** (runner + boot flag `copilotProposeKnowledge`, OFF; wires derive→sink→executor→dispatch, injecting the two adapters above) → **gate 4** (C5.4b serving oracle, eval-security arc). See `sow-kmp-bridge-finish` / `docs/team-handoffs/002-…`.

## Method notes carried
- Reviewer subagents gone → **general-purpose Agent** with security+code-quality prompts (two passes: find, then verify the fix). Per-file `git add`; never staged `.claude/settings.json` / root `CLAUDE.md` / `graphify-out/`. `graphify update .` after code changes.
- The reader normalizes UNTRUSTED framing but the writer's `parseNote` stays byte-exact — normalization that changed the shared parser would risk the writer's round-trip.

## Addendum — G3 SDK-MCP adapter (same session) · `8f45943`
Built the next live-wiring step: `packages/providers/src/runtime/copilot-propose-knowledge-mcp.ts` — `createCopilotProposeKnowledgeMcpServer(handler)`, the Claude Agent SDK in-process MCP registration exposing `mcp__copilot__propose_knowledge`. A thin mirror of `copilot-propose-mcp` (propose_action): zod raw shape = model-facing ergonomics (NOT the gate), delegates to an INJECTED structural handler (args-as-`unknown`, providers ↛ worker; G4 supplies the closure). Reuses the shared `COPILOT_MCP_SERVER_NAME` ("copilot") so the tool id reconciles to the G2 catalog id `copilot.propose_knowledge`; distinct export names avoid a barrel `export *` collision. Providers 293 green; repo-wide 31/31.
- **Adversarial review (general-purpose Agent): SHIP.** Traced the tool-id ↔ catalog-id correspondence end-to-end (`copilotToolToMcpName` splits on the first dot → `mcp__copilot__propose_knowledge`; catalog id `copilot.propose_knowledge`, mutating:true; ING-7 recognizes it) — the load-bearing claim is SOUND, no containment hole.
- **Folded a MEDIUM (doc/test fidelity):** the SDK's own `z.object(shape)` parse strips unknown keys BEFORE the handler, so the earlier "smuggled key reaches the worker unmodified" story was inaccurate; containment actually rests on the SERVER-DERIVED path/workspace (+ non-coercing `z.string()`). Header + the transparency test corrected. ⚠ **The shipped mirror `copilot-propose-mcp.ts` carries the SAME header imprecision — follow-up (out of G3 scope).**
- **LOW carried to G4:** both propose servers are named "copilot" — if G4 ever co-registers both in one `mcpServers` map, one silently overwrites the other. The decoupled grant means they never co-register today (convention, not structurally enforced). **G4 recommendation:** if both propose tools are ever wanted together, compose them as two `tools` in ONE `createSdkMcpServer({name:"copilot", tools:[…]})`, and assert the map never gets two servers under one key.

### State at close (updated)
Live-wiring **steps 1 + G3 DONE**. Remaining: **G4** (runner + boot flag `copilotProposeKnowledge`, OFF) → **gate 4** (C5.4b serving oracle, eval-security arc). HEAD `8f45943`.
