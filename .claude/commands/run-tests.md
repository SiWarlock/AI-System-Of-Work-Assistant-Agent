---
description: Run tests by class. Usage: /run-tests [unit|integration|e2e|contract|conformance|eval]
allowed-tools: Bash
argument-hint: "[unit|integration|e2e|contract|conformance|eval]"
---

Run tests by class across the monorepo (pnpm + Turbo). Uniform runner (Vitest) for all tracks; scope with `--filter <pkg>` from a worktree when iterating.

Argument: `$ARGUMENTS` — see the mapping below. Default: `unit`.

## Mapping

| Argument | Command |
|---|---|
| (empty / `unit`) | `pnpm vitest run` |
| `integration` | `pnpm test:integration` |
| `e2e` | `pnpm test:e2e` |
| `contract` | `pnpm vitest run --project contract`  (SQLite+Postgres repository contract, schema snapshots, adapter conformance) |
| `conformance` | `pnpm --filter @sow/evals conformance`  (provider × capability × pinned-model + runtime adapters) |
| `eval` | `pnpm --filter @sow/evals eval`  (EVAL-1 + leakage + injection — see `/eval`) |
| `all` | `pnpm test` |

---

<!-- ▼ EXAMPLE BLOCK [id=test-class-discipline-notes]: per-class discipline notes. ▼ -->

- **`contract`** must run on **both** SQLite and Postgres — Postgres is never a permanent stub (REQ-D-003). A green SQLite-only run does not satisfy the gate.
- **`conformance`** pins exact provider × model pairs; it needs the provider keys (Keychain / env for local) and a reachable local endpoint for Ollama/LM Studio classes, else those rows skip with a clear message.
- **`eval`** (EVAL-1 / leakage / injection) is **non-deterministic** and slow — run per phase / per-PR, not in the per-slice loop. Failures are Findings.
- **Latency/perf** assertions are NOT a test class here — the perf benchmark runs as its own task vs the `ARCHITECTURE.md` budgets, never inside the per-slice RED/GREEN loop (timing is flaky).

<!-- ▲ END EXAMPLE BLOCK [id=test-class-discipline-notes] ▲ -->

## Output

Report: test count + class · pass/fail counts · first ~20 lines of any failure · total duration. If an argument names a class needing an absent precondition (live endpoint, provider key), skip it with a clear message rather than failing the whole run.
