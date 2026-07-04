# System architecture — Truth → Index → Read (where gbrain fits)

> Companion to [`PHASE-13-PROPOSAL-osb-inheritance.md`](./PHASE-13-PROPOSAL-osb-inheritance.md). The one-picture model of how `obsidian-second-brain` inputs, KnowledgeWriter, the Markdown vault, and **gbrain** relate. (Repo-local mirror of the blueprint artifact so it doesn't depend on claude.ai access.)

**Thesis:** *Markdown is the truth, KnowledgeWriter is the only pen, and gbrain is the read-only lens you (and the Copilot) look through.* obsidian-second-brain feeds the truth from one side; gbrain indexes it from the other; there is exactly **one writer, one truth, and one read-lens per workspace.**

```
┌───────────────────────────────────────────────────────────────────────┐
│  01 · INPUTS  — candidate data, UNTRUSTED until gated                  │
│     Extractors (osb, vendored+pinned):  YouTube · Podcast · Web · File │
│     Capture "as you work" (G4):         git · telegram · session · /capture
│     Connectors (external reads):        Linear · Asana · Calendar ·    │
│                                         GitHub · Granola · Drive        │
└───────────────────────────────────────────────────────────────────────┘
                         │  candidate data
                         ▼
╔═══════════════════════════════════════════════════════════════════════╗
║  02 · CANDIDATE GATE — registerSource()                    [GOVERNED]  ║
║     ajv + Zod · workspaceId REQUIRED · Flow-4 dedupe ·                 ║
║     no-inference → TBD · ING-7 read-only for untrusted content         ║
║     ── Egress veto (ModelProviderPort): employer-work + ack-OFF        ║
║        ⇒ LOCAL model (Ollama/LM Studio), else FAIL CLOSED — never cloud║
╚═══════════════════════════════════════════════════════════════════════╝
                         │  validated plan
                         ▼
╔═══════════════════════════════════════════════════════════════════════╗
║  03 · KNOWLEDGEWRITER — the SOLE writer                    [GOVERNED]  ║
║     KnowledgeMutationPlan → applyPlan()                                ║
║     preserve human sections · compare-revision · secret-scan → REJECT  ║
╚═══════════════════════════════════════════════════════════════════════╝
                         │  commit
                         ▼
┌───────────────────────────────────────────────────────────────────────┐
│  04 · TRUTH — Obsidian-compatible Markdown   ★ the ONE canonical truth │
│     ┌───────────────┐ ┌──────────────────┐ ┌───────────────┐          │
│     │ Employer-work │ │ Personal-business│ │ Personal-life │          │
│     └───────────────┘ └──────────────────┘ └───────────────┘          │
│     Workspace isolation — no raw cross-workspace read                  │
└───────────────────────────────────────────────────────────────────────┘
                         │  indexed    ( ↻ rebuildable FROM truth )
                         ▼
┌───────────────────────────────────────────────────────────────────────┐
│  05 · INDEX — gbrain   — the READ brain (derived, read-only)           │
│     search · typed graph · backlinks · timelines                       │
│     parity / quarantine · pinned (config/gbrain.pin) · one per         │
│     workspace · generative → propose-only     (NEVER a source of truth)│
└───────────────────────────────────────────────────────────────────────┘
                         │  query
                         ▼
┌───────────────────────────────────────────────────────────────────────┐
│  06 · READ — you · Copilot · desktop                                   │
│     Copilot Q&A (cited) · Today / Projects ·                           │
│     "what's going on in project X?"                                    │
│     Cross-workspace ONLY via the GCL Visibility Gate (sanitized)       │
└───────────────────────────────────────────────────────────────────────┘

   ↻ SYNTHESIS LOOP — gbrain's own insights are PROPOSALS, not writes:
     back up through the candidate gate → KnowledgeWriter → Markdown →
     re-indexed. gbrain never touches truth directly. Confined / additive
     proposals may auto-apply (§13.8); anything that edits a human-relevant
     claim proposes.
```

## How to read it

- **`[GOVERNED]` (02, 03)** — the three boundaries that never bend: the candidate gate, the egress veto, and the sole writer. Nothing reaches Markdown or leaves the machine without crossing them.
- **`★ TRUTH` (04)** — the center of gravity. The Obsidian Markdown vault, one per workspace, is the only canonical semantic truth. Everything above it is *input*; everything below it is *derived*.
- **`INDEX` (05) = gbrain** — a derived, read-only, rebuildable projection of the truth. Delete it and rebuild from the Markdown and nothing is lost. A DB fact that can't be re-derived from Markdown is a parity defect → quarantined (this is the mechanical enforcement of "no hidden brain").
- **The `↻` loop** — gbrain can *propose* (synthesis, links, reconciliations) but never *writes*; proposals re-enter at the gate and are committed by KnowledgeWriter, then re-indexed.

## Where gbrain fits (the crossover, in one place)

Three things are easy to conflate — keep them distinct:

| | Role | Writes truth? |
|---|---|---|
| **Markdown vault** | the canonical notes (per workspace) | yes — but only via KnowledgeWriter |
| **gbrain** | the derived index / query engine (layer 05) | **never** — read-only, rebuildable |
| **obsidian-second-brain** (repo) | a toolkit: extractors (layer 01) + its own local index | its writers are stripped on inheritance |

- osb's **extractors** are *inputs* (layer 01) — upstream of gbrain. They produce Markdown; gbrain indexes that Markdown.
- osb's **own retrieval** (local Ollama embeddings + link graph) is a candidate to *power/improve* gbrain's retrieval — **not** a second index running beside it. Rule: **one derived index per workspace, no second hidden brain.**
- The **naming note:** the `gbrain` CLI/engine is what sits *behind* SoW's "GBrain" read layer — SoW pins it (`config/gbrain.pin`), runs it read-only per workspace, and queries it. Same thing, tool-vs-role.

## Current-state honesty

The governance around gbrain (read adapter, index-sync, the write-through / parity layer) is **written and tested, but wired to an in-memory stub** — the real `gbrain 0.35.1` process isn't spawned yet (a Phase-11 task), exactly like the vendor connectors. So the *rails* exist in code; the *real engine* behind layer 05 is still stubbed.

See also: [`sow-verified-build-reality`](../../MEMORY) · [`PHASE-13-PROPOSAL-osb-inheritance.md`](./PHASE-13-PROPOSAL-osb-inheritance.md) §13.3 (retrieval), §13.6 (capture), §13.8 (tiered autonomy).
