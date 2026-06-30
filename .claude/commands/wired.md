---
description: Trace a feature's call path from a production entry point; report reachable or unreachable. Usage: /wired <feature>
allowed-tools: Read, Grep, Bash, mcp__codegraph__codegraph_context, mcp__codegraph__codegraph_search, mcp__codegraph__codegraph_callers, mcp__codegraph__codegraph_callees, mcp__codegraph__codegraph_trace, mcp__codegraph__codegraph_impact, mcp__codegraph__codegraph_explore, mcp__codegraph__codegraph_node, mcp__codegraph__codegraph_files, mcp__context7__resolve-library-id, mcp__context7__query-docs
argument-hint: "<feature / symbol / file>"
---

<!--
  TEMPLATE NOTE (delete when generating):
  Highly portable. The "production entry points" examples (route / job / contract
  selector / UI handler / package export) generalize across project types — keep
  the list but adapt for the project's actual entry kinds. Fill placeholders.
-->

Trace whether a feature is **reachable from a real production entry point** — not just from its own tests. This is the standalone form of `/tdd` Step 7.5 and the system-level reachability gate. **Tests passing ≠ shipped.**

Argument: `$ARGUMENTS` — the feature, symbol, function, or file to check.

## Procedure

1. **Identify the symbol(s).** Resolve `$ARGUMENTS` to the concrete function/class/module/export under test.

2. **Enumerate the production entry points** this feature should be reachable from. Common kinds across project types:
   - HTTP / API route handler
   - CLI command / script
   - Scheduled job / cron / queue worker
   - UI event handler (button click, form submit, route render)
   - Exported package API (consumed by another workspace)
   - Contract function selector (on-chain ABI)
   - Deploy / migration step
   - Webhook receiver

   Use only the kinds that exist in this project.

3. **Trace the call chain** from each entry point toward the symbol. If a **code-intelligence MCP** (e.g. CodeGraph) is available, `codegraph_trace` answers this in one call (entry point → symbol, including dynamic-dispatch hops grep can't follow) — prefer it, then confirm with targeted reads; no-op when absent. Otherwise walk the wiring with `grep`:
   - The import / `export` of the symbol (is it even exported from its module?).
   - Its registration (route table, job registry, command map, DI container, event binding, ABI).
   - The chain of callers from the entry point down to it.
   ```bash
   grep -rn "<symbol>" <source-roots> --include=<lang-glob>
   ```

4. **Classify each callsite:** is it a production path, or only a test/fixture/mock? A symbol referenced **only** from tests is **unreachable** in production.

## Output

```
Feature: <argument>
Symbol(s): <resolved>
Reachable: YES / NO
  Path: <entry point> → <caller> → … → <symbol>     (when YES)
  Gap:  referenced only from <tests/None>; missing wiring at <where>   (when NO)
Recommendation: <none | wire at <entry point> | raise "Future TODO — belongs to a phase">
```

## Forbidden in this command

- **Counting test-only references as reachable.** A green suite over an unwired feature is exactly the gap this command exists to catch.
- **Fabricating a call path.** If you can't find the wiring, report NO — don't infer an entry point that isn't in the code.
- **Editing code.** This command reports; wiring happens in a `/tdd` slice.
