# Session 057 — Round 6: OSB one-writer governance arc + the owner-authorized (a)→(b) steer

- **Date:** 2026-07-11
- **Team:** `session-f2673cd5` — fresh orchestrator `orchestrator-2` (this doc; authored at the round close since the still-alive `implementer` holds and did NOT `/session-end`) + `implementer` (worker area, stays up).
- **Predecessor:** `056-2026-07-11-phase13-osb-extractor-set.md` (round 5).
- **Round scope:** round 6 = 5 slices. Owner direction C (autonomous, everything DORMANT over faked ports, no real vendor I/O, no HITL flips) for the first 3; then an owner-authorized (a)→(b) steer for the last 2. Repo-wide `turbo typecheck test` 31/31 green throughout; every slice mandatory Step-8 adversarially reviewed.

## What was built

A coherent **OSB one-writer GOVERNANCE arc** (the read edge structurally cannot write the canonical vault) + the owner's authorized (a) sole-writer + (b) frozen-contract slices.

- **`3fdb0c6` — 13.1-a anti-corruption write-path guard + `config/osb.pin`** (brief `017`, `packages/evals/src/osb/`). Pure `scanForWriteSurfaces(files)` denylist token-scan proving no OSB source-extractor / future `vendor/osb` path reaches the `@sow/knowledge` sole-writer / fs-vault / Tool-Gateway write surface (safety rule 1, KN-4/KN-9); non-vacuous via a `scannedCount>0` + count-pin + a data-driven every-token-self-detects backstop. `config/osb.pin` mirrors `config/gbrain.pin` (`osb_tag=v0.11.1`, `subtree_sha=PENDING_NO_SUBTREE` sentinel) + `parseOsbPin`/`validateOsbPin`. Step-8 folded a `copyFile`/`cp` bypass (14→22 tokens, all 0-FP re-verified). **Lesson 12.**
- **`60ebd9d` — 13.4 read-only Obsidian-vault MCP tool surface** (brief `018`, `packages/integrations/.../obsidian-vault-mcp.ts`). `createObsidianVaultReadConnector`: a frozen `mutating:false` descriptor set of the 5 reads + a `Set`-backed fail-safe registry (unknown⇒reject) + a read-only `invoke`; the 3 write tools (`save_note`/`update_note`/`capture`) NOT registered ⇒ no MCP path can write Markdown. Shape-A (a read-tool-descriptor surface in integrations, NOT a `ConnectorPort`/providers-MCP-server) adjudicated under direction C. Step-8 caught a `Set`-not-object prototype-pollution vector. **Lesson 13.**
- **`3fdf748` — 13.1-hardening: guard generalized to the full read edge** (brief `019`). Widened the guard's live scan from the 6 `*-source.ts` extractors to the FULL 16-adapter Connector-Gateway read edge (incl. `obsidian-vault-mcp.ts`) via a pure `isConnectorAdapterScanFile` predicate + count-pin 16; `scanForWriteSurfaces`/`WRITE_SURFACE_TOKENS` byte-unchanged. **The coverage Finding logged on 13.1 + 13.4 is CLOSED.**
- **`1180136` — 13.7b `@user`/`@generated` sentinel markers** (brief `020`, OWNER-AUTHORIZED sole-writer change). Adopted osb's marker vocabulary onto the EXISTING human-section preservation, ADDITIVELY: `@user`→a `HumanSection` whose signature covers the FULL marked span (de-marking un-seizable — the confinement primitive 13.8 rests on); `@generated`→an `AssistantSection` (writer-owned, explicit opt-in); the neutralizer (`noteSlug.ts`) extended with a MACHINE-CHECKED parser↔neutralizer parity. Step-8 verdict **NO WEAKENING FOUND** — `enforceHumanOwnership` gate byte-unchanged (+8/-0 doc-comment); additivity flows through `parseSections`. **Lesson 14.**
- **`58599b3` — 13.7a numbered-block provenance** (brief `021`, FROZEN-CONTRACT round). Added an optional `block?` back-ref to `CanonicalSourceRef` (numbered `(src:Bn)`, orthogonal to `span?`; regenerated the embedder `gbrain-proposed-fact.schema.json`; top-level `.snap` unchanged) + a standalone pure `block-provenance` domain validator (`hasBlockProvenance`/`distillBlockProvenance`/`validateBlockProvenance`). ADDITIVE + DORMANT, NOT wired as a required gate (would drop every ref). Step-8 **NO regression**. Orchestrator wrote the `ARCHITECTURE.md` Appendix A L450 + `packages/contracts/CLAUDE.md` cross-doc rows this round. **Lesson 15.**

## Decisions made

- The OSB read edge is a one-writer GOVERNANCE boundary enforced two ways: a **denylist tripwire** (13.1, generalized to the whole Connector-Gateway read edge in 13.1-hardening) + an **allowlist read-tool registry** (13.4). Lessons 12/13 are the dual.
- **13.4 shape-A** (read-tool-descriptor surface in integrations) adjudicated under direction C — dormant/reversible/non-contract, so within the owner's pre-delegated build-time design authority; the `ConnectorPort` Gateway integration + the real per-workspace MCP server are named follow-ups.
- **Owner escalation at the frontier-exhaustion point:** after 3 slices the orchestrator established (via recon) that the adjacent Phase-13 deterministic candidates were redundant-with-shipped (13.7a preservation-validator; 13.7b human-preservation) or blocked (13.10-vault) or real-I/O — and that 13.7b would touch the sole-writer gate. Surfaced a priority/safety fork → **owner authorized (a) 13.7b sole-writer strengthening (ADDITIVE-ONLY) THEN (b) 13.7a frozen-contract round.**
- **13.7b** additive strengthening via the PARSER not the gate (a +0/-0 gate diff IS the no-weakening proof — Lesson 14). **13.7a** a dormant validator NEVER wired as a required gate until producers emit `block` (Lesson 15).

## Decisions explicitly NOT made (deferred)

- **13.10 Tier-1 vault-catalog** — found BLOCKED on the deferred real obsidian MCP endpoint (the Copilot tool catalog enforces a "servable-under-read-scope" precondition; cataloging the obsidian reads now would be phantom entries). Noted in the plan.
- **Producer coordination for 13.7a** — wiring numbered-block emission into the 13.2 extractors + the generative generator, THEN composing `validateBlockProvenance` as a required gate into `intakeGenerativeProposal` (never before — a block-required gate today drops every ref).
- **Real transports / real vault I/O / real MCP server** (13.4/13.1 subtree vendoring + `subtree_sha` flip) — dormant injection points; no real vendor I/O per direction C.
- **13.3 retrieval / 13.8 living-vault synthesis / 13.9 NotebookLM** — need real model/retrieval/egress I/O (deferred). **13.5 P3-remainder** — worker-composition wiring / Temporal activation.
- Deferred-HITL ledger UNCHANGED (the owner's (a)/(b) were deterministic dormant work, not ledger flips).

## TDD compliance

All 5 slices strict RED→GREEN; mandatory Step-8 adversarial review (fresh general-purpose Agent, security + code-quality) on every slice — each earned its keep (a real `copyFile`/`cp` bypass; a `Set`-not-object prototype-pollution vector; a machine-checked parser↔neutralizer parity; a "NO WEAKENING FOUND" sole-writer verdict; a "NO regression" frozen-contract verdict). Repo-wide `turbo typecheck test` 31/31 green after each. Two research subagents flagged + correctly disregarded benign injected "cite sources" instructions in tool output (prompt-injection defense held; no impact).

## Cross-doc invariant audit

**ONE — 13.7a** (frozen-contract round): `CanonicalSourceRef` gained optional `block?` (shared sub-shape of the frozen Appendix-A model `GBrainProposedFact`). Orchestrator wrote the `ARCHITECTURE.md` Appendix A L450 + `packages/contracts/CLAUDE.md` cross-doc rows this round (implementer regenerated the embedder's JSON schema; top-level `.snap` unchanged — nested add). Slices 13.1-a/13.4/13.1-hardening/13.7b = NONE (additive evals/integrations/knowledge code + dormant markers over the open surfaces; no frozen model touched).

## Reachability

Each slice reachable + self-verified: the guards/validators by their own live conformance suites; 13.7b's parser/gate/neutralizer are on the live KnowledgeWriter commit + projection paths (extended, not dormant-only); 13.7a's field + validator by the contract + validator suites. Production wiring (real transports, MCP server, producer block-emission, required-gate composition) named as follow-ups.

## Open follow-ups

1. **HOLD for owner wrap-vs-continue** — the clean non-HITL dormant deterministic runway is genuinely spent.
2. If continue: **Phase-11 dormant cores** (11.3/11.5, uninvestigated — needs owner priority) OR a real-I/O gate (owner-gated).
3. Producer coordination for 13.7a (block-emission → required-gate composition).
4. 13.10-vault catalog (unblocks when the real obsidian MCP endpoint lands).
5. Real transports / MCP server / retrieval / synthesis (dormant/HITL).

## Lessons banked

**§12** anti-corruption guard (denylist token-scan, non-vacuous count-pin, sentinel pin; deny import PATHS not prose symbols) · **§13** read-only tool surface (frozen `mutating:false` allowlist + `Set`-backed fail-safe registry — the allowlist complement to §12) · **§14** additively strengthen a safety gate by extending the PARSER not the gate (+0/-0 gate diff = the no-weakening proof; marker vocab as one atomic unit w/ machine-checked parser↔neutralizer parity) · **§15** never wire a REQUIRED gate over a NEW field until producers emit it (drops all data else); a frozen additive field on a shared SUB-SHAPE ripples only through its embedder's generated schema.
