# Runbook — Run it live + provision secrets (owner ops)

> **Audience:** the owner/operator, running SoW locally on macOS. **Status honesty:** every step is tagged **WORKS-NOW** / **WIRED-BUT-INERT** (code exists, a precondition/flag isn't met in the shipped app) / **TEST-GATED** (only runs under a gated integration test today) / **BUILT-BUT-INERT** (built + boot-wired, dormant behind an owner-provisioning/arming gate) / **UNBUILT** (owner-gated HITL slice not yet built). Anchors are `file:line`.
>
> **VERIFIED 2026-07-14 (after `daf17bc`)** — read+ingest path traced end-to-end + repo-wide green (worker 1285 / evals 492 tests pass; `typecheck`+`test` exit 0). This refresh corrects the prior draft (`048d13e`): the **macOS Keychain `SecretsPort` adapter (11.4) is now BUILT + boot-wired** (was "UNBUILT") and `copilot.vault.read` is **wired on any real vault** (the prior "inert" was an empty-default-vault artifact, not a missing wire — see §4). Boot anchors shifted (`bootWorker` is `boot.ts:849`, was `:473`); the internal `boot.ts` `file:line`s below are indicative of the current tree.
>
> **One-line reality:** the control plane is real and boots; the desktop app + the live Copilot **read + synthesis** path work today (given the env preconditions below); the **vault→ingestion** live loop works behind an owner opt-in (`SOW_INGEST_WATCH`). Nothing here crosses the hard line — **propose/semantic-write stays OFF** (its full machinery, incl. the reconcile-TRIGGER arc, is now BUILT + DORMANT; arming it is an owner-gated bundle documented in `copilot-propose-go-live.md`, NOT part of running the read path).

---

## 0. Prerequisites (one-time)

- **Node 22 LTS + pnpm.** `pnpm install` at the repo root.
- **`claude` CLI logged in** (this is how Copilot's Sonnet-5 synthesis is billed — a **subscription login, NOT an API key**; see §4).
- **`gbrain` on PATH + an initialized brain** for the personal-business workspace (Copilot retrieval + the managed `gbrain serve`).
- **`VOYAGE_API_KEY`** exported in the shell that launches the app (gbrain embeddings; see §4).
- *(optional, for the real Temporal path in §2/§3)* the **`temporal` CLI**.

There is **no `apps/worker` `dev` script** — the worker only runs (a) spawned by the Electron worker-host, or (b) inside gated integration tests. Everything reaches the worker through an injected `BootConfig` (`apps/worker/src/boot.ts:849` `bootWorker`); the worker itself never reads `process.env.SOW_*`.

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
| `copilotRealModel: true` + `copilotModel:"claude-sonnet-5"` (`:101-102`) | **`claude` CLI subscription login** (NOT an API key) |
| `copilotGbrainRetrieval: true` (`:107`) | `VOYAGE_API_KEY` in env + `gbrain` on PATH + an initialized brain |
| `copilotWorkspaceScoping: true` (`:128`) | realModel + retrieval on |
| `copilotAgentMode: true` (`:143`) | a running `gbrain serve --http --enable-dcr` (worker-host self-manages it: `MANAGE_GBRAIN_SERVE=true`, port 8899, `worker-host/index.ts:28,:79-92`) |
| `copilotVaultRead: true` (`:160`) | **WORKS on a real vault** — point `SOW_VAULT_ROOT` at your Obsidian vault. `gateCopilotVaultReadDeps` (`boot.ts:509`) wires the read-only `copilot.vault.read` tool when the flag is on + `vaultRoot` is defined + scoping is active (+ as of the usable-gate polish, task 13.10d, the vault has readable content). On the **default empty `<userData>/vault`** it is functionally inert (reads fail-closed to `SAFE_EMPTY`); the tool is simply not useful until a populated vault is pointed at. **WS-8:** for the served `personal-business` workspace a flat Obsidian vault works directly; notes for another workspace must live under a `<slug>/…` top-level dir (partition), else denied. |
| `copilotSkillIntrospection: true` (`:161`) | none (static catalog) |

**Reachability is closed:** with `copilotRealModel` on, `resolveCopilotWorkspaces` provisions the 3 well-known scopes so a `personal-business` ask resolves a posture and reaches gbrain retrieval **provided** `VOYAGE_API_KEY` + `gbrain` are in the env and the managed serve is up (`boot.ts:329-330,:693-699`).

**The hard line holds — propose/write is OFF and structurally off.** `copilotProposeMode` / `copilotProposeKnowledge` are deliberately unset (`worker-host/index.ts:158-159`); even if flipped, the interim always-degraded provenance oracle makes every live ask `untrusted` → never propose-capable. **Do not flip these** — going live is a **separate owner-gated ARMING bundle** (provision the signing key into Keychain + bind the reconcile `GbrainReadGrant` transport + real KW corpora + the governance eval + the owner-confirmed flip), documented in `docs/runbooks/copilot-propose-go-live.md`. The C5.4b serving oracle + the full reconcile-TRIGGER machinery (that would feed the serve-time coverage gate) are now **BUILT + DORMANT** — arming them is NOT part of running the read path here.

---

## 5. Provision secrets — env/subscription today; **Keychain `SecretsPort` adapter BUILT-BUT-INERT (11.4)**

**How secrets resolve today:** they don't go through a store — they're **environment-variable + subscription-login based**. Config files are actively *barred* from holding secrets: `load-config.ts` runs `secretShapeGuard`, which **rejects** any secret-shaped key/value (REQ-S-003, `apps/worker/src/config/load-config.ts:1-8`). So do NOT put keys in `.env`/config; export them in the launching shell's environment.

**The keys a read-only live run needs:**
1. **Claude Sonnet-5 (Copilot synthesis)** — **no API key, no env var.** The Claude Agent SDK `query()` auto-uses your local `claude` CLI login and bills the subscription (`packages/providers/src/model/claude-subscription-completion.ts:1-8`). Provision by logging into the `claude` CLI. *(`ANTHROPIC_API_KEY` is referenced only by an unused raw-Messages-API path, not Copilot.)*
2. **`VOYAGE_API_KEY` (gbrain embeddings)** — a plain env var; must be present in the process that launches the app (it flows to the managed `gbrain serve` and/or the CLI transport, `copilotGbrainSubprocess.ts:263-265`).
3. **HMAC provenance-signing key** — resolved through the only `SecretsPort` in the codebase (`packages/knowledge/src/knowledge-writer/provenance-stamp.ts:87`), used **only for the propose/write-through path — which is OFF**, so **not needed for a read-only live run**.

**NO LONGER A GAP — the real macOS Keychain `SecretsPort` adapter is BUILT + boot-wired (task 11.4), inert behind an owner-provisioning gate.** _(This paragraph corrects the prior draft, which said UNBUILT.)_ Built + green (adapter 10 / backend 14 / boot 11 tests): `apps/worker/src/secrets/keychain-adapter.ts` (`createKeychainSecretsAdapter` → `SecretsPort.resolveSigningKey`), `keychain-backend.ts` (`createSecurityCliKeychainBackend` runs `security find-generic-password -w -s <svc> -a <acct>`, args-array, no shell), `keychain-boot.ts` (`buildKeychainSecrets`, owner-provisioning gate); boot-wired at `boot.ts:1089`, INERT until `config.keychainSecrets` is provisioned. **It is needed only at ARMING** (to source the propose signing key) — NOT for a read-only run; the FIRST real Keychain touch is owner-gated. The LIFE-6 Keychain-locked degraded controller (`apps/worker/src/lifecycle/degraded/keychain-locked.ts`) handles a locked Keychain. **For a read-only run, provisioning is manual env/subscription as above — no Keychain needed.**
---

## 6. Packaging + notarization — **UNBUILT (later, 11.6/11.7)**

Deferred/owner-gated (`IMPLEMENTATION_PLAN.md`). Three known swaps when it's built: `child_process.fork` → Electron `utilityProcess` (IPC becomes `process.parentPort`, `worker-host/index.ts:8-12`) + `@electron/rebuild` for `better-sqlite3`'s Electron ABI + the already-coded `app://sow` prod renderer paths (`main/index.ts:35-49`). Detail: `docs/spikes/0.1-electron-packaging.md`.

---

## Owner-run verification checklist

Run these in order with **your** live login + vault to confirm each capability. These are **OWNER-RUN** steps (they need your `claude` login / `VOYAGE_API_KEY` / real vault — an assistant can't run them without your real credentials, and shouldn't incur real cloud spend on your behalf). Do the §0 prerequisites first.

- [ ] **Prereqs present** — `claude` logged in (a bare `claude` prompt responds); `echo "$VOYAGE_API_KEY"` non-empty; `gbrain` on PATH with an initialized personal-business brain; (optional, for ingest) the `temporal` CLI installed.
- [ ] **App boots (§1)** — `pnpm --filter @sow/desktop dev` → the window opens. System Health showing **Worker-down / Temporal-degraded is EXPECTED** without a running Temporal — reads don't need it.
- [ ] **Copilot read + synthesis (§4)** — open the Copilot right-sidebar, ask a question about your workspace → a grounded **Sonnet-5** answer. **WORKS-NOW** given the prereqs; if it errors, it's failing closed on a missing prereq (`claude` login / `VOYAGE_API_KEY` / gbrain serve), not a bug.
- [ ] **gbrain retrieval** — the answer **cites your notes** (retrieval reached gbrain). Ungrounded/empty answers ⇒ `VOYAGE_API_KEY` / `gbrain` / the managed serve aren't up.
- [ ] **`copilot.vault.read` (§4)** — launch with `SOW_VAULT_ROOT=/path/to/your/Obsidian/vault`; ask the Copilot to read a specific note → its content. Pointing at a real vault **Just Works** for the served personal-business workspace. (On the default empty `<userData>/vault` the tool is not offered — point at your real vault. Notes for another workspace must sit under a `<slug>/…` top-level dir — WS-8.)
- [ ] **Auto-ingest — drop `.md` → KW commit (§3)** — set `SOW_INGEST_WATCH=1` + `SOW_VAULT_ROOT` + a running local Temporal (§2), launch, drop a new `.md` into the vault → it lands as a **durable KnowledgeWriter note** (under `sources/<workspace>/…`) and System Health shows the `sourceIngestion` run `applied`. **WIRED (owner-opt-in).** This is a read/ingest capability (owner-approved-live) — it does **not** arm anything.
- [ ] **Phase-9 features** — Global Today, scope-aware reads, the Projects page, the Approvals inbox render (empty-until-data). **WORKS-NOW.**
- [ ] **Safety confirm** — no `copilotProposeMode` / `copilotProposeKnowledge` set (propose stays OFF); no signing key provisioned. Employer-Work→cloud egress is owner-relaxed **for the Copilot reads only**; WS-8 cross-workspace isolation stays airtight.

⚠ **Do NOT run the ARMING bundle from this checklist** — provisioning the signing key + the reconcile transport + flipping propose is a **separate owner-gated step** in `docs/runbooks/copilot-propose-go-live.md`. This guide stands up the **read + ingest** path only.

## Quick reference — what works vs what's blocked

| Capability | Status | To go live |
|---|---|---|
| Desktop app boot + renderer↔worker (loopback+token) | **WORKS-NOW** | — |
| Worker in Temporal-degraded mode | **WORKS-NOW** | — |
| Copilot read + synthesis (ask / briefing / concept) | **WORKS-NOW** | `claude` login + `VOYAGE_API_KEY` + `gbrain` serve up |
| `copilot.vault.read` | **WORKS on a real vault** | point `SOW_VAULT_ROOT` at your Obsidian vault (default empty vault ⇒ tool not offered, as of task 13.10d) |
| Vault → ingestion (drop many `.md` → each durably persists) | **WIRED (owner-opt-in)** | `SOW_INGEST_WATCH=1` + `SOW_VAULT_ROOT` + a running local Temporal (multi-file per ws works; per-source content-addressed notes) |
| Propose / semantic-write | **OFF (hard line)** | C5.4b serving oracle (owner-gated; do NOT flip) |
| macOS Keychain secrets | **BUILT-BUT-INERT (11.4)** | provision at ARMING only (`config.keychainSecrets` + a real signing key); NOT needed for a read-only run — interim = env vars + `claude` login |
| Packaging / notarization | **UNBUILT (11.6/11.7)** | fork→utilityProcess + `@electron/rebuild` + prod paths |
