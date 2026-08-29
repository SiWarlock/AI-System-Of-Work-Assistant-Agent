# System of Work Assistant

> **Architecture sentence:** *governed local control plane — candidate-data-in, validated-and-policed-out; Markdown is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer.*
>
> _(Optional. If the project has a single load-bearing one-line posture, put it here and echo it in `docs/orchestrator-briefing.md` + the `ARCHITECTURE.md` executive summary. If not, delete this blockquote.)_

A Mac-first, local-first, self-hosted personal operating system for employer work, side projects, and personal life — a governed local control plane over Obsidian-compatible Markdown.

## Project structure

```
SoW-build/
├── .claude/
│   ├── commands/                       # Slash commands
│   └── agents/                         # Subagents (opt-in starter set + reactive additions)
├── packages/contracts/                       # shared contracts & domain code
│   ├── CLAUDE.md                       # Code-area conventions
│   └── LESSONS.md                      # Banked engineering lessons
├── docs/
│   ├── team-protocol.md                # DORMANT (team pattern) + the ARCHIVED root team-coordination section
│   ├── orchestrator-briefing.md        # DORMANT — team-mode orchestrator charter
│   ├── tdd-brief-template.md           # /tdd brief format
│   ├── scaffolding-reference.md        # Workflow reference (this project's map)
│   ├── team-handoffs/                  # DORMANT — /team-end output (team pattern only)
│   ├── briefs/                         # Numbered /tdd briefs (NNN-<task-id>-<topic>.md; <track>-NNN in multi-track)
│   ├── sessions/                       # Numbered chronological session docs (<track>-NNN in multi-track)
│   └── runbooks/                       # Operational procedures
├── CLAUDE.md                           # THIS FILE — global project conventions + shared comm rules
├── IMPLEMENTATION_PLAN.md                    # Task tracker (state + phase plan)
└── ARCHITECTURE.md                        # Architecture / design contract
```

<!-- ▼ EXAMPLE BLOCK [id=project-structure]: project structure — extend the tree with the project's real layout (extra code areas, deliverable docs, eval suites, etc.). Add one row per additional code area; remove team-handoffs/ if generated in single-operator-fallback mode. ▼ -->
```
SoW-build/
├── apps/
│   ├── desktop/      # Electron renderer/main/preload   [track: desktop]      — CLAUDE.md · LESSONS.md
│   └── worker/       # Node/TS control-plane worker      [track: worker]       — CLAUDE.md · LESSONS.md
├── packages/
│   ├── contracts/    # types · JSON Schemas · snapshots  [track: contract]     — CLAUDE.md · LESSONS.md
│   ├── domain/       # pure rules · state machines · validators   [track: contract]
│   ├── db/           # Drizzle · SQLite + Postgres        [track: worker]
│   ├── workflows/    # Temporal workflows + activities    [track: worker]
│   ├── policy/       # workspace/egress/tool/approval/matrix      [track: providers-integrations]
│   ├── providers/    # AgentRuntimePort + ModelProviderPort       [track: providers-integrations] — CLAUDE.md · LESSONS.md
│   ├── integrations/ # Connector + Tool Gateways          [track: providers-integrations]
│   ├── knowledge/    # KnowledgeWriter · GBrain · GCL     [track: knowledge]    — CLAUDE.md · LESSONS.md
│   └── evals/        # EVAL-1 · conformance · leakage     [track: eval-security]— CLAUDE.md · LESSONS.md
├── docs/  tdd-brief-template · scaffolding-reference  (team-protocol · orchestrator-briefing = DORMANT)
│          briefs/ · sessions/ · runbooks/ · team-handoffs/
├── CLAUDE.md  ·  IMPLEMENTATION_PLAN.md  ·  ARCHITECTURE.md
```
6 code areas = 6 build tracks (worktree-per-track); each track's CLAUDE.md/LESSONS.md sits at its primary dir and owns the territory listed inside.
<!-- ▲ END EXAMPLE BLOCK [id=project-structure] ▲ -->

## Tech stack

<!-- ▼ EXAMPLE BLOCK [id=tech-stack]: tech stack — replace with the project's real stack. One row per layer. Mark anything provisional and note where it gets locked. ▼ -->
| Layer | Choice |
|---|---|
| Runtime | Node 22 LTS + TypeScript 5.x (strict) |
| Monorepo / build | pnpm workspaces + Turbo |
| Frameworks | Electron + React + Vite (desktop) · Temporal TS SDK (worker) · Drizzle (db, SQLite + Postgres) · tRPC (local API) |
| Runtimes/providers | Claude Agent SDK + Hermes (AgentRuntimePort) · Claude/OpenAI/OpenRouter/Ollama/LM Studio (ModelProviderPort) |
| Schema / validation | Zod + JSON Schema (ajv) |
| Lint | ESLint |
| Static types | tsc --noEmit (strict) |
| Test runner | Vitest (+ the `packages/evals` harness for eval/conformance) |
| Secrets | macOS Keychain via SecretsPort |
<!-- ▲ END EXAMPLE BLOCK [id=tech-stack] ▲ -->

## Cross-cutting conventions

### Strict typing posture

<!-- ▼ EXAMPLE BLOCK [id=strict-typing-posture]: strict-typing posture — state the project's typing discipline. Examples: "every file declares strict types at the top; every property/parameter/return type has a native type declaration; runtime validation at boundaries via the validation library." Adapt to the language. ▼ -->
Every package is TypeScript `strict`. Every exported function declares explicit parameter + return types; no `any` on a contract surface. **Runtime validation at every boundary** via Zod + JSON Schema (ajv): provider/agent output is *candidate data* until it passes the schema gate — only validated data crosses into application services or reaches Markdown / an external system.
<!-- ▲ END EXAMPLE BLOCK [id=strict-typing-posture] ▲ -->

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>
```

**Types:** feat, fix, docs, style, refactor, perf, test, build, ci, chore.

**AI assistance trailer** on AI-assisted commits (HEREDOC for multi-line):

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

### Push posture

- Pushes go to **none configured (run `git init`; push when a remote is set)** only.
- Push only at `/orchestrate-end` round close-out; never mid-slice.

### Code intelligence & docs (external MCP tools — use when available)

If this workspace has these tools, **prefer them** — they cut tool calls and context. If not, ignore this section (no setup required, nothing breaks):

- **Code intelligence** (e.g. a CodeGraph MCP / indexed code graph): for "where is X", callers/callees, call-path traces, and impact-of-change, query it **before** falling back to `grep` + read loops; confirm a specific detail with a targeted read.
- **Library / API docs** (e.g. a Context7 MCP): when you need up-to-date library/framework docs, API references, setup/config steps, or version-correct examples, pull them from the docs MCP rather than relying on memory — **without being asked**.

#### ⛔ …and their KNOWN FAILURE MODES, which travel with the recommendation (task `### 24.87`)

**The instruction above and this block are one unit. A caveat kept somewhere else gets read as absent.**

⭐ **THE OPERATIVE ASYMMETRY, and it holds for every tool named here: _the graph is not a census._
A HIT is a LEAD. An EMPTY, or an EDGE, is a QUESTION.** Positive answers are cheap to confirm;
negative ones are the expensive direction, because *"no callers found"* closes a question with a ✅.

⛔ **NEVER conclude _"the tooling is unreliable."*** That discards instruments genuinely better than
`grep` for every positive question, and is the false-doubt failure in one sentence.

**Measured failure modes — one of each, in a single session:**

| mode | tool | what happened |
|---|---|---|
| **False negative** | `codegraph_callers` | a confident *"No callers found"* for a symbol with **two production call sites**, both callback-position. |
| **False edge** | `graphify` | emitted an `endpointsValid --calls--> revokeLink` edge **that does not exist**. |
| **Wrong-looking counts** | `grep` | `508 matches in 84 files` for a **single-file** query. ✅ **ATTRIBUTED 2026-08-28** — not a fabrication: bare `grep` resolves through a Claude shell-snapshot function to **`ugrep`**, whose summary line reads `N matches in M files`, and `rtk` (a `PreToolUse` hook) rewrites commands above the shell. See `docs/findings/instrument-anomalies-rtk.md`. |

⛔⛔ **WHAT MAKES THIS ONE FINDING RATHER THAN THREE TOOL BUGS: ALL OF THEM FAIL TOWARD _PLAUSIBLE_.**
None errors, none returns empty-looking, none looks wrong ⇒ ***a wrong answer is indistinguishable
from a right one at the point of reading.***

**A FOURTH INSTRUMENT, listed as a PEER and not as their remedy — `tsc` enumeration.** Genuinely
better than the three (an enumeration BY PROPERTY that no interception can forge), and it answers a
**narrower** question than we tend to ask of it: ⭐ **the compiler enumerates TYPE-DEPENDENT SITES
ONLY — a hardcode or a cast is invisible to it.**

**Practice that follows:**
- ⛔ **A truncated search is NEVER evidence of absence.** `rg … | head -N` output order is not
  stable; this was hit on 2026-08-28 and nearly filed as a finding. Run unbounded, or count first.
- **Positive-control every empty result** — search for something you know is there, the same way.
- Use **absolute paths** (`/usr/bin/git`, `/opt/homebrew/bin/rg`) to bypass the hook rewrite.
- **Branch on exit codes in the shell; do not parse rendered output.**
- An **instrument fact expires**: the 50-line `git log` cap no longer reproduces, and `ugrep` has
  moved 7.5.0 → 7.8.4. State the session with the measurement.

## Solo autonomous operation — the live mode

⛔ **THIS PROJECT RUNS SOLO.** One session owns every role at once: it plans, implements, reviews,
routes and commits. **The agent-teams pattern is ARCHIVED**, verbatim, at the foot of
`docs/team-protocol.md` — do not follow it, and do not treat its conventions (track prefixes,
messaging budget, `SendMessage` routing, `/context-check` tiers, orchestrator↔implementer handoffs)
as live constraints. `docs/orchestrator-briefing.md` is likewise team-mode and dormant.

⭐⭐ **THE STRUCTURAL CONSEQUENCE, AND IT IS THE REASON THE RULES BELOW EXIST — NOT A PLATITUDE.**
The team pattern got its error-correction from *separate parties*: an orchestrator reviewed the
implementer's tests, a lead re-checked the orchestrator's claims, reviewer subagents attacked the
diff. **Solo, all of those are the same context.** `contracts L68` states the consequence exactly:
***verification that flows only downward leaves a blind spot exactly the size of whoever sits at the
top of it*** — and solo, that is the whole hierarchy. ⇒ **the checks a team got for free must now be
performed deliberately, or they do not happen at all.** Everything below is that, made explicit.

### What reaches the owner

Four categories. Everything else, decide and proceed — the owner has delegated build-time design.

1. **Critical / safety design questions** — anything touching a safety rule below.
2. **Findings** — a discovered problem with material impact (spec/code contradiction, security
   issue, invariant at risk, broken premise, scope-threatening blocker).
3. **Deferment approvals** — any scope cut. Never silently drop work.
4. **Load-bearing decisions** — Option A/B/C calls shaping UX, the dev-facing API surface, or a
   load-bearing contract surface. Map options + tradeoffs via `AskUserQuestion`; do NOT pick on the
   owner's behalf.

⛔⛔ **A FLAG TOUCHING ANY OF THE SEVEN SAFETY RULES REACHES THE OWNER. ALL SEVEN. No exceptions, no
judgment call at the boundary.** *(Carried unchanged from the team-mode ruling of 2026-08-13 — it was
learned the expensive way: spawn prompts once said "rules 1/4/5/6" and there was no principled reason
that set excluded 2, 3 or 7.)*

⛔⛔ **AND ROUTE ON KIND — REACHABILITY GOVERNS DISPOSITION, NEVER ROUTING.** *"It's dormant / an
arming precondition rather than a live breach"* is a statement about **TIMING, not about KIND**. A
thing is a safety matter because of **what it is**, not **when it becomes reachable** ⇒ an item routes
on what it IS; its reachability decides what happens AFTER it arrives — fence vs fix-now, priority,
owner-gate — **never WHETHER it arrives.**

### The two checks a team gave for free — now mandatory, because nothing else performs them

⛔ **1. ADVERSARIALLY REVIEW YOUR OWN DIFF BEFORE CALLING A RUN DONE.** A long autonomous run is the
condition under which a reviewer is **most needed and least likely to exist**. Measured on
2026-08-28: two review rounds over one session's own diff produced **nine defects that typecheck
20/20 and tests 20/20 did not see** — and the code defects were **concurrency and ordering**, exactly
what a green suite is least able to observe.
⛔ **Run it against a FROZEN tree.** An earlier round was voided because commits landed into the
surface being reviewed while it read — *a measurement over a surface you are concurrently changing
measures nothing.*
⭐ **Expect most findings to be CLAIMS, not code.** Of those nine, **six were sentences**: comments
asserting coverage that did not exist. Each was written in the same round as the fix it described, by
the author who had just measured the thing — **the moment of maximum confidence is the highest-risk
moment for a durable claim.**

⛔ **2. A CORRECTION MOVES EVERY CHANNEL THAT CARRIES THE CLAIM, IN THE SAME COMMIT.** Amending a
lesson's prose and leaving its index row stale is not a partial fix — **it is worse than none**, because
two authoritative sources now disagree and neither announces it.
⭐⭐ **THE INDEX ROW IS THE ONE THAT MATTERS, AND IT IS THE ONE THAT GETS FORGOTTEN.** The prose is read
on demand; **the index loads into every session's context**, so it is the version that gets paraphrased
into new code comments. Measured 2026-08-28: `contracts L76`'s prose was correctly amended on
08-24, its index row was not, and **four days later that row's wording was copied into
`apps/worker/src/boot.ts` as current fact.** ⇒ *an amendment that reaches the prose and not the row
has not landed where the damage occurs.*
**Re-runnable census** (candidates to classify, never defects to count — `contracts L104`): for each
lesson, extract dated amendment markers from `LESSONS.md` and check the matching `CLAUDE.md` row
carries that date. ⚠ **Match the number cell as `| N |` OR `| [N](LESSONS.md#N) |`** — both forms are
in use, and a matcher that misses the second reports "this area has no index at all."
⭐ **The decidable test: a row asserting something the prose RETRACTED is a DEFECT; a row missing an
ADDITIVE amendment is INCOMPLETENESS.** Only the first fails open.

### Working rules

- **Numbered docs use the plain `NNN-…` form** (`docs/briefs/`, `docs/sessions/`) — track prefixes
  were a multi-worktree collision defense and do not apply. Next `NNN` = max + 1.
- **Finish the current slice.** Complete the `/tdd` cycle through its commit before any close-out or
  pivot; a half-landed slice is worse than a deferred one.
- **Close-out is on-demand**, not at routine work boundaries. Hot-route doc changes as they land
  rather than batching them — a tracker that is stale for a whole round is the one file everything
  else verifies against (`contracts L98`).
- ⛔ **CITE THE STATE YOU ACTUALLY OBSERVED.** Never carry forward a hash, count, or "it's green" you
  did not just measure. Solo there is no second party whose disagreement would surface a stale
  reassurance, so a copied-forward stamp is evidence of nothing (`contracts L155`: re-derive a
  number, never adjust one).

_(Team pattern, verbatim and dormant: `docs/team-protocol.md` "ARCHIVED" section. Three rules were
TRANSLATED into this section rather than archived — the four escalation categories, the ALL-SEVEN
auto-route, and route-on-kind — because they are mode-independent. This is their live copy.)_

## TDD posture

TDD applies to **deterministic code** — code where you can write a failing test that pins the behavior before the implementation exists.

<!-- ▼ EXAMPLE BLOCK [id=tdd-scope]: TDD scope — name what is test-first vs. what is exempt. Examples: "deterministic code (state machines, parsers, harness logic, instrumentation) is `/tdd`; LLM-driven generation is eval-tested instead." A project with no non-deterministic surface can simplify this to "TDD applies to all production code." ▼ -->
Deterministic code — contracts, validators, the 6 state machines, KnowledgeWriter, the Connector/Tool Gateways, the operational store, workflow control logic, parsers, the policy/egress/admission predicates — is **`/tdd`** (failing test first). **LLM/provider-driven generation** (the model's extraction/synthesis prose) is **eval-tested** instead via the `packages/evals` harness (`/eval`) — you can't pin a model's output with a unit test. When in doubt: *can I write a deterministic failing test that pins this behavior?* yes → `/tdd`; no → the eval path.
<!-- ▲ END EXAMPLE BLOCK [id=tdd-scope] ▲ -->

When in doubt, ask: "Can I write a failing test that pins this behavior deterministically?" If yes, `/tdd`. If no, ship via the project's non-deterministic-coverage path (eval suite, design-fixture review, etc.).

### Reviewer subagents — Step-8 policy

Optional Step-8 review subagents (`code-quality-reviewer`, `security-reviewer`) cost tokens every slice, so their fan-out is **policy-gated**. The implementer reads this at `/tdd` Step 8 (no-op if the subagents aren't installed):

- **security-reviewer:** `invariant`
- **code-quality-reviewer:** `every-slice`

Policy values: `off` · `invariant` (only invariant- or security-touching slices) · `every-slice` · `phase-boundary` (once at the phase-exit gate, dispatched by `/phase-exit`). Per-slice reviews cover the **slice diff**, not whole files. **At `phase-boundary` the review surface is the phase's accumulated branch diff + the trust boundaries it crosses** — for a track's later phases this over-approximates to the accumulated track diff (acceptable; say so in the report). Edit these values any time to tune per-slice cost.

## Requirement ids — which document defines which family (task `### 24.74`)

**A bare id does not say where it comes from, and the families below come from THREE different
documents.** This map is here, immediately above the safety rules, because that is where a reader
first meets a bare id.

| family | defined in | how to look one up |
|---|---|---|
| `WS-N` · `KN-N` · `ING-N` · `OBS-N` · `LIFE-N` · `RET-N` · `COST-N` | **`system_of_work_assistant_prd_v0_3.md`** (repo root) | by §-anchor — e.g. `§9.1 WS-8`, `§9.2 KN-4` |
| `REQ-F/S/NF/UX/D/I/T-NNN` | **`ARCHITECTURE.md`** — the requirement spine, stated with its text (e.g. `REQ-F-017` at `:139`) | search `ARCHITECTURE.md` for the id |
| `GATE-N` · `CP-N` · `§ARM-*` · `§DEC-*` | **`IMPLEMENTATION_PLAN.md`** — project-local, not requirements | search this tracker |

⛔⛔ **THE TRAP THIS MAP EXISTS TO REMOVE, MEASURED 2026-08-28: `REQ-*` IDS APPEAR IN NO PRD VERSION
AT ALL — v0.1, v0.2 and v0.3 contain ZERO of them.** The safety rules below cite `REQ-S-006` and
`REQ-F-017` alongside `KN-4`/`KN-9`, and that block names the PRD as the authoritative text **for
`KN-4`/`KN-9` specifically** ⇒ ***a reader who carries that attribution across to the neighbouring
`REQ-*` ids will search the PRD and find nothing***, which reads as a dangling id rather than as a
lookup in the wrong document.

⚠ **`docs/gap-audits/prd-req-coverage.md` is a TRACEABILITY MAP (PRD item → covering `REQ-*`), not a
definer.** It is the right place to ask *"which REQ covers this PRD requirement?"* and the wrong
place to ask *"what does this REQ say?"*

⭐ **When you cite an id, carry its meaning inline** — the `REQ-S-006` pattern used throughout the
safety rules below ("passes the JSON-Schema gate + validator (REQ-S-006)"). A citation whose meaning
travels with it survives its document being reorganised; a bare id does not.

## Key safety rules (do not paraphrase — explicit invariants)

<!-- ▼ EXAMPLE BLOCK [id=key-safety-rules]: key safety rules — the load-bearing domain invariants, stated explicitly. These are referenced by name from briefs, tests, and the forbidden-patterns lists. Project examples: "no real-world targets," "agent A cannot do agent B's job," "no autonomous filing of critical findings," "collateral never leaves without an equal claim burned," "settlement is one-time and immutable." If the project has no domain safety invariants, replace this whole section with a short note saying so. ▼ -->
1. **One writer / no hidden brain.** KnowledgeWriter is the ONLY autonomous writer of the canonical Markdown (**KN-4** / **KN-9** — authoritative text: `system_of_work_assistant_prd_v0_3.md:469` and `:474`, **not** `ARCHITECTURE.md`, which cites them once as a bare parenthetical and defines neither). No GBrain, runtime, agent, or external MCP writes Markdown directly; a DB-only semantic fact is a parity defect (quarantined). Enforced by routing every semantic mutation through a validated `KnowledgeMutationPlan`.
2. **Candidate-data gate.** Model/provider/agent output is candidate data until it passes the JSON-Schema gate + validator (REQ-S-006). No side effect — no Markdown write, no external write — happens before validation. The no-inference rule (REQ-F-017): never invent task owners/dates; emit `TBD` or route to clarification.
3. **External-write envelope / no duplicate writes.** Every external side effect goes through the Tool Gateway with an idempotency key + canonical object key + pre-write existence check + write receipt; replay reuses the receipt → zero duplicate external writes.
4. **Workspace isolation.** No raw cross-workspace retrieval. The GCL Visibility Gate (WS-8) is the single cross-workspace read path; agents may not issue cross-brain GBrain queries. 0 raw Employer-Work content surfaces in Personal outputs absent an approved link.
5. **Employer-Work egress veto.** Raw Employer-Work content with egress acknowledgment OFF may be sent only to a local zero-egress provider, else the job fails closed — never a cloud fallback. OpenRouter is its own processor, not an OpenAI alias.
6. **Untrusted-content tool-stripping (ING-7).** Any agent consuming imported/untrusted content runs read-only (no mutating tools) and is rejected at job admission if it declares one.
7. **Secrets.** Resolved only through SecretsPort/Keychain — never written to Markdown, logs, or the renderer; redaction strips secrets + raw content + prompts before any log sink.
<!-- ▲ END EXAMPLE BLOCK [id=key-safety-rules] ▲ -->

## Slash commands (`.claude/commands/`)

The harness injects each command's own description — no list is restated here. ⛔ **SOLO MODE: YOU RUN ALL OF THEM.** The role pairing this line used to carry (*lead runs `/team-start`/`/team-end`; orchestrator runs `/orchestrate-start`/`/orchestrate-end` + `/phase-exit`; implementer runs `/session-start`/`/session-end` + `/tdd`*) is **archived with the team pattern** — see `docs/team-protocol.md`. ⭐ **The sequence still means something solo, and it is the useful part:** `/tdd` per slice → `/session-end` when a work stretch closes → `/orchestrate-end` for round close-out (tracker + docs + terminal commit) → `/phase-exit` at a phase boundary. ⛔ **`/team-start` / `/team-end` / `/context-check` are INERT — they need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and a team that does not exist.** `/preflight`, `/run-tests`, `/check-arch`, `/wired` (+ optional `/eval`, `/trace`) are unchanged.

<!-- Solo mode is now the live mode; the team rows above are archived in docs/team-protocol.md. -->

## Lessons logged

Lessons start at §1 for this project. The compact index lives in `packages/contracts/CLAUDE.md`; full prose in `packages/contracts/LESSONS.md`.

Lesson numbers are stable IDs. Never reorder; never reuse a deleted slot.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
