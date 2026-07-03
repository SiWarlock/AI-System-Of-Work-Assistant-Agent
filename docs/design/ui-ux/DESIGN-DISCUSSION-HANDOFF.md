# UI/UX Design Discussion — Handoff & Working Brief

> **Mode: this is a DESIGN DISCUSSION, not a build.** The next session is a collaborative, back-and-forth conversation to decide the look, flow, design system, and UX of the app **before** Phase 9 (Electron Desktop UI) is built. Do **not** start writing Phase-9 code or unilaterally rewrite the spec. Discuss → propose options → let the owner decide → converge, page by page. The **output** of the discussion is an updated `docs/design/ui-ux/` spec + design-system that the eventual Phase-9 build follows.

## The gap we're closing

Three states of the design disagree, and none is final:

- **(A) The original written spec** — `docs/design/ui-ux/ui-ux-spec.md` + `design-system.md` (summarized below). Coherent and detailed, but **superseded** — the owner moved away from it.
- **(B) The Claude Design iteration** — what the owner actually built/prototyped in **Claude Design** (an external tool). It diverged from (A). **The assistant has NOT seen it** — the owner will describe / paste / screenshot it at the start of the discussion.
- **(C) What the owner actually wants** — not fully realized in (B) either. **This is the point of the discussion.**

**Entry point for the next session:** ask the owner to **show/describe what they built in Claude Design** and, specifically, **what feels right vs. wrong about it** (aesthetic, layout, flow, specific screens). Everything else follows from that. Do not monologue a new spec first.

## Owner's stated direction (the strongest signal of (C) so far — captured 2026-07-02)

The owner gave an explicit aesthetic + structural direction that **supersedes the old spec's dark "control-plane" look**:

- **Aesthetic: macOS-native, Apple-ecosystem vibes — "Liquid Glass."** Very modern, translucent frosted-glass material, the current Apple OS look. **Friendly**, not austere.
- **Light / bright / white-themed** (blue-accented) — a **light** default, NOT the old near-black `#09090B` dark-first. Bright and airy.
- **Blue** as the accent, in the Apple-system-blue family (friendly, not the old muted steel `#5A7FB5` on black).
- **Structural requirements the owner named:** a **Calendar view** (first-class, not buried) **and a Copilot sidebar** — Copilot as a **persistent right-hand assistant sidebar**, not only a standalone page.

**This resolves agenda item #1 substantially** and **reshapes the design system + shell:**
- The old `design-system.md` (near-black bg, steel-blue accent, "no glassmorphism, no gradients, cockpit density") is **superseded on the aesthetic axis** — the new look is **light, glassy, Apple-consumer-premium** rather than **dark, flat, Linear-developer**. Keep the *governance-legibility* + *information architecture* thinking; re-skin the *surface*.
- The **shell changes**: Copilot moves from a left-rail page to a **persistent Copilot sidebar** (right side), and **Calendar** is promoted to a first-class surface.
- **Tension to reconcile in the discussion** (raise, don't silently resolve): "Liquid Glass / bright / friendly / Apple-consumer" vs. the app's substance as a *dense, governed, all-day power-tool* — how much glass/translucency before governance data (IDs, hashes, statuses, diffs) stops being legible? Where does the mono-for-data / hairline-density discipline survive inside a glassy light shell? The three workspace accents (blue/emerald/amber) vs. an all-blue Apple palette. Light-first vs. a real dark mode.
- **Implementation note (for the eventual build, not the discussion):** Apple "Liquid Glass" has **no official web/CSS implementation** — in Electron/Chromium it is an **approximation** (`backdrop-filter` blur + layered translucent borders + specular highlights), and Electron can additionally use **real macOS window `vibrancy`/`visualEffectState`** for the actual system material behind the window. Label glass as an approximation; lean on real macOS vibrancy where possible.

Treat this as the leading candidate for (C) — but still start the discussion by having the owner show Claude Design + confirm/refine this against what they prototyped.

## What the product IS (the truth the design must serve — non-negotiable)

- **A Mac-first, local-first, self-hosted personal operating system** — a *governed local control plane* over the owner's Obsidian-compatible Markdown, spanning **three isolated workspaces**: Employer-Work, Personal-Business, Personal-Life.
- **Who it's for:** a single technical power-user (one person, their machine). Not a team product → **keyboard-first, information-dense, calm, trustworthy over flashy**, used all day.
- **The identity — "governance made legible."** Architecture sentence: *candidate-data-in, validated-and-policed-out; Markdown is the only source of truth, and one governed writer is its only autonomous author.* Four felt guarantees the UI must make **calm and obvious**:
  1. **Workspace isolation** — you always know which of the three "brains" you're in; crossing is deliberate + visible.
  2. **Approval before action** — external side effects wait for you, show exactly what will change, can't fire twice.
  3. **Provenance & audit** — every fact/action traces to its source + its record.
  4. **Egress safety** — you can always see whether cloud models may see raw content in the current scope.
- **Platform:** Electron desktop, Mac-first + a Telegram companion surface for approvals/briefs (the desktop app is the focus).

## The functional surfaces the UI must cover (ARCHITECTURE §11 — grounded, the data is REAL now)

Canonical §11 surfaces: **Global Today Dashboard · Workspace tabs · Project dashboard · Copilot (read-only Q&A) · Ingestion Inbox (with triage resolution) · Approval Inbox (Mac + Telegram parity) · Calendar view · Recent Changes · System Health.** Plus: **first-run onboarding** with workspace presets (Simple / Professional / Founder / Advanced), **Obsidian as a first-class editor** for the repos, and **Employer-Work egress status** visible in System Health + workspace settings.

**The API the UI renders against is already built + running** (Phase 8, live on loopback tRPC + WS): query procedures (dashboard / workspace / project / inboxes / System Health / Copilot-read / egress-status), command procedures (approval approve·edit·reject·defer, triage disposition), and a push stream with **4 event classes** (workflow status, approval update, System Health, read-model change). Critically, the renderer only ever receives **UI-safe projections** — the exact allowlisted fields are frozen in `@sow/contracts` `api/ui-safe.ts` (`UI_SAFE_ALLOWLIST`: `UiSafeApproval`, `UiSafeHealthItem`, `UiSafeWorkflowRunRef`, `UiSafeDashboardCard`). **The design should work with these real shapes** (ids, statuses, enums, timestamps, counts, short display strings — no raw content, no secrets).

## The original spec, in brief (the reference we're revisiting — (A))

- **Aesthetic:** "calm governed control plane," Linear / Raycast adjacent. Dark-mode-first, high-contrast, information-dense but unhurried, `⌘K` command palette first-class.
- **Dials:** visual variance LOW (predictable, aligned), motion LOW (state feedback only, honor reduced-motion), density MEDIUM-HIGH (cockpit; hairline dividers over big padded cards).
- **Shell:** persistent top bar (workspace-scope selector top-left · ⌘K search center · egress-state pill right) + a 220px left rail grouped **Work** (Today, Approvals·badge, Inbox·badge, Knowledge, Projects, Copilot, Health·badge) vs **Governance** (Connectors, Models, Audit, Settings).
- **Workspace scope model:** three isolated brains, each with an accent (Employer=steel blue, Personal-Business=emerald, Personal-Life=amber); a **Global** scope for cross-workspace views where any boundary crossing passes an explicit visibility gate (never silent blending).
- **Page set (12):** Today/Command Center · Approvals · Inbox · Knowledge · Projects · Copilot · System Health · Connectors · Models · Audit · Workspaces · Settings.
- **Design system:** bg near-black zinc `#09090B`, panels `#18181B`, hairline `zinc-800`; **one accent** steel blue `#5A7FB5` (no AI-purple, no decorative gradients, no neon); **Geist** UI + **Geist Mono for all governance data** (IDs/hashes/keys/timestamps); **Phosphor** icons stroke 1.5; radii locked (panels 10 / buttons 8 / pills full); one theme (dark default + real light), never inverts mid-screen; shadcn/ui + Radix component base.
- **Governance UI patterns (the differentiators):** the egress pill, the workspace-crossing visibility gate, the approval diff ("exactly what will change"), provenance/audit trails, mono-for-data.

*(Full detail: `ui-ux-spec.md` §4 per-page specs 4.1–4.12; `design-system.md` tokens + component map + copy voice + required states.)*

## Discussion agenda (what we'll work through — roughly in order)

1. **Aesthetic / mood / look-and-feel.** Is "calm governed control plane / Linear-Raycast dark" still the direction, or did Claude Design push elsewhere (warmer? lighter? more expressive? more consumer)? What should it *feel* like? Reconcile (A) vs (B) vs (C).
2. **Shell + navigation + flow.** The top-bar governance controls, the left-rail grouping, ⌘K, the workspace-scope model. Does the shell hold, or change?
3. **Page inventory.** Which pages exist, how grouped, what's home — reconcile the 12-page set vs what Claude Design has vs what's actually needed (merge/split/drop/add).
4. **Design system.** Color (accent + the 3 workspace accents), type (Geist + mono-for-data?), shape, motion, density, light/dark, component base. Lock the tokens.
5. **Per-page design.** Look + layout + key components + states, page by page — starting with **Today/Command Center** (sets the language), **Approvals** (the governance heartbeat), **Inbox/triage**. Ground each in the real UI-safe data shapes.
6. **Governance UI patterns.** How the four felt guarantees (isolation / approval / provenance / egress) are made visible + calm.
7. **Prototype-first order.** What to mock/build first once we've converged.

## How to run the discussion (method)

- **Start by eliciting (B) + (C):** ask the owner to show/describe Claude Design + what's right/wrong. Listen first.
- Use **`AskUserQuestion`** for genuine forks (aesthetic direction, layout options, page-set decisions) — offer 2–4 concrete, distinct options with tradeoffs, not open-ended prompts.
- Make options **tangible**: the assistant can produce **HTML/Artifact mockups** (load the `artifact-design` skill) or ASCII layout sketches so the owner compares real alternatives, not descriptions. The `design-taste-frontend` skill guidance applies (read the room, anti-slop, per-brief dials).
- Converge **page by page**; record decisions as we go.
- **Output:** an updated `docs/design/ui-ux/ui-ux-spec.md` + `design-system.md` (+ optional Artifact mockups) that Phase 9 builds from. Only after the owner signs off on the direction.

## Pointers

- Original spec: `docs/design/ui-ux/ui-ux-spec.md` · `docs/design/ui-ux/design-system.md`.
- Arch: `ARCHITECTURE.md` §11 (UI surfaces + UX rules), §5 (egress/auth/UI-safe boundary), §6 (knowledge/GCL visibility), §10 (the live API).
- The real data shapes: `packages/contracts/src/api/ui-safe.ts` (`UI_SAFE_ALLOWLIST` + the `UiSafe*` types) and `api/events.ts` (the 4 stream event classes).
- The live API surface: `apps/worker/src/api/**` (queries/commands/stream) — built + running (Phase 8; `SOW_API=1` live 7/7).
- Project state + binding decisions: memory `system-of-work-prd`; current build state: `docs/HANDOFF.md`.

## Build state at this handoff (context only — NOT what we're doing next)

Phases 0–8 + 10 are certified and the §10 API runs live (HEAD `9173a32`, tree clean, pushed). Phase 9 (Electron Desktop UI) is the phase this design discussion feeds — **but we are NOT building it yet.** We are deciding the design first.
