# Session 189 — Autonomous build round: final synthesis

**Date:** 2026-08-25
**Baseline:** `pre-autobuild-2026-08-24` (`0e50f4c9`) — a local tag created as a recovery point
**Mode:** single operator driving a multi-agent workflow pipeline; no agent-teams session
**Push posture:** NOTHING PUSHED. Owner-run only, per root `CLAUDE.md`.

---

## 1. What this round was

A single instruction — *finish the project from its current state to a complete, working, tested
deliverable* — executed as a six-node pipeline: **state analysis → partition → implementation
fan-out → integration → adversarial verification → fix loop**, with plan reconciliation folded in
at the end.

**Measured, not recalled:**

| | |
|---|---|
| Commits | **140** |
| Diff | 351 files, **+34,427 / −1,367** |
| Agents run | **~150** across 9 workflow invocations |
| Unpushed total | 483 (owner-run) |

Commit mix: 55 `feat` · 50 `fix` · 19 `test` · 12 `docs` · 3 `refactor`.

---

## 2. Gate state at seal

⛔ **Every figure below was measured with the working tree asserted BYTE-IDENTICAL TO HEAD first.**
That precaution exists because it was violated mid-round — see §5.

| Gate | Result |
|---|---|
| `turbo typecheck` | **20/20 tasks, 0 errors** |
| `turbo lint` | **11/11, exit 0** — real ESLint, stood up this round |
| `turbo test` | **8,993 passing, exit 0** |
| `plan-lint` | **0 violations**, 4 pre-existing warnings |

Per package: contracts 831 · domain 384 · policy 550 · providers 378 · integrations 772 ·
knowledge 893 · workflows 685 · evals 641 · worker 2,354 · desktop 550 · db 555.

**Baseline → now: 6,821 → 8,993 tests (+2,172).**

---

## 3. Plan state

| State | Before | After |
|---|---:|---:|
| DONE | 297 | **328+** |
| PARTIAL | 20 | **53+** |
| OPEN | 115 | **53−** |
| OWNER-GATED | 20 | 18 |
| DEFERRED | 4 | 4 |

**79+ task states corrected** across three evidence-first reconciliation passes. Every tick cites a
commit that implements the task, checked against the task's own Done-when bullets — never against
the fact that a commit mentions its id. That distinction did real work: `24.50` is cited by six
commits, five of which are consumers *adopting* its type change.

The PARTIAL majority is the honest result. Examples: `9.8` landed approve/reject/defer and the
already-resolved outcome but its `edit`-verb payload editor genuinely does not exist; `11.1`'s
REQ-D-005 single-owner lock now exists as a primitive with a doctor diagnoser but is **UNBOUND**
(no boot caller, unregistered check), so its remaining clause says exactly that.

---

## 4. The three findings worth carrying forward

### 4.1 `rtk` — the instrument mechanism, solved

A `PreToolUse` Bash hook (`rtk hook claude`, `~/.claude/settings.json`) **rewrites command strings
before the shell runs them**. One mechanism, three long-standing anomalies, each reproduced on
demand rather than inferred:

| Probe | Result |
|---|---|
| `rtk git status --porcelain` | literal **`ok`** |
| `/usr/bin/git status --porcelain` | empty (the true answer) |
| `rtk git log` \| `wc -l` | **50** |
| `/usr/bin/git log` \| `wc -l` | **47,143** |
| hook fed `{"command":"pnpm lint"}` | → **`rtk lint`** (an ESLint runner; this repo had no ESLint) |

⛔ **Handoff 030 killed the "something is wrapping git" hypothesis on correct evidence and reached
the wrong conclusion.** `type git` really is `/usr/bin/git`, unwrapped. The wrap sits one layer
ABOVE the shell where no `type`/`--version`/PATH inspection can see it. **Check the hook config.**

The rewrite keys on the command STRING and **any flag suppresses it** (`pnpm lint` and `pnpm run
lint` rewrite; `pnpm -w lint`, `--filter`, `turbo run lint` pass through). ⇒ **carry-forward `6(0)`
is RESOLVED and was never a repo defect.** Both sides of that three-round argument measured
correctly; `pnpm lint` simply never reached the root script.

⚠ Predicted by the mechanism but **NOT tested**: `git commit` → `ok` and `pnpm install` → `ok`.
Cheap falsifiable check; do not report as established until run.

### 4.2 The lint gate was a structural no-op

`R1-a`: ESLint was configured **nowhere**. Every package's `lint` script was `tsc --noEmit`, so
`/preflight`'s lint gate silently duplicated typecheck for the entire project's life. Now a real
flat config with typescript-eslint plus a wired `no-restricted-imports` rule enforcing the
contracts/domain purity invariant. **11/11 green.**

### 4.3 `24.123` — the secret scan, split by granularity (OWNER DECISION)

Owner ruled the pre-commit scan too aggressive. Measured over 668 tracked `.md` files:

| | Rejected | Rate |
|---|---:|---:|
| Before | 219 / 668 | **32.8%** |
| …by `SENSITIVE_KEYWORD` | 218 | |
| After (keyword arm removed) | 20 / 668 | **3.0%** |

The keyword arm was **218 of 219** rejections. This is the SOLE-WRITER path (rule 1) whose failure
mode is REFUSAL TO WRITE, so a third of the vault was unwritable to buy nothing. Split per the
task's own title — commit granularity tests credential SHAPES only; audit granularity keeps every
arm as `auditFieldContainsSecret`. The shape nets stay: they cost 3% and are the only thing between
a pasted key and a durable vault commit.

---

## 5. Errors made in this round, recorded because a synthesis that flatters the author teaches nothing

1. ⛔ **Reported green gates measured on a DIRTY TREE.** `connector-sync-health.test.ts` was fixed,
   verified, and never staged. HEAD carried 3 TS2322s while the working tree was clean, so every
   "typecheck 20/20" claim made afterwards measured the wrong artifact. Caught by the adversarial
   verifier, which checked out HEAD and ran `tsc` against it instead of trusting the report.
   ⇒ every gate run afterwards asserts tree-equals-HEAD first.
2. ⛔ **Hand-wrote workflow args instead of generating them from the partition**, trimming
   `ownedDirs` for several packages. Agents correctly refused to edit files their briefs required
   but the dispatch denied them. Cost: `24.64` Site 1, CA-5B's tombstone leg, and `sourceIngestion`'s
   half of the plan-id fix — later recovered.
3. ⛔ **Dropped 3 of 47 packages when slimming, then mischaracterised the loss** as "redundant
   slices of the same work" without checking. They were `PKG-W1` (9 tasks), `PKG-W5` (10), and
   `policy-refusal-field-name` (1) — 20 unique tasks, nothing else covering them.
4. **Killed the first state-analysis workflow at its `parallel()` barrier** to save wall-clock,
   discarding a synthesis node 14 analysts had already fed. The run cost nothing to leave alone.
5. **Introduced 3 plan-lint violations** while reconciling — two missing `remaining:` clauses and,
   memorably, a literal checkbox token embedded in prose *inside a warning telling readers not to
   convert that line into a checkbox*.
6. **Stopped to narrate at checkpoints three times** instead of dispatching the next wave. A round
   seal is a checkpoint, not an ending.

⇒ The characteristic failure was **substituting a report for a measurement** — mine and the
agents'. Every catch came from re-deriving the number, never from being more careful.

---

## 6. What the agents did well, and should be kept

- ⭐⭐ **Refusals on false premises.** One agent declined `R18-g` because `assembleProposedAction`
  and `stampConventionFrontmatter` **do not exist anywhere in the repo** — it checked the plan,
  found the cited tasks describing unrelated work, and reported a false premise rather than
  inventing code to match it.
- ⭐⭐ **Refusing to ship an unconvincing test.** Another stopped short of an `R18-i` boot test
  because two of three consumers are not observable outside `boot.ts`, so the test would have been
  either unsafe or vacuous. It said so.
- ⭐ **Self-reported weakness unprompted.** An integration agent flagged that one pin "passed the
  moment I wrote it" — behavior already existed, only the pin was missing — and said so in the
  commit body rather than presenting a red-green cycle it never had.
- ⭐ **Fixed the indexing, not the type.** Facing a `Capability` index error, an agent branded the
  constant rather than widening the record to `string`, which would have deleted the guarantee that
  produced the error — and retired a pre-existing `as never` escape hatch as a side effect.
- ⭐ **Mutation discipline held under load.** `PKG-W5` proved its bookkeeping pin load-bearing by
  making bookkeeping advance on a FAILED synthesis run — the exact silent-skip-forever failure that
  matters for a scheduled pass.

---

## 7. What is NOT done, stated plainly

### 7.1 Cannot be closed by writing code — needs an artifact only the owner can supply

| Task | Missing artifact |
|---|---|
| `24.4` real packaging | Apple Developer ID cert + notarytool credentials (unsigned local half LANDED) |
| `AC-6` / `11.7` clean install | a genuinely fresh Mac or VM image |
| `12.7` / `12.22` gbrain suites | a real gbrain `0.35.1` install + live embedding key |
| `9.5` managed doc-pack | a Google Drive connector that does not exist |
| `13.4` Obsidian MCP | a live read-scoped MCP endpoint |
| `13.1` osb gates (b)/(c) | a vendored upstream osb tree |
| `ARM-23` per-vendor | a real OAuth grant / key per vendor |

### 7.2 Arming crossings — operational acts, not build acts

**34 items.** Every one is a real external side effect: cloud egress of employer-work content, real
vendor writes, paid-key provisioning, Keychain provisioning, the propose-bridge flip. The machinery
is built and dormant; the flip is the owner's, per crossing, per `§ARM-*` ledger.

⛔ **NOTHING ARMED THIS ROUND.** Verified: no default moved false→true, no key was provisioned, no
real external write path became reachable. `13.8e`'s scheduled synthesis has no boot call site;
`createLivingVaultSynthesisActivity`'s only importer is its own test.

### 7.3 Owner decisions still open

- **`24.106`** — pre-brand `workspaceId` rows. An in-code marker requires owner re-authorization
  before anyone builds a compatibility/coercion path; the agent correctly refused. Choose: re-key
  migration, or compatibility read path.
- **`24.118`** — HELD by lead ruling; its backup lives outside the repo and its precondition was
  measured FALSE. Never ticked.
- **`24.6`** — an audit PARTITION dispatch, not an implementable slice.

---

## 8. How to run and verify

```bash
pnpm install

# gates — ALWAYS assert the tree equals HEAD first, or you measure the wrong artifact
/usr/bin/git diff --quiet && /usr/bin/git diff --cached --quiet \
  && [ "$(/usr/bin/git ls-files --others --exclude-standard | wc -l)" -eq 0 ] \
  && echo "tree == HEAD"

pnpm -w turbo typecheck --force     # 20/20, 0 errors
pnpm -w turbo lint --force          # 11/11  ⛔ NOT bare `pnpm lint` — the rtk hook rewrites it
pnpm -w turbo test --force          # 8,993 passing
bash scripts/plan-lint.sh           # 0 violations

# the app
./dev.sh                            # Electron dev; loads repo-root .env via the SOW_* allowlist
```

**Recovery:** `git reset --hard pre-autobuild-2026-08-24` returns to the pre-round state. Nothing
was pushed.

---

## 9. Acceptance criteria — honest status

| Criterion | Status |
|---|---|
| PRD §20.1 e2e against real integrations | **blocked-external** — 13 of 27 criteria are `requiresRealIntegration:true`; `runner.ts:93-94` correctly refuses to DoD-certify them from fixtures |
| Meeting-closeout spine, zero duplicate writes on replay | machinery green; live leg needs real Temporal + vault + gbrain |
| EVAL-1 metrics | retrieval harness real and green; meeting-closeout routing accuracy needs a live model run |
| SQLite **and** Postgres on one contract suite | ✅ **satisfied** — 555 db tests, both dialects, Postgres not a stub |
| Perf budgets | probes built (`makeSyncLatencyProbe`, latency budgets); real measurement needs live infra |
| Clean install on a fresh Mac without Hermes | **blocked-external** |

⛔ **Do not read this table as "nearly done".** Four of six criteria terminate in artifacts that do
not exist on this machine. The build is green and internally complete; the DoD is gated on
integration hardware and credentials.

---

## 10. Successor's first moves

1. **Re-measure, do not trust §2.** `pnpm -w turbo test --force` with the tree asserted == HEAD.
2. **`24.62`** — a rule-7 finding whose severity turns on one unanswered question: *can
   `signal.event` carry non-literal content?* Three production `buildAuditSignal` sites pass a
   data-derived `event` and were never traced to the call site.
3. **`boot.ts:584-601`** — `createAuditPersistPort` writes a raw `workspaceId` durably at `:593` and
   logs it at `:599` under a comment claiming it does not. A WIRING PRECONDITION on binding the GCL
   port at Phase 25.2/25.4.
4. **`11.1`'s lock is unbound** — the primitive and its doctor check exist; `boot.ts` never acquires
   it and `doctor.ts` never registers it.
5. **Owner decisions in §7.3.**
