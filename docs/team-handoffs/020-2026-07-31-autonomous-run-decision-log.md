# Team Handoff 020 — AUTONOMOUS RUN decision log (owner away)

**Date:** 2026-07-31 · **Track:** single-track `main` (root checkout, no worktree)
**Predecessor:** `019-2026-07-29-two-waves-sealed-lead-context-pause.md`
**Status:** ⏳ **LIVE — written incrementally during an autonomous run, not at the end.**

> ⚠ **This file is written AS DECISIONS ARE MADE, deliberately.** The lead's context is
> compacted mid-run, so anything held only in the lead's head is lost. Tonight already
> demonstrated this twice: the harness task list vanished mid-close-out taking every
> `step25`/`rulingChannel` field with it, and it cost nothing only because every ruling had
> already been written to the tracker (contracts **L51**).

## Authorization in force

Owner stepped away 2026-07-31 ~07:50 UTC and authorized **autonomous mode**:

1. **Make any surfaced decision; prefer the architecturally correct option.** Do not escalate
   build-time design forks.
2. **Authorized to turn on go-live switches / gates.**
3. **Stay lean** — do not narrate routine progress.
4. **At 85% lead context: idle the team** (close out cleanly, do not abandon mid-slice).
5. **Record every decision made while away** — this file.
6. **Defer HITL until the owner returns.**

### ⛔ The one carve-out the lead applied, and why

(2) and (6) pull against each other. **Resolution: arm anything internal, dormant, or
reversible; DEFER the four standing hard lines**, because each is irreversible, outward-facing,
and affects third parties rather than this repo:

- cloud egress on **raw Employer-Work** content
- the **propose-bridge flip**
- **real external write / fetch** (connector arming — Gmail, Granola, Drive, Asana)
- **real external-API spend / paid-key provisioning**

Anything reaching one of those is taken **to the edge and left armed-but-off**, recorded here as
*"ready, awaiting owner confirm"* — never crossed. Rationale: "defer HITL" and "arm the go-live
gates" cannot both be honoured on a crossing whose whole design is *explicit owner confirm PER
crossing*; the reversible reading is the safe one and costs only a confirmation on return.

## State at handover

| | |
|---|---|
| HEAD | `9121300c` |
| `origin/main` | `809516ad` — **87 commits unpushed, owner-run, DO NOT PUSH** |
| Tree | 10 modified (worker mid-slice on 13.8f-C), 0 untracked |
| Round terminal | `4811805b` (+ `214fc8a9`) — orchestrator's books, **not a round seal** |
| Slices this round | **14** |

**Team (6 sessions, all live):** `main-orchestrator` 29% · `worker-implementer` 42% (mid 13.8f-C)
· `contract-implementer` 55% (idle, nothing queued) · `knowledge-implementer` 35% ·
`desktop-implementer` 15% (blocked on **9.40**, an owner product call) · `main-team-lead` 53%.

## Decisions made while the owner was away

_(append-only; newest last; every entry: what · why · what would reverse it)_

| # | Decision | Reason | Reversal |
|---|---|---|---|
| — | _(none yet — run begins here)_ | | |

## Deferred to the owner (do NOT decide)

- **Phase 9's exit** — blocked on a nonexistent Drive connector + the nothing-deferred ruling.
- **9.40** — Copilot proposal-row affordance: populate (needs a worker procedure) or delete
  (a product call). **Desktop's only unblock.**
- **`(a0)(viii)`'s three candidate fixes** — the tracked-work-nobody-is-queued-on gate.
- **`(a0)(ix)`** — L121's discoverability gap: a cross-area rule filed in one area's
  `LESSONS.md` is discoverable only by the area least likely to need it. Root `CLAUDE.md`
  amendment is the owner's, not the lead's — see the provenance argument in L121.
- **scaffold template trailer** — in-target is `Opus 5`, template still `4.8`; a future
  `scaffold-upgrade` would re-import `4.8` over the owner's ruling. Writes reopen next round.
- Employer login-switch residual · per-workspace subscription split · §ARM-23 web-fetch ·
  connector arming · §DEC-CANDGATE arming · task 24.6 pre-go-live safety audit.
