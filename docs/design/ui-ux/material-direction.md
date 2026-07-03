# Material direction — macOS Liquid Glass (LOCKED 2026-07-03)

> **Status: LOCKED** on the *aesthetic / material* axis by the owner. Supersedes the old dark "control-plane / Linear-Raycast, no-glassmorphism" look in `design-system.md` (that doc's *information-architecture + governance-legibility* thinking still stands; only the surface is re-skinned).
>
> **Canonical reference mockups** (owner-approved 2026-07-03) — open on a Mac (real SF Pro). These three are the source of truth for the look; the tokens below are extracted from them:
> - [`mockups/today-macos-liquid-glass.html`](./mockups/today-macos-liquid-glass.html) — Today dashboard (the base language).
> - [`mockups/approvals-macos.html`](./mockups/approvals-macos.html) — Approvals (master–detail; the governance heartbeat: "exactly what will happen" + no-inference TBD + runs-once + egress).
> - [`mockups/calendar-macos.html`](./mockups/calendar-macos.html) — Calendar week view (governance-aware events; proposed writes shown as dashed "pending approval" blocks).
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
- `BrowserWindow`: **`vibrancy: 'sidebar'`** (nav/Copilot panes) / **`'under-window'`** (window base), **`visualEffectState: 'active'`**, transparent window background so the material shows.
- **`titleBarStyle: 'hiddenInset'`** for real inset traffic lights + unified toolbar.
- Provide a **solid-fill fallback** for `prefers-reduced-transparency` / reduced-motion.
- *(Confirm exact option names against current Electron docs at build time.)*

Net: the real app looks **more** glassy than the mockup, not less.

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
- **Workspace model:** the toolbar **workspace switcher scopes the whole app** — the active workspace (Employer-Work / Personal-Business / Personal-Life) drives every page. A **"Global"** scope aggregates across the three, and any cross-workspace read passes the **GCL Visibility Gate** (safety rule 4 — never a raw blend). Active workspace shown by the switcher + a subtle scope indicator (tint treatment still open, below).
- **Sidebar structure — Option B (config tucked in Settings):**
  - **WORK:** Today (home) · Calendar · Approvals · Inbox · Knowledge · Projects · **Health**
  - divider → **Settings** (contains **Connectors · Models · Audit · Workspaces** + preferences).
  - **Governance-legibility guardrail:** config *pages* live under Settings, but the always-on governance *signals* stay first-class and visible — the **egress pill** (toolbar), **Health** in the main rail (with alert dot), System Health on Today. Keeps the rail calm without hiding the guarantees.
- **Home:** Today. **Recent Changes** folds into Today ("Recent activity") + Audit — not a separate page.
- **Settled page inventory:** Today · Calendar · Approvals · Inbox · Knowledge · Projects · Health · Settings (→ Connectors · Models · Audit · Workspaces). Copilot = sidebar (not a page).

## Still open (decide later in the discussion)
1. **Dark mode.** Owner chose **light-first**. A real dark variant (frosted charcoal glass) is TBD — light is the default and the priority.
2. **Workspace identity vs. all-blue palette.** The 3 workspaces had accents (Employer = steel blue, Personal-Business = emerald, Personal-Life = amber). Under an all-Apple-blue app accent, the likely resolution: **keep system-blue as the app accent**, express the active workspace as a **small scoped indicator** (the switcher dot + a subtle scope tint), not a full re-theme — so you always know which brain you're in without three different-colored apps. Confirm when we design the workspace-scope model.

_When the whole UI/UX discussion converges, this folds into `design-system.md` as the token layer._
