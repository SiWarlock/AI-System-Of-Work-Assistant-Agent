# Session 028 — Real Copilot, Phase 1: egress governance + the Employer-Work notice

- **Date:** 2026-07-04 · **Mode:** single-operator (build, ultracode) · **Tracks:** contract · worker · desktop · evals
- **Predecessor:** `027-2026-07-04-approvals-page.md`
- **Successor:** `029-2026-07-05-RESUME-real-copilot-P2.md` (P2 in progress — P2.1/P2.2 done, P2.3 next)
- **HEAD at close:** `27aa649` (pushed origin/main) · **4 slice commits** (`56e9731` P1.1 · `a0c9e0a` P1.2a · `0fbf70b` P1.2b · `27aa649` P1.3)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; worker 424 · contracts 630 · desktop 172 · evals 148.
- **Reviews:** 6 subagent reviews (security ADVERSARIAL ×2 on the invariant slices + code-quality ×4). 0 critical/high. Plus a 5-agent parallel discovery **Workflow** that produced the P1.2 build spec.

## Why this session existed

The owner picked the deferred **real Copilot model path** (Track 2 from doc 026) — chosen scope: **full real path · Claude · full scoped-write tools**. This session built **Phase 1: the egress governance + the visible Employer-Work notice** — the owner's specific ask ("I'm fine with Employer-Work going to a cloud model, I just want some sort of notice"). (This session also earlier shipped §9.8 Approvals — see doc 027, already closed out + pushed at `06e4bbf`.)

## Tooling decisions locked (owner, this session)

Captured in memory `sow-copilot-real-model-direction`:
- **Auth = Claude SUBSCRIPTION, not an API key.** Route synthesis through the **Claude Agent SDK runtime** (`AgentRuntimePort` / `claude-agent-sdk-runtime.ts`) whose SDK I/O is behind an injected transport → subscription auth is a transport config. This **consolidates P2 (synthesis) + P4 (tools)** into one agentic runtime (native tool loop). Egress governance still applies (content → Anthropic cloud). Fallback: the API-key `claude-provider` behind the same broker.
- **GBrain ready** (`/setup-gbrain` run; Voyage `voyage-3` embeddings key set) → P3 wires the real read-only adapter.
- **Tools = API connectors** (injected HTTP transport) through the Tool Gateway envelope + **propose→Approvals** (§9.8 unblocks this). Granola + Asana in scope (Asana REST; Granola verify API — maybe read/ingest-only).
- **Per-workspace Google accounts** (work vs personal) → connector credentials resolve **per-workspace** via SecretsPort (reinforces WS-8 + the notice).

## What was built (P1 — 4 slices)

| Commit | Slice | Summary |
|---|---|---|
| `56e9731` | P1.1 (contract) | **`UiSafeCopilotAnswer.egressProcessor?`** — the notice carrier. Optional single-line label; its PRESENCE is the Employer-Work cloud-egress notice. UI-safe recipe (allowlist + `.strict()` + Exact + freeze + leakage test). |
| `a0c9e0a` | P1.2a (worker) | **`decideCopilotEgress`** (pure) — runs the fail-closed veto, then classifies the ALLOWED route with the **trusted `processorOfRoute`** (NOT `egressClass` — a tunneled-local route egresses but reads "local", which would miss the notice). Emits the notice iff employer-work AND the route egresses. + `WorkspacePosture`/resolver/selector ports, `buildCopilotJob`, interim fail-closed factories. |
| `0fbf70b` | P1.2b (worker) | **Wired into `answerCopilotQuestion`** — resolves the AUTHORITATIVE posture by `workspaceId` (server-side), selects a route, runs the veto BEFORE synthesis (fail-closed), threads `egressProcessor` through `toUiSafeCopilotAnswer` (strict-schema-gated). CopilotDeps + all 9 construction sites + boot's interim resolver. **Security M-1 discharged** (posture is server-resolved, never client input). |
| `27aa649` | P1.3 (desktop) | **The visible notice banner** in the Copilot sidebar — "Answered using `<processor>` — a cloud model — on Employer-Work content." Present only when the answer carries `egressProcessor`. |

### Files
- **Modified:** `packages/contracts/src/api/ui-safe.ts` (+test); `apps/worker/src/api/procedures/copilot.ts`, `src/boot.ts` (+copilot/queries/uiSafe/api-live tests); `apps/desktop/renderer/surfaces/copilot/Copilot.tsx`, `styles.css` (+copilot-panel test); `packages/evals/{test/conformance/copilot-governance.test.ts, src/benchmarks/dashboard-warmload.bench.ts, src/worker-api-auth/{auth-suite,exactly-once-suite}.ts}`.

## Decisions made

- **`processorOfRoute(route) !== null` is the egress predicate** (not `egressClass === "cloud"`) — the leak-safe classifier that catches tunneled-local egress. Pinned by a dedicated test (fails if the impl trusts `egressClass`).
- **Narrow `WorkspacePosture`** (`{type, dataOwner, egress}`) — exactly the veto's inputs; a synthesizer/selector can't reach `providerMatrix`.
- **Interim `EgressRouteSelector` returns a local route** — no `copilot.answer` capability route exists in any ProviderMatrix yet (arch gap), so a real matrix-driven `resolveRoute` would DENY for every workspace. Swap the adapter behind the port when the matrix entry lands.
- **boot's interim posture resolver** covers each dev-provision workspace (synthesized postures) → no `WORKSPACE_NOT_FOUND` regression; unrecognized ids default to the most-restrictive `employer_work` (never mislabel an unknown as personal).
- **The notice is server-derived + unforgeable** — `toUiSafeCopilotAnswer` never spreads the candidate, so a synthesizer can't inject/suppress `egressProcessor`; the strict schema hard-rejects a leak-shaped label.

## Decisions explicitly NOT made (deferred — P2+)

- **Real Claude synthesis** (P2) — swap `createStubSynthesis` for the Claude Agent SDK runtime on the subscription. **Needs the owner's one-time subscription-auth setup.** The real adapter MUST consume `decision.route` (else the veto is advisory — security carry-forward) and select a cloud route so the notice actually fires.
- **Real workspace_config resolver** — boot's interim posture resolver is synthesized; the authoritative path is `WorkspaceConfigRepository.get(id)` + a `copilot.answer` ProviderMatrix route (+ seed `workspace_config` in the provisioner).
- **Real GBrain retrieval** (P3), **full tools** (P4), **model-prose eval** (P5).

## TDD compliance

- Deterministic slices test-first (RED→GREEN): P1.1 (freeze + leakage), P1.2a (8 tests incl. the tunneled-local leak-safe pin), P1.2b (notice-on-employer-cloud, fail-closed-before-synthesis via throwing-fake, M-1 authority spy, unknown-workspace, local-no-notice, leak-label reject). P1.3 render-tested (jsdom, incl. false branch). ✓ No violations.

## Reachability

Full path wired + tested: `Copilot` composer → `App.onAskCopilot` → `query.copilotAsk` → `answerCopilotQuestion` (retrieve → scope → **resolve posture → select route → decideCopilotEgress (fail-closed veto) → synthesize → toUiSafeCopilotAnswer(egressProcessor)**) → the notice banner on the turn. The interim runs over a LOCAL route, so no notice fires yet — P2's real cloud synthesis is what makes it appear.

## Open follow-ups

- **[P2, owner] Real Claude synthesis on the subscription** — the next slice. Needs the subscription-auth setup + the real synthesis adapter consuming `decision.route`. Then the notice fires for real employer-work cloud asks.
- Carry-forwards (security/quality): bind `decision.route` to synthesis; the real `workspaceConfig.get` resolver + `copilot.answer` matrix route + provisioner `workspace_config` seed.
- Inherited (unchanged): P3 GBrain retrieval, P4 tools, P5 eval; §9.8 `UiSafeApproval` enrichment; the other 9.x pages.

## How to use what was built

With `devProvision` on, a Copilot ask over a workspace runs the full governed path but over a LOCAL route → an honest stub answer with **no** notice (correct — nothing egressed). The notice banner + the whole cloud path activate in P2 when the real Claude-subscription synthesis adapter selects a cloud route for an employer-work ask with egress-ack ON.
