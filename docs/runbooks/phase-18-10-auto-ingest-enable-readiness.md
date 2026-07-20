# Phase-18.10 auto-ingest ARM — ENABLE-readiness evidence sheet

> **Purpose:** decision support for the owner ENABLE of task **18.10 — autoIngest gate arm** (G54).
> **Not a build.** Nothing here provisions, arms, or flips anything. Assembled by `main-orchestrator`
> (team `session-4f4687dd`) at HEAD `adab96ef`.
>
> **TL;DR:** the dormant build + dry-run verification for auto-ingest is **COMPLETE and green at HEAD**.
> There is **no remaining dormant wiring to build**. What "18.10 ARM" now means is *exclusively* the
> owner-gated live ENABLE (provision + running Temporal + flip). Turning it on = **autonomous extraction
> on each new source** (the source transport is already LIVE, Option B subscription).

> ⚠ **CORRECTION — Path-β enablement landed 2026-07-20 (supersedes §2 below).** §1's dry-runs were proven
> on a WORKER-side harness; the maiden run did NOT go live through the packaged app. Finding: the
> subscription-EXTRACTION arming (`config.subscriptionArm`) is a worker `BootConfig` axis that NO desktop
> config exposed — so through the app, an auto-fired source would run the UNARMED KMP stub and produce **no
> real note** (the silent-no-note L64 trap). The owner picked **Path β** — build the in-app capability +
> a committed go/no-go, then enable — now DONE + dormant: **18.31** `dd2ceaa4` (egress-allowlist seam) ·
> **18.32** `0d8e7c56` (desktop assembles the armed config from env) · **18.34** `fc3031f7` (native
> allowlisted `.env`) · **18.33** `db45eb6e` (the go/no-go harness).
>
> **Corrected in-app ENABLE (owner-gated, ⛔ HARD STOP):** set `SOW_SUBSCRIPTION_ARM=1` +
> `SOW_EGRESS_ALLOWED_PROCESSORS=claude-agent-sdk` + `SOW_MANAGE_TEMPORAL=true` + `SOW_VAULT_ROOT=<vault>`
> (all now loadable via the allowlisted `.env`), **AND** inject a worker-host-side real `checkReachable`
> (env-only arm stays HEALTH-denied by design). **GO/NO-GO — run FIRST ($0):**
> `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts` — proves the
> armed path produces a real note before any real spend. A green run is the flip precondition.

---

## 1. What is already built + proven dormant

### Gate wiring (all shipped, default-OFF, byte-equivalent when unset)

| Piece | Location | Behavior |
|---|---|---|
| `gateAutoIngest` | `apps/worker/src/boot.ts:665` | `opts.autoIngest !== true \|\| vaultRoot === undefined` ⇒ `undefined` (no watcher, no Temporal worker, byte-identical to today's boot). Armed ⇒ builds `{ vaultWatch, proofSpineParams, temporalAddress ?? "127.0.0.1:7233", stubExtraction? }`. |
| `startVaultWatcher` / `createVaultWatchHandler` | `apps/worker/src/watch/vaultWatcher.ts:311` / `:176` | `.md`-only; **feedback-loop exclusion** of the `sources/` output subtree (L37); realpath **root-confinement** double-guard; debounce; degrade-safe (a down Temporal / fs.watch throw never crashes boot, §16). |
| `buildProofSpineParams` | `apps/worker/src/temporal/registerWorker.ts:309` | Constructs the workspace policy / correlation / commit params consumed on the armed path only (thunk — never built on the OFF path). |
| Worker-host arming spread | `apps/desktop/worker-host/index.ts` (`config.vaultRoot` / `config.autoIngest` / `config.ingestWorkspaceId`; `SOW_MANAGE_TEMPORAL`) | The desktop host forwards the arming config with one spread; managed local Temporal spawns only on `SOW_MANAGE_TEMPORAL=true` **and** a dbPath. |

### Dry-run verification — all three checks GREEN at HEAD

Ran the four directly-relevant files: **28 pass / 0 fail / 8 skip**.

- **(a) benign source → real note** — `apps/worker/test/integration/vaultWatcher-live.test.ts::md_change_captures_and_dispatches` (a `.md` write under the vault root auto-captures → dispatches → the run reaches `applied`); reinforced by `sourceIngestion-live.test.ts` cases **(a)** happy-path→`applied`, **(d)** real local file→root-confined transport→live workflow→`applied`, **(e)** dispatch→terminal, **(g)** multi-file→two distinct notes. *(Injected watch/fs seams — no real spend.)*
- **(b) employer-raw denied on the auto path** — `apps/worker/test/composition/egress-veto-assembled.test.ts` (18.30): untrusted + read_only + employer-raw + ack-OFF + cloud `{runtime}` ⇒ `egress_veto` / `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` at the **real assembled** `broker.runJob`; + ING-7 `admission` reject for a mutating tool; + an ack-ON non-vacuity control. Plus `sourceIngestion-live.test.ts::(b)` malformed→REAL-gate reject→`failed_terminal`.
- **(c) watcher excludes its OWN outputs (no feedback loop)** — `vaultWatcher-live.test.ts` output-subtree guard block (6 tests): `output_subtree_note_does_not_dispatch`, `output_subtree_onEvent_arms_no_timer_zero_dispatch`, `exclusion_matches_real_derived_output_path` (tied to the producer's `SOURCE_NOTE_SUBTREE` constant — can't drift), `exclusion_is_root_anchored_and_separator_safe`, `md_only_scope_precedes_output_subtree`, `user_md_outside_output_subtree_still_dispatches`.
- **OFF byte-equivalence + arming guard** — `apps/worker/test/composition/boot-auto-ingest-gating.test.ts`: `gateAutoIngest` OFF is byte-equivalent + strict `=== true` truthy-not-`true` guard (`"true"`/`1`/`"false"`/`{}` ⇒ no-arm; L28/L50).

This matches last round's 18.30 conclusion (`9eb9dd99`): the trigger is *already* built + wired dormant end-to-end; only the owner-gated ARM remains. worker L67.

---

## 2. What the ENABLE actually is (owner-gated; ⛔ HARD STOP — lead+owner run)

The knobs, in order. All default-absent/OFF today.

1. **Provision a real vault path** — set `config.vaultRoot` (the Obsidian vault the watcher observes). Absent ⇒ `gateAutoIngest` returns `undefined` (stays dormant).
2. **Start a running local Temporal server** — `SOW_MANAGE_TEMPORAL=true` (the Phase-14 14.4 substrate: loopback-forced, env-gated, persistent `<userData>/temporal/dev.db`). `temporalAddress` defaults `127.0.0.1:7233`.
3. **Flip the arming opt-in** — `config.autoIngest === true` (strict); optionally `ingestWorkspaceId` / `ingestSensitivity`. Desktop env alias: `SOW_INGEST_WATCH`.

Files the flip touches: `apps/desktop/worker-host/index.ts` (arming provision) + `apps/worker/src/boot.ts` (gate wiring — already present).

---

## 3. What turning it ON MEANS operationally

- **Autonomous extraction on each new source.** With the source transport already LIVE (Phase-18 subscription crossing, Option B), every benign `.md` dropped in the watched vault auto-fires ingestion → real-model extraction → a KnowledgeWriter note, **on cadence, without a human in the loop per source**. This is the step-change from the maiden run (which was a single manual source).
- **Recurring subscription runs = routine cost.** Each auto-fired extraction is a subscription (Option B) run — **no marginal API spend**, the "$" figure is a metered estimate (owner recalibration [[subscription-runs-are-routine]]). Reserve heavy gating for real external writes / employer-egress / paid-key provisioning — not for subscription extraction volume.
- **The employer-egress veto STILL governs the auto path.** Proven at the assembled root (§1(b)): employer-raw + ack-OFF + a cloud route **fails closed** (`egress_veto`, no cloud fallback) even when auto-fired. Auto-ingest does not weaken rule 5. ING-7 (untrusted-content tool-stripping) also still governs (mutating-tool jobs rejected at admission).
- **No feedback loop.** The watcher excludes its own `sources/` output subtree (§1(c)) — a written note never re-fires ingestion.
- **Rollback = one flag.** Unset `config.autoIngest` (or `SOW_INGEST_WATCH`) ⇒ byte-identical dormant boot; no watcher, no Temporal worker, no spine activity.

---

## 4. One downstream go/no-go the flip alone does NOT satisfy (worker L64)

Arming the gate wires the *trigger*. For the auto-fired run to actually **produce a note** (not spend-and-produce-nothing), the source run leg must emit a real `agent_extraction` candidate:

- the arming bundle must supply a real `stubExtraction`/completion **and** flip its `outputSchemaId → sow:agent-extraction`, and
- the WORKER `CANDIDATE_MODEL_SCHEMAS` registry must have the `agent_extraction` parser registered (it is, as of the crossing — 18.11+),

else the armed run yields candidate → `schema_rejected` → EMPTY → no commit → **no note despite a real run**.

**Recommended go/no-go before the first autonomous cadence:** a **fake-completion dry-run** (real arm + broker + gate + KnowledgeWriter, fake SDK seam ⇒ `costUsd 0`) proving *broker-accepts + note-produced* — the same pre-spend gate the source maiden run used (L64). The spend-free arm-verify (CP2-style) can NOT catch this: the gap is downstream of the arm, in candidate→note. This is a **flip-time precondition the owner/lead should run**, not a dormant build item.

---

## 5. Bottom line for the ENABLE decision

- Dormant build: **DONE.** Dry-run (a)/(b)/(c) + OFF byte-equivalence: **GREEN at HEAD.** Nothing dormant-buildable de-risks this further.
- The ENABLE is a pure owner-gated live action (provision vault + running Temporal + `autoIngest===true`), reversible by one flag.
- Its real risk surface is **operational** (autonomous recurring extraction), not safety-structural (veto + ING-7 + feedback-guard all proven on the auto path). Subscription cost is routine.
- **Before the first autonomous cadence:** run the L64 fake-completion dry-run as the note-produced go/no-go.

_Refs: IMPLEMENTATION_PLAN 18.10 / 18.30; session doc 101; `docs/audits/18-crossing-*.md`; worker Lessons 37 / 50 / 57 / 64 / 67; `docs/runbooks/phase-18-subscription-enable-decision.md`._
