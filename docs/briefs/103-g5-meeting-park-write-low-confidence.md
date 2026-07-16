# /tdd brief — g5_meeting_park_write (the G5 park-write second-half)

## Feature
Wire the **durable park-write** into `runMeetingCloseout`'s **7.7 low-confidence routing-review branch** — the G5 functional second-half (G5 = the 15.5 disposition-store machinery ✅ + this park-write; **G5 is not functionally live end-to-end until this lands**). Today `runMeetingCloseout` (`packages/workflows/src/workflows/meetingCloseout.ts:253-257`), on a `confidence:"low"` correlation outcome (inv-1: NO workspace guess), advances the state machine to `needs_routing_review` and **only `surface()`s a health item** — it does NOT durably record the item anywhere, so the "routed to Ingestion Inbox" comment is aspirational: nothing actually enters the disposition store, so there is no inbox entry for a human to reroute (15.8's desktop leg has nothing to resolve). This slice injects a **park port** into `MeetingCloseoutDeps` and calls it in the low-confidence branch so the un-routable meeting is durably PARKED (workspace-UNBOUND, inv-1) into the 15.5 disposition store → the Ingestion Inbox. Worker-track; **ISOLATED, security-reviewer=invariant** (inv-1 no-workspace-guess + WS-8 + the candidate/park write must not fabricate a routing). Pure-build, NO hard line (local operational store; no external write/propose/arming; the real connector drive that FEEDS a low-confidence meeting is Phase-16-waivered, L11).

## Use case + traceability
- **Task ID:** G5 park-write (the second-half of **15.5**; completes the disposition machinery's functional path). ⚠ Anti-"end-at-50%": G5 = 15.5 store ✅ + this park-write — **do not lose**.
- **Architecture sections it implements:** `ARCHITECTURE.md §19.2` (ingestion spine — the low-confidence routing-review park), `§9` (meeting-closeout workflow — the `needs_routing_review` low-confidence routing-review state, inv-1 no-guess, never-throw boundary).
- **Depends on:** 15.5 (`SourceDispositionRepository` / `DispositionStore` + `createDurableDispositionStore` — the durable store, worker L36) · P7 (§9 `runMeetingCloseout` state machine) · 15.9 (`725acaf2` — the meeting path that reaches this branch).
- **Related context (confirm at Step 1 — you own the worker track + you built 15.5):**
  - **The gap — `packages/workflows/src/workflows/meetingCloseout.ts:245-257`:** the correlate step. `!isOk(correlated)` (correlator error) → `needs_routing_review` + `surface`; `outcome.confidence === "low"` (`routingReview:true`, NO workspaceId, inv-1) → `needs_routing_review` + `surface`. Neither writes to the disposition store. G5 adds the park on the LOW-CONFIDENCE path.
  - **The store — `packages/workflows/src/activities/disposition.ts` `DispositionStore` (`isParked`/`getByKey`/`insert(key, TriageDisposition)`) + `RecordDispositionActivityDeps`; `apps/worker/src/composition/dispositionDurable.ts` `createDurableDispositionStore` (the durable dual-dialect repo, L36 — first-write-wins CAS, fail-closed both directions).** The park reuses THIS store (never a new writer).
  - **`TriageDisposition` (`packages/workflows/src/ports/ingestionTriage.ts`):** the disposition value shape for a parked/`needs_routing_review` item — confirm the exact variant for a low-confidence PARK (workspace-unbound).
  - **The consumer — the Ingestion Inbox projection + 15.8's reroute loop:** a parked item surfaces in the UI-safe `ingestionInbox` projection (the sole render path, L36) and 15.8 (desktop) resolves it. G5 produces the parked row; 15.8 consumes it.

## Acceptance criteria (what "done" means)
- [ ] **Park port injected + called:** `MeetingCloseoutDeps` gains a `park` port (mirror the existing `DispositionStore.insert` / `RecordDispositionActivityDeps` shape — workflow code calls an INJECTED port, never does I/O directly). `runMeetingCloseout`'s `confidence:"low"` branch calls it BEFORE (or as part of) the `needs_routing_review` return, durably recording the parked item.
- [ ] **inv-1 / WS-8 — workspace stays UNBOUND:** the parked disposition carries NO guessed workspace (a low-confidence outcome has no `workspaceId` by construction; the park must not invent one). The park key + payload derive from the meeting's OWN identity (`input.run.workflowId` = `meeting:${ws}:${recordId}` — the scope is the INGESTING workspace, distinct from a *routing-target* workspace which stays unbound for the human to choose). Pin that a low-confidence park writes zero routing-target workspace.
- [ ] **Idempotency (rule 3 / L36):** the park key is the meeting's stable identity (reuse the disposition CAS key discipline — a re-driven / replayed low-confidence meeting parks ONCE, a re-record HIT reuses the prior `AuditId`, never a duplicate inbox row). Pin the replay leg.
- [ ] **Fail-mode is explicit + fail-safe:** decide + pin the park-write fault behavior (Q3). A park fault must NOT silently lose the item — surface a distinct health signal so an operator sees the item did not durably park; the state still resolves to `needs_routing_review` (never a false "parked"). §9 never-throws across the boundary.
- [ ] **Correlator-error vs low-confidence split (Q4):** confirm whether the correlator-ERROR branch (`!isOk(correlated)`) also parks or ONLY health-surfaces (my default: correlator-error = a transient source fault → health-surface + retry candidate, NOT a routing-review park; the low-confidence outcome is the legit needs-human-routing park). Pin the chosen split so an error doesn't create a spurious inbox row (and a low-confidence DOES).
- [ ] **End-to-end:** a fake low-confidence meeting → `runMeetingCloseout` → parks a `needs_routing_review` disposition into the store → the item is retrievable (via `isParked`/the inbox projection). High-confidence still runs the full pipeline (no park). Regression: the existing meeting tests stay green.
- [ ] **Reachability:** the park port is wired into `meetingCloseoutWorkflow` (`apps/worker/src/temporal/workflows.ts:241`, binding a park activity over `createDurableDispositionStore`) + exercised by the low-confidence e2e; the real connector drive that feeds a real low-confidence meeting is Phase-16-waivered (L11).
- [ ] `/preflight` clean (worker + workflows + repo-wide).

## Wiring / entry point (Step 7.5)
`runMeetingCloseout` low-confidence branch → `deps.park.record(...)` → the durable disposition store; the port is bound in `meetingCloseoutWorkflow` over `createDurableDispositionStore` (the 15.5 repo). State: reachable + exercised by the low-confidence meeting test; the connector drive that produces a real low-confidence meeting is Phase-16-waivered. Name the exact binding site + the fail-mode at Step 9.

## Files expected to touch
**Modified:** `packages/workflows/src/workflows/meetingCloseout.ts` (the low-confidence branch + `MeetingCloseoutDeps` park port), `packages/workflows/src/ports/meetingCloseout.ts` (the park port type, if it lives there), `apps/worker/src/temporal/workflows.ts` (bind the park activity into `meetingCloseoutWorkflow`) + tests. Possibly a thin park activity in `packages/workflows/src/activities/` over the existing `DispositionStore`.
If beyond this (e.g. a new disposition variant), flag at Step 2.5.

## RED test outline (Step 2)
1. `low_confidence_meeting_parks_a_disposition` — a `confidence:"low"` outcome ⇒ `deps.park.record` called with a `needs_routing_review` disposition keyed by the meeting identity; state = `needs_routing_review`. (§19.2/§9 — the G5 fix)
2. `parked_disposition_binds_no_routing_workspace` — the parked payload carries NO guessed routing-target workspace (inv-1/WS-8). (safety)
3. `low_confidence_park_is_idempotent` — a replayed/re-driven low-confidence meeting parks ONCE (CAS HIT reuses the prior AuditId; no duplicate inbox row). (rule 3 / L36)
4. `park_write_fault_surfaces_and_does_not_false_park` — a park-store fault surfaces the health signal + resolves `needs_routing_review`, never a silent loss nor a false "parked". (§9 / fail-safe)
5. `correlator_error_does_not_park` (Q4 default) — a correlator ERROR health-surfaces WITHOUT a park row (a transient fault ≠ a routing-review item). (no spurious inbox row)
6. `high_confidence_meeting_does_not_park` — a high-confidence outcome runs the full pipeline, zero park write. (no regression/misroute)

## Cross-doc invariant impact
- **Model:** likely none new (consumes `TriageDisposition` + `DispositionStore`); if the `MeetingCloseoutDeps` port set is an Appendix-A/frozen seam, flag at Step 2.5. **Shared-contract seam touched?** Confirm — the meeting-closeout deps port is workflow-internal; a new injected port is additive.

## Things to flag at Step 2.5
1. **Park port shape + placement (LOAD-BEARING).** Reuse the existing `DispositionStore.insert(key, TriageDisposition)` directly as the injected port, or a thin `park` wrapper? Confirm the port mirrors the 15.5 store contract (no new writer).
2. **The park key + the two-workspace distinction.** Key = `input.run.workflowId` (`meeting:${ingestingWs}:${recordId}`)? Confirm the INGESTING-workspace scope (WS-8 for the store) is kept DISTINCT from the (unbound) routing-target workspace the human later picks — the park must not conflate them.
3. **Fail-mode (Q3).** Park-fault → health-surface + `needs_routing_review` (fail-safe, item flagged not-durably-parked) vs a harder fail. My default: surface a distinct park-failed health signal, still resolve `needs_routing_review` (never a false "parked", never a silent loss); the store is fail-closed both directions (L36) so a fault is a typed err, not a benign absence.
4. **Correlator-error vs low-confidence (Q4).** Default: ONLY the low-confidence outcome parks; a correlator error health-surfaces + is a retry candidate (no inbox row). Confirm.
5. **Reachability/waiver split.** The park is reachable via the low-confidence meeting e2e; the connector drive feeding a real low-confidence meeting is Phase-16-waivered (mirror 15.1/15.9, L11). Confirm.

## Dependencies + sequencing
- **Depends on:** 15.5 (disposition store), 15.9 (`725acaf2`, the meeting path), P7 (§9). **Blocks / closes:** **G5** (functionally live end-to-end once this lands) + feeds 15.8 (the human reroute loop consumes the parked row).

## Estimated commit count
**1.** A focused single slice (the branch wiring + the port + the bind). **security-reviewer = invariant** (inv-1 no-workspace-guess, WS-8 store scope, rule-3 idempotency, the fail-safe no-false-park). code-quality every-slice. **Pure-build — NO hard line** (local operational disposition store; no external egress/propose/arming; the connector drive is Phase-16-waivered).

## Lessons-logged candidates anticipated
- **Convention candidate** — the low-confidence routing-review park: a workflow's un-routable (inv-1, no-workspace-guess) outcome is durably PARKED through an INJECTED disposition port (never workflow-direct I/O), keyed by the ingesting-workspace-scoped meeting identity (the routing-target workspace stays UNBOUND for the human), idempotent via the 15.5 CAS (a replay parks once), and a park fault surfaces a distinct health signal + resolves `needs_routing_review` (never a false "parked"/silent loss) — closing G5 so a low-confidence meeting actually reaches the Ingestion Inbox for human reroute (15.8).

## How to invoke
1. Continue the worker-impl3 session.
2. Read this brief (Q1 port shape + Q3 fail-mode + Q4 error-vs-low-confidence are load-bearing).
3. `/tdd g5_meeting_park_write`.
4. Step 2.5 — ping the design answers. Don't GREEN until I sign off.
5. Step 9 — categorized flags; confirm G5 is functionally live (15.5 ✅ + park-write ✅). After G5 → 15.7 (source-ingestion external-write propose — ⚠ I CHECK for a hard line before dispatch).
