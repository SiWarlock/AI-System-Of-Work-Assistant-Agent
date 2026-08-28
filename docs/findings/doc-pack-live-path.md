# The §4.5 managed doc-pack LIVE path — what actually blocks it

**Status:** BLOCKED, correctly. Not buildable before `§ARM-21`.
**Supersedes:** every "blocked on a Drive connector that does not exist" statement in
the tree. That reason is **false** and has been corrected at its four sites.

## The short version

The doc pack renders five slots as `unlinked`/`unknown` and that output is **right**.
Only the stated REASON was wrong. The live path is task `21.9`
(`⛔ Owner-Gates §ARM-21`), and it cannot be reached by building harder.

## What the tree actually has (measured at `2ec4ebf7`)

| Piece | State |
|---|---|
| Drive READ connector (`connectors/adapters/drive.ts`) | **EXISTS** |
| Drive WRITE adapter (`tools/adapters/drive.ts`) | **EXISTS**, in the write-adapter registry |
| `createNotebookLmSync` (the five-slot upsert) | **EXISTS**, tested |
| `runNotebookLmSync` (7.16 driver) | exists — **zero production callers** |
| `createAssembleNotebookDocsActivity` | exists — **zero production callers** |
| `buildNotebookSync` (worker bind) | exists — **dormant**, returns `undefined` unless `gate.enabled === true`; no caller |
| `resolveMapping` (the `NotebookMapping` resolver dep) | **UNBOUND** — no implementation anywhere |
| `NotebookMapping` persistence | **DOES NOT EXIST** — zero `notebook` hits in `packages/db/src` (positive-controlled: `Repository` returns 25 hits in the same file) |
| `defaultDocPack()` (`activities/projectDashboard.ts`) | hardcodes all five slots `unlinked`/`unknown` |

## Why it cannot be built early — the load-bearing bit

The obvious move is "at least make `linkState` real: a slot is `linked` if a
`NotebookMapping` exists for the project." **That does not work, and the reason is
structural rather than a matter of effort.**

`NotebookMappingSchema` requires `driveFolderId` plus five non-blank
`managedDocIds`. Those ids are **Drive object ids**. Nothing in the system can know
them until the folder and the five docs have been CREATED at Drive — which is a real
external write, i.e. `§ARM-21` itself (`21.9`'s Files line: *"link the Drive
connector-instance + schedule the sync over the Drive write transport"*).

⇒ **Creating the mapping IS the first real Drive write.** `linkState` is therefore
downstream of the crossing, not independent of it. `syncState` is even further
downstream — it is a fact about sync outcomes that have not happened.

⇒ Building a `NotebookMapping` store now would add a table with **no writer**, which
is the same built-but-unwired shape this codebase has now found four times
(Phase-25 schedules with no input, `TransportFaultDetail` with no producer, `update`
with no caller, and this).

## What a real attempt needs, in order

1. `§ARM-21` crossing (owner) — **and `external-write-update-path.md` resolved
   first**, since the doc pack is an UPSERT surface: a re-sync with changed bodies is
   exactly the update path that is currently broken and twice-reverted.
2. Drive credentials — `§ARM-23`.
3. A per-vendor Drive `WriteHttpSpec` + a real `HttpTransport` + a bound
   `WriteTransportGate.make` (see the correction below).
4. `NotebookMapping` persistence + the `resolveMapping` binding, written by the
   provisioning step that creates the folder and the five docs.
5. Per-slot sync-outcome persistence — `NotebookSyncResult` already partitions
   `upserted` / `reattachRequired` / `heldForRetry`, which maps cleanly onto
   `synced` / `error` / `stale`. Nothing persists it today.
6. Only then: the projector, replacing `defaultDocPack()`.

## A second stale claim, corrected at the same time

`docs/runbooks/owner-arming-inventory.md` Crossing 5 told the owner:

> a grep of the whole tree finds **no** real `AdapterTransport` implementation
> anywhere — only the deterministic stub

**False at HEAD.** `createWriteHttpTransport`
(`tools/adapters/write-http-transport.ts`, task 21.6a) is a real `AdapterTransport`:
SSRF guard on the final url, header-only token via the 17.4 write-credential seam,
positive-2xx gate, redacted faults. It is DORMANT and UNBOUND, which is a different
thing from absent.

The conclusion the runbook drew from it — *"this crossing cannot be flag-only"* — is
still **TRUE**, and the correction is deliberately narrow: three pieces are genuinely
missing (a per-vendor `WriteHttpSpec` — none ships in `src`; a real `HttpTransport`;
a bound `WriteTransportGate.make` — the gate ships unbound). Over-correcting to "the
transport is done" would be the more dangerous error, so the entry now names the
three remaining pieces instead of the amount of work.

⚠ This one mattered because the owner reads that section **to decide whether to
cross**. An overstatement of remaining work in an arming runbook postpones a
crossing; an understatement invites an unsafe one. Neither is a harmless doc bug.
