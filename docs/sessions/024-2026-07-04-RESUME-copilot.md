# RESUME HANDOFF — build 9.6 Copilot (B = page shell, then A = retrieval+LLM+citation backend)

> **PROSPECTIVE handoff** (written for the next session, post-compaction). Predecessor: `023-2026-07-04-interim-recent-changes-projector.md`.
> Owner directive: *"do B and A and then whatever is next"* — build the Copilot PAGE SHELL first (B), then the Q&A BACKEND (A), then continue the roadmap.

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work Assistant BUILD — build 9.6 Copilot in two phases, B then A:
  B = the Copilot PAGE SHELL (a routable surface on the AppShell/Route foundation: chat UI —
      question input + answer area + citations rendering + the persistent "read-only, routes
      to a proposal" reminder; the live Q&A input SCAFFOLDED/disabled until A lands). Render-
      test it with the jsdom harness (test-dom/, LESSONS §4).
  A = the Q&A BACKEND (read-only, cited, NO side effects; §4.6): a UiSafeCopilotAnswer contract
      (answer + citations as opaque note refs/titles — no raw-content leak), a workspace-scoped
      knowledge RETRIEVAL path, GOVERNED-LLM synthesis through AgentRuntimePort/ModelProviderPort
      with the Employer-Work EGRESS VETO (raw employer content → a LOCAL zero-egress provider
      only, else fail closed), citations, a `query.copilotAsk({workspaceId, question})` read
      procedure, and the EVAL suite (packages/evals — the synthesis is model-driven, so
      EVAL-tested, NOT TDD). Then wire the page's input to it (B's scaffold → live).
Then continue with "whatever is next" (see the roadmap gaps below).

Read first: docs/sessions/024-2026-07-04-RESUME-copilot.md (THIS doc — full plan, slices,
invariants), then docs/design/ui-ux/ui-ux-spec.md §4.6 Copilot + §3 shell. HEAD at handoff:
71ec4f0 (pushed to origin/main).

Method (standing): TDD for deterministic/security slices (failing test first); the LLM synthesis
is EVAL-tested via packages/evals (you cannot unit-test model prose). Commit per slice (explicit
git add <path>, never -A; Conventional Commits + Co-Authored-By: Claude Opus 4.8 (1M context)
<noreply@anthropic.com>); ultracode; dispatch security-reviewer + code-quality-reviewer per slice
(security-reviewer on invariant/security-touching); run the REPO-WIDE `pnpm -w turbo run typecheck
test` after any port/contract change. New UI-safe contract = the allowlist + .strict() + Exact<>
parity + freeze-test recipe (see UiSafeManagedDoc as the latest example). Do NOT touch files from a
parallel session (they commit their own work to main — youtube-source/capture-source/PHASE-13). Push
at close-out. If running ultracode workflows, the model is up to you (opus is fine).
```

---

## Current state — what's DONE + PUSHED (do NOT rebuild)

HEAD `71ec4f0` on `origin/main`. This session (post-021) delivered, all security-reviewed clean:
- **Routing foundation + dedicated Projects page** (021): `renderer/store/route.ts` (`Route` union + `navigate` reducer, route ≠ scope), `renderer/chrome/AppShell.tsx` (the extracted shell — scope switcher/drill-down moved verbatim), `renderer/surfaces/projects/Projects.tsx` (list→detail, REQ-F-011, WS-8). **This is the foundation Copilot mounts on** — add a page = a `Route` variant + a `NavLink` + a surface component.
- **§4.5 doc pack** (022, DP-1/2/3): `UiSafeManagedDoc` + `docPack` contract, dev-provisioner writes it, the Projects-detail "Managed docs" section.
- **JSX-render test harness** (022, d): `test-dom/*.test.tsx` + `tsconfig.testdom.json` + `// @vitest-environment jsdom`; @testing-library/react. **Use this to render-test the Copilot page.** LESSONS §4.
- **c interim recent_changes** (023): dev-provisioner writes recent_changes; a SHARED `collapseToSummaryLine` in `@sow/contracts` (use it for any projector-built `summary`).

Gate: repo-wide `turbo lint typecheck test` **42/42**; desktop 127; contracts 52/52.

## The build — B (page shell) then A (backend)

### B — Copilot page shell (UI-first, render-tested). No backend needed.

- **B1 — route + nav (TDD the pure bits).** Add `{ surface: "copilot" }` to the `Route` union (`renderer/store/route.ts`); `routeEquals` already handles a no-payload surface. Add a **Copilot** `NavLink` in `AppShell` (mirror Today/Projects). `App.tsx` routes `copilot` → `<Copilot .../>`. Extend `route.test.ts`. Render-test the nav (mirror `test-dom/app-shell.test.tsx`).
- **B2 — the Copilot surface (`renderer/surfaces/copilot/Copilot.tsx`).** A chat surface (§4.6): a question **input**, an **answer/transcript** area, **citations** rendered as chips/links to source notes, and a PERSISTENT "This surface reads only — it never writes or sends; an action becomes a proposal that routes to Approvals" reminder. Under GLOBAL scope, a "Copilot reads a workspace's knowledge — pick a workspace (or the visibility gate)" state (WS-8-consistent). The live Q&A input is SCAFFOLDED/disabled ("Answering is coming up next") until A. `.sow-copilot-*` CSS. Render-test (empty state, the read-only reminder present, input disabled, WS-8 state). Optionally surface the existing `query.copilot` recent-runs read as "recent Copilot activity."

### A — Copilot Q&A backend (read-only, cited, no side effects; EVAL-tested)

- **A1 — contract (`UiSafeCopilotAnswer`, TDD).** `{ answer: string (single-line? or multi-line prose — decide + bound), citations: readonly UiSafeCitation[], ... }`; `UiSafeCitation` = an opaque note ref + a display title, NO raw content / path / URL (WS-8 / leakage-gate — mirror UiSafeManagedDoc's drop-the-handle posture). Frozen: allowlist + `.strict()` + `Exact<>` + freeze tests. Use `collapseToSummaryLine`-style bounding for any single-line field.
- **A2 — retrieval (worker/knowledge, TDD the deterministic parts).** A workspace-scoped read over the knowledge (GBrain/GCL) returning candidate context + source refs. WS-8: no cross-workspace retrieval (the GCL Visibility Gate is the ONLY cross-brain path). Fail-closed on unknown workspace.
- **A3 — governed synthesis (providers, EVAL-tested).** Route (question + retrieved context) through `AgentRuntimePort` / `ModelProviderPort`. **EGRESS VETO (safety rule 5):** raw Employer-Work content with egress-ack OFF may go ONLY to a LOCAL zero-egress provider (Ollama/LM Studio), else FAIL CLOSED — never a cloud fallback. **Candidate-data gate (rule 2):** the model output is candidate data until it passes the schema gate. **No side effects** (rule: read-only surface) — if the answer implies an action, emit a PROPOSAL that routes to Approvals, never a direct write. NOTE: the app currently runs over INJECTED STUBS (no real vendor I/O) — default synthesis to a local provider; the eval suite uses a stub/fixture provider.
- **A4 — API (`query.copilotAsk`, TDD the procedure/gate).** A read-only procedure `{ workspaceId, question } → Result<UiSafeCopilotAnswer>`; re-validates the candidate answer + citations; workspace-scoped; ING-7 if it ever consumes imported/untrusted content (read-only, tool-stripped).
- **A5 — wire the page (desktop).** B2's scaffolded input → `query.copilotAsk`; render the answer + citations; enable the input. Render-test the happy path + the read-only reminder.
- **A6 — eval suite (`packages/evals`).** Conformance for the synthesis: NO side effects, citations always present + workspace-scoped (no cross-workspace leak), egress-veto honored (employer-raw never leaves local), no raw-content in the projection. This is the coverage the LLM prose can't get from a unit test.

## Load-bearing invariants + safety rules (Copilot-specific — DO NOT break)

- **Read-only / no side effects** (§4.6) — Copilot NEVER writes or sends; an action becomes a proposal → Approvals. Enforce in A4 (no mutating path) + show the reminder in B2.
- **Employer-Work egress veto** (safety rule 5) — raw employer content + egress-ack OFF → local zero-egress provider ONLY, else fail closed. OpenRouter is its own processor, not an OpenAI alias.
- **Candidate-data gate** (rule 2) — model output is candidate until it passes the JSON-Schema gate + validator. No side effect before validation.
- **WS-8 isolation** (rule 4) — no raw cross-workspace retrieval; the GCL Visibility Gate is the single cross-brain read path; citations carry no raw content / handle.
- **Untrusted-content tool-stripping (ING-7)** — if a Copilot agent ever consumes imported/untrusted content, it runs read-only (no mutating tools), rejected at admission if it declares one.
- **Secrets** (rule 7) — provider creds via SecretsPort/Keychain only; never in Markdown/logs/renderer.
- **The routing foundation** — route ≠ scope (scope gates DATA, route selects SURFACE); mount Copilot as a Route variant, don't entangle with the scope switcher.

## Then "whatever is next" (after Copilot)

Owner-visible backlog (Carry-forward + roadmap gaps): the **audit-driven recent_changes + real project-sync projector** (blocked — owner to pick from the 3 options: interim / add-workspaceId-to-AuditRecord / bring-up-Temporal); the **§4.5 doc-pack LIVE path** (a Drive-backed projector + the re-add action, blocked on a Drive connector); the other **9.7–9.14 pages** (Ingestion Inbox, Approvals, Calendar, System Health, Connectors, Models, Audit, Workspaces, Settings) — each mounts on the AppShell/Route foundation; **D2 gated global surface**; **live push** for recent/projects; the Projects **listbox a11y** pass; **packaging** (utilityProcess + @electron/rebuild). Larger: bringing up **real Temporal** + **real vendor I/O** (the whole control plane runs over stubs today).

## Build/run + test reference

- `pnpm --filter @sow/desktop dev` — Electron + spawned worker. `devProvision` on → real Projects + Recent activity.
- Per-package `pnpm --filter @sow/<pkg> typecheck && test`; **repo-wide `pnpm -w turbo run typecheck test`** after any port/contract change. Render tests: `test-dom/*.test.tsx` (jsdom). Eval: the `packages/evals` harness.
