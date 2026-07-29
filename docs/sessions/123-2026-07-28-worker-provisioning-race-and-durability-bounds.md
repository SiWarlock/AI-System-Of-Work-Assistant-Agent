# 123 — worker: the provisioning/revoke race (9.30) + the durability bounds (9.31, 9.29, 9.23)

**Date:** 2026-07-28
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/118-2026-07-26-worker-noteslug-livingvault-zeroegress.md`
**Successor session:** _(unwritten)_
_(Doc number 123 was ASSIGNED by the orchestrator, not computed — desktop and provint both computed 120 concurrently and collided.)_

---

## What landed

| Task | Commit | Summary |
|---|---|---|
| **9.23** | `144ae6f1` | Provisioning seeds only what it CREATES; a re-provision no longer restores a revoked egress ack. |
| **9.29** | `a0eafd22` | The provisioning-owned-fields invariant, as a documented decision + a writer census. No carry-forward. |
| **9.30 + 9.31** | `615394a8` | The race eliminated by narrowing the write on BOTH branches; the durability bound documented + pinned. |
| _(reconciliation)_ | `23e1bf42` | Sibling fakes reconciled with the grown `WorkspaceConfigRepository` (L50, own commit). |

All green at HEAD: **worker 1990/1990 · db 453/453 · `turbo typecheck` 20/20**.

---

## Why this session existed

9.23 closed a rule-5 fail-open: `provisionWorkspace` seeded the egress allowlist *before* its existence
check and then wrote the whole aggregate, so any later re-provision silently restored an owner-REVOKED
`employerRawEgressAcknowledged` — no audit row, no owner confirm. The 9.10-B revoke held only until
someone re-provisioned.

Closing it surfaced three residuals, each of which **bounds the claim "the revoke is durable"**. This
session closed all three. The through-line: *a defect is not closed until the claim about it is stated
with its bounds.*

---

## The load-bearing decisions

### 1. Option A — eliminate the shared write, don't detect the conflict (9.30)

The `get` (existence/type check) → `upsert` was a non-atomic read-modify-write over an unconditional
`ON CONFLICT DO UPDATE <every column>`. A `revokeEgressAck` landing in that window was silently
clobbered — 9.23's own defect, narrowed to a race.

Compare-and-set would have *detected* the conflict. Narrowing the write **removes the shared column**:
provisioning does not own egress state, so it should not be writing it. `updateProvisioningFields`
narrows the same-type branch to `{name, markdownRepoPath, gbrainBrainId}`; `insertIfAbsent` makes the
create branch insert-only.

**Second-order effect, and the real prize:** 9.29's invariant stops being documentary and becomes
**structural**. `ProvisioningOwnedFields` makes a posture write *untypeable* from this call site, so
9.23's carry-forward and its `WorkspaceSchema.parse` re-gate could both be deleted — not dropped.
Security review verified the deletion by tracing rather than accepting the claim: the update echoes
nothing from the stored row (all three values come from the step-1 Zod-parsed aggregate), so no stored
blob re-crosses into a write and the re-gate's premise evaporates.

### 2. ⚠ The over-claim — and the correction that matters most

**My first version of Option A narrowed only the same-type branch, and I wrote in-code that the race was
closed. The CREATE branch had the identical race and I asserted it was safe.** A provision that read
`not_found`, then lost the window to both a create and a revoke, blind-updated its freshly-seeded
`ack=true` straight back over the owner's decision.

Both reviewers found it independently. I **reproduced it with a failing test before fixing it** rather
than reasoning about it — the test went RED exactly as described, then GREEN under `insertIfAbsent`.

The generalizable form, and the correct statement of Option A:
> **Eliminate the shared write on EVERY branch that writes it.** Narrowing one branch while another keeps
> the blind whole-row write *moves* the defect rather than removing it.

This is this round's signature defect shape appearing inside my own fix for it.

### 3. The sibling's `arch_gap` does NOT transfer (the ruling that reshaped the slice)

The brief instructed me to read `workspaceRegistry.ts:39-47`'s `arch_gap (concurrency)` note and **match
the house answer**. Reading it showed the justification *inverts*:

| | `workspaceRegistry` | `provisionWorkspace` |
|---|---|---|
| Direction of a lost update | **fail-SAFE** (a dropped id goes invisible; scoped reads fail closed) | **fail-OPEN** (a revoke is reverted) |
| Does a re-provision repair it? | **Yes** — explicitly cited as why it's acceptable | **No** — a re-provision is what *causes* it |

Matching it would have meant keeping the conclusion while discarding the premise that earned it. The
orchestrator recorded this as overturning its own default vote, and as the reason "documented
`arch_gap`" was off the table for this path.

**The mirror-image failure is worth naming too:** the brief warned that *diverging* silently from a house
answer is the failure mode. *Converging* silently is equally one — adopting a precedent's conclusion
without re-checking that its reasoning still applies.

### 4. 9.31 is documentation, because `markdownRepoPath` has zero production consumers

`createWorkspace` takes a caller-chosen `id` with no uniqueness on `markdownRepoPath`, so a NEW
`employer_work` workspace pointed at the same vault root is a fresh create ⇒ freshly seeded `ack=true`.
9.23 + 9.30 make the revoke durable for the **ROW**, not the **VAULT**.

The trace found the field has **no production consumer at all**: the runtime vault comes from
`backends.ts` `createFsVault(config.vaultRoot ?? …)`, never from the workspace row. So "two workspaces
sharing a vault root" is not a state anything can act on — the worker has exactly one vault. That makes
it a documented bound plus a tripwire (`markdownRepoPath_has_no_production_consumer`), not code.

Also corrected: `backends.ts` claimed *"a deployment passes the workspace's markdownRepoPath"* — false;
it passes `config.vaultRoot`. A stale claim about which state governs behaviour, in the file whose
behaviour it describes.

### 5. ⚠ 9.30 gates 9.21 — sequencing, escalated

The race reads "low likelihood" today because it needs a user doing two things at once. **9.21
(repair/resume) makes re-provision a BACKGROUND operation** — the identical argument that made 9.23
must-land-before-9.21. The orchestrator took this up and recorded it on both tasks; it was its own
framing, not a verified one, before this session.

### 6. The corrected consumer-direction table (from 9.29, fixed after review)

My 9.29 `dataOwner` finding had the right **verdict** (it is the dangerous one) but the **wrong
mechanism**, and I had written the wrong mechanism into the comment that *was* that slice's deliverable:

| Field | Reset direction | Real consumer |
|---|---|---|
| `providerMatrix` | **FAIL-CLOSED** at every consumer | empty matrix denies routing; cannot support a local-only claim |
| `defaultVisibility` | **DIRECTION-DEPENDENT** — not fail-closed | most restrictive for the GCL ceiling, but the **permissive** value at the approval gate (`=== "isolated"` is required for auto-allow) |
| `dataOwner` | **FAIL-OPEN** | ⚠ **NOT the §5 egress veto** — that branches on `workspace.type`, and `dataOwner` reaches it only as an audit ref. The real gate is **approval**: auto-allow requires `dataOwner === "user"`, so an employer-hardened workspace re-derived to `"user"` moves an external action from requires-approval to auto-create. |

Both fail-open surfaces are unreachable from the store today (`resolveWorkspacePolicy` has no production
caller; the one store→posture path projects neither field) — which is what keeps it a documented
invariant rather than a live hole.

**Note:** 9.30 removed this concern as a side effect — provisioning no longer writes any of the three.

---

## Decisions explicitly NOT made

- **9.29 carry-forward** — deliberately not written. The trace found no post-provision writer, so
  preserving state nothing can yet change is speculative work that reads as safety.
- **Revoke-side symmetric mutator** (task #38) — the race is closed in the ACK direction only; the revoke
  is still a whole-aggregate read-modify-write, so a concurrent *rename* can be lost. Benign direction,
  real design decision, not for a boundary.
- **The foreign-`workspaceId` read-side re-gate** (task #39) — with the write-side parse gone, a corrupt
  `egressPolicy.workspaceId` is now detected *nowhere*. This slice did not open it (the read side was
  always unguarded), which is why it is recorded rather than logged as a regression.
- **9.32** — scoped by the orchestrator as an arc, not a slice; the "which providers" question is a
  product decision with the owner.

## TDD compliance

**Clean.** Every behavioural change went RED-first with the failure verified for the right reason,
including the create-branch race (reproduced before fixing, at review's prompting).

Two honest notes:
- 9.29's `carried_ack_timestamp` pin and 9.30's `create_branch_conflict` pin were both added **after** an
  initial green, at reviewer request. Both were verified discriminating — the second by an actual RED run.
- Two 9.30 pins (`provisioning_write_cannot_touch_egress_state`, `same_type_write_updates_only_…`) pass
  both before and after, by design: they are regression guards proving 9.23's behaviour survives the
  mechanism swap, not RED-first pins.

## Reachability

- **9.23 / 9.29 / 9.30** — `onboarding.createWorkspace` (`onboarding.ts:46/69/177`) → `provisionWorkspace`
  → `insertIfAbsent` (create) | `updateProvisioningFields` (same-type). Both branches on the live path.
- **9.31** — documentation + pin; no runtime surface by design.

## Tripwires, and the fact that they fired on me

Three census-style pins now guard these invariants. **Two fired on my own slice**, which is the point:

- `writers_are_exactly_the_two_known` caught the repository interface growing without its write-method
  list being updated (I had added `insertIfAbsent` and the classifier still keyed on the old set).
- `markdownRepoPath_has_no_production_consumer` caught my own new `ProvisioningOwnedFields` declaration.

Both were resolved by **exempting the two declaration sites file-level with the reason recorded**, never
by re-broadening — a guard widened for comfort stops guarding. Review also caught that the
`markdownRepoPath` pin had been excluding `backends.ts` and all of `packages/db/` — i.e. disarmed at
exactly the two places a real consumer would appear; it now strips comments instead of excluding files.

Non-vacuity for both was proven **by experiment**: a real offending file was added to the tree, the pin
was observed FIRING, and the file was removed. A census's vacuity mode is *discovery returning nothing*,
not a mis-classified string.

## Open follow-ups

1. **#38** — revoke-side `get`→`upsert` can still lose a concurrent rename (the other half of 9.30).
2. **#39** — a foreign `egressPolicy.workspaceId` is now detected nowhere; the read-side re-gate
   (`storeBackedWorkspacePosture` compares `ws.id` but not `ws.egressPolicy.workspaceId`).
3. **9.30 gates 9.21** — must land before the repair/resume path makes re-provision routine.
4. **Arch doc (orchestrator)** — §5/§11: revoke durability stated WITH its bounds; what a re-provision
   updates vs preserves vs re-derives.
5. **Lesson candidates** — "eliminate the shared write on every branch that writes it"; "a precedent's
   conclusion does not transfer without its premise"; "a census's non-vacuity lives in discovery — prove
   it by adding a real offender and watching it fire".

## How this was built

Four `/tdd` cycles across two sessions. The pattern that produced every real finding was the same one:
**check a claim against the code that acts on it, rather than against its own wording** — the brief's
model of `allowedProcessors`, the sibling's `arch_gap` reasoning, my own `dataOwner` mechanism, and my own
"the race is closed" comment all failed that check, and each was green-and-plausible until it was run
against source.
