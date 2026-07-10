# Session 054 — frontmatter marker-safety (region-marker safety arc complete)

- **Date:** 2026-07-09
- **Phase:** Phase 6/9 §6 hardening (KnowledgeWriter ownership / region-boundary integrity)
- **Team:** `session-f2673cd5` (orchestrator + implementer, single-track on `main`, autonomous build)
- **Predecessor:** [`053-2026-07-09-phase11-enablement-gate-region-marker-neutralization.md`](./053-2026-07-09-phase11-enablement-gate-region-marker-neutralization.md)
- **Successor:** _(next session)_
- **Round:** round 3 — 1 slice (`be229cd`); `/orchestrate-end` (orchestrator) pushes after this doc.

## Why this session existed

Drain the out-of-slice FINDING surfaced at the round-2 region-marker Step-9 review: `checkOwnership` runs `parseSections` over the WHOLE note (frontmatter included), and `serializeScalar` does not strip `<!--`, so a `kw:region` marker string in a MODEL-DERIVED frontmatter value (meeting title/decisions/attendees, project title) formed a spurious frontmatter region → a fail-closed `malformed_marker` rejection of an otherwise-legit note. This slice completes the region-marker threat model (bodies were handled round-2 in `3daa0c8`; frontmatter is the other half).

## What was built

### Slice #7 — frontmatter marker-safety (`be229cd`, task #7)

**Files created:**
- `packages/workflows/test/frontmatter-marker-safety.test.ts` — 12 tests (dispatcher shape + delegation + idempotence + nested-array recursion · SCALAR-branch marker (title → YAML-quote) · ARRAY-branch marker (decision `string[]` element → `JSON.stringify`) · close+foreign markers · marker-in-slug `duplicate_region_id` · `checkOwnership` passes on create AND re-sync patch with human content preserved · clean-value byte-identical · projectSync title neutralization). Uses the REAL `parseSections`/`checkOwnership`/`serializeScalar` from `@sow/knowledge` + a faithful `renderCreate` mirror.

**Files modified:**
- `packages/workflows/src/activities/projections/noteSlug.ts` — new `neutralizeFrontmatterValue(value)` dispatcher: a thin delegate over the shipped `neutralizeRegionMarkers` (single authority) — neutralizes a string, RECURSES over array elements, passes any other shape (TBD sentinel, number, undefined) through untouched.
- `packages/workflows/src/activities/projections/meetingOutputs.ts` — the frontmatter loop wraps each of the 5 model-derived `NOTE_FRONTMATTER_FIELDS` values in `neutralizeFrontmatterValue` (`rawTitle`/`note.title` inherit the neutralized title).
- `packages/workflows/src/activities/projections/projectSyncOutputs.ts` — `identity.title` AND `identity.slug` neutralized (into `note.title`/`frontmatter.title`/H1 and `frontmatter.slug`); `projectId` kept RAW.

## Decisions made

- **Dispatcher, not a second neutralizer.** `neutralizeFrontmatterValue` DELEGATES to `neutralizeRegionMarkers` (inherits its fixpoint + linear-regex ReDoS guarantees) — a per-value type-dispatch (string / recursive-array / passthrough), not a fork. Reuse verbatim (Q3).
- **Neutralize at the composition sites; leave `serializeScalar` untouched** (Q1). The neutralize→serialize composition is sound: a neutralized `<\!--` has its `\` escaped to `\\` by BOTH `yamlDoubleQuote` (scalar) and `JSON.stringify` (array) ⇒ `<\\!--`, no `<!--` survives; serialization can only ADD backslashes, never forge a marker; `REGION_MARKER_RE` superset-covers every consumer matcher.
- **Scope = model-derived values only** (Q2). Meeting = all 5 `NOTE_FRONTMATTER_FIELDS` (all from the extraction). projectSync = `title` + `slug` (both from the resolved `ProjectRegistryEntry`). Human-authored frontmatter/body is never rewritten (checkOwnership PROTECTS it; the projections compose model-derived values only).
- **`slug` neutralized; `projectId` kept RAW** (Step-8 review fold). `slug` shares the `ProjectRegistryEntry` source with `title`, so a marker-bearing slug would serialize to a spurious region with the SAME id as the body ⇒ `duplicate_region_id` (the exact fail-closed rejection this slice prevents). `projectId` stays verbatim because gate-1's `readNoteProjectId`↔`expectedProjectId` compare depends on it (and it's server-sanitized, marker-free).
- **Array dispatcher recurses** (Step-8 review fold). Handles nested `string[][]` rather than relying on the extraction schema's flat-`string[]` shape.

## Decisions explicitly NOT made (deferred)

- **A marker-safe `serializeScalar`** — the broader alternative (Q1) was NOT taken; the targeted-site neutralization leaves `serializeScalar`'s general contract intact for its other callers.
- **Human-authored frontmatter neutralization** — out of scope by design (a human placing a marker in their own frontmatter is checkOwnership's concern to protect, not to rewrite).

## TDD compliance

**Clean — no violations.** Slice #7 was test-first: 8 of 10 tests failed (markers survived without the dispatcher) before the implementation; the 2 that passed pre-impl were the clean-value regression pins (expected). The 2 Step-8 hardening folds (slug + recursion) each landed with their own failing-first assertions within the cycle.

## Cross-doc invariant audit

**NONE this round.** Pure string-composition hardening in `packages/workflows` reusing the shipped `neutralizeRegionMarkers`; no contract/schema/snapshot/Appendix-A change. `git diff -- ARCHITECTURE.md` shows no owed edit. Confirmed with the orchestrator at Step 9.

## Reachability

- **Both projections LIVE.** `composeMeetingRegionBody`/meeting frontmatter via the meeting-closeout projection; `composeRegionBody`/project frontmatter via projectSync. The frontmatter neutralization is exercised whenever a model-derived frontmatter value embeds a marker string. `neutralizeFrontmatterValue` is reachable through both live drivers; no new unreachable surface.

## Open follow-ups

- **Round-2 frontmatter FINDING `(origin: 2026-07-10)` — DRAINED by this slice.** Orchestrator marks it resolved in Carry-forward at `/orchestrate-end`.
- **Lesson 9 scope note (orchestrator):** the neutralize-untrusted-markers-at-the-source threat model includes frontmatter + both serialize branches (YAML scalar + JSON array). No new lesson — folds into lesson 9.
- No new implementer follow-ups from this slice. The region-marker safety arc (region bodies `3daa0c8` + frontmatter `be229cd`) is COMPLETE.

## How to use what was built

- `neutralizeFrontmatterValue(value)` is the single entry point for defusing content-embedded region markers in a model-derived frontmatter value before it is serialized — call it at any projection that composes a `NoteCreate` from model/registry-derived frontmatter (string, array, or passthrough).
