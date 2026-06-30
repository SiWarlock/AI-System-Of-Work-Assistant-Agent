---
description: Look up a topic in the architecture lookup table and read only that section. Usage: /check-arch <topic>
allowed-tools: Read, Grep
argument-hint: "<topic>"
---

Look up a topic in the area `CLAUDE.md` lookup table and read **only that section** of the cited file (`Read` with `offset`/`limit`). Context-efficiency primitive.

Argument: `$ARGUMENTS` — the topic to look up.

## Procedure

1. Read the lookup table in `packages/contracts/CLAUDE.md` (top section, near "Lookup table — where to find canonical info").

2. Find the row matching `$ARGUMENTS`. Match flexibly — partial keyword match, case-insensitive.

3. If a match is found:
   - Read only the cited section of the cited file (use `Read` with `offset` + `limit` to read just that section).
   - Report the section content + its file:section reference.

4. If no match is found:
   - Fall back to `grep` across `ARCHITECTURE.md` for the topic keyword.
   - Report the best matches with file:line references.
   - **Recommend adding a row to the lookup table** if the topic will recur.

## Output format

```
Topic: <argument>
Source: <file>:§<section>

<section content — abbreviated to ~50 lines max; cite further reads if needed>
```

If fallback grep was used:

```
Topic: <argument> (no lookup-table match)
Grep matches:
- <file>:<line> — <snippet>

Recommendation: add a row to the packages/contracts/CLAUDE.md lookup table:
| <topic> | <file> | §<section> |
```

## Forbidden in this command

- **Loading the entire `ARCHITECTURE.md`.** The whole point is targeted reads.
- **Inferring sections beyond what the lookup table or grep surfaces.** If a topic isn't documented, say so; don't fabricate.
