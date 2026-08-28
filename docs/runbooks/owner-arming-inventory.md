# Owner arming inventory — turn-on decisions, one page per crossing

**What this document is:** a map of every gated crossing between the system as it boots today and the
system with real external effects turned on. For each crossing it states what turns on, what it costs,
what must be true first, and what breaks if it is taken out of order.

**What this document is NOT:** an authorization. Nothing in this file arms anything. Every crossing below
still needs its own explicit owner confirmation, in the moment, per the `§ARM-*` ledger in
`IMPLEMENTATION_PLAN.md` and the matching phase in `docs/runbooks/turn-on-and-smoke-test-runbook.md`. Reading
this document and deciding "yes, go" are two different acts.

**Sources:** `IMPLEMENTATION_PLAN.md` "Owner gates & arming ledgers" (the `§ARM-*` entries) + every task
tagged `OWNER-GATED`, cross-checked against `docs/runbooks/turn-on-and-smoke-test-runbook.md` (the phase-by-phase
Preconditions / Activation / Smoke tests / Rollback narrative). Where the two sources disagree or one is
stale, this document says so rather than picking silently.

---

## The order that actually matters

The runbook numbers its sections 0→9 but that is **execution-order-within-Part-I**, not the dependency
graph. The true dependency order — stated explicitly in the runbook's own closing section and confirmed by
task `### 24.28` — is:

**Sequential chain (each depends on the one before it):**
Crossing 1 (Keychain) → Crossing 2 (real model transport) → Crossing 3 (reconcile/coverage) → Crossing 4
(serving-oracle trust) → Crossing 5 (external write) → Crossing 6 (propose flip, LAST of the chain).

**Two independent arcs (each needs only the early links above):**
Crossing 7 (per-vendor connectors — needs Crossings 1 + the connector engine, not 2–6) and Crossing 8
(research provider + living-vault schedule — needs only Crossing 1).

**The one correction worth memorizing:** the runbook's own section numbering puts "Phase 4" (serving-oracle,
Crossing 4) *before* "Phase 5" (reconcile, Crossing 3) on the page, but Crossing 3 must run **first** —
Phase 4's own Preconditions require a `ParityReport` that only Phase 5 produces. The runbook carries two
loud STOP blocks on this exact point (tracked as `### 24.28`); this document lists them in the correct
order (3 before 4) so you don't have to hold the correction in your head.

**A second structural note:** three of the eight numbered crossings (3, 4, and 6) are not independent
gates — they are three checkpoints inside **one** continuous 7-step sequence, `§ARM-GBRAIN`, because they
share substrate (the same Keychain key, the same gbrain HTTP client, the same corpora, the same governance
eval). Arming crossing 4 without having genuinely finished crossing 3 does not produce a shortcut — it
produces an oracle that is sound but permanently degraded. Treat 3→4→6 as one arc with three confirmation
points, not three separate decisions.

---

## Ranked at a glance

| # | Crossing | Ledger | Cost tier | Current state |
|---|---|---|---|---|
| 1 | Keychain HMAC signing-key provisioning | `§ARM-17` (+ step 2 of `§ARM-GBRAIN`) | **Cheap & safe** — local disk only, no network, no spend | Not yet crossed. Smoke test now PARTLY done: the `not_found` path is MEASURED against the live binary (`SOW_KEYCHAIN=1`); `locked`/`denied` + key-encoding still need a provisioned item |
| 2 | Real model transport under the egress veto | `§ARM-18` | **Consequential** — real cloud egress + real metered spend | **Partially crossed** — source-leg maiden run + auto-ingest Step-A both live; breadth held by owner |
| 3 | Reconcile / serving-coverage arc | `§ARM-GBRAIN` steps 1–4 | **Moderate, delicate** — read-only gbrain traffic, but a wire-shape slip can manufacture a false "complete" | Not crossed — the read transport is hardwired to a no-op, no trigger exists |
| 4 | Serving-oracle go-live (trust flip) | `§ARM-GBRAIN` (cont.) | **Moderate → consequential** — no write yet, but this is the gate that makes trust (and therefore writes) possible | Not crossed — depends on 3; rebuild-oracle producer unbuilt |
| 5 | External-write transport | `§ARM-21` | **Consequential** — the first irreversible write to a third party | Not crossed. ⚠ Corrected 2026-08-28: a real `AdapterTransport` DOES exist (`createWriteHttpTransport`, 21.6a) — dormant + unbound. Missing: a per-vendor `WriteHttpSpec`, a real `HttpTransport`, a bound `WriteTransportGate.make` |
| 6 | Propose / semantic-write flip | `§ARM-GBRAIN` (cont.) + Phase-22 tasks | **Most consequential in the sequential chain** — the only point where the agent's own output can become a durable change | Not crossed — depends on 3, 4, 5 |
| 7 | Per-vendor connector enablement | `§ARM-23` | **Consequential, per vendor** — real credentials + real outbound fetch, one vendor at a time | Not crossed — every vendor is adapter-built, transport-unbound; Gmail has no adapter at all |
| 8 | Research provider go-live + living-vault scheduling | `§ARM-RESEARCH` | **Consequential** — two paid keys + real external fetch of query text (which can carry vault content) | Not crossed — 2 of 8 named preconditions still open, 1 ambiguous (see below) |

Crossings 2 and 1 are listed above in dependency order even though 1 has not yet formally been crossed and
2 already partly has — see Crossing 2 below for the honest explanation of that gap.

---

## Crossing 1 — Keychain HMAC signing-key provisioning

**Ledger:** `§ARM-17` · Owner-Gates §ARM-17 · also step 2 of the `§ARM-GBRAIN` 7-step sequence.
**Unblocks:** the acceptance criteria for Phase 17 (task 17.4 is done; the phase-level acceptance is the
open OWNER-GATED item); it is the prerequisite for everything in the `§ARM-GBRAIN` arc (Crossings 3, 4, 6).

**What it turns on, in one sentence:** it lets the worker read one signing key out of your Mac's login
Keychain at runtime, so notes committed later can be cryptographically stamped as genuinely
KnowledgeWriter-authored — nothing is signed, verified, or served differently yet.

**Preconditions (verifiable):**
- macOS with `/usr/bin/security` present (true on every Mac) and the login keychain unlocked.
- Phases 0–2 of the runbook complete (worker boots; read/ingest healthy).
- You have decided the `service`/`account` naming (`keychain://sow-provenance-signing/hmac-key` is the
  runbook's recommendation) and generated a ≥32-byte-entropy key at provisioning time.

**Real-world cost:** effectively none. No network call, no external API spend, no Markdown write. The
only new runtime behavior is the worker being *able* to run `/usr/bin/security find-generic-password`
(absolute path, no shell, 5-second timeout, 64 KiB max buffer). This is the correct crossing to do first
specifically because it is close to free — it is also the first time a real macOS credential store is
touched, which is why the runbook still calls it a hard line and wants the real exit codes/stderr strings
verified against the live binary. ⚠ Corrected 2026-08-28 — they are no longer wholly unexercised: the
`not_found` path is now measured against the real binary by a `SOW_KEYCHAIN=1` test (see "Already verified
for you" below). `locked`, `denied` and the key-encoding round-trip still are, because they need a
provisioned or locked keychain.

**Note the scope of this specific crossing is narrow.** The `§ARM-17` ledger entry describes a broader
provisioning bundle — the HMAC key **plus** `providers/{claude,openai,openrouter}` **plus**
`embeddings/voyage` — but the runbook's own Phase-3 walkthrough scopes this crossing to the HMAC signing
key alone, and defers provider/connector/vendor tokens to their own later crossings (2, 5, 7). Today
`VOYAGE_API_KEY` is provisioned as a plain exported env var, not via this Keychain gate. Confirm which
scope you're actually provisioning before running the `security add-generic-password` commands — the two
sources do not agree on how much lands in this one crossing.

**What breaks if taken out of order:** nothing breaks by doing this alone — it is the safe one to do
early. What *does* break is treating "the key is in the Keychain" as sufficient for Crossing 4: it is only
one of several OFF-locks on the serving oracle (see Crossing 4).

**How to verify it worked:** `security find-generic-password -w -s <service> -a <account>` returns the
stored value at the CLI; the in-process adapter (`buildKeychainSecrets({})`) resolves it and returns
`ok(<N bytes>)` with N = stored length − 1 (trailing newline stripped); a bad/missing ref returns a typed
`secret_unresolved` error carrying only the ref and reason — never the key bytes or raw stderr; grepping
worker logs, health items, and the renderer for the key value returns zero hits.

**Already verified for you, BEFORE the crossing (2026-08-28).** Run it yourself any time — it provisions
nothing and reads no secret, so it needs no crossing:

```bash
SOW_KEYCHAIN=1 node_modules/.bin/vitest run --root apps/worker keychain-live-classifier
```

It drives the REAL production path (`buildKeychainSecrets({})` ⇒ the real bounded `execFile` ⇒ the real
`/usr/bin/security`) against a service/account that does not exist, and pins the measured result: exit `44`
⇒ backend kind `not_found` ⇒ port reason `missing` ⇒ facade `missing`. Until this landed, NO test had ever
spawned the binary — the whole path's contract with macOS was an assumption.

⚠ **What it does NOT cover, so do check these by hand while provisioning:** the `locked` and `denied`
classifications are still **assumptions** (reaching them means locking your login keychain or denying an
ACL — a test must not do that to your machine), and so is the key-ENCODING round-trip, which needs a
provisioned item. After you add the key, confirm the resolved byte length is exactly the stored length
minus the trailing newline, then lock the keychain (`security lock-keychain`) once and confirm the fault
reads `locked` rather than `missing`. `locked` is the one worth checking: it is the only reason treated as
RETRYABLE, so a mis-classification retries forever instead of surfacing a credential problem.

**How to back out:** remove `keychainSecrets` (and `provenanceServingOracle.signingKeyRef`) from the
worker-host config and relaunch — `buildKeychainSecrets(undefined)` constructs nothing and boot is
byte-identical to before. To remove the secret entirely: `security delete-generic-password -s <service> -a
<account>`. No durable side effects exist beyond the Keychain item itself.

---

## Crossing 2 — Real model transport under the egress veto

**Ledger:** `§ARM-18` · Owner-Gates §ARM-18.
**Unblocks:** the Phase-18 acceptance criteria (currently PARTIAL); real content flowing into the
ingestion spine, which everything downstream (Crossings 3, 4, 5, 6) ultimately needs something to reconcile
and trust.

**What it turns on, in one sentence:** it lets the extraction pipeline call a real Claude model — over your
local `claude` subscription login, never a provisioned API key — to turn a real meeting/source into a
structured note, spending real (small) metered subscription usage per call.

**Current state — read this before treating it as "not yet crossed":** this is the one crossing that has
**already partially happened**. The source-leg maiden run is complete (2026-07-18, `$0.044772` metered,
every safety check held) and the auto-ingest enable ran end-to-end once on a throwaway test vault
(2026-07-24, `$0.054601` metered). The **owner has explicitly held the full phase tick** — the remaining
breadth (meeting-close live arming, model-driven eval-class runs, a live `ProposedAction` real target, and
the in-app watcher's continuous auto-fire mode) is still gated and undone. Treat "some real spend already
happened safely" and "this crossing is fully open" as two different facts.

**Preconditions (verifiable):**
- `claude` CLI logged in locally; the worker runs with `ANTHROPIC_API_KEY` **unset** (an empty/stale key
  would shadow the subscription route by resolution precedence — this is load-bearing, not incidental).
- The subscription-shadowing env/settings guards (18.28→18.40, 18.36/18.39-B) are in place — these close a
  denylist-is-unwinnable problem by construction (minimal allowlisted child env + presence-degrade on any
  managed settings file), not by enumeration.
- `SOW_SUBSCRIPTION_ARM=1` + `SOW_EGRESS_ALLOWED_PROCESSORS=claude-agent-sdk` + a `$0` dry-run
  (`SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts`) green
  BEFORE any real run.
- No managed-settings file present on the host (an enterprise-MDM Mac degrades this path safely but
  loudly; a personal dev Mac is unaffected).

**Real-world cost:** real, metered API spend per call (capped at $1.50/run by SDK `maxBudgetUsd`, both
maiden runs came in under $0.06), and real content leaving the machine to Anthropic's API under your
subscription. For Employer-Work content specifically, the separate egress veto (rule 5) must resolve
`allowed` — see the Employer-Work note under Crossing 7/8's cost discussion; this crossing does not by
itself decide that.

**What breaks if taken out of order:** running this before Crossing 1 is fine (it does not depend on the
Keychain gate — subscription auth is ambient via `~/.claude`). Running the **continuous** auto-ingest
watcher before understanding it triggers *autonomous recurring* spend on a cadence (not a single manual
run) is the actual risk here — that is why the box stays owner-gated even after the one-shot proof succeeded.

**How to verify it worked:** a real run produces a schema-valid `agent_extraction` output, a committed
note, and a metered-cost log line under the cap; `childEnv` on the spawn is exactly the 8-key allowlist
with no shadow variable present.

**How to back out:** unset `SOW_SUBSCRIPTION_ARM` / `SOW_INGEST_WATCH`; the extraction path reverts to
disabled and no further spend occurs. Already-committed notes from prior armed runs are not rolled back —
they are ordinary vault content at that point.

---

## Crossing 3 — Reconcile / serving-coverage arc

**Ledger:** part of the `§ARM-GBRAIN` 7-step sequence (steps 1, 3 [wire-shape], 4).
**Runbook section:** "Phase 5" in the document, but **must run before "Phase 4."**
**Unblocks:** Crossing 4 (serving-oracle trust) cannot honestly go green without this.

**What it turns on, in one sentence:** after new content lands in the vault, the worker runs a real
comparison between the canonical committed Markdown and what the gbrain index actually holds, and stores
the verdict — this is the mechanism that later lets a trust decision say "verified," not just "unverified
by design."

**Preconditions (verifiable):**
- Migration `0006_parity_reports` applied on the running dialect (confirm the table exists before arming —
  a missing table fails safe but noisy).
- `SOW_VAULT_ROOT` set to the real served vault; `config.copilotGbrainWorkspaceId` set to the one served
  workspace.
- **Build-first, not yet done:** the GbrainReadGrant HTTP read transport is hardwired
  `makeDbAdapter: () => undefined` at `boot.ts:1348` — every armed reconcile today would record a
  permanently DEGRADED report. Nobody has bound the real transport.
- **Build-first, not yet done:** nothing in boot ever calls the reconcile scheduler's `enqueue`/`flush` —
  the trigger source does not exist (`boot.ts:629` is a doc comment, not code).
- **Build-first, not yet confirmed:** the exact field names the live `gbrain serve --http` read transport
  uses for "more results remain" (`hasMoreResultsSignal`) are a *documented candidate*, not yet verified
  against a live call. A pagination field named outside the documented set is the single most dangerous
  failure mode of this whole crossing — see below.

**Real-world cost:** low by itself — this is a read-only comparison against your own already-ingested
data, no external write, no new spend. The delicacy is not cost, it's **correctness under silence**: a
wire-shape mismatch here does not throw an error, it quietly reports a truncated read as "complete,"
which three phases later can look like a green light for trust.

**What breaks if taken out of order:** this is the crossing whose entire purpose is catching problems
*before* Crossing 4 trusts anything. Arm Crossing 4 first (which the runbook's own page order tempts you
to do) and you trust facts nothing has verified. This is exactly the mistake `### 24.28`'s two STOP blocks
exist to prevent.

**How to verify it worked:** a benign vault change produces exactly one persisted `ParityReport` row at
head revision; a genuinely divergent/unstamped fact produces `cleanForServing=false` plus an operator-
visible `parity_defect` health item (never a silent pass); a store fault degrades ALL legs, never a false
green; a truncated/unknown-paging read reports `coverageComplete=false`, never true.

**How to back out:** unset the reconcile env gate; `gateReconcile` returns undefined and nothing is
constructed. Already-stored `parity_reports` rows are harmless to leave — the serving gate re-scopes to
head revision and, with the rebuild-oracle leg still unbuilt, stays degraded regardless.

---

## Crossing 4 — Serving-oracle go-live (the trust flip)

**Ledger:** part of the `§ARM-GBRAIN` 7-step sequence (continuing from Crossing 3).
**Runbook section:** "Phase 4" — despite the page order, **read and complete Crossing 3 first.**
**Unblocks:** the single precondition that makes Crossing 6 (propose) even conceivable — no write
capability is grantable while every source resolves untrusted.

**What it turns on, in one sentence:** it lets a retrieved source that is provably KnowledgeWriter-authored
(HMAC-verified against committed Markdown) resolve as "trusted" to the Copilot, instead of every source
being permanently "untrusted" as it is today.

**Preconditions (verifiable):**
- Crossing 1 (signing key resolvable) and Crossing 3 (a `cleanForServing: true, coverageComplete: true`
  `ParityReport` at head revision) both genuinely complete — not just started.
- At least one committed `.md` note in the served vault carries a valid `kwStamp` frontmatter stamp.
- A passed governance eval for both the propose and read paths
  (`packages/evals/test/conformance/copilot-propose-governance.test.ts`) — coordinate with the
  eval-security track before arming, per this repo's CLAUDE.md.
- **Build-first, not yet done:** a rebuild-oracle build-status producer bound into the coverage reader's
  `resolveOracleBuild` dependency. As shipped this dependency is simply never passed, so `oracleBuildOk` is
  hardwired false — meaning even a perfect Crossing 1 + Crossing 3 cannot make coverage go green today.
  Arming the flag without this producer selects the real oracle, but it degrades on everything — sound,
  but observably nothing.

**Real-world cost:** no external write occurs at this crossing. The cost is entirely in what it *enables*
— it is the sole gate standing between "read-only forever" and "the model may hold a write tool." Get this
one wrong (a false-green coverage verdict) and an unverified fact can become an approved write later,
which is why the runbook calls this "the single most delicate mis-arm point in the whole go-live ladder."

**What breaks if taken out of order:** arming this before Crossing 3's build-first work lands is not
unsafe — the design is deliberately AND-composed so a missing leg just means "still degraded, nothing
observable." The actual risk is the opposite direction: believing this crossing is "live" because the flag
is set, without confirming the wire-shape check from Crossing 3 was done — that's the one path where "armed"
and "actually trustworthy" can silently diverge.

**How to verify it worked:** with the oracle unarmed, propose stays ungrantable even on a KW-stamped ask
(construction ≠ selection). Armed: a genuinely KW-authored, stamped note resolves `trusted`; an imported/
ingested note with no valid stamp stays `untrusted` even armed (the adversarial ING-7 test — this must
never flip); forcing any one coverage leg non-green collapses the whole verdict to degraded; a string
`"true"` (not the boolean) never arms it.

**How to back out:** set `copilotServingOracleGoLive: false` — the interim always-degraded oracle is
reselected immediately, byte-equivalent to the shipped default. No external or semantic write can have
occurred from this crossing alone; the write path is still behind Crossing 6, separately gated.

---

## Crossing 5 — External-write transport (first real outbound write)

**Ledger:** `§ARM-21` · Owner-Gates §ARM-21.
**Unblocks:** tasks 21.6, 21.7, 21.9 (real per-vendor transport, the Approvals-to-vendor terminal write,
NotebookLM back-sync).

**What it turns on, in one sentence:** it lets an approved action actually create an object at a real
third-party vendor (a Todoist task is the recommended first vendor) instead of an in-memory stub — this is
the first time the machine can act on the outside world.

**Preconditions (verifiable):**
- **Build-first — still true, but NARROWER than this entry used to say.** ⚠ CORRECTED 2026-08-28: the
  previous wording claimed "a grep of the whole tree finds **no** real `AdapterTransport` implementation
  anywhere — only the deterministic stub." That is **false at HEAD**. `createWriteHttpTransport`
  (`packages/integrations/src/tools/adapters/write-http-transport.ts`, task 21.6a) IS a real
  `AdapterTransport`: SSRF guard on the final url, header-only token via the 17.4 write-credential seam,
  positive-2xx gate, redacted faults. It is DORMANT and UNBOUND — which is not the same as absent.
  The CONCLUSION still holds: **this crossing cannot be flag-only.** Three pieces are genuinely missing,
  and they are the whole remaining list — a per-vendor `WriteHttpSpec` (none ships in `src`; only the
  interface and the factory), a real `HttpTransport` (Node `fetch`) implementation, and a bound
  `WriteTransportGate.make` (the gate ships UNBOUND). Plus, if the approval-card path is the trigger,
  replacing the currently no-op `dispatchApproval` stub.
  ⛔ Read `docs/findings/external-write-update-path.md` before crossing: the UPDATE path is broken and was
  twice reverted, and it is a fix-BEFORE-`§ARM-21` item. A doc-pack re-sync is exactly that path.
- Phase 2 (auto-ingest) ON — the propose activity that carries `dispatchExternalWrite` is only registered
  under Temporal when `proofSpineParams` exists, which requires auto-ingest + a vault root.
- The operational store is durable (a real `dbPath`, never `:memory:`) — the exactly-once receipt store is
  worthless if it evaporates on restart.
- A vendor credential provisioned via shell-exported env or Keychain — never in config/`.env` (the config
  loader's `secretShapeGuard` refuses secret-shaped values outright).

**Real-world cost:** genuinely irreversible from this system's side. Once armed and dispatched, an object
exists at the vendor; SoW cannot un-create it. This is why the runbook insists the very first armed write
be a disposable test object you can delete by hand at the vendor.

**What breaks if taken out of order:** arming the gate without the build-first transport does nothing
observable (writes still land on the stub — "succeed" locally with zero vendor effect), which is safe but
can be mistaken for success. The dangerous direction is the opposite: a real transport bound behind a gate
that a truthy-but-not-`true` value can accidentally satisfy — the gate is deliberately strict `=== true` +
`typeof make === "function"` specifically to close that.

**How to verify it worked:** with the gate off, zero HTTP requests leave the machine on a trigger (verify
via a network monitor). Armed: exactly one approved action produces exactly one vendor object and one
`write_receipts` row; replaying the same trigger reuses the receipt (`{status:'reused'}`, no second
object); a non-approved action never reaches the vendor at all (`approval_pending`, no existence probe, no
create); an unreachable vendor fails to `held`, never a speculative create.

**How to back out:** unset the arming input; `selectAdapterTransport` reverts to the stub on next boot.
Already-written vendor objects from the armed window are **not** rolled back automatically — delete them
manually at the vendor. If standing down for any reason beyond a routine pause, rotate the vendor token.

---

## Crossing 6 — Propose / semantic-write flip (last of the sequential chain)

**Ledger:** the tail of the `§ARM-GBRAIN` 7-step sequence, plus Phase-22 tasks 22.2 (external propose) and
22.3/22.4 (semantic propose) — all tagged Owner-Gates §ARM-GBRAIN.
**Unblocks:** nothing further downstream in the sequential chain — this is deliberately the last flip.

**What it turns on, in one sentence:** on a fully-trusted ask, the Copilot may call a `propose` tool that
records a PENDING approval card for you to review — and only on your explicit approval does anything
commit to the vault or dispatch externally. This is the only point in the whole system where the agent's
own output can eventually cause a durable change.

**Preconditions (verifiable — all of them, this crossing has the most stacked gates):**
1. Crossing 4 genuinely live (the real oracle selected, not just flagged).
2. Crossing 1's signing key still resolving.
3. Crossing 3's coverage genuinely green at head revision — including the rebuild-oracle leg, which per
   Crossing 4 is unbuilt as of this writing. **This crossing cannot honestly arm until that producer ships.**
4. The propose-path governance conformance suite green.
5. `proofSpineParams` provisioned (semantic flavour only) — requires auto-ingest ON.
6. Enable **exactly one** of `copilotProposeMode` / `copilotProposeKnowledge` — never both (the resolver
   fails closed to `read_only` if both are set; this guard is already built and pinned, task 22.5, done).
7. Your explicit confirmation at the moment of the flip.

**Real-world cost:** the highest-stakes flip in the sequential chain, but by design every individual write
still requires a second, separate human act (approving the card) — nothing here alone writes anything.
The cost is in what a *mistake in an earlier crossing* can now reach: if Crossing 4 ever produced a false
"trusted" verdict, this is the flip that turns that into a proposal a tired reviewer might approve.

**What breaks if taken out of order:** arming this before Crossings 3/4/5 are genuinely complete (not just
flagged) does not silently misbehave — every ask stays read-only, which is the single most likely failure
mode and is safe. The dangerous version is the inverse of "out of order": an untrusted/imported source ever
producing a proposal. If that is ever observed, the runbook calls it a critical security regression and
says roll back immediately.

**How to verify it worked:** a KW-authored ask produces a PENDING card and the vault is provably unchanged
until approval; the card appears in exactly the correct workspace's inbox and nowhere else; an untrusted
ask never produces a card; approving produces exactly one commit, traceable to the approval id; a
payload-swap replay on the same plan id is rejected, never silently overwritten; rejecting produces zero
writes; re-approving an already-committed card produces no second commit.

**How to back out:** remove the flipped flag and restart — the propose tool leaves the allow-list
immediately. Already-pending cards remain in the inbox for you to reject; nothing external or in the vault
can have been written by the sink alone. For a deeper stand-down, also disarm Crossing 4's oracle flag so
even a stray flag cannot reconstruct a trusted verdict.

---

## Crossing 7 — Per-vendor connector enablement (independent arc)

**Ledger:** `§ARM-23` · Owner-Gates §ARM-23. Gated only on the connector engine (Phase 16) and Crossing 1
(Phase 17) — **not** on Crossings 2–6.

**What it turns on, in one sentence:** for one named vendor at a time (Granola, Asana, Drive, Calendar,
Todoist, Linear, GitHub, or one of the URL/podcast/YouTube extractors), it replaces an in-memory mock with
a real network call to that vendor using a real least-privilege read credential.

**Preconditions (verifiable, per vendor):**
- **Build-first, universally:** a grep of the tree today finds no real vendor/HTTP/MCP transport anywhere
  — the only real transport in existence is the local-filesystem vault watcher. Each vendor needs its own
  build round (the adapter, gate, and KnowledgeWriter path are already built and shared; only the transport
  is missing).
- **Gmail specifically has no adapter file at all** — it needs an adapter built from scratch before any
  transport work, distinct from the other seven which are adapter-built/transport-unbound.
- A least-privilege READ-ONLY credential provisioned per vendor via Keychain (never a write scope).
- The vendor's wire shape is a documented Context7-grounded *candidate*, not yet live-verified — task 23.7
  is the explicit live-verification step, itself owner-gated because it needs the real API + a bound
  credential to run at all.

**Real-world cost:** real outbound network traffic to a named vendor using a real credential, one vendor
at a time. Each vendor's own crossing is independent — arming Todoist does not touch Asana. The
consequential part is credential provisioning + real fetch, not writes (every connector here is READ-only
by contract; the write path is entirely Crossing 5/21, a separate gateway).

**What breaks if taken out of order:** taking a connector live without the SSRF/egress guard confirmed on
the *resolved* IP (not just the original URL) reopens a DNS-rebind/redirect class of risk explicitly called
out for the web-source extractor. Batch-arming multiple vendors in one sitting is explicitly against the
runbook's own instruction ("do NOT batch-arm the set" — each vendor gets its own confirmed crossing).

**How to verify it worked:** one known item ingests to exactly one KnowledgeWriter-committed note (never a
raw file write by the adapter itself); grepping logs/health items for the credential token returns zero
hits; attempting a write/mutate call with the same read-only token fails `insufficient_scope` at the
vendor; running the same sync pass twice produces zero duplicate notes (content-hash dedupe); the note
carries the correct workspace id and is invisible cross-workspace.

**How to back out:** remove that vendor's config/credential and boot gate — construction reverts to
`undefined`, byte-equivalent to before that vendor was armed. Other already-armed vendors are unaffected
(per-vendor is the isolation boundary here).

---

## Crossing 8 — Research provider go-live + living-vault synthesis scheduling

**Ledger:** `§ARM-RESEARCH` · Owner-Gates §ARM-RESEARCH. Independent arc, gated only on Crossing 1.

**What it turns on, in one sentence:** it lets `/research` and `/research-deep` send your query text to
two paid cloud providers (Perplexity and xAI) and, on a schedule, lets a living-vault synthesis pass
propose vault updates from what comes back — always as a reviewable proposal, never an autonomous write.

**Preconditions — eight named items, verified against current task state (this crossing has the most
scrutiny of any in this document, because unlike the others its preconditions are individually numbered
tasks with their own done/not-done status):**

| # | Precondition | Status |
|---|---|---|
| 1 | Route the withheld PROPOSE tier into §9.8 Approvals (task 13.8i + the binding, 13.8i-B) | **CLOSED** — mechanism `a7d4ae9d`, composition-root binding `fdbc2c85` (2026-08-11), both source and meeting activity sites bound |
| 2 | `createIngestRewriteAdapter` ignores `validated` — synthesizes with no entity context | **OPEN** — no fix found in the plan; this is a real, currently-true gap |
| 3 | `gateLivingVaultRewrite` has no `bootWorker` call site — nothing constructs its deps | **OPEN** — the capability is inert by absence, not just by flag |
| 4 | Namespace entity stub paths so untrusted names can't collide with structural surfaces (13.8j) | **CLOSED** — `6dc6c34f` |
| 5 | Every path entering `groundedPaths` is shape-validated, on the meeting path (13.8k) | **CLOSED** — `3acb2e0b` |
| 6 | The SOURCE path gets the same grounded-path admission (13.8l) | **CLOSED** — `89eea8df` |
| 7 | Poisoned-row refusals reach an operator, not silence (13.8m) | **AMBIGUOUS — re-verify at the crossing.** The task's own "State" line (dated 2026-08-25) claims all four legs landed including the meeting-path consumer; an older note in the same task block, written before that leg landed, says the meeting path still has "a populated channel and no reader." The plan itself has not reconciled these two statements. Do not treat this as closed without re-checking the meeting-path consumer directly. |
| 8 | Cap the model-supplied `entityRefs` fan-out so a degenerate output can't drive an unbounded GBrain read loop (13.8h) | **CLOSED** — `bed423cb`, explicitly marked closed in-plan |

Net: **5 of 8 clearly closed, 2 clearly open (#2, #3 — both wiring gaps, not safety-design gaps), 1
genuinely ambiguous (#7) and worth a direct re-check before relying on it.**

**Real-world cost:** two new standing cloud-egress relationships (Perplexity + xAI), each its own paid
key, each its own egress-processor id (the plan is explicit that neither may ever be aliased to another
processor — doing so would let an Employer-Work ack-OFF job silently egress instead of failing closed).
Query text sent to these providers can carry vault-derived content, so this is a genuine new data-exposure
surface, not just a spend line.

**What breaks if taken out of order:** arming the flag while preconditions #2/#3 stay open means a run
would apply additive changes while synthesizing against **no entity-grounded context at all** — not
unsafe, but pointless, and easy to mistake for a working feature because nothing errors. Arming before
re-verifying #7 risks the exact failure mode 13.8m exists to prevent: a poisoned input and a benign empty
run becoming indistinguishable on the one path that hasn't confirmed its audit reader is real.

**How to verify it worked:** a live `/research` or `/research-deep` run reaches the real endpoint and
lands a candidate note through KnowledgeWriter, never a direct write; an Employer-Work ack-OFF run fails
closed at the live endpoint with no cloud fallback; `livingVaultSynthesis` runs on schedule with additive
changes AUTO and human-relevant edits PROPOSE-only.

**How to back out:** disarm the single default-OFF strict flag — the research processor leaves the
egress allowlist, no further external fetch occurs, and the schedule unregisters. Reject any lingering
pending research-derived proposals to confirm nothing is stranded.

---

## Closing notes for whoever runs this

- **This document does not authorize anything.** Each crossing above still needs its own explicit,
  in-the-moment owner confirmation, per its `§ARM-*` ledger entry and its runbook phase. Reading this list
  is not that confirmation.
- **Do not batch crossings.** The runbook is explicit about this for Crossing 7 and it applies in spirit to
  all of them — one crossing, one confirmation, one set of smoke tests, before the next.
- **The `§ARM-GBRAIN` arc (Crossings 3, 4, 6) shares one signing key, one gbrain client, and one corpus.**
  Don't re-derive "is this safe" independently for each of the three — verify the shared substrate once and
  carry that verification forward, but still get a separate confirmation at each of the three flip points.
- **Two crossings (3 and 8) have open build-first work that a flag cannot substitute for.** Arming without
  it does not misbehave — it produces an honestly inert result — but it is worth knowing which flips are
  "real work already landed, needs your go-ahead" (1, 2, 5-build, 7-per-vendor-build) versus "the
  mechanism itself doesn't fully exist yet" (3's read transport + trigger, 4's rebuild-oracle producer).
