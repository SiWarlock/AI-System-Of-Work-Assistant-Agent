<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (control-plane worker (storage · Temporal · API))

> Full prose for every lesson logged during work in `apps/worker/`. The compact index lives in `apps/worker/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. On-request Copilot synthesis skills reuse a single-sourced governed core — never re-implement the gate

**Date:** 2026-07-12.
**Source slice:** C6 (b)-1 `b1048c3` (brief 040) + confirmed by (b)-2 `048d13e` (brief 041).

An on-request Copilot synthesis SKILL (Q&A, briefing, concept-synthesis, …) is a tRPC `.query()` procedure that **supplies its own retrieval** and then routes through the **one shared governed core** — never a re-implemented egress/gate. In `apps/worker/src/api/procedures/copilot.ts` that core is `runGovernedCopilotSynthesis(deps, workspaceId, question, scopedContext)` over `GovernedCopilotSynthesisDeps {synthesis, workspacePosture, routeSelector}`: WS-8 re-guard (`enforceRetrievalScope`) → authoritative server-side posture → route select → egress veto BEFORE synthesis → synthesize on the **veto-cleared route** (`decision.value.route`, never re-selected — the P1.2b binding) → `toUiSafeCopilotAnswer` candidate/UI-safe gate. `CopilotDeps` is just `GovernedCopilotSynthesisDeps` + `retrieval`.

What VARIES per skill is only the **retrieval source** and the **directive**; the safety machinery does not. Briefing (`copilotBriefing.ts`) supplies a `CopilotBriefingRetrievalPort` that assembles the §9.4 Today read-model into a `RetrievedContext` (already-UiSafe items + counts only — no-raw by construction) and a server-fixed `BRIEFING_DIRECTIVE`. Concept (`copilotConcept.ts`) reuses `CopilotRetrievalPort` (workspace knowledge) + a `CONCEPT_DIRECTIVE` framing — reusing the core so verbatim that `copilot.ts` was byte-unchanged (both Step-8 reviewers confirmed). Extracting the core once means the egress veto + candidate gate + WS-8 re-guard **cannot drift** between skills; adding a skill is a retrieval + a directive + a mount, reviewed against the same invariants each time.

Two corollaries worth keeping: (1) a skill with a **client-supplied** term (concept) carries the Q&A injection posture — bound it at the transport parser (`parseConceptInput`, ≤200 + single-line via a code-point guard, LESSONS Unicode-in-regex) — while a **server-fixed** directive (briefing) has a smaller surface. (2) When a retrieval reads a read-model whose **port** returns raw (e.g. `approvalInbox`→raw `Approval`), redact at the retrieval (read `.length` only), so no raw content enters the egressed `blocks` — no-raw *by construction* beats trusting a downstream projection.

**Rule:** an on-request Copilot synthesis skill supplies its own retrieval + reuses the single-sourced governed core (`runGovernedCopilotSynthesis`) — never a re-implemented gate; the retrieval source varies, the safety machinery does not.

## <a id="2"></a>2. Activate a built-but-dormant boot capability with a pure fail-safe gate helper (default-OFF)

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 1 `727ab76` (brief 042).

To make the shipped app run a capability whose machinery is already built but flag-gated, add a PURE `gate…(opts) → wiring | undefined` helper (mirroring `gateCopilotVaultReadDeps`, `boot.ts:441-463`): it returns the wiring object ONLY when the owner opt-in AND every precondition are present, else `undefined`. The worker-host reads owner config (env/IPC), calls the helper, and spreads the result into `bootWorker` — so with the opt-in unset the boot is **byte-equivalent to the prior degraded boot** (no new construction, no behavior change). Two properties make it safe: (1) any expensive/side-effectful dep is built inside a **thunk** the helper invokes only on the ON path, so the OFF path constructs nothing (unit-test that the builder is never called when OFF); (2) owner-configurability lives in the Electron `main` process (where `process.env` is already read) and threads through the IPC config the same way an existing field does — never hardcode a path (`gateAutoIngest` reads `SOW_INGEST_WATCH`/`SOW_VAULT_ROOT`/…, default OFF).

The security dividend: default-OFF + owner-opt-in IS the activation authorization. Nothing real happens until the owner opts in, so the review surface shrinks to "is the OFF path byte-unchanged, and is every ON-path dep behind the gate." A subtlety worth flagging at review: activating one capability can incidentally satisfy a DORMANT sibling's precondition (auto-ingest-ON defines `proofSpineParams`, which the propose/semantic-dispatch also needs) — call it out; the sibling stays off by its OWN designed locks, not by the incidental barrier you just removed.

**Rule:** activating a built-but-dormant boot capability = a pure fail-safe gate helper (default-OFF, thunk'd deps, owner-config not hardcoded) that augments `bootWorker` only when the opt-in AND its precondition are both present; the shipped default stays byte-equivalent to the prior boot.

## <a id="3"></a>3. A durable KnowledgeWriter-idempotency store is an operational-store repo, fail-closed both directions

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 2a `bbabd5f` (brief 043).

The `KnowledgeRevisionStore` that backs KnowledgeWriter exactly-once (`getByIdempotencyKey`/`record`) must be a real `@sow/db` operational-store repo, NOT an in-memory `Map` — the Map loses exactly-once across a worker restart (a fresh instance sees an empty store → re-commit). Build it as a Drizzle table keyed by `idempotencyKey` (PRIMARY KEY) with `INSERT … ON CONFLICT DO NOTHING` (first-write-wins: `record` returns void, so exactly-once == idempotent no-op, keeping the FIRST — this deliberately DIVERGES from sibling repos that signal a typed conflict, because the interface has no error channel). It passes the ONE `repository-contract.test.ts` suite on BOTH dialects (no dialect-specific SQL; Postgres never a stub). The durability property is inherently a FILE test (temp-file SQLite, close→reopen→fresh repo sees the row) — the in-memory contract suite structurally can't test restart.

The load-bearing safety property is **fail-closed in BOTH directions**: a real `DbError` on `getByIdempotencyKey` OR on `record` must PROPAGATE (reject), never be masked as `undefined`/swallowed — the only `undefined` is a genuine `not_found`. A masked lookup error reads to the writer as "no prior commit" → re-commit (duplicate); a swallowed `record` error means the writer believes it persisted when it didn't → replay re-commits. The consumer (the KnowledgeWriter `applyPlan`, via `createCommitActivity`'s try/catch) must honor the rejection as `commit_failed`, no re-commit. Adapter lives at the composition root (`apps/worker/src/composition/`) because `packages/knowledge` must not import `packages/db` (layer ban). Audit content persists summaries only (REQ-S-003 — no secret/raw column).

**Rule:** a durable KnowledgeWriter-idempotency store is an operational-store repo keyed by `idempotencyKey` (UNIQUE, first-write-wins), passing the one repo-contract suite on both dialects, fail-closed on BOTH `getByIdempotencyKey` AND `record` (reject, never mask); the in-memory Map is an honest interim that loses exactly-once across restart.

## <a id="4"></a>4. Activate a real sole-writer commit by swapping the fake for the existing adapter — never a new writer

**Date:** 2026-07-12.
**Source slice:** auto-ingest slice 2b `a6cf0ec` (brief 044).

To make a deterministic-fake commit leaf real, DON'T write a new writer — swap the fake `CommitKnowledgePort` for the EXISTING `createCommitActivity(deps)` (`packages/workflows/src/activities/commitKnowledge.ts`) over the sole-writer `applyPlan` (the meeting flow already uses it — mirror `buildActivities.ts:382-391`). Three details are load-bearing: (1) leave `ownershipCheck`/`secretScan` UNSET so `applyPlan`'s REAL defaults (`enforceHumanOwnership`/`scanForSecrets`) engage — a pass-through would silently disable the sole-writer + secret guards; (2) `expectedBaseRevision` must be a RESOLVER (`() => readVaultHeadRevision(vault)`) not a fixed value, because the live vault head moves between commits; (3) construct the real writer deps + durable store LAZILY behind the same default-OFF gate (rebind the shared `proofSpineParams.revisions` in `bootWorker` after backends are built, gated on `proofSpineParams !== undefined`) so nothing is constructed and nothing persists on the OFF path.

The fail-closed carry-forward from the durable store (lesson §3) is honored WITHOUT touching the sole writer: `createCommitActivity` already wraps `applyPlan` in a try/catch → `commit_failed`, and its doc-comment names the revision store as the throwing substrate — so a store rejection fails closed at the activity boundary. Verify (don't assume) the consumer catches it before concluding "no writer change." A post-commit `record`-reject is the writer's pre-existing `record-fault → System-Health` design: Temporal-retry → `not_found` → re-project onto the advanced head → empty diff → no-op (no duplicate). Watch for a DIFFERENT pre-existing gap the real commit EXPOSES: a fixed output path (`sources/<ws>/ingested.md`) that was harmless while the commit was fake becomes a collision once writes are real (→ a named per-source-path slice).

**Rule:** activate a real sole-writer commit by swapping the fake for `createCommitActivity` over `applyPlan` (real ownership/secret defaults + a live `readVaultHeadRevision` resolver + the durable store), behind the same default-OFF gate — never a new writer; verify the existing adapter honors the store's fail-closed.

## <a id="5"></a>5. A derivation must receive the per-item identity; a derived path must be traversal-safe by construction — and fork a shared port rather than dishonor it

**Date:** 2026-07-13.
**Source slice:** multi-file ingestion fix `ac78327` (brief 045).

Three durable lessons from making multi-file ingestion real:

**(1) A derivation collapses silently if it can't see what distinguishes its inputs.** The ingestion `build` derived a note path + planId from a STATIC boot binding (`sourceRef:"autoingest-src"` for every file) — so every dropped file produced the same planId → the durable store replayed the 2nd → ONE note, no error, "applied" each time. The real per-file identity (`context.source` = `file:<ws>:<relPath>` + `contentHash`) was in scope at the driver but never threaded into the `build` port. The build stage MUST receive the per-item identity; passing only `(validated, ws)` was the actual bug. Symptom to watch: a "successful" pipeline that silently produces one output for many distinct inputs (a replay-away, not a crash).

**(2) A derived filesystem path is an injection boundary — make the WHOLE path traversal-safe by construction.** Derive the variable segment as a `sha256` hex digest of the identity (a hash can't contain `..`/separators/NUL — safe by construction, deterministic, collision-free) rather than sanitizing a raw ref. AND guard every OTHER interpolated segment: `WorkspaceId` is a bare branded string (`ids.ts` rejects only empty/whitespace — NO charset validation), yet it's interpolated into `sources/${ws}/…`; an unsafe `ws` would break cross-workspace confinement. Guard it `^[A-Za-z0-9_-]+$` (anchored, ASCII — the JS `$`-without-`m` trailing-newline bypass must be empirically ruled out), fail-closed. Note the vault-root guard (`createFsVault.abs`) backstops only WHOLE-vault escape, not cross-workspace-within-vault — so the derivation-side ws-guard is the PRIMARY WS-8 cross-workspace defense. Narrow the derivation's INPUT TYPE too (`{sourceId, contentHash}`, not the full envelope) so attacker-influenceable fields (`origin`/`routingHints`) are structurally excluded from the path surface (least privilege).

**(3) When a shared port's consumers diverge, FORK it — don't dishonor it.** The `BuildOutputsPort` was shared by meeting-closeout, source-ingestion, AND hermes (cron/kanban — no `contentHash`). Adding a required per-file `source` to the SHARED port would have forced hermes to fabricate a fake contentHash (a dishonest param). The right move is a DEDICATED `SourceBuildOutputsPort` — the shared port stays byte-unchanged (zero regression by construction for the other consumers), and it matches the existing precedent (crossCalendar/projectSync already fork their own build-outputs ports). A port is shared only while its consumers' shapes coincide; when one genuinely diverges, forking is more honest + more conservative than widening.

**Rule:** thread the per-item identity into a derivation (a static seed collapses many inputs to one output silently); derive filesystem paths traversal-safe by construction (hash the identity + guard every interpolated segment incl. the workspace id, narrow the input type); and fork a shared port when a consumer diverges rather than forcing a dishonest param.

## <a id="6"></a>6. A trust label must be co-located with the bytes it vouches for — verify the consumer's pairing before compacting a positionally-paired array

**Date:** 2026-07-13.
**Source slice:** C5.4b slice 1 `4650ad4` (brief 046).

The Copilot content-trust decision stamps `sources[].provenance = knowledge_writer`, but the model synthesizes over `RetrievedContext.blocks` — a **separate array** from `sources`. So stamping a source trusted while leaving `blocks` untouched leaves a trust label sitting over bytes the gate never proved. The fix carries each admitted citation's rehydrated `AdmittedFact.content`+`mdContentSha` on the serving verdict and REBUILDS `blocks` from those proven bytes — a trust label and the bytes it vouches for must be co-located, never on two arrays that can disagree.

The load-bearing subtlety surfaced at Step 7.5: `buildCopilotUserPrompt` pairs `blocks[i]`↔`sources[i]` **positionally**. A first design "compacted" `blocks` to just the admitted subset (a shorter array) — which SHIFTS the alignment, so a proven excerpt renders under the wrong (untrusted) citation. The correct rebuild is POSITIONAL: `blocks = sources.map(s => admitted.get(s.citationId)?.content ?? "")`, preserving `blocks.length === sources.length` while still dropping unverified bytes (unadmitted → `""`). The general rule: before you compact/rebuild ONE of two positionally-paired arrays, read the CONSUMER and confirm its pairing contract — an index-keyed pairing turns "drop an element" into "misattribute every element after it."

Fail-closed axes to preserve on such a rebuild: a malformed verdict value (non-string content), a foreign/subset key, a degraded/empty verdict — each strips to all-untrusted with `blocks` untouched (never blank a read-only answer). Carry the proven `mdContentSha` even if unused today (honest verdict + enables a later content↔sha integrity re-check); the gate already proved integrity, so the decorator does NOT re-hash.

**Rule:** stamping a source trusted requires rebuilding the synthesized-over `blocks` from the SAME proven bytes (a trust label never sits on a separate array the model reads); and before compacting one of two positionally-paired arrays, verify the consumer's index-pairing contract — rebuild positionally (`""` at dropped indices), never compact.

## <a id="7"></a>7. A serve-time coverage/health reader with no persisted source degrades HONESTLY — a fail-closed constant + an in-code note naming the missing store, never a green stub

**Date:** 2026-07-13.
**Source slice:** C5.4b slice 2 `286910f` (brief 047).

Building the serving oracle's boot-side readers surfaced that there is **no serve-time `ParityReport` store** — the reconciler produces reports but nothing persists/queries them at serve time (`write-through-flag.ts` takes `latestParityReport` as an INJECTED input, not a stored read). The honest reader (`createServingCoverageReader`) therefore returns `parity = undefined` and `oracleBuildOk = false` UNCONDITIONALLY (both force `isDegradedCoverage`), with only `pinValid` a real signal (via `checkVersionPin`). Crucially it is a REAL adapter that degrades because the source is absent — NOT a stub that fakes green — and an in-code comment NAMES the missing store as the injection point, so a future slice wiring real parity persistence knows exactly where it plugs in (this is the C5.4a honest-interim pattern applied to a coverage/health leg). A green stub would be a silent false-positive on the trust gate; a documented fail-closed constant is safe and self-explaining.

Two reader-design corollaries banked here: (1) the committed-vault reader skips a listed-but-unreadable `.md` and returns the READABLE subset (undefined only when zero remain) — an incomplete allow-set can only make a citation WITHHOLD (fail-safe), never falsely admit, so a race-deleted file shouldn't degrade the whole workspace; a genuine list/read THROW fails the whole read closed. (2) When a read seam is synchronous but its real implementation needs async I/O, widen the seam to the codebase's existing sync-OR-async `MaybeAsyncResult` union (`(x) => T | undefined | Promise<T | undefined>`) + one `await` at the consumer (a no-op on a sync value) — this fits the real async reader with ZERO ripple to existing sync fakes, and reuses an established precedent (`CopilotRetrievalPort.retrieve`) rather than forcing every fake to become async.

**Rule:** a serve-time coverage/health reader with no persisted source degrades honestly (a fail-closed constant + an in-code note naming the missing store as the injection point), never a green stub; incompleteness must fail SAFE (withhold, not admit); widen a sync seam to the `MaybeAsyncResult` union rather than rippling async through every fake.

## <a id="8"></a>8. A go-live seam is AND-composed of independent OFF-locks — each alone keeps the capability OFF, and the shipped default stays byte-equivalent

**Date:** 2026-07-13.
**Source slice:** C5.4b slice 3 `3d56dc6` (brief 048).

Wiring a safety-critical capability into boot so it is CONSTRUCTIBLE + proven-selectable but stays OFF is best done as several INDEPENDENT OFF-locks, each individually sufficient to keep the capability off (defense-in-depth beyond the single flag of Lesson 2). The serving oracle's go-live seam has three: (1) the arming flag `copilotServingOracleGoLive` unset (default) ⇒ `goLiveArmed` false ⇒ the selector returns the interim degraded oracle; (2) `loaderBacked` is constructed ONLY when a signing key is provisioned, so absent a key it is `undefined` and the selector's `goLiveArmed && loaderBacked!==undefined` guard falls back to interim — a STRUCTURAL lock (the Keychain SecretsPort is HITL/unbuilt, so this holds today even if the flag were flipped); (3) the real coverage reader degrades by reality (`parity===undefined`) and is NOT config-defeatable (no `BootConfig` field can inject green coverage — that lives only in tests). Verify the locks are genuinely independent by adversarial pairwise-defeat: defeat any two, the third must still hold the line, and NO config combination admits a non-KW source.

Two properties keep it safe + reviewable: (a) the shipped default (all new config fields absent) is BYTE-EQUIVALENT to pre-seam — pin it (unset ⇒ interim selected, nothing new constructed); (b) extract the go-live logic into PURE helpers (`buildServedVaultResolver`, `buildLoaderBackedServingOracle`) so it is unit-testable without booting the huge async `bootWorker`, and construct nothing eager on the OFF path (the factory defers the fs-backed loader/readers/gate until called). WS-8 on a shared single dev vault: the resolver maps ONLY the single served workspace to the one vault (a second workspace can never resolve to it; unset ⇒ empty map ⇒ all degrade), with the writer's HMAC (binding `workspaceId`) as the real backstop — a mis-resolved foreign vault's notes fail `signature_invalid`.

**Rule:** a go-live seam is AND-composed of independent OFF-locks (arming flag AND a provisioned key AND real coverage) — each individually sufficient to keep the capability OFF, proven by adversarial pairwise-defeat; the shipped default stays byte-equivalent to pre-seam, and the go-live logic lives in pure, unit-testable helpers that construct nothing on the OFF path.

## <a id="9"></a>9. A secrets adapter maps EVERY fault to a typed ref-only error, never throws, holds key bytes only transiently — real I/O behind a mockable backend seam

**Date:** 2026-07-13.
**Source slice:** 11.4 slice 1 `4010155` (brief 049).

The `KeychainSecretsAdapter` implementing `SecretsPort.resolveSigningKey` maps every failure mode to a typed `SecretUnresolved` carrying ONLY the opaque ref + a FIXED class token (`missing|locked|denied|backend_error|invalid_ref`) — never the key bytes, never a backend's raw stderr/`detail` (the seam's optional `.detail` exists for backend-isolation debug and the adapter DROPS it). The adapter never throws (a throwing/rejecting backend, a rogue/prototype `kind`, a malformed ref — all fail-closed to a typed err; `Object.hasOwn`-guard the reason lookup). Key bytes pass straight through as `Uint8Array` (never `.toString()`/stringified/logged), held only in the return binding; a ZERO-LENGTH key is REJECTED (never serve an empty HMAC key). The opaque `keychain://<service>/<account>` ref is parsed fail-closed (exactly 2 non-empty segments, a bounded charset that bars `.`/`..`/leading-`-`/shell-metacharacters, a length cap) with ZERO backend calls on a malformed ref.

Structure real I/O behind a MOCKABLE backend seam (`KeychainBackend.read(service, account)`), so the adapter core + all its tests run against a fake in-memory backend and the BUILD never touches the real Keychain — the real backend is a separate slice, wired only under owner provisioning. A distinct `invalid_ref` reason (config error) vs the Keychain-runtime faults matters: the boot-side degraded controller routes runtime faults to the retryable-on-unlock path but a bad ref to a NON-retryable config surface.

**Rule:** a secrets adapter maps every fault to a typed ref-only error (a fixed class token, never the value or raw backend detail), never throws (fail-closed on rogue kind / malformed ref / backend throw), holds key bytes only transiently (never stringified/logged; reject a zero-length key), fail-closed-parses the opaque ref (0 backend calls on malformed), and puts real I/O behind a mockable backend seam so the build never touches the real store.

## <a id="10"></a>10. A CLI-backed secrets reader: args-array + absolute bin, secret only in the ok Result, robust stderr-pattern faults — and de-alias returned bytes (a Buffer's `.slice` shares memory)

**Date:** 2026-07-13.
**Source slice:** 11.4 slice 2 `4db092e` (brief 050).

The `security find-generic-password` backend runs over an INJECTED, mockable execFile-shaped `exec` seam (so the parse is unit-tested against synthetic `{code, stdout, stderr}` — the real `security` binary runs only at owner-provisioning). Invoke the ABSOLUTE bin `/usr/bin/security` (no PATH lookup ⇒ no binary-hijack) with an args ARRAY (never a shell string); argv-injection is then structurally impossible — no shell, absolute bin, getopt OPTION-VALUE semantics (a leading-`-` value after `-s`/`-a` is consumed literally, never reparsed; a `--` separator is inapplicable here and would only risk enabling the unwanted trailing `[keychain]` positional). Classify faults by STDERR PATTERN (`\blocked\b` word-boundary, "interaction not allowed" ⇒ locked; "denied"/"not authorized"/"auth failed" ⇒ denied; else backend_error) not brittle numeric codes — with an in-code note to verify the real codes/strings against the live binary at provisioning; a fault can NEVER map to code 0 (garbage stdout on spawn-failure/timeout is never mistaken for a success value). Rule 7: the `-w` stdout IS the secret — it reaches ONLY the ok `Uint8Array`; the fault path reads ONLY code+stderr (stdout can't reach `detail` by construction); `detail` bounds ≤200 + scrubs secret-shaped runs.

**The load-bearing gotcha (a review catch):** DE-ALIAS the returned key bytes with `new Uint8Array(bytes.subarray(0, end))`, NEVER `bytes.slice(0, end)` — a Node `Buffer` (exactly what the real execFile yields) OVERRIDES `Uint8Array.prototype.slice` with shared-memory VIEW semantics, so `.slice` would silently alias the ~4KB allocation pool on the ONE path carrying a real secret (a heap-leak vector invisible to a test that uses a plain `Uint8Array`). The `subarray`-into-a-fresh-`Uint8Array` constructor always copies, Buffer or not — pin it with a `Buffer.alloc(...).subarray(...)` input test.

**Rule:** a CLI-backed secrets reader uses an args-array + absolute bin (no shell, no PATH), returns the secret ONLY in the ok Result (fault path never reads stdout), classifies faults by stderr PATTERN with a live-verify note (a fault never maps to code 0), bounds+scrubs any debug detail — and DE-ALIASES returned bytes via `new Uint8Array(subarray)`, NEVER `.slice` (a Node Buffer's `.slice` shares the backing pool).

## <a id="11"></a>11. A real-I/O adapter is boot-wired behind an owner-provisioning gate — default-absent ⇒ inert/byte-equivalent, the real backend built only on the provisioned path

**Date:** 2026-07-13.
**Source slice:** 11.4 slice 3 `536d3b2` (brief 051).

Wiring a real-I/O adapter (the Keychain `SecretsPort`) into `bootWorker` is done behind an owner-provisioning GATE (`BootConfig.keychainSecrets`, absent by default). `buildKeychainSecrets(gate)` constructs the adapter + the real bounded no-shell execFile backend ONLY when the gate is present, returns `undefined` otherwise — so the shipped default spawns NO real process and is byte-equivalent to pre-slice. Pin the inert default with a factory SPY asserting ZERO off-path invocations of the real-exec factory (not just "returns undefined"). Source the one live consumer fail-closed-first: `provenanceServingOracle.secrets = keychainSecrets?.secrets ?? bundle.secrets` (the gate is the real source; the inline bundle stays a test fallback; making the field optional keeps the prior assembly tests green AND makes OFF-lock 2 more fail-closed — omission ⇒ interim). A facade for a NOT-YET-WIRED consumer (the provider `getSecret`) can ship built+tested with an explicit reachability sub-note, but do NOT thread it into a dormant path — defer that (and a degraded-controller routing whose call-site is dormant) to a named follow-up slice rather than wiring dormant-on-dormant with nothing to exercise.

**Rule:** boot-wire a real-I/O adapter behind an owner-provisioning gate (default-absent ⇒ inert, byte-equivalent, the real backend/process built ONLY on the provisioned path — pinned by a factory-spy zero-invocation assertion); source the live consumer fail-closed (`gate?.x ?? fallback`, optional field ⇒ omission degrades); ship a facade for a not-yet-wired consumer only with a reachability sub-note, and defer a routing whose call-site is dormant to a named follow-up rather than wiring dormant-on-dormant.

## <a id="12"></a>12. A serve-time trust-signal store is a fail-closed `@sow/db` operational-store repo behind a narrow fakeable read-port — deterministic latest-ordering (secondary tiebreak) + a read-back identity re-gate

**Date:** 2026-07-13.
**Source slice:** 11.1 serve-time ParityReport store `ca10090` (brief 052, Brick-B slice 1).

A store that feeds a serve-time trust decision (here the C5.4b coverage kill-switch reads the latest `ParityReport`) is a real `@sow/db` operational-store repo, NOT an in-memory cache: a `parity_reports` table on BOTH dialects passing the ONE `repository-contract` suite (no dialect-specific SQL), an additive migration (`0006`, next-after-`0005`), `record` idempotent first-write-wins on the report id (UNIQUE — immutable operational truth, never two rows per id), and `getLatestForRevision(ws, rev)` returning the newest-recorded report or `undefined`. The frozen contract is stored **as-is** (payload as a JSON/text column, re-gated through the frozen `ParityReportSchema.parse` on read — a lossless round-trip); a store-side `recorded_at` (injected-clock) supplies the "latest" ordering the timestamp-free contract lacks (no contract change). Three sharp edges a naive port misses: **(a) fail-closed BOTH directions distinguishing fault-vs-absence** — a real `DbError`, an unparseable stored payload, OR an identity-mismatched payload returns a typed err `Result`, NEVER masked as a silent ok and NEVER collapsed into the `undefined` that means "no row" (the reader must degrade on a fault without treating it as "no report"). **(b) DETERMINISTIC latest-ordering needs a secondary tiebreak** — `desc(recorded_at)` alone lets a same-`recorded_at` collision between two distinct report ids pick an arbitrary row, and SQLite vs Postgres can disagree, so a clean report could shadow a dirty one (a trust-gate defeat, forbidden-pattern §2); add `desc(reportId)` as the deterministic dialect-agreeing tiebreak + tell the write-path caller to supply canonical ISO-8601. **(c) re-gate IDENTITY, not just shape, on read-back** — a directly-tampered ops-DB row whose columns match the query key but whose payload claims a different `(workspaceId, reconciledAtRevision)` would surface cross-workspace (WS-8); assert the parsed payload's ws/rev == the query args, else typed err. Front the repo with a NARROW read-port exposing only the serve-time read (`getLatestForRevision`) that REJECTS on fault — `record` stays on the repo for the write-path slice — so the serve-time reader consumes a minimal fakeable seam.

**Rule:** a serve-time trust-signal store is a fail-closed `@sow/db` operational-store repo (dual-dialect contract suite + additive migration + idempotent-first-write-wins on id) fronted by a narrow fakeable read-port that REJECTS on fault; store the frozen report as-is + re-gate it through its schema on read; fail-closed BOTH directions distinguishing a fault (degrade) from a true no-row (`undefined`); make latest-ordering DETERMINISTIC with a secondary id tiebreak (a same-timestamp collision must not pick a dialect-arbitrary row that shadows a dirty report); and re-gate IDENTITY on read-back (parsed ws/rev == query key, else typed err) so a tampered row cannot surface cross-workspace.

## <a id="13"></a>13. Wiring a db-backed (async) source into a sync serve-time reader: widen the seam to the async sibling's union + keep the new dep OPTIONAL so the unbound seam degrades byte-equivalently

**Date:** 2026-07-13.
**Source slice:** 13.10 B2 serving-coverage reader parity wiring `daf4fa1` (brief 053, Brick-B slice 2).

When a serve-time reader gains a leg backed by an async source (here `createServingCoverageReader`'s parity leg reads the async db-backed `ParityReportStore`), the reader's returned function must become `async` — its **return type changes** from `T` to `Promise<T>`, which is NOT purely additive: every DIRECT caller (incl. the reader's own factory unit tests that read `.pinValid`/`.parity`) must `await`, so convert them in-slice (that's part of making it async, not scope creep). Do NOT ripple `Promise` through every fake of the CONSUMING seam — instead **widen the seam type to the sync-or-async union** (`(…) => Sources | Promise<Sources>`), MIRRORING the async sibling that already exists on that seam (the `CommittedVaultReader` is already `… | Promise<…>` and the loader `await`s it); the union keeps every existing SYNC fake valid (sync is a member, `await` no-ops on it) so the consumer's other tests stay untouched. Keep the new source dep **OPTIONAL** (`store?: …`): unbound ⇒ the leg resolves to its degraded value (`parity: undefined`) exactly as before, so the reader is **byte-equivalent to pre-slice** and boot needs no change — the real adapter binds in a later composition-root slice (the waiver-holder pattern, [20](LESSONS.md#20)). Fail-closed rides through unchanged: the async source REJECTS on fault, the reader's existing bare `catch` degrades ALL legs (a store fault never crosses the boundary, never a false green); a `catch` that also zeroes an independent leg (here `pinValid`) is the safe stricter direction (coverage is AND-composed — parity absence alone already degrades). Ship only the PARITY leg; leave a sibling leg (`oracleBuildOk`) at its degraded constant for its own slice — coverage stays AND-degraded, correct + inert.

**Rule:** to wire an async (db-backed) source into a sync serve-time reader, make the reader's fn `async` and convert its own direct-caller tests to `await` (in-slice — the return type changed); widen the CONSUMING seam to the sync-or-async union mirroring the async sibling already on it (existing sync fakes stay valid, `await` no-ops), don't ripple `Promise` through every fake; keep the new source dep OPTIONAL so the unbound seam degrades byte-equivalently and boot is untouched until a later composition-root slice binds the real adapter; fail-closed rides through the reader's all-legs-degrade `catch` (a source reject never crosses, never a false green); ship one leg at a time (a sibling leg stays at its degraded constant for its own slice).

## <a id="14"></a>14. A worker-side "record-only-on-ok" gate over a knowledge-layer reconcile Result — record the report VERBATIM, a reconcile err is a typed SKIP never a stored clean report, a sink fault REJECTS (fault ≠ skip)

**Date:** 2026-07-13.
**Source slice:** 13.10 B3 parity reconcile→store record path `07d6b0b` (brief 054, Brick-B slice 3).

When persisting a knowledge-layer reconcile output (`reconcileParity`'s `Result<ReconcilerOutcome, ReconcileError>`) into an operational store that feeds a **serve-time trust gate**, the write path is a WORKER-SIDE gate — `apps/worker` sees both `@sow/knowledge` and `@sow/db`, so a **type-only** import of the outcome types gives zero runtime coupling and no knowledge→db edge (the recording never lives in the knowledge package). Record from the RIGHT producer: the full `reconcileParity` (classifies the whole canonical∪db union → real `content_mismatch`), never a narrow primitive that sees one divergence class and would over-claim coverage. Three fail-closed properties, each pinned: **(a) record-only-on-ok, verbatim** — `isErr(outcome)` early-returns BEFORE the sink call (an err never reaches `record`); an `ok` forwards `outcome.value.report` BY REFERENCE, never synthesizing the trust fields (`cleanForServing`/`coverageComplete`) that carry the reconciler's real determination (pin with a `toBe` same-reference test — a missing/partial rebuild-oracle's `coverageComplete=false` must never read as complete-and-clean). **(b) a reconcile err is a typed SKIP** — return a discriminated `{ kind: "skipped_reconcile_error", error }` (the union has NO fault variant); the future caller routes it to health/degrade. **(c) a sink fault REJECTS (fault ≠ skip)** — a `record` `DbError` rejects through the gate (no try/catch swallow) so the caller degrades, distinct from the reconcile-err skip; the recorder port mirrors the read-port's reject-on-fault ([12](LESSONS.md#12)) and REUSES the same fault-rejection helper so rule-7 (drop the opaque cause, keep the code) holds by construction. Record DIRTY reports too (`cleanForServing=false` is operational truth — the serve-time degrade signal; dropping it blinds the gate). Ship the gate DORMANT + reachability-waivered (no trigger/caller); a later slice wires the reconcile trigger + the health routing.

**Rule:** a worker-side record gate over a knowledge reconcile `Result` records the report VERBATIM only on `ok` (`isErr` early-returns before the sink; forward the report BY REFERENCE, never synthesize the trust fields); a reconcile `err` is a typed `skipped` disposition never coerced into a stored clean report; a sink `DbError` REJECTS (fault ≠ skip — both fail-closed + distinguishable, reusing the read-port's fault-rejection helper for rule-7); record dirty reports too (a defect report is the serve-time degrade signal); type-only-import the knowledge output types (no knowledge→db edge); record from the full-coverage producer; ship dormant + waivered until a trigger slice.

## <a id="15"></a>15. A promise-REJECTION test whose assertions live only inside `.catch(cb)` is VACUOUSLY GREEN if the code ever resolves — capture the reason + assert unconditionally (fail loudly on resolve)

**Date:** 2026-07-13.
**Source slice:** 13.10 B3 — a convergent security + code-quality finding (`07d6b0b`).

A test that pins a REJECTION property — here the recorder's fault-rejection must carry `DbError.code` but NOT the opaque driver `cause` (safety rule 7 — no raw content/secret leak) — by attaching `.catch(cb)` and asserting INSIDE `cb` is a SILENT PASS if the code under test ever RESOLVES instead of rejecting: `cb` never runs, no assertion executes, the test is green while the exact property it claims to pin is unverified. Worst on a safety/redaction property — a regression that makes the path resolve (or leak) sails through CI. Force the outcome deterministically instead: `await promise.then(() => { throw new Error("expected rejection") }, (e) => e)` — capture the rejection reason, then assert the property (has-`code` / no-raw-content) UNCONDITIONALLY so a resolve throws loudly; or `await expect(promise).rejects.toThrow(...)` + assert on the captured error. Any test whose assertions live ONLY in a `.catch`/rejection callback is suspect — the assertions must run whether or not the promise rejects.

**Rule:** never let a rejection test's assertions live only inside `.catch(cb)` — it passes vacuously if the code resolves (a silent green on the pinned property, worst on a safety/redaction pin). Capture the rejection reason (`.then(() => { throw … }, e => e)` or `rejects.toThrow`) and assert UNCONDITIONALLY so a resolve fails loudly. `pattern:` grep review target — a test-block `.catch(` whose callback holds the only `expect(`; `accepted: reviewer-caught` (the mandatory dual review verifies rejection tests fail-on-resolve).
