# System of Work Assistant — UI/UX Specification

> **Hand this to Claude Design (or any designer).** It is self-contained: it assumes no prior knowledge of the codebase. Pair it with `design-system.md` (the token + component + copy sheet) which every screen prompt should reference.

---

## 1. What we are building

The **System of Work Assistant** is a **Mac-first, local-first, self-hosted personal operating system** — a *governed local control plane* that sits over your own Obsidian-compatible Markdown notes and spans three sides of your life: **employer work, side projects, and personal life**.

In plain terms, it:

1. **Reads from your tools** — Calendar, Todoist, Linear, Asana, Granola (meeting transcripts), Google Drive, GitHub, Telegram capture, and arbitrary URLs/sources.
2. **Turns raw input into governed knowledge** — meeting digests, decisions, project notes, person notes, daily notes — written as **Markdown** (the single source of truth), plus a searchable local knowledge graph.
3. **Proposes and executes external actions** — creating a calendar hold, a Linear issue, a Drive doc, a Telegram message — but **only through an approval + audit spine**, so nothing happens to the outside world without your say-so and a durable record.

It runs on your machine. It is **privacy-governed**: content from your employer workspace is never sent to a cloud AI model unless you explicitly acknowledge it, and the three workspaces are kept strictly isolated.

### Who it is for
A single technical power-user owner (one person, their machine). Not a team product. This means: keyboard-first, information-dense, calm, and trustworthy over flashy.

### The identity that must come through in the UI
This app is defined by **governance made legible**. Its architecture sentence is:

> *candidate-data-in, validated-and-policed-out; Markdown is the only source of truth, and one governed writer is its only autonomous author.*

Everything the UI shows should reinforce four felt guarantees:

- **Workspace isolation** — you always know which of the three "brains" you are in, and crossing between them is deliberate and visible.
- **Approval before action** — external side effects wait for you; they are shown with exactly what will change and cannot fire twice.
- **Provenance and audit** — every fact and every action traces back to its source and its record.
- **Egress safety** — you can always see whether cloud models are allowed to see raw content in the current context.

The UI's job is to make those guarantees **calm and obvious**, not to bury them.

### Platform
An **Electron desktop app**, Mac-first. There is also a Telegram companion surface for approvals and briefs, but this spec is the desktop app.

---

## 2. Design language

**Aesthetic:** *calm governed control plane* — Linear / Raycast adjacent. Dark-mode-first, high-contrast, information-dense but unhurried, keyboard-first (a `⌘K` command palette is first-class).

**Design dials** (product-UI, not marketing):
- **Visual variance: low** — predictable, aligned layouts. This is a tool used all day; surprise is a cost.
- **Motion: low** — state transitions, reveals, and feedback only. Nothing cinematic. Honor `prefers-reduced-motion`.
- **Density: medium-high** — a cockpit for real work; hairline dividers and tight lists over big padded cards.

**Foundations** (full values in `design-system.md`):
- **Background** near-black zinc (`#09090B`), elevated panels `#18181B`, hairline dividers `zinc-800`.
- **One accent**, steel blue `#5A7FB5`, used consistently. No AI-purple, no gradients-for-decoration, no neon glows.
- **Workspace accents** color-code the three brains: Employer-Work = steel blue, Personal-Business = emerald, Personal-Life = amber.
- **Type:** Geist for UI, **Geist Mono for all governance data** (IDs, hashes, canonical keys, cursors, timestamps, counts-in-data-context). Not Inter, no serif.
- **Icons:** Phosphor, stroke 1.5, one family.
- **Radii locked:** panels/tiles 10px, buttons 8px, chips/pills full.
- **Theme locked:** the whole app is one theme (dark by default, with a real light mode); sections never invert mid-screen.

**Anti-slop guardrails** (apply to every screen): no uppercase "eyebrow" labels stacked over every heading, status dots only where they encode real state, no em-dashes in any UI copy, real semantic color (green healthy/approved, amber pending/degraded, rose blocked/error), mono for data.

---

## 3. Information architecture

### The shell

Every screen lives inside a persistent shell:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ◈ Scope: Employer-Work ▾     ⌕ Search or run a command  ⌘K   🛡 Egress: local-only ⚙ │  top bar (52px)
├────────────┬──────────────────────────────────────────────────────────────┤
│ left rail  │                                                              │
│ (220px)    │              active surface renders here                     │
│            │                                                              │
└────────────┴──────────────────────────────────────────────────────────────┘
```

**Top bar** carries the three governance controls that are always relevant:
- **Workspace scope selector** (top-left, most important control). Sets the governed context. Color-coded to the current workspace accent. Options: All (Global), Employer-Work, Personal-Business, Personal-Life.
- **⌘K command palette** (center). Jump to any note, run a workflow, approve, search the knowledge graph. This is a keyboard tool; the palette is first-class.
- **Egress state pill** (right). Shows whether cloud AI models may see raw content in the current scope: `local-only` (shield locked, safe) or `cloud allowed`. Turns rose if an action would risk sending raw employer content to a cloud model.

**Left rail** is the primary nav, grouped into work surfaces and governance surfaces, with live badges:

```
Work                Governance
▸ Today             ▸ Connectors
▸ Approvals   3     ▸ Models
▸ Inbox       5     ▸ Audit
▸ Knowledge         ▸ Settings
▸ Projects
▸ Copilot
▸ Health    ● 1
```

### Workspace scope model
The three workspaces are **isolated brains**. Switching scope re-colors the accent and re-scopes everything (notes, approvals, connectors, models). A **Global** scope exists for cross-workspace views, but any read that crosses a boundary passes through an explicit "visibility gate" and is shown as a deliberate crossing, never silent blending.

### The full page set

| Page | Purpose |
|---|---|
| **Today / Command Center** | Home. Daily brief + today's schedule + what is waiting on you + system health at a glance. |
| **Approvals** | The queue of proposed external actions awaiting approve / edit / reject / defer. The governance heartbeat. |
| **Inbox (Ingestion)** | Captured sources that need triage (assign workspace / project / sensitivity) before they enter the pipeline. |
| **Knowledge** | The Obsidian-compatible Markdown notes browser, scoped to the workspace: meetings, projects, people, decisions, daily notes, sources. |
| **Projects** | Per-project status, progress, and the managed NotebookLM doc pack (00–04). |
| **Copilot** | A read-only question-and-answer surface over your knowledge, with citations and no side effects. |
| **System Health** | Persistent operational issues (connector outages, blocked writes, budget breaches, missed schedules) until resolved. |
| **Connectors** | Connector auth, sync cursors, reachability, least-privilege scopes. |
| **Models** | The model routing matrix, egress state, budgets, local vs cloud, conformance status. |
| **Audit** | The append-only trail of every governed action, with actor, refs, payload hashes, timestamps. |
| **Workspaces** | The three brains and their governance posture (egress policy, model matrix, visibility default) + cross-workspace links. |
| **Settings** | Governance config, secrets (macOS Keychain), egress acknowledgment, schedules. |

---

## 4. Page specifications

Each spec gives purpose, layout, key components, and the required states (loading / empty / error). **Today is fully detailed** because it sets the shell and the language; the others are specified to a buildable level and can be expanded on request.

### 4.1 Today / Command Center

**Purpose:** the first thing you see. Answers "what happened, what needs me, and what is on fire" in one glance.

**Layout** (content column max 980px inside the shell):

```
Today                                          Run daily brief · 9:12
Tuesday, July 1
───────────────────────────────────────────────────────────────
Daily brief
Two meetings on the calendar and one blocker to clear. Vendor review
still needs close-out. Granola sync is degraded, so the standup
transcript has not landed yet.
3 decisions logged · 2 meetings · 1 open blocker

Waiting on you
┌────────────────────────────┐  ┌────────────────────────────┐
│ 3   Approvals              │  │ 5   To triage              │
│     Create Linear issue    │  │     2 captured sources     │
│     ENG-482 and 2 more   › │  │     need a workspace     › │
└────────────────────────────┘  └────────────────────────────┘

Today's schedule
09:30 · Standup            2 people   transcript pending
11:00 · Vendor review      4 people   needs close-out        ›
15:00 · 1:1 with Priya     2 people   in 4 hours

System health
● Granola connector is degraded   retry 4 of 6 · next in 42s
  View health ›

Recent activity
KnowledgeWriter committed meeting-2026-06-30-arch-sync.md  rev 0c4  18h
Approved: calendar hold for vendor review                          1d
Calendar connector synced   cursor 2026-07-01                      2h
```

**Key components:** the "Waiting on you" region is **two tiles** (never a row of three equal cards), each with a large mono number and a one-line preview. Schedule and Recent activity are **hairline-divided lists**, not cards. The single status dot is earned (a real degraded connector). Mono for `rev 0c4`, `cursor 2026-07-01`, retry counters, times.

**States:**
- *Loading:* skeleton rows matching each region (shimmer on tiles + list rows), never a spinner.
- *Empty:* "Nothing waiting on you" (calm check) when 0 approvals + 0 inbox; "No meetings today" for the schedule.
- *Error:* a top inline banner "Control plane reconnecting…" (rose hairline) if the local worker is down; the degraded connector is itself an inline error surface.

### 4.2 Approvals

**Purpose:** the governance heartbeat. Every proposed external action that needs your decision, shown with exactly what will change and a guarantee it cannot fire twice.

**Layout:** a list of **approval cards**, grouped by workspace. Each card:

```
┌ Create Linear issue · ENG-482 ─────────────────────────────────┐
│ "Fix vendor auth timeout"                                       │
│ Workspace: Employer-Work · Visibility: isolated · Expires 6h    │
│ before → after   (short diff of the change)                     │
│ object key  cok_linear_9f…    no duplicate ✓                    │
│ [ Approve ]  [ Edit ]  [ Reject ]  [ Defer 24h ]                │
└─────────────────────────────────────────────────────────────────┘
```

**Key components:** a redacted payload summary (never raw secrets), a before/after diff, the required-approval reason, workspace + visibility + expiry, and a mono footer showing the object key + a green "no duplicate" confirmation (the system checked the target before writing). Four actions: Approve, Edit, Reject, Defer (with snooze). Applying is exactly-once and idempotent (approving twice does nothing the second time). Cards can also arrive/resolve on Telegram; the two stay in parity.

**States:** *empty* = "Nothing awaiting approval"; *loading* = skeleton cards; *error/conflict* = a card whose precondition changed shows a "needs review" state, never a blind overwrite.

### 4.3 Inbox (Ingestion triage)

**Purpose:** captured sources that could not be auto-routed with confidence wait here for you to classify, then re-enter the pipeline.

**Layout:** a list of parked sources. Each row: the source (a URL, a captured note, a meeting), a proposed classification, and controls to set **workspace**, **project**, and **sensitivity**. A dedupe hit (the same content captured twice) shows as "already captured, no action."

**Key components:** workspace + project + sensitivity selectors; a "route into pipeline" action that reuses the original capture identity (so re-processing is safe and never duplicates). No owner/date/workspace is ever guessed for you; unfilled required fields are shown as amber "needs input" chips.

**States:** *empty* = "Inbox clear"; *error* = a source that failed to register shown inline with a retry.

### 4.4 Knowledge (notes browser)

**Purpose:** read and navigate the Markdown knowledge base for the current workspace. This is where meeting notes, project notes, person notes, decisions, and daily notes live.

**Layout:** a two-pane browser — a left tree/list (by type: Meetings, Projects, People, Decisions, Daily, Sources) and a right Markdown reader. Notes are mostly **read + propose** (a single governed writer authors the canonical Markdown; you propose edits rather than freely editing). Each note carries a **provenance strip**: source → writer revision, with mono hashes on hover.

**States:** *empty* = "No notes yet in this workspace"; *loading* = skeleton tree + reader.

### 4.5 Projects

**Purpose:** per-project status, progress, and the managed NotebookLM document pack.

**Layout:** a project list, then a project detail showing: progress (parsed from the real task system, not guessed), recent decisions, and the five managed Drive-backed docs — **00 Brief, 01 Decisions, 02 Meeting Digest, 03 Research, 04 Open Questions** — with a sync state and a "re-add / refresh source" affordance when a managed doc is unlinked.

### 4.6 Copilot (read-only Q&A)

**Purpose:** ask questions of your knowledge and get answers **with citations and no side effects**. If you want to act on an answer, it proposes an action that routes to Approvals.

**Layout:** a chat surface scoped to the current workspace (or Global via the visibility gate). Every answer shows its **citations** (links to the source notes). A persistent reminder that this surface reads only; it never writes or sends anything without turning into a proposal.

### 4.7 System Health

**Purpose:** operational truth that persists. Each distinct failure (a connector outage, a blocked external write, a budget breach, a missed schedule, a rejected input) is one item that stays until resolved or acknowledged, linked to its audit record.

**Layout:** a list of health items, each with a semantic dot (amber degraded, rose blocked/unreachable), a plain description, mono technical detail (retry counters, cursors), and an acknowledge/resolve action.

### 4.8 Connectors

**Purpose:** the read side. Connector auth, per-connector sync cursor, reachability, and least-privilege scope.

**Layout:** a table of connectors (Calendar, Todoist, Linear, Asana, Granola, Drive, GitHub, Telegram, URL sources) with columns: status (reachable / degraded / unreachable), cursor (mono), last sync, scope. A degraded connector shows its retry/backoff state.

### 4.9 Models

**Purpose:** the model routing matrix and its governance. Which provider/model serves which capability per workspace, egress class (local vs cloud), budget usage, and conformance status.

**Layout:** a matrix (capability × route) per workspace, an egress banner (whether cloud is allowed here), and budget meters. Local-only workspaces (Employer-Work by default) show the cloud routes as blocked.

### 4.10 Audit

**Purpose:** the append-only record of every governed action.

**Layout:** a reverse-chronological, filterable list. Each entry: actor, event, refs, mono payload hash, timestamps, before/after summary (summaries only, never raw content). Filter by actor / event / workspace / date.

### 4.11 Workspaces + governance

**Purpose:** the three brains and their posture, plus the cross-workspace links.

**Layout:** the three workspaces with their accent, egress policy (VETO / cloud-ok), model preference (local-only / cloud), and default visibility. Below, the active **cross-workspace links** — the only sanctioned way raw content crosses a boundary — each showing direction and that it required approval.

### 4.12 Settings

**Purpose:** governance configuration. Egress acknowledgment, secrets (stored in macOS Keychain, never shown), schedules, workspace policy, connector auth.

---

## 5. Core UX flows

These are the signature journeys. Build them as screen sequences.

### 5.1 Meeting closeout (the proof spine)
A Granola transcript arrives → the app correlates it (calendar, workspace, project, attendees) → an agent drafts a digest → a validator checks it → you review a **Meeting Closeout** screen: left = the digest (decisions, action items, with uninferred owners/dates shown as amber **TBD chips**, never guessed); right = the proposed Markdown notes + the proposed external actions queued to Approvals. You send it through; notes commit and actions land in the Approvals queue.

### 5.2 Approval
A proposed action appears in Approvals (and on Telegram) → you see the object, a redacted payload summary, a before/after diff, the required approval, workspace, and expiry → Approve / Edit / Reject / Defer → on approval it applies exactly once (the system checks the target first, so a replay never creates a duplicate) → it moves to Audit.

### 5.3 Source ingestion + triage
A URL or captured note comes in → it is registered (deduped by content, so a re-capture is a no-op) → if it cannot be routed confidently it parks in the Inbox → you assign workspace / project / sensitivity → it re-enters the pipeline reusing the same capture identity (safe to replay) → it becomes a source note.

### 5.4 Daily brief
On a schedule (or collapsed catch-up after your Mac wakes), connectors refresh → the app assembles per-workspace briefs and a global brief → the Today page shows it and Telegram gets a summary.

### 5.5 Cross-store deletion (governed saga)
You explicitly ask to delete something → the app builds a deletion plan and shows the ordered, idempotent steps (Markdown tombstone first as the commit point, then knowledge-graph purge, then event-store tombstone with history preserved) → any partial failure surfaces in System Health and re-drives safely, never orphaning or resurrecting data.

---

## 6. Governance UI patterns (the differentiators)

These are the things that make this **not** a generic dashboard. Apply them consistently:

- **Workspace boundary is felt, not just labeled.** The current workspace accent tints the scope selector and active-nav; a lock glyph marks any cross-workspace read.
- **Provenance everywhere.** Every fact/note/action carries a "source → governed writer revision" trail; mono hashes on hover; the Audit page is the full ledger.
- **Candidate vs committed.** Proposed writes render in a distinct "candidate" style (dashed/tinted) until they pass validation and (if needed) approval, then settle into committed truth.
- **Egress is ambient.** The top-bar shield pill is always visible; if an action would send raw employer content to a cloud model, the UI says so plainly and the action fails closed (it will not silently fall back to cloud).
- **System Health is persistent truth.** Health items do not vanish on refresh; they stay until resolved/acknowledged and link to their audit record.
- **Exactly-once, shown.** Approval cards and external writes display the "no duplicate" confirmation so the idempotency guarantee is visible, not just implemented.

---

## 7. What to prototype first

Recommended order for mockups:
1. **Today / Command Center** — sets the shell, nav, workspace scope, top-bar language, and the calm-dense rhythm. (Fully speced in §4.1.)
2. **Approvals** — carries the most of the app's governance identity.
3. **Meeting Closeout Review** — the richest single screen; shows the governed pipeline end to end.

Use `design-system.md` alongside each screen so tokens, components, and copy voice stay identical across the set.
