# Phase 1 — Whole-System Security Review (phase-exit gate)

- **Reviewer:** security-reviewer (policy `invariant`; Phase 1 ships the safety-invariant contract + domain surface)
- **Date:** 2026-06-30
- **Review surface:** accumulated Phase-1 diff `cb8ad14..HEAD` over `packages/contracts/src/**`, `packages/domain/src/**`, `packages/db/src/**` (93 files, +5278; 27 Appendix-A models + ajv registry + schema gate + fixtures, 6 state machines + universal validators + no-inference + key builders, Drizzle schema source + repo interfaces).
- **Verdict:** **CLEAR.** No critical/high finding. One Finding (the already-recorded gate-composition contract) — non-blocking; Zod + §3 universal-rules enforcement confirmed present and tested.

## Invariant pass (per Key safety rule)

| # | Safety rule | Result | Evidence |
|---|---|---|---|
| 1 | One writer / no hidden brain | **PASS** | `SignedProvenanceStamp.writerActor = z.literal("KnowledgeWriter")` (schema-gate-caught; invalid fixture `…WrongWriter` proves rejection). `KnowledgeMutationPlan` is the only KW input shape; `GbrainReadGrant`/`GbrainServePolicy` pin `generativeCycleEnabled: z.literal(false)`, `scope: ['read']`, `federationScope: 'workspace_only'`. `QuarantineRecord` models DB-only facts as non-servable parity defects. |
| 2 | Candidate-data gate (REQ-S-006) | **PASS w/ Finding F1** | Structural ajv gate (`validate`) + the model Zod parse (`.refine`) + the §3 universal rules together = the gate. All cross-field invariants ARE in the Zod schemas; the composition is the contract (Lesson 3). See F1. |
| 2 | No-inference (REQ-F-017) | **PASS** | `no-inference.ts` hard-rejects any non-`TBD` value: `evidenceRef===undefined` → `inferred_owner_or_date`; empty/whitespace evidence → `missing_evidence`; only the `'TBD'` sentinel is allowed without backing. No falsy bypass (`0`/`false`/`""` are concrete → require evidence). Pure, deterministic, total. |
| 3 | External-write envelope / no dup writes | **PASS** | §3 rule (b) `ruleExternalWriteKeys` requires non-empty `canonicalObjectKey` + `idempotencyKey` on `ProposedAction`/`ExternalWriteEnvelope` (trim-aware). Key builders are pure SHA-256 over a canonicalized, order-independent preimage — replay-stable (see rule 6). `WriteReceipt` models exactly-once proof. |
| 4 | Workspace isolation | **PASS** | `Workspace` refine couples `id ≡ egressPolicy.workspaceId ≡ providerMatrix.workspaceId`. `GclProjection` is the single cross-workspace shape; §3 rule (d) requires `visibilityLevel` + `workspaceId`; refine forbids raw-content-shaped keys (floor — see F2). `defaultWorkspace()` fails closed (`isolated` visibility, employer dataOwner, egress closed). |
| 5 | Employer-Work egress veto | **PASS (inputs represented)** | `EgressPolicy` refine: `acknowledgedAt` present IFF `employerRawEgressAcknowledged===true` (invalid fixture `…AckWithoutTimestamp` proves it). `ProviderId` enum lists `openrouter` as its OWN value (not an OpenAI alias). `ProviderRoute.egressClass` carries the `local` non-egress marker. `AgentJob` carries `trustLevel`+`carriesRawContent`. The veto *predicate* itself is §5/§7 (post-Phase-1) — contract correctly carries every input it needs. |
| 6 | Untrusted-content tool-stripping (ING-7) | **PASS (catalog-independent half)** | `ToolPolicy` refine + `isToolPolicyConsistent`: `read_only ⇒ !allowsMutating` (invalid fixture `…MutatingReadOnly` proves it). Per-tool mutation classification is deferred (no mutating-tool catalog upstream — documented arch_gap); `AgentJob.trustLevel` present for the §5 admission predicate. |
| 7 | Secrets | **PASS** | No plaintext-secret field/column anywhere. `ProviderProfile` is `.strict()` with NO apiKey/token/secret field (invalid fixture `…InlineSecret` w/ `apiKey:"sk-…"` is rejected by `additionalProperties:false`). All `@sow/db` tables carry REQ-S-003 "no secret column" + column-parity. `tokenRef`/`stampSig`/`sig` are references/signatures, not secrets. No secret-shaped literal in any *valid* fixture. |

## General security pass

- **`any` on contract surfaces:** none (grep clean; sole hit is the word "any" inside a refine message string).
- **Input validation:** every boundary model is `.strict()` Zod (unknown-key rejection) + branded non-empty ids; registry is ajv `strict:true` + format assertions.
- **Injection:** no string-concat-to-system path. Key builders hash all inputs (raw `operation`/identity never emitted into the key; output charset `[a-z0-9_]`).
- **Unbounded loops / DoS:** validators iterate fixed-size record/array fields; the state engine uses fixed adjacency tables (`includes` over a bounded edge list). No user-length-driven loop.
- **ReDoS:** `FACT_IDENTITY_RE` and `MdContentSha` regex use only non-nested quantifiers separated by literal delimiters — linear, no catastrophic backtracking.
- **Determinism / replay:** `canonical-key.ts` / `idempotency-key.ts` / validators / state machine are pure + total — `node:crypto` SHA-256, no clock/`Math.random`/env/I-O; code-unit sort (not `localeCompare`) keeps cross-machine replay stable.
- **Prototype pollution:** validators build fresh arrays/objects and never merge attacker keys into a target; `z.record` parse yields plain objects only read via `Object.values`.

## Findings

### F1 — [medium · Finding · NON-BLOCKING] Candidate-data gate is a *composition*; cross-field safety invariants live only in the Zod `.refine()`s
`packages/domain/src/validation/schema-gate.ts:22` (`validate`) and `packages/domain/src/validation/universal-rules.ts:53` (`ruleSchemaValid`) are both **structural-only** — `zod-to-json-schema` drops `.refine()`, so the emitted JSON Schema (and therefore ajv) cannot see: ToolPolicy `read_only⇒!allowsMutating`, EgressPolicy `ack⇔acknowledgedAt`, KMP non-empty `sourceRefs`, ProviderMatrix `route⊆allowedProviders`, Workspace `id≡embedded`, ParityReport `clean⇒no-hard-divergence`, Divergence `db_only/unstamped⇒hard`, GclProjection raw-key denylist.

**Confirmed mitigations (why this is not a bypass today):**
1. Every one of those invariants **is** encoded in the model's Zod `.refine()` (verified per-model in this review).
2. The §3 universal rules add **independent field-presence** defense-in-depth for the three highest-impact write-through invariants — external-write keys (rule b), scoped/sourced mutation (rule c, REQ-F-006), visibility declared (rule d) — so those do NOT rely on the refine path at all.
3. `packages/domain/test/fixtures/fixtures.test.ts` pins the honesty biconditional against `fullGateAccepts = validate() && ZodSchema.safeParse()` and **explicitly proves** every refine-tier fixture passes ajv but fails the Zod parse.

**Residual (downstream) risk:** a future consumer that treats bare `validate(output, schemaId)` (or only the four §3 rules) as "the candidate-data gate" would admit a refine-violating payload — e.g. a `read_only` ToolPolicy with `allowsMutating:true`, an ack-without-timestamp EgressPolicy, or a KMP with empty `sourceRefs` (the last is independently caught by rule c, the first two are NOT caught by any §3 rule). ToolPolicy/EgressPolicy/ParityReport/Divergence/GclProjection refines have **no** universal-rule backstop.

**Recommended hardening (not required for phase exit):** (a) harden the `schema-gate.ts` module header to state it is structural-only and that the canonical gate MUST compose the model's Zod parse; (b) export a `composeGate(schemaId, ZodSchema)` (ajv ∧ Zod parse) helper so downstream callers cannot reach for ajv-alone; (c) when §5/§6/§7 predicates land, route ToolPolicy/EgressPolicy admission through `*.safeParse`/`isToolPolicyConsistent`, never the registry validator alone.

**Action:** step-9-flag (Finding — already recorded as Lesson 3 / ADR-008). NOT a phase-exit blocker (per dispatch: Zod + universal-rules enforcement present + tested).

### F2 — [low · informational] GclProjection leakage floor is shallow and refine-only
`packages/contracts/src/models/gcl-projection.ts:24` forbids only three top-level key names (`rawcontent`/`body`/`content`, case-insensitive) and does not inspect nested objects; being a `.refine()` it is also subsumed by F1's structural-gate gap. The model documents this as a "shape-gate floor"; full per-`projectionType` leakage enforcement is §5/§6. Recommend the future GCL Visibility Gate (WS-8) implement the allowed-field allow-list and not rely on this floor. **Action:** defer (downstream).

### F3 — [low · informational] ING-7 per-tool stripping, §5 egress veto, and admission-time rejection are not enforceable at the contract layer
No mutating-tool catalog / processor catalog / sensitivity-classifier exists upstream, so ToolPolicy can only pin `read_only⇒!allowsMutating` and EgressPolicy can only carry the ack fields. The Phase-1 contracts correctly **represent** every input the §5/§7 predicates need; the predicates themselves (untrusted⇒reject-on-declared-mutating-tool, raw-employer+ack-off⇒local-only-or-fail-closed) are post-Phase-1. Flag so the providers-integrations/eval-security tracks implement and conformance-test them. **Action:** defer (downstream).

## Scope note
This phase-exit dispatch IS the whole-system security pass for Phase 1; the surface is the accumulated contract/domain/db branch diff (the contract+domain track is a single Phase-1 track, so no over-approximation was needed). The 7 modified `packages/domain/test/state/*.test.ts` files in the working tree are tests (not production code) and were treated as review context, not surface.
