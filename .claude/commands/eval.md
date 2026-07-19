---
description: Run a named eval class. Usage: /eval [category]
allowed-tools: Bash, Read
argument-hint: "[category|all]"
---

<!--
  OPTIONAL COMMAND. Generate this file ONLY if the project has an eval / test-suite
  class worth a dedicated runner command (eval-driven projects). If not, DELETE
  this file and remove its row from the area memory file (CLAUDE.md) + briefing command lists.

  This body is heavily project-shaped. The structure below — argument list →
  mapping table → pre-flight checks → output format → forbidden — is the reusable
  SHAPE. The content inside the EXAMPLE BLOCK is the source project's real /eval
  (an adversarial-AI platform). Replace it wholesale with this project's eval
  structure. Delete this comment.
-->

Run the named eval class.

Argument: `$ARGUMENTS` — one of the categories below; `all` runs the full suite. Default: prompt the user to pick if no argument.

<!-- ▼ EXAMPLE BLOCK [id=eval-body]: /eval body — illustrative shape. Replace wholesale with this project's eval classes. ▼ -->
Run the project's evaluation suites (the `packages/evals` harness) — distinct from `/run-tests` (deterministic unit/integration). Use for the non-deterministic / acceptance surface:

- **EVAL-1** meeting-closeout (≥20 labeled transcripts → routing/project accuracy ≥90%) and retrieval (≥30 queries → relevance ≥90%).
- **WS-7 leakage** suite (≥15 adversarial cases → 0 raw Employer-Work leakage).
- **Prompt-injection** red-team corpus (5 §16.1 vectors + cross-workspace exfiltration).
- **Provider/runtime conformance** matrix (provider × capability × pinned model).

```bash
pnpm --filter @sow/evals eval -- <suite>   # e.g. meeting-closeout | retrieval | leakage | injection | conformance
```

Report per-suite pass/metric vs the §5.4 / §20.1 thresholds. Eval failures are **Findings**, not silent.
<!-- ▲ END EXAMPLE BLOCK [id=eval-body] ▲ -->
