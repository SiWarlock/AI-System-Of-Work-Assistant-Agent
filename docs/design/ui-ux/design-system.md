# System of Work Assistant — Design System Sheet

> **Reference this alongside every screen prompt** so tokens, components, copy voice, and states stay identical across the whole app. Companion to `ui-ux-spec.md`.

Aesthetic in one line: **calm governed control plane** — Linear / Raycast adjacent, dark-mode-first, keyboard-first, high-contrast, information-dense but unhurried.

---

## 1. Tokens

### Color

| Token | Value | Use |
|---|---|---|
| Page background | `#09090B` (zinc-950) | app canvas. Never pure `#000`. |
| Elevated surface | `#18181B` (zinc-900) | tiles, panels, top bar, cards |
| Hairline / border | `zinc-800` at ~60% | dividers, list rows, borders (favored over shadows) |
| Text primary | `#FAFAFA` (zinc-50) | headings, key values |
| Text secondary | `#A1A1AA` (zinc-400) | body, labels |
| Text muted | `#71717A` (zinc-500) | metadata, timestamps |
| **Accent — steel** | `#5A7FB5` | the one interactive accent + Employer-Work scope |
| Workspace — emerald | `#3FB27F` | Personal-Business scope |
| Workspace — amber | `#D19A4E` | Personal-Life scope |
| Semantic — healthy/approved | `#3FB27F` | success, committed, connected |
| Semantic — pending/degraded | `#D19A4E` | awaiting, deferred, degraded connector |
| Semantic — blocked/error | `#D66A6A` | rejected, unreachable, blocked write, egress risk |

**Rules:** one accent (steel) used identically across the app. Workspace accents only tint the scope selector, active nav, and workspace chips. Semantic colors only encode real state. No purple, no decorative gradients, no neon glows.

### Type

- **UI:** Geist (sans). Not Inter, no serif.
- **Data:** **Geist Mono** for every ID, hash, canonical key, connector cursor, timestamp, and count shown in a data context.
- **Scale:** page title `text-2xl`/`24px` weight 600; section heading `text-sm`/`14px` weight 600, sentence case (no uppercase eyebrows); body `text-sm` zinc-400; data/mono `text-xs`–`13px`.

### Shape (locked)

- Panels / tiles / cards: **radius 10px**
- Buttons: **radius 8px**
- Chips / pills / badges: **full radius**

One scale, applied everywhere. No mixed radii without a documented rule.

### Spacing / layout

- Left rail `220px`, top bar `52px`, content column `max-w-[980px]`.
- Density medium-high: `py-6` between major regions, `gap-3` within lists.
- Prefer hairline-divided lists (`divide-y`) over boxed cards; use a card only when elevation encodes real hierarchy (the "Waiting on you" tiles, approval cards).

### Icons

Phosphor, stroke `1.5`, one family. Nav 18px, inline 16px.

### Motion

- Low intensity: rows fade/slide in on mount (stagger ~40ms), tiles lift `-translate-y-[1px]` on hover, press `scale-[0.99]`.
- Approval card resolve can use a layout transition.
- Everything above static honors `prefers-reduced-motion` (collapses to instant).

### Theme

One theme app-wide (dark by default, real light mode available). Sections never invert mid-screen. Set the theme once at the app root.

---

## 2. Component mapping (shadcn/ui + Radix primitives)

| UI element | Component |
|---|---|
| Workspace scope selector | `DropdownMenu` (steel-tinted trigger) |
| Command palette (⌘K) | `Command` |
| "Waiting on you" tiles, approval cards | `Card` (customized: 10px radius, hover lift) |
| Schedule / activity / audit rows | plain `div` + `divide-y` (no card boxes) |
| Nav badges, workspace chips, status chips | `Badge` |
| System health item, error banner | `Alert` |
| Knowledge browser panes | `ResizablePanelGroup` |
| Approve/Edit/Reject/Defer | `Button` (primary steel / ghost / destructive rose) |
| Toasts (transient only) | `Sonner` |
| Models matrix, connectors, audit | `Table` |

Own the components (shadcn gives you the code); never ship them in default state. One design system, no mixing.

---

## 3. Copy voice

- **Plain and functional.** Say what the thing is. No filler verbs (elevate, seamless, unleash), no marketing punch.
- **Mono for data.** IDs, hashes, keys, cursors, timestamps render in Geist Mono.
- **No em-dashes anywhere in UI copy.** Use a period, comma, colon, or line break. (Regular hyphens are fine.)
- **No uppercase eyebrow labels** stacked over headings. The heading alone is enough.
- **Real, organic mock data.** Realistic meeting names, plausible times, believable IDs (`ENG-482`, `cok_linear_9f…`, `rev 0c4`). No "Acme", no "Jane Doe", no fake-perfect numbers.
- **Governance language is calm and specific:** "Approve", "Defer 24h", "needs close-out", "no duplicate", "local-only", "transcript pending", "reattach source".

---

## 4. Required states (every screen)

- **Loading:** skeleton loaders matching the final layout shape (rows/tiles), never a generic spinner.
- **Empty:** composed and calm, with what to do next ("Inbox clear", "Nothing awaiting approval", "No notes yet in this workspace").
- **Error:** inline and specific (a degraded connector, a reconnecting worker banner, a precondition conflict on an approval), never a dead end.

---

## 5. Paste-ready Claude Design prompt (template)

Copy this, then swap the screen-specific block:

> Design a **dark-mode desktop app screen** for a local-first personal work OS with a **calm, governed, Linear/Raycast-adjacent** aesthetic. Background `#09090B`, panels `#18181B`, hairline dividers `zinc-800`, one steel-blue accent `#5A7FB5`. Fonts: **Geist** for UI, **Geist Mono** for IDs, hashes, keys, cursors, timestamps, and data counts. Phosphor icons, stroke 1.5. Radii locked: panels 10px, buttons 8px, chips full. Persistent shell: a 220px left nav rail (Today, Approvals, Inbox, Knowledge, Projects, Copilot, divider, Health, Connectors, Models, Audit, Settings) and a 52px top bar with a steel workspace scope selector ("Employer-Work"), a ⌘K command search, and a shield egress pill ("Egress: local-only"). Restrained motion (fade-in on mount, 1px hover lift). No purple, no gradients, no three-equal-cards, no uppercase eyebrow labels, no decorative status dots, **no em-dashes**. Include loading (skeleton), empty, and error states.
>
> **This screen:** _[paste the specific page layout from `ui-ux-spec.md` §4]_

---

## 6. Screen build order

1. **Today / Command Center** — sets the shell and language (spec §4.1).
2. **Approvals** — the governance heartbeat (spec §4.2).
3. **Meeting Closeout Review** — the richest screen, whole pipeline visible (spec §5.1).

Keep this sheet open for every screen so the set stays consistent.
