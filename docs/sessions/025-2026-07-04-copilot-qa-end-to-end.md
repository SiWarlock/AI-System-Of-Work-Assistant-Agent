# Session 025 — §9.6 Copilot Q&A, end-to-end (B page shell + A backend)

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** desktop · contract · worker · providers-integrations (reuse) · eval-security
- **Predecessor:** `024-2026-07-04-RESUME-copilot.md` (the resume handoff)
- **Successor:** `026-2026-07-04-RESUME-post-copilot.md` (resume handoff — pick the next track)
- **HEAD at close:** `08cbf6e` · **8 slice commits** (`761f312` B1 · `5b58692` B2 · `fef29e6` A1 · `d9ae4a6` A2 · `bfd7685` A3 · `212aff7` A4 · `b482921` A5 · `08cbf6e` A6)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; desktop 149; worker 387; contracts 629; evals 148.
- **Reviews:** 16 subagent reviews across the 8 slices (security + code-quality per security-touching slice; code-quality-only for B1 UI-chrome + A6 test-suite). 0 critical/high anywhere; every medium/high-in-test fixed IN-SLICE.

## Why this session existed

Owner directive (session-024 resume prompt): **build 9.6 Copilot in two phases, B then A** — B = the page shell, A = the retrieval + governed-LLM + citation backend. This discharges the standing Carry-forward item **b (9.6 Copilot Q&A)**, the last of the owner's "b-d" queue's headline item.

## Load-bearing course-correction (before any code)

The session-024 resume prompt framed Copilot as a **"routable page / NavLink"** — but the LOCKED design (`material-direction.md:57/85/94/119`) says the opposite in four places: *"Copilot = persistent right sidebar, collapsible to a thin rail, expandable — NOT a separate nav page."* Surfaced the conflict via `AskUserQuestion`; **owner chose the right sidebar (per the lock).** Reverted the speculative route/NavLink work and built Copilot as the **expandable rail→sidebar** the design mandates. (The handoff's "page" framing was my own imprecision, not an owner override of the lock.)

## What was built (8 slices)

### B — the page shell (desktop)
| Commit | Slice | Summary |
|---|---|---|
| `761f312` | B1 | **Rail→sidebar expand/collapse chrome.** AppShell owns `copilotOpen` (orthogonal to route AND scope); the 36px rail (behavior-preserving move) gains an Expand chevron; the expanded `<Copilot>` panel a Collapse control. Disclosure focus management (focus follows into the panel on open, back to the rail on collapse; no initial-load steal). |
| `5b58692` | B2 | **Chat panel content.** iMessage bubbles (user filled-blue, assistant glass), mono citation chips, a routes-to-Approvals proposal row, suggestion chips, a rounded input + blue send circle (scaffolded/disabled until A), a persistent read-only reminder. WS-8: a new `resolveWorkspaceId` fails CLOSED for the ASK direction (Global/unknown → pick-a-workspace, no composer) — `isWorkspaceScope` fails closed only for the push-fold direction, the wrong way for gating a read. |

### A — the backend (contract · worker · desktop · evals)
| Commit | Slice | Summary |
|---|---|---|
| `fef29e6` | A1 (contract) | **`UiSafeCopilotAnswer` + `UiSafeCitation`** — the WS-8 leakage-gate seam. Opaque citationId (`uiSafeOpaqueRef` rejects path/URL) + single-line title; answer = single-line-bounded blocks (min 1 / max 40, each ≤1024) + citations (max 20); both caps defeat chunk-smuggling. Frozen: `.strict()` + `Exact<>` + sorted allowlist + freeze test. Pinned the downstream **redact-by-type handoff** on the `answer` comment. |
| `d9ae4a6` | A2 (worker) | **Workspace-scoped retrieval** — `CopilotRetrievalPort` + `enforceRetrievalScope` (defense-in-depth WS-8 guard; null/non-object → typed err, no throw) + `createFixtureRetrieval` (interim; `Object.hasOwn` own-key lookup; mis-keyed fixture fails closed). Real GBrain/GCL deferred (no passage read-model yet). |
| `bfd7685` | A3 (worker) | **Governed synthesis** — `guardCopilotEgress` REUSES the broker's certified `vetoJobEgress` (@sow/providers: `egressVeto` + the narrow-only route-identity guard); FORCES `carriesRawContent:true` so a caller can't bypass the veto. `createStubSynthesis` cites sources but structurally never touches `context.blocks` (no raw echo). Real LLM synthesis deferred (EVAL-tested, A6). |
| `212aff7` | A4 (worker) | **`query.copilotAsk` + the candidate-data gate.** `answerCopilotQuestion` = retrieve → re-enforce scope → synthesize → gate, fail-closed at every step. `toUiSafeCopilotAnswer` normalizes blocks + titles via `collapseToSummaryLine`, passes citationId through for the schema to reject, validates against `UiSafeCopilotAnswerSchema` (discharges A1's citation-title obligation). `parseAskInput` bounds question length. `QueryRouterDeps`/`ApiServerDeps` gain a `copilot` bundle (boot wires the interim; evals cross-package consumers threaded). |
| `b482921` | A5 (desktop) | **Wire the page.** `createAskCopilot` (mirrors `createDrillDown`, folds err/transport → `{ok:false}`); `App.onAskCopilot` resolves the scope's workspaceId (fail-closed); AppShell forwards `onAsk`. Copilot's composer goes LIVE (Enter submits, chips prefill, turns render), a failed/malformed ask folds to a generic error turn. Robust `submit` (`finish()` always resets pending; collision-proof `ask-` ids). |
| `08cbf6e` | A6 (evals) | **Governance conformance suite** — a deterministic battery over the committed functions: read-only/no-side-effects, WS-8 no-cross-workspace-leak, egress veto (deny cloud+tunneled, allow local/ack-on/personal, narrow-only), and a **19-case leakage battery** (≥15 floor) proving no raw-content SHAPE survives the gate. The MODEL-PROSE eval (retrieval grounding + citation correctness) is explicitly DEFERRED (needs a real provider + labeled corpus). |

### Files
- **Created:** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx`, `apps/desktop/renderer/lib/copilot-ask.ts`, `apps/desktop/test-dom/copilot-panel.test.tsx`, `apps/worker/src/api/procedures/copilot.ts`, `apps/worker/test/api/procedures/copilot.test.ts`, `packages/evals/test/conformance/copilot-governance.test.ts`.
- **Modified:** `apps/desktop/renderer/chrome/AppShell.tsx`, `renderer/App.tsx`, `renderer/store/scope.ts` (`resolveWorkspaceId`), `renderer/lib/live.ts`, `renderer/styles.css`, `test-dom/app-shell.test.tsx`; `packages/contracts/src/api/ui-safe.ts` + `test/api/ui-safe.test.ts`; `apps/worker/src/api/procedures/queries.ts` + `server.ts` + `boot.ts` + 3 worker test files; `packages/evals/src/benchmarks/dashboard-warmload.bench.ts` + `src/worker-api-auth/auth-suite.ts` (dep threading).

## Decisions made

- **Copilot = right sidebar (per lock), not a nav page** — owner-confirmed via AskUserQuestion; corrected the handoff's framing.
- **Reuse `vetoJobEgress`, don't re-compose `egressVeto`** — the broker's certified composition adds the narrow-only route-identity guard; a bespoke composition dropped it (code-quality finding).
- **`resolveWorkspaceId` (new)** — the ASK-direction fail-closed gate (Global/unknown → null); `isWorkspaceScope` fails closed only for the push-fold direction.
- **The redaction/validation boundary is the procedure** (`toUiSafeCopilotAnswer`) — ports return candidate data; the ONE gate turns it UI-safe (mirrors the sibling read procedures).
- **Interim over stubs, honestly** — fixture retrieval + stub synthesis + the egress guard DEFERRED to the real synthesis adapter (the interim is local/no-egress, so the deferral is truthful, not a gap).

## Decisions explicitly NOT made (deferred — owner-visible)

- **The real model-prose eval** (retrieval grounding + citation correctness quality) — needs the AgentRuntimePort/ModelProviderPort wired to a real provider + a labeled corpus (PRD §20.1 / EVAL-1 floors). Documented in the A6 header.
- **Real GBrain/GCL retrieval** — no passage-serving read-model exists; the fixture retrieval is the interim.
- **The real synthesis adapter** — when it lands it MUST call `guardCopilotEgress` with the **authoritative Workspace record's posture** (type + egress policy resolved by workspaceId, NEVER client input), and fold a `question` length cap into the same follow-up (both are pinned forward obligations from the A3/A4 reviews).

## TDD compliance

- Deterministic slices test-first (RED→GREEN): A1 contract (freeze + leakage + behavior), A2 retrieval (WS-8 fail-closed battery), A3 egress guard + stub, A4 orchestration + gate + procedure. B1/B2/A5 render-tested (jsdom tier, LESSONS §4). ✓
- A6 is a conformance suite (the harness IS the deliverable; it exercises real behavior). The LLM synthesis is stubbed → the model-prose eval is deferred, not skipped. ✓
- No TDD violations.

## Reachability

Full end-to-end path is wired + tested: `Copilot` composer → `App.onAskCopilot` → `live.askCopilot` → `query.copilotAsk` → `answerCopilotQuestion` (retrieve → scope-guard → synthesize → gate) → `UiSafeCopilotAnswer` → rendered turn. `guardCopilotEgress` is tested-but-unwired BY DESIGN (the interim synthesis is local/no-egress; it's the gate the real adapter applies — documented at the wiring site).

## Open follow-ups

- **[owner] The real Copilot model path** — GBrain/GCL retrieval + governed LLM synthesis through the runtime/model ports, with `guardCopilotEgress` wired at route selection (authoritative Workspace posture) + the model-prose eval + a `question` length cap in the synthesis path. All pinned in the code (A3/A4 EGRESS NOTE + review flags).
- Inherited (unchanged): the §4.5 doc-pack Drive live path; audit-driven recent_changes + real project-sync projectors; the other 9.7–9.14 pages (each mounts on the AppShell/Route foundation); D2 gated global; live push; Projects listbox a11y; packaging.

## How to use what was built

Run with `devProvision` on → expand the Copilot rail in a workspace scope → ask a question. The interim returns an honest "nothing found yet" (fixture retrieval is empty per provisioned workspace) with real citations once a passage source exists. Under Global scope the composer is replaced by a "pick a workspace" state (WS-8). A failed ask shows a generic error turn — never raw content.
