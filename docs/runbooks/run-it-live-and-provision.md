# Runbook — Run it live + provision secrets (owner ops)

> **Audience:** the owner/operator, running SoW locally on macOS. **Status honesty:** every step is tagged **WORKS-NOW** / **WIRED-BUT-INERT** (code exists, a precondition/flag isn't met in the shipped app) / **TEST-GATED** (only runs under a gated integration test today) / **UNBUILT** (owner-gated HITL slice not yet built). Anchors are `file:line` at the time of writing (`048d13e`).
>
> **One-line reality:** the control plane is real and boots; the desktop app + the live Copilot **read + synthesis** path work today (given the env preconditions below); the **vault→ingestion** live loop and the **macOS Keychain secrets adapter** are the two real gaps. Nothing here crosses the hard line — propose/semantic-write stays OFF.

---

## 0. Prerequisites (one-time)

- **Node 22 LTS + pnpm.** `pnpm install` at the repo root.
- **`claude` CLI logged in** (this is how Copilot's Sonnet-5 synthesis is billed — a **subscription login, NOT an API key**; see §4).
- **`gbrain` on PATH + an initialized brain** for the personal-business workspace (Copilot retrieval + the managed `gbrain serve`).
- **`VOYAGE_API_KEY`** exported in the shell that launches the app (gbrain embeddings; see §4).
- *(optional, for the real Temporal path in §2/§3)* the **`temporal` CLI**.

There is **no `apps/worker` `dev` script** — the worker only runs (a) spawned by the Electron worker-host, or (b) inside gated integration tests. Everything reaches the worker through an injected `BootConfig` (`apps/worker/src/boot.ts:473` `bootWorker`); the worker itself never reads `process.env.SOW_*`.

---

## 1. Boot the desktop app — **WORKS-NOW**

```bash
pnpm --filter @sow/desktop dev
```

This runs `build:sow` (`turbo run build --filter=@sow/worker...`) + `build:worker` (`node worker-host.build.mjs`) + `electron-vite dev` (`apps/desktop/package.json:7-9`).

What happens:
- Electron **main** mints a per-launch session token (`apps/desktop/main/index.ts:120`) and **forks** the built worker host under **system `node`** (not the Electron binary — so `better-sqlite3`'s native ABI matches): `child_process.fork(../worker/desktop-host.mjs, execPath = SOW_WORKER_NODE ?? "node")` (`main/index.ts:79-87`).
- Launch config + token go over the **child IPC channel, never env/argv** (`worker-host/index.ts:219-228`); fields `{token, launchId, origins, hosts, apiHost, apiPort, dbPath, vaultRoot}` (`main/index.ts:68-78`).
- The renderer connects to the worker over **loopback + Bearer token** (`renderer/lib/live.ts:56-64`); the worker refuses non-loopback binds and enforces the Origin/Host allowlist server-side (`boot.ts:807-822`).

**Booting WITHOUT a local Temporal is SAFE and is the default** — the worker-host passes no `proofSpineParams`, so `connectTemporal()` degrades cleanly (no throw), records an operator-visible `worker_down` System-Health item (`boot.ts:864-878`), and brings the control-plane API + backends up regardless. You'll see "Worker down" in System Health; that's expected without Temporal.

> Dev-only vs prod: dev serves the renderer from Vite; the `app://sow` privileged protocol + prod paths activate only when `!isDev` (`main/index.ts:35-49,:124`). Packaging is a later step (§6).

---

## 2. Run the worker against a local Temporal — **owner ops step (dev-server not scripted)**

The local Temporal dev-server is **the owner's separate ops step — there is no pnpm script for it** (by design, `boot.ts:341`). The documented command (from the packaging spike):

```bash
temporal server start-dev --db-filename <app-data>/temporal.sqlite --ui-port 0
```
(`docs/spikes/0.1-electron-packaging.md:108`.) Default worker connect address is `127.0.0.1:7233` (`boot.ts:880`); task queue `PROOF_SPINE_TASK_QUEUE`.

**Caveat — the shipped desktop worker-host does not register a Temporal worker.** It passes no `proofSpineParams` (`boot.ts:855-862`), so even with a dev-server running, the desktop app boots Temporal-degraded. The **real-Temporal path is exercised today only via gated integration tests** (which spin an ephemeral server through `TestWorkflowEnvironment.createLocal()`, not `start-dev`):

```bash
SOW_TEMPORAL=1 pnpm --filter @sow/worker test    # runs the real-Temporal integration suites
```
(`apps/worker/test/integration/sourceIngestion-live.test.ts:307`, `vaultWatcher-live.test.ts:464`.)

> To make the desktop app itself run workflows live, the worker-host must be given `proofSpineParams` + a running dev-server — see §3, this is the same unbuilt-wiring gap.

---

## 3. Exercise real vault → ingestion — **WIRED (owner-opt-in, default-OFF; durably persists)**

**How it works:** a `node:fs` watcher on the vault root → a `.md` add/change → root-confined capture (C2) → dispatch (C3a) → a live `sourceIngestion` Temporal run → a **REAL KnowledgeWriter commit** (durable canonical Markdown), idempotent-replay across restart. The auto-ingest arc (slices 1/2a/2b — `727ab76`/`bbabd5f`/`a6cf0ec`) made this live behind an owner opt-in; `SOW_TEMPORAL=1` end-to-end verified.

**To turn it on** (the owner's step) — set these env vars in the shell that launches the desktop app (`main/index.ts` reads them → IPC → worker-host → `gateAutoIngest`):
- `SOW_INGEST_WATCH=1` — the opt-in. **Unset (default) = OFF** → today's degraded boot, byte-unchanged, nothing constructed, nothing persists.
- `SOW_VAULT_ROOT=/path/to/your/Obsidian/vault` — your REAL vault (default is `<userData>/vault`, NOT your vault).
- `SOW_TEMPORAL_ADDRESS` — default `127.0.0.1:7233` (override only if your dev-server differs).
- `SOW_INGEST_WORKSPACE` — default the canonical personal-business workspace.

Then run a local Temporal dev-server (§2) + launch the app (§1). Drop a `.md` in the vault → captured → `sourceIngestion` runs to `applied` → **durably committed to canonical Markdown by the KnowledgeWriter** (verify in the vault + System Health).

**Safety:** the write is the sanctioned KnowledgeWriter **sole-writer** path (safety rule 1) — NOT the propose bridge, NOT GBrain write-through. Default-OFF + owner-opt-in IS the activation authorization; `gateAutoIngest` returns undefined when unset so the durable store + commit deps are never even constructed.

> **Multi-file (RESOLVED 2026-07-13, `ac78327`):** many distinct files per workspace now persist — each becomes its OWN durable note at a per-source content-addressed path (`sources/<ws>/<sha256(sourceId,contentHash)>.md`, traversal-safe + ws-guarded). Same file re-dropped with the same content → idempotent replay (no duplicate); an EDITED file → a new note (lossless — true update-in-place is a flagged follow-on). Distinct files never collide.

---

## 4. Exercise the live Copilot (read + synthesis) — **WORKS-NOW (given the preconditions)**

The C6-(a) go-live turned the read+synthesis flags ON in the worker-host (`apps/desktop/worker-host/index.ts`). Ask via the renderer Copilot sidebar → `askCopilot(workspaceId, question)` → tRPC `query.copilotAsk` (`renderer/lib/live.ts:38,:93`). Fails closed to `{ok:false}` on any gate.

**As of C6 slice (b), two more on-request skills are live behind the same governed path** (read-only, egress-veto'd, candidate-gated, WS-8): **briefing** (`query.copilotBriefing`, bound to the workspace's §9.4 Today) and **concept-synthesis** (`query.copilotConcept`). Renderer affordances for these ("brief me" / "explain a concept") are a pending desktop-track follow-on — the worker procedures are live now.

**Flags ON today** (worker-host lines) + their runtime preconditions:

| Flag (worker-host) | Precondition to actually work |
|---|---|
| `copilotRealModel: true` + `copilotModel:"claude-sonnet-5"` (`:94-95`) | **`claude` CLI subscription login** (NOT an API key) |
| `copilotGbrainRetrieval: true` (`:100`) | `VOYAGE_API_KEY` in env + `gbrain` on PATH + an initialized brain |
| `copilotWorkspaceScoping: true` (`:121`) | realModel + retrieval on |
| `copilotAgentMode: true` (`:136`) | a running `gbrain serve --http --enable-dcr` (worker-host self-manages it: `MANAGE_GBRAIN_SERVE=true`, port 8899, `worker-host/index.ts:23-28`) |
| `copilotVaultRead: true` (`:153`) | **WIRED-BUT-INERT** — needs a real `vaultRoot` (currently `<userData>/vault`); until pointed at the Obsidian vault, `gateCopilotVaultReadDeps` leaves it inert (`boot.ts:442-450`) |
| `copilotSkillIntrospection: true` (`:154`) | none (static catalog) |

**Reachability is closed:** with `copilotRealModel` on, `resolveCopilotWorkspaces` provisions the 3 well-known scopes so a `personal-business` ask resolves a posture and reaches gbrain retrieval **provided** `VOYAGE_API_KEY` + `gbrain` are in the env and the managed serve is up (`boot.ts:329-330,:693-699`).

**The hard line holds — propose/write is OFF and structurally off.** `copilotProposeMode` / `copilotProposeKnowledge` are deliberately unset (`worker-host/index.ts:151`); even if flipped, the interim always-degraded provenance oracle makes every live ask `untrusted` → never propose-capable (`boot.ts:668-690`; see `docs/runbooks/copilot-propose-go-live.md`). **Do not flip these** — the go-live gate is the C5.4b serving oracle (Bucket B).

---

## 5. Provision secrets — env/subscription today; **Keychain adapter UNBUILT (11.4)**

**How secrets resolve today:** they don't go through a store — they're **environment-variable + subscription-login based**. Config files are actively *barred* from holding secrets: `load-config.ts` runs `secretShapeGuard`, which **rejects** any secret-shaped key/value (REQ-S-003, `apps/worker/src/config/load-config.ts:1-8`). So do NOT put keys in `.env`/config; export them in the launching shell's environment.

**The keys a read-only live run needs:**
1. **Claude Sonnet-5 (Copilot synthesis)** — **no API key, no env var.** The Claude Agent SDK `query()` auto-uses your local `claude` CLI login and bills the subscription (`packages/providers/src/model/claude-subscription-completion.ts:1-8`). Provision by logging into the `claude` CLI. *(`ANTHROPIC_API_KEY` is referenced only by an unused raw-Messages-API path, not Copilot.)*
2. **`VOYAGE_API_KEY` (gbrain embeddings)** — a plain env var; must be present in the process that launches the app (it flows to the managed `gbrain serve` and/or the CLI transport, `copilotGbrainSubprocess.ts:263-265`).
3. **HMAC provenance-signing key** — resolved through the only `SecretsPort` in the codebase (`packages/knowledge/src/knowledge-writer/provenance-stamp.ts:87`), used **only for the propose/write-through path — which is OFF**, so **not needed for a read-only live run**.

**THE GAP — the real macOS Keychain `SecretsPort` adapter is UNBUILT (task 11.4, owner-gated HITL).** There is no `KeychainSecretsAdapter` / `keytar` / `security find-generic-password` in `src` — only a `FakeSecretsPort` in tests; the design is named in `ARCHITECTURE.md:317`. What IS built is the *failure* half — the LIFE-6 Keychain-locked degraded controller (`apps/worker/src/lifecycle/degraded/keychain-locked.ts`), which handles a locked Keychain but does not resolve secrets. **Until 11.4 lands, there is no wired Keychain store/retrieve — provisioning is manual env/subscription as above.**

---

## 6. Packaging + notarization — **UNBUILT (later, 11.6/11.7)**

Deferred/owner-gated (`IMPLEMENTATION_PLAN.md`). Three known swaps when it's built: `child_process.fork` → Electron `utilityProcess` (IPC becomes `process.parentPort`, `worker-host/index.ts:8-12`) + `@electron/rebuild` for `better-sqlite3`'s Electron ABI + the already-coded `app://sow` prod renderer paths (`main/index.ts:35-49`). Detail: `docs/spikes/0.1-electron-packaging.md`.

---

## Quick reference — what works vs what's blocked

| Capability | Status | To go live |
|---|---|---|
| Desktop app boot + renderer↔worker (loopback+token) | **WORKS-NOW** | — |
| Worker in Temporal-degraded mode | **WORKS-NOW** | — |
| Copilot read + synthesis (ask / briefing / concept) | **WORKS-NOW** | `claude` login + `VOYAGE_API_KEY` + `gbrain` serve up |
| `copilot.vault.read` | **WIRED-BUT-INERT** | point `config.vaultRoot` at the real Obsidian vault |
| Vault → ingestion (drop many `.md` → each durably persists) | **WIRED (owner-opt-in)** | `SOW_INGEST_WATCH=1` + `SOW_VAULT_ROOT` + a running local Temporal (multi-file per ws works; per-source content-addressed notes) |
| Propose / semantic-write | **OFF (hard line)** | C5.4b serving oracle (owner-gated; do NOT flip) |
| macOS Keychain secrets | **UNBUILT (11.4)** | build `KeychainSecretsAdapter`; interim = env vars + `claude` login |
| Packaging / notarization | **UNBUILT (11.6/11.7)** | fork→utilityProcess + `@electron/rebuild` + prod paths |
