# Handoff 004 — Remaining-work RESUME MENU (post-C6-(b), 2026-07-12)

> **Purpose:** the durable menu a fresh team finds on restart. Everything below is **owner-gated** (HITL, irreversible, external spend, or a hard-line flip) — the non-HITL deterministic runway is spent. This doc is the single "what's left + why it's gated + what unblocks it" list; it consolidates the deferred-HITL ledger. Companion: `docs/runbooks/run-it-live-and-provision.md` (Bucket A — how to run what's built).
>
> **Team:** `session-f2673cd5` (single-track, `main`). **Author:** orch13. **State at write:** local HEAD `048d13e` (+ this round's docs, UNPUSHED — round-seal, no push until owner go).

---

## You are here

- **origin/main = `762ae8a`** (C6-(a) go-live). **Local HEAD = `048d13e`** — C6 slice (b) landed (both b-1 briefing `b1048c3` + b-2 concept `048d13e`), plus this round's docs (UNPUSHED).
- **LIVE today (read-only, governed):** the Copilot on a scoped cloud Sonnet-5 agent — Q&A (`copilotAsk`), **briefing bound to §9.4 Today** (`copilotBriefing`, C6 (b)-1), **concept-synthesis** (`copilotConcept`, C6 (b)-2), plus `vault.read` + skill-introspection (C6-(a)). All egress-veto'd / candidate-gated / WS-8-scoped; propose OFF.
- **What's real vs inert:** see the Bucket A runbook's quick-reference table. Short version — control plane + desktop app + Copilot read/synthesis WORK; vault→ingestion is TEST-GATED; Keychain secrets + packaging are UNBUILT.

## The hard line (do NOT cross without owner go)

- **Propose / semantic-WRITE bridge stays OFF** (`copilotProposeMode` / `copilotProposeKnowledge`) — gated on the C5.4b serving oracle (item 1). Structurally off even if flipped (interim degraded provenance oracle ⇒ every ask `untrusted`).
- **No external fetch / no external write / no real API spend** without owner authorization.
- **WS-8 cross-workspace isolation** stays enforced (`decideHitScope` — foreign→DROP, ambiguous→DROP fail-closed).
- **Relaxed (owner 2026-07-12):** Employer-Work↔cloud **EGRESS** for the Copilot (reads + model outputs of employer-work content). The propose/semantic-WRITE bridge on employer-work content STAYS gated (item 7).

---

## REMAINING WORK / RESUME MENU (owner-gated)

Ordered biggest-lever first. Each: **what · current state · go-live gate/blocker · category.**

### 1. C6 Tier-4 — propose / semantic-WRITE bridge  *(the biggest)*
- **What:** the Copilot proposes a Markdown edit → §9.8 Approval → on approve, a head-at-commit KnowledgeWriter write. §13.10a, built end-to-end.
- **State:** **BUILT + DORMANT + structurally OFF.** Fully wired (trusted answer → `propose_knowledge` → PENDING §9.8 → approve → KW commit); flags `copilotProposeMode`/`copilotProposeKnowledge` OFF.
- **Go-live gate:** the **C5.4b serving oracle** — a real `admitForServing`-backed retrieval adapter that stamps `knowledge_writer` ONLY on genuine KnowledgeWriter-authored canonical Markdown (`apps/worker/src/api/procedures/copilotProvenanceStamp.ts`; 5 named preconditions in that file's header; security-review-gated). This is the single gate that lets `deriveCopilotContentTrust` ever return `trusted`. **⚠ A blanket stamp on gbrain hits re-opens the ING-7 bypass** — must be admitForServing-backed. Then the propose-path governance eval (`packages/evals`, eval-security) + real vendor I/O (running `gbrain serve --http` + KW-authored corpora).
- **Category:** hard-line flip (owner-gated) + a real deterministic build (the oracle).

### 2. C6 Tier-3 — ingest triggers
- **What:** auto-ingest sources into the vault/brain. Extractors exist (emit-only, dormant, over faked transports): file/PDF, web-article, podcast, YouTube (all emit `RegisterSourceInput` through the real `registerSource()` gate).
- **State:** **file = LOCAL, wireable non-HITL** (the C3b vault-watcher → `sourceIngestion`; TEST-GATED today — see Bucket A §3). **web/podcast/youtube = HARD LINE** (real external fetch).
- **Go-live gate:** file — set `vaultWatch` + real `vaultRoot` + `proofSpineParams` + a running local Temporal (the unbuilt-wiring gap; all local, no hard line). web/podcast/youtube — owner authorization for real external network fetch + real fetch transports (dormant injection points today).
- **Category:** file = local build (non-HITL, owner-run ops); others = external-fetch hard line.

### 3. C6 Tier-5 — external-action adapters
- **What:** the Copilot proposes an external action (Calendar / Todoist / Linear / Drive / GitHub) → §9.8 Approval → Tool-Gateway envelope → real external write.
- **State:** the Tool-Gateway envelope + approval + idempotency machinery is BUILT; the concrete vendor `AdapterTransport`s are placeholder injection points (built-OFF).
- **Go-live gate:** owner authorization for **external write + real API spend** + real vendor SDK transports + per-vendor secrets (blocked on item 5, Keychain). Depends on item 1's propose surface being live for the propose→approve→act loop.
- **Category:** external write + spend (hard line, owner-gated).

### 4. Write-through enablement + pin re-capture + gbrain SHA-identity
- **What:** flip GBrain write-through LIVE (fail-closed), one-time enablement precondition.
- **State:** the deterministic cores are BUILT (`decideWriteThroughEnablement` one-time flip-precondition; `checkVersionPin`/`pinValidatedForEnablement`). DORMANT.
- **Go-live gate:** the pin RE-CAPTURE + `writeThroughEnabled` flip are owner-gated HITL. **⚠ Known FINDING (banked, round 9):** gbrain 0.35.1.0 exposes NO local commit-SHA source → `checkVersionPin` can't SHA-match a real build (LOW on the non-HITL build [ships fail-closed], MATERIAL to write-through GO). The **gbrain SHA-identity decision** is the owner's version-pin-identity call, tied to pin re-capture.
- **Category:** owner-gated flip + a load-bearing version-identity decision.

### 5. 11.4 — secrets / macOS Keychain adapter  *(HITL, UNBUILT)*
- **What:** the real `KeychainSecretsAdapter` implementing `SecretsPort` (mac Keychain store/retrieve).
- **State:** **UNBUILT.** Only `FakeSecretsPort` (tests) + the LIFE-6 Keychain-*locked* degraded controller exist; config bars secret-shaped keys (`secretShapeGuard`). Interim provisioning = env vars + `claude` subscription login (Bucket A §5).
- **Go-live gate:** build the adapter (`ARCHITECTURE.md:317` names the design). Blocks any real per-vendor secret (item 3) and the HMAC provenance-signing key store (item 1's write path).
- **Category:** HITL build (owner-gated — touches the real Keychain).

### 6. 11.6 / 11.7 — packaging + notarization  *(UNBUILT, later)*
- **What:** a shippable notarized `.app`.
- **State:** UNBUILT. Known swaps: `child_process.fork`→Electron `utilityProcess` + `@electron/rebuild` for `better-sqlite3` + the `app://sow` prod paths (already coded, `!isDev`-gated).
- **Go-live gate:** owner-gated packaging work; a codesigning/notarization identity. Detail: `docs/spikes/0.1-electron-packaging.md`.
- **Category:** HITL / ops (owner-gated).

### 7. Employer-Work↔cloud EGRESS relaxation — *partially applied*
- **What:** allow raw Employer-Work content to reach the cloud Copilot (reads + model outputs).
- **State:** **APPLIED for the Copilot** (owner 2026-07-12: "don't care if cloud reads/writes employer-work stuff" — EGRESS scope only). The C6-(a)/(b) live Copilot already egresses served-workspace-own employer-work content under this relaxation.
- **Remaining:** the propose/semantic-**WRITE** bridge on employer-work content STAYS gated (folds into item 1's hard-line flip). No further action unless the owner widens the relaxation to the write path.
- **Category:** owner-relaxed (egress) / still-gated (write).

---

## Non-blocking residuals (banked, not owner-gated)

Carried in `IMPLEMENTATION_PLAN.md` Carry-forward — small follow-ons, no owner gate:
- **C6 (b) enrichments:** workspace-cards in the briefing (needs the UiSafe dashboard projector); real-adapter desc-sort+cap when producers land; quote-escape the concept-directive term (LOW, ≤ Q&A posture); the renderer "brief me" / "explain a concept" affordances (desktop track).
- **Eval-security follow-ons:** briefing + concept governance-eval cases (join `copilot-governance.test.ts`; coordinate — do NOT touch `../SoW-build-evalsec`).
- Older residuals (durability outbox, `close()` shutdown race, §16 doc-drift cleanup, `budget_exceeded`→`budget_breach`) — see the round-7 Carry-forward.

---

## How to resume (fresh team)

1. Read this doc + the Bucket A runbook (`docs/runbooks/run-it-live-and-provision.md`) + `IMPLEMENTATION_PLAN.md` "Currently in progress".
2. Confirm the owner's next target from the menu above (the menu is owner-decision-gated — pick with the owner, don't auto-start a gated item).
3. Non-HITL first mover if the owner wants forward motion without a gate crossing: **item 2 file-ingestion live-wiring** (set `vaultWatch` + real `vaultRoot` + `proofSpineParams` + run a local Temporal) — the only remaining item that's all-local and crosses no hard line, though it needs the owner's ops step (running Temporal + pointing at the real vault).
4. Everything else = escalate-before-crossing (hard-line flip / external spend / HITL build).
