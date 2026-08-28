# The external-write UPDATE path — why two attempts were reverted

**Status:** IN PROGRESS (third attempt, staged). C1's mechanism is BUILT and WIRED;
C2/C3 and the `update` wiring itself are still open.

| Stage | What | Commit |
|---|---|---|
| 1 | `write_applications` — the applied-write ledger (schema, both dialects, contract suite). No callers. | `8851034f` |
| 2 | Wired into the replay gate (`recordReceipt` appends; `resolveExisting` arm (a) consults it). `update` still unwired. | `392457aa` |
| 3 | **NEXT** — enumerate every re-drive path, then ordering (C3), then `update`. | — |

⚠ Two lessons already paid for in stage 2, recorded so attempt 4 does not repeat them:
- **The ledger must ADD recall, never SUBTRACT it.** Treating a ledger MISS as
  authoritative broke two long-standing replay pins — the ledger only knows writes
  made through `recordReceipt`, so a receipt from a direct `put`/fixture/legacy row
  stopped being recognised. A miss now falls through to the receipt-row lookup.
- **Arm (b) currently MASKS C1.** A test asserting "a superseded replay issues no
  second create" PASSES with the ledger disabled, because `getByCanonicalObjectKey`
  short-circuits any dispatch for an existing object. Assert the outcome KIND
  (`replay` vs `existing`), not the status. That same short-circuit is *also* why
  `update` never happens — and stage 3 must move it, which is what finally exposes
  C1 for real.
**Reachability:** DORMANT — the write transport is default-OFF until `§ARM-21`.
**⛔ Fix BEFORE arming `§ARM-21`, not after.**

## The bug

`TargetWriteAdapter.update` is declared at `packages/integrations/src/tools/adapter-port.ts:141`,
in a file whose own header calls the Tool Gateway "the ONLY caller". **It has zero callers.**

So a vendor object can never be updated. Every write is create-or-reuse. Measured
consequence: a NotebookLM re-sync with CHANGED bodies issues zero vendor writes,
carries none of the new content, and reports `outcome: "synced"`. Edited notes never
reach Drive and the caller is told the vault is in sync.

## The root constraint

`write_receipts` has PRIMARY KEY `(targetSystem, canonicalObjectKey)` and `put` is
`onConflictDoUpdate` over that target, overwriting the row's `idempotencyKey` column
— in BOTH dialects (`packages/db/src/adapters/sqlite/index.ts` ~:1373-1391,
`postgres/index.ts` ~:1434-1451).

⇒ **The store holds ONE write per object.** It can answer *"is THIS envelope's key the
currently-applied key?"* and *"what payloadHash is currently applied?"* It cannot
answer *"was this OLD envelope ever applied?"*

A create-only world never hits this: an object is created once, so the single row IS
its entire history. **Updates make the history longer than the store can hold.**

⭐ And a second, independent gap: **there is no ordering anywhere in the system.**
Nothing distinguishes a newer intent from an older superseded envelope. These are two
different problems and they need two different mechanisms — conflating them is what
sank attempt 2.

## Attempt 1 — wire update generally (reverted)

Five criticals, all measured:

| # | Defect |
|---|---|
| C1 | Recording a receipt on update EVICTS the prior idempotencyKey, so a replay of the already-committed envelope stops replaying and writes again. **This is safety rule 3 itself.** |
| C2 | The update arm took no create-reservation — two concurrent dispatches with the same key both reached the vendor (measured: 2 vendor updates for one logical write). |
| C3 | A held update re-driven by `outbox-drain.ts` carries an OLD `payloadHash`, so after a newer body landed it wrote the old bytes back — a content REVERT. |
| C4 | Arm-(c) "adoption" persisted a receipt carrying `env.payloadHash` for a payload never written, so the NEXT changed-content dispatch read "we own this" and updated a FOREIGN object. |
| C5 | `adapter-port.ts` therefore asserted a property — "without a receipt there is no evidence this system authored it" — that the adoption step itself fabricated. |

It passed **918 tests**, because `InMemoryReceiptStore` accumulated every historical
idempotency key while the shipped store keeps one row. **The suite was green because
the fake was wrong.** That fake is now corrected (`3442d117`) and pinned.

## Attempt 2 — caller-asserted capability, narrowed to Drive (reverted)

Rejected the ledger and modelled freshness as a capability (`allowInPlaceUpdate` /
`allowAdoptedUpdate`) plus a target allowlist, stripping the grants in the outbox
drain. All five gates REFUTED:

- **C1 UNREPAIRED.** The receipt overwrite was kept; the design argued both replay
  channels were closed. One of them was not.
- **The strip has a hole.** `outbox-drain.ts` is *not* the only component that
  re-drives a persisted envelope — `packages/workflows/src/activities/envelopeReuse.ts`
  (`reuseExternalWriteOnResume`) is a second path the design never accounted for.
- **The capability protected nothing.** The sole production caller
  (`notebooklm-sync.ts`) set BOTH grants unconditionally on every dispatch, so the
  entire defence was caller discipline with nothing structural behind it.
- **C4/C5 reproduced** by a different route: on the composed notebook bind the outer
  adapter's `existenceCheck` returns `ok(null)`, so the adoption sentinel is never
  stamped on the outer row and the live probe happens in a NESTED dispatch.
- A held update whose grants are stripped returns `reused`, and the drain then closes
  the entry carrying a DIFFERENT write's receipt — **the held bytes are silently dropped.**

## What a third attempt needs

Two mechanisms, not one. Attempt 2 rejected the ledger by arguing it does not fix C3
— true, and beside the point: C3 is an ORDERING problem, not a replay problem.

1. **Replay (C1):** an applied-write ledger — every applied `idempotencyKey` recorded
   independently of the current-object row. A schema change in `packages/db` plus the
   dual-dialect contract suite, and a pruning story.
2. **Ordering (C3):** something that makes a superseded envelope identifiable —
   a monotonic sequence on the envelope, or a vendor precondition. ⚠ Verify first
   that any field can carry a real version: `ExternalWriteEnvelope.preconditions` is a
   free-form gate-name list and `WriteReceipt.rawRef` is documented as a
   redaction-safe POINTER, not an etag.
3. ~~**Enumerate EVERY re-drive path**~~ — ✅ **DONE 2026-08-28. The list is THREE, and
   attempt 2 knew only two.** A "re-drive path" is a component that dispatches a
   PERSISTED envelope rather than building one from current facts — that is what makes
   a stale `payloadHash` reachable.

   | # | Path | How the envelope is persisted |
   |---|---|---|
   | 1 | `outbox-drain.ts` | the outbox row (`idempotencyKey`, `canonicalObjectKey`, `payloadHash`, payload) |
   | 2 | `envelopeReuse.ts` (`reuseExternalWriteOnResume`), called from `apps/worker/src/lifecycle/recovery.ts` | `RecoverableWrite.envelope`, from the resume ledger |
   | 3 | ⭐ **the APPROVAL path** — `approvalFlow.ts` dispatches `input.context.envelope` via `dispatchApproved` | **durable Temporal workflow input**, held across a HUMAN decision |

   ⭐ **#3 is new, and it is the worst of the three for C3.** The other two re-drive
   within minutes; an approval can sit pending for days by design. Approve it after a
   newer sync has landed and it writes the OLD payload back — the content revert, via
   a path neither reverted attempt named. It is also the one path a "strip the grants
   in the drain" defence (attempt 2's design) could never have covered, because the
   stripping happens in `outbox-drain.ts` and this envelope never goes near it.

   **Why the list is closed.** Every production caller of `dispatchExternalWrite` /
   the routed `dispatch` was classified. The rest build a FRESH envelope from current
   facts (`notebooklm-sync.ts`, `notebooklm-ground.ts`), are pass-through routers
   (`write-adapter-registry.ts`), or are a different `dispatch` concept entirely and
   never touch the external-write envelope (`vaultWatcher.ts` source-ingestion,
   `commands.ts` triage re-enter, `temporal-unavailable.ts` job dispatch,
   `gbrain-sync-trigger.ts` index sync).

   ⚠ A partial ordering defence already exists at ONE boundary and is worth reusing
   rather than reinventing: `copilotProposeSink.ts`'s `reconcileExisting` REJECTS a
   same-id approval whose `payloadHash` diverges (first-write-wins).
4. **Concurrency (C2):** `receiptStore.reserve` is the exclusive-right-to-CREATE guard
   and returns `committed` for an object that already has a receipt, so it cannot
   serialize two updates as-is. Either extend it or document last-writer-wins
   honestly — attempt 2 documented a limit materially narrower than the real one.

## Decision rule for this path

**Stale content is recoverable — you re-sync. A duplicate write, a clobbered foreign
object, and a reverted document are not.** When they conflict, prefer stale. That is
why both attempts were reverted rather than fixed forward: the bug they fixed is
recoverable and the bugs they introduced are not.

## Related

Three "built but unwired" defects surfaced in the same session, all the same shape —
machinery that exists and is never invoked: Phase-25 schedules registered with no
input; `TransportFaultDetail` defined with no producer; `update` declared with no
caller. Worth a grep for others before `§ARM-21`.
