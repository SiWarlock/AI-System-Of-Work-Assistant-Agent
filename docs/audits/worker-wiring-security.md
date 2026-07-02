# Security review — worker-wiring wave (proof spine)

**Scope:** `/phase-exit` phase-boundary security pass over the accumulated wave diff
`8cc9654..11d7e6b` (WW-1 `d755c7b` + WW-2/3 `11d7e6b`). The composition root crosses
every trust boundary (KnowledgeWriter, Tool Gateway, policy, db, FS vault, Broker), so
each safety invariant was re-derived independently against the SHIPPED code — the
build-time adversarial verify was NOT trusted.

**Verdict: CLEAR.** No new critical/high. The 2 prior HIGHs are genuinely closed. The
deterministic-stub transports do not weaken any durable-write invariant and are each
gated behind a REAL-SDK injection-point marker. Findings below are NOTE / STALE-DOC
class only (carry-forwards already tracked, plus one hardening nit).

---

## Invariant-by-invariant re-derivation

### (1) no-DUPLICATE-external-write — WW-1 reserve — PASS

Files: `packages/db/src/schema/{,pg/}write-receipts.ts`,
`packages/db/src/adapters/{sqlite,postgres}/index.ts`,
`packages/db/src/invariants/operational-truth.ts` (`decideReserve`),
`packages/db/migrations/{sqlite,pg}/0000_genesis.sql`.

The reserve is an `INSERT … ON CONFLICT DO NOTHING` on the composite PK
`(targetSystem, canonicalObjectKey)` — an ATOMIC single statement on both dialects.
The uniqueness key is the composite PK, NOT `idempotencyKey`. The placeholder row
carries `idempotencyKey = NULL`; both SQLite and Postgres treat NULLs as DISTINCT under
a UNIQUE index, so many concurrent reservations never collide on that column. The
genesis migrations confirm the shipped DDL:
- sqlite: `PRIMARY KEY(targetSystem, canonicalObjectKey)` +
  `CREATE UNIQUE INDEX write_receipts_idempotencyKey_unique`.
- pg: `PRIMARY KEY(...)` + `CONSTRAINT write_receipts_idempotencyKey_unique UNIQUE`.

**Nullable-placeholder fix (prior HIGH #1 — non-injective reserve key): CLOSED.**
The earlier design synthesized a placeholder idempotencyKey from
`(targetSystem, canonicalObjectKey)`, which is NON-injective — colon-delimited canonical
keys collide (`('slack','a:b')` and `('slack:a','b')` both → `slack:a:b`) and could also
collide with a real committed key, tripping `UNIQUE(idempotencyKey)` for an object never
reserved (a spurious reserve failure → a lost write). The shipped fix uses `NULL`
(schema line 49; both adapters, sqlite 698 / pg 745), which sidesteps BOTH failure modes
because the object identity (composite PK) is the only uniqueness key the reserve uses.
Re-derived injectivity independently: the composite PK is exact (no delimiter flattening),
so two distinct object identities can never map to the same PK. Airtight.

**TOCTOU between the ON-CONFLICT insert and the re-read:** examined. The classification
is a PURE shared function `decideReserve({inserted, existingReceiptPresent})` (identical
on both dialects), so no dialect divergence. The re-read window has exactly one benign
race: the row is `release`d (placeholder deleted) between the failed INSERT and the
re-read → `existing === undefined`. Both adapters handle this by returning `in_progress`
(sqlite 712-716 / pg 763-766) — fail-SAFE: the caller must NOT create; a retry
re-reserves cleanly. The alternative (a committed row) is only produced by `put`, which is
monotonic (reserved→committed, never the reverse), so a re-read can never see LESS than
what the failed insert observed. No interleaving yields two `reserved` outcomes:
exactly one INSERT lands. The gateway's `reserve` step (gateway.ts 182-194) treats
`committed`→reuse-receipt and `in_progress`→hold, so the DB verdict maps to a
zero-duplicate-create decision.

**`put` cross-object guard: PASS.** `put` upserts on the composite PK and a duplicate
`idempotencyKey` pointing at a DIFFERENT object identity trips `UNIQUE(idempotencyKey)` →
driver throw → typed `conflict` (globally-unique replay key preserved). `release` deletes
ONLY a receipt-less row (`isNull(receipt)`) — never a committed receipt (would re-open a
duplicate). `toWriteReceipt` fails closed (throws) if a committed row ever has a NULL key,
and `receiptPresent`/`rowToReceiptRecord` refuse to surface a receipt-less reservation as
a committed record (backends 312-328) — a bare reservation can never masquerade as proof
of an existing object.

### (2) no-inference + workspace-ISOLATION — projection + buildOutputs — PASS

Files: `packages/workflows/src/activities/projections/meetingOutputs.ts` (`safeNoteSlug`,
`project`), `packages/workflows/src/activities/buildOutputs.ts` (`createBuildOutputsActivity`),
`apps/worker/src/composition/backends.ts` (`createFsVault`).

**Path-traversal fix (prior HIGH #2): CLOSED — re-derived at two independent layers.**
- Primary (projection): `safeNoteSlug` NFKD-normalizes, then `replace(/[^\p{L}\p{N}]+/gu, "-")`
  collapses EVERY non-alphanumeric run (separators `/` `\`, dots — so `..` is impossible —
  whitespace, control, NUL) to a hyphen, trims leading/trailing hyphens, caps at 120. The
  result provably contains no separator and no `..`, so it cannot inject path structure into
  `note.path = meetings/${workspaceId}/${slug}.md`. A title that slugs to empty
  (all-punctuation, e.g. `../..`) fails closed → `unmappable_extraction`, no partial note.
- Backstop (vault): `createFsVault.abs()` computes `resolve(root, p)` and refuses any path
  where `full !== rootResolved && !full.startsWith(rootResolved + sep)` — catching `..`
  traversal AND absolute paths (`resolve` lets an absolute `p` win). This is defense-in-depth
  so ANY unsafe path source is refused, not just this projection. `vault-containment.test.ts`
  pins write / absolute / rename-target refusal + a contained round-trip.

**Any OTHER model-controlled value into a path or side effect?** Traced exhaustively:
- `canonicalIdentity` / `idempotencyIdentity` (carry model `itemTitle`/`itemOwner`) →
  `buildCanonicalObjectKey` / `buildIdempotencyKey` (packages/domain/src/keys/*). These use
  an INJECTIVE JSON encoding `[version, targetSystem, sortedEntries]` then SHA-256; output
  charset is `[a-z0-9_]` (`cok_…` / `idem_…`) — no `:` `/` or whitespace can escape into the
  key. The keys become DB values (PK / UNIQUE) and vendor payload, NEVER a filesystem path.
  JSON escaping removes delimiter-collision ambiguity, so two distinct (title, owner) pairs
  cannot conflate into one external-object key.
- `payload: { title, owner }` → the vendor adapter body only; the stub keys its in-memory
  table by `canonicalObjectKey`, never by raw title. No path use.
- frontmatter / note body: `composeBody` + `frontmatterValue` render display text into file
  CONTENT (not path); content passes the KnowledgeWriter secret scan before commit.
- `payloadHash`: a deterministic string label, DB column only.

**Can `plan.workspaceId` ever be anything but the passed one?** No. The projection reads a
FIXED convention field set that deliberately EXCLUDES `workspaceId` (NOTE_FRONTMATTER_FIELDS),
and `createBuildOutputsActivity` stamps `workspaceId` (the passed, correlation-bound value)
into the plan by construction (buildOutputs.ts:162). A validated field literally named
`workspaceId` is ignored for all routing/target derivation. The canonicalIdentity /
idempotencyIdentity are bound to `String(workspaceId)` (the passed value), so a model field
can never redirect the durable write to another workspace.

### (3) approval FAIL-CLOSED — requireApproval unwrap + gateway ordering — PASS

Files: `apps/worker/src/composition/backends.ts` (`makeRequireApproval`),
`apps/worker/src/composition/buildActivities.ts` (externalWriteDeps),
`packages/integrations/src/tools/gateway.ts` (`dispatchExternalWrite`).

`makeRequireApproval` unwraps the @sow/policy decision as
`isAllow(decision) ? decision.value : { requiresApproval: true }` — a policy DENY (an
unclassifiable/malformed action) FAILS CLOSED to approval-required, never reads a value off
a deny. `approval-unwrap.test.ts` pins both a null/malformed action AND a well-formed
employer action → `requiresApproval: true` (no auto-apply default).

Gateway ordering re-derived: `dispatchExternalWrite` runs candidate-gate (step 1) → require
approval (step 2). When approval is required and `isApproved(env)` is false, it calls
`recordPendingApproval` and returns `{status:"approval_pending"}` with NO existence probe and
NO create — the approval-required action PARKS with zero external write. The pending
`Approval` id is derived deterministically from `env.idempotencyKey`
(`approval:${idempotencyKey}`), so re-recording a pending is idempotent. Exactly-once for the
apply path rides `ApprovalTransitionOutcome.applied`: the real `ApprovalRepository.applyTransition`
CAS (`WHERE id=? AND status=expectedFrom`, shared `decideApprovalCas`) returns `applied:true`
only for the genuine transitioner; a replay/second-channel contender gets `applied:false` and
may NOT dispatch. `dispatchApproved` only reuses/creates through the same reserve-then-create
gateway, so approval + no-dup compose.

### (4) SECRETS — KnowledgeWriter defaults intact — PASS

Files: `apps/worker/src/composition/buildActivities.ts` (knowledgeWriterDeps),
`packages/knowledge/src/knowledge-writer/writer.ts` (`applyPlan`), `ownership.ts`, `secret-scan.ts`.

The composition leaves `ownershipCheck` + `secretScan` UNSET (buildActivities 283-285, with an
explicit "NEVER pass a pass-through here" comment). `applyPlan` defaults them to the REAL
`enforceHumanOwnership` / `scanForSecrets` (writer.ts 170-171) and additionally runs its OWN
candidate-data gate `runGate(command.plan, deps.registry)` (step 2, line 186) using the process
schema registry — NOT any injected stub. So the durable Markdown-write path enforces the real
schema gate + human-ownership preservation + blocking (reject-not-redact) secret scan regardless
of the broker's deterministic gates. `registry` is also left unset → the real process registry.
Nothing in the composition disables any secret/ownership/schema default.

### (5) DETERMINISTIC-STUB transports — no invariant weakened; all gated — PASS

Files: `apps/worker/src/composition/backends.ts` (stub factories),
`apps/worker/src/composition/buildActivities.ts` (schemaGate/cardRenderer/runners).

Each stub was checked for whether it weakens an invariant vs. a real adapter, and whether it is
gated so it cannot ship silently:

- `createStubSchemaGate` / `schemaGate: () => ok(undefined)` (validate activity): these are the
  BROKER's schema gate and the validate-activity gate. They "always accept," but they do NOT
  govern the durable-write gates. The KnowledgeWriter re-runs its OWN `runGate` on the plan
  (invariant 2, independent), and the external-write path runs the REAL
  `admitExternalWriteEnvelope` (ajv → Zod → §3 universal external-write rule → linkage pin)
  inside `dispatchExternalWrite` step 1 — NOT stubbed. So an always-pass broker/validate stub
  cannot let unvalidated data reach Markdown or an external system. Both carry the
  `REAL-SDK INJECTION POINT` marker.
- `createStubAdapterTransport`: models the VENDOR HTTP only, sitting BEHIND the real
  reserve → existence-check → approval → create gates. Its `query` returns a real hit for a
  prior create (existence check is honest, not "always absent"); `create` is idempotent by
  canonicalObjectKey. It does not weaken existence/dedupe. Marked.
- `createStubProviderRunner`, `stubHealthGate`, `stubBudgetGate`, `createStubIndexApplyClient`:
  deterministic, each marked; none makes a security decision (they are transport/availability
  seams). The index client ACKs idempotently (no duplicate nodes).
- `cardRenderer`/`recordPendingGateway`/parked-source/ingestion runners: in-process stand-ins
  for Phase-8/9/10 seams; none approves-by-default or bypasses a gate. `makeRequireApproval`
  (the real fail-closed unwrap) is used, not a stub-approve.

Crucially, the stub composition is reachable ONLY via `assembleBackends` on the
SOW_TEMPORAL-gated live path / test path, and every seam is labelled
`// REAL-SDK INJECTION POINT (carry-forward: vendor transport)` — the real transport drops in
without touching the activities. No stub weakens invariant 1-4.

---

## Findings

- **NOTE** — `apps/worker/src/composition/backends.ts`: the deterministic-stub transports are
  a functional stand-in, not a production posture. They are correctly marked and gated behind
  SOW_TEMPORAL + REAL-SDK injection markers, and none weakens a durable-write invariant, but a
  real deployment MUST replace them before any live external/model call. Already tracked as a
  carry-forward. No action this wave.
- **NOTE** — `packages/domain/src/keys/canonical-key.ts` arch_gap: canonical-key VALUE case is
  preserved (not lowercased), a deliberate correctness-safe choice (collapsing distinct objects
  → silent mis-write is worse than a duplicate). Pre-existing design decision, not introduced
  here; a target system needing case-insensitive matching must pre-normalize. No action.
- **STALE-DOC** — `registerWorker.ts` PROOF_SPINE_IGNORE_MODULES carry-forward (a workflow-safe
  subpath on @sow/contracts / @sow/domain barrels to shrink the node:fs/node:crypto ignore list
  to empty) is already flagged in-code as a cross-track Finding. Not this track's territory; the
  stubbed built-ins are provably unreachable in the workflow sandbox (gate/crypto run in
  activities), so no security impact. Tracking only.

## Both prior HIGHs — confirmation

- HIGH #1 (WW-1 non-injective reserve key) — **CLOSED.** NULL placeholder key; composite PK is
  the sole reserve uniqueness key; injectivity re-derived; both dialects byte-identical.
- HIGH #2 (WW-2/3 model-title path traversal) — **CLOSED.** Title slug at the projection
  (no separator, no `..`, empty→fail-closed) + vault containment backstop (`..`/absolute
  refused); both layers independently re-derived and pinned by tests.
