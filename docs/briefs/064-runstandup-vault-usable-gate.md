# /tdd brief — copilot_vault_read_usable_gate

## Feature
A small **honest-gate polish** on `gateCopilotVaultReadDeps` (`apps/worker/src/boot.ts:509`): AND an injected **`vaultUsable: (root) => boolean`** predicate into the gate so the read-only `copilot.vault.read` MCP tool is wired **only when the configured `vaultRoot` actually has readable content** — so on the shipped **default empty `<userData>/vault`** the Copilot is NOT offered an inert tool that can only return `SAFE_EMPTY`. Fail-safe: a throwing predicate ⇒ `false` ⇒ inert (never offer the tool when usability can't be determined). `bootWorker` binds a real `createFsVaultUsable()` (exists + ≥1 readable `.md`); tests bind a fake. **This makes the gate honestly reflect the runbook's intended "default = inert, real vault = wired" model** — the tool already works on a real vault today (this is polish, NOT a broken-wire fix; see the piece-1 finding). Byte-equivalent on a real, populated vault; changes behavior only for an empty/absent `vaultRoot` (offers no tool instead of an always-empty one).

## Use case + traceability
- **Task ID:** 13.10d (the read-only vault-page-read gating — the RUN-PATH STANDUP arc's polish; reads/ingest only, propose stays OFF). Ref: the piece-1 verification finding (`copilotVaultRead` is functionally inert on the default vault only because `<userData>/vault` is empty — the gate has no usability check).
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (the read-only GBrain/vault MCP capability surface — REQ-F-019 / KN-2; a read tool should be offered only when it can serve) + the WS-8 read-safety posture (the vault handler is already WS-8-scoped; this only narrows *when the tool is offered*, never widens it). ∈ Phase 13 scope — no widen.
- **Related context (reused, NOT modified):**
  - **The gate** (`boot.ts:509-517`): `gateCopilotVaultReadDeps(gate, scopingActive, buildDeps)` — today `gate.copilotVaultRead === true && gate.vaultRoot !== undefined && scopingActive ? buildDeps(gate.vaultRoot) : undefined`. Pure; `buildDeps` invoked ONLY on the gated-on path. Its ONLY consumers: the boot call site (`boot.ts:1028`) + `test/boot-copilot-read-gating.test.ts`.
  - **The handler** (`copilotVaultRead.ts:88`, unchanged): reads fail-closed to `SAFE_EMPTY` on an empty/absent vault — so the current behavior on the default vault is HARMLESS (empty results), just wasteful (an offered tool that never helps).
  - **vaultRoot flow** (unchanged): `SOW_VAULT_ROOT ?? <userData>/vault` (`main/index.ts:67`) → IPC → `worker-host:169` → `config.vaultRoot` → the gate (`boot.ts:1028`). The default is always a defined-but-empty dir.
  - **Layering:** worker composition-root (boot.ts). No handler edit, no WS-8 change.

## Acceptance criteria (what "done" means)
- [ ] `gateCopilotVaultReadDeps` gains an injected 4th param **`vaultUsable: (root: string) => boolean`**, AND-ed into the existing condition: build deps IFF `copilotVaultRead === true && vaultRoot !== undefined && scopingActive && vaultUsable(vaultRoot)`; else `undefined`.
- [ ] **Empty/absent vault ⇒ inert:** `vaultUsable(root)` false ⇒ the gate returns `undefined` and **`buildDeps` is NOT invoked** (no vault MCP server wired; the tool is not offered). Asserts (RED today): with a fake `vaultUsable → false`, `undefined` + 0 `buildDeps` calls.
- [ ] **Usable vault ⇒ wired (byte-equivalent to today):** `vaultUsable → true` + the existing 3 conditions ⇒ `buildDeps(vaultRoot)` invoked (unchanged from today's behavior on a real vault). Asserts: deps built + `buildDeps` called once.
- [ ] **Fail-safe:** a `vaultUsable` that THROWS ⇒ treated as `false` ⇒ inert (never a thrown boot, never a tool offered when usability is indeterminate). Asserts: a throwing predicate ⇒ `undefined` + 0 `buildDeps` calls (capture + assert unconditionally, Lesson 15).
- [ ] **Real predicate `createFsVaultUsable()`** (pure factory over injected fs ops or `node:fs`): returns a `(root) => boolean` that is true IFF the root exists AND contains ≥1 readable `.md` (mirrors the committed-vault reader's `.md` filter — case-sensitive `.endsWith(".md")`); any fault (missing dir / read error) ⇒ `false` (fail-safe). Bound at the boot call site (`boot.ts:1028`).
- [ ] The existing gate conditions (flag / vaultRoot-defined / scopingActive) are unchanged; the boot call site passes the real predicate; **byte-equivalent on a populated real vault**.
- [ ] All unit tests pass (extend `test/boot-copilot-read-gating.test.ts`); repo-wide `pnpm -w turbo run typecheck test` green; `/preflight` clean.
- [ ] **MANDATORY Step-8 dual review = security-reviewer + code-quality-reviewer** — this narrows a read-capability's activation (fail-safe direction); confirm it never WIDENS (never offers the tool when it shouldn't) + the WS-8 handler is untouched.

## Wiring / entry point (Step 7.5)
`bootWorker` (`boot.ts:1028`) — the existing `gateCopilotVaultReadDeps(config, wsScope !== undefined, buildDeps)` call gains the `createFsVaultUsable()` predicate arg; the gate helper is unit-tested directly (its only non-boot consumer is the gating test). No new entry point — this narrows an existing one.

## Files expected to touch
**Modified:**
- `apps/worker/src/boot.ts` — add the `vaultUsable` param to `gateCopilotVaultReadDeps` + the `createFsVaultUsable()` factory (co-located) + the boot call-site arg.
- `apps/worker/test/boot-copilot-read-gating.test.ts` — extend the vault-read gating cases (usable-true / usable-false / throwing) + a `createFsVaultUsable` unit test (empty dir → false, dir with a `.md` → true, missing dir → false).

## RED test outline (Step 2)
1. **`gate_inert_when_vault_unusable`** — fake `vaultUsable → false` + all 3 other conditions true ⇒ `undefined` + `buildDeps` 0 calls. Why: don't offer an inert tool.
2. **`gate_wired_when_vault_usable`** — `vaultUsable → true` + 3 conditions ⇒ `buildDeps` called once. Why: byte-equivalent on a real vault.
3. **`gate_inert_when_vault_usable_throws`** — `vaultUsable` throws ⇒ `undefined` + 0 `buildDeps` (Lesson 15 unconditional assert). Why: fail-safe.
4. **`fs_vault_usable_empty_dir_false`** — `createFsVaultUsable()` over an empty tmpdir ⇒ false. Why: the default-vault case.
5. **`fs_vault_usable_with_md_true`** — a tmpdir containing `note.md` ⇒ true. Why: the real-vault case.
6. **`fs_vault_usable_missing_dir_false`** — a non-existent path ⇒ false (no throw). Why: fail-safe.

## Cross-doc invariant impact
- **Model field changes:** none — a boot-gate seam. **Orchestrator doc rows:** none expected (an `ARCHITECTURE.md §6` one-liner that the vault-read tool is offered only on a usable vault is an arch-note candidate — flag it). **Shared-contract seam (Appendix-A model) touched?** No.

## Things to flag at Step 2.5
1. **`vaultUsable` semantics — "≥1 readable `.md`" vs "exists" vs "not the default path".** **Default vote: exists + ≥1 readable `.md`** (the honest "is there anything to read" — a populated `<userData>/vault` still works; empty/absent ⇒ inert). Flag if you'd prefer a cheaper "exists + non-empty dir" or a path-based check.
2. **Boot-time evaluation (a vault populated AFTER boot needs a restart).** **Default vote: accept boot-time** — matches the gate model + the auto-ingest model (the owner points at a populated real vault, then launches). Note it in-code. Flag if you want a per-call check (more complex; not worth it).
3. **Injected predicate vs inline fs in the gate.** **Default vote: inject `vaultUsable`** (keep the gate pure + unit-testable; `createFsVaultUsable` is a separate pure factory over fs) — mirrors the arc's injection style. Confirm.
4. **Fail-safe direction.** **Default vote: throw/indeterminate ⇒ false ⇒ inert** (conservative — never offer a tool we can't confirm is usable). Confirm.

## Dependencies + sequencing
- **Depends on:** nothing unlanded (the gate + boot call site + gating test all exist).
- **Blocks:** nothing (piece 3, the run guide, is independent docs work — it documents this behavior).

## Estimated commit count
**1.** A small, focused gate-polish — own commit. ~15–25 lines + tests.

## Lessons-logged candidates anticipated
- **Convention candidate** — "A read-capability activation gate offers the tool only when it can actually serve (a `vaultUsable`-style usability predicate AND-ed in, fail-safe throw⇒inert), so the model isn't handed an always-empty tool; byte-equivalent on a real vault, narrows only the empty/absent case."
- **Architecture-doc note candidate** — an `ARCHITECTURE.md §6` line: the `copilot.vault.read` tool is gated on a usable vault (not just a configured vaultRoot).

## How to invoke
1. Read this brief; note it's a POLISH (the tool already works on a real vault — this narrows the empty-vault case honestly).
2. Run `/tdd copilot_vault_read_usable_gate`.
3. Step 0/1 — confirm the gate + factory + the gating test.
4. Step 2.5 — ping back with answers (or defaults).
5. Step 8 — MANDATORY dual review (confirm the narrowing never widens; WS-8 handler untouched).
6. Step 9 — surface anything beyond the candidates.
