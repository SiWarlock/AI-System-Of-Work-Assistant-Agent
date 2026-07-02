# arch-drift audit — worker-wiring wave (WW-1, WW-2/3)

**Phase:** worker-wiring (commits d755c7b + 11d7e6b)
**Auditor:** arch-drift-auditor
**Date:** 2026-07-02
**Anchors audited:** §8, §4, §6, §9, §16

---

## §8 — External-write envelope / reserve-then-create EXACTLY-ONCE

### Spec contract statements

| Statement | Verdict | Evidence |
|---|---|---|
| Tool Gateway is the ONLY external-write path | VERIFIED | `WriteReceiptRepository` is the sole DB-backed reserve; no write adapter called outside it |
| reserve-then-create: atomic INSERT ON CONFLICT DO NOTHING on (targetSystem, canonicalObjectKey) | VERIFIED-BY-TEST | contract test `repository-contract.test.ts:734–811`; both dialects |
| `reserved` = this caller won INSERT; `in_progress` = another worker mid-write; `committed` = receipt present, reuse | VERIFIED-BY-TEST | same test block; `ReserveOutcome` union `interfaces.ts:144–147` |
| Replay reuses the receipt — zero duplicate external writes | VERIFIED-BY-TEST | contract test "after put(receipt) reserve is {kind:'committed'}" |
| `release` deletes ONLY receipt-less placeholder, NEVER a committed row | VERIFIED-BY-TEST | contract test "release REFUSES delete COMMITTED row" `sqlite/index.ts:767–776`; guarded by `isNull(receipt)` |
| `idempotencyKey` GLOBALLY UNIQUE on write_receipts; NULL on reserved placeholder | VERIFIED | SQLite migration `0000_genesis.sql:118`; PG migration `0000_genesis.sql:116`; both nullable with unique constraint |
| `pre-write existence check` (getByCanonicalObjectKey) present | VERIFIED | `WriteReceiptRepository.getByCanonicalObjectKey` in `interfaces.ts:357`; both adapters implement it |
| Both dialects share `decideReserve` pure function (adapter-divergence blocked) | VERIFIED | `operational-truth.ts:336–360`; imported by both `sqlite/index.ts:57` and `postgres/index.ts:67` |

**Verdict: CLEAR**

---

## §4 — Operational Storage

### Spec contract statements

| Statement | Verdict | Evidence |
|---|---|---|
| write_receipts classified as OPERATIONAL TRUTH, NOT rebuildable | VERIFIED (structurally) | `interfaces.ts:331–338` comment; schema comment `write-receipts.ts:17–21`; no `clear()`/delete path on the interface |
| write_receipts NOT in `OperationalDomain` union or `OPERATIONAL_TRUTH_DOMAINS` | STALE-DOC | `operational-truth.ts:42–52` — union has 10 domains, none is `"write_receipts"`; `OPERATIONAL_TRUTH_DOMAINS` is the "five §4 named" set (line 68–74) — write_receipts is not in it; the type-level rebuild guard (`assertRebuildTarget`) cannot be called for this domain |
| SQLite / Postgres column parity on write_receipts | VERIFIED-BY-TEST | `repository-contract.test.ts` runs identical suite on both dialects; both schemas: same 6 columns, same PK, same nullable idempotencyKey unique |
| workflowRunRefs idempotencyKey UNIQUE on both dialects | VERIFIED | SQLite `event-log.ts:63` `.unique()`; PG mirror `pg/event-log.ts:38` `.unique()`; both migrations emit a UNIQUE constraint |
| Dual-dialect parity via shared `decideReserve` | VERIFIED | both adapters call same pure function; same verdict on both sides |
| DB unavailable → degraded mode, distinct System Health item | VERIFIED | `worker.ts:50–66` `BootstrapDegraded` shape; `buildWorkerDownHealthItem` mints `worker_down` `HealthItem` |
| Migration mismatch → back up + refuse to start | NOT VERIFIED IN THIS WAVE | migration DDL is present; the app-version ↔ schema-version check and restore-from-backup flow were deferred (out of scope for this wave) |
| Adapter divergence → release blocked | VERIFIED | both dialects pass same parameterized contract suite; divergence fails the test |

**Verdict: STALE-DOC** (write_receipts domain omission from `OperationalDomain` type — code is structurally safe, doc/type gap. Architecture doc note: §4 should acknowledge `write_receipts` as an additional operational-truth domain beyond the five named ones; or the code's `OperationalDomain` union should be extended to include it so `assertRebuildTarget`/`isOperationalTruth` remain exhaustive.)

---

## §6 — KnowledgeWriter sole writer + derive-from-validated + WS-2/WS-4

### Spec contract statements

| Statement | Verdict | Evidence |
|---|---|---|
| KnowledgeWriter is the SOLE autonomous semantic writer | VERIFIED | `buildActivities.ts:39` imports `applyPlan` from `@sow/knowledge`; no other Markdown writer in the composition root |
| derive-from-validated: projection receives only VALIDATED fields | VERIFIED | `meetingOutputs.ts:1–49` comment + `project()` takes `ValidatedExtraction` — only fields that passed the validate gate reach the projection |
| No-inference (REQ-F-017): absent/TBD fields emit TBD sentinel, never invented value | VERIFIED | `meetingOutputs.ts:208–211` — `frontmatterValue(fields[name])` returns TBD sentinel for absent fields; code comment "NEVER invented" |
| WS-2/WS-4 workspace stamp: PASSED workspaceId is the ONLY routing authority | VERIFIED | `meetingOutputs.ts:213–218` — explicit comment "A caller/model `workspaceId` field is IGNORED for path/target derivation"; the projection uses only the function parameter `workspaceId` |
| Path-containment: model-controlled title slugged so `..`/separator injection impossible | VERIFIED-BY-TEST | `safeNoteSlug` at `meetingOutputs.ts:143–150`; vault-containment test `vault-containment.test.ts:17–44` pins the vault-layer backstop |
| All-punctuation title (e.g. `"../.."`) slug → empty → fail-closed | VERIFIED | `meetingOutputs.ts:222–228` — `slug.length === 0 → err(unmappable_extraction)` |
| action item without concrete owner+title derives no external action | VERIFIED | `meetingOutputs.ts:244–246` — `if (itemTitle === undefined \|\| itemOwner === undefined) continue` |
| `workspaceId` field in extraction cannot redirect write | VERIFIED | explicit comment + code: `NOTE_FRONTMATTER_FIELDS` at `meetingOutputs.ts:73–79` does NOT include `workspaceId`; it would appear in frontmatter only if it were in that array |

**Verdict: CLEAR**

---

## §9 — Pure-driver contract preserved by @temporalio wrappers

### Spec contract statements

| Statement | Verdict | Evidence |
|---|---|---|
| Sandbox-safe: workflow module imports NEITHER @temporalio/worker NOR node:crypto/fs | VERIFIED | `workflows.ts:1–48` imports only `@temporalio/workflow`, deep-leaf pure modules, and type-erased composition type |
| Deterministic: no `Date.now()` / `Math.random()` called directly; clock injected | VERIFIED | `workflows.ts:136–140` — `workflowClock` reads `new Date()` which the Temporal VM makes deterministic inside the sandbox |
| `resolveRun` idempotency: lookup-first, create-then-reconcile on conflict | VERIFIED | `idempotency.ts:64–103` — `not_found` routes to create; conflict re-reads by idempotencyKey and returns `reused:true` |
| `create-conflict → reused` path (WW-1 new path): loser re-reads and reuses winner's run | VERIFIED | `idempotency.ts:92–98` |
| In-sandbox run repo: always-novel (not DB-backed) — acknowledged carry-forward | VERIFIED | `workflows.ts:177–208` — `sandboxRunRepo()` explicitly described as in-sandbox-only; carry-forward note at line 173–175 |
| ProxyActivities typed against composition-root shape | VERIFIED | `workflows.ts:113` `proxyActivities<ProofSpineActivities>` with type-only import `workflows.ts:98` |
| Every activity returns typed Result; nothing throws across boundary | VERIFIED | `buildActivities.ts:1–8` comment; `worker.ts:3–18` architecture comments; `interfaces.ts:10–12` error convention |
| Temporal-unavailable is first-class degraded mode (not crash) | VERIFIED | `worker.ts:50–66` — `BootstrapDegraded.shouldReconnect:true`, bounded backoff, `worker_down` health item; never throws |

**Verdict: CLEAR**

---

## §16 — Health surfacing unchanged

### Spec contract statements

| Statement | Verdict | Evidence |
|---|---|---|
| Temporal-unavailable surfaces a distinct `worker_down` HealthItem | VERIFIED | `worker.ts:92–110` — `buildWorkerDownHealthItem` emits `failureClass:"worker_down"`, `state:"open"`, typed `auditRef`, `openedAt` |
| HealthItem shape matches Appendix A (id, failureClass, severity, message, auditRef, openedAt, state) | VERIFIED | `worker.ts:96–109` — all Appendix-A required fields present |
| bounded backoff (not crash-loop) | VERIFIED | `worker.ts:68–82` `reconnectBackoffMs`: exponential base 500ms, cap 60s, capped exponent to prevent overflow |
| One distinct item per (failureClass, queue) — deduplication | VERIFIED | `worker.ts:84–89` — `id: worker_down:${taskQueue}` is a stable composite key |
| `shouldReconnect:true` on degraded — never spins | VERIFIED | `worker.ts:125–133` |

**Verdict: CLEAR**

---

## Summary

| Anchor | Verdict | Worst issue |
|---|---|---|
| §8 external-write envelope | CLEAR | — |
| §4 operational storage | STALE-DOC | write_receipts absent from OperationalDomain type + OPERATIONAL_TRUTH_DOMAINS constant |
| §6 KnowledgeWriter / §6 WS-2/WS-4 | CLEAR | — |
| §9 pure-driver / @temporalio wrappers | CLEAR | — |
| §16 health surfacing | CLEAR | — |

**Overall: CLEAR** — 5 anchors audited, 0 DRIFT, 1 STALE-DOC (architecture doc should acknowledge write_receipts as an additional operational-truth domain; code is structurally safe).

### Architecture-doc note (STALE-DOC)

`packages/db/src/invariants/operational-truth.ts` `OperationalDomain` union (line 42–52) and `OPERATIONAL_TRUTH_DOMAINS` constant (line 68–74) enumerate 10 domains but do not include `write_receipts`. The schema file (`write-receipts.ts:17`) and the repository interface (`interfaces.ts:331`) both explicitly classify write_receipts as "OPERATIONAL TRUTH — NOT rebuildable." The structural protection is real (no `clear()`/delete path on the interface), but the type-level `assertRebuildTarget` / `isOperationalTruth` guards are unreachable for this domain. Recommendation: either extend `OperationalDomain` to include `"write_receipts"` (and add it to `OPERATIONAL_TRUTH_DOMAINS`), or add an inline comment in `operational-truth.ts` acknowledging that `write_receipts` is protected structurally rather than via the type map.
