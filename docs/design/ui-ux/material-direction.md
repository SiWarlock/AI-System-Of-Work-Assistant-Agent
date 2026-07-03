# Material direction — macOS Liquid Glass (LOCKED 2026-07-03)

> **Status: LOCKED** on the *aesthetic / material* axis by the owner. Supersedes the old dark "control-plane / Linear-Raycast, no-glassmorphism" look in `design-system.md` (that doc's *information-architecture + governance-legibility* thinking still stands; only the surface is re-skinned).
>
> **Canonical reference mockups** (owner-approved 2026-07-03) — open on a Mac (real SF Pro). These are the source of truth for the look; the tokens below are extracted from them:
> - [`mockups/today-macos-liquid-glass.html`](./mockups/today-macos-liquid-glass.html) — Today dashboard (the base language).
> - [`mockups/approvals-macos.html`](./mockups/approvals-macos.html) — Approvals (master–detail; the governance heartbeat: "exactly what will happen" + no-inference TBD + runs-once + egress).
> - [`mockups/calendar-macos.html`](./mockups/calendar-macos.html) — Calendar week view (governance-aware events; proposed writes shown as dashed "pending approval" blocks).
> - [`mockups/inbox-macos.html`](./mockups/inbox-macos.html) — Inbox / ingestion triage (pre-workspace staging; **neutral "Global" scope**; workspace assignment; ING-7 untrusted-content banner; file → KnowledgeWriter + gate).
> - [`mockups/knowledge-macos.html`](./mockups/knowledge-macos.html) — Knowledge (reader/browser over canonical Markdown; provenance + rev + backlinks; **Open in Obsidian** is the edit path).
> - [`mockups/projects-macos.html`](./mockups/projects-macos.html) — Projects dashboard (cross-screen loop: blockers, pending-approval tasks, TBD owners/dates, decisions linking to Knowledge).
> - [`mockups/today-macos-dark.html`](./mockups/today-macos-dark.html) — Today in the **dark** theme (frosted charcoal). Light is default; dark is supported.
>
> **Reserved-color rule (from the type-color reconciliation):** color means only **workspace** (blue/emerald/indigo) or **status** (warn amber / good green / accent blue). Classifiers like note-type render as **neutral mono tags**, never a colored dot — so a hue never ambiguously means two things.
>
> Still **open** (to decide later in the discussion — see bottom): dark mode, and how the 3 workspace accents live under an all-blue Apple palette.

## The look, in one line

Apple-ecosystem **Liquid Glass** — light, bright, **frosted-white / silvery** translucent glass over a soft desaturated pastel desktop, Apple **system-blue** accent, SF Pro type, real macOS window chrome. Friendly and premium, but the governance data stays crisp.

How we got here: v1 (flat white, drop-shadows) read "web SaaS" → variant **B** (maximal Liquid Glass) was the right *material* but too colorful and not quite macOS → **B2** calmed the color to authentic macOS frost. B2 is locked.

## Design tokens (extracted from the reference mockup)

### Color
| Token | Value | Use |
|---|---|---|
| `--accent` | `#0a84ff` | macOS system blue — selected sidebar pill, primary buttons, user chat bubble |
| `--accent-ink` | `#0064d6` | blue as **text/link** (darkened to hold on glass) |
| `--label` | `#1d1d1f` | primary text (Apple label) |
| `--label-2` | `#46464b` | secondary text |
| `--label-3` | `#6b6b73` | tertiary / captions |
| `--warn` / `--warn-ink` | `#ff9f0a` / `#b25e00` | degraded / needs-attention (fill vs. text-on-glass) |
| `--good` / `--good-ink` | `#34c759` / `#1a7f37` | healthy / egress-local (fill vs. text-on-glass) |
| traffic lights | `#ff5f57` `#febc2e` `#28c840` | window controls |

Semantic color (good/warn/critical) is **separate from the accent** and never counts as the accent.

### Material (the glass)
- **Surface tints (frosted white):** sidebar/Copilot `rgba(255,255,255,0.46)` · content `rgba(255,255,255,0.50)` · card `rgba(255,255,255,0.50)` · card-solid `rgba(255,255,255,0.64)`. Translucent enough to see the desktop through; frosted enough to read data.
- **Backdrop filter:** `saturate(160%) blur(30–50px)` on panes (higher blur on the big panes). *Calm* saturation — the loud color was the "too colorful" tell.
- **Specular kit (what makes it liquid, not flat):** bright inner edge ring `inset 0 0 0 1px rgba(255,255,255,0.55)` + glossy top highlight `inset 0 1px 0 rgba(255,255,255,0.7)` + soft inner bottom glow + a **subtle** diagonal sheen overlay (`mix-blend-mode: screen`, opacity ~0.3).
- **Hairlines:** glass-edge light `rgba(255,255,255,0.35)`; separators on solid surfaces `rgba(0,0,0,0.06)`.
- **Wallpaper:** soft, bright, **desaturated** pastel (cool blue/mint/lavender at low saturation) — the desktop the glass refracts. NOT a vivid gradient.
- **Radii:** window `16px` · card `15px` · buttons/controls `~7px` · pills full.
- **Window shadow:** large + soft (`0 40px 90px -20px rgba(10,20,60,0.55)`), tinted cool — depth via translucency + shadow, not per-card drop-shadows.

### Type
- **UI:** the **system stack** — `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui` → real **San Francisco** on macOS. (Using the system stack *is* the Mac-native move; do not link a webfont.)
- **Data:** `"SF Mono", ui-monospace, Menlo, monospace` for **all governance data** — ids, hashes, `rev`/`cursor`, keys, timestamps. `font-variant-numeric: tabular-nums` wherever digits align (schedule times, counts).

## macOS idioms (locked — these are what make it read "Mac app," not "web")
- Real **window**: rounded corners, big soft shadow, **traffic lights** + **unified toolbar** (`hiddenInset`).
- Selected sidebar row = **filled rounded-pill** in accent — **never** a left accent-bar (that's the web tell).
- **Segmented control** (macOS inset style), **grouped inset lists** (hairline-separated rows in a rounded container) for schedule/health.
- **Copilot** = persistent right sidebar with **iMessage-style bubbles** (user = filled blue, assistant = glass) + citation chips (mono) + proposal action row + suggestion chips + rounded input with a blue send circle.
- Toolbar: **pull-down** workspace switcher (dot + name + up/down chevron), **small inset** search + `⌘K` chip (not a giant web search bar), **egress status pill** on the right.
- Fake menu bar + wallpaper are staging for mockups; on a **light** desktop the menu bar is **dark text on light frost**.

## HARD build requirement (Phase 9 — do not drop)
The web `backdrop-filter` is only an **approximation**. The shipped Electron app MUST use the **real macOS system material**:
- **The app PAINTS its own locked pastel wallpaper + frosted panes** (the mockups' `backdrop-filter` glass over a painted gradient). This is the BASE and it reads bright/glassy on any desktop.
- **`titleBarStyle: 'hiddenInset'`** for real inset traffic lights + a unified toolbar; an **opaque** window with a light `backgroundColor`.
- Provide a **solid-fill fallback** for `prefers-reduced-transparency` / reduced-motion.

> ⚠️ **LESSON (2026-07-03, from the running Phase-9 build).** Do NOT rely on window `vibrancy` for the material. `vibrancy: 'sidebar'` + a transparent window samples whatever DESKTOP sits behind the window, which washed the bright design to a flat **gray** (desktop-dependent). The earlier note here ("pair with real vibrancy → looks *more* glassy") was WRONG. The app must **paint its own bright base**; vibrancy is at most an optional flourish layered *under* the painted design — never the base.

## Spacing & overflow discipline (LOCKED — learned 2026-07-03)

These bugs recurred because each screen re-invented spacing. LOCKED rules — every Phase-9 component inherits them by default so the class of bug can't return:

- **Container padding:** cards/panels/popovers ≥ 14–16px; compact blocks (calendar events) 5–8px, never 0.
- **Minimum block height:** a calendar event block is `min-height: 60px` so even a 30-min event fits time + title + one status chip without jamming the bottom edge.
- **Chips/tags:** shrinkable (`min-width:0; max-width:100%; overflow:hidden`) AND **prefer shorter text over clipping** — a chip must never bleed to a container edge or cut mid-word (use "landed · 3 decisions", not a clipped "transcript landed · 3 deci…").
- **Titles:** single-line with ellipsis; never assume the block is wide enough.
- **Never narrow a data block to make room for an overlay** — float the overlay; keep the block full width. (This was the popover/`right:68px` anti-pattern.)
- **Paired buttons:** side-by-side is the default, but only if BOTH labels fit — **size the container to the content** (widen the popover/card) rather than clipping. Full-width stacking is a fallback, not the default.
- **`overflow:hidden` clips shadows + borders:** keep interactive controls inset from any rounded/clipped container edge, or their shadow/border gets sliced and reads as "touching the edge."
- **Popovers/cards are sized to their longest line** (mono provenance lines are long) — never set a width narrower than the content it must hold. (The event popover is 360px for this reason.)

## Shell & navigation (LOCKED 2026-07-03)

- **Three-pane shell:** left nav rail · center content · right **Copilot sidebar**. Unified toolbar carries traffic lights, workspace switcher, `⌘K` search, **egress pill**, gear.
- **Copilot = persistent right sidebar** on every screen — collapsible to a thin rail, and **expandable to a full-screen conversation**. It is NOT a separate nav page.
- **Workspace model:** the toolbar **workspace switcher scopes the whole app** — the active workspace (Employer-Work / Personal-Business / Personal-Life) drives every page. A **"Global"** scope aggregates across the three, and any cross-workspace read passes the **GCL Visibility Gate** (safety rule 4 — never a raw blend).
- **Workspace identity — Treatment 1 (subtle scope), LOCKED:** the app accent stays **system-blue for every workspace**. The active workspace is expressed ONLY by the **switcher dot** + a thin **scope line** under the toolbar — no control re-tint (selected pills, buttons, counts stay blue in all brains, keeping the locked look consistent). Isolation stays legible without three differently-colored apps.
  - **Workspace colors** (dot + scope line only): Employer-Work = blue `#0a84ff` · Personal-Business = emerald `#1fae6b` · Personal-Life = **indigo `#5e5ce6`**. *(Indigo replaces the original amber, which collided with the warning/degraded semantic color.)*
- **Sidebar structure — Option B (config tucked in Settings):**
  - **WORK:** Today (home) · Calendar · Approvals · Inbox · Knowledge · Projects · **Health**
  - divider → **Settings** (contains **Connectors · Models · Audit · Workspaces** + preferences).
  - **Governance-legibility guardrail:** config *pages* live under Settings, but the always-on governance *signals* stay first-class and visible — the **egress pill** (toolbar), **Health** in the main rail (with alert dot), System Health on Today. Keeps the rail calm without hiding the guarantees.
- **Home:** Today. **Recent Changes** folds into Today ("Recent activity") + Audit — not a separate page.
- **Settled page inventory:** Today · Calendar · Approvals · Inbox · Knowledge · Projects · Health · Settings (→ Connectors · Models · Audit · Workspaces). Copilot = sidebar (not a page).

## Prototype-first build order (Phase 9) — LOCKED

Build in this order so each step de-risks the next; everything hangs off the shell:

1. **The app shell + Today** — window chrome (traffic lights, unified toolbar, `hiddenInset`), real macOS **vibrancy**, the Option-B nav sidebar + blue **scope line**, the collapsible **Copilot sidebar** frame, and the Today dashboard (home). This establishes every reusable primitive (glass panes, nav pill, cards, grouped lists, segmented control, chips, mono-for-data).
2. **Approvals** — the governance heartbeat + the highest-value interaction (the "exactly what will happen" + approve/edit/reject/defer flow). Proves the command path + UI-safe projections end-to-end.
3. **Calendar** — validates the language on a non-card layout (time grid) and the cross-screen governance loop (proposed writes surfacing as pending blocks).
4. **The inheriting pages** — Inbox · Knowledge · Projects · Health · Settings (→ Connectors · Models · Audit · Workspaces). These reuse the locked patterns and need only light per-page notes, not fresh design.

## Dark mode (SUPPORTED — light is the default) 2026-07-03

Adopted. **Light is the default**; a **frosted-charcoal dark** theme is a first-class variant. Reference: [`mockups/today-macos-dark.html`](./mockups/today-macos-dark.html). Same structure/idioms as light — only the material re-tints:

- **Wallpaper:** deep blue-charcoal (not flat black) so the glass still refracts faint color.
- **Panes:** dark translucent — sidebar/Copilot `rgba(30,33,44,0.55)` · content `rgba(28,31,42,0.5)` · card `rgba(36,40,52,0.55)` · card-solid `rgba(44,48,62,0.72)`; blur/saturate as light; faint top rim `inset 0 1px 0 rgba(255,255,255,0.08)`, hairlines `rgba(255,255,255,0.08)`.
- **Text:** `#f2f2f7` / `#a1a1aa` / `#6b6b73`; mono data `#c7c7cf`.
- **Accent:** system-blue kept, **brightened** on dark → `#409cff` for text/links/counts (pill/button base stays `#0a84ff`).
- **Semantic:** warn `#ff9f0a` (text `#ffb340`), good `#30d158` (text `#4ee06f`) — tuned to read on dark.
- Sheen/specular carried a touch brighter than a literal swap so the glass doesn't flatten into opaque cards.
- Real build: pair with Electron `vibrancy` dark materials; honor `prefers-color-scheme`.

## Design discussion — COMPLETE (2026-07-03)

Everything load-bearing is decided and captured: aesthetic · tokens · spacing/overflow discipline · reserved-color rule · shell · navigation (sidebar Option B) · page inventory · Copilot placement (sidebar) · workspace model + identity (Treatment 1, blue/emerald/indigo) · dark mode · prototype-first order. **Seven reference mockups** — Today (light + dark) · Approvals · Calendar · Inbox · Knowledge · Projects — match the spec, covering every genuinely-distinct surface.

**Deferred to just-in-time (Phase 9 build):** **Health** and **Settings** (→ Connectors · Models · Audit · Workspaces). The owner opted not to design these — they're the most pattern-inheriting surfaces (System-Health cards already exist on Today; Settings/config are standard list + form), so they'll be laid out during the build from the locked components.

_When the whole UI/UX discussion converges, this folds into `design-system.md` as the token layer._
