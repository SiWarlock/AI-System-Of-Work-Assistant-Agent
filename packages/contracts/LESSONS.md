<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (shared contracts & domain)

> Full prose for every lesson logged during work in `packages/contracts/`. The compact index lives in `packages/contracts/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. Branded `z.infer` + `declaration: true` → TS4023 — use an explicit interface + `z.ZodType` annotation

**Date:** 2026-06-30.
**Source slice:** Phase-1 contract freeze (tasks 1.3–1.9), commits `512d731` / `4bdedf6`.

The shared branded IDs (`src/primitives/ids.ts`) carry their brand via a module-private `declare const __brand: unique symbol`. When a model's exported TypeScript type is derived with bare `export type X = z.infer<typeof XSchema>` and the schema embeds a branded field, the declaration emitter (`tsconfig` has `declaration: true`) must name `__brand` to write the `.d.ts` for `X` — but `__brand` is not exported, so `tsc` raises **TS4023 "… cannot be named"**. `--noEmit` still runs this check, so it fails the `pnpm typecheck` gate, not just a build.

The fix every branded model uses: declare an **explicit `interface X { … }`** (and an `interface XInput { … }` for the parse-input shape, since branded fields accept plain strings on input and the brand is applied on parse), then annotate the schema `export const XSchema: z.ZodType<X, z.ZodTypeDef, XInput> = z.object({…}).strict()…`. The nameable `X` sidesteps the emitter; `.strict()` unknown-key rejection and `.refine()` invariants are unaffected. For embedded sibling schemas, derive the input shape with `z.input<typeof SiblingSchema>` so the input interface stays in lockstep with the sibling's contract (see `knowledge-mutation-plan.ts`). `egress-policy.ts` is the canonical reference.

**Rule:** A model whose Zod schema embeds a branded ID must export an explicit `interface` + annotate the schema `z.ZodType<Out, ZodTypeDef, In>` — never rely on bare `z.infer` for the exported type.

## <a id="2"></a>2. Zod-as-source contract recipe (ADR-008) — generate the JSON Schema, freeze the field set, import shared shapes

**Date:** 2026-06-30.
**Source slice:** Phase-1 contract freeze (task 1.2 harness + 1.3–1.9), commit `8a42f13`.

Every frozen Appendix-A seam model is authored from **one** Zod schema and ships exactly four files: `src/models/<kebab>.ts` (the `.strict()` schema + `z.infer`/interface type + `X_SCHEMA_ID`), `schemas/<kebab>.schema.json` (the **generated** strict JSON Schema — `emitJsonSchema` via `zod-to-json-schema`, `additionalProperties:false`, never hand-written), `src/models/__snapshots__/<kebab>.snap` (the hand-authored top-level field-name set = the frozen spec), and `test/models/<kebab>.test.ts`. The test (a) freezes the field set against the `.snap`, (b) drift-guards the generated `schema.json` via `freezeGenerated`, (c) exercises valid/invalid fixtures + every `.refine`. The ajv-strict `defaultSchemaRegistry` globs `schemas/*.schema.json` by `$id`; `registry-all.test.ts` proves it compiles all + that every exported `*_SCHEMA_ID` resolves (REQ-S-006 coverage).

Two anti-drift disciplines are load-bearing: **(1)** shared sub-shapes (`ContextRef`, `SourceRef`, the KW mutation primitives, `CanonicalSourceRef`), shared enums, and branded-ID Zod schemas are authored **once** (`shared-shapes.ts` / `shared-enums.ts` / `zod-brands.ts`) and *imported* by composites — re-declaring one inline is the cross-track Finding the freeze exists to prevent. **(2)** `.refine()` conditional invariants are **not** expressible in the generated JSON Schema (`zod-to-json-schema` drops them), so they are enforced by Zod + the model's tests; the ajv gate stays structural (type/required/`additionalProperties`). Deeper cross-field validators are Phase-1 task 1.11. A field add/remove/rename must edit `ARCHITECTURE.md` Appendix A + the schema + the `.snap` in the same round.

**Rule:** Each Appendix-A model ships 4 files (`.ts`/`schemas/*.schema.json`/`__snapshots__/*.snap`/test); the JSON Schema is generated (never hand-written); import shared brands/enums/sub-shapes — never re-declare them inline.

## <a id="3"></a>3. The ajv `validate()` gate is structural-only — the candidate-data gate is a composition

**Date:** 2026-06-30.
**Source slice:** Phase-1 task 1.15 fixtures meta-test (commit `a039e86`); surfaced by the domain-layer consistency critic.

`zod-to-json-schema` (ADR-008) silently **drops `.refine`/`.superRefine`** — a Zod conditional invariant does not appear in the generated JSON Schema. So `validate(output, schemaId)` (the 1.2 ajv gate, REQ-S-006) checks only structure (types, required, `additionalProperties:false`) and **admits cross-field-invariant violations**: a `read_only` ToolPolicy with `allowsMutating:true` (ING-7 / safety rule 6), an unsourced `KnowledgeMutationPlan` (REQ-F-006 / safety rules 1 & 2), an EgressPolicy acknowledged without `acknowledgedAt` (safety rule 5), a `ParityReport` `cleanForServing` carrying a HARD divergence (§12 fail-closed). The 1.15 fixtures meta-test had to use a **full ajv+Zod biconditional** (the literal "validate() ok iff valid" was unsatisfiable for refine-only invalid fixtures), which is what exposed this.

Consequence — the candidate-data gate (safety rule 2) is a **composition**, never ajv alone: ajv `validate()` (structural) **+** the model's Zod `parse` (cross-field refines) **+** the §3 universal rules (`universal-rules.ts` + `no-inference.ts`) **+** the §5/§6/§7 predicates (egress veto, ING-7 admission, GCL visibility). Every §9 meeting validator, §5 admission gate, and §7 broker MUST run the full composition before any side effect. Treating the ajv gate as the whole gate is a reviewer-rejection condition (EVALUATION_CRITERIA).

**Rule:** Never treat the ajv `validate()` structural gate as the complete candidate-data gate — compose it with the model's Zod parse + the §3 universal rules + the §5/§6/§7 predicates.

## <a id="4"></a>4. A security predicate parsing an untrusted URL/endpoint must isolate the authority BEFORE extracting userinfo/host

**Date:** 2026-07-01.
**Source slice:** Phase-3 §5 egress veto (`packages/policy`, task 3.4); found by the adversarial-verify pass, fixed in commit `bc18914`.

The Employer-Work egress veto (safety rule 5) trusts `isLoopbackEndpoint(endpoint)` as PROOF that a route claiming `egressClass:'local'` truly cannot leave the machine. The first-pass hand-rolled `extractHost` stripped URL **userinfo** (`lastIndexOf('@')`) BEFORE stripping the path/query/fragment. URL grammar only allows userinfo inside the **authority** (before the first `/ ? #`); any `@` after that is path/query/fragment, NOT userinfo. So `http://evil.com/@127.0.0.1` (real host `evil.com`) was parsed as host `127.0.0.1` → `isLoopbackEndpoint`=true → `processorOfRoute`=null (non-egress) → the veto ALLOWED raw Employer-Work content to egress to an arbitrary remote host with the acknowledgment OFF. Every standard HTTP client connects to `evil.com` for that URL. The same worked via path/query/fragment/backslash/scheme-less variants; a remote-authority `file://evil.com/…` / `unix://evil.com/…` was likewise mis-classed local.

Fix: **isolate the authority first** — strip path/query/fragment (and backslash, a WHATWG special-scheme path separator) to get the authority segment, THEN take the last `@` within it, THEN the host. For `file:`/`unix:` inspect the authority (`file:///path` is local; `file://host/…` must have a loopback host). Harden the classifier to treat a null/neither-key/both-key route as EGRESS, never non-egress.

Two meta-lessons: **(a)** for any loopback/SSRF/allowlist decision, prefer isolating the URL authority component explicitly (or a vetted URL parser) over a linear strip-in-sequence — order of stripping is a security boundary. **(b) Green unit tests ≠ a safe security gate.** 134 unit tests passed; the CRITICAL bypass was found only by an **adversarial-verify** stage (independent skeptics prompted to REFUTE the invariant, each constructing a concrete bypass input). Run that stage on safety-critical predicates; encode every found bypass as a regression test (`packages/policy/test/adversarial-regressions.test.ts`).

**Rule:** A security predicate that parses an untrusted URL/endpoint must isolate the authority (strip path/query/fragment + backslash) before extracting userinfo/host — stripping userinfo first is loopback/SSRF-spoofable — and must be gated by an adversarial-verify pass, not unit tests alone.

## <a id="5"></a>5. Raw-content/secret redaction cannot be a length or shape heuristic — classify by per-field TYPE, fail-safe redact-unknown

**Date:** 2026-07-02.
**Source slice:** Phase-10.1 mandatory redaction layer (`packages/domain/src/redaction`); the defect was REFUTED by the adversarial-verify pass and took **two full redesigns + one surgical fix**, each re-verified, to reach CLEAR.

The §16 redactor is the mandatory backstop that keeps secrets + raw Employer-Work content (safety rules 5 & 7) out of every log sink. Three successive classifiers each leaked, because each tried to decide "is this string raw?" from the string's own shape:

1. **Length/multiline heuristic** (`multiline || len > 512`) → a **short single-line** raw value (an employer codename, a surname, a short sensitive sentence) under an allowlisted diagnostic field, or inside an `Error.message`, passed after only credential-scrubbing. Also an off-by-one at exactly 512.
2. **Positive token-SHAPE allowlist** (`^[A-Za-z0-9_:.+-]+$`, ≤128) → closed free-form prose (has whitespace) but a **whitespace-free** raw token still passed: a single-word codename, an opaque base64url session token with no credential prefix, a numeric OTP/PIN. You cannot tell `ACME` (raw) from `todoist` (a safe enum) or `824193` (an OTP) from a count by shape.
3. **Per-field TYPE/vocabulary** (the fix that HOLDS): a string is emitted un-redacted ONLY if it is a member of its field's **frozen enum** (`level∈LogLevel`, `failureClass∈FailureClass`, `state∈HealthState`, `event∈EventName`, `provider∈ProviderId`, `targetSystem∈TargetSystem`), an **id under an id-named field** (IDs are §16-loggable + system-generated, never raw), a **number/boolean**, or an **ISO-8601 timestamp** — everything else (free-form message, unknown field, opaque token) redacts. But a **fourth** re-verify caught one more: `isIdNamedKey("providerId")` short-circuited to the id-charset gate *before* the switch, so the intended `providerId∈ProviderId` case was **dead code** — an **id-suffix collision shadowing a dedicated validator**. Fixed by running the enum switch before the generic id rule.

Meta-lessons: **(a)** raw-content detection from a value's own shape/length is undecidable — a short raw word is indistinguishable from a safe token; classify by the field's KNOWN TYPE (frozen-enum membership / id-field / number / timestamp) and **fail-safe redact everything else**, which is the allowlist the spec actually required. **(b)** a name-based heuristic (an `Id`-suffix rule) can silently **shadow a more specific validator** — order dedicated cases before generic fallbacks. **(c)** there is an irreducible **accepted residual** (a secret a caller mislabels under a genuine system-generated id field) — name it, document why it is bounded (ids come from the id-builders, secrets only from SecretsPort), and **pin it as a test** so any future tightening is deliberate. **(d)** adversarial re-verify **each** fix independently until CLEAR — here it took 3 rounds; the first two "green" fixes still leaked.

**Rule:** A mandatory secrets/raw-content redactor must classify each value by its field's known TYPE (frozen-enum membership, id-under-id-field, number, ISO timestamp) and fail-safe **redact everything else** — never a length or token-shape heuristic (a short whitespace-free raw word is shape-indistinguishable from a safe token); run dedicated field validators before any generic name-suffix rule, document + pin the accepted residual, and re-verify each fix until an independent skeptic cannot leak.

## <a id="6"></a>6. Serving-trust context assembly must be honest-by-construction — page-fact-only citation resolution + coverage DERIVED from real parity (never hardcoded green)

**Date:** 2026-07-09.
**Source slice:** G1e-2 `createServingContextLoader` (`apps/worker/src/api/procedures/servingContextLoader.ts`) — the worker-side assembly the real gate-4 serving oracle consumes; a safety-critical serving-trust surface, adversarially reviewed SHIP.

The serving oracle stamps a source `knowledge_writer` (⇒ propose-eligible) only when it can PROVE the content is genuine KnowledgeWriter-authored Markdown. The context loader that feeds it must not undermine that proof by construction:

1. **Citation resolution is page-fact-ONLY.** A `citationId` (`gbrain:<slug>`) resolves to exactly the PAGE fact identity (`[page:<slug>]`) — never the note's link/tag/timeline facts. The page is the sole HMAC-stamped + rehydratable unit; a link/tag identity would fail the gate's content-hash leg (page-hash ≠ fact-hash) and, under all-or-nothing admission, drop the whole page. The resolver is INJECTIVE (distinct citationIds → disjoint fact sets) and WITHHOLDS (null) on unknown / malformed / non-uniquely-resolvable slugs — never guesses.
2. **Coverage is DERIVED + fail-closed, never a constant.** `ServingCoverage` is computed from the real `ParityReport` (cleanForServing/coverageComplete) + the pin-valid + oracle-build-ok legs, and bound to the HEAD committed revision so a STALE-green report (right content, wrong revision) can't defeat the kill-switch. Any absent/dirty leg / unresolved signing key / workspace-id mismatch collapses to `degraded` (a NORMAL cannot-serve state, not a fault); typed `err` is reserved for an actual load fault; the engine never throws (§16). A dormant loader that hardcoded all-green would silently false-admit the instant it's wired.

**Rule:** A serving-trust context assembler resolves citations to the single stamped/rehydratable unit only (page-fact-only, injective, withhold-on-ambiguity) and DERIVES its serving coverage from the real ParityReport + pin/oracle legs bound to the head revision — fail-closed to `degraded` on any absent/dirty/stale/mismatched signal, never hardcode green even while dormant; reserve `err` for load faults, never throw.

## <a id="7"></a>7. A security/governance eval must assert the fail-closed PATH non-vacuously — a positive anchor proves the negatives aren't trivially always-true

**Date:** 2026-07-09.
**Source slice:** the propose-path governance conformance battery (`packages/evals/test/conformance/copilot-propose-governance.test.ts`, runbook §3); the adversarial review's explicit mandate was to REFUTE vacuousness.

A green security eval is worthless if its assertions pass for the wrong reason. Two failure modes to design out:

1. **Vacuous negatives.** An eval asserting "untrusted content ⇒ propose never granted" passes trivially if EVERYTHING is always untrusted (e.g. the trust resolver is stubbed off). Include a POSITIVE anchor — an all-`knowledge_writer` context that DOES yield `trusted` ⇒ propose — so the negatives are proven meaningful (the machinery CAN grant, and correctly withholds). Verify each assertion by deletion/inversion of the guard it pins (does removing the guard make the test fail?).
2. **Wrong surface.** Assert the surface the actor actually sees. A leakage test over an internal error OBJECT misses what the MODEL receives — drive the model-facing handler (`handleCopilotProposeToolCall`) with a secret-bearing input and assert its RETURNED text carries no secret, not merely that some internal error is clean.

Deterministic governance (contentTrust fail-closed, no-auto-apply, payload-swap TOCTOU, server-derived keys) is a conformance BATTERY over the committed functions — egress-free, `requiresRealIntegration:false`; the only real-`query()` end-to-end case is `requiresRealIntegration:true` (real egress) and stays a deferred `it.todo`.

**Rule:** A security/governance eval asserts the fail-closed PATH non-vacuously — pair every "denied ⇒ X" negative with a positive anchor proving the grant machinery works, verify each assertion by deleting/inverting its guard, and probe the actual actor-facing surface (the model-facing handler text), not an internal object; keep it deterministic + egress-free and isolate any real-egress case as a gated `it.todo`.

## <a id="8"></a>8. A prerequisite/health check engine is PURE over an injected probe snapshot — and safety-posture checks fail CLOSED to a finding on any absent/unknown probe

**Date:** 2026-07-09.
**Source slice:** Phase 11.5 install-doctor check-engine (`apps/worker/src/install/doctor.ts` + `checks/*`, `packages/contracts/src/install/doctor-result.ts`); the one-writer posture checks are a REQ-S-NEW-008 / safety-rule-1 surface, adversarially reviewed SHIP.

Splitting the engine from the probes buys determinism + testability + a clean fail-closed default:

1. **Pure over an injected `ProbeSnapshot`.** `runDoctor(snapshot) → DoctorReport` does NO I/O — the real OS/boot probe COLLECTORS (diskutil/Keychain/port-bind/`git remote`/`ps`) are a separate deferred adapter that produces the snapshot. So the whole diagnosis logic (distinct repair per variant, worst-of roll-up, idempotency-as-purity) is unit-drivable with fixtures, and a `safeCheck` try/catch folds any diagnoser throw to a fail-closed `probe_error` finding (§16 never-throws).
2. **Safety posture fails CLOSED — a writable/mispointed mount is NEVER a silent `ok`.** For the one-writer posture (vault-ACL / gbrain read-only-mount / stray-gbrain-process), an ABSENT/unknown/malformed probe outcome defaults to a `finding`, not `ok` (assume-worst; a missing probe can't confirm the prerequisite). The stray-process finding is redaction-safe BY CONSTRUCTION — it names a closed op-label enum (`serve`/`autopilot`/…; unrecognized ⇒ `"unrecognized-writer"`), never raw args/secrets. Guard with `Array.isArray` before `.length` (strings have `.length` too — a `.length`-truthy check false-passes a string).

**Rule:** A prerequisite/health check engine is a PURE function of an injected probe snapshot (real collectors are a separate deferred adapter) so it's deterministically testable and never throws (`safeCheck`→`probe_error`); safety-posture checks default to a `finding` (fail-closed, assume-worst) on any absent/unknown/malformed probe — a writable/mispointed/stray-writer state is never a silent `ok` — and name detected entities via a closed label enum (redaction-safe by construction). **Generalizes** — the same pure-fail-closed-decision-over-injected-results shape recurs in the Phase-11.3 write-through enablement gate (`decideWriteThroughEnablement`, `c4467ee`): a pure AND over injected leg results with a DISTINCT refusal per leg, `enabled`/admitted IFF EVERY leg is explicitly satisfied (never enabled-by-omission), reusing already-built legs (`pinValidatedForEnablement`) rather than rebuilding.

## <a id="9"></a>9. Neutralize boundary markers in content at the SINGLE inner-body source (fixpoint, linear regex) — a content-embedded region marker must never forge/break a region boundary

**Date:** 2026-07-09.
**Source slice:** region-marker neutralization (`neutralizeRegionMarkers`, `noteSlug.ts`; `3daa0c8`) — a §6 region-boundary-integrity / untrusted-content (ING-7) surface, adversarially reviewed BLOCK→FIXED→clean (termination/completeness proof + 300K-input fuzz).

`applyRegionPatch` locates a region by an EXACT `<!-- kw:region:<id> -->` `indexOf`; a `kw:region` marker string embedded in assistant CONTENT could forge/break that boundary (over-/under-replace, touching human content) or mislead `parseSections`. Three load-bearing rules:

1. **Neutralize at the SINGLE inner-body source, not the wrapper.** The same `regionBody` feeds BOTH the create note AND the re-close patch's `newBody` verbatim — neutralizing only the note wrapper leaves the patch path raw (create/patch diverge + the patch re-introduces the marker). Apply ONE shared neutralization at the inner-body builder (the single source), via one helper both projections call (single authority — cf. `meetingNotePath`). Also neutralize any marker in text OUTSIDE the region (e.g. an H1 title before the open marker — an equal forgery vector for `indexOf(open)`).
2. **Run to a FIXPOINT, don't single-pass.** A greedy id class can swallow a nested marker into an outer match's id and leave the inner `<!--` intact. Escape the leading `<!--`→`<\!--` and repeat until the string stops changing: escaping only REMOVES `<!--` (never creates one) ⇒ monotone-decreasing ⇒ terminates, each pass peels one nesting layer ⇒ at the fixpoint no substring matchable by the SUPERSET regex (⊇ every consumer's matcher) remains — graceful (not fail-closed), idempotent, content-preserving (a single escape char, no deletion), clean content byte-identical.
3. **A marker-scan regex on an untrusted-content path must be LINEAR.** Adjacent nullable quantifiers like `\s*/?\s*` backtrack QUADRATICALLY — a ReDoS soft-DoS (measured 60s at 400K ws). Collapse to a single linear class (`[\s/]*`) that stays a superset of the consumer matchers; pin it with a large-whitespace regression test that would time out on the vulnerable form.

**Rule:** To keep boundary markers unforgeable, neutralize any marker string in content at the SINGLE inner-body source that feeds both create + patch (one shared helper; also outside-region text), escaping to a FIXPOINT so no nested/crafted marker survives per any consumer's matcher (graceful, idempotent, content-preserving); and keep every marker-scan regex on an untrusted path LINEAR (no adjacent nullable quantifiers) with a ReDoS regression pin.

**Extends to FRONTMATTER (`be229cd`).** The same threat model + ONE shared helper (`neutralizeFrontmatterValue` delegating to `neutralizeRegionMarkers`) covers model-derived frontmatter VALUES too — `checkOwnership`/`parseSections` scan `MARKER_RE` over the WHOLE note (frontmatter included), so a marker in a model-derived field (title/decisions/attendees/slug) forms a spurious region ⇒ a fail-closed write rejection. Neutralize at the composition site, across BOTH serialize branches (YAML-scalar + JSON-array): a neutralized `<\!--` can only GAIN backslashes on serialization (`<\\!--`), never re-forge `<!--`. Neutralize model-derived values ONLY (human frontmatter is protected, not rewritten), and keep any field a verbatim compare depends on RAW (e.g. `projectId` for the gate-1 `readNoteProjectId`↔`expectedProjectId` check) — server-derived/sanitized fields are marker-free anyway.

## <a id="10"></a>10. A UI-safe read-model inbox lands read-first (empty-until-producer); its producer applies the drop-rules AT WRITE and ships dormant

**Date:** 2026-07-10.
**Source slice:** §9.7 ingestion inbox — 9.7-A read path (`UiSafeIngestionItem` + `query.ingestionInbox`, `1dc53e6`) + 9.7-B write-time producer core (`createIngestionInboxProjectionPort`, `apps/worker/src/api/projections/ingestionInboxProjection.ts`). A WS-8 / leakage (safety rules 2+4) surface; both adversarially reviewed SHIP (0 crit/high/med). Mirrors the recentChanges/`projectDashboardUpdate` read-model pattern.

A user-facing inbox/list read-model is built in dependency order across cycles, and the leakage defense sits at BOTH ends:

1. **Read-first, empty-until-producer.** Cycle 1 ships the READ path + a non-seam UI-safe projection contract (allowlist + `_uiSafeParity` + freeze test — no Appendix-A snapshot/ajv-registry) returning `ok([])` until a producer populates the row; the write-time PRODUCER is cycle 2; the always-on wiring + the desktop mount are named DEFERRED follow-ups. This lets the correct shape + the wrong-alias removal land safely before the (bigger) producer/persistence.
2. **Drop-rules AT WRITE, not only at read.** The producer applies the same UI-safe projection (`toUiSafeIngestionItem` — explicit allowlisted field-copy, drops `origin`/`contentHash`/`routingHints`/`workspaceId`, single-line summary from a SAFE token) BEFORE storing, so the `read_models` blob at rest holds only already-dropped items — raw refs are never persisted. The read boundary STILL re-validates every row fail-closed (`sanitizeIngestionInbox`, whole-list-reject on a poisoned row, cap-N) — belt-and-suspenders. Pin drop-at-write by asserting the raw url/hash/path strings are absent from the SERIALIZED blob, not just that the field is missing.
3. **Deterministic dormant upsert core (no listable domain store needed).** The producer is a pure port over injected `{readModels, now}`: `get(key, ws)` → fault-vs-`not_found` guard → narrow existing (reuse the READ-side narrower for a no-drift read-back) → dedup-by-id + append/remove → `put`. The read_models KV row IS the store (incremental upsert on park/disposition) — no separate listable parked-source table. It ships with NO caller (the always-on invocation runs only inside Temporal → deferred R5-style, exactly like `projectRecentChanges`); §16 never-throws on BOTH `get` AND `put` faults, for BOTH operations.
4. **WS-8 at write = per-workspace key + write-key authority + the POSITIVE keying pin.** Key the row per `(readModelKey, workspaceId)`; fail closed when the caller's `workspaceId ≠ source.workspaceId` (REQ-F-002 — mis-attribution unrepresentable). "Park A ⇒ B reads empty" alone FALSE-PASSES a "producer writes to `(key, null)` global" bug (B reads `(key, B)`=empty either way) — pin the POSITIVE leg: A's row is stored under `(key, A)` specifically.
5. **No-drift pin.** Reuse the read-side narrower for the write-side read-back AND assert write-satisfies-read-contract (`SchemaArray.safeParse` over the produced row) so the producer's output can never drift from the read contract the query enforces.

**Rule:** A UI-safe read-model inbox ships the READ path + non-seam UI-safe contract FIRST (empty-until-producer, mirror recentChanges), then a deterministic dormant PRODUCER that applies the UI-safe drop-rules AT WRITE (no raw refs at rest — the read still re-validates fail-closed), upserts per `(workspaceId, key)` with dedup-by-id + write-key authority (caller ws ≡ source ws) + fault-vs-not_found guard + §16 on BOTH get/put of BOTH ops, ships with NO caller (Temporal always-on wiring + UI mount deferred, like `projectRecentChanges`); pin no-drift via read-side-narrower reuse + write-satisfies-read-contract, pin drop-at-write against the SERIALIZED blob, and pin WS-8 with the POSITIVE keying leg (A stored under `(key, A)`), never just "B reads empty".

## <a id="11"></a>11. An OSB source extractor is EMIT-ONLY over a FAKED transport, with TOTAL never-throws — the whole map runs under one try (the untrusted transport can throw OR resolve `ok` with a pathological shape)

**Date:** 2026-07-10.
**Source slice:** Phase-13 task 13.2 — the web-article extractor (`extractWebSource`, `packages/integrations/src/connectors/adapters/web-source.ts`), mirroring the `youtube-source` (G1) prototype. An untrusted-content ingest surface (safety rules 1/2/6); adversarially reviewed SHIP (0 crit/high) after folding a convergent Step-8 finding.

An OSB/untrusted-content source extractor inherits obsidian-second-brain fetch/analyze as an EMIT-ONLY adapter — it produces CANDIDATE data and NEVER writes:

1. **Emit-only by construction.** The adapter returns a `RegisterSourceInput` candidate (no KnowledgeWriter dep — it structurally CANNOT write); prove it by passing the emitted candidate through the REAL `registerSource()` gate (ajv + Zod `.strict()` + dedupe) → `registered{envelope}`. The candidate flows candidate-gate → `KnowledgeMutationPlan` → `KnowledgeWriter` (sole writer) → Approval Inbox strictly DOWNSTREAM.
2. **The transport is a FAKED, injected seam.** Real fetch (Python subprocess / WebFetch / RSS / file read) is a dormant "REAL-EXTRACTOR INJECTION POINT" — out of scope; tests use a pure fake fn over fixtures (zero network, zero clock). The adapter is a deterministic pure map + hash.
3. **TOTAL never-throws over the UNTRUSTED transport (the load-bearing catch).** The transport is untrusted twice over: it can throw, AND it can resolve `ok` with a pathological/adversarial shape (a null/non-string body, a circular value, a huge/malformed payload — a realistic non-article readability fault). So the WHOLE post-transport mapping (property access, hashing, candidate build) must run under ONE try — not just the transport call — else a mis-shaped `ok` result throws across the seam. Pin it with a "transport resolves `ok` with a null/non-string body ⇒ typed err, never a throw" test, alongside the throwing-transport test.
4. **Fail-closed + no-inference.** A transport fault / empty / whitespace-only / malformed body ⇒ a typed error, NO candidate (never a partial/contentless one). `contentHash` is over the dedupe-stable CONTENT (`{url, text}` / `{videoId, transcript}`), not the volatile metadata. routingHints derive from METADATA only; workspace/sensitivity/sourceId are passed through from policy — never invented from the untrusted body (the no-inference rule); absent metadata is OMITTED, not fabricated.
5. **The `type` token rides the OPEN `SourceEnvelope.type`** (`web_article`/`podcast`/`file`) — a new extractor is purely additive `packages/integrations` adapter code + fixtures, NO frozen-contract/snapshot/Appendix-A round (unless the `type` enum is closed — don't).

**Rule:** An OSB source extractor is an EMIT-ONLY adapter over a FAKED injected transport — a deterministic map from the fetched payload to a `RegisterSourceInput` candidate (contentHash over the dedupe-stable content, routingHints/scope never inferred from the untrusted body), fail-closed on fault/empty/MALFORMED, with the WHOLE mapping under ONE try (the untrusted transport can throw OR resolve `ok` with a pathological shape), proven emit-only + gate-valid by passing the REAL `registerSource()` gate; the real transport stays a dormant injection point (no network in the adapter or its tests); the `type` rides the open `SourceEnvelope.type` (no frozen round).

## <a id="12"></a>12. A structural anti-corruption / one-writer guard is a PURE denylist token-scan over a file FAMILY — deny import PATHS not prose symbols, made NON-vacuous by a count-pin, paired with a sentinel-forced pin

**Date:** 2026-07-11.
**Source slice:** Phase-13 task 13.1 gate (a) — the OSB anti-corruption write-path guard (`scanForWriteSurfaces`, `packages/evals/src/osb/anti-corruption-guard.ts`) + `parseOsbPin`/`config/osb.pin` (brief `017`). A safety-rule-1 (one-writer, KN-4/KN-9) governance boundary; adversarially reviewed SHIP after folding the `copyFile`/`cp` bypass gap (14→22 tokens, all 0-false-positive re-verified).

A "no X may reach Y" boundary (here: no source-extractor / vendored path may reach the sole-writer / fs-vault / Tool-Gateway write surface) is enforced STRUCTURALLY, as a standing conformance test — not left to code review:

1. **Pure scan over injected contents; the fs read stays in the test.** `scanForWriteSurfaces(files: {path,content}[]) → {violations, scannedCount}` is a deterministic pure classifier; the live test does the only I/O (reading the real repo source), so the core is unit-testable with synthetic inputs and the live assertion is a thin wrapper. Reachability is SATISFIED by the live conformance test itself (it runs the guard against the real surface), not judgment-waived.
2. **Deny import PATHS, not prose symbols.** The sole-writer token is the import path `@sow/knowledge` (+ the deep `knowledge-writer` path), NOT the bare word `KnowledgeWriter` — 5 of 6 clean adapters *name* the sole writer in a doc-comment ("emit-only — never calls KnowledgeWriter"), so a prose-symbol token false-positives the entire clean set. Deny the machinery you can't reach without importing it.
3. **Substring for paths/symbols, WORD-BOUNDARY regex for short generic fs-ops.** `writeFile`/`createFsVault`/`ExternalWriteEnvelope`/`tools/adapters` match as substrings; short generic identifiers (`rm`/`rmdir`/`rename`/`mkdir`/`unlink`/`link(`) match by `\b…\b` (or a call-form like `link(`) so prose (`transform`/`renamed`/`filename`/standalone "link") can't false-positive. Cover the real write surface exhaustively (fold `copyFile`/`cp`/`createWriteStream`/`writev`/`truncate`/`symlink` — the plausible bypasses a naive `writeFile`-only list misses).
4. **NON-vacuous via a count-pin — an empty scan is a FAILURE.** A guard that scans zero files and reports "0 violations" is worse than useless. Assert `scannedCount === EXPECTED_COUNT && > 0` against the self-maintaining family glob (`*-source.ts`), so a renamed/moved/deleted member that escapes the glob fails, AND a new member added without bumping the constant fails — the bump is DELIBERATE, and a new extractor is force-scanned. Test catch-power EXHAUSTIVELY with a data-driven "every denylist token self-detects" case driven off each token's own string (so no test `sample` field leaks into the production constant and every future token auto-gets a detection assertion) — the false-NEGATIVE direction is the safety-critical one, not just the 0-false-positive direction.
5. **A sentinel-forced pin so a bump can't silently drift.** Mirror the existing `.pin` file (`config/gbrain.pin`): parseable `key = value` / `#` comments; a TOTAL parser (`split-on-first-=` so a URL query-string survives; typed-`Result`, never throws). The identity/SHA field is a `PENDING_*` sentinel until real vendoring, VALIDATED as sentinel-OR-real (40-hex) so a future bump MUST record the real content-SHA to pass — the pin cannot drift to an undeclared state.
6. **A denylist is a tripwire, not a proof — name the residual + the runtime backstop.** Out-of-model write vectors (`child_process` shelling, a DB-only fact) and a non-conforming-named member are OTHER guards' concern; the runtime one-writer invariant is the real enforcement. Document the scope as defense-in-depth and file the follow-up (derive the scan surface from the `SourceIngestionPort` registry rather than a name convention).

**Rule:** Enforce a one-writer / anti-corruption boundary as a PURE denylist token-scan (injected file contents; fs read in the test) over a self-maintaining file family — deny the write-surface IMPORT PATHS (`@sow/knowledge`, `createFsVault`, fs writes incl. `copyFile`/`cp`, `ExternalWriteEnvelope`) NOT prose symbols (bare `KnowledgeWriter` false-positives doc-comments); substring for paths, word-boundary regex for short fs-ops so prose can't false-positive; make it NON-vacuous with a count-pin (`scannedCount===EXPECTED && >0` — a lost member OR an unbumped new member fails, so a bump is deliberate) + a data-driven every-token-self-detects catch-power test; pair with a mirror `.pin` whose SHA field is a sentinel-OR-real value validated so a bump can't silently drift (TOTAL split-on-first-= parser, never throws); and name the residual (out-of-model vectors, name-convention surface) + the runtime invariant as the real backstop — the scan is a tripwire, not a proof.

## <a id="13"></a>13. A read-only external tool surface = a frozen `mutating:false` descriptor allowlist + a Set-backed fail-safe registry (unknown ⇒ reject) + read-only dispatch — the allowlist complement to Lesson 12's denylist

**Date:** 2026-07-11.
**Source slice:** Phase-13 task 13.4 — the read-only Obsidian-vault MCP tool surface (`createObsidianVaultReadConnector`, `packages/integrations/src/connectors/adapters/obsidian-vault-mcp.ts`, brief `018`, shape A). A safety-rule-1 / KN-4 / KN-9 boundary: registers ONLY the 5 vault read tools, NOT the 3 write tools — so no MCP path can write Markdown. Adversarially reviewed SHIP.

Where Lesson 12 proves "no path REACHES a write surface" by a denylist scan, this is the dual: an ALLOWLIST tool surface where a write tool is never registered in the first place. Enforce it structurally:

1. **A frozen `mutating:false` descriptor allowlist.** Model the read surface as a frozen set of `{ id; mutating: false; description }` specs (mirror the proven `packages/policy/src/copilot-tool-catalog.ts` `CopilotToolSpec` / `COPILOT_READ_TOOLS`). Type `mutating` as the LITERAL `false`, not `boolean` — a read tool then literally cannot be typed mutating. `Object.freeze` the array + specs so the registered set can't be runtime-tampered.
2. **Hold registered ids in a `Set`, NOT a plain-object map.** A plain-object membership lookup (`registered[id]`) opens the `__proto__` / `constructor` prototype-pollution vector — an attacker-supplied `__proto__` tool id "matches" a nonexistent entry. `Set.has(id)` closes it. (This was the load-bearing Step-8 catch.)
3. **Fail-safe: an unregistered id ⇒ REJECT (never a permissive default).** Mirror `isMutatingCopilotTool`'s unknown⇒mutating — an id not in the frozen read set ⇒ `isRegisteredReadTool` false ⇒ dispatch typed-rejects. Unknown AND write ids both reject.
4. **Check the registry BEFORE the seam; whole dispatch under ONE try (never-throws TOTAL).** The fail-safe check runs before the transport is touched, so a write/unknown tool never reaches the seam. Put the `call.toolId` deref + the fail-safe check + the transport call + the result map ALL inside one try so even a malformed call (null / a throwing getter) resolves to a typed err instead of a rejected promise (Lesson 11, taken to totality).
5. **Excluded write tools are name LITERALS, never call targets.** The 3 write ids (`save_note`/`update_note`/`capture`) live only in an exclusion constant asserted absent from the registry — never registered, never dispatched; their name strings don't match the code-shaped write-surface tokens (so they don't trip the Lesson-12 self-check either).
6. **Outside the canonical guard's scan surface ⇒ a NON-VACUOUS inline self-check.** When the module sits outside Lesson 12's `*-source.ts` denylist-guard scan surface, back its structural one-writer with its OWN inline write-surface check — and make it non-vacuous (a data-driven self-detect: every token flags a synthetic line), else a misspelled/missing token passes green (the exact Lesson-12 vacuity gap). Document the coverage-bound divergence + file the follow-up (derive the canonical guard's surface from a registry so it covers this file too).

**Rule:** Model a read-only external tool surface as a frozen `mutating:false` (literal-typed) descriptor allowlist + a `Set`-backed fail-safe registry (an unregistered id ⇒ rejected, never permissive — mirror `isMutatingCopilotTool`; a plain-object map opens `__proto__`/`constructor` prototype-pollution, a `Set` closes it) + a read-only dispatch that checks the registry BEFORE the seam and runs the whole deref+check+call+map under one try (never-throws TOTAL, even a malformed call); the excluded write tools are name literals, never registered/reachable; if the module sits outside the canonical anti-corruption guard's (Lesson 12) scan surface, back it with a NON-vacuous inline write-surface self-check and document the coverage-bound. The allowlist-registry complement to Lesson 12's denylist-scan tripwire.

## <a id="14"></a>14. Additively strengthen a safety-critical gate by extending the PARSER that feeds it, NOT the gate — a +0/-0 gate diff IS the no-weakening proof; adopt a new marker vocabulary as one atomic unit with machine-checked parser↔neutralizer parity

**Date:** 2026-07-11.
**Source slice:** Phase-13 task 13.7b — adopting osb's `@user`/`@generated` sentinel markers onto the KnowledgeWriter's human-section preservation (`sections.ts` parser + `ownership.ts` gate + `noteSlug.ts` neutralizer, brief `020`). An OWNER-AUTHORIZED, ADDITIVE-ONLY change to the sole autonomous Markdown writer's ownership gate (safety rule 1, KN-4/KN-9, forbidden-pattern #4). Step-8 verdict: NO WEAKENING FOUND.

When you must ADDITIVELY strengthen a safety-critical gate (here: expand what counts as human-owned + protected) without any risk of weakening it, the technique + its proof:

1. **Extend the PARSER that FEEDS the gate, not the gate logic.** The ownership gate (`enforceHumanOwnership`/`checkOwnership`) was left BYTE-UNCHANGED (diff +8/-0, a doc-comment only); the new protection flows entirely through `parseSections` now yielding an extra `HumanSection` for a `@user` region. **A +0/-0 diff on the gate IS the machine-checkable no-weakening proof** — the gate cannot have weakened because it was not touched; more coverage arrives purely as more protected sections. Prefer this shape over editing the predicate whenever a safety guarantee must only ever grow.
2. **Adopt a new marker/token vocabulary as ONE atomic unit: recognition + gate + neutralizer.** A parser that recognizes a boundary marker has a paired NEUTRALIZER (Lesson 9) that defuses content-embedded markers so untrusted content can't forge a boundary. Shipping recognition WITHOUT the neutralizer extension leaves an unsafe intermediate (a content-embedded new marker forges a region) = a weakening. So they ship together, one commit.
3. **Pin the parser↔neutralizer PARITY, machine-checked against the REAL parser.** Assert the neutralizer defuses EVERY form the parser recognizes (`neutralizer ⊇ parser`: post-neutralize ⇒ the real `parseSections` finds 0 boundaries) — not two hand-mirrored regexes that can silently drift. The neutralizer being a deliberate BROADER superset (case-insensitive / whitespace-tolerant) is the safe direction; the parity test proves no recognized-but-undefused marker (= no forge vector).
4. **Capture the FULL marked span so DE-MARKING is caught, not just content-edits.** A protected region's signature must cover the markers + inner body, so stripping the boundary to seize the region diverges the signature and is rejected. For a confinement primitive ("provably never overwritten"), "overwritten" must include seize-by-de-marking — pin it with its own test, don't just claim it.
5. **Prose-safe syntax + additive-to-the-owned-set.** Use an HTML-comment-wrapped marker (not a bare token) so ordinary prose is never false-matched (clean-content stays a no-op — Lesson 12). And new recognition must be ADDITIVE to the owned set, never RECLASSIFY currently-protected content: recognizing a writer-marker must not let a writer SEIZE human text (the absorption catch fires); only content EXPLICITLY carrying the marker reclassifies (= correct opt-in semantics, forge-path closed by #2/#3).

**Rule:** To additively strengthen a safety-critical gate, extend the PARSER that feeds it, not the gate — a +0/-0 gate diff IS the no-weakening proof (the guarantee can only grow). Adopt a new boundary-marker vocabulary as ONE atomic unit (recognition + gate + neutralizer), pin a MACHINE-CHECKED parser↔neutralizer parity (neutralizer ⊇ parser ⇒ no forge vector, Lesson 9), capture the FULL marked span so de-marking (not just content-edit) is rejected, use a prose-safe HTML-comment syntax so clean-content is a no-op (Lesson 12), and keep recognition additive-to-the-owned-set (never reclassify/seize currently-protected content). Then a Step-8 review can VERIFY no-weakening by diffing the gate + running every prior test byte-for-byte green.

## <a id="15"></a>15. Never wire a REQUIRED validation gate over a NEW field until producers emit it (else it drops all existing data); a frozen additive field on a shared SUB-SHAPE ripples only through its embedder's generated schema

**Date:** 2026-07-11.
**Source slice:** Phase-13 task 13.7a — numbered-block provenance: an additive optional `block?` on the frozen `CanonicalSourceRef` + a standalone `packages/domain/src/validation/block-provenance.ts` validator (brief `021`). A FROZEN-CONTRACT round, owner-authorized, DORMANT. Step-8: genuinely additive + dormant, NO regression.

1. **The dormant-gate trap.** When you add a validator over a NEW field, do NOT compose it as a REQUIRED gate into a live path until PRODUCERS emit that field — a "require `X`" gate applied today rejects/drops EVERY existing record (none carry `X` yet). Here, wiring `validateBlockProvenance` (require-block) into `intakeGenerativeProposal` would have dropped every `evidenceRef` (no producer emits `block`), breaking the generative path. So the validator ships STANDALONE + fixture-tested + DORMANT; the required-gate composition lands WITH producer emission, never before. Pin the dormancy: a regression test that the live path is byte-untouched + the validator has zero non-test callers.
2. **Frozen additive field on a shared SUB-SHAPE.** `CanonicalSourceRef` is a shared sub-shape, not a top-level Appendix-A model — so an additive field ripples ONLY through its embedder's (`GBrainProposedFact`) generated JSON schema. The consequence for the frozen-contract-round file-list: regenerate the EMBEDDER's `schemas/<embedder>.schema.json` (the nested field appears in `evidenceRefs.items`); the `freezeGenerated` (whole-JSON-schema) test leg catches the nested add, but the top-level `fieldSet` `.snap` is UNCHANGED (the field is nested, not a top-level key) → NO `.snap` edit. Because `freezeGenerated` asserts checked-in schema == `emitJsonSchema(Zod)`, regenerating it transitively proves BOTH candidate-gate layers (ajv structural + Zod) accept the field — no separate ajv test needed (LESSONS §3).
3. **Explicit-field-pick forward-safety.** At a consumer boundary that maps one shape into a downstream `.strict()` shape (here `evidenceRefs → sourceRefs` into the KMP), use an explicit field-PICK, NOT a spread — so a NEW optional field cannot silently leak into the downstream strict shape when producers eventually populate it. The pick is what keeps the dormant field truly inert end-to-end.
4. **Keep the new field's format OPAQUE until a producer defines it.** `block` is `z.string().min(1)`, not `^B\d+$` — over-constraining a frozen field before its producer exists risks a re-freeze. Let the validator (a `.trim()` non-empty check) carry trace-worthiness; keep the contract permissive.

**Rule:** Never wire a REQUIRED validation gate over a new field into a live path until producers emit that field — a required gate today rejects every existing record; ship the validator STANDALONE + dormant + fixture-tested, regression-pin the live path byte-untouched (zero non-test callers), and compose the required gate WITH producer emission. For the frozen-contract add: a field on a shared SUB-SHAPE ripples only through its EMBEDDER's generated JSON schema — regenerate that (`freezeGenerated` catches the nested add + transitively proves ajv+Zod both accept it), the top-level `fieldSet` `.snap` stays unchanged. Use an explicit field-PICK (not a spread) at any shape→`.strict()`-shape boundary so the new optional field can't leak downstream until intended, and keep the field's format OPAQUE until its producer defines it (avoid a premature re-freeze).

## <a id="16"></a>16. Make-it-real live-Temporal activation reuses the proof-spine assembly (only the already-real gate runs real over deterministic leaves); a workflow dispatch is idempotent BY CONSTRUCTION

**Date:** 2026-07-11.
**Source slice:** the make-it-real Option-C arc C1 (`25f14d0`, live `sourceIngestion` on a `@temporalio/testing` `TestWorkflowEnvironment` worker) + C3a (`7a471d3`, `dispatchSourceIngestion`), briefs `022`/`026`.

1. **Activate a dormant workflow by REUSING the proven assembly, not a parallel one.** To bring a previously-uncalled §9 driver live on a real (LOCAL) Temporal worker: register it in the SAME sandbox bundle (`workflows.ts`) + build its activity set through the SAME `buildProofSpineActivities`/`buildRegisteredActivities` path the existing proof spine uses — no divergent hand-rolled activity object. The live integration test uses `TestWorkflowEnvironment` (ephemeral loopback test server, 100% local — no Cloud/remote namespace/egress) exactly as the proof-spine capstone does.
2. **Guardrail-3 shape: real orchestration over deterministic leaves.** When first making a pipeline "real", only the already-real, pure gate (`registerSource()`) runs for real; every downstream leaf (agent/commit/propose/index) stays a DETERMINISTIC composition-root fake built INLINE (never import `test/support` into prod — a layering violation). Real Temporal scheduling + activity execution is the thing proven live; the leaves swap to real one at a time, each behind its own owner gate.
3. **Idempotent dispatch by construction.** Make the deterministic source key BE the Temporal `workflowId` + set `WorkflowIdReusePolicy: REJECT_DUPLICATE`; a re-dispatch throws `WorkflowExecutionAlreadyStartedError` (symbol-`instanceof` on `@temporalio/common`), which you FOLD to an idempotent-SUCCESS no-op (not a failure). This gives TWO independent dedupe guards — Temporal's workflowId reuse AND the driver's own `resolveRun`. Content-version the key (`src:${ws}:${contentHash}`) so an EDIT re-ingests but a duplicate EVENT dedupes.
4. **Confine the concrete Temporal Client to a thin adapter behind an injected port.** `dispatchSourceIngestion` is PURE over an injected `StartWorkflowRun` port; the real `createTemporalClientStartRun(client)` adapter wraps `client.workflow.start`. The gated test drives the SAME real adapter via `env.client` — so it's genuinely tested, not dormant — while the pure core stays degraded-testable with no server. Defer the boot Client composition to its FIRST REAL CALLER (don't ship a dormant untested live-client boot seam — reachability discipline). Degraded-safe = a typed err + a `worker_down` §16 item (Temporal-down IS infra) + NEVER throw, including on a nullish input or a health-sink fault.

**Rule:** To activate a dormant workflow for real, reuse the existing sandbox-bundle + `buildRegisteredActivities` assembly (one path, no divergence) on a LOCAL `TestWorkflowEnvironment`; run only the already-real pure gate for real and keep every other leaf a deterministic composition-root fake (guardrail-3, no `test/support` in prod). Make dispatch idempotent by construction — the deterministic (content-versioned) source key IS the Temporal `workflowId` under `REJECT_DUPLICATE`, `AlreadyStarted` folded to a success no-op, backstopped by the driver's `resolveRun`. Confine the concrete Client to a thin adapter behind an injected port (degraded-testable + the SAME adapter runs under `env.client`), defer the boot-Client composition to its first real caller, and make the dispatch degraded-safe: typed err + `worker_down` §16 item + never-throw.

## <a id="17"></a>17. Real LOCAL connector I/O safety = realpath ROOT-containment before open + bounded/typed reads + a SINGLE authoritative predicate + workspace-bound-by-config (never content-inferred) + TOTAL never-throws

**Date:** 2026-07-11.
**Source slice:** the make-it-real arc C2 (`8a48833`, `createFileReadTransport`) + C3b (`571ab33`, the vault file-watcher capstone), briefs `023`/`027`.

1. **ROOT-containment is the arbitrary-file-read boundary — resolve to realpath + assert BEFORE opening.** A real `node:fs` read transport takes an allowed `root`; it `fs.realpath`s both `root` and the resolved target and requires `realTarget === realRoot || realTarget.startsWith(realRoot + sep)` (the `+ sep` kills the `/root-evil` sibling-prefix bypass) BEFORE any `readFile` — so a `../` traversal / absolute-outside / symlink-escape reads ZERO bytes (typed `unreachable`, no `file` field). A string-only prefix check is NOT acceptable for a security boundary. Read the resolved `realTarget` (not the raw path) to shrink the check→read TOCTOU window; fail CLOSED on a bad/missing root.
2. **Bounded + text-only + redacted.** Cap the read (max-bytes → typed reject, never an unbounded buffer); NUL-byte-sniff a binary file → typed `unknown` (don't emit garbage-text as content); errno-ONLY fault messages (never leak the absolute path).
3. **A safety predicate lives ONCE — reuse it, don't mirror it.** When a second surface (the file-watcher) needs the same containment as a pre-filter, EXPORT the transport's pure predicate (`isContainedUnder`) additively and reuse it — a duplicated containment check, even a "pre-filter", is a drift risk on a security boundary. Containment is double-GUARDED (watcher pre-filter + the transport's authoritative read-confinement) but single-SOURCED.
4. **Workspace-bound by CONFIG, never content-inferred (WS-2 / REQ-F-017).** A capture trigger is constructed with an explicit `{ root, workspaceId, sensitivity }` policy binding (vault-per-workspace); the captured `RegisterSourceInput` takes those verbatim + a path-derived `sourceId` — NEVER infer the workspace/sensitivity from the file path or content (pin it with a decoy-content test that names another workspace).
5. **TOTAL never-throws — even a SYNCHRONOUS start-throw.** The whole capture/dispatch handler is fail-closed; and `fs.watch` can throw SYNCHRONOUSLY at start (missing root / fd-exhaustion) — catch that too (a no-op watcher + a warn), or it crashes the whole control-plane boot + leaks the Temporal Connection. Use a lazy Client connect so a down Temporal degrades instantly instead of stalling boot; ship the watcher behind an OFF-by-default flag.

**Rule:** A real LOCAL connector read confines to an allowed root by REALPATH containment asserted before any open (reject `../`/absolute-outside/symlink-escape as typed errs reading zero bytes; `+ sep` sibling-prefix guard; read the resolved realTarget; fail-closed on a bad root), bounds the read + NUL-sniffs binary + redacts to errno-only, and reuses ONE exported authoritative containment predicate (never a mirrored copy). Its captured source is workspace-BOUND by config (vault-per-workspace), never content-inferred (WS-2/REQ-F-017, decoy-content pinned). The handler NEVER throws — including on `fs.watch`'s SYNCHRONOUS start-throw (else it crashes boot + leaks the connection) — uses a lazy Client connect for instant degrade, and ships flag-OFF by default.

## <a id="18"></a>18. A §16 health failure-class must reflect the CAUSE not the resting state; a frozen-taxonomy expansion's consumer ripple must be EMPIRICALLY surveyed, and a new class that needs distinct handling gets ONE assertNever-guarded decision point

**Date:** 2026-07-11.
**Source slice:** the make-it-real arc C-fix (`77c717e`, cause-aware failure-class) + C-enum (`0fea74c` + mirror `97759a7`, the `FailureClass` frozen-contract expansion), briefs `024`/`025`.

1. **Class by CAUSE, not by resting state.** A state that conflates causes (`failed_terminal` ← register-malformed schema-reject, injection/admission/egress, ownership/secret, commit-failed) must NOT map all of them to one class (`worker_down`) — that mislabels a data-validation reject as infra-down, breaking the §16 "distinct health item per failure class" invariant. Thread a cause-derived class from each failure SITE (pure per-code helpers) with the resting-state map as a non-terminal default only; RESERVE `worker_down` for genuine supervision/infra (a Temporal-unavailable dispatch failure IS `worker_down` — correctly). Where the frozen enum lacks a member, use a least-wrong member + a greppable `arch_gap` marker + keep the cause code in the surfaced MESSAGE (nothing lost) — then escalate the enum expansion as a category-4 owner decision (don't bundle it into the focused fix).
2. **Survey the consumer ripple EMPIRICALLY — don't assume it.** Before a frozen-taxonomy expansion, dispatch a read-only survey: a `FailureClass` may be a PASS-THROUGH discriminant (open severity string, generic `humanizeToken`, import-derived self-updating redaction set, `Partial<Record>`, the lone `assertNever` on a DIFFERENT enum) → ZERO tsc-breaking exhaustive switches AND zero mis-bucketing `default` switches, so the "handle every consumer" ripple the brief guarded against doesn't exist. The only pin to bump can be a membership TEST. `tsc`-exhaustiveness catches switches WITHOUT a default; a `default`-carrying switch won't break but could silently mis-bucket a new member — hand-audit those too.
3. **Give a new class needing distinct handling ONE assertNever-guarded decision point.** Where a new member DOES need behavior (severity), add a single pure exhaustive `defaultSeverityForFailureClass(fc)` (`assertNever`-guarded so a FUTURE member MUST get a deliberate value) at the one site that assigns it (`materializeHealthItem`'s `input.severity ?? default`; producer-explicit severity still wins). That turns "the ripple doesn't exist" into "so add the ONE deliberate decision point with a tsc-enforced forward-guard" — precisely the no-silent-mis-bucket property, placed where it matters. Security/isolation → critical; policy/egress → error.
4. **The frozen contract's canonical-doc mirror commits IMMEDIATELY.** An additive enum expansion is a frozen-contract round (Zod + regenerated JSON schema + snapshot + Appendix A + cross-doc mirror); the ARCHITECTURE.md/area-CLAUDE.md mirror commits in its OWN `docs()` commit right after the schema, NOT accumulated with general tracker edits — a frozen contract's canonical doc must not drift from its committed schema across intervening commits.

**Rule:** A §16 failure-class reflects the CAUSE not the resting state — thread a cause-derived class from each failure site, reserve `worker_down` for genuine infra, and where the frozen enum lacks a member use a least-wrong member + a greppable `arch_gap` + the cause in the message, escalating the expansion as an owner call. Before a frozen-taxonomy expansion, EMPIRICALLY survey the consumer ripple (a pass-through discriminant can have zero tsc-breaking consumers; hand-audit `default`-carrying switches tsc won't catch); where a new class needs distinct handling, add ONE `assertNever`-guarded decision point so future members can't silently mis-bucket. Commit the frozen contract's canonical-doc mirror immediately in its own `docs()` commit — no drift across intervening commits.

## <a id="19"></a>19. Real install-doctor probe COLLECTORS = pure mapper over an injected exec/net port + a thin real adapter, never-throw fail-closed; a safety-posture collector fail-closes an ABSENCE of confirmation to a finding + classifies into a CLOSED label set (the redaction primitive)

**Date:** 2026-07-12.
**Source slices:** the Phase-11 install-doctor collector arc — 11.5-a (`5171f2a`, prerequisite probes) · 11.5-b (`76cf02f`, macOS-security probes) · 11.5-c (`0646df7`, one-writer POSTURE probes, safety rule 1+7), briefs `028`/`029`/`030`. Completes Lesson 8 (which built the pure engine + deferred "real collectors = separate adapter" — this is that adapter's safety contract).

1. **Pure mapper over an INJECTED port + a thin real adapter.** Each collector is a pure data-mapper over an injected `RunCommand` (a local `execFile`) / `ProbeLoopbackBind` (a `net` bind) port; the real adapter is thin + LOCAL-ONLY and never throws across the seam (every fault → a typed outcome the collector fail-closes). So the collectors are unit-testable with fakes, the adapters exercised only under a gated (`SOW_DOCTOR_REAL`) test — the default suite never shells out.
2. **Exec safety is the crux — fixed argv ARRAY, no shell, absolute bins.** Run a bin + an argv ARRAY with `shell:false` (NO shell-string / command-injection surface); the argv is a per-probe CONSTANT (config values ride as a fixed positional / `cwd`, never concatenated into a command); bound with `timeout` + `maxBuffer`; report faults as an errno `code` ONLY (never the raw stderr / an absolute path `e.message` leaks). Use ABSOLUTE system bins for the security-sensitive probes so a hostile `PATH` can't shadow them — `/bin/ls`·`/sbin/mount`·`/bin/ps` for the POSTURE probes AND `/usr/bin/fdesetup`·`/usr/bin/security` for the security-STATE probes (task 11.5-e); the version-PRESENCE bins (`node`/`pnpm`/`temporal`/`gbrain`) stay BARE by design (the check IS PATH-presence + version — absolutizing would defeat it). ✅ CLOSED residual (11.5-e `9fa5760`): a `-`-leading positional PATH now rides after a `--` end-of-options separator (`/bin/ls -lde -- <path>`), so it can never be read as a flag.
3. **A safety-posture collector fail-closes an ABSENCE of confirmation to a finding.** Can't-prove-the-negative ⇒ assume the unsafe state: vault-ACL is a READ-ONLY allowlist (owner==worker AND no group/other write AND every extended-ACL entry a deny-or-worker-allow; an unknown/empty perm ⇒ assume WRITE; require an EXACTLY-10-char mode string — a short mode slipping the length check is a fail-OPEN a review caught); gbrain-mount ok only when read-only AND exact-canonical; a `ps` fault OMITS the stray-process field so the engine's `p == null` branch fails it closed (we cannot confirm "no stray writer").
4. **Classify-into-a-CLOSED-label-set is the redaction primitive for an untrusted scan.** The stray-process collector emits ONLY a `StrayGbrainOp` from the frozen closed set — never a raw `ps` line / argv / path / secret (redaction-safe BY CONSTRUCTION, Lesson 8). Classification keys on the EXECUTABLE token (a launcher-wrapped `sudo gbrain serve` still classifies; `grep gbrain serve` — grep IS the exec — does not) + EXACT-normalized canonical-brain path binding (a different brain ⇒ not stray) + fail-closed-stray on an UNRESOLVABLE brain arg.

**Rule:** A real install-doctor probe collector is a PURE mapper over an injected exec/net port + a thin LOCAL-only never-throwing adapter; fail-close each probe to the assume-worst shape the pure engine maps to a `finding` (Lesson 8). Exec safety = a fixed argv ARRAY (`shell:false`, config never string-concatenated), bounded timeout+cap, errno-only redaction, ABSOLUTE bins for security-sensitive probes. A safety-posture collector fail-closes an ABSENCE of confirmation to a finding (can't-prove-negative ⇒ assume unsafe: ACL read-only allowlist, exact-10-char mode, ps-fault-omits-field) and classifies a detected entity into a CLOSED label set (the redaction primitive — key on the executable token + exact-path binding, never echo raw args). **Pin:** per-probe fast-unit fakes (green/assume-worst/malformed/fault) + a fixed-argv/no-shell assertion + a gated `SOW_DOCTOR_REAL` real-adapter test.

## <a id="20"></a>20. The reachability-waiver-holder pattern: ship a pure engine + real collectors DORMANT behind a documented waiver, then ONE composition-root ENTRY makes the whole chain reachable in a single reviewed slice; a multi-instance worst-of fold HOISTS shared probes to run exactly once

**Date:** 2026-07-12.
**Source slice:** the Phase-11 install-doctor CLI/repair command 11.5-d (`8d71c64`, the `sow-doctor` bin — closes the 11.5-a/b/c reachability waiver), brief `031`.

1. **Ship dormant behind a documented reachability waiver, then close it with ONE entry.** A pure engine + real collectors can land unreachable-by-design (each unit/gated-testable + independently reviewed) behind an explicit reachability waiver — then a SINGLE composition-root ENTRY (real adapters + config resolution + a PURE render + exit-code core) makes the WHOLE chain reachable in one reviewed slice; `/wired` traces from the entry; the waiver is CLOSED. (Same shape as the serving oracle-core + the G1e-2 loader landing dormant.)
2. **A report-only entry renders ONLY typed fields + a non-masking exit code.** The render is a pure typed-field pass-through (redaction-safe — never raw probe output); the exit code is a DERIVED worst-of (`ok`/`degraded`→0, `finding`→non-zero) that an install script can gate on — a finding is NEVER masked to 0. Report-only: print the typed repair guidance, NEVER auto-apply a fix (idempotent by pure re-probe; no side effect beyond the read probes + the write sink).
3. **A multi-instance worst-of fold covers EVERY instance — and HOISTS the shared probe to run exactly once.** When the deployment has N of a scoped resource (N workspace vaults, one-repo-per-workspace), fold the scoped checks (`vault_acl`, `git_remotes`) worst-of over EVERY configured instance — a rule-1 posture check that silently covers only 1-of-N (`first(map)`) leaves a writable non-first vault UNCHECKED (re-opens GO #1). Fold at the PROBE level (AND the booleans before one `runDoctor`). HOIST the shared/expensive/stateful probe (a loopback bind) to run EXACTLY ONCE — a per-instance fan-out that re-runs it would self-COLLIDE (concurrent binds to the same port → false "occupied"); running it once makes the collision structurally impossible (better than a sequential workaround). Prefer an additive per-field-probe EXPORT over re-running the whole bundle per instance.
4. **Resolve impure config at the ENTRY, inject it into the pure core.** The entry (not the pure collector) resolves environment-derived config — the worker principal via `os.userInfo()`, vault roots from `AppConfig`, the rest from env with fail-closed defaults — and INJECTS it, so the pure collector never reads the OS (no-inference; testable).

**Rule:** Land a pure engine + real collectors DORMANT behind a documented reachability waiver (each independently testable/reviewed), then close the waiver with ONE composition-root ENTRY (real adapters + entry-resolved+injected config + a pure render/exit-code core) — `/wired` traces from the entry. The entry is report-only: render ONLY typed fields (redaction-safe), a derived worst-of exit code that never masks a finding, no auto-mutation. A multi-instance check folds worst-of over EVERY configured instance (never silently 1-of-N — a partial rule-1 posture check is a hole) and HOISTS a shared/stateful probe (a port bind) to run EXACTLY ONCE (structural collision-elimination), via additive per-field-probe exports. **Pin:** render/exit-code pure units (ok/degraded/finding/mixed) + a multi-instance worst-of fold test + a shared-probe-invoked-exactly-once test + a gated end-to-end.

## <a id="21"></a>21. Make-real over a probe whose REAL output contradicts the assumed contract → fail-closed candidate-field parse + delegate to the built pure core + document the identity-gap as a deferred Finding

**Date:** 2026-07-12.
**Source slice:** the GBrain version-pin make-real 11.3-a (`3141118`) — verifying the REAL installed gbrain 0.35.1.0 surface BEFORE writing the probe revealed a broken premise the dormant-over-fakes build could not surface.

1. **Verify the REAL surface before writing the probe.** The make-real step's first job is to RUN the actual tool/vendor surface and confirm the assumed contract — this is where a dormant-over-fakes build's hidden premise gaps surface (here: `checkVersionPin` assumed the running build reports its 40-hex commit SHA; the real `gbrain doctor --json` emits none, and `gbrain --version` is only the semver tag). Do NOT write the parser against the ASSUMED shape.
2. **Fail-closed candidate-field parse — never fabricate to satisfy the contract.** When the real output lacks the assumed field, parse the candidate keys that MIGHT carry it (validated — e.g. hex ≥7), and on absent/malformed return the UNAVAILABLE value the pure core degrades on — never coerce a wrong-typed substitute (e.g. the semver tag into the SHA field), which produces a bogus mismatch. Honest-fail-closed beats fabricated-match.
3. **Delegate the decision to the built pure core — the make-real slice only adds the probe + parse.** It does NOT re-implement or edit the pure decision core (nor the sibling gates) — it produces the injected input and composes; the composition is TOTAL never-throw (a thrown/type-violating probe folds to the degrade branch; wrap the delegate call in the try too).
4. **Document the identity-gap as a DEFERRED Finding, don't paper over it.** The premise gap becomes a category-2 Finding routed to the owner-gated path it actually blocks (here: the write-through GO's version-pin IDENTITY — a `GbrainPin` SHA→semver-tag frozen-contract change OR a real SHA source), documented in-code + the deferred ledger, tied to the existing HITL item. The non-HITL slice ships correctly (fail-closed) meanwhile; the contract-fix is the owner's call when that path opens.

**Rule:** When making a dormant check REAL over a probe, RUN the real surface FIRST — a broken premise the fakes hid (an assumed field the real output doesn't carry) surfaces here. Respond honest-fail-closed: parse the candidate field, return the pure core's UNAVAILABLE value on absent/malformed (never fabricate a wrong-typed match), and DELEGATE the decision to the built core (the make-real slice adds only the probe + parse, TOTAL never-throw). Bank the premise gap as a category-2 Finding tied to the owner-gated path it blocks (in-code + the deferred ledger), not a silent paper-over — the non-HITL slice ships fail-closed; the contract-identity fix is the owner's. **Pin:** a test asserting the REAL surface's shape (the authoritative reality pin) + a synthetic-with-the-assumed-field test (forward-compat) + the composition's fail-closed + never-throw paths.

## <a id="22"></a>22. Interactive list surfaces use ONE shared roving-tabindex hook (single tab stop) — never per-option `tabIndex=0`; clamp the active index on read against a LIVE count

**Date:** 2026-07-12.
**Source slice:** 9-a11y (`5c55011`) — the Projects + ScopeSwitcher `role="listbox"` surfaces.

1. **Roving-tabindex, single tab stop — the per-option `tabIndex=0` anti-pattern.** A `role="listbox"` (or any composite widget) must be ONE tab stop: exactly one active `role="option"` is `tabIndex=0`, the rest `tabIndex=-1`; the CONTAINER owns the arrow keys (Up/Down move the roving focus + `.focus()` follows, Home/End to the extremes, no wrap by default). Per-option `tabIndex=0` (N tab stops, each option independently tab-focusable) is the ARIA-APG anti-pattern — extract ONE shared `useRovingListbox` hook so every list surface has the identical keyboard contract, never a divergent copy.
2. **Explicit-selection, not follow-selection, when a selection has side effects.** Arrows MOVE FOCUS only; Enter/Space performs the selection — so keyboard matches mouse and arrowing never fires a heavy side effect (switching the app's workspace scope, opening a project, triggering a reload). Reset the roving entry point on an EXTERNAL selection change, not on every focus move.
3. **Clamp the active index ON READ against the LIVE count.** When the option list is a LIVE projection (options can drop out from under a stale arrow-browsed index), a reset effect keyed only on the selected index misses a count shrink → the active index points past the end → EVERY option becomes `tabIndex=-1` → the widget loses its single tab stop (unfocusable). Clamp on read (`active = count===0 ? 0 : min(activeIndex, count-1)`) at the key handler + the per-option props + the returned index; pin it with a count-shrink regression test.

**Rule:** Interactive composite list surfaces consume ONE shared roving-tabindex hook — single tab stop (exactly one option `tabIndex=0`), container-owned Up/Down/Home/End (no-wrap default), explicit-selection (arrows move focus; Enter/Space selects; reset on external selection change) — NEVER per-option `tabIndex=0`. Clamp the active index on read against the live option count so a projection shrink can't zero every tab stop. **Pin:** render tests (jsdom + testing-library) for exactly-one-tabIndex-0 / arrow+Home/End nav / no-wrap / arrows-don't-select / count-shrink-keeps-single-tab-stop.

## <a id="23"></a>23. Thread an additive candidate field through a frozen Appendix-A seam — OPTIONAL + gate-validated + explicit field-PICK at any embedding `.strict()` boundary; the 4-file ADR-008 set moves together

**Date:** 2026-07-15.
**Source slice:** Phase-15 — the additive optional `body?` on the frozen `SourceEnvelope` (ADR-008 seam; §19.2 note-body threading).

To thread a new candidate field through a frozen Appendix-A seam (`SourceEnvelope +body?`), make it OPTIONAL + additive + gate-validated (`z.string().optional()` — a present non-string is rejected, absent is accepted), NEVER composed as a required field: a required field would drop every existing record (nothing carries it yet), so the required gate + its producer/consumer land TOGETHER in a later slice (Lesson [15](LESSONS.md#15) in action). Prevent an embedder leak: any shape embedding the model at a `.strict()` boundary uses an explicit hand-authored field-PICK (NOT a spread), so the new field does not surface downstream until intended. The 4-file ADR-008 set moves together in ONE commit: the Zod model (`.strict()`), the regenerated JSON Schema (the field under `properties`, NOT in `required`, `additionalProperties:false` preserved), the frozen snapshot (the top-level field-set now includes the field), and the schema-snapshot test.

**Rule:** thread a new candidate field through a frozen Appendix-A seam as OPTIONAL + additive + gate-validated (`z.string().optional()`, string-if-present else rejected) — never a required field (which drops every existing record; the required gate + producer/consumer land together in a later slice, L15); use an explicit hand-authored field-PICK (not a spread) at any `.strict()` boundary embedding the model so the new field can't leak downstream until intended; move the 4-file ADR-008 set in ONE commit (Zod `.strict()` model + regenerated JSON Schema [field under `properties`, NOT `required`, `additionalProperties:false` preserved] + frozen snapshot [top-level field-set includes the field] + schema-snapshot test). `pin: source-envelope.test.ts additive-body block + registry-all green`.

## <a id="24"></a>24. logic-in-package / wire-at-boot (the ARC-5 cross-track pattern) — the LOGIC lands in the owning package; the composition-root BINDING is a separate worker task

**Date:** 2026-07-25.
**Source slice:** ARC-5 cross-track pattern — applied this round to 21.1/21.2, 13.17, 9.9, 13.8b, 21.10.

When a capability needs both a pure/owning-package implementation AND a worker composition-root binding, the two split across TRACKS: the LOGIC (validator, resolver, re-ranker, projection, renderer affordance) lands test-first in the owning package (`contracts`/`domain`/`knowledge`/`providers`/`desktop`), and the `apps/worker/composition` (or Electron main) BINDING that wires it into boot is a SEPARATE task on the worker/host track. This keeps each slice atomic + single-territory + independently reviewable, and prevents a cross-track slice from touching two territories at once (a merge + review hazard). The seam is an injected port left UNBOUND (or a default-OFF gate) until the wiring task lands — so the logic ships dormant + byte-equivalent meanwhile.

**Rule:** split a capability into the owning-package LOGIC (test-first, in its own track) and a SEPARATE worker/host composition-root BINDING task — the logic ships dormant behind an unbound injected seam / default-OFF gate until the wiring task lands, so each slice stays atomic + single-territory. `accepted: process convention (not mechanically enforceable)`.

## <a id="25"></a>25. A new egress-classed provider is a FROZEN-CONTRACT round — enum + ALL embedding schemas (empirically surveyed) + membership pins + a rule-5 contract-surface test; fail-closed BY CONSTRUCTION via the ProviderId-agnostic §5 veto

**Date:** 2026-07-25.
**Source slice:** 13.13 — the `perplexity`/`xai` (RES-1) `ProviderId` enum expansion.

Adding a new egress-classed processor to the `ProviderId` enum ripples through EVERY schema that embeds it — SURVEY the ripple EMPIRICALLY, don't assume it: 13.13 was **5** embedding schemas, not the assumed 3 (provider-route + provider-profile + provider-matrix + agent-job + workspace), each regenerated with its snapshot in one frozen-contract round, plus the membership pins and a rule-5 contract-surface test. Fail-closed is BY CONSTRUCTION: the §5 egress veto is ProviderId-AGNOSTIC — it opts a processor IN via the `LOCAL_PROVIDERS` allowlist, so a new cloud provider absent from that allowlist (perplexity/xai) is egress-classed automatically with NO veto edit. That is why the enum expansion cannot silently open an egress hole.

**Rule:** a new egress-classed `ProviderId` is a frozen-contract round — enum + ALL embedding schemas EMPIRICALLY surveyed (13.13 = 5: route/profile/matrix + agent-job + workspace) + snapshots + membership pins + a rule-5 contract-surface test; the §5 veto stays ProviderId-agnostic (`LOCAL_PROVIDERS` opt-in allowlist), so an un-allowlisted new cloud provider is egress-classed fail-closed BY CONSTRUCTION. `pin: providerid-research.test.ts`.

## <a id="26"></a>26. Local retrieval selects a zero-egress backend for employer-work or fails closed (rule 5); the embedding index is a rebuildable sidecar OUTSIDE the Markdown tree; RRF fusion K=60, 0-indexed, id-asc tie-break

**Date:** 2026-07-25.
**Source slice:** 13.3a — the local-embedding hybrid retrieval backend.

The local-embedding retrieval path selects a ZERO-EGRESS backend for an employer-work query or FAILS CLOSED (rule 5) — there is no cloud fallback for sensitive retrieval. The embedding index is a REBUILDABLE sidecar kept OUTSIDE the canonical Markdown tree: it is a pointer/ranking artifact, never a byte source (§6(i)-adjacent, safety rule 1), and a lost index rebuilds from Markdown. RRF fusion of the lexical + dense legs uses `K=60` with a 0-indexed rank and an id-ascending tie-break so the fused order is deterministic + CI-stable.

**Rule:** local retrieval selects a zero-egress backend for employer-work or fails closed (rule 5); the embedding index is a rebuildable sidecar OUTSIDE the Markdown tree (never a byte source); RRF fusion is `K=60`, 0-indexed rank, id-asc tie-break (deterministic). `pin: knowledge gbrain-local-embed.test.ts`.

## <a id="27"></a>27. A no-inference eval suite scores at a HARD 100% floor (a safety invariant, not a soft bar) and asserts the domain oracle directly over a labeled corpus, provider-free

**Date:** 2026-07-25.
**Source slice:** the no-inference validator eval (REQ-F-017 characterization suite).

REQ-F-017 no-inference is a SAFETY INVARIANT, so its eval suite scores at a HARD 100% floor — anything below is a fail, never a soft ratio bar (contrast the ≥0.90 usefulness metrics). It asserts the DOMAIN ORACLE (`validateNoInference`) DIRECTLY over the labeled corpus, provider-free (no model call — the oracle is deterministic, so the suite pins the oracle, not a model). RED for a characterization-over-an-existing-oracle suite means scratch-running the negative controls against a BROKEN stub oracle first (to prove the suite actually catches an inference leak), not against the finished oracle where everything already passes.

**Rule:** a no-inference eval scores at a HARD 100% floor (safety invariant, not a soft bar) and asserts the deterministic domain oracle directly over the labeled corpus, provider-free; get RED for a characterization suite by scratch-running the neg-controls against a broken stub, not the finished oracle. `pin: evals no-inference-validator.test.ts`.

## <a id="28"></a>28. The retrieval re-ranker is a PURE local re-scorer reusing the RRF fusion primitive — reorders before the cap, no egress/model/spend, content-preserving

**Date:** 2026-07-25.
**Source slice:** 13.17 — the retrieval re-ranker.

The retrieval re-ranker is a PURE, local, deterministic re-scorer that REUSES the RRF fusion primitive (L26) — it reorders candidates BEFORE the top-K cap, so the retained cut-set improves, with no egress, no model call, and no spend. It is content-preserving and generic (`<T extends Passage>`), so it never mutates or drops passage content — only order. The model-based re-ranking leg is owner-gated and deferred (this local leg ships first).

**Rule:** the retrieval re-ranker is a PURE local re-scorer reusing the RRF fusion primitive — reorders before the cap, no egress/model/spend, content-preserving (`<T extends Passage>`); the model-based leg is owner-gated. `pin: knowledge gbrain-rerank.test.ts`.

## <a id="29"></a>29. A §12 worker-API auth eval drives the EXPORTED interceptor/originAllowlist/handshake boundary (imports, never edits worker) and reuses the 8.7 runAuthSuite; a spoof vector must drive the gate-path it CLAIMS

**Date:** 2026-07-25.
**Source slice:** the §12 session-token/origin auth eval.

An eval over the §12 renderer↔worker auth boundary IMPORTS the worker's exported interceptor / originAllowlist / handshake surface (the eval track CONSUMES track outputs, never EDITS the worker) and reuses the 8.7 `runAuthSuite` for the core session-token gate rather than re-implementing it. A spoof vector must exercise the gate-path it actually CLAIMS to test: an ORIGIN-position value is checked by a raw exact-match, so only a HOST-position vector exercises the Lesson-4 host-authority-isolation predicate — mislabeling one for the other is a vacuous assertion (the guard it names never runs).

**Rule:** a §12 worker-API auth eval drives the EXPORTED interceptor/originAllowlist/handshake boundary (imports, never edits worker) + reuses the 8.7 `runAuthSuite`; a spoof vector must drive the gate-path it CLAIMS — ORIGIN-position = raw exact-match, only HOST-position tests Lesson-4 host authority-isolation. `pin: evals session-token-origin.test.ts`.

## <a id="30"></a>30. An egress-classed research provider runs the BROKER veto FIRST; a key-less aggregator SELF-runs the REAL egressVeto over a SYNTHETIC egress-classed route (processorOfRoute!==null or the employer-raw veto fails OPEN)

**Date:** 2026-07-25.
**Source slice:** 13.13r — the RES-1 research provider + its egress-leakage eval.

An egress-classed research provider (Perplexity/xAI) runs the broker's rule-5 egress veto FIRST, before any dispatch. The KEY-LESS source aggregator is NOT exempt just because it has no paid key: it SELF-runs the REAL `egressVeto` over a SYNTHETIC egress-classed route — and that route MUST carry `processorOfRoute !== null`, or the employer-raw veto FAILS OPEN (the sharp pin: a null-processor route silently skips the employer-raw check). Each vendor is its OWN processor (never aliased), citations are preserved verbatim as candidate data, and the provider ships dormant over a faked transport — key-less does NOT mean bypass.

**Rule:** an egress-classed research provider runs the broker veto FIRST; a key-less aggregator SELF-runs the REAL `egressVeto` over a SYNTHETIC egress-classed route (`processorOfRoute!==null` or the employer-raw veto fails OPEN — the sharp pin); each vendor its OWN processor (never aliased); citations verbatim candidate-data; dormant over faked transport; key-less ≠ bypass. `pin: providers research-provider.test.ts + evals research-egress-leakage.test.ts`.

## <a id="31"></a>31. A task-rollup UI-safe projection is a PRE-RANKED ordered list (producer ranks; renderer renders order, never re-sorts by a model signal), priority-representable-as-UNSET, workspace-scoped (no workspaceId), flood-bound

**Date:** 2026-07-25.
**Source slice:** the §13.15/13.16 task-rollup UI-safe projection (contract-first).

The task-rollup UI-safe projection is a PRE-RANKED ordered list: the producer ranks deterministically and the renderer renders THAT order — it NEVER re-sorts by a model signal (determinism + no-inference at the surface). Priority is representable as UNSET (absence IS the sentinel — REQ-F-017 never infers a priority), the shape carries NO `workspaceId` ANYWHERE (WS-8 — the projection is already workspace-scoped at production, so re-carrying the id is a leak surface), and it is `.strict()` + array-`.max()` flood-bound. Defined contract-first so the producer and the renderer surface unblock in parallel.

**Rule:** a task-rollup UI-safe projection is a PRE-RANKED ordered list (producer ranks; renderer renders order, never re-sorts by a model signal), priority-representable-as-UNSET (absent IS the sentinel, no-inference), workspace-scoped with NO `workspaceId` anywhere (WS-8), `.strict()` + array-`.max()` flood-bound; defined contract-first to unblock producer + surface. `pin: contracts ui-safe.test.ts`.

## <a id="32"></a>32. The EntityResolver grounds-before-writing — exact-slug/alias resolves, no-note ⇒ create-stub, ambiguous/lossy/collision ⇒ WITHHOLD (never a fabricated path); PURE over a WS-8-scoped GBrain read; fail-closed to unresolved

**Date:** 2026-07-25.
**Source slice:** 13.8a — the synthesis `EntityResolver`.

The synthesis EntityResolver GROUNDS before any write: an exact slug/alias match resolves; a genuinely-absent note yields a create-stub; an ambiguous, lossy, or colliding candidate is WITHHELD — it never fabricates or picks an arbitrary path (a synthesis-named path is never trusted). It is PURE over a WS-8-SCOPED GBrain read (foreign-workspace candidates are DROPPED, so a cross-workspace note can't be resolved into — safety rule 4), and it fails closed to `unresolved`.

**Rule:** the EntityResolver grounds-before-writing — exact-slug/alias resolves, no-note ⇒ create-stub, ambiguous/lossy/collision ⇒ WITHHOLD (never a fabricated/arbitrary path); PURE over a WS-8-scoped GBrain read (foreign-workspace candidates dropped); fail-closed to unresolved. `pin: knowledge synthesis-entity-resolver.test.ts`.

## <a id="33"></a>33. The retrieval recall@10 bar runs on a recorded-embedding fixture (deterministic/CI, ≥30 queries), computes its own dense-cosine baseline, gates fused≥0.91 + reranked≥raw with ≥1 lexical-rescue, drives the REAL retrieveLocalEmbed

**Date:** 2026-07-25.
**Source slice:** 13.3b — the retrieval recall@10 eval.

The retrieval recall@10 eval runs on a RECORDED-embedding fixture (deterministic, CI-safe, ≥30 queries — the §12 corpus floor) and computes its OWN dense-cosine baseline mirroring the real cosine, so the "does fusion help" claim is self-contained. It gates fused recall `≥0.91` AND reranked `≥` raw with `≥1` lexical-rescue case (a query where raw `<` fused, proving fusion actually helps and not a tie), drives the REAL `retrieveLocalEmbed` (exercising the rule-5 zero-egress floor), and proves non-vacuity via a both-legs-miss degraded corpus (recall drops when it should).

**Rule:** the recall@10 bar runs on a recorded-embedding fixture (deterministic/CI, ≥30 queries), computes its own dense-cosine baseline, gates fused≥0.91 + reranked≥raw with ≥1 lexical-rescue (raw<fused proves fusion helps), drives the REAL `retrieveLocalEmbed` (rule-5 floor), non-vacuity via a both-legs-miss degraded corpus. `pin: evals retrieval-recall.test.ts`.

## <a id="34"></a>34. A renderer open/reveal affordance passes a CLOSED repo TARGET (never a path); MAIN resolves target→configured root so path-traversal is impossible BY CONSTRUCTION; Open-in-Obsidian opens obsidian:// with encodeURIComponent as a structural injection guard

**Date:** 2026-07-25.
**Source slice:** 9.9 — the desktop Open-in-Vault / reveal affordance.

A renderer "open / reveal in vault" affordance passes a CLOSED repo TARGET token (an enum-like key), NEVER a filesystem path — MAIN resolves that target to the configured root, so a renderer-supplied path-traversal is impossible BY CONSTRUCTION (§5-preserving, and stronger than exposing roots to the renderer to resolve). The true Open-in-Obsidian builds an `obsidian://` URL from the MAIN-resolved root with a HARDCODED scheme literal and `encodeURIComponent` as a STRUCTURAL injection guard (Context7-verified against the Obsidian URI scheme), with a graceful folder-open fallback when Obsidian isn't the handler.

**Rule:** a renderer open/reveal affordance passes a CLOSED repo TARGET (never a path); MAIN resolves target→configured root so path-traversal is impossible BY CONSTRUCTION (§5-preserving); Open-in-Obsidian builds `obsidian://` from the MAIN-resolved root (hardcoded scheme + `encodeURIComponent` structural injection guard, Context7-verified) with a graceful folder-open fallback. `pin: desktop open-in-vault.test.ts`.

## <a id="35"></a>35. The employer-egress rule-5 FLIP is an owner-authorized SCOPED default-seed (employer_work + [claude] only, provisioning-time, no bulk migration), proven by inverse-ALLOW + non-[claude]-denies + preserve-fault pins; rides the 9.10-A store-backed resolver

**Date:** 2026-07-25.
**Source slice:** 9.10 — the employer cloud-egress default-seed flip (`bcde3d61`), over the 9.10-A store-backed posture resolver.

The employer-work rule-5 egress FLIP is an owner-authorized, SCOPED provisioning-time default-seed — it sets `employerRawEgressAcknowledged=true` + `acknowledgedAt` ONLY for `employer_work` + a `[claude]` processor, with NO bulk migration of existing records. It is proven by three pins: an inverse-ALLOW (the seeded scope now allows a `[claude]` cloud route), a non-`[claude]`-still-denies (scoped, never blanket-cloud), and a preserve-fault (an absent/faulted employer posture STILL fails closed — never a fault-time default-true). It rides the 9.10-A store-backed single-source posture resolver (the interim `cloudCopilotPosture` hack is RETIRED). LOAD-BEARING precondition (login = company): `docs/runbooks/phase-18-subscription-enable-decision.md`.

**Rule:** the employer-egress rule-5 FLIP is an owner-authorized SCOPED default-seed (employer_work + `[claude]` only, ack=true + acknowledgedAt, provisioning-time, NO bulk migration), proven by inverse-ALLOW + non-`[claude]`-denies + preserve-fault (absent/faulted STILL fails closed — never a fault-time default-true); rides the 9.10-A store-backed single-source resolver (retires `cloudCopilotPosture`). `pin: worker egress-posture-store-backed.test.ts`.

## <a id="36"></a>36. The external-write credential seam resolves the vendor token at DISPATCH-time through an OPTIONAL injected WriteSecretsAccessor, BEFORE the existence-probe + create; fail-closed on unavailable/empty/throw; value discarded (never logged); real-accessor ⇔ real-transport arm together

**Date:** 2026-07-25.
**Source slice:** 21.10 — the external-write credential seam (17.4 `writeSecretRef`).

The external-write credential seam resolves the vendor token at DISPATCH time (the 17.4 `writeSecretRef`) through an OPTIONAL injected `WriteSecretsAccessor`, BEFORE the pre-write existence-probe and the create. It fails closed on unavailable / empty / throw (a blank token is NOT auth), reads the value ONLY for the non-empty check then DISCARDS it (never logged — rule 7), and is byte-equivalent when the accessor is ABSENT (dormant default). The real accessor and the real write transport MUST arm TOGETHER (§ARM-21) — a real accessor without a real transport (or vice-versa) is a half-armed hole.

**Rule:** the external-write credential seam resolves the vendor token at DISPATCH-time (17.4 `writeSecretRef`) via an OPTIONAL injected `WriteSecretsAccessor`, BEFORE the existence-probe + create; fail-closed on unavailable/empty/throw (blank ≠ auth); value read only for the non-empty check then discarded (never logged, rule 7); ABSENT ⇒ byte-equivalent; real-accessor ⇔ real-transport arm together (§ARM-21). `pin: integrations credential-seam.test.ts`.

## <a id="37"></a>37. The LinkHealer heals a forward link ONLY on a faithful/unambiguous slug match (shared match-keys with the EntityResolver — predicate-lives-once); backlinks NEVER authored (derived read-only via GBrain); every heal is a LinkMutation → KnowledgeWriter

**Date:** 2026-07-25.
**Source slice:** 13.8b/13.8c — the synthesis `LinkHealer`.

The synthesis LinkHealer heals a FORWARD link only on a faithful, unambiguous slug match — reusing the SAME match-keys as the EntityResolver (L32) so the resolve predicate LIVES ONCE (a lossy/fuzzy/2+-candidate match withholds). Backlinks are NEVER authored — they are derived read-only via GBrain. Every heal is a `LinkMutation` routed through KnowledgeWriter (safety rule 1 — never a direct write).

**Rule:** the LinkHealer heals a forward link ONLY on a faithful/unambiguous slug match (shared match-keys with the EntityResolver — predicate-lives-once; lossy/fuzzy/2+ withholds); backlinks NEVER authored (derived read-only via GBrain); every heal is a `LinkMutation` → KnowledgeWriter (never a direct write). `pin: knowledge synthesis-link-healer.test.ts`.

## <a id="38"></a>38. The synthesis planner sets the autonomy TIER itself from (effect kind, target) — never model-declared — splits AUTO vs PROPOSE into SEPARATE plans, and confines `@user` regions with a SYMMETRIC fail-closed allowlist

**Date:** 2026-07-26. **Source slice:** 13.8c — confined synthesis planner (`461a0186`). The KN-10 tier is a DETERMINISTIC planner decision over (effect kind, target), never a field the model gets to declare: an additive `@generated` refresh or a new link ⇒ `requiresApproval:false`, a `FrontmatterPatch` or any human-relevant claim edit ⇒ `requiresApproval:true`. Additive-AUTO and human-relevant-PROPOSE therefore ride SEPARATE `KnowledgeMutationPlan`s (one mixed plan would have to collapse to the weaker flag). The `@user` confinement check must be SYMMETRIC — `refresh` admitted only when its region id ∈ `generatedRegionIds` AND `new_region` only when ∉ it — because the one-sided form let an effect be RELABELED to write into a human region (security-review Critical, closed here).

**Rule:** the synthesis planner sets the autonomy tier itself from (effect kind, target) — never model-declared; additive-AUTO and human-relevant-PROPOSE ride SEPARATE KMPs (never one mixed plan collapsed to the weaker flag); `@user` confinement is a SYMMETRIC fail-closed allowlist (`refresh` id ∈ generatedRegionIds, `new_region` id ∉ it) — the asymmetric form is an effect-relabel bypass. `pin: knowledge synthesis-planner.test.ts`.

## <a id="39"></a>39. The canonical region-marker neutralizer lives where `MARKER_RE` lives, runs on BOTH create and patch, and is region-AWARE (preserves legitimate `@generated` wrappers) — ⚠ SAFETY

**Date:** 2026-07-26. **Source slice:** 13.8d(a) — KnowledgeWriter marker neutralization (`04e01eed`). A region-marker injection defense is only sound if the neutralizer is co-located with the marker regex it must stay in sync with (`MARKER_RE` in knowledge `markdown-vault/sections.ts`) — a copy in a downstream package silently diverges the moment the marker grammar changes. It must run on BOTH the create and the patch path (neutralizing only one leaves the other as the injection vector), and it must be region-AWARE: blanket-stripping would destroy the legitimate `@generated`/`kw:region` wrappers the confinement model depends on. **Amends L9,** whose Source slice still cites the retired `noteSlug.ts`/`3daa0c8` location. **Sharpened at #54 (the re-point that retired the duplicate):** pin the census THREE ways — referential identity to the canonical symbol, a DEFINITION census covering `function` AND `const` (an `export const` re-fork is the shape that actually occurs), and a MATCHER-LITERAL census — because an `export function <name>` grep pins the NAME, not the DEFENSE, and misses both the re-fork shapes and the `export { … }` re-export shape. Note also that retiring a duplicate is rarely a pure no-op: at #54 the canonical impl escaped every `<!--` in a span (`replaceAll`) where the retired copy escaped the first (`replace`) — same fixpoint, strictly more escaping on nested input. Verify the matcher literals are byte-identical (incl. flags) and record the implementation delta.

**Rule:** the canonical region-marker neutralizer lives where `MARKER_RE` lives (knowledge `markdown-vault/sections.ts`), runs on BOTH create and patch, and is region-AWARE (preserves legitimate `@generated` wrappers, never a blanket strip); any other package RE-EXPORTS it and never re-defines it. `pin: knowledge region-marker-neutralize.test.ts` + `packages/workflows/test/neutralizer-single-source.test.ts` (referential identity + definition census + matcher-literal census) + `pattern: grep -rlE 'export (function|const) neutralizeRegionMarkers' (excluding test/dist/node_modules) == 1`.

## <a id="40"></a>40. The ingest rewrite is ONE plan-synthesis per run (⇒ ≤2 KMPs), its receipt is keyed by ordered `planIds` (the batch-undo unit), and structural-file parity rides INSIDE the AUTO plan

**Date:** 2026-07-26. **Source slice:** 13.8d(b) — living-vault ingest rewrite + structural files (`3d2d24f9`). An ingest UPDATES existing notes rather than fanning out per entity, so the rewrite emits ONE plan-synthesis per run ⇒ at most two plans (the AUTO one and the PROPOSE one) — not a plan per touched note. The run receipt is keyed by the ORDERED `planIds`, not revisionIds, because a pure pre-commit planner cannot know commit hashes yet; that ordered id list IS the one-action batch-undo unit. KN-12 structural parity (`index.md` sections + append-only op-log) rides INSIDE the AUTO plan as ordinary KnowledgeWriter mutations — a separate structural write path would be a second writer (rule 1).

**Rule:** the ingest rewrite is ONE plan-synthesis per run (⇒ ≤2 KMPs, not per-entity); the receipt is keyed by ordered `planIds` (a pure pre-commit planner can't know revision hashes) and that list IS the batch-undo unit; structural-file parity rides INSIDE the AUTO plan as KW mutations, never a second write path. `pin: knowledge ingest-rewrite.test.ts` + `structural-files.test.ts`.

⛔ **AMENDED 2026-07-31 — THE "THAT LIST IS THE BATCH-UNDO UNIT" CLAUSE IS SUPERSEDED. The rest of this lesson stands unchanged.** When L40 was written, **every** plan the producer emitted was committed, so *"the receipt's ordered `planIds`"* and *"what was committed"* were the same set and the identity was free. **13.8d's tier split ended that** — a plan carrying `requiresApproval !== false` is withheld — and **13.8i** (`a7d4ae9d`) routes those withheld plans to §9.8 Approvals instead. ⇒ **A withheld plan produces NO revision, so putting its id in "the batch to undo" references nothing.** The batch-undo unit is now **what COMMITTED**, accumulated post-commit-success (`SourceIngestionOutcome.livingVaultPlanIds`), **not** the producer's emitted list.

⚠ **The receipt's `planIds` is still correct for what it IS** — the ordered set of plans *synthesised* — and the pure-planner-can't-know-revision-hashes reasoning is untouched. **What changed is the CONSUMER's question:** *"which plans did this run produce?"* and *"which plans can this run undo?"* were one question and are now two.

⭐ **WHY THIS AMENDMENT EXISTS AT ALL, and it is the durable part: the divergence was SILENT for two slices.** 13.8d split the tiers and nothing noticed, **because nothing consumed `planIds`** — an unread field cannot contradict the lesson describing it. It surfaced only when 13.8i's implementer went to consume it and found the semantics wrong; a code-quality reviewer then caught that the supersession was being made **without amending here**. ⛔ **A lesson silently outlived by a later slice is a FALSE-GREEN IN THE LESSONS INDEX ITSELF** — and the index is what every `pin:` line, enforcement line and cross-reference in this system rests on. **Amend the lesson; never leave a superseding slice to be discovered by the next reader who trusts it.** ⇒ **When a slice's correct behaviour contradicts a banked lesson, amending that lesson is part of the slice, not follow-up.** *(origin: 2026-07-31, 13.8i — implementer flagged the supersession, code-quality reviewer flagged the silence)*

## <a id="41"></a>41. A per-`TargetSystem` routing registry needs BOTH an exhaustive `Record` (compile-time) and an `Object.hasOwn` runtime guard, plus an explicit unrouted fail-closed sentinel

**Date:** 2026-07-26. **Source slice:** 21.1/21.2 — write-adapter routing registry (`07145feb`, `ed9faa26`). Compile-time exhaustiveness (`Record<TargetSystem, …>`) proves every enum member is covered but says nothing about a value arriving at runtime, and a bare property read on the map is a prototype-pollution FAIL-OPEN (a crafted target name resolves to an inherited `Object` member and looks routed). `Object.hasOwn` closes that. An unroutable target must yield an explicit fail-closed sentinel (`createUnroutedWriteAdapter()`) — never `undefined` that silently skips the write, and never a default adapter that writes somewhere unintended. Both dispatch sites route through the ONE entry, else a target bypasses the registry entirely.

**Rule:** a per-`TargetSystem` routing registry = exhaustive `Record` (compile-time completeness) AND `Object.hasOwn` at lookup (closes the prototype-pollution fail-open) AND an explicit unrouted fail-closed sentinel (never `undefined`, never a default adapter); ALL dispatch sites route through the one entry. `pin: integrations write-adapter-registry.test.ts`.

## <a id="42"></a>42. A real-parse transport over UNTRUSTED HTML uses a LINEAR tag-strip, an integer 2xx gate, decode-BEFORE-collapse, and the SSRF guard before dispatch

**Date:** 2026-07-26. **Source slice:** 13.2a — web real-parse transport (`3c501687`). Parsing attacker-controlled markup with a backtracking regex is a ReDoS vector, so the tag-strip must be LINEAR (`<[^>]*(?:>|$)` — the `|$` handles an unterminated tag without backtracking). The 2xx gate is `Number.isInteger`-checked (a non-integer/NaN status must not pass a range comparison), decoding happens BEFORE whitespace-collapse (collapse-then-decode can reconstitute markup), and the SSRF/loopback guard runs BEFORE dispatch — never after. The real readability library is the arming-time swap behind the same injected-fetch seam.

**Rule:** a real-parse transport over untrusted HTML = LINEAR tag-strip (no backtracking; handle the unterminated tag), `Number.isInteger` positive-2xx gate, decode-BEFORE-collapse, SSRF/loopback guard BEFORE dispatch; the real parser library is the arming swap behind the injected seam. `pin: integrations web-fetch-transport.test.ts`.

## <a id="43"></a>43. Extend the ONE vetted connector transport with an ADDITIVE auth mode (never a bespoke client), and ground the vendor API VERSION on Context7 before building

**Date:** 2026-07-26. **Source slice:** 21.3 — todoist (`6facc356`) + telegram (`15a90ed4`) read connectors. Telegram needs token-in-URL-path auth, which is a new MODE on `createConnectorHttpTransport` (`pathAuth`: interpolate only into an explicitly ALLOWLISTED safe path segment, never log or surface it in a fault, keep the `Bearer` branch byte-equivalent) — not a second transport, which would fork the SSRF guard and the redaction discipline. Separately, the brief assumed Todoist REST **v2** while the unified **v1** API (`{results, next_cursor}`) had superseded it: the vendor API VERSION is part of the wire shape and must be Context7-grounded before build, not just the endpoint names.

**Rule:** extend the ONE vetted connector HTTP transport with an ADDITIVE auth mode (e.g. `pathAuth` — allowlisted safe path, never logged, existing Bearer branch byte-equivalent), never a bespoke client that forks the SSRF/redaction discipline; ground the vendor API **version** (not just endpoints) on Context7 before building. `pin: integrations connector-{todoist,telegram}-transport.test.ts` (extends L3 — do not duplicate it).

## <a id="44"></a>44. Read-model sanitizer posture is chosen PER HAZARD — whole-degrade-to-empty where a partial row would assert a false SAFE state, per-row-drop where partial is honestly useful

**Date:** 2026-07-26. **Source slice:** 9.9a calendar (`8b4e3537`) + 13.16 task rollup (`0e6e1662`). "Drop the bad row" is not a universal sanitizer policy. A partial CALENDAR projection is actively dangerous: dropping an unparseable busy window makes the remaining data assert *free* when the truth is unknown (REQ-F-009), so the whole projection degrades to empty. A partial TASK ROLLUP is merely incomplete, not misleading, so per-row-drop is correct and preserves usefulness. The question to ask per read-model: *does a missing row make the surface claim something SAFE that isn't verified?* — if yes, degrade whole.

**Rule:** choose read-model sanitizer posture PER HAZARD — whole-degrade-to-empty when a dropped row would make the surface assert a false SAFE/permissive state (calendar busy/free ⇒ false "free"), per-row-drop when partial is honestly useful (task rollup); never a blanket drop policy. `pin: worker queries.test.ts (sanitizeCalendar / sanitizeTaskRollup)`.

## <a id="45"></a>45. A fail-safe OFF command is get-before-upsert fail-closed, flips the flag AND clears its timestamp, and treats the audit row as part of "done"

**Date:** 2026-07-26. **Source slice:** 9.10-B — egress-ack REVOKE command (`225c10ca`, ⚠ rule-5). Turning a permission OFF still needs the full fail-closed discipline: get-before-upsert (an absent/faulted read must never become a silent CREATE of a record that didn't exist), and the flip must clear the acknowledgment TIMESTAMP alongside the boolean — a stale `acknowledgedAt` is exactly the artifact a later reader mistakes for consent. The audit row is part of the operation, not a side effect: it records summaries only (rule 7) and an audit-write fault returns Err rather than reporting success, so an idempotent retry completes the pair. Application of L30.

**Rule:** a fail-safe OFF command is get-before-upsert fail-closed (never a silent create), flips the flag AND clears its paired timestamp (a stale ack timestamp reads as consent), and treats the summaries-only audit row as part of "done" (audit fault ⇒ Err; idempotent retry completes). `pin: worker egressCommands.test.ts`.

## <a id="46"></a>46. A GLOBAL read-model hydrates cold-load ONLY; a WORKSPACE-scoped one hydrates cold-load + scope-change with clear-first and a stale-scope guard — and every row re-validates `.strict()` with drop

**Date:** 2026-07-26. **Source slice:** 9.9b calendar renderer (`f9d86536`) + 13.16 Top-priorities renderer (`985c1dda`). A workspaceId-free (GLOBAL) projection has nothing to re-fetch on a scope change, so hydrating it there is wasted work and a flicker source; a workspace-scoped one MUST re-hydrate, and must clear FIRST plus carry a stale-scope guard so a slow in-flight response for the previous scope cannot land in the new scope's state (a cross-workspace display leak, WS-8-adjacent). On arrival, unwrap the `{items}`/`{entries}` envelope and re-validate each row `.strict()`, dropping bad rows — the renderer treats worker output as candidate data too.

**Rule:** GLOBAL (workspaceId-free) read-models hydrate cold-load ONLY; WORKSPACE-scoped ones hydrate cold-load + scope-change with clear-first + a stale-scope guard (a late response for the old scope must never land in the new one); unwrap the `{items}`/`{entries}` envelope and re-validate every row `.strict()` with drop. `pin: desktop test/renderer/{schedule,task-rollup}-reducer.test.ts`.

## <a id="47"></a>47. A renderer-isolation security spec asserts bridge==inventory AND main-handler-set==inventory AND the REAL `webPreferences`, and drives the store through the REAL validate→onData drop path

**Date:** 2026-07-26. **Source slice:** 9.14 — renderer security specs (`25029a76`). Pinning the preload bridge against the inventory is only half the surface: an orphan `ipcMain.handle` in main is reachable regardless of what preload exposes, so the main HANDLER SET must be pinned against the same inventory (both directions). The `webPreferences` assertion must read the REAL values via a mocked `BrowserWindow` constructor rather than re-stating expected config, and the UI-safe store guarantee must be exercised through the REAL `validateStreamEvent → onData` path so the drop behavior — not a hand-built fake — is what's proven.

**Rule:** a renderer-isolation spec asserts preload-bridge == inventory AND main-handler-set == inventory (an orphan `ipcMain.handle` is reachable regardless of preload) AND the REAL `webPreferences` (mocked `BrowserWindow` ctor, never re-stated config) AND no-Node-escape AND UI-safe-only through the REAL `validateStreamEvent→onData` drop path. `pin: desktop test/security/renderer-isolation.spec.ts` + `renderer-redaction.spec.ts`.

## <a id="48"></a>48. A denylist guard token must match the QUOTED import specifier, never a bare substring; prove no-weakening with an all-import-forms fixture and a `+0/-0` gate diff

**Date:** 2026-07-26. **Source slice:** #55 — anti-corruption guard tightening (`2c5ac552`). A guard that greps a bare package substring fires on prose and comments (a false positive that trains people to widen the exclusion list — the real risk), while a guard that's too narrow silently stops catching real imports. Anchoring on the QUOTED specifier (`/['"]@sow\/knowledge/`) is the balance point, and the way to ship it safely is a fixture exercising all idiomatic import forms plus a `+0/-0` gate diff proving the change caught nothing less and nothing more. A net-new legitimate read-edge bumps the count-pin only behind a write-free CERTIFY step, so the pin can't be raised to paper over a real violation.

**Rule:** a denylist guard token matches the QUOTED import specifier (`['"]@pkg/name`), never a bare substring (backtick/prose false positives train exclusion-widening); prove no-weakening with a fixture over every idiomatic import form + a `+0/-0` gate diff; a net-new read-edge bumps the count-pin ONLY behind a write-free CERTIFY. `pin: evals test/osb/anti-corruption.test.ts`.

## <a id="49"></a>49. A NEW Appendix-A model lands as the FULL set in ONE round — 4-file ADR-008 set + seam fixture + `ZOD_BY_ID` registration + membership-guard rows + any dual-dialect derived rollup

**Date:** 2026-07-26. **Source slice:** 13.15 — typed `Task` model + `TaskRepository` (`54b052a7`). A frozen-contract addition is not "add the type"; it is a fixed checklist that must complete in ONE round or the seam is half-frozen: the 4-file ADR-008 set, a seam fixture in `fixtures/valid.ts`, `ZOD_BY_ID` registration, the membership-guard rows, and — where the model has one — the dual-dialect derived rollup table. The rollup is DERIVED (an index over the sole writer's truth), never a second writer (rule 1). Increment over L2/L23 rather than a standalone rule.

**Rule:** a NEW Appendix-A model lands as the FULL set in ONE round — 4-file ADR-008 set + seam fixture in `fixtures/valid.ts` + `ZOD_BY_ID` registration + membership-guard rows + any dual-dialect derived rollup (DERIVED index, never a 2nd writer); a partial round leaves a half-frozen seam. `pin: contracts schema-snapshot + membership-guard suites` (increments L2/L23).

## <a id="50"></a>50. A shared-port extension's sibling-fake fixes land as their OWN reconciliation commits

**Date:** 2026-07-26. **Source slice:** Wave-2 round hygiene (`f7829ce5`, `f4555713`, `3a881899`). Widening a shared port/deps interface breaks every OTHER area's test fakes, and those fixes are not part of the feature's logical change — folding them into the feature commit destroys its bisectability and hides the blast radius. Land them as explicit reconciliation commits naming the port growth that caused them, so the next widening can estimate its own fan-out from the history.

**Rule:** a shared-port/deps-interface widening lands its sibling-fake fixes as their OWN reconciliation commits naming the port growth that caused them — never folded into the feature commit (preserves bisectability + makes the next widening's fan-out estimable). `accepted: not mechanically enforceable`.

## <a id="51"></a>51. Close-out debt goes in a FILE, never only in harness task metadata — task lists are session-scoped and do not survive a respawn

**Date:** 2026-07-26. **Source slice:** the #31 doc-debt reconstruction (Wave-2 → fresh-session handoff). A round banked under context pressure deferred its documentation routing to a task whose item-level detail lived only in the harness task-list metadata. The task list is **session-scoped**: at the next session's respawn it was empty, and the detail was gone — while the code it described was committed and green the whole time. The debt was recoverable only because session docs, log entries, and the handoff had independently recorded most of it, and the parts that existed ONLY in metadata are unknowable by construction (there is no artifact to diff against, so their absence cannot even be detected). The corollary for a deferral under pressure: writing one durable line into the plan or handoff costs less than the reconstruction, and unlike the reconstruction it is complete.

**Rule:** any close-out debt that must survive the session — deferred doc routing, unbanked lessons, pending ticks, "next session does X" — is written into a FILE (`IMPLEMENTATION_PLAN.md` Carry-forward / the owning phase's `#### Residuals` / the `/team-end` handoff), never only into harness task metadata or a task description; the task list carries STATUS, not durable content, because it does not survive a respawn. A deferral whose only record is task metadata is a silent-loss bug, not a deferral. `accepted: not mechanically enforceable` (mitigation: `/orchestrate-end` Carry-forward triage + `/team-end` handoff are the enforcement points).

## <a id="52"></a>52. Phrase a dormancy pin as "every importer must be arming-gated", never "zero importers" — and when the gate lives at the composition root, an explicit task-naming waiver marker is the load-bearing branch

**Date:** 2026-07-26. **Source slice:** the 13.8d/13.8f cross-area coordination (`e596038b` + brief 199/200). A dormancy pin written as *"no `apps/` or `packages/workflows/` importer exists"* is correct exactly until the binding slice it was protecting arrives — at which point a CORRECTLY-built, flag-gated binding turns it RED, and the pin lives in the producing package's territory so the consuming implementer cannot fix it without a cross-territory test edit. Phrase it as *"every non-test importer must be arming-gated"* and it is green on both sides of the binding commit, with no RED window and no coordination. The subtlety that decides whether it actually works: a well-built binding puts its strict `=== true` gate at the **composition root** (`boot.ts`, behind a pure gate helper) while the file that *imports* the dormant symbol sits one hop away, so a `=== true`-in-the-importing-file predicate still fails the correct code. The explicit `dormancy-waiver(<task-id>)` marker in each importing file is therefore the LOAD-BEARING branch, not a fallback — and the task id must be required, or the marker is a rubber stamp.

**Rule:** phrase a dormancy pin as "every non-test importer must be arming-gated (zero importers also passes)", never "zero importers" — the latter guarantees a RED window on the binding slice and tempts a cross-territory test edit; accept as gated: a strict `=== true` in the importing file, a `dormancy-waiver(<task-id>)` marker with a REQUIRED non-empty task id (the branch that applies when the real gate lives at the composition root, one file from the import — put the marker in EVERY importing file), or a type-only reference; exclude `/dist/` (compiled artifacts match); pin non-vacuity with an ungated bare call. Guard-rail scope: catches the ACCIDENTAL ungated binding, not an adversarial one — say so in-file. `pin: knowledge test/support/dormancy-pin.ts + ingest-rewrite.test.ts (dormancy_pin_allows_gated_importer)`.

## <a id="53"></a>53. A policy-posture surface renders unknown as UNAVAILABLE (never the permissive value) and re-renders from the command's returned state — and failing closed on the DISPLAY must not strand the emergency OFF control

**Date:** 2026-07-26. **Source slice:** 9.10-C egress-settings surface. Two halves of one rule for any surface that displays a safety posture. **(a) Unknown is not permission.** An err / throw / malformed payload folds to "posture unavailable" — never to the permissive rendering — and the post-mutation display comes from the COMMAND's returned state rather than an optimistic local flip, so the UI can never claim a policy change the worker didn't durably make; a failed mutation leaves the displayed posture untouched, keeping the fail-safe direction honest about failing. **(b) The corollary that is easy to miss:** if an unavailable posture hides the whole pane, failing closed on the DISPLAY has just stranded the emergency OFF control at exactly the moment the operator most wants it. An unavailable state must still offer a Retry (and must not hide the fail-safe action), so display-fail-closed never becomes action-fail-closed.

**Rule:** a policy-posture surface renders unknown/err/malformed as UNAVAILABLE, never as the permissive value; it re-renders from the mutation command's RETURNED state (never optimistically) and leaves the posture unchanged on failure; and an unavailable posture still exposes a Retry so failing closed on the display never strands the emergency OFF control. `pin: desktop test-dom/egress-settings-page.test.tsx (query error → unavailable · post-revoke renders from command result · revoke failure leaves posture unchanged)`.

## <a id="54"></a>54. When only the fail-SAFE direction of a policy control is exposed by design, pin the ABSENCE of the unsafe direction as an exact control INVENTORY over every posture state — a name-regex filter is vacuous exactly where the crossing would re-open

**Date:** 2026-07-26. **Source slice:** 9.10-C (the no-re-ack pin). A deliberately one-directional safety control needs its missing direction PINNED, or a later "complete the toggle" slice silently re-opens an owner-gated crossing. The naive pin — filter the rendered controls by a name regex (`/acknowledge|enable|allow/i`) and assert no match — is **vacuous precisely in the state that matters**: when the posture is already OFF the surface renders zero controls, so the filter trivially passes over an empty set and would keep passing after someone adds the unsafe control to a *different* state. The sound pin is an exact INVENTORY of every interactive node, asserted in EVERY posture state, so adding any control anywhere fails the test until a human re-examines it. Same discipline at the client layer: assert the module's export list exactly, not that no export matches a bad-name pattern.

**Rule:** pin a deliberately-absent unsafe direction as an EXACT control inventory over all interactive nodes in EVERY posture state (and an exact export list at the client layer) — never a name-regex filter over rendered controls, which is vacuous exactly where the crossing would re-open (a fail-safe state often renders zero controls, so the filter passes over an empty set). `pin: desktop test-dom/egress-settings-page.test.tsx (NO re-ack affordance in ANY posture state) + test/renderer/egress-status.test.ts (module exposes NO ack-ON caller)`. **Extension for a tests-only / characterization slice (added 2026-07-26, task 9.24): there is no RED, so non-vacuity must come from MUTATION.** Break the behaviour each assertion claims to protect, observe the failure, restore — and then state **per assertion** which were mutation-confirmed and which have **no plausible current mutation** (those are future-proofing, not proof; say so in-file rather than presenting the whole suite as proven). A characterization suite that has never failed is indistinguishable from one that cannot.

## <a id="55"></a>55. A per-workspace read must verify the RETURNED id equals the REQUESTED one — a validated-but-unused id is the tell

**Date:** 2026-07-26. **Source slice:** 9.10-C (code-quality HIGH). A per-workspace projection that validates `workspaceId`, carries it through, and then never COMPARES it will happily render another workspace's posture under this workspace's label — a WS-8-adjacent display leak that no schema check catches, because the payload is perfectly well-formed. The smell that identifies it: a field that is validated and threaded but never read. Compare the returned id to the requested one at the read boundary and fold a mismatch to UNKNOWN (the same fail-closed path as a malformed payload), never render it.

**Rule:** a per-workspace/per-scope read compares the RETURNED id to the REQUESTED one at the boundary and folds a mismatch to UNKNOWN — a well-formed payload for the wrong scope is a display leak no schema gate catches; treat a validated-but-never-read id as the tell that the comparison is missing. `pin: desktop test/renderer/egress-status.test.ts (foreign-workspace payload folds to unknown)`.

## <a id="56"></a>56. A safety POSTURE must be DERIVED from the state that governs it — never asserted from a constant, a default-seed, or a hardcoded string

**Date:** 2026-07-26. **Source slice:** the round-level shape behind four separate rule-5 issues (9.10-A pre-store constant · 9.22 `!acknowledged` vs the local-only contract · 9.23 provisioning re-seed overwriting a revoked ack · the hardcoded `AppShell` "Egress: local-only" chrome pill). Four defects, one shape: a safety property *assumed* somewhere convenient instead of *derived* from the record that governs it. They differ only in how far the assumption sat from the truth — a constant that predates the durable store; a boolean whose meaning drifted from its own doc comment; a seed that ran before the existence check that would have preserved the owner's decision; and a literal string in view code with no data binding at all. The last is the purest form and the easiest to ship: it cannot be right except by coincidence, it renders globally, and no test fails when reality moves. The tell in every case: **you can change the governing state and the assertion does not move.** **Scope discipline on this lesson's own claim (corrected 2026-07-26 by the implementer who found the pill):** the chrome pill was the only unconditional CONSTANT posture assertion **in `renderer/chrome/`** — verified there (the connection pills are `connection`-prop-derived, the nav badge count-derived, the scope switcher renders workspace names). It was **not** the only false-assurance surface in the renderer, and the sibling shows a SECOND mechanism worth naming: `surfaces/copilot/Copilot.tsx` renders its cloud-egress notice from `turn.egressProcessor`, so the notice's **ABSENCE** reads as "not cloud egress" — **fail-open-by-omission**. Same defect class, opposite construction: not a claim asserted from a constant, but a claim implied by a missing element. A derived-presence indicator is only honest if its absence is also derived; otherwise "we had no data" and "there is nothing to warn about" render identically.

**Rule:** a safety posture (egress mode, local-only, acknowledged, contained, trusted) is DERIVED at read time from the governing durable state — and its ABSENCE must be derived too (a warning that appears only when data is present makes "no data" indistinguishable from "nothing to warn about") — — never a constant, never a default-seed, never a hardcoded string in view code, never a boolean whose meaning has drifted from its doc comment. Test it by changing the governing state and asserting the claim moves; if the claim cannot move, it is not a status, it is a decoration that reads as a guarantee. A default-seed is safe only where it cannot overwrite a later owner decision. `pin: worker egress-posture-store-backed.test.ts + queries/systemHealth egress pins + desktop app-shell chrome_makes_no_egress_claim`; `pattern: no literal "local-only"/"zero-egress" string in renderer view code`.

## <a id="57"></a>57. A per-item governance flag is INERT unless the boundary that acts on the items enforces it — carrying the flag is not enforcing it

**Date:** 2026-07-26. **Source slice:** 13.8d living-vault binding (security-reviewer catch). The synthesis planner emits a plan set in which one plan carries `requiresApproval: true`, and the obvious binding — "commit the plans the producer returned" — **auto-applies the human-gated tier**, because nothing downstream re-reads the flag: neither `createCommitActivity` nor `applyPlan` inspects it. The §9.8 Approvals gate was bypassed by an ABSENT check, not a wrong one, which is why it reads as correct in review: every individual component behaved as documented, and the governance simply had no enforcement point. The brief specified the bypass in good faith ("the plan set reaches the commit path"), so the catch came from asking a question no document prompted: *does anything downstream actually read the flag this data carries?*

**The process half, and it is not secondary.** The brief specified the bypass in good faith, so the only thing standing between it and a shipped Approvals hole was an implementer checking the brief's PREMISE against the code instead of implementing the brief as written. That happened twice in one round: here, and when 13.8g-A's author found that the EntityResolver returns `create_stub` rather than withholding on a no-match — invalidating the brief's recommended option, which would have minted machine-named person notes. **An implementer who contradicts a brief because the code says otherwise is doing the job correctly**, and an orchestrator's brief is a hypothesis to be checked, not an instruction to be obeyed. The corresponding orchestrator duty is now in `docs/tdd-brief-template.md`: any brief that moves flagged/validated items across a boundary must state who enforces the flag downstream.

**Rule:** when a producer emits a SET of validated items carrying a per-item governance flag (`requiresApproval`, `dryRun`, `trusted`, a tier), the CONSUMER that acts on them owns the split — enforce the flag at the acting boundary with a strict `!== <permissive>` test (never truthy: a malformed/older shape must not read as pre-approved), and SURFACE withheld items rather than dropping them. Before shipping any boundary that moves flagged items, verify by inspection that something downstream reads the flag; "the model/producer set it correctly" is not enforcement. `pin: worker approval_tier_is_never_auto_committed + unknown_approval_flag_fails_closed`.

## <a id="58"></a>58. A component-scoped safety pin cannot see a claim rendered by the chrome around it — pin safety claims over the COMPOSED surface

**Date:** 2026-07-26. **Source slice:** 9.10-C + the hardcoded chrome pill. The egress pane shipped with an explicit `NEVER claims zero-egress / local-only` test that passed honestly — and the running app still asserted "Egress: local-only" on every screen, because the pin rendered `EgressSettings` in isolation while the false claim lived in the `AppShell` wrapper one element up. Both facts were true simultaneously: the component made no claim, and the app did. A safety pin scoped to the component under test is blind to exactly the region a user cannot distinguish from it — the composed viewport is what the human reads, so that is the scope the claim must be pinned at.

**Rule:** pin a "this surface makes no unsafe claim" invariant over the COMPOSED surface (component + its chrome/shell), not the component alone — a component-scoped negative pin passes while the wrapper asserts the very thing it forbids, and the user cannot tell the two apart. Corollary: when adding a negative safety pin, ask what renders AROUND the unit under test. `pin: desktop app-shell chrome_makes_no_egress_claim (shell-level) alongside egress-settings-page.test.tsx:220 (pane-level)`.

## <a id="59"></a>59. When the consumer is workflow-SANDBOX code, a dormant capability's arming gate belongs in the ACTIVITY — and the unarmed activity returns the identity result, not a failure

**Date:** 2026-07-26. **Source slice:** 13.8d living-vault binding (worker flag 5). Temporal workflow code runs in a sandbox that cannot read boot config, so the usual "check the flag at the composition root and inject nothing when off" shape has nowhere to put the check on the workflow side. Putting the gate in the ACTIVITY solves it — but only if the unarmed activity returns the **identity/empty** result rather than a typed failure. An unarmed activity that fails makes the dormant path surface a degrade on EVERY run: the health sink fills with a signal that means "this feature is off," which is indistinguishable from "this feature is broken," and the operator learns to ignore both. The dormant default must be observationally identical to not having the capability at all. Corollary honesty requirement: on the Temporal path the true cost of dormancy is one inert activity round-trip — say exactly that in the comment rather than claiming "byte-equivalent", which is false at the trace level even though every observable outcome matches.

**Rule:** when the consumer of a dormant capability is workflow-sandbox code (no access to boot config), put the arming gate in the ACTIVITY and have the unarmed activity return the identity/empty result — never a typed failure, which turns dormancy into a per-run degrade signal that trains operators to ignore the health surface. Describe the residual cost precisely (e.g. "one inert activity round-trip; every observable outcome identical") instead of overclaiming byte-equivalence. `pin: worker source-living-vault-binding.test.ts (default_off_is_byte_equivalent — spy call count 0)`.

## <a id="60"></a>60. An IDENTIFIER is not a NAME — never synthesize a display name from a local-part, and never accept a delimiter-bearing string as one

**Date:** 2026-07-26. **Source slice:** 13.8g-A attendee normalization (both reviewers, independently). Normalizing untrusted free text into an ENTITY reference has an asymmetric cost: a fabricated entity is a vault page a human must find and merge, while a missed one is a re-run. So the rule is *evidence only* — a display name comes from the string or not at all. Title-casing `jane.doe@acme.com` into "Jane Doe" is the obvious violation, but the ones that actually shipped were subtler: the code decided "is this an identifier?" purely by *whether a display part existed*, without asking whether the display part was **itself** an identifier. Three real-world shapes defeated it — `jane.doe@acme.com <jane.doe@acme.com>` (routine ICS/Outlook output when CN equals the address), comma-joined lists (`Jane Doe <jane@…>, Bob Smith <bob@…>`, which bound one attendee's address to another's name), and an internal `all-hands@acme` whose missing dotted TLD failed the strict address shape so the group checks never ran. A delimiter-bearing display part (`@`, `<`, `>`) is therefore never a name, and structural exclusion must run on the RAW string before any parse. Corollary on the other side: a fail-safe-toward-exclusion bias needs an over-exclusion GUARD test, or "bias toward exclusion" is unfalsifiable and quietly eats real people (`Alex Hands`, `rm.patel`).

**Rule:** an identifier is not a name — never synthesize a display name from an email local-part, and never accept a display part containing `@`/`<`/`>` as a name (CN==address and comma-joined lists are routine calendar output); run structural non-person exclusion on the RAW string before parsing; pair any fail-safe-toward-exclusion rule with an over-exclusion guard test naming real humans it must NOT eat. Where a suppression mechanism already makes fabrication impossible (e.g. identifier-only refs that cannot mint a stub), DEGRADE to it rather than dropping — a bias calibrated for the old mechanism should be re-derived, not preserved. `pin: knowledge attendee-refs.test.ts (identifier-as-display-name + comma-joined + internal-group + over-exclusion guard vectors)`.

## <a id="61"></a>61. When a finding names one call site, grep for the CONSTRUCTION — the second copy is the one that ships

**Date:** 2026-07-26. **Source slice:** the 13.8g-A structural-surface finding (reported for one file; a second call site found during orchestrator verification). An accurate report of what a reviewer saw is not a report of the finding's SCOPE. The stub-path defect was reported at `meeting-rewrite.ts:185`; the identical construction also sat at `planner.ts:288`, on the SOURCE-ingestion path — which was already bound (dormant) in production, making the unreported copy the more exposed of the two. The generalization: a defect that lives in a small inline expression (a path join, a cast, a comparison, a default) tends to have been copied rather than shared, so the reported instance is a sample, not the population. Fixing only the reported site leaves the shipped one and produces a "we already fixed that" false memory the next time it surfaces.

**Rule:** on receiving a finding about an inline construction (path building, casts, comparisons, defaults), grep the CONSTRUCTION repo-wide before scoping the fix — never just the reported file — and fix by making the construction live ONCE rather than correcting each copy. Duplication is what let the defect exist twice; de-duplicating is what stops a third. `accepted: not mechanically enforceable` (mitigation: the Step-9 routing habit + a `path_derivation_lives_once`-style structural pin per de-duplicated construction).

## <a id="62"></a>62. A "makes no unsafe claim" pin must be DIRECTION-AGNOSTIC and subtree-scoped — ban the TOPIC in the surface that cannot know it, never blocklist the wrong phrasing

**Date:** 2026-07-26. **Source slice:** #10 chrome egress-claim removal (security review of the pin itself). The approved pin was a three-phrase blocklist. The reviewer ran 25 plausible restorations past it and **20 slipped** — `"Local only"` with a space, a U+2011 non-breaking hyphen, `"Nothing leaves this Mac"` — and, more damning, `Egress: cloud-allowed` and `Egress: none` passed **green** despite being the identical defect: a chrome element asserting a per-workspace posture it cannot know. A phrase blocklist encodes the wrong invariant (this wording was wrong) instead of the real one (this surface may not speak to this topic). The fix bans the TOPIC within the subtree that cannot know it (`.sow-toolbar` may not mention egress at all), scoped so a legitimate sibling stays legal (the left-rail "Egress" nav noun in the disjoint `.sow-sidebar`), with a vocabulary net over every naming attribute plus resolved `aria-labelledby`/`aria-describedby`. Two further blind spots the same review closed: jsdom does not evaluate `content:`, so a DOM-text pin cannot see `::after { content: "local-only" }`; and non-vacuity must be PROVEN with a throwaway probe asserting the pin fails on each restoration form (including aria-only, title-only, indirect-label, and opposite-direction) — a negative pin that has never failed is indistinguishable from one that cannot.

**Rule:** pin "this surface makes no unsafe claim" by banning the TOPIC in the subtree that cannot know it, direction-agnostically — never a blocklist of the phrasing that happened to be wrong (which passes the opposite-direction claim, the same defect); scope it so legitimate siblings stay legal; cover every naming attribute + resolved aria-label references + injected CSS `content:`; and prove non-vacuity with a throwaway probe over multiple restoration forms before deleting it. `pin: desktop app-shell chrome_makes_no_egress_claim + chrome-egress-claim.test.ts (no_dead_egress_pill_styles + no_css_injected_claim)`. **⚠ This lesson was written too narrowly — see L64 for the general form.** The same failure recurs in grep sweeps, code review, and audits, not just test pins; L64 is the rule to reach for when the question is "have we found them all?"

## <a id="63"></a>63. jsdom-tier tests cannot use the static `new URL("<literal>", import.meta.url)` form — Vite's web transform rewrites it to an asset URL

**Date:** 2026-07-26. **Source slice:** #10 (the implementer's own measured correction of a wrong first diagnosis). A structural fs-walking check placed in the jsdom tier failed on its first RED with an infrastructure error rather than an assertion. The initial diagnosis — "`import.meta.url` isn't a `file:` URL under jsdom" — was **wrong**, and was corrected after actually measuring: `import.meta.url` IS a `file:` URL there. What breaks is specifically the STATIC `new URL("<string-literal>", import.meta.url)` form, which Vite's web transform rewrites into an asset URL resolved against the jsdom document base. Beyond the mechanics, the reusable discipline is the correction itself: a plausible cause that explains the symptom is not a verified cause, and an in-file rationale that is wrong is worse than none — it teaches the next reader a false constraint.

**Rule:** don't use the static `new URL("<literal>", import.meta.url)` form in jsdom-tier tests (Vite rewrites it to an asset URL; `import.meta.url` itself is fine) — put DOM-less structural/fs checks in the node tier where they belong (desktop L3). And when you write a rationale comment for a workaround, verify the mechanism rather than the plausible story: a wrong in-file explanation propagates as a false constraint. `pin: desktop test/renderer/chrome-egress-claim.test.ts (node tier)`.

## <a id="64"></a>64. Any search for INSTANCES of a defect must enumerate the CONCEPT, never the known string forms — the known forms are by definition the ones already found. Loop until dry.

**Date:** 2026-07-26. **Source slice:** the chrome egress-claim removal + its design-authority sweep — and, decisively, the orchestrator repeating the error in prose within the hour of banking L62 about it in tests.

This is the general form of L62, which was written too narrowly as a test-pin rule. The failure mode is identical in every medium:

- **As a test pin:** a three-phrase blocklist over rendered text let 20 of 25 plausible restorations through, and passed `Egress: cloud-allowed` — the *opposite-direction* claim, which is the same defect.
- **As a grep sweep:** searching the design docs for the literal strings already known (`"Egress: local-only"`, `"shield egress pill"`) found 4 of 9 sites. A concept-level sweep (shield · pill · ambient · always-visible · "always see") found the rest, and needed **three iterations to come back dry** — each pass's vocabulary surfaced sites the previous pass's phrasing could not.
- **The most dangerous find came last:** a normative *principle* ("always-on governance signals stay first-class visible") that would have re-authorized the removed element on its own authority — and would have felt like good governance while doing it. A generator produces a wrong element; a principle re-legitimizes it.

The reason this recurs is structural, not careless: **the string forms you know are precisely the ones you have already found.** Searching for them can only re-find what you have; it cannot reach the instance phrased differently, spelled with a different hyphen, expressed as a diagram, stated as a principle, or written in the opposite direction. So the search key must be the CONCEPT (what must not be true / what topic this surface may not speak to), and the stopping condition must be *a pass that adds nothing*, not *a pass that found something*.

Applies to: negative test pins, grep sweeps, code review for a known defect class, security audits, doc reconciliations, and any "have we got them all?" question. A one-pass string sweep produces a **confident and wrong all-clear**, which is worse than no sweep — it closes the question.

**Rule:** when searching for INSTANCES of a defect (pin, grep, review, audit, doc sweep), enumerate the CONCEPT — the invariant that must hold, or the topic a surface may not address — never the string forms already known, which by construction are the ones already found; cover the opposite-direction phrasing, alternate spellings/unicode, diagrams, and NORMATIVE statements that would re-authorize the thing (the last is the most dangerous and tends to surface last); and iterate until a pass adds nothing, reporting the iteration count. Never report an all-clear from a single string-shaped pass. `accepted: not mechanically enforceable` (mitigation: state the search KEY and the number of dry iterations in the commit/report, so a one-pass sweep is visible as such — cf. L54 non-vacuity, L61 grep-the-construction).

## <a id="65"></a>65. A fail-safe DEFAULT that resolves through a prototype chain is not a fail-safe — use a `ReadonlyMap` whenever the key is untrusted

**Date:** 2026-07-26. **Source slice:** 13.8j (security-reviewer caught it in the FIX, not the original defect). The pattern `LOOKUP[key] ?? FALLBACK` over an **object literal** looks like a total function with a safe default. It isn't: object literals inherit `Object.prototype`, so `__proto__`, `toString`, `constructor`, `valueOf`, and `hasOwnProperty` all return a **non-undefined** value — `??` never fires, and the caller silently receives a function or an object where it expected a namespace. Here that produced `"[object Object]index.md"` and `"function toString() { [native code] }index.md"`, i.e. **paths back at the vault root** — the exact collision the slice existed to prevent, reintroduced by the mechanism meant to prevent it. What makes this worse than an ordinary bug: it silently converts "complete-by-construction" into "complete except ~9 magic strings", which is the denylist posture the design had explicitly rejected — and a reviewer checking only "does the default get applied?" passes it. Prefer a `ReadonlyMap` over `Object.create(null)`: both fix today, but the Map also survives a later refactor back toward a literal and is immune to a polluted `Object.prototype` gaining new keys. Related but distinct from **L41** (which is about lookup COMPLETENESS — exhaustive `Record` + `Object.hasOwn`); this is about the **DEFAULT being defeated**, a different failure surface, and the two have now bitten in the same round.

**Rule:** never write `OBJECT_LITERAL[untrustedKey] ?? FALLBACK` — the prototype chain makes the fallback unreachable for `__proto__`/`toString`/`constructor`/`valueOf`/`hasOwnProperty`, so the "safe default" silently doesn't apply exactly where the key is adversarial. Use a `ReadonlyMap` (preferred — also immune to later `Object.prototype` pollution and to a refactor back to a literal), and type the parameter as `K | undefined` so the fallback branch is reachable BY THE TYPE SYSTEM rather than through a cast. Pin it with hostile keys, not just an absent one — the hostile-key test is what exposes this class. `pin: knowledge synthesis-entity-resolver.test.ts (__proto__/constructor/toString/valueOf/hasOwnProperty/""/undefined ⇒ namespaced, never root)`.

## <a id="66"></a>66. When an absence is safe only because of an invariant enforced ELSEWHERE, the pin must say so — it encodes a conclusion, not a law

**Date:** 2026-07-26. **Source slice:** 9.24 (the Copilot egress-notice trace). L56 established that a derived-presence indicator is only honest if its ABSENCE is also derived. This is the second half, and it is about the *test* rather than the code. 9.24 concluded that a missing egress notice is safe — but that conclusion rests on four legs that all live **somewhere else**: the field being `.optional()` rather than `.catch()` (so it can never be silently stripped), a failed ask rendering an explicit failure turn, both synthesis adapters failing closed on a non-Claude route before egress, and the composition root pairing the adapter with the route selector under one ternary so they cannot skew. A pin sitting in the consumer that merely asserts "absent ⇒ silent" therefore **encodes a conclusion whose premises it cannot see**. If any upstream leg changes, the pin still passes and the conclusion is quietly false. Two consequences: the pin must NAME the invariants it depends on (so a future reader can re-check them), and the durable statement of *why* belongs where the legs live — parking it in the consumer's test file makes it invisible to the track that owns them (here: a desktop test file the worker track never reads).

**Rule:** when a test asserts that an absence/silence is SAFE, and that safety depends on invariants enforced elsewhere, the pin must name those invariants explicitly and the reasoning must be recorded where the invariants live (architecture doc / the owning area), not only in the consumer's test. A consumer-side pin over a cross-boundary conclusion passes unchanged after its premises break — it documents a belief, not a law. `accepted: not mechanically enforceable` (mitigation: name the dependent legs in the test comment + route the durable statement to the arch note at Step 9).

## <a id="67"></a>67. A test whose NAME asserts more than its body can observe is worse than no test

**Date:** 2026-07-26. **Source slice:** 9.24 — the implementer wrote `non_employer_cloud_egress_behavior_unchanged`, then found it could not see workspace type **at all**: the renderer keys the notice solely on field presence, so the `personal-business` scope in the fixture was decorative and the test was mechanically identical to the existing absent-notice case. It passed, it read as coverage of an owner-chosen posture, and it verified nothing about that posture — the enforcement is worker-side and unobservable from the renderer. That is worse than absent: a suite reader (or a future audit) counts it as protection, so it actively discourages writing the real check. The fix was not to delete it but to **pin what the surface CAN observe** — `notice_is_scope_blind_at_the_renderer` — which is both true and useful: it fails precisely if someone "fixes" the owner-chosen behaviour with renderer-side suppression, i.e. it catches an owner-decision reversal AND a rule-5 decision migrating out of the worker.

**Rule:** a test's name must not claim more than its body can observe — check what the unit under test actually has access to before naming an assertion after a property enforced elsewhere. When the property isn't observable at that layer, don't delete the test: re-aim it at what IS observable and valuable there (often the layer's own blindness to the property), and name it for that. A passing test that verifies nothing is counted as coverage and suppresses the real one. `pin: desktop copilot-panel.test.tsx (notice_is_scope_blind_at_the_renderer — replaced a name-overclaiming test)`.

## <a id="68"></a>68. Verification that flows only DOWNWARD leaves a blind spot exactly the size of whoever sits at the top of it

**Date:** 2026-07-26. **Source:** the round's own review pattern, named by the team lead.

All round, verification flowed one direction: the orchestrator read source to check every implementer's rule-5 claims rather than accepting them, and it kept catching real things — a second unreported call site, a fix that reintroduced the defect class it closed, an accepted "hard-rejects the whole answer" leg that was too strong. That worked. What it did **not** cover was the orchestrator's own output. The concrete evidence: an orchestrator-authored finding claimed commit messages were reaching git degraded and framed the durable audit trail as at risk. It sat in `IMPLEMENTATION_PLAN.md` as fact until the lead **read the stored commit bytes** instead of accepting the report — 3740 bytes, intact. The finding was overstated, and an overstated finding in a durable file is the same defect class as an overstated safety claim: it asserts more than the evidence supports, and someone later acts on it. It survived only because nobody was checking upward.

The structural point generalizes past this team: in any review hierarchy the top node's claims are checked by nobody inside the system. The lead named their own instance of it — they verify the orchestrator's rule-5 claims, and the only check on *their* reports is the owner reading them. So the mitigation cannot be "be more careful"; it has to be that **claims are stated with the evidence attached** (file:line, byte counts, command output) so any reader can re-run the check without trusting the claimer, and that a reader **spot-checks upward** rather than assuming the layer above did its work.

**Rule:** verification must not be purely hierarchical — the top of a review chain is unverified by construction, so (a) state every claim with re-runnable evidence attached (`file:line`, counts, actual command output) rather than as a conclusion, especially in durable files, (b) treat an overstated finding in a plan/architecture doc as the same defect class as an overstated safety claim in code, and (c) spot-check UPWARD periodically — reading the artifact instead of the report is what catches it. `accepted: not mechanically enforceable` (mitigation: evidence-attached claims + the reviewer above reading source/bytes rather than summaries; cf. L64 on why a one-pass report closes a question it never opened).

## <a id="69"></a>69. A TESTED false assurance is an active defense of the defect — it inverts the review gate from a check into a lock

**Date:** 2026-07-26. **Source slice:** 9.22 (worker found the first instance; the lead found the second; an orchestrator sweep found two more artifacts).

> ⚠ **LINE REFERENCES UPDATED 2026-07-29 — this lesson's own citations had gone stale, which is an L71 instance inside L69.** The two assertions are at **`egressCommands.test.ts:87` and `:182`** on current source; the `:83`/`:178` below were correct when written on 2026-07-26 and drifted as later commits landed in that file. Caught by the 9.22 implementer reading the file rather than trusting the citation — my brief 215 had propagated the stale numbers straight from here. **A `file:line` citation is a claim that carries an implicit "as of commit X"**; when it is load-bearing enough to send someone to a specific assertion, re-read before quoting it.

An untested false assurance is a gap. A **tested** one is worse in kind, not degree. `egressCommands.test.ts:83` and `:178` (⚠ now `:87`/`:182` — see above) both asserted `zeroEgressOnly === true` after an egress revoke — a claim that was false whenever the workspace still allowed a cloud processor. The consequence is not merely that the bug was uncaught: **the suite actively defended it.** Anyone attempting the correct fix saw a red test, and red tests confer confidence — so they would back out *believing they had been stopped by a working safety net*. That inverts the gate: the assertion stops being a check on the code and becomes a lock on the code, holding the defect in place with the authority of the test suite behind it. The reflex to make a red test green is strong and mostly correct, which is exactly why **stopping to ask whether the test was right** has to be trained rather than assumed.

Two structural corollaries, both observed in this one slice. **(a) After fixing a construction, re-sweep the TESTS** for assertions that encoded the old behaviour — that is where a correct fix goes to die. One report yielded four artifacts: worker reported one pinning assertion, the lead found a second (a full-object `toEqual`, the more brittle form, and the one that survived the first fix), and a repo-wide sweep found two stale FAKES returning a combination the corrected producer can no longer emit. A fake modelling an impossible state is not defending anything, but it later reads as documentation of intended behaviour. **(b) An audit that reads only production code cannot find this class at all** — it lives in the assertions and fixtures (recorded as scope constraint 5 of task 24.6).

**Rule:** treat a test that asserts a safety VALUE as a claim requiring the same derivation check as the code it guards — a tested false assurance actively defends the defect, because the correct fix presents as a regression and the fixer backs out with a failing test's confidence. When correcting a safety construction: flip AND strengthen every assertion that encoded the old behaviour (prefer an independence/invariant assertion over a value assertion), re-sweep tests and fakes repo-wide rather than trusting the reported instance, and flag a test-semantics change on a safety pin explicitly instead of letting it disappear into a green suite.

`pin: worker egressCommands.test.ts` (`revoke_flips_ack_and_clears_timestamp` · `visibility_reflects_revoke` — the two corrected assertions, each carrying an explicit in-code `9.22 ⚠ SEMANTICS CHANGE (L69)` comment naming this lesson)
⚠ **PIN NAME CORRECTED 2026-07-29.** This pin shipped citing `revoke_return_makes_no_unearned_local_claim`, which **exists in no test file** and shows no sign of ever having existed (the two live carriers have different, long-standing names). Found by executing [L99](#99)'s enforcement pattern, independently of the reported instance that prompted it.
⭐ **It was NOT an absent pin, which was the expected outcome — a third possibility neither framing enumerated: the pin's SUBJECT exists, in the CITED FILE, under two different names.** The evidence is author-declared rather than inferred: both assertions carry in-code `9.22 ⚠ SEMANTICS CHANGE (L69)` comments explaining that each *used to* read `zeroEgressOnly: true` and now reads `false`. That is the artifact this lesson is about, labelled as such by the person who changed it. ⇒ **Cited by test NAME, not `file:line`** — deliberately, because this lesson's own line citations have now drifted **twice** (`:83`/`:178` → `:87`/`:182` → the assertions actually sit at `:91`/`:189`). A name does not rot; a line number is a claim with an implicit *"as of commit X."*
⚠ **Related but deliberately NOT folded into this pin:** `zeroEgressOnlyDerivation.test.ts` `post_revoke_status_is_derived_from_state` pins the *substantive property* the false assurance mis-asserted (a revoke on a cloud-allowlisted workspace still reports `false`). It is **9.22's** coverage of the property, in a **different file** — kept labelled separately rather than absorbed, since folding it in would assert a cross-file equivalence this lesson's own [L99](#99) forbids a rename to smuggle.
⚠ **And the honest limit: this lesson's RULE is a process rule about test-authoring judgment, which no test can pin.** The corrected assertions are *artifacts* of having applied it, not enforcement of it. Treat the rule itself as `accepted: not mechanically enforceable`; **no future slice is owed a pin for it**, and recording one would be a phantom obligation.

## <a id="70"></a>70. Verify the PROPERTY, not the MECHANISM — a mechanism check passes while the property fails, and that is exactly what a reviewer misses too

**Date:** 2026-07-26. **Source:** the implementer's own generalization after a fix reintroduced the defect class it closed **twice** in one round (13.8j, 13.8k).

Both times the tell was identical: the implementer verified that the **mechanism** was in place — the namespace is applied; the guard is called — but not that the **property** held — no root path is reachable; nothing enters the grounded set unvalidated. A mechanism check passes while the property fails, and crucially **a reviewer asking "does it apply the namespace?" misses it for the same reason.** Concretely: 13.8j applied a namespace via an object-literal lookup, so `__proto__`/`toString` resolved through the prototype chain and landed back at the vault root — namespace applied, property violated. 13.8k's `admitInto` was called on every path — guard called, property violated, because it returned `true` for an already-grounded path and callers key stub-creation off that return. The same shape recurs one level up in the pins: a structural pin searched for **the construction the author had used** (`grounded.add`) rather than **the property wanted** (nothing enters unvalidated), so seeding the set via `new Set([...])` bypassed both the admission point and the pin.

The practical consequence the implementer committed to, and it is cheap: **for any pin whose job is to prove an invariant, mutation-test it inside the slice rather than trusting it reads correctly.** Both of that slice's unsound pins looked fine on inspection — one was vacuous, one compared source text — and only deliberately breaking the code exposed them. Two extra runs, versus shipping a test that proves nothing forever.

**Rule:** state and verify the PROPERTY, not the mechanism that is supposed to deliver it — "no path targeting a writer-owned surface is reachable from any producer" rather than "the guard is called"; then adversarially test the property (hostile inputs, not just absent ones). Write pins against the property too, never against the construction you happened to use, or a different construction bypasses both code and pin. And mutation-test any invariant pin in the slice that introduces it: an inspection-passing pin can be vacuous or text-comparing, and only breaking the code distinguishes them. `pin: knowledge grounded-path.test.ts + synthesis-entity-resolver.test.ts (hostile-key + mutation-verified invariant pins)`.

### ⭐ CONFIRMING INSTANCE 2026-07-29 (9.22) — a LOOSE ANCHOR makes a census pin accept a superset

Self-caught by the implementer, on their own guard, in the round's last slice. 9.22 added a source-scan census pin — *"no producer bypasses the predicate"* — to prove that every `zeroEgressOnly` value comes from `isZeroEgressOnlyWorkspace`. The pin matched with a **prefix-anchored** regex.

> **A prefix anchor accepts a superset. `isZeroEgressOnlyWorkspace(x) || true` matches the pin and is a total bypass** — the pin passes on precisely the input it exists to reject.

Matching *"the call appears here"* is a **mechanism** check; the property is *"the value is the predicate's return, unmodified."* They both-anchored the match, then **mutation-verified by reintroducing that exact `|| true` shape**, watched it fail, and reverted. No live instance existed — **they found it by attacking their own guard rather than trusting it.**

**Generalises to every census/source-scan pin:** anchor both ends, and pick your adversarial input by asking *what is the cheapest edit that satisfies this matcher while violating the invariant?* (the [L74](#74) question, aimed at the matcher instead of the subject). A pin that greps for a good call cannot distinguish a good call from a good call with a defect welded to it.

---

<a id="71"></a>
## 71. A durable claim must carry the conditions under which it was true — and a correction is a claim too

**2026-07-27 · the egress-integrity round's five retractions · process lesson, no code pin**

Five claims were retracted in one round. Four are the same defect and the fifth is that defect applied to a *fix*. All five were plausible, all five reached a durable file (`IMPLEMENTATION_PLAN.md`, a handoff, the round log, a Carry-forward item), and none was caught by review — each was caught only when somebody **ran or re-read the actual artifact**.

### The two mechanisms — and why conflating them is itself the trap

The tempting one-liner is *"diagnose by running, not by inferring."* **That is wrong, and the round proved it wrong.** It fits some instances and actively misdescribes the most consequential one, and a lesson that guards the wrong thing leaves the real trap open.

**(a) Written from INFERENCE where execution was available.** A remembered crossing recorded as landed, when one `grep` showed the symbol had **zero hits repo-wide** (it existed only on an unmerged branch — a reader would have searched a file for something that was never there). A mechanism asserted for someone else's error — *"they never ran the suite"* — that was never checked against what they actually did.

**(b) Written from a REAL execution, attributed to the WRONG STATE.** The costliest one, and the one (a)'s framing hides completely. A measurement was taken in a working tree with an edit applied, the edit was reverted, and the result was recorded as a property of committed `HEAD`. The follow-up `git status` (clean) and `git log` (file unchanged) both **passed and were both true** — of a *different tree-state* than the measurement. Two individually-correct observations fused into one false composite. Nothing was fabricated, and checking their work the obvious way **confirmed both halves**.

> **The rule (b) yields, which no amount of "run it" discipline would have produced:**
> **when a diagnosis and its `git status` / `git log` verification are separated by a REVERT, the verification does not cover the diagnosis.** Re-run after the tree is clean, or record the tree state (`git diff --stat` / `git stash list`) beside the observation.

### The propagation half — how three of them survived

Two survived because a reader trusted a credible source instead of checking: an implementer's hypothesis was amplified into a durable file by an orchestrator who did not verify it, and a lead then began banking a *lesson* from that unverified mechanism. The chain broke only when the original implementer **re-tested their own hypothesis and retracted it** — pushing back against a claim already accepted by two people above them. That is the expensive direction to push, and it was the only thing that worked.

**Corollary to [L68](#68):** a credible upstream source is not evidence. The more senior the amplifier, the less likely anyone downstream re-checks — so the *cheapest* place to verify is the moment before something becomes durable, and the person best positioned is the one who least feels the need.

### The fourth instance — a correction is a claim

A half-applied fix left an entry asserting **"ONE issue, not two"** in its head while the tail still declared **"TWO ISSUES ARE STACKED HERE"** with the retracted guidance intact. **A half-corrected record is worse than an uncorrected one:** it reads as authoritative in both directions and the reader believes whichever half they reach first. A second correction over-swung the other way — *"none of that is true"* — when the original observation *was* true, merely of another tree; that erased the very distinction the fix existed to draw.

**So: after correcting a durable entry, re-read the WHOLE entry for coherence, and state precisely which part was wrong** — the observation, its attribution, or its scope. "That was false" is usually too coarse to be true.

### What to actually do

- Attach re-runnable evidence to a durable claim: the command, the counts, `file:line`, and **the tree state it was taken in**.
- Before recording a claim about someone else's error, check what they did. *"They never ran it"* was itself an unverified claim about an unverified claim.
- One `grep` beats one memory. If the claim is "X landed," grep for X.
- When you correct an entry, read it end-to-end afterward, and be precise about which half moved.

`accepted: not mechanically enforceable` — enforcement points are `/orchestrate-end` Carry-forward triage and `/team-end`, where durable text is written under the most time pressure and the least verification.

---

<a id="72"></a>
## 72. A guard applied to ONE field of an aggregate is a silent fail-open for its siblings

**2026-07-27 · 9.23 / 9.29 / 9.31 · worker + its reviewers**

`provisionWorkspace` already did the get-before-upsert that [L30](#30) mandates. It read the stored row, compared `type`, and rejected a type flip. **The read was right there — and only its `type` use was wired.** The same `upsert` rewrote `egressPolicy` (silently restoring a REVOKED egress ack — a rule-5 fail-open, task 9.23), `providerMatrix`, and `defaultVisibility` (fail-closed clobbers, task 9.29) from spec defaults.

Nothing was missing in the sense a checklist would catch: the rule existed, the mechanism existed, the code implemented it. **What was missing was the rule's application to the other fields the same write touches.**

**Why review does not catch this.** A reviewer asks *"is the L30 guard present?"* — it is, visibly, with a correct comment. The guard's presence is what makes the omission invisible; an *absent* guard would have drawn attention. This is [L70](#70) (verify the property, not the mechanism) in the specific shape that recurs most: the mechanism is genuinely there and genuinely correct **for the one field its author was thinking about**.

> **The check:** when a guard protects a field on a write, enumerate **every field that write touches** and state, per field, whether the guard applies. Fields the guard does *not* protect are either deliberate (say so in-code, with the safety direction named) or defects.

**Direction matters for scoping, not for detection.** 9.23's sibling was fail-OPEN (a revoked consent restored); 9.29's are fail-CLOSED (config wiped to restrictive defaults). Both are the same defect. They were deliberately **not** fixed together — carrying `egressPolicy` forward preserves a *revoked* state, while carrying `providerMatrix` forward preserves a possibly-*permissive* `rawCloudEgressEnabled`. Same code shape, different safety argument; the second must not ride in on the first's rule-5 coattails.

**Bound the claim afterwards.** Having closed it, the implementer volunteered that the revoke is durable per workspace **ROW**, not per **VAULT** (task 9.31) — a second workspace pointed at the same vault root re-seeds. "Is it durable now?" answered unqualified would have been a fresh instance of [L56](#56) *about the fix itself*. **A fix's scope is a claim, and inherits the same evidence burden as the claim it repairs.**

`pin: worker provision-preserves-egress-posture.test.ts` (`re_provision_preserves_a_revoked_ack` · `same_type_overwrite_carries_policy_verbatim` · `a_corrupt_stored_policy_can_never_re_cross_into_a_write`)
⚠ **Third name corrected 2026-07-29** — it shipped as `carried_policy_with_a_foreign_workspaceid_does_not_land`, which exists in **no test file** (9.30's rename; see [L76](#76) for the full repair and why the rename is not cosmetic — that guard pins a re-gate 9.30 **superseded**). The first two names were verified live in the same pass, at `:75` and `:118` — the point of checking all three rather than only the one flagged.
`pattern: grep -n "\.upsert(" apps/worker/src/composition` — extends L30's pattern: for each hit, ask which fields the guard covers, not merely whether a guard exists.

---

<a id="73"></a>
## 73. In a multi-axis safety predicate, a fixture failing on the axis you have not built yet reads as a broken fixture

**2026-07-27 · 9.22 option C · caught in review before any code was written**

`zeroEgressOnly` under option C is a conjunction: **axis 1** the provider matrix resolves local-only, **AND axis 2** both egress allowlists are empty. The worker fixture `employerAcked` (via `validWorkspace`) sets `allowedProcessors: []`, `rawContentAllowedProcessors: []`, and `allowedProviders: ["claude"]`.

So it evaluates **`false` — via axis 1**, because `claude ∉ LOCAL_PROVIDERS`. **Its allowlists are empty.** Option A ⇒ `true`, B ⇒ `false`, C ⇒ `false`.

**The trap:** an implementer who builds axis 2 first computes `true` here, sees a test expecting `false`, and concludes the *fixture is stale*. Fixing the test makes the suite green — and ships **option A while believing it shipped option C**, on the rule-5 surface the owner reads to confirm a revoke landed.

> **When a conjunction's axes are built or checked in isolation, a fixture that fails on an unbuilt axis is indistinguishable from a wrong fixture.** The green suite actively confirms the mistake.

This is [L69](#69) with the roles reversed. There, a test defended the defect and made the correct fix look like a regression. Here, the test is *correct* and would be **sacrificed** to an incomplete implementation. Both invert the review gate; the direction differs.

**What to do**
- For every conjunctive safety predicate, record **which axis** makes each discriminating fixture fail. The value is not the verdict — it is the *reason*, which is the part that does not survive a summary.
- State it as a tripwire the implementer will actually hit: *"if your axis-2-only implementation makes this fixture pass, you have implemented option A."*
- Prefer **separate per-axis predicates** with the AND at one visible composition site over one fused predicate. A fused predicate hides which axis failed, and hiding which axis failed is how a two-condition safety claim degrades into a one-condition claim with nobody noticing.
- Test **each axis alone ⇒ false**. Those are exactly the cases the weaker options miss, and they are what makes the conjunction falsifiable rather than decorative.

**Also recorded (the meta-point that prompted the check):** the claim under review — "the branch's literals are correct under C" — was **right**, and its most natural justification ("the allowlists are empty") was **wrong**. A right answer resting on a wrong reason is indistinguishable from a right answer until someone builds on the reason. That is why an observation was demanded rather than a derivation, and why the *reason* was recorded alongside the verdict.

`accepted: not mechanically enforceable` — mitigation is the per-axis test set + recording the failing axis beside every discriminating fixture.

---

<a id="74"></a>
## 74. A guard must assert the exhaustive, non-emptiable oracle — a label the scorer only subset-checks is free to empty

**2026-07-27 · task #19 synthesis-corpus guard · security review HIGH, found and fixed in-slice**

The anti-laundering guard added alongside a corpus re-point first asserted that every path in `expected.stubPaths` sat under a known entity namespace. It read as rigorous and passed design review — including mine.

It was defeatable. `stubs_present` (`scorer.ts:63`) is a **SUBSET** check, so `stubPaths` can be **emptied at zero cost**: a targeted de-namespace could re-point `createPaths` back to the vault root, empty `stubPaths`, and walk straight through the guard — with corpus-wide non-vacuity still propped up by the *other* entry.

**The defect: the guard asserted over a corpus LABEL rather than over the thing the label describes.** A label is an input the attacker (or a careless future edit) also controls. Fixed by making the primary oracle the planner's **real emitted paths** (`no_root_creates_from_planner`) — which no corpus edit can satisfy — and demoting the label check to a secondary that names the offending expectation, covers `createPaths` too, and rejects `..`.

> **Ask of any guard: what is the cheapest edit that makes this assertion vacuous?** If the answer is "empty the field it reads," it is guarding a label, not a property. Prefer an oracle the artifact under suspicion cannot rewrite.

Directly related to [L70](#70) (verify the property, not the mechanism) and [L54](#54) (an exact inventory, because a filter is vacuous precisely in the state that matters) — the recurring form is an assertion whose *subject* is attacker-controlled.

`pin: evals suites/synthesis/synthesis-reason.test.ts (no_root_creates_from_planner)`

---

<a id="75"></a>
## 75. Prove a new guard by SIMULATING the compromise it claims to catch

**2026-07-27 · task #19 · the step that upgraded "load-bearing" from opinion to evidence**

The guard in [L74](#74) had already passed review as load-bearing when its author found it bypassable. What settled it was not more review — it was **running the attack**.

The simulation: compromise the planner so it genuinely mints at the vault root, then launder the corpus to agree, then re-stamp the integrity hash — i.e. perform the exact laundering the guard exists to detect. Result:

- **All 10 pre-existing tests PASS** — including `safety_floor_100pct` and `faithfulness_no_fabrication`
- **Only the 2 new KN-12 guards fail**

So a KN-12 root-collision regression laundered through the corpus **would have shipped fully green before this slice**. That sentence is a measurement. "The guard is load-bearing" was, until then, an opinion that had already survived one review while being false about the guard's first version.

> **A negative guard that has never failed is indistinguishable from one that cannot fail.** Make it fail on purpose, against a genuine compromise rather than a hand-built fixture, then revert. Report what stayed green — the passing set is the finding.

Generalizes [L62](#62)'s throwaway-probe practice from phrasing-blocklists to any safety guard, and pairs with [L70](#70): the simulation is what distinguishes "the mechanism ran" from "the property holds."

**Byproduct worth its own note (knowledge, 13.8j):** the first simulation deleted the `concept` map entry and the planner emitted `entities/widgets.md`, **not** a root path — producing a root mint required *also* blanking `FALLBACK_NAMESPACE`. That module's comment calls the fallback "⚠ LOAD-BEARING — do not tighten this into a rejection." **That claim is now demonstrated rather than asserted**, and any future slice tempted to harden the fallback into a rejection should read it as measured fact.

⛔ **MISSING PRECONDITION — added 2026-07-28 after the same author's simulation was itself invalid.** Hunting the guard blindnesses of [L74](#74), their **first** simulation patched `@sow/providers` while the test under examination imports from `@sow/domain`. It produced a plausible, confident **"24/24 passed"** — a result that looked exactly like a finding. They caught it only because a companion assertion *should* have fired and didn't, then re-ran against the real import path.

> **A simulation is evidence only if you prove the compromise was REACHED — by seeing the guard FAIL before you trust it passing.** Otherwise you have measured an untouched code path and are about to report a blindness that does not exist — the [L71](#71) defect (a real execution attributed to the wrong thing) wearing the clothes of this very technique.

**There are at least two distinct ways to get that false green, and only the FAIL-first check covers both** (both hit by the same author, hours apart): (i) the compromise never reached the code under test — patching `@sow/providers` where the test imports `@sow/domain`; (ii) the compromise reached the right function and **no test fed it the triggering input** — the oracle was fixed but the corpus hand-picked three values, none of them the PEM the fix was for. "Verify the import path" catches only (i). **Running the guard against the compromise and requiring RED catches both**, which is why it is a required state and not a review step.

⛔ **AND A GREEN SUITE IS NOT EVIDENCE A FILE RAN — CHECK THE COUNT (added 2026-07-28, third self-caught defect in one slice).** Literal control characters in a fixture made a test file a **syntax error**, and a broken test file reports **`PASS (0) FAIL (0)`**. Every signal that normally means "fine" said fine. It was caught only because the suite **COUNT** dropped **466 → 334**.

> **A file that did not run and a file whose tests all passed are indistinguishable from the pass/fail line alone.** The count is the only signal that separates them — and a simulation whose file silently stopped executing produces a *perfect* false green.

This is the same defect class as the states above, one layer lower: state 1 (compromise applied, guard passes) is **indistinguishable from "the test file did not execute."** Record the test COUNT alongside every simulation state, not just the verdict.

**The three-state protocol** (the practising implementer's own formulation, adopted as the method):
1. **compromise applied, guard PASSES** → the blindness is reproduced;
2. **guard fixed, compromise still applied, guard FAILS** → it now discriminates;
3. **compromise reverted, guard PASSES** → no false positive on correct code.

**State 2 is the one a "fix" without simulation skips**, and it is what caught a stacked second defect that state 1 and 3 both missed. A compromise that changes nothing is indistinguishable from a compromise that was never applied.

### ⭐ AMENDMENT 2026-07-29 — the trap was hit again, inside this very technique, and the new half is WHY

While verifying #41's leads, an implementer mutated `budget-enforcer.ts`'s `branch: "cancelled_budget"` literal, reported **7 PASS / 1 FAIL**, and then caught themselves: **they had stated the result before running the command.** The real run was **8 PASS / 0 FAIL** — nothing went red. They flagged their own error, found the cause, re-ran against the correct target (`broker.ts:377`), and got the genuine 7/1.

**The new, sharper half — a mutation target can look live and be DEAD, because a downstream consumer re-hardcodes the value.** `budget-enforcer.ts` computes `branch` on its `GateDeny`; **`broker.ts:377` discards it entirely and re-hardcodes its own `"cancelled_budget"` literal.** So mutating the producer's field changed nothing observable — not because the test was weak, but because **nothing reads that field.** This is a distinct sub-case of (i) "the compromise never reached the code under test": the *import path was right*, the *function was right*, and the field was still unreachable.

> **Before trusting a green mutation, confirm the mutated value is actually CONSUMED** — not just that the file, module, and function are on the path. Two independent literals that happen to agree read exactly like one shared literal until you mutate one.

**Corollary finding, worth its own fix:** that duplication is a live drift risk — a computed field silently discarded and re-hardcoded downstream will diverge the first time either side is edited.

**And the process half stands on its own:** the failure was *stating a simulation result before executing it*, inside the lesson that exists to stop exactly that. It cost nothing only because the author corrected it within minutes, unprompted, against their own prior message. **Self-correction at that speed is what keeps a verified-findings list worth reading** — the alternative is a list where one entry is wrong and none can be trusted.

`accepted: not mechanically enforceable` — mitigation: state the simulation, **the import path it reached**, **that the mutated value is consumed downstream**, and the passing set in the Step-9 report. Never state a simulation result you have not run.

---

<a id="76"></a>
## 76. An unchecked cast on a READ path that feeds a WRITE path is the only validation boundary you have left

**2026-07-27 · 9.23 · generalized at the lead's request beyond the slice that surfaced it**

`packages/db`'s workspace `get` returns `row as Workspace` — an **unchecked cast, no Zod on the read path**. That is invisible and harmless while a stored row is only *read*. It stops being harmless the moment a value read that way is carried into a **write**, which is exactly what 9.23's fix does when it carries `existing.value.egressPolicy` forward.

At that point the re-parse (`WorkspaceSchema.parse` on the reassembled aggregate) is not a formality or belt-and-braces — **it is the only validation the stored blob ever receives before re-crossing into a write.** It catches a foreign `egressPolicy.workspaceId` (the identity refine), a contradictory `acknowledgedAt`-without-ack, a non-array allowlist, and any unknown key. Narrowing it to a hand-written id comparison — which reads like a tidy simplification — would silently drop all of that.

**Fail closed, do not normalize.** A foreign `workspaceId` is rejected rather than rewritten to the expected one: normalizing would graft another workspace's allowlist and acknowledgment onto this workspace, **stamped as if it belonged there** — a WS-8-adjacent write that looks entirely legitimate to every later reader. Same posture as the store-fault branch: never proceed over a contradictory prior state.

> **Find the read→write paths.** Wherever a repository read is typed by cast rather than parse, and its result can reach an `upsert`, the parse at the write boundary is load-bearing and must be commented as such — otherwise a future reader deletes it as redundant with "the type."

This is the read-path dual of the project's candidate-data rule (safety rule 2): provider output is untrusted until parsed, and **so is your own store's output once a cast is the only thing asserting its shape**.

`pin: worker provision-preserves-egress-posture.test.ts (a_corrupt_stored_policy_can_never_re_cross_into_a_write)`
⚠ **Citation corrected 2026-07-29.** This lesson shipped citing `carried_policy_with_a_foreign_workspaceid_does_not_land`, which exists in **no test file** — 9.30 renamed the guard, and every citation kept the old name (contracts [L93](#93)'s rot direction, [L96](#96) applied to a `pin:` line rather than a prose claim). The live guard is at `apps/worker/test/composition/provision-preserves-egress-posture.test.ts:221`.
⛔ **And the rename is not cosmetic — do not repair the citation without reading what the new name says.** That guard's own annotation is *"9.23's re-gate, superseded (9.30)"*, and `IMPLEMENTATION_PLAN.md:1186` records why: 9.30 **DELETED** the `existing.value.egressPolicy` carry-forward **and its `WorkspaceSchema.parse` re-gate** — the exact mechanism this lesson is about — because `updateProvisioningFields` narrows the same-type write to name/vaultRoot/brainId, so **no stored blob re-crosses into a write at all** and the re-gate's premise evaporates rather than being ignored. ⇒ **The RULE stands** (a cast-typed read that can reach a write is the last validation boundary you have). **The MECHANISM it praises is history** — superseded by a stronger closure: by construction, not by re-gate. Cite it that way; a bare rename would have turned a stale citation into a fresh false claim ([L71](#71) — a correction is a claim too).
`pattern: grep -rn "as Workspace\|row as " packages/db/src` — each hit is a read whose consumers must parse before writing.

---

<a id="77"></a>
## 77. A multi-axis safety posture is only as strong as its axes' INDEPENDENCE — verify no single event can zero them all

**2026-07-27 · 9.22 option C · found by the producer implementer, escalated rather than silently strengthened**

Option C was chosen over the single-axis alternatives for one stated reason: **it requires two independent things to go wrong before the app misreports safety.** That rationale is the whole justification for the extra complexity.

It does not hold at the default state. `provisionWorkspace` seeds **both** allowlists `[claude]`, so *"both allowlists empty"* **is** the never-provisioned state — and that same absence leaves `providerMatrix` empty, which satisfies axis 1 **vacuously**. **One missing event zeroes both axes**, and an unconfigured workspace reports the strongest safety claim the system can make.

The result is not *false* — an empty matrix genuinely routes nowhere. It is worse than false in one specific way: **it is indistinguishable from a deliberate owner decision** while being the product of nothing having happened yet.

> **When you compose a safety claim from N conditions, enumerate the events that could set each one, and check whether any single event sets all N.** If one does, the conjunction is theatre at exactly that state — you have a one-axis predicate wearing an N-axis costume, and the extra axes buy nothing precisely where the system knows least.

**Two process points, both worth copying:**
- The implementer **shipped it as ruled, documented it, pinned it, and escalated** — rather than quietly strengthening the predicate against an owner ruling. Silently hardening a safety predicate past its ruling is a second inversion in the same file; the escalation is the correct move even when the strengthening looks obviously right.
- Ask the independence question **at design time**, when the answer changes the option chosen. Here it surfaced after the ruling, so the ruling now carries a recorded qualification instead of having been made with full information.

Companion to [L73](#73) (the axis-order trap — the *implementation* hazard of a conjunction). This is the *design* hazard: L73 is about building one axis and mistaking a correct fixture for a broken one; L77 is about the axes not being the independent things you counted.

`pin: policy processors-zero-egress.test.ts` (the unprovisioned-workspace case, pinned as deliberate) · **task 9.29** is the durability fix that stops it being routinely reachable.

---

<a id="78"></a>
## 78. Totality is a property of the whole fold, not of the guard you wrote — a branding constructor throws on input your guard admitted

**2026-07-27 · `processorOfRoute` · found while consuming it**

`processorOfRoute` documents itself as pure and fail-closed, and its malformed-route branches carefully return the `MALFORMED_ROUTE` processor (egress, never non-egress) rather than throwing. The guards are right.

Then it **brands** the route's raw identity — and the brand constructor throws on a blank string. So `{provider: ""}`, arriving from a deserialized row, **throws instead of denying**, on the identity layer that sits directly beneath the egress veto. A throw on an untrusted route is a fail-open-by-crash on a rule-5 path.

**The author's guards were exhaustive over the cases the author enumerated.** The throw came from a *downstream constructor* the guards happily fed — a value that passed every explicit check and then failed at a conversion nobody classified as a check.

> **Totality is a property of the whole fold from untrusted input to returned value — including every constructor, brand, parser, and coercion along the way.** Reviewing "are the guards exhaustive?" cannot find this, because the guards *are* exhaustive; the throw lives after them.

Practical checks: brand/parse **after** validating, or use the non-throwing constructor variant; for any function documented total, trace each `return` path back through every call it makes and ask which of them can throw on admitted input; a `try` at the boundary is containment, not totality — it protects *that* caller and leaves every other one exposed (which is why this became its own task rather than being fixed at the call site).

Related to [L76](#76): both are cases where a value crosses a boundary carrying a *type-level* promise (a brand, a cast) that nothing enforced at runtime.

`pin: policy processors-zero-egress.test.ts` (boundary containment) · **task #25** makes the predicate itself total.

---

<a id="79"></a>
## 79. Adding a conjunct silently retires the discrimination of every existing test built on the state it now rejects

**2026-07-27 · 9.22, the owner's third conjunct · found by the implementer adding it**

`isLocalOnlyProviderMatrix` gained a third conjunct: the matrix must be **non-empty**. One line. The predicate's existing test suite stayed green.

**Green was the wrong signal.** Every single-fault fixture in that suite — `allowedProviders: ["claude"]`, `rawCloudEgressEnabled: true`, the sparse-array and hole cases, the proxy cases, the malformed-field cases — had been built on an **empty matrix**, because that was the minimal fixture under the old two-conjunct arity. After the change, all seven still passed **on the new unconfigured conjunct, not on the condition each was written to test.** They asserted `false` and got `false`, for a reason that had nothing to do with their names.

**Two were worse than non-discriminating.** The totality pins (blank route identity, throwing getter) **short-circuited at the new check and never reached the route scan they exist to exercise.** A safety pin that no longer executes the code it guards is [L69](#69)'s hazard arriving by accident: it is not defending the defect, it is simply absent while reporting present.

> **Widening a predicate's precondition narrows the input space its existing tests explore.** Any fixture that satisfied the old arity *minimally* now likely fails at the new conjunct first — so it stops discriminating, silently, with no red anywhere.

⭐ **SHARPER (2026-07-28, from the implementer who did the re-basing — the first framing was too weak):** the hazard is **not** "old tests go stale." Two of the affected pins had **already been mutation-verified in the base slice**, and the re-basing itself was done correctly — yet they *still* silently re-pointed at the new conjunct. The under-reported-`length` proxy fixture began tripping the new check instead of the guard it was written for; the non-enumerable/symbol fixtures were clearing the conjunct only because it enumerated keys the same way their target guard did. **A fixture can be re-based correctly and still end up asserting the new condition rather than its own** — because the new conjunct and the old guard can inspect the *same structural property*, so satisfying one incidentally satisfies or trips the other. Mutation-verification before the change does not survive the change. **Re-mutate every affected pin AFTER adding the conjunct, not just before.**

**The check when you add a conjunct to a shared predicate:** for each existing test, ask *does this fixture still reach the condition the test is named for?* Mechanically: re-base every case onto a fixture that **satisfies the new conjunct** (here, a `localMatrix()` builder producing a genuinely configured matrix), so each test fails for its own reason again. The alternative — trusting a green suite through an arity change — is verifying the mechanism instead of the property ([L70](#70)).

**This is the third time in one round a green suite would have certified the wrong thing** (the tested false assurance of [L69](#69); the laundered corpus of [L75](#75); this). The common thread is not carelessness — each suite was thorough *for the shape it was written against*, and each was invalidated by a change that no test could see. **A suite's discrimination is a property of the fixtures, not of the assertions**, and nothing in a passing run reports its loss.

⭐ **CONFIRMING INSTANCE, ONE DAY LATER — this lesson caught a live regression, not a stale fixture (2026-07-28, desktop 9.26/9.28).** A refactor deleted a field-by-field re-map, and the post-reshape mutation check on a 9.24 rule-5 pin went **RED**. What it surfaced was not a fixture needing an update: **deleting the re-map also deleted a defensive throw** nobody knew they relied on, which had been landing contract-violating payloads on `ASK_FAILED`. With the answer carried verbatim a malformed reply would instead throw **during render** — and with **no `ErrorBoundary` anywhere in the app**, React unmounts the **entire root** rather than the panel.

> **When a refactor removes code, ask what failure mode that code was incidentally providing.** A mapping, a cast, a redundant-looking branch — each may be the only thing converting a crash into a handled path.

`pin: policy processors-zero-egress.test.ts` — every single-fault case re-based onto `localMatrix()`; the unconfigured case asserts `false` on **both** halves independently. · `desktop copilot-panel.test.tsx` — the three reshaped 9.24 pins, each re-mutated *after* the reshape and each discriminating something different.

---

<a id="80"></a>
## 80. A suite must assert that a gate DECIDES, not that a gate SAID NO

**2026-07-28 · eval-guard sweep (24.6-A) · the round's strongest single line, recorded verbatim at the lead's instruction**

> **These suites assert that a gate SAID NO, not that the gate DECIDES.**

Two guards, both proven blind by simulation, both leaving **all 610 tests green** under a compromise that should have been caught:

- **rule 7 — redaction.** `redactRecord` was compromised so a non-allowlisted field emits a **PEM private key verbatim**. Green.
- **rule 4 / WS-8 — visibility.** `validateProjectionVisibility` was replaced with a **constant DENY** — a gate that decides nothing and refuses everything identically. Green.

**A guard with no allow-side control and no reason-code pin cannot distinguish a working gate from a brick wall.** Every deny-side assertion still passes when the gate has stopped deciding, because "it said no" is exactly what a brick wall says. The suite is measuring the *outcome* it hoped for rather than the *decision* it claims to test.

### The two things that make a guard suite discriminate

1. **An allow-side control** that differs from the deny fixture **in exactly the field the gate decides on**. The WS-8 fix was one such case: an `isolated`-level projection *within* an `isolated` default must be ALLOWED. Its sibling leg already had one — same file, one leg protected, one not — and the sibling's own comment stated the reason. **The asymmetry was the defect.**
2. **A reason-code pin,** not just a boolean. A `MALFORMED_POLICY_INPUT` deny and a genuine visibility refusal are the same `isDeny`, and a suite that reads only the boolean scores a broken gate as a working one. `suites/egress-ack/egress-veto.test.ts` is the reference shape: every deny pins a reason **code**, so removing the protection flips the *reason*, not merely the outcome — and it survives the constant-deny substitution that kills the others.

### The corollary that nearly shipped a half-fix

Fixing the redaction **oracle** left the suite *still green under the compromise*, because **nothing ever fed it a PEM** — the non-allowlisted-field case hand-picked three values, none of them one.

> **An oracle only protects what the corpus actually drives through it.** Fixing the eye is useless if nothing walks in front of it.

Both halves were the same [L74](#74) move: delete the enumeration (check every corpus value verbatim) **and** drive the whole corpus through the guarded path rather than a hand-picked sample. ⚠ **In a safety ORACLE an enumeration is worse than in a guard** — it does not fail open loudly, **it just stops seeing.**

### Scope

This generalizes past evals to any test of a policing predicate — egress vetoes, admission gates, approval gates, visibility gates. **Ask of any guard suite: if I replaced the gate with a constant DENY, would anything go red?** If not, the suite pins the outcome, not the decision.

`pin: evals suites/leakage/workspace-leakage.test.ts` (allow-side control) · `test/observability/redaction-conformance.test.ts` (whole-corpus, enumeration-free oracle) · reference shape `suites/egress-ack/egress-veto.test.ts`

---

<a id="81"></a>
## 81. An implementer who contradicts a brief after reading the code is functioning correctly — expect it, don't tolerate it

**2026-07-28 · five corrections in one round · recorded at the lead's instruction as a STANDING EXPECTATION, not an anecdote**

In a single round, implementers corrected **five** orchestrator-authored framings. Every one was caught by **doing the work**. **None** was caught by review — not by the orchestrator who wrote it, not by the lead who endorsed it, not by a reviewer subagent.

| # | The framing | What reading the code showed |
|---|---|---|
| 1 | "a re-derived `dataOwner` removes the employer branch of the §5 egress veto" | The veto branches on workspace **`type`**; `dataOwner` reaches it only as an audit ref. The real fail-open is the **approval gate** (`approval-policy.ts:176`), where `dataOwner: "user"` moves an external action to auto-create with no §9 card. *(Also: `defaultVisibility` is not uniformly fail-closed — it is **permissive** at that same gate.)* |
| 2 | "read the sibling `arch_gap` and match the house answer" | The sibling's justification **inverts**: fail-SAFE there / fail-**OPEN** here, and a re-provision **repairs** the sibling's race while **causing** this one. Matching it would copy a conclusion while discarding the premise that earned it. |
| 3 | "a simulation must verify the import path" | That is the language-specific *symptom*. The rule is **prove the compromise was REACHED — see the guard FAIL before trusting it passing**, which covers both observed false-green modes. |
| 4 | "apply admission to the source path's plan targets" | Read naively that gates the **merged** output, refusing the writer's own KN-12 parity writes and **destroying the feature while still "preventing collision"** — the exact non-vacuity trap the same brief named three sections earlier. |
| 5 | "sweep for more instances (#30) before fixing the known ones" | **#29 is a FALSE coverage claim; #30 finds MISSING ones.** A DoD asserting coverage by a nonexistent file reads green and *closes the question*; another true gap on a pile already known non-empty changes nothing anyone would do. |

**Why review cannot substitute.** Each framing was *plausible* — that is what got it written and endorsed. A reviewer checks whether the instruction is coherent, not whether its premise survives contact with the code, because checking the premise **is doing the work**. Case 4 is the sharpest: the brief's own test #3 named the trap the brief's Files line then walked into. The author had the concept and still wrote the contradiction.

> **The brief is a hypothesis. The code is the evidence.** An implementer who reads the code and contradicts the brief has done the job the brief could not do for itself.

**What this obliges, on each side:**
- **Orchestrator** — write premises as **falsifiable claims with `file:line`**, so contradiction is cheap; treat a Step-2.5 correction as the process working, never as friction; and **carry the correction upward** rather than absorbing it, because the endorser is usually holding the same wrong picture ([L68](#68)).
- **Implementer** — a brief that contradicts the code is a **finding**, not an instruction to follow carefully. Cases 1 and 3 were implementers correcting **their own** prior claims after the orchestrator had already relayed them upward; that is the most expensive direction to push and the only thing that stopped the chain.

**The asymmetry that makes this structural:** verification pressure in a review hierarchy runs *downward* by default. Three of this round's five corrections travelled *up* through an orchestrator and a lead who had both already agreed. Nothing in the hierarchy checks the top node ([L68](#68)) — **only contact with the code does.**

⭐ **SIXTH INSTANCE — AND THE MOST CONSEQUENTIAL, BECAUSE IT WAS A CLOSE-OUT INSTRUCTION (2026-07-28).** The orchestrator told an implementer to record "the 3 lenses (E/F/G) unexplored" in their session doc. **E and F had been run to completion; only G was never started** — and that completed pass had produced ~10 findings including a **live rule-3 edge** (an eval fake missing the real repository's terminal-state guard, where production has no second guard). The implementer corrected the instruction **while executing it**. Had they complied, **the finding would have been lost at respawn**, because the successor re-derives from files and the file would have said the pass never happened.

> **A wrong instruction in a CLOSE-OUT is worse than a wrong instruction in a brief.** A brief's error surfaces when the code contradicts it; a close-out's error is *written into the durable record and never contradicted by anything*, because the work that would have contradicted it is exactly what stops.

Corollary: at a cycle boundary the orchestrator is describing work it did not do, from messages that are compressing, under time pressure — the worst possible conditions for a claim that will be the only surviving record. **Ask the implementer to correct the close-out list rather than dictating it.**

⚠ **AND IT APPLIES ONE LAYER FURTHER UP — the LEAD, self-identified.** A close-out generates a burst of lead direction (record-don't-fix, what session docs must carry, what the seal must say), all issued from compressing messages, at speed, describing work the lead did not do — **the same conditions, one step further from the code.** The defense is identical and was not being applied there: **nobody was asking the lead to correct their close-out lists.** Ask upward as well as downward, or the layer with the least contact with the code writes the most durable text unchallenged.

⚠ **AND THE SAME TRAP CATCHES THE VERIFIER.** Checking one of these corrections, the orchestrator ran `git diff … | grep -c "<pin_name>"`, got `1`, and nearly reported the implementer's self-correction as wrong. **A context line and a changed line count identically under `grep -c`** — the single hit was a *new comment* mentioning the pin, not a change to it. The measurement that verifies a correction is as capable of being the wrong oracle as the claim it checks ([L71](#71)); when a count decides a question, check *what kind* of line it counted.

`accepted: not mechanically enforceable` — mitigation: cite `file:line` for every load-bearing brief premise; pre-load a Step-2.5 question wherever a premise carries the slice; state corrections in the round record with attribution so the pattern stays visible.

---

<a id="82"></a>
## 82. On finding a false assurance: make the claim true, or retract it — never split the difference

**2026-07-28 · two DoD claims, opposite dispositions, one rule · lead ruling**

Two false coverage claims surfaced in the same sweep, and they were resolved in **opposite directions**. That contrast is the lesson.

- **`WORKSPACE_LEAKAGE dodPass=true`** — unsupported (no allow-side control, so a constant-DENY gate scored identically). **Disposition: make the claim TRUE.** The missing evidence was *one pin*.
- **Four dead DoD suite pointers**, incl. safety-classed `KNOWLEDGE_WRITE` / `WORKSPACE_ROUTING` / `TOOL_GATEWAY_IDEMPOTENCY` — the registry asserted coverage by files that **do not exist**. **Disposition: mark UNCOVERED and open tasks to write the suites.** Making those claims true is three real safety suites.

> **Make the claim true when you cheaply can; retract it when you can't. Never split the difference.**

### The forbidden middle is the one that feels most helpful

The tempting third option — **re-point the pointer at whatever suite sits nearby** — is the failure mode, and it is attractive precisely because it is cheap, looks like a fix, and turns the build green. It **manufactures the appearance of coverage**: committing the defect while ostensibly repairing it. "Nearby" is not coverage; **proximity is not evidence.** Re-point only with proof the suite covers the criterion's *actual claim*.

### Why "uncovered" beats "falsely covered"

**An uncovered criterion is VISIBLE; a false-green one CLOSES THE QUESTION.** The first invites work. The second actively prevents it — nobody audits a criterion that reports covered, so the gap becomes permanent *and* invisible. On a safety-classed criterion that is strictly worse than the honest gap.

This is [L56](#56)'s disposition half. L56 says *derive a claim from the state that governs it, never assert it*. L82 says what to do the moment you find one that was asserted: **the cheap-and-quiet option is the one that reproduces the defect.**

### The generalizable test

When you find a claim the evidence doesn't support, three options exist and only two are legitimate:
1. **Supply the missing evidence** — right when it's cheap and bounded (one pin, one fixture, one assertion).
2. **Withdraw the claim + record what would restore it** — right when the evidence is real work. Cost: honest visibility.
3. ⛔ **Re-aim the claim at whatever evidence is handy** — *never*. This is the option that produces a green build and a false record, and it is the one that will feel like the pragmatic middle path.

⚠ **The pull toward (3) scales with deadline pressure and with how safety-classed the criterion is** — exactly inverted from where it is safe.

`accepted: not mechanically enforceable` — mitigation: an `existsSync`-class tripwire so a dangling claim becomes RED rather than invisible; route volume-of-work-to-make-it-true upward before choosing, since that number decides between (1) and (2).

---

<a id="83"></a>
## 83. In a shared working tree the INDEX is shared state — per-file `git add` is not isolation

**2026-07-28 · hit from both sides in one round · desktop + evalsec**

Two implementers hit the same defect from opposite ends within hours, neither at fault:

- **Desktop**, staging its own four files, found **three of evalsec's already staged** in the shared index. A plain `git commit` would have swept another track's in-flight work into a **rule-5 commit** — the `225c10ca` mixed-commit failure this project has been paying for all round. They used a **pathspec-limited commit** (`git commit -- <their paths>`), verified exactly four files landed, and relayed that evalsec's staging had been reset (content intact).
- **evalsec**, staging only its session doc, had that doc **swept into the worker's commit**, because the index already held eight of worker's files when worker committed.

> **`git add <my-file>` isolates what you *put in* the index. It does not isolate the index.** Anyone else's broad `add` or `commit` between your `add` and your `commit` carries your staged file with it — or takes theirs with yours.

**The defenses, in order:**
1. **Pathspec-limited commit** — `git commit -- <paths>` makes capturing someone else's work *structurally impossible* rather than a matter of noticing. ⚠ Side effect: it resets the index for the *uncommitted* paths, so a teammate's staged files silently become unstaged. **Their content is safe; tell them**, or they meet an empty staging area mid-commit.
2. ⭐ **CHAIN `git add … && git commit …` IN ONE SHELL INVOCATION** — this is the mitigation that actually worked, and per-file `add` is not a substitute. **Atomicity is the defense; discipline is not.** Verify `git diff --cached --name-only` immediately before, and `git show --stat` immediately after. ⚠ The index can also be *reset* between your `add` and your `commit` ("no changes added to commit" on a call that just succeeded), and **`git status`/`git show HEAD:<path>` can lie to you about your own work** — only `git diff HEAD` was trustworthy.
3. **Verify at commit time, not add time.** The window between the two is the whole exposure.
4. **Do not rewrite history to fix a mis-attribution.** A rebase in a shared tree with live agents is far more destructive than a file committed under the wrong message. Record the attribution in the round seal instead. *(evalsec's call, and it was right.)*

⚠ **FIVE incidents in one round, not two** — desktop finding evalsec's files staged · evalsec's doc swept into a commit · evalsec's *second* edit swept again · worker's `add` silently picking up provint's rename · worker's index reset between `add` and `commit`. ⛔ **Three of the five landed inside a RULE-5 safety commit**, which breaks *"never bundle a safety-critical slice with anything else"* — and note the shape: **the commit that was cleared is not the commit that landed.** A clearance covers a described file set; the landed diff was wider. No harm this time, but that is precisely how an unreviewed change rides in on a cleared one.
**This is a structural cost of N implementers sharing one working tree at this parallelism, not five separate mistakes** — the strongest argument yet for per-area worktrees or serialized commits at close-out.

**Same root as the mutation-window rule** ([L75](#75)): a shared tree has more shared state than the files themselves — the index and the working tree are both global, and every agent's normal, correct workflow perturbs them. **Neither of these was a discipline failure; both were structural.** Expect them whenever N implementers share one checkout.

### ⭐ THE PROCEDURE — three checks, and the third is the one that caught it

Per-file `git add` is **necessary but not sufficient**. It does not protect against **(a)** files already in the index before you add, or **(b)** the index changing between your `add` and your `commit`. What actually worked, from three occurrences in one session (another area's session doc in the staging area · an index reset between `add` and `commit` · a foreign session doc inside a commit despite staging exactly one file):

1. **BEFORE** — `git diff --cached --name-only`, immediately before committing. Verify the exact set.
2. **DURING** — chain `git add … && git commit …` in **ONE invocation**, so nothing can land between them.
3. **AFTER** — `git show --stat`, immediately after. **Catch what still got through.**

### ⭐ AMENDMENT 2026-07-29 — the working tree is a moving target for READERS too, not just writers

L83 above is about the index as shared state for the agent *writing* a commit. The same tree is shared state for anyone *reviewing* — and that produced three framing errors in one day, all at lead level, all with the same mechanism.

The sharpest instance: a reviewer checking whether 9.22 had touched all three of its sites read `boot.ts` **after** the implementer's edit (their quoted line numbers `:543`/`:588` reflect the edited file) and `egressRevoke.ts` **before** it — then reported the third site as untouched and asked for it to be sent back. The implementer had in fact already derived it correctly.

> **The proof that the read spanned two states was self-contained: the reviewer quoted a comment as evidence of absence, and that comment had been deleted by the very edit they were looking for.** A file cannot both contain a line and not contain it, so the two observations came from different snapshots.

**Why this is worse than an ordinary stale read.** It arrives as a *finding*, with file:line evidence attached, addressed to whoever can act on it — so it is maximally likely to be relayed. Had it been forwarded, a correct implementation would have been sent back for rework mid-slice, and the "wrong instruction in a close-out" hazard would have fired with the reviewer's authority behind it.

**Mitigation, and it is one line: while an implementer is mid-slice, review the COMMITTED diff, not the live working tree.** `git show`/`git diff <base>..<head>` are immutable; `git status` and a file read are not. If you must read the live tree, take every observation in **one** command invocation so they share a snapshot, and say which snapshot in the report. Same discipline as the mutation window ([L75](#75)): record the tree state beside the observation.

**Corollary for the relaying orchestrator:** verify a review finding against the tree yourself **before** forwarding it, exactly as you would verify a brief premise ([L81](#81)). Three times in one day the thing that prevented rework was checking first — and the cost of checking is one `git diff`.

### ⭐ IT APPLIES TO TEST RUNS TOO — a monorepo suite run mid-slice measures somebody else's work-in-progress

Same day, third manifestation. A `/session-end` reported *"one unrelated pre-existing failure elsewhere in the monorepo (apps/desktop electron-vite bundle test)."* Honestly reported; they saw it. **It does not reproduce:** on clean committed HEAD, `apps/desktop` is **58/58 files, 483/483 tests green, including `test/bundle/main-bundle-resolution.test.ts`.**

The cause is this lesson's mechanism wearing test-runner clothes: they ran the monorepo-wide suite **while another area was mid-slice with uncommitted files.** The failure was real *in the tree at that moment* — and it was that area's work-in-progress, not a property of HEAD. **A cross-area test result taken mid-slice attributes another agent's incomplete work to the repository.**

⚠ **That makes THREE reported reds in one round, none reproducible at committed HEAD** — an inherited `@sow/db` migration failure, a repo-wide `lint` failure, and this. Each was reported in good faith by someone who genuinely observed it; none was about the repo. **In a shared tree with N live agents, "I saw a failure" and "the repository has a failure" are different claims**, and only one of them survives a re-run on a clean checkout.

**Do:** scope your `/session-end` verification to **your own package** (which every implementer here did correctly), and treat any cross-area red as **REPORTED, NOT VERIFIED** until re-run on a clean tree. If you must report one, say which tree state you measured. **The orchestrator's own handling is the pattern to copy: deferring the verification until the other area's source was committed, rather than either repeating the claim or dismissing it.**

> **Step 3 is the one that matters.** In the third occurrence a commit had *already* silently carried another area's session doc; it was caught only by checking afterwards and corrected with `reset --soft` + unstage + re-commit. **Steps 1 and 2 reduce the odds; step 3 is what tells you they failed.** Without it, the mis-attribution is discovered by whoever audits the hash months later, if ever.

A recovery via `reset --soft` is safe and correct here — it is *not* history rewriting, since the commit has not been shared. That is a different thing from rebasing a pushed or teammate-visible commit, which stays forbidden.

`accepted: not mechanically enforceable` — mitigation: the three-check procedure above; pathspec-limited commits as the default; `git status` before believing a red in a package you did not touch.

---

<a id="84"></a>
## 84. A green suite under a mutated guard has TWO readings — unasserted, or unreached — and they demand different fixes

**2026-07-28 · task #40 (E1) · evalsec, mutation-verified**

The §12 approval-exactly-once eval — **a phase-exit-8 DoD criterion** — was suspected of running on a CAS fake that lacked the real repository's terminal-state guard. The prior round wrote the conclusion *"delete that branch in production and the eval stays green"* into the round seal **as fact**, then corrected itself at the seal: three of E1's four claims were read off the source, the fourth was not, and all four had been stated at one strength.

So it was **executed**: the terminal branch was removed from `packages/db/src/invariants/operational-truth.ts:254-267`, the §12 suite run, and it stayed **3/3 green**. Branch restored; `git status --porcelain packages/db/` clean.

**The claim was true. The obvious reading of it was wrong.**

> The tempting conclusion is *"the eval fails to ASSERT the guard."* The actual finding is stronger and different: **the eval's call graph never REACHES that code at all.**

**Why the distinction is not academic — it changes the fix:**

| Reading | What's wrong | What fixes it | What "fixing the assertion" achieves |
|---|---|---|---|
| **Unasserted** | The suite drives the real code but doesn't check this property | Add the assertion | Closes it |
| **Unreached** | The suite never executes the real code | Make the suite drive the real code | **Nothing about the real code** |

Under the unreached reading, adding assertions to the stand-in is still correct work — it removes drift, and #40 did it — but it must not be recorded as closing the coverage gap, because the real function remains uncovered by that suite either way. That is why #40 shipped **and #44 stayed open**.

**Relation to [L75](#75).** L75 governs false greens in the *simulation* — the compromise never landed, or landed where no test fed it the triggering input; its remedy is fail-first ("see the guard FAIL before you trust it passing"). This is the **opposite corner**: the compromise genuinely landed, the suite genuinely stayed green, and the open question is what that green *proves*. L75 tells you the measurement is real. L84 tells you a real measurement still has two readings.

**Relation to [L80](#80).** L80's test is *"replace the gate with a constant DENY — would anything go red?"* This one is *"delete the gate — would anything go red, and if not, which of the two reasons is it?"* L80 catches a gate that stopped deciding; this catches a suite that was never watching.

**Do:** when a mutation leaves a suite green, determine which reading applies *before* writing the fix — cheapest discriminator is whether the suite's imports reach the mutated module at all. Then state the reading in the report, and name the test that WOULD have gone red. Do not let "we fixed the guard" stand in for "the code is now covered."

`pin: packages/db/test/invariants/operational-truth.test.ts` (30/30 — the only thing that actually pins the real `decideApprovalCas`; treat it as load-bearing) · `accepted: not mechanically enforceable` (mitigation: record which reading a green-under-mutation supports, plus the count per L75).

---

<a id="85"></a>
## 85. A fake that mirrors a real guard covers the fake — mirroring buys discrimination, never coverage

**2026-07-28 · task #40 residual → #44 · raised by the implementer at Step 9**

The #40 fix made the eval's fake CAS enforce the terminal-state rule, importing the **real** `isTerminalApprovalStatus` from `@sow/db` rather than re-declaring the status set — so the two cannot drift. That is the right fix and it is genuinely better than a duplicated literal ([L39](#39)'s single-sourcing, applied to a test double).

**And it does not make the suite cover `decideApprovalCas`.** A future regression in the *real* function stays invisible to that suite, because the suite still executes the double.

> **Mirroring a real guard's semantics buys discrimination for the double's own logic. It buys nothing about the code the double stands in for.**

**Why this is easy to miss, and why it matters more than the original defect:** "the fake was missing the guard; we added the guard" reads as a closed loop. Both halves are true, the suite goes green, and the finding gets ticked. What actually changed is that the fake stopped being *wrong*; nothing changed about what the suite *watches*. So the remaining exposure is now harder to see than before the fix, because the obvious symptom is gone — the [L82](#82) hazard arriving through a legitimate repair rather than a re-pointed claim.

**Corollary — know which test is load-bearing.** Once a criterion is nominally covered by a suite running a double, the real assurance lives somewhere else entirely; here `packages/db/test/invariants/operational-truth.test.ts`. That file is the only thing between a real regression and a silently-passing DoD criterion, and nothing in the eval suite's name or output says so. Name it, in the suite and in the plan.

**Do:** when a double is corrected to match production, state explicitly what the suite covers *after* the change (usually: unchanged), and where the real code is actually pinned. Where a real adapter exists, prefer driving it — a double is for what you cannot reach, not for what is merely inconvenient to wire.

`pin: packages/db/test/invariants/operational-truth.test.ts` · `accepted: not mechanically enforceable` (enforcement point: `/tdd` Step 9 — a "fixed the fake" flag must state the post-fix coverage, not only the drift closure).

---

<a id="86"></a>
## 86. A refusal channel is only real once a refused run is distinguishable from an empty one on EVERY exit path — including the paths that reject afterwards

**2026-07-29 · 13.8m-A producer + 13.8m-B consumer · knowledge + worker**

The whole point of a refusal channel is that *"we refused something hostile"* stops being byte-identical to *"there was nothing to do."* The subtlety is that this is a property of **every** exit, not of the happy one.

The producer got there first: `rewriteVaultForSource` hoists its `refusals` accumulator **above the `try`** (`ingest-rewrite.ts:112-115`) and includes it on the fail-safe `empty()` receipt (`:116`), with the reason stated in-code — *a fault AFTER admission must not discard what was already refused, or a hostile run that hijacks paths and then trips a throwing port becomes byte-identical to a benign empty one.*

The consumer had the same shape one layer up. `createLivingVaultPort` can reject **after** the receipt is read — `path_escape`, a WS-8 mismatch, an unresolvable vault root. So the audit fires **once, immediately after the receipt, before root resolution and the containment loop**; a refused-then-rejected run still surfaces its codes.

> **Ask of any refusal/audit channel: enumerate every `return` between the refusal and the caller, and check that each one still carries it.** A channel that only survives the success path documents the case nobody attacks.

**Supporting constraints, all load-bearing:**
- **Code-only, always.** `GroundedPathRefusal` is a closed two-member union (`"structural_surface" | "unsafe_shape"`). A channel carrying the refused *path* would become the exfiltration route it exists to report (rule 7). A count is fine; a path, title, or entity name is not.
- **Best-effort at the sink, never at the accumulator.** A throwing/rejecting sink must not alter the returned `Result` and must not escape as an unhandled rejection (L25's terminal-sink rule). But the *accumulation* is not best-effort — that is the part hoisted above the `try`.
- **A benign run must invoke the sink ZERO times.** Firing on every run destroys the distinction from the other direction, and it is the easier mistake to make.

**Known bound, recorded rather than hidden:** `refusals` is OPTIONAL on the worker seam so the 13 pre-existing containment-test fakes stayed valid (L11-style degrade). The consequence is that a *future* adapter can omit it and the sink silently never fires. Acceptable only because the single production producer always forwards the required receipt field, pinned by `adapter_forwards_refusals_verbatim` — and **the bound is stated in the type's doc comment**, scoped the way 13.8k's module header scoped its invariant. An unqualified "refusals are surfaced" would have been the overclaim.

⚠ **Scope discipline that mattered more than the code:** the plan recorded this channel as landing on **both** synthesis receipts. It landed on **one** (`ingest-rewrite.ts:97`); `MeetingRewriteReceipt` has no refusal field at all (`meeting-rewrite.ts:95-112` — `groundedPaths` is the *admitted* set). Briefing the false claim would have sent an implementer after a field that does not exist, and shipping it as "refusals now reach the operator" would have left the meeting path byte-identical between a poisoned run and an empty one — **the original defect, silently half-closed, on an `§ARM-RESEARCH` arming precondition.** Caught by reading the receipts before authoring the brief.

`pin: apps/worker/test/living-vault-refusal-audit.test.ts (refused_then_containment_rejected_still_surfaces + benign_empty_run_invokes_no_sink)` · `pattern: grep -n "return err(" apps/worker/src/composition/living-vault.ts` — per hit, ask whether the refusal already fired.

---

<a id="87"></a>
## 87. Close a structurally-satisfiable safety type with a NOMINAL brand — and give the genuine candidate boundary its own UNBRANDED type

**2026-07-29 · 9.34 (`d7a9b170`) · desktop**

`CopilotTurnView.reply` and `CopilotAnswerView`'s prop were typed `UiSafeCopilotAnswer`. TypeScript is structural, so **any object of the right shape satisfies it** — and because the rule-5 disclosure field `egressProcessor` is `.optional()`, a hand-built literal omitting it compiled cleanly and **silently dropped the disclosure**. The type asserted "this was validated" while accepting anything shaped like it.

Fixed with a **nominal brand**: `AdmittedCopilotAnswer = UiSafeCopilotAnswer & { readonly [uniqueSymbol]: true }`, mintable only by the exported `admitReply()` (which casts internally, after `.safeParse`). Both chokepoints now require the branded type, so `reply:` is **uninhabitable by a hand-built literal**.

⭐ **The half that makes it honest, and the half that is easy to skip: a SEPARATE unbranded `CopilotTurnSeed` for the mount-time seed prop.** That boundary genuinely receives unvalidated candidate data. Branding it — or casting into the brand there — would have made the brand assert something false at exactly the point it matters. So the candidate boundary keeps a candidate type and is admitted *internally*, at the door that actually validates.

> **A brand is a claim about provenance. If you find yourself casting into it at a boundary that has not validated, the boundary needs its own unbranded type — not a cast.**

**Verification notes worth reusing:**
- **RED for a type-level pin is a `@ts-expect-error` that goes UNUSED.** Both pins compiled without error pre-brand, so the directive became unused and **typecheck went RED**. That is a real red-green cycle on a purely static change.
- **Both reviewers independently mutation-tested it** by aliasing `AdmittedCopilotAnswer` back to the bare contract type and confirming the directives fail — L75 applied to a type-level guard, where the instinct to skip simulation is strongest because "it's just types."
- **No contract change.** The brand is a renderer-local nominal type *over* the existing `UiSafeCopilotAnswer`; the shared model is untouched, so this is not a frozen-contract round.

`pin: apps/desktop/test-dom/copilot-panel.test.tsx (two @ts-expect-error pins + admitReply renders + CopilotTurnSeed still accepts a plain literal)`.

---

<a id="88"></a>
## 88. Single-sourcing is for literals that must AGREE — two caps bounding different THREAT MODELS must stay independent

**2026-07-29 · 13.8h (`bed423cb`) · knowledge**

13.8h's own `Done-when` said *"keep the cap a single shared constant so a caller-side and planner-side cap can't drift."* That was **overridden deliberately**, and the reasoning generalizes past this slice.

`meeting-rewrite.ts`'s `MAX_ENTITY_REFS` bounds **deterministic input the meeting path owns**. The new `MAX_MODEL_ENTITY_REFS` in `planner.ts` bounds **adversarial model output** — a degenerate REASON emission driving an unbounded sequential GBrain read loop. Both are `200` today, so sharing looks free.

It isn't: **coupled, a future tuning of one silently retunes the other's threat model.** Someone raising the meeting cap for a legitimate large-attendee meeting would, without knowing it, widen the adversarial fan-out bound. The values coincide; the *reasons* do not.

> **L5/L37's single-sourcing rule applies to a literal that must AGREE with another** — a grammar, a path convention, a matcher, an enum both sides parse. It does **not** apply to two values that merely happen to be equal. Ask: *if one of these changed for its own reason, must the other change with it?* If no, they are different constants that happen to share a number, and merging them couples two decisions that should move independently.

**So the discipline is symmetric, and both directions have bitten this project:** a duplicated *matcher* diverges silently and the fix is to single-source it (L39, and the `branch`-literal duplication in the L75 amendment). A shared *policy threshold* couples unrelated decisions and the fix is to split it. Naming and an in-code note are what keep the split from reading as an oversight — here the comment states the decoupling explicitly, precisely so the next reader does not "helpfully" merge them.

⚠ **A plan's `Done-when` is a hypothesis too** (L81 applied to the tracker rather than the brief). This one was written before anyone had looked at whether the two caps shared a reason, and a circular import (`meeting-rewrite` → `planner`) made sharing infeasible regardless. **The divergence is recorded on the task itself**, because a shipped implementation contradicting its own recorded Done-when is exactly what a later reader "fixes."

`pin: packages/knowledge/test/synthesis-planner.test.ts` (cap asserted via the ACTUAL GBrain call count, not the reported number — the property, not the mechanism, L70) · `accepted: not mechanically enforceable`.

---

<a id="89"></a>
## 89. A gate named for a check it does not perform is worse than an absent gate — its passing is read as evidence

**2026-07-29 · found while verifying an implementer's close-out claim · measured, not inferred**

An implementer's `/session-end` reported that repo-wide `pnpm lint` **fails** ("eslint binary not found"). Running it produced the opposite result — and the opposite result is the worse one:

```
pnpm lint  →  Tasks: 11 successful, 11 total   exit 0
```

Then what it actually runs:

- **Every** package's `lint` script is **`tsc --noEmit`** (`@sow/desktop`'s is three `tsc --noEmit -p …` invocations).
- **ESLint is not installed** — no `node_modules/eslint` — and **has no config anywhere**: no `.eslintrc*`, no `eslint.config.*`.
- **No package defines `format:check`**, nor does root, so `pnpm format:check` fails as an unknown script.

⇒ **`pnpm lint` is `pnpm typecheck` wearing another name.** Every `/preflight clean` and `lint clean` claim in this project's history means *"typecheck passed."* **There has never been any lint coverage at all.**

> **The failure mode is not that the gate is broken. It is that the gate PASSES.** A broken gate gets fixed the first time someone runs it. A gate that passes while checking nothing it claims to keeps producing green, and that green is consumed as evidence — by implementers reporting Step 9, by orchestrators approving ships, and by every round seal that wrote "preflight clean."

### ⛔ CORRECTION TO THIS LESSON'S OWN FIRST DRAFT — it was NOT undiscovered, and that makes it sharper

My first draft called this defect **invisible** and framed it as newly found. **Both were wrong**, and the truth is worse. `IMPLEMENTATION_PLAN.md` `#### Residuals (1)` carries **three** bullets on it, since **2026-07-26**, and one of them already states the consequence in almost these words:

> *"`/preflight` currently CLAIMS a lint gate it does not run — every `lint` script is `tsc --noEmit`, and there is no root `format:check` at all, so `/preflight` steps 2-3 are structural no-ops. **A gate that reports success without executing is the same false-assurance shape as this round's four rule-5 findings (contracts L56), one layer up in the tooling.**"*

So it was found, the consequence was stated, **the correct lesson-analogy (L56) was already drawn**, and it was re-confirmed by a second area during a later slice. Then a whole round of us — five implementers, an orchestrator, a lead — went on reading "lint clean" as evidence, and I re-discovered it as novel.

⭐ **THE ACTUAL LESSON, which is not the one I first wrote: recording a defect does not stop its false signal from being believed.** A finding in a file competes with a green check in a terminal, and the green check wins, because the green check arrives at the moment of decision and the file does not.

⭐ **And the mechanism is specific and procedural.** That bullet's own text says it was *"moved out of Carry-forward 2026-07-26 — phase-owned tooling debt, not next-1-2-brief working set."* **That move was procedurally correct and it is what stopped the item being read.** Carry-forward is triaged every `/orchestrate-end`; phase `Residuals` are not. So the item went from a surface with a recurring reader to a surface with none — de-prioritized exactly as the format contract intends, and thereby removed from every subsequent round's attention. **Correct bookkeeping produced the blind spot.** (The lead independently recalled it as *"Carry-forward item 7"* — a stale-location memory that is itself evidence of the move.)

**So the transferable rules are two, not one:**
1. **A gate's green must be earned by the gate, not by its name** — the original finding.
2. **When you de-prioritize a defect out of the actively-triaged set, its false signal keeps firing at full strength.** Either retire the signal at the same time (rename the script, or make `/preflight` announce "lint = typecheck only"), or accept that the record will not be consulted. **Moving a known false-green out of the working set without disarming the false green is the trap.**

**Where the false claim was documented, which is what made it durable:** root `CLAUDE.md`'s stack table lists `Lint | ESLint`; all six area `CLAUDE.md` files carry a "Standard commands" block advertising `pnpm lint` and `pnpm format:check`; `/preflight` composes `lint && typecheck && test`. **Six documents describe a tool that is not installed** — the same *three-surfaces-agree-one-has-it* shape recorded for the approval terminal guard, arriving in the toolchain instead of the code. ⚠ **A seventh document — the plan's own `Residuals (1)` — described it CORRECTLY, and lost to the other six**, which is the correction below.

**Relation to [L80](#80).** L80 asks *"if I replaced the gate with a constant DENY, would anything go red?"* This is the mirror: **a gate that is a constant ALLOW for the property it names.** Both are gates that have stopped deciding; a constant-DENY gate at least announces itself by blocking, while a constant-ALLOW gate is silent forever. **Relation to [L82](#82):** this is a false coverage claim, and the disposition rule applies unchanged — make it true (install and configure the linter) or retract it (say plainly that `lint` means typecheck). ⛔ **Do not re-point it at "well, typecheck is a kind of linting"** — that is L82's forbidden middle.

**Do, for any gate you rely on:** run it once and read **what it executed**, not whether it passed. For a composite gate (`lint && typecheck && test`) confirm each leg runs a *distinct* tool — two legs invoking the same binary means one leg is decoration.

**Provenance, corrected to what was actually established** (the first draft's version of this paragraph was itself imprecise, so it is restated rather than patched): an implementer's `/session-end` reported repo-wide `pnpm lint` **and** `pnpm format:check` as *both* failing, "verified pre-existing via `git stash`." Running `pnpm lint` at root gave a **pass**, which is what prompted the investigation. On being asked what they ran, the implementer **reproduced and isolated it themselves**: `pnpm lint` / `pnpm run lint` genuinely fail **in their session** with `Command "eslint" not found`, while `npx turbo run lint` — the same underlying task — passes with `11/11 successful`. So the repo-side facts are as recorded above; the "both fail" was an artifact of one command string, honestly retracted.

⚠ **WIDENED SAME DAY — "session-local" was my word and it was too narrow.** A **second** implementer independently hit the same thing: `pnpm lint` throwing a harness-level JSON-parse wrapper error, worked around by invoking the underlying `tsc --noEmit` directly and finding it clean. **Two of five implementer sessions, and zero occurrences from the orchestrator session at repo root.** So it is not one agent's fluke — it is something about how the implementer sessions invoke that command string, still unexplained, and **it means implementers cannot run the composite gate at all** (they have been running the legs directly, which is why nobody's scoped preflight caught it either). ⛔ The repo-side facts do not move; what moves is my characterisation, and *"artifact of one session"* → *"reproducible in implementer sessions, cause unknown"* is a different claim with a different follow-up. Recorded rather than smoothed, because the narrow version would have closed the question.

⭐ **The reusable half of that exchange:** their `git stash` check *felt* like verification and proved the wrong thing. **Re-running a failing command with your changes removed proves the failure is stable — not that it is about the repository.** A stable observation of a local artifact is indistinguishable, by that check alone, from a real defect. Same family as [L71](#71): the verification did not cover the diagnosis. **When a tooling claim arrives second-hand, run it yourself** — and when your own environment disagrees with a teammate's, suspect the invocation before the repository.

⛔ **Recorded, not fixed** — installing ESLint across 11 packages and triaging its first run is a new arc, forbidden by the round's teardown boundary. Deliberately left visible rather than quietly patched, per L82: an uncovered gap invites work; a false-green one closes the question.

`pattern: [ -d node_modules/eslint ] || echo "WARN: lint gate claims ESLint; ESLint is not installed"` · `accepted: not mechanically enforceable` until the gate is made real.

---

<a id="90"></a>
## 90. A non-vacuity guard must be satisfied by the test's SUBJECT, not by the environment — delete the feature and see if the guard still passes

**2026-07-29 · #8, the round's final slice · both halves self-caught by the implementer**

#8's `no_naming_attribute_overclaims` sweeps `aria-label` / `aria-labelledby` / `aria-describedby` / `title` on the egress-posture subtree for banned claim tokens. Knowing that a filter-then-assert-nothing-matched test passes vacuously over an empty set ([L54](#54)), the implementer added a non-vacuity check: *assert the attributes exist.*

⚠ **The non-vacuity guard was itself vacuous.** Pre-existing, unrelated `aria-label`s elsewhere in the page satisfied "attributes exist" — so **the test would have passed while never touching the new pill at all.** It guarded the DOM's general habit of having labels, not this feature's labels.

> ⭐ **The check that finds this: delete your feature entirely. Does the non-vacuity guard still pass?** If yes, it is anchored to the environment, not to your subject — and "something matched" was never the same claim as "the thing I am testing matched."

Fixed by giving the pill **its own populated `title`** (the scope sentence) and anchoring non-vacuity to *that specific node's* attribute, so the guard cannot be satisfied by anything the feature doesn't own.

**The second half, same slice, same instinct.** They had confirmed the banned-token regex **passes on clean text** — but not that it **fires on a real restoration**. That is [L75](#75) landing on the pin that guards this round's signature defect: a negative pin verified only in the state where it should be silent. Closed by reintroducing `"nothing leaves this machine"` into the rendering and confirming **four** tests caught it.

**Why this pair is the right note to end a round on:** every earlier instance this round was found by someone *else* — a reviewer, the orchestrator, the lead. These two were found by the author, on their own tests, by asking what their guard would fail to notice. **That is the only version of this discipline that scales**, because the reviewer who would catch it is reading the assertion and finding it reasonable — which it is. The defect is never in what the assertion says; it is in what satisfies it.

**Do:** for any guard added to prevent a vacuous pass, state what anchors it to the subject. For any negative/absence pin, verify it FIRES on a genuine restoration, not merely that it is quiet on clean input. Both are single extra runs inside the slice.

`pin: apps/desktop/test-dom/egress-settings-page.test.tsx (no_naming_attribute_overclaims, anchored to the pill's own title; banned-token regex mutation-verified against a real restoration)` · `accepted: not mechanically enforceable`.

---

<a id="91"></a>
## 91. A clearance that stops at the routing layer is indistinguishable from a clearance never given — whoever imposes a hold owns releasing it

**2026-07-29 · the round's last slice · orchestrator's own failure, caught by the lead**

#8 was rule-5, so the lead asked that its Step-10 commit **hold** until they cleared the Step-9. I relayed that hold to the implementer. The lead then cleared #8 — to **me**, since the lead does not DM implementers.

I did not pass it on. I spent the next three commits banking lessons, and **the team stalled**: the implementer sat idle, correctly obeying a hold I had imposed and then failed to lift, with their slice complete and their files uncommitted.

> **From the implementer's side, a clearance that stopped at the relay is byte-identical to a clearance never given.** Everyone waits, nobody is blocked by anything real, and **no signal anywhere reports a problem** — the same false-green shape this round spent itself closing, relocated from the code into the coordination layer.

**Two actionable halves, both mine to have known:**

1. **Imposing a hold creates a blocking edge, and the holder owns releasing it.** "Hold until X clears" makes the *relay* of X load-bearing. I added the dependency and then treated the message carrying its release as ordinary correspondence rather than as the thing a teammate was parked on.
2. **The status board would have shown it, and nobody read it.** The task sat `in_progress` with an idle owner and a dirty tree — visible the entire time, to **both** the orchestrator and the lead. The orchestrator was reading its own commit queue; the lead was reading idle-notifications as *normal quiet*. **Two roles, the same status channel available to each, neither looking at it.** So this is not one agent forgetting a check — it is that **nothing polls the board**, and both parties were consuming event streams instead of state.

### ⛔ WHO ACTUALLY CAUGHT IT, and why that is the finding

**The owner did — by noticing every pane had gone quiet.**

Not the orchestrator. Not the lead. Not `TaskList`. Not a heartbeat, not `/context-check`, not a tier threshold. **The entire monitoring apparatus reported normal while nothing moved for twenty minutes.**

> ⭐ **A stall is the only failure mode whose signature is the ABSENCE of a signal.** Every other defect this round announced itself — a red test, a failing gate, a contradiction between two documents, a mutation that stayed green. **A stall announces itself as calm.** Our instrumentation detects events; it has nothing that watches for the absence of events, and an idle notification is byte-indistinguishable from "correctly finished and nothing to do."

That the detection method which worked was *a human noticing an absence* is precisely the method a governed autonomous system cannot rely on. **Recorded as an unmet monitoring gap, not as a save.** The concrete shape of the missing check: *is any task `in_progress` whose owner has been idle longer than a slice takes, with uncommitted files in its territory?* — a question the existing data answers and nothing currently asks.

⚠ **The uncomfortable detail, kept because it is the useful part:** the lessons I was writing during that window were [L90](#90) — *about a guard that passes while checking nothing.* The lapse and the lesson occupied the same twenty minutes. **Knowing a failure mode in the abstract does not make you notice it in your own workflow**, which is the entire reason these are written as mechanical checks rather than as things to be mindful of.

**Do:** when you impose a hold, track it as an open obligation on yourself, and release it before any other work. In a team pattern where one role is the only channel between two others, **the relay is a critical path, not correspondence.** And read the board, not your own queue, when deciding whether anyone is waiting.

`accepted: not mechanically enforceable` — mitigation: an imposed hold is written down as an owed release (the same rule as [L51](#51): if it only lives in your head or in a message, it is not tracked); check `TaskList` for `in_progress` tasks with idle owners before starting unrelated work.

---

<a id="92"></a>
## 92. A certified phase's acceptance statement is IMMUTABLE — new work anchored to its spec goes to an ACTIVE phase; the Spec anchor carries traceability, the placement carries ownership

**2026-07-29 · §DEC-CANDGATE leg 1 (task 13.18) · orchestrator proposed, lead ruled**

Scheduling the twice-deferred §DEC-CANDGATE arc needed a numbered tracker home. Its anchor-native one was obvious: the slice adds a `packages/contracts` model, and **Phase 1's Spec anchors are exactly `§3 · Appendix A · §16/REQ-S-006`.** So `### 1.16`.

Phase 1 is `✅ done · CLEAR 06-30`, and its acceptance line reads **`- [x] DONE · a039e86e · phase-certified`** followed by *"All 1.X checkboxes ticked."*

I noticed adding an unticked `### 1.16` would flip a `✅` row the owner reads, judged that not mine to do quietly, and surfaced it instead of absorbing it. **That instinct was right and the reasoning behind it was too small.**

> **The lead's ruling: a phase certification is an AUDIT ARTIFACT, not a status field.** Adding an unticked task under an acceptance line asserting *"All 1.X checkboxes ticked"* does not just flip one `✅` — it **retroactively redefines every past certification in the project** to mean *"complete, except for whatever we added later."* That integrity loss is far larger than a phase-boundary smudge.

**And the objection that made Phase 1 look necessary dissolves once placement and anchoring are separated.** They are different things:

- **The `Spec:` anchor carries TRACEABILITY.** 13.18 still declares `§3 · Appendix A · §16/REQ-S-006`, so `/phase-exit`'s auditor reads those anchors and the audit surface follows the task wherever it sits.
- **The phase carries OWNERSHIP** — who works it, which round closes it, whose gate it blocks.

So the task went to **Phase 13** (active, and where all four instances of the defect arose) with `spec-lint`'s sanctioned **`widens phase scope because…`** declaration. Traceability preserved, certification honest, nothing smudged that matters.

⚠ **The near-miss worth naming:** the alternative I nearly took would have been *locally* correct on every rule I could see — right anchors, right package, right phase for the spec — and would have quietly damaged an audit trail spanning fourteen certified phases. **A rule that is right about one row can be wrong about the artifact the rows compose into.**

**Do:** new work whose spec anchors point into a **certified** phase goes to an **active** phase, declaring the scope widening explicitly, and records why in-task so it is not re-litigated. Never add an unticked checkbox under a `[x]`-certified acceptance statement. If no active phase can own it, that is an escalation, not a certification edit.

`pattern: awk '/^### Acceptance criteria/{a=1} a&&/^- \[x\]/{c=1} /^## Phase/{a=0;c=0} c&&/^- \[ \]/{print FILENAME": unticked task under a certified acceptance line"}' IMPLEMENTATION_PLAN.md` — the real fix is a `plan-lint` rule (recorded as a scaffolding follow-up); until then this grep is the check.

---

<a id="93"></a>
## 93. Code citations in durable prose fail in BOTH directions — they rot silently, AND a wrongly-scoped audit condemns healthy ones. The audit is the more dangerous half

**2026-07-29 · three candidate instances in one round; ONE of them was a false positive**

Durable prose in this project cites `file.ts:NN` constantly, and **nothing lints those citations.** This round produced what looked like three instances of them rotting. It was two — and the third taught more than both.

**The two real instances (rot):**
1. **[L69](#69)** cited `:83`/`:178`; both had drifted. Found by an implementer reading the file while briefing 9.22 — *"an L71 instance inside L69."*
2. **`IMPLEMENTATION_PLAN.md:90`** (the §DEC-CANDGATE ledger) cited `planner.ts:180-182` and *"consumed at `:197`"* — both stale post-13.8h, **inside the paragraph written explicitly for whoever picks the arc up cold.** Corrected to `:197-200` and `:220`.

**The false positive, and why it is the dangerous direction:**

A premise-check reported that **[L49](#49)** cites a `ZOD_BY_ID` registration and membership-guard rows that **do not exist anywhere.** Grep confirmed: zero hits. The conclusion drafted into a brief was *"follow the code, not L49's stale prose."*

**L49 was correct.** `ZOD_BY_ID` lives in `packages/domain/test/fixtures/fixtures.test.ts`; the membership rows in `packages/contracts/test/primitives/shared.test.ts`. The search had covered only `packages/contracts/src` and `packages/contracts/test`, found nothing, and **generalized "not in this package" to "does not exist."**

> ⭐ **The search reproduced the exact blind spot the lesson exists to close.** L49's whole content is *"a new Appendix-A model's checklist reaches OUTSIDE `packages/contracts`, and missing the fixture/`ZOD_BY_ID` breaks the DOMAIN meta-test, not the contracts suite — **green-in-contracts ≠ done**."* An audit scoped to `packages/contracts` was **guaranteed** to declare that lesson stale.

**Had it shipped:** an implementer would have followed the brief, landed a fully green `packages/contracts`, reported clean, and left `@sow/domain` red with a half-frozen seam — **L49's precise failure mode, caused by a brief that cited L49 while contradicting it.**

⚠ **The two directions demand opposite responses, which is why one-directional framing makes the next reader worse:**

| Direction | What it looks like | Wrong response it invites |
|---|---|---|
| **Rot** (L69, plan:90) | citation points at moved/absent code | *"trust cited lessons less"* |
| **False positive** (L49) | audit says a HEALTHY citation is stale | *"delete the guard the citation defends"* |

Loosening trust in cited lessons is the natural reaction to rot — and it is exactly what would have made instance 3 land. **A citation that fails to resolve is a question, never a verdict.** Ask *"did I look everywhere it could live?"* before *"is the prose wrong?"* — and for this project the answer is usually another package, because the seams deliberately span them.

### ⛔ THE NAMING VARIANT — a TEST NAME that overstates its scope misleads the next reader of the test, not its author

**Same day, found while reviewing 13.18's Step 2.5.** `packages/domain/test/fixtures/fixtures.test.ts:128` is named:

> `"provides exactly one VALID fixture for every registered Appendix-A schema"`

Its mechanism (`:129`) is `const registered = [...defaultSchemaRegistry.ids()]`, and `defaultSchemaRegistry` is an **unconditional glob** over `schemas/*.schema.json` (`packages/contracts/src/schema/registry.ts` `loadSchemasFromDir`). **There is no Appendix-A filter.** The name asserts a narrowing the assertion does not perform.

**It caused a real error the same day.** I read the name, inferred that [L49](#49)'s new-model checklist attached only to Appendix-A models, and wrote that conditionality into brief 219 and task #3's description. The contract implementer traced the registry in source and overturned it: the checklist is **mandatory the moment a schema file exists**, because the meta-test measures against the glob. Had the conditional been followed, `packages/contracts` would have gone green with `@sow/domain` red — L49's exact failure mode, produced by a brief that cited L49.

⭐ **Why this earns its own line rather than folding into the citation rule: an overstated name is INVISIBLE TO ITS AUTHOR and load-bearing for everyone else.** The author knows what the assertion does — they wrote it — so the name never misleads *them*, and no test failure will ever surface the gap. It misleads the **next** reader, who has only the name and a reasonable expectation that it describes the mechanism. **A name is documentation with none of documentation's review.**

⇒ **A test name is a claim about scope. If it names a filter, the assertion must perform that filter.** When they disagree, fix the **name** — the assertion is usually the correct half, and renaming is free.

**Do:** read the assertion before inferring a rule from a name. When writing one, prefer a name that **under-claims** (`every registered schema`) to one that over-claims (`every Appendix-A schema`) — the honest name costs nothing and the flattering one costs someone a wrong inference. The rename itself is in Carry-forward, deliberately not done: another area's test file, and renaming a passing test mid-round is churn.

**Do:** before declaring a citation stale, search the **whole repo**, not the package the symbol seems to belong to. When correcting one, land **one** number in **every** place it appears (a half-corrected citation is a new instance). And when a premise-check contradicts a lesson, the lesson gets the benefit of the doubt until the search is proven exhaustive — the lesson was written by someone holding the code.

⛔ **Deliberately NOT done: a repo-wide citation sweep.** It is task 24.6's territory and out of scope this round — and this lesson's own content argues a cheap sweep would produce false positives faster than fixes.

`pattern: grep -oE '[a-zA-Z0-9_/.-]+\.ts:[0-9]+' packages/*/LESSONS.md` — then verify each path exists and has ≥ that many lines. ⚠ **States its own limit: this catches a citation pointing past EOF or at a deleted file; it CANNOT catch a line that still exists but now says something else, which is the common case (both real instances this round).** The stronger form is citing a stable symbol name alongside the line number so a reader can re-locate it after drift.

---

<a id="94"></a>
## 94. A correction must land in EVERY channel that carries the claim — and channels rank by what a stale value CAUSES, not by how authoritative they look

**2026-07-29 · the orchestrator's own failure, three times in one correction, while writing the lesson about it**

I retracted a wrong finding (that [L49](#49) was stale — see [L93](#93)) and fixed brief 219. I then told the lead the correction had landed. **It had landed in one channel of four.**

| Channel | State after my "fix" | Found by |
|---|---|---|
| brief 219, correction-3 section | ✅ corrected | me |
| task #3 **metadata** | ✅ corrected | me |
| task #3 **description** | ⛔ **still the retracted version, verbatim** | **the lead** |
| brief 219, **three downstream references** | ⛔ **still pointed the old way** | me, only on a re-audit |

The description was being read by an implementer **already working the slice**. The three downstream brief references included the *"verify the premises"* instruction — the first thing the implementer reads — which still called it *"a probably-stale L49 citation."*

> ⚠ **`metadata ≠ description`, and correcting the section that states a claim does not correct the sentences that repeat it.** I had corrected the *argument* and left the *conclusions drawn from it* in place, in the same file, having just re-stamped that file and declared it fixed.

⛔ **A correction that lands in one place and not another is WORSE than no correction:** two authoritative sources now disagree, **and neither announces the disagreement.** Before, one source was wrong. After, the reader picks.

**This is the round's signature shape, third instance.** It is not a new failure mode — it is the one the round opened on:

1. **Seven Phase-9 checkboxes** read `[ ] OPEN` while the phase's own acceptance **prose** already credited every landing commit. *The record was correct where nobody looks and wrong where it gets read.*
2. **[L91](#91)** — a clearance reached the orchestrator and never reached the implementer. *Correct at the routing layer, absent at the consuming one.*
3. **This** — corrected in the brief, stale in the task description an implementer was reading.

⭐ **The new half, which makes this mechanical rather than a reminder: NOT ALL CHANNEL DRIFT IS EQUAL. Rank by consequence.**

- A stale **instruction** fails **OPEN** — the implementer acts on it. Task #3's retracted L49 text pointed at *"skip the domain checklist,"* i.e. straight at the half-frozen seam.
- A stale **spec-lint stamp** fails **SAFE** — `/tdd` Step 0 simply re-lints, costing one run.

Both were stale in the same description. **Only one could hurt.** And the stamp went stale *three times* (`@9632c07d → @ed597a6a → @1469120a → @8fe4b89d`) because **every content edit re-hashes the brief** — so a hash pasted into durable prose is guaranteed to rot.

⇒ **The fix is structural, not diligence.** I removed the stamp from the task description entirely and replaced it with a pointer to the metadata plus the command to regenerate it. **A volatile value does not belong in durable prose that also carries instructions** — it drifts, and its drift trains readers to distrust the prose around it, which is where the load-bearing text lives.

**Do:** when you correct a claim, enumerate its channels **before** declaring the fix done — brief file (including every downstream sentence that repeats it), task description, task metadata, and any message already sent — then grep the retracted wording across all of them to prove none survives. Fix the highest-consequence channel first. Keep volatile values (hashes, counts, stamps) out of durable instruction prose and behind a pointer. And when a correction reverses an instruction someone may already have acted on, **tell them explicitly that it reversed** — do not just publish the new version.

`pattern: grep -rniE '<the retracted wording>' docs/briefs/ IMPLEMENTATION_PLAN.md packages/*/LESSONS.md` — run it as the **last** step of any correction, not the first; a correction is not done when the right text exists, it is done when the wrong text does not. ⚠ Task descriptions/metadata are session-scoped and **not** greppable — enumerate them by hand ([L51](#51): if it only lives in the harness, it is not tracked).

### ⛔ AMENDMENT (same day, +1 hour) — this lesson was applied to the INSTANCE it was noticed at, not across the CLASS it named. Fourth instance.

I wrote *"a hash in durable prose is guaranteed to rot"* — **a statement about every task description** — and then de-inlined the stamp from **task #3 only.** The lead enumerated the rest:

- **#1** description said `@f9bdfa76` · brief was actually `@e23ff413` ⛔ **stale since dispatch**
- **#2** description said `@10f66c4f` · brief `@10f66c4f` — current **only because that brief had not been edited yet**
- **#3** ✅ the one I noticed, the one I fixed

⚠ **`@e23ff413` is the stamp I quoted in #1's own dispatch message.** I had the new hash in hand and left the old one in the description, so worker held two disagreeing sources for the same brief from the moment it was dispatched.

⭐ **The distinction that makes this mechanical, and it rescues the consequence-ranking rather than undermining it:** the lead correctly de-prioritised #1 *because a stale stamp is fail-safe.* That reasoning was sound. **But "which do I fix FIRST" and "what is the FULL SET" are two different questions, and answering only the first is how *fix first* silently becomes *fix only*.** The ranking tells you the order. It never tells you the extent. **Ask both, in that order, every time.**

⇒ **When a lesson names a class ("every X of this kind"), the fix is not done until the class is enumerated** — even for the members whose staleness is harmless, because the harmless ones are where the habit forms. And note the recursion: **this is the round's signature shape for the fourth time, committed by the author of the lesson about it, within an hour of writing it.** Knowing a failure mode does not make you apply it at the right scope — which is why the check below is a question you ask, not a thing you remember.

### ⛔ FIFTH INSTANCE, inside the repair of the fourth — and it exposes a HOLE IN THE THREE-STEP COMMIT DISCIPLINE

Repairing the above, I ran two edits in one shell invocation: amend `LESSONS.md` prose, amend the `CLAUDE.md` index row. **The `LESSONS.md` edit failed its own `assert` guard** (my anchor string didn't match the real line) and correctly changed nothing. The `CLAUDE.md` edit succeeded. Then `git add … && git commit` **ran anyway** — because the `&&` chain guarded only **add→commit**, never **write→add**.

⇒ **For one commit (`49f0cdba`) the lessons index asserted a section that did not exist in the prose** — the index/prose disagreement the lessons convention exists to prevent, committed by the role that maintains it.

⛔ **The three-step discipline could not have caught it, and this is the transferable part.** It verifies **what is staged**, not **whether the edits meant to produce it all succeeded**:

- `git diff --cached --name-only` **before** → correct (nothing pre-staged)
- `git show --stat` **after** → correct (one file, one row, exactly the content I asked for)

**Both were truthful. Neither could report that a sibling edit silently no-oped.** A partial write + a truthful stage + a successful commit **reads as success at every checkpoint** — which is this round's signature shape reaching the instrument that was supposed to catch this round's signature shape.

⚠ **The guard did its job; I failed to gate on it.** An assertion that aborts a *step* but not the *pipeline* is a **warning, not a gate.**

**Do:** chain writes into the commit — `python … && git add … && git commit` — so a failed edit **cannot** reach a commit. Or verify the **content is present** before staging (`grep -c '<the new text>'`), not merely that the file changed. ⚠ **And for any paired artifact (prose ⟷ index, model ⟷ snapshot, code ⟷ test), assert BOTH halves at the commit, not in the working tree** — `git show HEAD:<file>` on each. Staging the pair is not the same as both halves being written.

**Do (added):** after fixing an instance, ask *"what is the SET this instance belongs to, and have I enumerated every member?"* — and record the enumeration, not just the fix. A lesson that diagnoses a class and ships one instance-fix will let its next reader do exactly the same thing and feel finished.

---

<a id="95"></a>
## 95. A type consumed as if its TypeScript annotation constrained runtime-untrusted data needs a BOUNDARY schema — and that schema rejects-or-passes, never rewrites

**Date:** 2026-07-29. **Source slice:** 13.18 — `EntityRef` gets a real contract + Zod schema (`93ebeabd`), §DEC-CANDGATE leg 1.

**The arc's thesis, and the reason four fixes in one round did not add up to one fix.** `EntityRef` was declared only in `packages/knowledge`, self-described *"knowledge-local, not a frozen contract"*, with no schema anywhere — while `planSynthesis`'s input guard validated only `workspaceId` and `sourceRefs`. So `kind: EntityKind` was a **compile-time claim about runtime-untrusted data**, defended ad hoc at each consumption site.

That one shape produced four distinct bugs: the uncapped model-supplied `entityRefs` fan-out (13.8h), `requiresApproval` carried but enforced nowhere (the §9.8 Approvals bypass, [L57](#57)), attendee display-name shapes no validator rejected (two high-severity bugs, [L60](#60)), and `kind` trusted enough to index an object literal (the prototype-chain hole, [L65](#65)). **Every fix closed an INSTANCE while the shape that produced them stayed open, so instance five looked novel to whoever met it.**

⇒ **When a field crosses a model boundary and is then consumed as if the annotation constrained it, the fix belongs at the boundary schema — not at each consumer.** A consumer-side guard protects that consumer; the next one starts from zero.

⚠ **The gap is usually already wider than it looks.** `EntityRef` had *already* crossed into `packages/evals` via the `@sow/knowledge` barrel, so an un-schema'd type was acting as a **de facto cross-package contract with zero runtime validation** — which is the argument for a class-fix in one sentence. Check who imports it before scoping the fix.

**Two properties of the schema itself, both load-bearing:**

**(a) It rejects or passes; it NEVER rewrites.** No `.trim()`, no `.transform()`, no coercion. `name` feeds `entitySlug()`/`faithfulKey()` path and key derivation, so a transforming gate would silently change derived output — **a schema that mutates its input is a second producer**, which is the one-writer rule violated at the validation layer.

**(b) `.strict()` closes a smuggled field at BOTH tiers, not one.** `additionalProperties: false` **survives** JSON-Schema translation (unlike cross-field refines — [L3](#3)), so ajv gates it independently of Zod. A model-supplied `path` arriving on an `EntityRef` and reaching a writer-owned surface — the shape behind the §ARM-RESEARCH 13.8j/k/l residuals — is therefore closed twice. ⭐ **Established empirically by the reviewer, not assumed**, which is what separates it from `.strict()`-as-tidiness. Relatedly: prefer `z.enum` over an object-literal lookup, because it is a real Set-membership check and L65's failure mode cannot recur through it even in principle.

⛔ **A boundary schema with no caller closes nothing.** Leg 1 shipped the gate; **leg 2 calls it** at `planSynthesis`. Describing leg 1 as "the candidate-data gap is closed" would be the half-gate-that-reads-as-coverage the owner warned about when approving the arc.

`pin: packages/contracts/test/models/entity-ref.test.ts (9 tests incl. the proto-chain + .strict() rejections) + the generated schemas/entity-ref.schema.json freeze`

---

<a id="96"></a>
## 96. A `CLAUDE.md` claim that an invariant "is pinned" is ITSELF a claim needing verification — and a scanner must add a companion guard for escape vectors it cannot classify, never a comment that overclaims

**2026-07-29 · 13.20 (`0a6d6629`)**

Forbidden-pattern #2 stated the §2.5 pure-root invariant was pinned by *"a boundary test."* **A repo-wide search found no such test.** ⇒ **An unbacked claim of coverage is worse than an acknowledged gap, because nobody re-checks what a convention doc says is already enforced.** Same class as `lint`-is-typecheck.

⭐ **And the slice reproduced the defect in miniature, then fixed it properly.** The new scanner's own header claimed it caught a tsconfig `paths` alias reach-around. **It did not** — a bare path-aliased specifier is neither `@sow/`-prefixed nor relative, so it passed both branches unscanned. The fix was **not** to delete the sentence: narrow the comment to what is actually detected **AND add a companion guard** asserting no `paths` map exists. If one ever appears, that goes red and the scanner needs a real third branch.

⇒ **A scanner that classifies specifiers cannot classify what doesn't look like a specifier. For every such escape vector: a guard on the vector's ABSENCE, or an explicitly named blind spot — never a comment implying coverage.**

**Do:** treat "X is pinned" in any doc as unverified until you find the pin. When your own guard has a hole, add a tripwire for the hole rather than prose about it. `pattern: grep -rn "pins this\|is pinned\|pinned by" packages/*/CLAUDE.md` — each hit is a claim to verify.

---

<a id="97"></a>
## 97. A BARE IDENTIFIER IS A POINTER TO NOTHING THAT READS AS A POINTER TO SOMETHING — qualify every cross-namespace reference

**2026-07-29 · three independent instances in one round**

1. **`#13`** in a handoff's desktop queue: no tracker entry, no description, its detail dead with a prior session's task list. **And ambiguous across three numbering systems** — the only resolvable `#13` is the **owner-ENABLE hard line** (*"lead-run with the owner — NOT an orchestrator step"*). ⇒ **briefing it would have pointed at an owner crossing while looking routine.**
2. **`L26`** cited in a *contracts* brief while meaning **worker's** L26. Lesson numbers are **per-area and independent**, so a bare `L##` resolves differently in four namespaces and **looks valid in all of them.** The implementer inherited and copied it — correctly, given the context.
3. **`L49`** references in the plan that turned out to be *worker* L49, not contracts L49.

⇒ **The failure is not staleness — it is that a bare identifier LOOKS fine.** A stale citation fails to resolve and gets investigated; an ambiguous one resolves to the wrong thing silently. ⚠ **Worse for `#13`: it sat in a DURABLE FILE, so it read as recorded.** Contracts [L51](#51) says close-out debt goes in a file; **the corollary is that a file entry must carry enough scope to be actionable COLD. A number is not scope.**

**Do:** qualify every cross-area citation (`worker L26`, not `L26`). Never put a bare `#N` in a queue without a one-line description. Before acting on any bare identifier, resolve it — and if it cannot be resolved, **say so rather than inferring.**

---

<a id="98"></a>
## 98. An owner of a shared doc holding UNCOMMITTED state makes HEAD lie to everyone who verifies against HEAD — the counterpart to L83

**2026-07-29 · orchestrator's own failure, caught by the lead**

[L83](#83) says verify at a **commit**, never the live tree, while anyone is mid-slice. The lead did exactly that — checked task 9.24's checkbox **at HEAD**, read `[ ] OPEN`, and correctly concluded a claim of mine was false.

**9.24 was done.** It shipped in a prior round, and this round's seven-stale-checkbox reconciliation had ticked it — **in the orchestrator's working tree, uncommitted, for thirteen commits.**

> ⇒ **Verifying at HEAD is right, and it returns a WRONG ANSWER while a doc-owner holds uncommitted tracker state.** L83 protects you from a moving tree; nothing protected the lead from a *stale* HEAD. **Both halves of "don't trust the tree, trust HEAD" can fail at once.**

⚠ **The asymmetry that makes this the orchestrator's problem specifically:** implementers commit per slice, so their state converges every cycle. The orchestrator owns `IMPLEMENTATION_PLAN.md`/`ARCHITECTURE.md` and the cadence says those ride the **round-terminal** commit — which means **tracker truth is designed to be stale for the whole round**, for a file the entire team verifies against by policy.

**Do:** commit tracker reconciliation **promptly**, not at the seal — a checkbox tick is not "round bookkeeping," it is the answer to a question teammates ask HEAD. If you must hold plan state, say so when anyone reports a task's status. `accepted: not mechanically enforceable` — mitigation: after any batch of checkbox ticks, commit before the next dispatch.

---

<a id="99"></a>
## 99. Enumerate the occurrence set, then CLASSIFY each member — an occurrence of a stale citation is not always a stale citation

**2026-07-29 · the L76/L72 pin-name repair · the instruction said four sites; three were repairs**

`carried_policy_with_a_foreign_workspaceid_does_not_land` appeared in four places and existed in **no test file**. The instruction — correct about extent — was *"fix the stale pin name in four places, not one."* Three were **citations**: a `pin:` line pointing at a guard, which must be true. The fourth was a **quotation**: `IMPLEMENTATION_PLAN.md`'s own finding record, which names the stale string as its *subject* — *"L76 cites a pin named X that exists in NO TEST FILE."* Substituting the live name there would have made the record assert that **the live guard** exists in no test file.

> ⇒ **A citation-rot record has to keep quoting the rotted citation.** Enumerate the full occurrence set ([L93](#93)'s repo-wide discipline), then **classify each member before touching it** — CITATION (points at a thing; must resolve) vs QUOTATION (reports that a thing was wrong; must stay verbatim). Only citations get repaired. "Enumerate the set" and "repair the set" are different instructions, and the second is not implied by the first.

**The larger half: a repair can manufacture a fresh false claim.** 9.30 had **deleted** the mechanism L76 describes — the `existing.value.egressPolicy` carry-forward *and* its `WorkspaceSchema.parse` re-gate — because `updateProvisioningFields` narrows the same-type write so no stored blob re-crosses (`provisionWorkspace.ts:238-249`). The live guard's own name says so: `a_corrupt_stored_policy_can_never_re_cross_into_a_write`, annotated *"9.23's re-gate, superseded (9.30)"*. So a **pure rename** would have left prose asserting a deleted re-gate while pointing at a live test — **worse than the stale name was**, because a stale name fails visibly the moment anyone greps for it and a plausible live name never does. Resolution that holds: **the RULE stands, the MECHANISM is history, the closure is now by construction.** [L71](#71) generalized — a correction is a claim, so *verify the cited thing still does what the citing prose says it does*, not merely that the name resolves.

**Enumeration discipline, applied unasked:** L72's pin line carried three names; only one was flagged. The other two were checked in the same pass and were live (`:75`, `:118`). Checking the unflagged siblings is what turns a reported instance into a closed class.

⭐ **THE CHECK IS MECHANIZABLE, AND IT FOUND A FOURTH INSTANCE — measured, not asserted.** Run over `pin:` lines, it flagged `revoke_return_makes_no_unearned_local_claim` (L69's pin, citing `worker egressCommands.test.ts`): the file exists, **no test of that name does**, and none of its nine live `it(...)` names matches. Independent of the reported instance, found by execution.
⚠ **And its false-positive mode is known, because it fired on itself:** the corpus-wide form flagged 3 names of which 2 were legitimate quotations (L67 quotes a test it exists to criticize). Scoping to `pin:` lines drops one, but **prose that merely mentions the word `pin:` while quoting a stale name still trips it** — which is this lesson's own distinction, unmechanizable by grep. Treat output as *candidates to classify*, never as defects; a check that reports known permanent false positives is one people learn to disbelieve ([L89](#89)).

> ⭐ **THE LINE THAT MATTERS MORE THAN THE ENFORCEMENT LINE: the pattern narrows the set; it cannot do the classifying.**
>
> Demonstrated **within an hour of banking this lesson**, by its own author, on a different check: verifying that three audit reports emitted no `CLEAR`/`BLOCKED` verdict, a grep for those tokens flagged **all three** — and every hit was the *disclaimer sentence* saying no verdict was emitted. Same structure, one level up: a mechanical search cannot distinguish a thing from a statement **about** that thing. The only fix was to read the lines. ⇒ **Any grep-backed enforcement line on a claim of this shape inherits this limit**; write the limit down beside the pattern, or the next person reads a hit count as a defect count.

`pattern:` — pin-line-scoped; every hit is a CANDIDATE requiring the citation-vs-quotation classification above:
```sh
grep -nE 'pin:' packages/contracts/LESSONS.md | grep -oE '\b[a-z][a-z0-9]*(_[a-z0-9]+){3,}\b' | sort -u |
  while read -r n; do grep -rqF "$n" --include='*.test.ts' --include='*.test.tsx' apps packages ||
    echo "CANDIDATE (classify: citation or quotation?): $n"; done
```
`accepted: not mechanically enforceable` — the classification half is judgment; the pattern narrows the set to inspect. Candidate `plan-lint`/`spec-lint` rule (see the process-durability item's gate-gap list).

---

<a id="100"></a>
## 100. A negative claim from a scoped search is only as strong as its scope — so state the scope WITH the claim

**2026-07-29 · the third instance of one defect by a third mechanism · lead, self-caught and self-reported**

*"There is NO `WorkspaceSchema.parse` on any write path"* was false. `defaultWorkspace()` parses at `packages/contracts/src/models/workspace.ts:112`, and the create path writes exactly its output (`provisionWorkspace.ts:294` `insertIfAbsent(workspace)`) — so the fresh-create write **is** validated. The search that produced the claim covered `apps/worker/src` + `packages/db/src`, which **structurally cannot contain** `packages/contracts/src`.

**Three instances of the same defect by three different mechanisms, in one round, by one author:**
| Mechanism | What went wrong |
|---|---|
| Wrong **pattern** | the regex could not match the form the thing was written in |
| Merged **output** | two commands' results read as one, so a miss looked like a hit |
| Wrong **scope** | the paths searched excluded where the thing lives |
| **Verified evidence, inherited inference** ⭐ | the *fact* under the claim was checked and TRUE; the *step from fact to claim* was never checked |
| **Correct numbers, incommensurable units** ⭐ | both measurements were right; they measured *different things* and were compared as if they didn't |

⭐ **The fourth is the sharpest of the four and it arrived the same day, on a different claim.** *"`§4.5` does not exist in `ARCHITECTURE.md`"* was verified — zero occurrences, correctly scoped, **true**. The claim built on it, *"therefore `§4.5` is undefined,"* was **false**: its real referent is `docs/design/ui-ux/ui-ux-spec.md:206`, another document's own §-numbering. **Checking the fact under a claim is not checking the claim** — and it feels like verification, which is exactly what makes it dangerous.

> ⭐ **State the distinction this way, because it is the whole reason the fourth earns a row instead of a footnote: the first three mechanisms produce a wrong FACT. The fourth produces a wrong CONCLUSION FROM A RIGHT FACT — so EVERY VERIFICATION STEP PASSES.**
>
⭐ **The fifth arrived while banking the fourth, in the same document, from a FLAG AMBIGUITY.** Recording L101's scale, the measurement was written as `grep -coE …` — **`-c` counts LINES, `-o` counts OCCURRENCES, and combining them is ambiguous.** One run reported **87** (lines, the candidate set); a later run of the sibling pattern reported **180** (occurrences). Both numbers were **correct**; they measured **different things**, and the record paired them as a ratio — *"87 candidates against 180 legitimate."* The real figures: **87 lines / 113 occurrences** vs **163 lines / 180 occurrences**. Caught only because the 180 **would not reproduce** on re-run, on a file that had only been appended to — a count that moves in the wrong direction is a unit error, not a data change. ⇒ **Never write a count without its unit, and prefer the command over the value.** ⚠ This one is *not* caught by re-running the same command — re-running reproduces the same ambiguous flag. It is caught by re-deriving the number **a different way** and finding it disagrees with itself.

⭐ **AND THE FOURTH IS NOT SPECIFIC TO CODE CLAIMS — it applies to any decision whose COST you ESTIMATE without MEASURING.** Live instance, a *process* decision the same day: the lead was about to decline four `/session-end` runs on budget grounds, reasoning *"four documents is more than I can afford."* **The premise was never checked — implementer recaps go to the orchestrator, not the lead**, so the actual cost was **four idle notifications**, not four documents. ⇒ *"I was about to decline on a cost I would not have paid."* **Every step of that reasoning was sound except the unexamined premise underneath it**, which is precisely the fourth mechanism's signature. **Dissolved by checking, not by reasoning harder** — and reasoning harder would have produced a more confident wrong answer. ⇒ **When declining something on cost, state who actually pays and verify that they do.**

⚠ **Its sibling, and worth the distinction: "NO OBSERVATION" IS NOT A NULL RESULT.** Asked for their read of the `pnpm lint` intermittency, worker-implementer recorded that they **never ran it directly** that session (only per-package `tsc --noEmit`) and therefore had *"no data point to add, not a null result."* ⇒ **An absent measurement and a negative measurement are different facts, and collapsing them manufactures evidence** — three implementers reporting "didn't see it" would have read as three non-reproductions when only one of them had actually looked. **Report "I did not measure this," never "I saw nothing."**

> The first three mechanisms are catchable by re-running the check: widen the pattern, separate the outputs, extend the scope, and the wrong fact turns into a right one. **The fourth has no failed check anywhere in the chain to notice.** The grep was correct, its scope was correct, the count was correct, and the conclusion was still false — so there is nothing for a diligent re-verification to find. The only defence is to state the inferential step *as a separate claim* and check that too: *"zero occurrences in file X"* and *"therefore undefined"* are two assertions, and the second is the one that was never tested.

> ⇒ **The durable rule is NOT "widen the pattern"** — that only fixes the first mechanism, and this round proved there are at least three. **A negative existence claim inherits the boundaries of the search that produced it, and those boundaries must travel with the claim.** *"I grepped and found nothing"* is not a finding. *"No hit for `<pattern>` under `<paths>`"* is — because a reader can see the hole, and the person holding the file can contradict it cheaply.

**Why negatives specifically.** A positive claim carries its own evidence (here is the hit) and is self-falsifying if wrong. A negative claim's evidence is an **absence**, which is indistinguishable from an absence of *looking* — so the scope IS the evidence, and omitting it leaves a claim with no checkable content that still reads as authoritative. Kin to [L91](#91) (a stall's signature is the absence of a signal) and [L75](#75)'s fail-first precondition: an unobserved absence and a real absence look identical.

⚠ **The reason this one was expensive rather than merely wrong:** the false negative was used to *repair* a citation. Under it, the natural fix was to name a different mechanism as the write-path guard — which would have replaced a stale citation with a confidently-wrong one ([L99](#99)'s larger half). **A wrong negative upstream of a correction propagates into durable prose as a positive assertion.**

⭐ **Working counter-example from the same exchange, worth copying:** the enumeration *"both dialects × `get`/`list` = four sites"* was stated **with its scope**, which is exactly what let the next reader find that `updateProvisioningFields`'s `.returning()` row is cast too — **six sites, three per dialect** (sqlite `:362`/`:364`/`:412`, postgres `:383`/`:385`/`:430`). A scoped claim gets corrected; an unscoped one gets believed.

> ⭐⭐ **AND THEN IT ESCALATED, WHICH IS THE RULE'S REAL PAYOFF — STATING THE SCOPE DID NOT JUST BOUND THE CLAIM, IT REVEALED THE CLAIM WAS MEASURING THE WRONG THING.**
>
> Writing *"complete for the pattern `as Workspace` within `packages/db/src`"* forced the next question — *is that where the property lives?* — and the answer was no. `packages/db/src/schema/workspace-config.ts:35-36` types both nested aggregates `text({mode:"json"}).$type<Workspace[...]>()`, so drizzle's inferred row is **already structurally `Workspace`** and **all six casts are decorative**: delete them and an unvalidated row still flows. **A cast-shaped search, however wide, structurally cannot establish completeness when the type lie lives in the schema DECLARATION rather than at the call sites.** The six-site enumeration was accurate and beside the point — a construction census wearing a completeness badge ([L70](#70)).
>
> ⇒ **So the rule's payoff is not "narrower claims."** It is that **forcing yourself to say WHERE you looked exposes WHETHER that is where the property lives.** An unscoped *"the casts are the problem"* would have shipped a fix that deleted six casts and changed nothing — and it would have passed review, because the casts really were there. **The scope statement is not a hedge; it is the step that makes the measurement auditable.**

⭐ **A SIXTH SHAPE, and it is mechanism #1 at its most dangerous: THE THING YOU ARE SEARCHING FOR DOES NOT EXIST AS A LITERAL ANYWHERE.** Deleting the dead `.sow-pill--zero-egress` CSS rule (9.37a), the acceptance bullet said *"nothing references the class."* The rule's selector list was **shared** with `.sow-pill--egress-false` — which is **live**, and is built by **template interpolation**: `` `sow-pill sow-pill--egress-${String(...acknowledged)}` `` (`egress.tsx:230`). ⇒ **No literal occurrence of that class name exists in the TSX, so a name search returns "zero references" for a class with a live consumer.** Deleting the block on that evidence would have silently restyled a live element. Caught by the implementer reading the selector list rather than trusting the search. **Same family as the `$type<>()` look-alike ([L103](#103)'s limits): the property does not live where the literal is.** ⇒ For dynamically-constructed identifiers, search the **stable prefix** (`sow-pill--egress-`), not the full name — and know that the set of construction sites is itself unbounded.

⭐ **A SEVENTH SHAPE — WRONG SCOPE *INSIDE A BELT*, which is where it does the most damage.** 9.36's source census (the belt over deliberate `as Workspace` reintroductions) discovered its own file set with bare **`git ls-files`** — **tracked files only.** The slice's central new file, `packages/db/src/adapters/workspace-read-gate.ts`, was **untracked at the time**, so ⛔ **the census was blind to the very file the slice created.** A belt whose enumeration method skips new files **passes forever on exactly the additions it exists to catch** — and it passes *green*, so nothing signals the hole. Fixed with `git ls-files --cached --others --exclude-standard`. Self-caught by the implementer before reporting.
⚠ **Sibling false pass from the same census, also self-caught:** the first mutation attempt used an inline `import("@sow/contracts").Workspace` cast form, which the regex **correctly did not match** — so the mutation "passed" while testing nothing. **A mutation that the guard cannot see is indistinguishable from a guard that works** ([L75](#75)'s fail-first precondition). The realistic single-token cast was needed to make the census go RED.
⇒ **Both belong to L100 rather than to the census:** a guard is only as complete as the **enumeration** feeding it, and *"which files does this scan?"* is a scope question with the same failure mode as *"which paths did you grep?"*

> ⛔ **AND THE PRESCRIPTION THIS FORCES ON ACCEPTANCE BULLETS, because the bullet was mine:** *"nothing references the class"* stated a **negative claim without saying HOW TO LOOK** — this lesson's own rule, applied one level up, to a brief. ⇒ **Any acceptance bullet asserting an absence must specify the search that establishes it** (which pattern, which paths, and whether the identifier can be dynamically constructed). A bullet that says *"verify nothing references X"* delegates the scope decision to whoever reads it, and they will use the literal.

`pattern:` — not greppable. Enforcement is at authoring time: any sentence of the form *"there is no X"* / *"X appears nowhere"* / *"nothing calls X"* must carry the pattern **and** the path set that was searched — **and, for an identifier that can be assembled at runtime, must say so.**
`accepted: not mechanically enforceable` — mitigation: in a Finding or a Step-9 flag, a negative claim without a stated scope is treated as unverified rather than as evidence.

---

<a id="101"></a>
## 101. `ARCHITECTURE.md` has real numbered subsections ONLY under §19 — every other `§N.x` token in project prose is shorthand wearing an architecture-anchor costume

**2026-07-29 · found by the Phase-9 audit's anchor reconciliation · the CLASS fix, deliberately not four repairs**

Phase 9's task prose cites `§4.5` (8×), `§14.1`, `§14.3`, `§14.5`, `§13.5`, `§9.4`, `§9.5`, `§9.32`. **Not one of them is an `ARCHITECTURE.md` section.** Traced to their real referents:

| Token | Real referent |
|---|---|
| `§4.5` | `docs/design/ui-ux/ui-ux-spec.md:206` — **another document's own §-numbering** |
| `§14.1` / `§14.3` / `§14.5` | `IMPLEMENTATION_PLAN.md` **Phase-14 tasks** |
| `§13.5` | plan **task** 13.5 (appears in `ARCHITECTURE.md` only inside an Appendix-A cross-ref row) |
| `§9.4` / `§9.5` / `§9.32` | plan **task numbers** wearing a `§` |
| `USER_FLOWS 3/5/6/13` | Flows 3/5/6 are real; **Flow 13 does not exist** in `USER_FLOWS.md` — "13" resolves only as `ARCHITECTURE.md:354` §9's *workflow*-13 |

> ⛔⛔ **CLASSIFIER CORRECTED 2026-08-11 (24.6 round 4 / `LES-1`) — READ THIS BEFORE APPLYING ANYTHING BELOW. `ARCHITECTURE.md`'s real numbered subsections are `§19.x` **AND `§2.5`**; every OTHER `§N.x` is shorthand.** ⚠ **The universal stated below — *"ONLY under §19 … by construction not an architecture anchor"* — is FALSE by exactly one counter-example, and it is the most load-bearing one in the project: `ARCHITECTURE.md:80` is `## §2.5 — Subsystem dependency DAG & parallelization seams`.** Corroborated three ways: Phase 9's declared `Spec anchors:` line · `packages/contracts/CLAUDE.md`'s own *"the §2.5 import-direction root"* · `docs/tdd-brief-template.md`'s mandated seam bullet. ⛔ **Applying the old rule would have RECLASSIFIED EVERY LEGITIMATE `§2.5` CITATION AS A NOTATION ERROR and stripped the one cross-cutting seam anchor the brief template mandates — fix-where-noticed would have been SAFER than the sweep.** ⭐ **The correction landed in `IMPLEMENTATION_PLAN.md` at `25acd598` (2026-07-30) and NEVER PROPAGATED HERE, nor to this file's index row, nor to forbidden-pattern #8 — and a brief dated ONE DAY LATER cited the falsified universal as its justification.** *(contracts L94: a correction reaching the channel that STATES a claim but not the channel that REPEATS it leaves the repeating channel authoritative — and here the repeating channels were a lessons ledger and a forbidden-patterns block, i.e. the two surfaces implementers are told to obey.)* ⭐ **The banked scale figures and the enumerate-then-classify discipline below all still stand — this is a CLASSIFIER fix, not a cancellation.** ⚠ **A universal claim needs one search that could REFUTE it, not three that confirm it.**
>
> ⇒ **The structural fact that makes this checkable: `ARCHITECTURE.md` has real numbered subsections ONLY under §19** (`### §19.1`–`### §19.13`). Every top-level section is a bare `## §N`. **So any `§N.x` token with `N ≠ 19` is, by construction, not an architecture anchor** — it is a plan task, another doc's numbering, or a typo.

**Why this is one lesson and not eight repairs.** Each instance individually reads as a trivial citation typo. Together they are a **notation collision**: the project uses `§` for at least four different numbering systems (architecture sections, plan tasks, other design docs' internal sections, and workflow numbers), and the reader cannot tell which from the token. The failure is not that a link is broken — **it is that the token resolves *plausibly* in the wrong system.** A dangling citation gets investigated; an **ambiguous** one gets believed, which is the same asymmetry as a false CLEAR versus a false RED.

⚠ **It cost a real escalation.** `§4.5` is the anchor of the doc-pack leg that makes Phase 9 un-exitable, so *"the blocker is pinned to a section that does not exist"* was escalated toward the owner as potentially scope-deciding — and withdrawn once the referent was found. **The notation defect manufactured a scope question out of a formatting choice.**

⚠ **The gate has purchase on this in exactly one place, and it is not where the instances live.** `scripts/spec-lint.sh` fails a *brief* whose cited anchor is outside the phase's declared set — verified live: it rejected a draft carrying `§9.36` and a stray `§13`, both authored **by the person who had reported this finding an hour earlier**. Nothing lints the same tokens in `IMPLEMENTATION_PLAN.md` task prose, which is where all eight live. **A gate that covers the newest artifact and not the accumulated one reports health for the half nobody was worried about.**

**Do:** cite an architecture anchor as bare `§N`; cite a plan task as **`task N.M`** (no `§`); cite another document by **path + its own numbering** (`ui-ux-spec.md §4.5`), never bare. When `§N.x` with `N ≠ 19` appears, resolve it before repeating it.

⛔ **SCALE, measured when the pattern was first run rather than estimated — the class is an order of magnitude larger than the phase that surfaced it.** The pattern matches **87 lines** of `IMPLEMENTATION_PLAN.md`, against **180** legitimate `§19.x` occurrences correctly excluded. Phase 9 contributed 8.

**The measurement method, recorded so nobody re-estimates it** (2026-07-29, at commit `247d0b67`):
```sh
grep -cE '§(1[0-8]|[0-9])\.[0-9]' IMPLEMENTATION_PLAN.md   # → 87   (candidate lines)
grep -coE '§19\.[0-9]+'           IMPLEMENTATION_PLAN.md   # → 180  (legit §19.x, excluded)
```
⛔ **87 is a CANDIDATE count, not a defect count** — and the distinction is what keeps the record honest. A future reader who budgets against 87 and **reports how many were real** is running a scoped arc; someone who fixes the 8 they happened to notice and ticks the item is doing fix-where-noticed **wearing a completion badge**. Re-run the two commands rather than trusting these numbers: the file grows. ⚠ **87 is the size of the CANDIDATE SET, not a defect count** — many are presumably valid references to other documents' numbering, which is exactly what needs classifying. Stated this way deliberately: *"8 instances found"* would have implied the repair was a phase-sized cleanup when the surface is repo-wide, and a fix scoped to the instances someone happened to notice is the fix-where-noticed shape. **Whoever takes the cleanup should budget against 87 candidates and report how many were real.**

`pattern: grep -nE '§(1[0-8]|[0-9])\.[0-9]' IMPLEMENTATION_PLAN.md` — every hit is a non-§19 subsection reference and therefore **not** an architecture anchor; confirm which system it belongs to. (Excludes `§19.x`, the only real subsections.) ⚠ Inherits [L99](#99)'s limit: prose *discussing* the notation hazard trips it too — the pattern narrows the set, it cannot do the classifying.

---

<a id="102"></a>
## 102. Before recording a rule as unpinned, ask whether it is the KIND of rule a test can pin at all — "pin owed" on a judgment rule is debt that can never be discharged

**2026-07-29 · created in the same breath as a ruling against phantom pins · lead, self-caught**

Repairing [L69](#69)'s rotted pin citation, the ruling was: *establish whether either candidate test pins L69's rule; if neither does, **record the pin as ABSENT** — and an absent pin is a candidate slice for a later round.* The reasoning behind it is sound and is [13.20](#93)'s: **a claim asserted-as-pinned but unenforced is worse than unpinned, because the claim stops anyone looking.**

**Two things were wrong with it, and the second is the lesson.**

**(a) The framing was a FALSE DICHOTOMY.** "Either a test pins the rule, or the pin is absent" excluded what turned out to be true: **the pin's subject existed, in the cited file, under two different names.** The evidence was **author-declared, not inferred** — both assertions carry an in-code `9.22 ⚠ SEMANTICS CHANGE (L69)` comment naming the lesson. So citing them smuggles no cross-file equivalence, which is precisely the hazard the ruling existed to protect against and which its own binary made unreachable. ⇒ **When a ruling enumerates the outcomes, check that the enumeration is exhaustive before treating "neither" as proof of absence.**

**(b) ⛔ L69's rule is a PROCESS rule about test-authoring judgment — *no test can pin it*.** *"Treat a test that asserts a safety value as a claim requiring the same derivation check as the code it guards"* is a rule about how a human reads a diff. Corrected assertions are **artifacts of having applied it**, never enforcement of it. So *"record the pin as absent, and a later slice writes it"* created an obligation **no slice could ever discharge** — and it was created in the same message that ruled against phantom pins.

> ⇒ **A phantom obligation is the same defect as a phantom pin, facing forward.** A phantom pin says *"this is checked"* when nothing checks it. A phantom obligation says *"this will be checked"* when nothing can. Both retire the reader's attention; the second also accretes into a backlog that can only ever be closed by someone re-deriving that the work was impossible.

**The check, and it is one question asked BEFORE the enforcement line is written:** *is this the kind of rule a test can pin at all?*

| Rule kind | Honest enforcement |
|---|---|
| A **property of the code** ("no root path is reachable") | `pin:` a test — and mutation-verify it ([L75](#75)) |
| A **mechanically detectable shape** ("no second definition of this symbol") | `pattern:` a grep/ast-grep expression |
| A **judgment rule** ("stop and ask whether the test was right") | `accepted: not mechanically enforceable` — **and no slice is owed** |

⚠ **The failure mode this prevents is quiet.** `accepted: not mechanically enforceable` looks like the weakest of the three options, so there is a pull toward promising a pin instead — it reads as more rigorous. **It is less rigorous**, because it substitutes a deliverable nobody can produce for an honest statement about the rule's nature. Where a judgment rule *does* have a mechanical shadow, name the enforcement **point** rather than a test (L71's line does this: *"enforcement points: `/orchestrate-end` Carry-forward triage + `/team-end`"*).

`accepted: not mechanically enforceable` — self-referentially, this is exactly that kind of rule. Enforcement point: the moment an `accepted:` / `pin:` / `pattern:` line is authored at Step-9 routing.

---

<a id="103"></a>
## 103. HOUSE PATTERN — make the violation UNREPRESENTABLE; a detector is belt, never the mechanism

**2026-07-29 · named because the team converged on it unprompted, four-for-four in ONE round, four independent authors, three code areas**

This is a **convention**, not an incident report. Four slices in one round independently reached for the same move, and naming it makes the fifth cheaper to reach for:

| # | Slice | The violation | Made unrepresentable by |
|---|---|---|---|
| 1 | **9.35** (desktop) | a fallback rendering `error.message` / a stack — rule 7 | `fallback` typed `(reset) => ReactNode` with **no error parameter** — the caller is never handed one |
| 2 | **9.30** (worker) | provisioning writing posture columns | `ProvisioningOwnedFields` — a posture write is **untypeable** from that path |
| 3 | **9.21-B** (worker) | a partial modelled as a success, or leaking a message | the `err` variant carries only a **closed literal**, no message field ([L80](#80)) |
| 4 | **9.36** (db) | an unvalidated stored aggregate reaching a policy decision | the parse becomes the **only** constructor of the repo's return value |
| 5 ⭐ | **the commit discipline itself** (process, not code) | a foreign staged file entering someone else's commit | **`git commit -- <paths>`** — pathspec-limited, so the index's contents cannot influence the commit's contents ([L109](#109)) |

⭐ **The fifth instance is the one that shows the pattern is not about types.** The first four replace a runtime check with a compile-time impossibility; the fifth replaces a **procedural** check with a **command form**, and the reasoning is identical — a three-step "verify the index, then commit" discipline is a detector whose failure mode is *"the actor read the output after acting"*, while a pathspec-limited commit removes the influence entirely. ⇒ **Ask the pattern's question of processes too: what is the cheapest edit that makes this violation representable again?** If the answer is *"forget one step"*, you have a detector.

> ⇒ **Prefer a design in which the bad state does not typecheck over one in which the bad state is detected.** A detector answers *"did it happen?"*; unrepresentability answers *"can it happen?"* — and only the second is closed under **future callers**, which is where every one of these was actually leaking.

⭐ **The decisive precedent is the project's own, and it is now THREE-for-three on safety rule 5** — this is not an aesthetic preference:
- Worker [L73](#73): a `process.env` **denylist** was *structurally unwinnable* for a rule-5 egress **completeness** invariant — every re-ground found more (the watched set grew **13 → 81**). Replaced by a spawn-env **allowlist** (complete-by-construction, drift-immune); the denylist was retained **explicitly as "defense-in-depth belt," not the completeness mechanism.**
- Worker [L74](#74): the same call again for settings **files** — a **presence-degrade** subsuming an unwinnable managed-**field** enumeration.
- 9.36: a **cast census** would have been the third instance of the same unwinnable-denylist shape.

**The tell that you are on the losing side of this:** the enumeration keeps growing when re-checked, and each re-check is *correct*. That is not diligence converging — it is evidence the property does not live where you are counting. ⚠ **An enumeration can be accurate and beside the point** ([L100](#100)): 9.36's six-cast census was right about the casts and wrong about completeness, because the type lie lived in the schema declaration, not the call sites.

**Do:**
1. Ask **"what is the cheapest edit that makes this violation representable again?"** If the answer is *"add a new call site"* or *"add a new field"*, you have a detector, not a mechanism.
2. Put the invariant where the **compiler** enforces it: a closed literal ([L31](#31)'s literal-`false` arming flags), a branded type only one constructor can produce, an absent parameter, a narrowed field set.
3. **Keep the detector — and label it belt.** Both L73 and L74 kept theirs. ⛔ **Report the belt separately from the mechanism**, or a later reader mistakes the belt for the guarantee and "improves" the mechanism away.
4. If the belt is a census/source-scan, **both-anchor it and mutation-verify** — 9.22's census pin was prefix-anchored and accepted a superset, passing on exactly the input it existed to reject ([L70](#70)).

⚠ **Limits, so this doesn't become a reflex.** Unrepresentability costs type complexity, and it cannot express a **runtime** property (freshness, ordering, a live external state) — for those, a fail-closed runtime gate with a **reason code** is the mechanism ([L80](#80)). And a type-level guarantee over data crossing a trust boundary is only real **after** a runtime parse: `$type<>()` on a DB column is a **compile-time claim about runtime-untrusted bytes**, which is the defect 9.36 exists to fix, not an instance of this pattern.

⭐ **AND A META-RULE THIS ENTRY EARNED, applying to every convention promoted from candidate: BANK THE LIMITS ALONGSIDE THE PATTERN, IN THE SAME EDIT.** The look-alike above is the reason. `$type<>()` on a DB column **looks** like make-the-violation-unrepresentable and is its **inverse** — a compile-time claim over runtime-untrusted bytes, i.e. **the defect 9.36 exists to fix rather than an instance of the pattern.** A convention shipped without that distinction would have produced a fifth "application" that was **the original defect wearing the pattern's name** — and it would have been defended by citing this lesson. ⇒ **A pattern without stated limits becomes a reflex, and a reflex is applied by people who did not read the reasoning.** For any convention promoted to house-pattern status, the same edit must answer: *where does this NOT apply, and what looks like it but isn't?*

`accepted: not mechanically enforceable` — a design-time preference, not a checkable shape. Enforcement point: `/tdd` Step 2.5, where "how would you detect this?" should be answered with "you wouldn't — it won't compile."

---

<a id="104"></a>
## 104. A mechanical check cannot distinguish a USE from a MENTION — so the document explaining a rule is the one most likely to violate it mechanically

**2026-07-29 · THREE independent demonstrations in one round, TWICE inside a mechanism built to catch the very thing**

| # | The check | What it flagged | What the hit actually was |
|---|---|---|---|
| 1 | [L99](#99)'s stale-pin-name pattern over `pin:` lines | the repaired L76/L72 pin lines | **correction prose that QUOTES the stale name** in order to record it |
| 2 | a grep for `CLEAR`/`BLOCKED` over the three Phase-9 audit reports, verifying no verdict was emitted | **all three reports** | the **disclaimer sentence** saying no verdict is emitted |
| 3 | `scripts/spec-lint.sh`'s out-of-phase-anchor check | brief 226's gate-finding note | **the note documenting that very collision**, which quoted the offending token — and its first rewrite still did, so it tripped **twice** |

> ⭐ **This is not a defect in any of those checks. It is what greps ARE.** A mechanical check matches a **form**; use and mention share the form. So **any grep-shaped gate will trip on prose ABOUT what it forbids** — and the prose most likely to mention a forbidden token is **the finding that documents it.**

**Two corollaries, and the second is the load-bearing one:**

1. **The document explaining a rule is the document most likely to violate it mechanically.** A lesson about a bad token contains the token. A disclaimer about a verdict contains the verdict vocabulary. A finding about a citation quotes the citation.
2. ⛔ **A check with no use/mention escape will systematically SUPPRESS ITS OWN DOCUMENTATION.** The path of least resistance when a gate rejects your finding-record is to **delete the discussion** — which is exactly backwards, and it happens quietly because deleting the sentence makes the check green. **The gate ends up enforcing silence about the thing it exists to catch.**

**Do:**
- **Expect the finding-record to trip the check**, and budget for it rather than treating it as a surprise.
- Write the record **token-free** (describe the token instead of reproducing it), **or** give the check an explicit escape (an allowlisted line prefix / a marker comment) — but **never** resolve it by removing the explanation.
- When authoring a `pattern:` enforcement line, **state this limit beside it** (as L99 and [L101](#101) now do). A hit count is a **candidate** count; classification is human and always will be.
- ⚠ **Do not "fix" the check to be cleverer about it.** Distinguishing use from mention requires understanding the sentence — that is not a property a grep can acquire, and an almost-clever check is worse than a blunt one because its false-negative surface stops being obvious.

⚠ **The self-referential note, which is the point rather than a joke:** a mechanical check for this lesson's own rule would flag this lesson. Every table row above is a mention.

`accepted: not mechanically enforceable` — necessarily, and demonstrably. Enforcement point: authoring any `pattern:` line, and reading any check's output as candidates rather than defects.

---

<a id="105"></a>
## 105. The most recent implementation is not the most correct one — it is the one that most recently accepted a compromise

**2026-07-29 · caught while briefing 13.8m-C, before a line was written**

Task 13.8m landed on two paths. **13.8m-A** (source producer) put `refusals` on the receipt as a **required** field. **13.8m-B** (the worker consumer) made it **optional on the worker seam** — deliberately, to keep 13 existing containment fakes valid — and **recorded the bound in-code**: *"a FUTURE adapter could omit it and the sink would silently never fire."*

Briefing the **meeting** path (13.8m-C), the natural move is *"mirror the most recent sibling."* **That would have carried B's optionality onto a second path** — importing a compromise that existed only to avoid a fakes migration, onto a path with no fakes to migrate.

> ⇒ **"Follow the newest sibling" is the default that spreads recorded bounds** — and a recorded bound spreads **silently, because it was already deemed acceptable once.** Nobody re-litigates it; its acceptance is treated as settled precedent rather than as a local trade.

**The right template was the OLDER one.** A's required field makes omission **unrepresentable**; B's optional seam makes it **detectable at best** ([L103](#103)).

**The check is cheap, and the compromise's own diligence is what makes it cheap:** a compromise in the newest sibling is usually **documented** — that is what makes it a *recorded* bound. ⇒ **Before mirroring an implementation, read its own caveats.** If it has an in-code note explaining why it is shaped that way, that note is telling you whether the shape is the design or the concession.

**Ask: which sibling has the fewest ACCEPTED COMPROMISES — not which is newest.** Recency signals *"most recently touched,"* which correlates with *"most recently forced to trade something,"* not with correctness.

⚠ **Where recency IS the right signal:** when the newer sibling exists *because* the older one was wrong (a supersession — 9.30 superseding 9.23's re-gate is exactly that, see [L76](#76)). ⇒ **Distinguish a SUPERSESSION from a CONCESSION.** A supersession's note says *"the older approach was wrong"*; a concession's says *"this is narrower than we wanted, because X."* Mirror the first; read past the second.

`accepted: not mechanically enforceable` — judgment at authoring time. Enforcement point: brief-writing, at the moment a prior implementation is named as the template to mirror; say **which** sibling and **why that one**.

---

<a id="106"></a>
## 106. A CAPABILITY IS NOT A GUARANTEE — a correctly-typed, correctly-fail-closed signal that reaches no consumer is indistinguishable from the failure it was built to distinguish

**2026-07-29 · THREE instances across three areas on one safety posture, one of them pre-existing and untouched**

| # | The signal | Produced | Consumed |
|---|---|---|---|
| **#45** | the §5 egress veto's `AuditSignal` → `AuditRecord` | ✅ | ⛔ **no persistence consumer — produced and DROPPED.** *Pre-existing; tracked since before this round and still open* (`IMPLEMENTATION_PLAN.md:552`, handoff `018:52`) |
| **13.8m** | `GroundedPathRefusal` on the synthesis receipt | ✅ (A: source · C: meeting) | source path wired by B; **meeting path has no consumer** |
| **9.36 → 9.38** | a distinguishable stored-row-corruption `DbErrorCode` | ✅ | ⛔ `boot.ts:578-592` folds **any** `get()` error into one generic `failClosedEgress` value |

> ⇒ **In all three the producer is CORRECT.** The type is right, it fails closed in the right direction, the tests pass, and **the signal never arrives.** At the surface, a corrupt stored row is byte-identical to an outage; a poisoned-candidate run is byte-identical to a benign empty one; a vetoed egress is byte-identical to one that never happened. **Each was created precisely to be distinguishable from the thing it is now indistinguishable from.**

**Why this passes review, every time.** A producer slice's Done-when is *about the producer* — and it is genuinely met. The consumer is "someone else's slice," so its absence is not a defect **in the work under review**. ⚠ **Two coincidences are a pattern; three, with one already tracked and unfixed, is a systemic gap in how this project ships signals** — not three unlucky slices.

**The tell:** the phrase *"now distinguishable"* / *"now surfaced"* / *"now audited"* appearing in a record whose slice only built the **producer**. Nothing in a green suite contradicts it, because the producer really does produce.

**Do:**
1. ⛔ **A slice that produces a distinguishing signal must NAME ITS CONSUMER — or record the absence as a tracked task in the SAME round.** Producer-first sequencing is correct; **producer-only is a half-shipped guarantee.**
2. **Write the scoped claim, never the unqualified one.** Not *"corrupt rows are now distinguishable"* but *"distinguishable at the repository boundary; nothing surfaces it yet — see task N."* The unqualified form is the [L56](#56) class, and it is what gets quoted.
3. ⭐ **Mechanical hook — `/tdd` Step 7.5 already asks the question and accepts the wrong answer.** *"none — wiring lands in `<slice>`"* is a legitimate Step-7.5 response, but nothing checks that `<slice>` **exists as a tracked task**. ⇒ **When Step 7.5 answers "none," the named future slice must be a real task by the end of that round.** That converts an intention into an artifact ([L51](#51): close-out debt goes in a file, never only in a head or a message).
4. When judging "is this done?", ask **whose eyes** the signal reaches — not whether it is emitted. Kin to [L80](#80) (*a suite must assert that a gate DECIDES, not that a gate SAID NO*): both are the difference between a mechanism existing and a mechanism working.

⚠ **Do not over-correct into blocking producer-first work.** Splitting producer from consumer is right — it is how 13.8m-A/B shipped safely and how the repo avoids dormant-on-dormant wiring ([L11](#11)). **The defect is never the split; it is the unqualified claim plus the untracked consumer.**

`accepted: not mechanically enforceable` for the framing; the **Step-7.5 hook in (3) is the checkable part** — enforcement point: `/tdd` Step 7.5 and `/orchestrate-end` Carry-forward triage.

---

<a id="107"></a>
## 107. Red-first proves the test predates the CODE; an independently-authored cross-area enumeration proves it predates the AUTHOR — so the second can discharge the first's residual

**2026-07-29 · 9.36 · reframes what the TDD gate is FOR**

9.36 shipped with a disclosed TDD deviation: the shared read-gate helper and both adapters were written **before** the dual-dialect tests. The implementer mitigated with mutation verification, which was genuinely strong — reverting one adapter's gate turned exactly the 4 tests that touch it RED while the 3 scoped elsewhere correctly stayed green.

**But mutation verification cannot reach the residual, and the residual is precise:** a test derived from the implementation **encodes** the implementation, and **no mutation OF that implementation reveals it.** Mutation proves **discrimination**; it says nothing about **spec-fidelity**.

> ⭐ **The reframe: red-first is a PROXY, not the property.** What we actually want is *"this test was not derived from the code under test."* **Temporal ordering** (write the test first) is one way to get it. **Independent authorship** is the property itself.
>
> ⇒ **RED-FIRST PROVES THE TEST PREDATES THE CODE. AN INDEPENDENTLY-AUTHORED, CROSS-AREA SPEC ENUMERATION PROVES THE TEST PREDATES THE AUTHOR.** The second is a *stronger* guarantee of the same property — which is why it can **discharge** a red-first residual rather than merely apologise for it.

**How it discharged this one.** The remedy was not "write more fixtures" but a **cross-map** against `packages/contracts/test/models/workspace.test.ts`, which already enumerates every `WorkspaceSchema` constraint class one `it(...)` at a time — `.strict()` unknown key, each branded/enum field, both `min(1)` strings, a missing required field, **both nested aggregates' own invariants**, and the top-level refine **in both directions**. That file is **contracts territory, authored by a different area, for a different purpose** — so it *structurally cannot* have been derived from the worker implementation under test.

⚠ **Not a licence to skip red-first.** It discharges a residual **after the fact**, when an independent enumeration happens to exist; it does not make deviation free. Red-first remains the default because it needs no such coincidence — and forbidden-pattern #1 still applies, with the deviation recorded, its residual named, and this remedy attached (so an accepted-deviation precedent carries its **price**, not just its permission).

⭐ **The deliverable shape matters as much as the source, and "one fixture per class" was the wrong ask.** Several constraint classes are **unreachable in a given context** — a `NOT NULL` column cannot present as a *missing field* in a stored row. So the artifact is a **per-class disposition**: **covered** (name the fixture) · **unreachable-in-this-context BECAUSE …** · **gap**. ⇒ **The "because" IS the artifact, not the fixture count.** It converts *"would I have written these tests the same way before seeing the code?"* — unanswerable introspectively — into a list a reviewer can audit.

**Generalises past tests:** whenever you need *"X was not derived from Y,"* ask whether an **independent author** already produced X for their own reasons. That is stronger than any ordering discipline you can impose on a single author, and cheaper than re-deriving it.

`pin: the cross-map itself is the artifact` · `accepted: not mechanically enforceable` — enforcement point: `/tdd` Step 2.5 when a deviation is disclosed, and Step 9 when it is recorded.

---

<a id="108"></a>
## 108. What a skipped review costs is not a wrong answer — it is an UNASKED ADJACENT QUESTION

**2026-07-29 · 13.8m-C · and it is why "already GREEN, and correct" is not a defence**

Knowledge skipped the `/tdd` Step-2.5 pause: tests written, RED confirmed, implemented, GREEN, mutation-verified — **then** the write-up sent. Self-caught and disclosed, with work stopped before Step 7.

**Reviewing it, everything checked out.** Their central finding was **better than the brief's premise** (the real refusal discard point is `resolveEntity`'s internal `withheld(reason)`, not the `admitInto` call the brief pointed at), and their scope reasoning was sound (not threading three provably-unreachable-to-fail call sites, since speculative guards are the [L75](#75) *"never observed to fail"* shape). The one thing the gate most needed to catch — whether a sibling slice's recorded compromise got inherited ([L105](#105)) — was verified in source and had **not** been.

> ⇒ **So the cost was not a wrong answer. It was the question NEXT TO the answer.** Their narrowing to the two members the field's type admits is correct — and it opens an obvious adjacent question: **the other five union members, do they reach anybody?** One of them is a workspace-isolation signal. At Step 2.5 that question gets asked and costs a sentence. After GREEN it is either a new slice or nothing.
>
> ⛔ **Which is why "the design is already green AND correct" does not defend skipping the review: correctness of the answer GIVEN is not coverage of the answers NOT SOUGHT.**

**And the structural reason the gate sits where it does:** a design reviewed **after** it is green can only be **ratified or rejected wholesale.** Before implementation, a reviewer can cheaply add, narrow, or redirect. Afterwards, every suggestion costs rework, so the reviewer's threshold silently rises and marginal-but-real improvements go unmade. **The review still happens; it just becomes a weaker instrument.**

⚠ **Distinguish two things that share the words "TDD deviation, disclosed":**
| | What moved | What was lost |
|---|---|---|
| **Reorder inside the gate** (9.36) | tests after code, **Step 2.5 still happened** | spec-fidelity — addressable, see [L107](#107) |
| **Skip the gate** (13.8m-C) | **no pre-implementation review at all** | the adjacent questions — **not** recoverable, only substitutable |

⇒ **Do not let one's precedent cover the other.** The remedy for a skipped gate cannot be the remedy for a reorder: here it was *"answer the question Step 2.5 would have asked, from source, and don't fix it in this slice"* — which substitutes for the lost review without pretending to restore it.

⚠ **And the trend rule, because two in one round is a trend:** **disclosure is what makes a deviation ASSESSABLE; it is not what makes it acceptable.** Both deviations were disclosed and self-caught, which is strictly better than silence — but if disclosure becomes most of the mitigation, the gate is softening, and a third instance is a **finding**, not three one-offs.

`accepted: not mechanically enforceable` — enforcement point: the reviewer, at the moment a Step-2.5 write-up arrives describing completed work. Name what was lost, not just what was disclosed.

---

<a id="109"></a>
## 109. A CHECK CHAINED INTO THE ACTION IT GUARDS IS NOT A GATE — it prints, it cannot stop

**2026-07-29 · self-inflicted and self-caught, on the exact hazard banked earlier the same round**

The shared-tree commit discipline is three steps: `git diff --cached --name-only` **before**, chained `add && commit`, `git show --stat` **after**. Committing an `ARCHITECTURE.md` note, all three ran — and **14 of another implementer's in-flight, already-staged files landed inside a `docs(arch)` commit.**

**The pre-check WORKED. It printed the dirty index, correctly and completely.** It could not act, because it was **inside the same shell invocation as the commit**:

```sh
echo "=== PRE-STAGE ==="; git diff --cached --name-only   # printed 15 foreign files
git add ARCHITECTURE.md && git commit -q -F - <<'EOF'     # ran anyway
```

> ⇒ **A check whose output the actor reads only AFTER the action is not a gate; it is a receipt.** The `&&` chains **add → commit**; nothing chains **check → add**. And step 3 (`git show --stat` after) reports the damage **as history**, which is the one form in which it is most expensive to fix.

⚠ **This is the same defect as the round's earlier "an assertion that aborts a step but not the pipeline is a warning, not a gate,"** and it survived being banked because that entry was read as being about *failed edits*, not about *the checkpoint's own placement*. **Recording a hazard does not immunize you against its other shape.**

**THE FIX IS STRUCTURAL, AND IT IS THE HOUSE PATTERN ([L103](#103)) APPLIED TO THE COMMIT ITSELF:**

```sh
git commit -F <msg> -- <paths>      # pathspec-limited: commits ONLY these paths
```

⭐ **`git commit -- <paths>` commits exactly those paths regardless of what else is staged.** The foreign-file sweep stops being *detected* and becomes **unrepresentable** — the index's contents can no longer influence the commit's contents. No discipline, no ordering, no reading of output required. ⇒ **In a shared checkout, pathspec-limit every commit.** (This was already recorded once as a mitigation and had not been adopted as the default; adopting it is the actual remedy — see [L110](#110).)

⚠ **ONE LIMIT, AND CARRY IT WITH THE RULE OR SOMEONE WILL CONCLUDE THE FORM IS BROKEN AND REVERT TO THE DETECTOR** (found by desktop-implementer shipping under it): **`git commit -- <path>` cannot pick up an UNTRACKED file** — a brand-new file still needs `git add` first.
> ⇒ **This does NOT weaken the guarantee.** The `add` makes the file **visible**; the pathspec **on the commit** remains the **filter**. So a foreign staged file still cannot enter the commit — **unrepresentability holds in full.** What is lost is only the *convenience* of never needing an `add`, not the property. ⇒ For a slice adding new files: `git add <your new paths>` **then** `git commit -F <msg> -- <your paths>`.

⛔ **THE SECOND-ORDER LIMIT, AND IT BIT THE SAME DAY THE FIRST WAS BANKED — `git commit -- <path>` FILTERS BY PATH, SO IT DOES NOTHING ABOUT A CONCURRENT WRITER EDITING THE *SAME* PATH.** Committing a pathspec-limited `IMPLEMENTATION_PLAN.md` change, the orchestrator swept in the **lead's uncommitted edit to that same file** (a bullet they had just added while writing the round handoff). Nothing was lost, but it landed under a commit message that never mentioned it — and it pushed a capped section over its limit, turning `plan-lint` red.
> ⇒ **Unrepresentability holds for foreign FILES; it does NOT hold for foreign CHANGES TO YOUR OWN FILES.** The pathspec is a **file**-level filter, and a shared doc has **no** file-level protection at all. ⇒ **For a file more than one role writes** — the tracker, an area's `LESSONS.md`/`CLAUDE.md` — the pathspec buys you nothing, and the only real mitigations are the ones already known: **commit promptly so the window is seconds** ([L110](#110)'s adopt-the-default reasoning), and **read `git diff <path>` before committing** to see whose changes are actually in there. ⚠ **Do not let "I pathspec-limited it" stand in for that check on a shared file** — that substitution is what happened here.

**Secondary fixes, for when pathspec-limiting is unavailable:**
- Put the pre-check in a **separate invocation** and read it before the next one. Cheap, and it restores the check→act ordering.
- Or make it **fail-closed in-line**: `[ -z "$(git diff --cached --name-only)" ] && git add … && git commit …` — so a dirty index *aborts* rather than *narrates*.

**The repair, recorded because it is non-destructive and worth knowing:** `git reset --soft HEAD~1` (moves HEAD; **working tree untouched**) → `git restore --staged <foreign paths>` (**index only**; a new file returns to untracked) → re-commit pathspec-limited. Nothing was lost. ⚠ **Then tell the owner of those files to verify their own diff** — they are the only one who knows what it should contain, and a silent partial is precisely what this class produces.

⚠ **Zsh footgun met during the repair, worth its own line:** `git restore --staged $PATHS` **failed** because **zsh does not word-split unquoted parameter expansions** — the whole list arrived as one pathspec. It failed *loudly* (`did not match any file(s) known to git`), which is the good direction; in a script that ignored the exit code it would have silently unstaged nothing while reporting success. **List paths explicitly, or use an array.**

`pattern: git log --format='%H %s' -20 | …` — not reliably greppable after the fact. **Enforcement is the habit: `git commit -- <paths>`.** `accepted: not mechanically enforceable`, but the pathspec form makes the failure mode structurally unreachable, which is stronger than enforcement.

---

<a id="110"></a>
## 110. A MITIGATION RECORDED AS AN OPTION IS NOT A MITIGATION — if it is the right default, make it the default in the same edit that records it

**2026-07-29 · the third distinct shape of [L89](#89) in one round, and the purest**

`git commit -- <paths>` — pathspec-limiting, which makes a foreign staged file **structurally unable** to enter a commit — **was already in this project's record as a mitigation.** It had been written down, correctly, as one available option among several. **It had never been adopted as the default.** Then an orchestrator commit swept 14 of another implementer's staged in-flight files into a `docs(arch)` commit ([L109](#109)) — a failure the recorded mitigation would have made impossible.

> ⇒ **The remedy was in the record, correct, and inert.** Nothing was missing, nothing was wrong, and it protected nobody — because it was filed as a *thing you could do* rather than as *the thing we do*.

⭐ **Three distinct shapes of L89 in a single round, worth naming together because the differences are what make each escapable:**

| Shape | What the record did | Why it failed |
|---|---|---|
| **Recorded but UNBELIEVED** | correctly documented `lint` as typecheck-only | the false green kept being read as evidence; a whole round said "lint clean" |
| **Recorded but OTHER-SHAPE** | *"an assertion that aborts a step but not the pipeline is a warning, not a gate"* | filed as being about failed **edits**; could not prevent its sibling about **checkpoint placement** ([L109](#109)) |
| **Recorded but NEVER ADOPTED** ⭐ | pathspec-limiting, as an option | an option is not a default; the author of the next commit had no reason to reach for it |

**Do:** when routing a mitigation at Step-9, ask **"is this the right default?"** If yes, **change the default in the same edit** — the convention, the template, the command you actually type — not only the lesson describing it. If the answer is *"it depends,"* say **on what**, because an unconditioned option will be read as optional forever.

⚠ **The general form, and it is uncomfortable:** **a record's job is not to be true. It is to change what happens by default.** A true, correct, well-written entry that leaves the default untouched has bought nothing but the ability to say it was known — which is worse than not knowing, because it converts a surprise into a foreseeable omission.

⭐ **Corollary that generalises past commits:** where the mitigation is *structural* (a pathspec, a closed literal, an absent parameter, a required field), adopting it as the default is nearly free — this is [L103](#103)'s make-it-unrepresentable applied to **process**. Where it is *behavioural* ("remember to check X"), adoption is expensive and unreliable, which is itself an argument for finding a structural form first.

`accepted: not mechanically enforceable` — enforcement point: `/tdd` Step-9 routing and `/orchestrate-end`, at the moment an enforcement line is written. **A `pattern:` or `pin:` that names an option rather than a default is this defect.**

---

<a id="111"></a>
## 111. A RETRACTION IS A CLAIM — and an INTERMITTENT failure is the perfect trap for a premature one

**2026-07-29 · I retracted a correct doubt, on evidence I had explained away, and an implementer caught it by re-verifying instead of deferring**

An implementer's preflight reported root **`pnpm lint`** failing and used `npx turbo run lint` instead. I relayed the doubt to the lead. The lead ran `pnpm lint`, got **11/11 successful**, and retracted it. **I then verified the retraction — and "confirmed" it — and the retraction was WRONG.**

**What is actually established** (all unpiped exit codes, two independent operators):
- root `package.json:12` = `"lint": "turbo run lint"` — the script does delegate to turbo.
- **`pnpm lint` fails INTERMITTENTLY**, *before turbo starts*, with `ESLint output (JSON parse failed…)` / `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "eslint" not found` — the implementer reproduced it at **exit 1**, and **my own first run produced byte-identical output**.
- `pnpm --filter . run lint` and `npx turbo run lint` succeed, **11/11 exit 0**, in the same shell, same session.
- **All 11 packages' `lint` is literally `tsc --noEmit`; `eslint` appears in ZERO workspace manifests** — so the eslint reference cannot originate in a package script, and the *recursive*-exec error says bare invocation isn't running the root script at all. **Cause unidentified; deliberately not chased.**

> ⛔ **HOW I GOT IT WRONG, AND THE MECHANISM IS THE LESSON: I dismissed real evidence because it disagreed with a conclusion I had just formed.** My run 1 failed; my run 2 of the *same command in the same shell* returned 11/11. **I treated run 2 as the truth and run 1 as an artifact of my own tooling** — reasoning that no manifest references eslint, so the text "couldn't be real."
>
> ⭐ **An INTERMITTENT failure is the ideal trap for this, because a second run genuinely does "disprove" the first — and the disproof is worthless.** Two runs disagreeing is evidence of **non-determinism**, never evidence that the failing run was fictitious. **The correct read of "it failed, then it passed" is "it is flaky," not "it passes."**

**Separate RAISING from CORROBORATING — they are different acts with different standards** (this distinction is the lead's, and it corrects an earlier over-broad version of this entry):
| Act | Verdict | Why |
|---|---|---|
| **Raising** an unverified doubt to someone who can verify it | ⭐ **CORRECT** | that is what the escalation channel is *for*; a teammate who sits on a doubt until it is substantiated is strictly worse, and this round repeatedly depended on that channel working |
| **Corroborating** it with support that does not hold | ⛔ **the defect** | it converts "please check this" into "this is established," and it spends the verifier's budget on a false premise |

⚠ **So do NOT read this as "don't raise doubts."** An earlier draft of this entry said escalating-without-banking was *"the same claim in a channel with fewer witnesses."* **Too strong, and actively harmful if followed** — it teaches suppression of exactly the signal that caught this. The defect was never the raising.

⛔ **THE PIPE TRAP CAUGHT BOTH INVESTIGATORS WITHIN FIFTEEN MINUTES, and this is worth more than either self-criticism:**
- I ran `pnpm lint 2>&1 | tail -8` then printed `$?` — **which is `tail`'s status, not `pnpm`'s.** I reported an exit code I had not measured.
- The lead ran `pnpm lint 2>&1 | tail -6; echo "exit=${PIPESTATUS[0]}"` and got **`exit=` — empty**. They noted it as instrument imprecision and moved on.
- **The lead reached a defensible answer only because they had a second, independent signal** (the `11 successful` line plus visible `tsc --noEmit`). ⇒ **Redundancy separated the two outcomes, not care.**

> ⇒ **`cmd | tail` discards the exit status you care about. Redirect (`cmd > f 2>&1; echo $?`) or index `PIPESTATUS` correctly — and if the exit code prints EMPTY, that is a failed measurement, not a minor imprecision.**

⭐ **AND THE DURABLE FIX IS ABOUT EVIDENCE CLASS, not care — make the evidence unrepresentable-as-wrong ([L103](#103) applied to evidence):** the finding that actually mattered — **lint means typecheck and nothing more** — never depended on any of this. It rests on **script inspection**: 11 scripts, all `tsc --noEmit`, no ESLint anywhere, no `format:check`. **An inspectable fact cannot be re-opened by a flaky execution; a run's exit code can.** ⇒ **Prefer inspectable evidence over executed evidence for any durable claim.** Exit codes and run output are **receipts**; the script definitions are the **gate**.

**Counter-consideration, stated as reasoning rather than as demonstrated here** — because this instance shows the *opposite*, and pretending otherwise would be the defect this entry is about: a **false doubt** is also costly, and differently from a false claim. A false claim is specific and checkable, so someone kills it; a vague doubt is unfalsifiable as stated and lingers, and **a distrusted-but-working gate is worse than a known-broken one, because it gets bypassed *and* never replaced.** ⇒ **Both directions have a false-positive rate. Skepticism is not free — but neither is dismissal, and THIS time dismissal was the error.**

⚠ **Meta, and it is the round's own trap: a round spent almost entirely on over-claims trains a suspicion reflex, and that reflex is an over-claim generator pointed the other way** — including inward, at one's own correct work. The reflex fired here twice: once as an over-harsh self-criticism the lead had to reject, and once as the over-confident retraction above.

`accepted: not mechanically enforceable` — enforcement points: **(1)** any message questioning *or* retracting an existing claim must carry the command, the output, and a **real** exit code; **(2)** two runs disagreeing ⇒ report **flaky**, never **passing**; **(3)** prefer inspectable over executed evidence in anything durable.

---

<a id="112"></a>
## 112. AN IN-FLIGHT MESSAGE IS INDISTINGUISHABLE FROM AN ABSENT ONE AT THE OBSERVATION POINT — so a stall check detects a WAITING STATE and cannot diagnose its CAUSE

**2026-07-29 · the lead's own instrument, corrected by its author after banking a false positive as a success**

A three-way wait was diagnosed from three signals read together: the task still `in_progress` with its owner assigned · the owner idle for ~4 minutes · two uncommitted files whose newest write was ~6 minutes stale. The conclusion — *"every party correctly believes it is blocked on someone else, and the relay never came"* — was **wrong**: the relay had already been sent and was **in flight while the measurement was being taken**.

> ⇒ **The three signals cannot separate "blocked" from "resolution in transit,"** because the distinguishing information lives in a channel the observer cannot see. ⭐ **So the check has an IRREDUCIBLE false-positive rate proportional to message latency, and NO additional signal fixes it** — adding a fourth observable does not help when the missing fact is unobservable in principle from that vantage point.

**The honest form of the instrument:**
- ✅ **It reliably detects a WAITING STATE.** Task-owner + idle-time + file-mtime read *together* is genuinely better than reading the quiet, and it beats each signal alone.
- ⛔ **It cannot diagnose the CAUSE of that state.** *"Someone is waiting"* is supported; *"X never sent Y"* is not.
- ⇒ **Therefore it warrants a QUESTION, never an ACCUSATION.** *"Is anyone blocked on me?"* costs one message and is right either way. *"The relay never came"* was an accusation, and it was false.

⚠ **And the ledger error is the more instructive half:** this was recorded as *"the first time the stall check fired on a REAL stall"* — after two earlier false positives. **It was the third false positive.** ⇒ **A monitoring instrument's own success ledger needs the same verification as any other claim** ([L111](#111)), and it is *especially* prone to inflation, because the operator both raises the alarm and grades it. **A check that grades its own hit rate will report a better one than it has.**

**Generalises past messaging:** any observation-point check on a distributed system shares this shape — a queued job, an unflushed buffer, a request in the network. **"I cannot see it" and "it does not exist" are the same observation and different facts.** Kin to [L100](#100)'s negative claims (an absence is only as strong as the scope that looked) and to [L91](#91) (a stall's signature is the absence of a signal — true, and the reason this instrument is needed *and* the reason it cannot be conclusive).

`accepted: not mechanically enforceable` — enforcement point: the wording of the alarm itself. **Phrase a stall report as a question about state, never as a claim about someone's action;** and when logging whether the check "worked," verify the outcome before crediting it.

---

<a id="113"></a>
## 113. A lead's RULINGS need the same adversarial channel its CLAIMS have — the person who cannot audit a decision is the person who made it

**2026-07-29 · the round's capstone, requested by the decider whose judgement it indicts**

This round produced **ten overturns** of a reader further from the evidence by a reader closer to it. **Nine covered CLAIMS. Exactly ONE covered JUDGEMENT — and only because the decider asked for it.**

**Why claims got corrected and decisions did not.** The machinery that made claim-overturns cheap was one convention: **every brief and finding cited a falsifiable `file:line`**, so anyone with the file open could contradict it in one command. ⛔ **That machinery has no analogue for a decision.** A ruling — *hold contract · no 4th adversarial pass · Option A over Option B · not this round* — cites **reasoning**, not a checkable premise. There is nothing to grep. So the only person positioned to price it is **whoever bore its cost**, and that person is structurally not the one who chose.

> ⭐ **THE PERSON WHO CANNOT AUDIT A DECISION IS THE PERSON WHO MADE IT, AND THE ONLY CORRECTION AVAILABLE COMES FROM WHOEVER BORE ITS COST.**
>
> **A hold's cost is invisible to whoever imposed it.** So is a deferral's, a scope cut's, an ordering constraint's, a *"not this round."* The decider sees the risk avoided; only the held party sees the hour.

**The instance.** contract-implementer was held idle for over an hour by lead ruling, to keep two writers off the contract/db seam while 9.36 was live. Asked — **specifically**, in those terms — whether the hold had been *wrong*, they **read `be62e348`'s actual diff** rather than agreeing: it rewrote `packages/db/src/repositories/interfaces.ts`, added the read-gate adapter, touched both dialects' schema, and contained **zero `packages/contracts/**` files.** ⇒ **The hold was right for a MORE PRECISE reason than the one given** — the contention surface was never the contracts layer, it was the repository-interface file one layer down. **Sharpened, not ratified**, and the next dispatch inherits a named file instead of an approximation.

⚠ **The uncomfortable half: it only happened because the decider asked.** Contract had formed no view during the hold, had no channel to raise one, and investigated *when prompted*. ⇒ **A low correction rate on judgement is not evidence that judgement is better than claims. It is evidence that nobody is checking.**

**Do:**
1. **When a ruling imposes a cost on someone — a hold, a deferral, a scope cut, an ordering — ask the party who bore it to price it, AT CLOSE-OUT**, which is the last moment before the state is recoverable.
2. ⛔ **Ask the SPECIFIC question, not a generic one.** *"Anything unfiled?"* got *"nothing unfiled."* *"Was this hold wrong — was the collision real, would the work have parallelised safely, did you form a view you didn't state?"* got a diff read. **The generic prompt is not a weaker version of the specific one; it is a different question, and it reliably returns nothing.**
3. **Record the answer as a PRICED decision** — including *"it was right, for this narrower reason,"* which is the common and most useful outcome.

⚠ **Limit, so this does not become paralysis:** this is **not** *"distrust every ruling."* A decider who re-litigates every call stops deciding, and most rulings this round were right. The ask is **one bounded question, once, at a boundary, to the one party who paid** — cheap enough to be routine, and it is the only correction channel that exists for judgement.

**Kin:** the reader-with-the-file-open asymmetry (this entry is that asymmetry pointed at **decisions** rather than **claims**) · [L100](#100)'s fourth mechanism in a *process* decision (a cost estimated without being measured) · [L112](#112) (an instrument that grades its own hit rate will report a better one than it has — the same self-assessment defect, one level up).

`accepted: not mechanically enforceable` — enforcement point: `/orchestrate-end` close-out, and the escalation taxonomy. **A hold or deferral should carry a price-it-back step the way a Step-9 flag carries a routing destination.**

---

<a id="114"></a>
## 114. A function that returns a SAFE DEFAULT with a SUCCESS FLAG destroys the caller's ability to distinguish causes — the information is gone AT THAT FRAME, not merely unlogged downstream

**The shape:** every failure branch returns `{ok: true, value: <safeDefault>}` — the `!isOk(...)` guard and the `catch` both. The posture is correct, the return type is honest about *what it is*, and the **cause is annihilated**.

**Instance (task 9.38, `apps/worker/src/boot.ts` `egressStatus`).** 9.36 had just done the hard part: it re-gated the stored `Workspace` aggregate at the repository boundary and minted a **distinguishable, permanently-non-retryable** `stored_row_schema_violation`. `egressStatus` then did `if (!isOk(got)) return {ok:true, value: failClosedEgress(wsId)}` — **with no inspection of `got.error.code` at all** — and folded a thrown outage to the *same* value. So a corrupt row, an absent workspace, and a store outage were **byte-identical at that surface**, and because the frame reported **success**, the caller could not tell either. The operator could not see the corruption they were required to repair.

⛔ **WHY THIS IS NOT [L106](#106), and the difference dictates the remedy.** L106 is *produced-and-dropped*: the signal exists, travels, and reaches no consumer — so the fix is **add a consumer**. This is *never-produced*: the distinction is destroyed **at the frame**, so there is nothing downstream to consume and **no consumer can be added later.** ⇒ **L106's remedy is unavailable here by construction.** Conflating the two sends you looking for a reader that could not exist.

⚠ **And the remedy that suggests itself is also unavailable: you cannot "widen the error path," because there is no error path** — the function returns `ok`. **You must ADD a channel** (a health item, an audit signal), which is a different and larger change than it looks from the call site.

⭐ **THE TRAP, and why this survives review: the safe default is CORRECT, so the code reads as careful — and it *is* careful, about the posture.** Fail-closed is exactly right; nothing about it should change. The carelessness is entirely about **observability**, and **the safe default is precisely what makes the information loss invisible** — there is no failing test, no error log, no unhappy path to notice. **Correct-and-safe is not the same as observable**, and a reviewer checking the invariant will find the invariant honoured.

⛔ **The one wrong fix, stated because it is the tempting one:** do **not** buy visibility by weakening the safe default (returning `ok:false`, or making the posture depend on the failure class). The correct fix is **orthogonal** — leave the return byte-identical on every branch and mint the distinction **beside** it. 9.38 pins the return byte-identical across absent/corrupt/outage precisely so that trade becomes unrepresentable rather than merely discouraged.

**Tell:** a read port whose every failure branch returns a success. Grep the `catch` blocks and the `!isOk` guards of anything that serves a posture, a status, or a projection.

⚠ **Residual honesty requirement.** Adding the channel for *one* cause does not restore the others: after 9.38, an **outage still mints nothing**, so absence-of-signal continues to conflate *healthy* with *outage*. That was pre-existing and is not worsened — but it must be **stated**, because the natural reading of "we now surface corruption" is "we now surface failures." Fixing the outage case was declined for a real reason, not a scheduling one: **there is no reliable outage signal to key on without risking a false corruption report**, which would trade a true-positive guarantee for a false-positive risk.

**Kin:** [L106](#106) (the same wire, a different break — and the remedies do not transfer) · [L100](#100)'s family of claims that pass every check while measuring the wrong thing · the *make-the-violation-unrepresentable* posture applied to a **trade-off** (the byte-identical pin) rather than to a type.

`pattern: rg -n 'catch[^{]*\{[^}]*ok:\s*true|!isOk\([^)]*\)[^{]*\{[^}]*ok:\s*true' apps/worker/src packages/*/src` — warn-grep at `/preflight`; a hit is not automatically wrong (a deliberate best-effort fold is legitimate) but **must carry an in-code note saying which causes it collapses and why that is acceptable.**

---

<a id="115"></a>
## 115. A TOTAL function over `unknown` costs nothing at the definition site and is paid back at a call site its author could not have known would exist

**Date:** 2026-07-31. **Source:** 13.8g-B brief authoring (orchestrator), from 13.8g-A's `7dfd03d3` a round earlier. **Extends [L103](#103)** — the same posture, arriving through a *signature* rather than through an unrepresentable state.

13.8g-A's author wrote `normalizeAttendees(raw: unknown): AttendeeNormalization` (`packages/knowledge/src/synthesis/attendee-refs.ts:171`) — TOTAL, never-throws, `Array.isArray` guard first, returning the empty normalization on anything that is not a string array (`:172-173`). At the time the only imagined caller was a raw meeting-record attendee list. **That list turned out not to exist anywhere in the codebase.** A round later the real call site materialised as `ValidatedExtraction.fields["attendees"]?.value` — a *post-model, schema-gated* `ExtractionField<unknown>` whose `.value` may be a string, an array, the `TBD` sentinel, or absent: **four shapes, none of them the one the function was written for.**

⭐ **And the wiring needed ZERO new guards.** Not because anyone anticipated this call site — nobody could have — but because a function that is total over `unknown` has already answered *every* "what if the caller hands me something else" question in advance. Had the signature been the "obvious" `normalizeAttendees(raw: readonly string[])`, the corrected path would have required a shape probe, a `TBD`-sentinel check, an array coercion, and a decision about what to do with each failure — **four new branches, each a place to get the fail-safe direction backwards**, written by someone under pressure to make a dispatch work.

⇒ **The general claim, and it is about ECONOMICS rather than taste: at the definition site, accepting `unknown` and being total costs one `Array.isArray` and an empty-value constant. At an unanticipated call site it saves a branch per shape the caller might hold — and unlike the definition-site cost, the call-site cost is paid by someone who does not have the function's invariants in their head.** The asymmetry is the whole argument. This is why [L103](#103)'s posture generalises past types: *make the bad input unrepresentable* and *make every input representable-and-handled* are the same move seen from the two sides of a boundary.

⚠ **The limit, so this is not read as "type everything `unknown`":** it applies at a **trust boundary** where the input genuinely is untrusted or its shape is genuinely not yet known — a parser, a normalizer, a gate, an adapter over content the process did not author. **Inside** a boundary, `unknown` erases a real compile-time guarantee and is strictly worse ([L80](#80): add a case, do not weaken a claim). The test: *would a caller handing me the wrong shape be a BUG in the caller, or a fact about the world?* Bug ⇒ type it precisely. Fact about the world ⇒ `unknown` + total.

⭐ **Why it is worth banking as EVIDENCE and not as principle:** this project already believed the house pattern. What it did not have was a case where the payoff was **collected by a different person, a round later, on a call site nobody had imagined** — which is precisely the payoff shape that never shows up in the slice that pays the cost, and therefore the one that gets argued away when someone asks whether the extra guard is worth it. **It was worth it, and here is the receipt.**

`accepted: not mechanically enforceable` — enforcement point: `/tdd` Step 2.5, when reviewing any new function that takes external/untrusted/not-yet-shaped input. Ask whether a wrong shape would be the caller's bug or the world's fact.

---

<a id="116"></a>
## 116. In a hub-and-spoke team, authority attaches to the SPEAKER, not to the claim — so a relay arrives wearing the relayer's confidence rather than its source's

**Date:** 2026-07-31. **Source:** two same-day instances, both self-reported by the lead. **Complements [L113](#113)** — that one says a ruling needs a challenge channel; this one says you must first be able to tell a ruling from a relay.

**Instance 1:** the lead read `IMPLEMENTATION_PLAN.md:68`'s *"head of queue is 9.41 leg B"* and restated it to the orchestrator as fact. The orchestrator nearly briefed it **as the lead's ruling** — which would have made a stale tracker line unchallengeable, since nobody contradicts the lead on a sequencing call. Caught only because the lead retracted it unprompted: *"the sequencing call is YOURS."*
**Instance 2:** the orchestrator offered a **preliminary, unverified** observation (*"the click→fetch→render interaction has no built precedent"*). The lead restated it as an instruction — *"carry that caveat INTO the brief."* On checking, **two thirds of the interaction was already built.** Carrying it would have told an implementer to design from scratch around working machinery.

⇒ **The mechanism is structural, not a failing of anyone's diligence.** In a hub-and-spoke team every fact reaches the spokes through one node, and **confidence is attached by the last speaker rather than carried from the origin.** A tracker line worth 60% and an unverified aside worth 30% both arrive at 100% once the lead has said them — and the recipient cannot see the difference, because the two look identical on the wire. **Neither instance involved anyone stating something they believed to be false.**

⭐ **THE STANDING RULE (the lead's — reworded out of first person, NOT a verbatim quote): when the lead restates something a document or a teammate said, that is a POINTER, not a ruling — treat it with the confidence its ORIGINAL source had, which is often less than the relay sounds. A real ruling says it is a ruling and carries a reason.** The presence of a reason is the discriminator, because a relay has nothing to give one from. *(⚠ The "not verbatim" note is not pedantry: this lesson's own subject is claims arriving with more authority than they earned, so labelling a paraphrase as a quotation would be the lesson committing itself.)*

⚠ **The two failure directions are not symmetric, and the second is the expensive one.** A relayed **false claim** gets checked against code and dies cheaply. A relayed **false doubt** ("there's no precedent for X") makes someone **rebuild working machinery** — nothing contradicts it, because the absence it asserts is exactly what nobody goes looking for. **[L111](#111) applied to the coordination layer:** a false doubt is unfalsifiable as stated and therefore lingers, and it costs most when it arrives with authority attached.

⇒ **Obligations, both cheap:** the **relayer** marks a relay as a relay (*"the tracker says…"* / *"you said earlier…"*) rather than absorbing it into their own voice — one clause; the **recipient** verifies a relayed premise before acting on it exactly as they would a brief premise ([L81](#81)), and **reports back when it fails**, since the relayer holds the same wrong picture and will otherwise repeat it. Both instances here were closed by the recipient looking rather than complying.

`accepted: not mechanically enforceable` — enforcement point: any message that will become a brief premise or a dispatch decision. **The tell is the missing reason: if you cannot say WHY, you are relaying.**

⭐ **THIRD INSTANCE, 2026-07-31 — THE DOWNWARD FACE, and it is arguably the costlier one.** The two instances above are lead→orchestrator. The same defect points **down** the hierarchy: an orchestrator, reviewing an implementer's Step-2.5, was one keystroke from sending *"the absent-flag fixture is missing — add it."* **It was not missing** (`packages/workflows/test/source-living-vault-binding.test.ts:381-393`, `unknown_approval_flag_fails_closed`, which deletes `requiresApproval` and asserts not-committed). Caught only by reading the file before sending. ⛔ **And the detail that makes it worth recording: that fixture was the very thing making the implementer's planned mutation-verification NON-VACUOUS** — relaxing a strict `!== false` to a truthy check is indistinguishable from the original when every fixture carries `true`, so without the absent-flag case the mutation would have proved nothing. **The doubt would have attacked the exact thing making their test good.**

⇒ **Why downward is worse than upward, and it is structural rather than a matter of degree:** a false doubt aimed at a subordinate **burns their round-trip AND trains them to over-defend correct work** — and **nothing checks it**, because the one person best placed to refute it is the person being doubted, who must now argue against a reviewer who has already written the finding down. Upward, a relayed doubt meets someone with standing to push back; downward it meets someone with a reason not to. **Hold a doubt you are about to send DOWN to a strictly higher evidentiary bar than one you send up** — the asymmetry of who can safely contradict it is the reason.


---

<a id="117"></a>
## 117. After a session death, run TWO checks — a diff is structurally blind to untracked files, and the file it cannot see is the only one with a real loss vector

**Date:** 2026-07-31. **Source:** `worker-implementer`'s turn died on an API 529 mid-slice on 13.8i (a §9.8 Approvals safety slice). **Companion to [L83](#83)** (shared-tree state) and [L100](#100) (a claim inherits its check's scope).

Recovery reported *"369 insertions across 4 files, all present"* — and the arithmetic was exact. **A fifth artifact existed and was not in that number:** an **untracked** 152-line test file containing the slice's highest-value test (the one driving the *real* propose sink twice to prove the adapter did not mangle its idempotency). `git diff --stat` cannot see an untracked file, so a complete-looking inventory was structurally incomplete.

⇒ **THE PROCEDURE, after any session death, crash, 529, or abrupt teardown — BOTH, always:**
```sh
git diff --stat                              # modifications to TRACKED files
git ls-files --others --exclude-standard     # what the diff is structurally blind to
```
**Then stage the untracked work immediately.** Staging costs nothing and **removes the only real loss vector** — a tracked modification survives almost anything short of a hard reset, while an untracked file is one careless `git clean` or `git checkout` from gone.

⭐ **THE REPORTING DEFECT, self-diagnosed by the lead and sharper than the procedure:** *"I ran two checks and reported one."* Both checks had in fact been run — all five files were stat'd — but the **summary** merged a 4-file `diff --stat` with a 5-file existence check into a single number, **and the number is what travels.** ⇒ **A summary that silently spans two different scopes is worse than either check alone**, because the merged figure carries the authority of both while covering neither. Same defect as [L100](#100)'s unscoped negative, relocated from a search into a status report.

⭐⭐ **AND THE DEEPEST VERSION, which is the reusable one: "I checked PRESENCE and reported SAFETY, and those are not the same property."** The file was *there* — that was true and verified. Whether it was *safe* is a different question with a different answer, and nothing in the presence check speaks to it. ⚠ **This generalises far past git:** a service that responds is not a service that is healthy; a row that exists is not a row that is valid; a test that runs is not a test that discriminates. **Whenever you report reassurance, name the property you actually measured** — the gap between the measured property and the reassuring one is where every false green in this project has lived.

⚠ **Corollary for the recovery message itself:** tell the interrupted party what you verified *and how*, so they do not reconstruct work that is sitting on disk — but do not let "your work is intact" outrun the check that established it. The honest form names the artifacts and their **risk state**, not just their existence.

`accepted: not mechanically enforceable` — enforcement point: any crash/teardown recovery, and any message asserting that someone else's in-flight work survived.


---

<a id="118"></a>
## 118. ⭐ THE FAMILY: A PROXY STANDING IN FOR THE PROPERTY — the round's unifying defect, banked as a family because the remedies differ but the DETECTION QUESTION is identical

**Date:** 2026-07-31. **Banked at the lead's instruction** after three instances surfaced in one evening and a back-reading found the day's earlier findings were the same shape. ⛔ **This is an INDEX, not a new rule** — each member below has its own entry and its own remedy. What generalises is **how you notice**.

**THE SHAPE.** You need to know property **P** (is it safe? is it done? is it necessary? is it covered?). **P** is expensive or awkward to measure. A **proxy Q** is cheap and to hand (does it exist? how many lines? where is it conventionally done? did the command exit 0?). **Q correlates with P almost always — which is exactly why substituting it is invisible.** You measure **Q**, and then you *report* **P**. The substitution fails precisely where the correlation breaks, and **that case is disproportionately the interesting one**, because a correlation that holds everywhere boring is what made **Q** look safe to use.

**MEMBERS FROM THIS ROUND** — each `Q → P`, with where it broke:
- **presence → safety** ([L117](#117)): five files stat'd and all present; the fifth was **untracked**, i.e. present and *not safe*. "I checked presence and reported safety."
- **lines changed → progress** (2026-07-31, orchestrator): a wake message told an implementer *"resume at Step 3/4"*, inferred from `git diff --stat`. It was at **Step 8** — GREEN done, suite run, safety pin mutation-verified. The diff cannot see finished work that produced no further lines.
- **conventional location → necessary location** (2026-07-31, orchestrator): Step-8 reviewer dispatch was treated as bound to the implementer's session **because that is where the step lives**. A reviewer needs the **diff and the brief**; the session is convention, not dependency. This one *cost an option* rather than producing a false claim — the failure mode of a proxy is not always a wrong answer, sometimes it is an unconsidered one.
- **a gate that runs → a gate that checks** ([L89](#89)): `lint` is `tsc --noEmit`; the command exits 0 and the property it names was never evaluated.
- **a test that runs → a test that discriminates** ([L75](#75), [L84](#84), [L90](#90)): green because unasserted, or unreached, or because no fixture fed the triggering input.
- **the tracker says X → X is true** ((a0)(viii), both faces): work correctly recorded but unqueued; and a task whose recorded scope would produce a defect if followed.
- **a summary → what it summarises** ((a0)(viii)'s table face): *"Phase 25 · knowledge · open · 6"* answering *"does knowledge have work?"* with **yes, six**, while all six are another track's.

⇒ **THE DETECTION QUESTION, and it is the only part that transfers: NAME THE PROPERTY YOU ACTUALLY MEASURED, THEN ASK WHETHER IT IS THE PROPERTY YOU CARE ABOUT.** Not *"is my check correct?"* — every check above was correct. **The proxy is not wrong; it is answering a different question than the one being reported.** ⭐ The tell is a sentence where the verb of measurement and the noun of the claim disagree: *"I stat'd the files, so the work is safe."* *"The diff shows 369 lines, so it is at Step 4."* *"Turbo exited 0, so it lints."*

⚠ **WHAT DOES NOT GENERALISE — do not turn this into "distrust proxies."** A proxy is usually the right tool: measuring **P** directly is often impossible (you cannot measure "this test discriminates" without mutating), and a cheap correlated signal is how anything gets checked at all. ⛔ **The rule is not "stop using proxies." It is "report the proxy, not the property"** — say *"five files present, one of them untracked"* rather than *"work is safe"*; say *"369 lines across 4 tracked files"* rather than *"at Step 4."* **A stated proxy invites the reader to notice the gap; a proxy reported as the property closes the question.**

⭐ **Why a family rather than a rule: the REMEDIES have nothing in common.** L117's is a second git command; L89's is renaming a script; L75's is mutation; (a0)(viii)'s is a sweep over a bounded set. **Only the noticing is shared** — which is why collecting them earns its keep, and why fixing them one at a time never surfaced the pattern. **Three appeared in one evening because someone was finally naming the measured property out loud each time.**

`accepted: not mechanically enforceable` — necessarily; a check for this would itself be a proxy. **Enforcement point: any sentence that reports reassurance, status, or coverage.**

<a id="119"></a>
## 119. A schema-declared per-field property needs a correspondence pin in the CONSUMER's own suite — a locally re-derived belief that happens to agree today is not the same thing

**Date:** 2026-07-31. **Origin:** 13.8g-C leg C (knowledge), closing the one obligation the lead's ruling left open on leg A (`5eaf33f5`).

Leg A declared `LIST_VALUED_EXTRACTION_FIELDS = ["attendees","decisions"]` in `packages/contracts` — the single source for "which extraction fields may be array-valued." `packages/knowledge`'s `normalizeAttendees(raw: unknown)` had, independently and correctly, already assumed array-of-strings input for `attendees` (an `Array.isArray` gate at entry, per-element `typeof entry !== "string"` withholding — built dormant, ahead of its own wiring). **Both sides agreed. Nothing tied the agreement together.**

⛔ **That is exactly the shape 13.8g-C itself exists to close, one level down.** The task's own history: three independent modules assumed a field could be array-valued while the extraction gate stayed scalar-only — each individually reasonable, none checking against a shared declaration, until the disagreement surfaced as dead code and a silently-inert arc. A consumer's belief matching a declaration TODAY, with no pin tying the two together, is the same setup: correct only until one side changes and nothing notices.

⭐ **The fix the ruling required** (`IMPLEMENTATION_PLAN.md:1873`: *"list-ness has exactly one source... no consumer may hand-assume via a local `Array.isArray` against its own belief — that divergence IS the bug"*): import the SAME declared constant into the CONSUMER's own test suite and assert membership there — `attendees_is_declared_list_valued_in_the_shared_schema`. A future edit dropping `"attendees"` from the declared set now fails in the consumer's suite, not only the declaring package's.

⚠ **Why the declaring package's own test isn't enough** — `packages/contracts/test/models/agent-extraction.test.ts` already pins the declared set's shape (checked FIRST, per this instance, to avoid a duplicate pin). That test protects the DECLARATION's own content; it says nothing about whether any particular CONSUMER's array-handling code still agrees with it. Two different properties, two different failure surfaces: the declaration can stay correct while a consumer silently drifts, and only a consumer-side pin catches that.

⭐ **Distinguish from the neighboring single-sourcing lessons — this is NOT an instance of either:** L39/L61 govern re-forking a PARSER (two splitters that could disagree on the same string); L5/L37, sharpened by **L88**, govern a LITERAL that must agree vs. two literals that merely coincide for unrelated reasons. This is neither a parser nor a literal — it is a **declared per-field property** (a trait: is this field list-valued?) consumed by N independently-written modules, each of which needs its OWN tripwire against the SAME declaration, because the declaration lives in a package the consumers structurally cannot import from in reverse (`packages/contracts` is the pure DAG root).

`pin: packages/knowledge/test/attendee-refs.test.ts::attendees_is_declared_list_valued_in_the_shared_schema` (mutation-verified: swap the checked value to one absent from the real, untouched declared array → RED; revert → GREEN — the real array was never edited, since `packages/contracts` is a different track's territory). `accepted: not mechanically enforceable` beyond the instance pinned — no gate today enumerates every schema-declared property and confirms every consumer carries a correspondence pin; the enforcement point is the one **L118** already names: at Step 2.5/Step 9, whenever a slice reads a shared declaration, ask whether ITS OWN suite pins the correspondence — not only whether the value happens to be correct today.

<a id="120"></a>
## 120. A fact about our STAFFING is not a fact about what is PERMITTED — and a weak reason bundled with a strong one gets LAUNDERED

**Date:** 2026-07-31. **Origin:** the orchestrator authorizing a one-line cross-area fixture fix mid-13.8f-C. **Self-reported**; the lead had challenged the authorization on a different hypothesis entirely and accepted this as the actual defect.

**The instance.** Authorizing an edit in `packages/evals` (eval-security's territory), the orchestrator gave **two** reasons. First: *"a shared-type widening's own compile-break can't land red, so the fix is part of the change"* — sound, and independently ruled correct by the lead ([L121](#121)). Second: *"and no eval-security-implementer is live this session to route it to regardless."* **The fact is true. The inference is invalid — availability is not authority.** If a crossing needs authorization, having nobody to route it to does not grant it; it removes the reviewer, which is the **opposite** of permission.

⭐ **THE FAMILY: a staffing fact offered as a permission fact.** Second known member, already ruled on and already in the tracker: *"an area is idle"* offered as a reason to delete a specified affordance (`9.40`, ruled — *"an area is idle" is not a reason*). Both substitute **who is available** for **what is allowed**. ⚠ The orchestrator had **read that exact ruling hours earlier** and reproduced the fallacy anyway — the L91/L94 note again: knowing a failure mode in the abstract does not make you notice it in your own reasoning, which is why this is written as a mechanical check rather than a thing to be mindful of.

⭐ **THE NEW HALF, and it is why this matters more than one bad argument would: A WEAK REASON BUNDLED WITH A STRONG ONE GETS LAUNDERED.** A reader who accepts the strong reason **inherits the weak one silently** — it arrives pre-endorsed, was never argued on its own merits, and is now quotable as though it had been. **The strong reason is precisely what makes the weak one dangerous:** standing alone, *"nobody's around to ask"* would have been challenged on sight.

⚠ **The tell, and it is available before anyone else reads it: the weak reason was doing no work.** The compile-break argument was already sufficient. **An unnecessary reason is a signal** — it is there because the author wanted more support than they had, and that is exactly when the surplus reason is the unsound one.

⇒ **Do, both directions:**
- **Writing:** when a decision rests on one sound reason, **ship one reason.** If you catch yourself adding *"and also…"*, ask whether the addition would survive alone. If it wouldn't, **deleting it makes the decision stronger** — you are removing the part a future reader would quote back at you.
- **Reading:** evaluate each reason **separately**. **Accepting a conclusion is not accepting the bundle** — say which reason you accepted, so the other one does not travel on your endorsement.

`accepted: not mechanically enforceable` — enforcement point: **any authorization, ruling, or justification carrying more than one reason.** Check each alone; a reason that cannot stand alone should not ride along.

<a id="121"></a>
## 121. A shared-type widening's own compile-break in another area is part of the CHANGE, not a CROSSING — and the test is whether you can state it that way

**Date:** 2026-07-31. **LEAD DECISION**, ruled after challenge (provenance below — it matters, and the process failure outranks the ruling). **Origin:** 13.8f-C Step 8; `MeetingBuiltOutputs` gained a required `siblingPlans` field and left `packages/evals`' `hermes-gateway-routing.test.ts` fixture red.

**THE NARROW FORM — lead-ruled, recorded verbatim so it cannot be quoted wider than it was granted:**
> *"A shared-type widening's own compile-break in another area's fixture is part of the change, not a crossing — one line, assertion-preserving, its own commit."*

⛔ **THE BOUNDARY OF THE BOUNDARY (lead, and this is the load-bearing half — the narrow form alone is quotable as a licence).** This covers **a compile-break caused by your own change**. It does **NOT** cover editing another area's tests to make them agree with you, changing an assertion, or **any change that would still be wanted if the compile were fine.** ⇒ **THE TEST: if you cannot state the crossing as "my change broke this and it cannot land red," it IS a crossing and it comes to the lead.**

⭐ **WHY THE BOUNDARY-AVOIDING ALTERNATIVE IS WORSE — the actual reasoning, not the conclusion.** The crossing was avoidable outright: make the new field **optional** (`siblingPlans?:` + `?? []` at the read site) and the foreign fixture compiles untouched. **Rejected.** An optional **produced** field makes *"a real adapter that omitted it"* **indistinguishable** from *"one that correctly had nothing to commit"* — [L106](#106)'s capability-not-guarantee, and **precisely the `receipt.plans` silent drop that task 13.8f-C was split out of 13.8f-B to prevent.** ⇒ **Choosing `optional` to dodge a territory boundary trades a real invariant for process convenience** — the same shape as the (a0)(iii) ruling (*do not add an anchor to a phase because a linter demanded it*) and the lead's *"if the container cannot carry the guards, the container is wrong"* pre-ruling, in a third costume. ⭐ **The evidence that the implementer REASONED rather than defaulting to `required`: they made the sibling fault field (`meetingVaultRewriteFault` — ⚠ **written here as `livingVaultRewriteFault` and renamed at this same slice's Step 9, see the self-note below**) OPTIONAL in the same edit, correctly** — `undefined` = no fault is a genuinely meaningful absence there. **Required-vs-optional was decided per field, on what an absence would MEAN.** Cite that asymmetry; it is what makes the argument credible rather than a preference.

**MECHANICS that make such a fix auditable rather than silent** — all three, or it is a silent touch: **(1)** its **own commit**, pathspec-limited to the foreign file; **(2)** a message naming **the upstream slice that required it** and stating *"mechanical, no `<area>` logic touched"*; **(3)** scope held to the compile fix — so the owning area later finds a clean self-explaining diff instead of an unexplained edit buried in an unrelated commit, and **revert is one command** if the ruling goes the other way.

⛔ **PROVENANCE, recorded because the process failure is the more useful half: the orchestrator AUTHORIZED this unilaterally; the lead challenged it after the fact.** Even with correct reasoning, **a first-of-its-kind interpretation of a standing rule must arrive as a REQUEST, not go out as an authorization** — the lead owns the standing rule's interpretation, and treating a novel reading as settled *because it seemed obvious* is exactly how a scoped exception becomes standing practice nobody remembers granting. ⚠ **And both halves of what followed are the channel working:** the lead's *suspected* mechanism was **wrong** (they suspected an earlier slice-scoped **owner** exception had been inherited as precedent; it had not — the orchestrator never held it), while the **real** defect arrived from the orchestrator self-reporting an error the lead **had not asked about and could not have seen** ([L120](#120)). ⇒ **Challenge a crossing on sight even when your hypothesis about its cause is wrong — the challenge is what surfaces the true one; and answer it by reporting the error you find while answering, not only the one you were asked about.**

⚠ **DISCOVERABILITY GAP, stated rather than assumed away:** an implementer meets this situation **mid-slice, at Step 8**, and reads **their own area's `CLAUDE.md`** — not `packages/contracts/`. So this lesson sits where the **orchestrator** will find it and not necessarily where the **implementer** will. ⛔ **A root `CLAUDE.md` line may be owed; deliberately NOT written there unilaterally** — root territory rules are the lead's/owner's, and writing one there off my own ruling would repeat this lesson's own provenance defect. Surfaced to the lead instead.

⛔ **SELF-NOTE, added ~1h after this lesson was banked — THIS LESSON'S OWN CITATION WENT STALE, BY A RENAME THIS LESSON'S OWN ARGUMENT PRODUCED.** The credibility evidence above originally cited the field as **`livingVaultRewriteFault`**; at the same slice's Step 9 the orchestrator ruled it **renamed** to `meetingVaultRewriteFault` — on the reasoning that the `livingVault` prefix implied a source-path counterpart that does not exist ([L93](#93)'s naming family). ⇒ **The lesson cited a symbol that no longer resolved, inside the sentence that is its evidence** — so a reader grepping to verify the central claim would find nothing and could not check it. ⭐ **And the mechanism is exactly [L94](#94), committed by the author of both halves:** the same message that ordered the rename told the implementer *"do NOT work from the enumeration — grep the identifier repo-wide"* — and then **the two surviving stale references were the author's own lesson prose + index row**, because the enumeration considered was *code sites* and never *the durable prose citing the name*. ⇒ **Add DOCS to the channel list for any rename: `grep -rIn '<oldName>' packages apps docs` — a rename's channel set includes the lessons ledger, the tracker, and briefs, not only the code.** ⚠ **The fix preserves the old name as the pre-rename form rather than silently swapping it**, because the argument is about *why that name was wrong* — substituting it would erase the evidence while appearing to correct it ([L82](#82)'s forbidden middle).

⭐ **SEE ALSO [L122](#122)** — the brief carrying this guard had a FALSE PREMISE, caught by this guard, and the failure was neither a permission error nor a mismeasurement. The guard was written for a permission hazard and caught a premise defect: **pre-ruling the principle covered an instance nobody had in mind.**

`accepted: not mechanically enforceable` — enforcement point: **`/tdd` Step 8's full-graph typecheck** ([L81](#81)) is where these surface, and it is the moment the test above must be applied. `pattern: git log --name-only` — a commit touching a path outside the committing area's territory should name the upstream slice and *"mechanical"* in its message; a review prompt, never a gate.

<a id="122"></a>
## 122. AN UNRESOLVED PREMISE IS NOT WRITTEN AS A PREMISE — a doubt filed as a question does not weaken the assertion it doubts

**Date:** 2026-07-31. **Banked at the lead's instruction**, on the lead's observation that the orchestrator's self-report ("this was L118") named the wrong lesson and that the real one was better. **Origin:** brief 241 / task 13.8i-B; found by `worker-implementer` when the brief's own hard-line guard told it to *establish* rather than assume, and it stopped **before Step 1**.

**TWO INSTANCES, ONE ENTRY — they are the same shape at two distances: the information that would have prevented the error was already in hand or already in the ledger, and the brief was written past it anyway.**

### Instance 1 — the doubt and the assertion in the same document
The brief's premise block stated: *"The sink instance **already exists at boot**: `createApprovalsKnowledgeProposeSink({…})` is constructed at `apps/worker/src/boot.ts:1756` as `knowledgeProposeSink`."* The **same brief**, in its Step-2.5 section, asked: *"Is `boot.ts:1756`'s `knowledgeProposeSink` construction inside a **CONDITIONAL scope**? Its indentation suggests a nested block."*

⛔ **Q1 IS THE PROOF THE AUTHOR KNEW THE PREMISE WAS UNESTABLISHED.** The code: that line sits inside the body of `agentSynthesisFactory` — a **lazy** `() => CopilotSynthesisPort` that is only *defined* when `config.copilotRealModel === true && config.copilotAgentMode === true`, and whose body runs only when invoked, per-ask. There is **no boot-time instance to wrap**, and it belongs to a **different feature** (the Copilot chat agent's own propose-knowledge tool).

⭐ **WHY FILING THE DOUBT DID NOT SAVE IT, and this is the transferable part: THE TWO CHANNELS ARE NOT EQUAL.** An implementer **builds from the premises** and reads *"Things to flag at Step 2.5"* as **review scaffolding**. So a brief that asserts X in its premises and asks *"is X true?"* in its questions **SHIPS X.** The document disagreed with itself and the confident half was in the load-bearing channel.
⇒ **THE RULE: resolve it before the brief, or write the premise AS the open question it is** — *"UNVERIFIED: the sink's construction scope is not established; the implementer must establish it before Step 1."* **A premise and a question about that premise cannot both appear in one brief.**

⚠ **NOT [L118](#118), and the distinction matters or the wrong remedy gets applied.** L118 is *measuring the wrong property*. Here the measurement was **correct and known-incomplete** — the author had measured *"the identifier appears in `boot.ts`"* and **knew** that wasn't *"an instance exists at boot,"* which is why Q1 exists. **What failed is downstream of measurement: the reporting of a known-open question as settled.** L118's remedy (*name the property you measured*) would not have caught this, because the property **was** named — in the other section.
⚠ **Nearest relative is [L94](#94)** (a correction lands in the channel that STATES a claim, not the channel that REPEATS it) — **but this is worse, because a correction at least knows it is fixing something.** A doubt filed as a question is an author who knows, writes it down, and ships the confident version anyway.

### Instance 2 — the answer was already banked, one layer down
⛔ **[L59](#59) is literally the answer, and the brief was written past it.** L59: *"When the consumer is workflow-SANDBOX code, a dormant capability's arming gate belongs in the **ACTIVITY** — and the unarmed activity returns the identity result, not a failure… Temporal sandbox code cannot read boot config."* **It was banked from 13.8d — the very task 13.8i-B declares as its dependency.** The brief instead described a composition-root parameter-threading shape that cannot work across the sandbox boundary. Worker **independently rediscovered L59** from the in-code comment at `temporal/workflows.ts:436-443` (*"the delegate is ALWAYS bound because the sandbox cannot read boot config; the ARMING decision lives in the activity"*).
⇒ **A brief that names a dependency INHERITS THAT DEPENDENCY'S LESSONS.** The ledger is not a passive archive to be consulted when you already suspect something — **the moment a brief cites `Depends: <task>`, that task's banked lessons are part of the brief's input set.** ⚠ This is the *"recorded but unbelieved"* mechanism of [L89](#89) with the record intact and the reader absent: **nothing was wrong with L59; it simply was not read.**

### What actually caught it — and it is worth more than the miss
⭐ **The brief's own hard-line guard** — *"establish that, do not assume it… STOP and raise a Finding"* — **was written for a PERMISSION hazard (a possible arming crossing) and it caught a PREMISE defect instead.** Second confirmed instance this round of *pre-rule the principle, not the instance*: a guard written for one hazard covered a different one. ⭐ **And it was cheap because it fired BEFORE Step 1** — no RED tests were written against the wrong target shape, so the cost was one message, not a discarded slice.

`accepted: not mechanically enforceable` in full — but **two cheap mechanical halves exist and both are dispatch-time:** (1) ⛔ **a brief must not contain a Step-2.5 question about premise X while also asserting X** — a human check at dispatch, and the strongest single guard, since the author's own question is the detector; (2) **before dispatch, read the banked lessons of every task named in `Depends:`** — a bounded set, and instance 2 is what it costs to skip. **Enforcement point: brief authoring, before the spec-lint stamp — not review.**

<a id="123"></a>
## 123. "MUST" IS PROSE, NOT A GATE — an optional guard is type-indistinguishable from a bound one at the call site

**Date:** 2026-07-31. **Banked at the lead's instruction, who asked for the phrase verbatim:** *"it is the whole audit in five words."* **Origin:** task 24.6's audit run 1, finding F1 → task **24.9**; surfaced by the `AC-2` partition, escalated across a partition boundary, resolved and re-graded by the orchestrator.

**The instance.** `packages/knowledge/src/gbrain/local-embed.ts` enforces the rule-5 (Employer-Work egress) floor for local semantic retrieval from `backend.egressClass` — a field the **caller self-declares**. The mechanism that would *prove* it, `egressGate?: RetrievalEgressGate` (the reuse of the real endpoint-proof `egressVeto`), **is optional** (`:107`, guarded at `:244` by `if (egressGate !== undefined)`). The module's own header states the obligation plainly: a remote backend **"MUST bind `egressGate`"** at wiring time.

⛔ **THAT SENTENCE IS THE ENTIRE ENFORCEMENT. It is a comment.** Nothing fails, nothing reds, nothing warns if the arming slice wires a remote backend and omits the gate. ⇒ ***"MUST" is prose, not a gate.***

⭐ **THE MECHANISM, AND IT IS WHY THIS IS WORSE THAN AN ABSENT GUARD: an optional guard is TYPE-INDISTINGUISHABLE FROM A BOUND ONE AT THE CALL SITE.** `retrieveLocalEmbed(input, { backend })` and `retrieveLocalEmbed(input, { backend, egressGate })` **both compile, both pass review, and both look complete.** An *absent* guard is a visible gap someone must add; an *optional* one is a gap that **satisfies the compiler while omitting the proof** — the same shape as [L106](#106)'s capability-not-guarantee, aimed at a **guard** rather than a signal. **Compare [L2](#2)/[L28](#28)**: a strict `=== true` on a boundary boolean is the same instinct one level down — *do not let the permissive reading be the easy one.*

⚠ **AND THE SEVERITY MUST BE STATED HONESTLY OR THE FINDING GETS DISMISSED.** Measured at audit time: `retrieveLocalEmbed` has **zero production callers**, `egressGate` is bound in **tests only**, and the sole `EmbeddingBackend` construction is the eval harness's *recorded, zero-egress, in-memory* one. ⇒ **NOT a live breach — a live arming PRECONDITION with no enforcement mechanism.** Nothing reaches the unproven path because nothing reaches the function. ⛔ **But that is exactly the wrong reason to close it**, and the audit's threat-model ruling is why: *the audit assumes the gates are open.* The wiring slice that makes retrieval real is the one that will silently satisfy the type and skip the proof.

⛔ **DO NOT CLOSE SUCH A FINDING BY CITING THE COMMENT AS COVERAGE.** *"The module documents that a remote backend must bind the gate"* is **the asserted-constant mechanism living in a comment** — the very defect class the audit hunts, one layer of indirection out. ⭐ **The generalisation: a comment stating an obligation is EVIDENCE THAT SOMEONE KNEW, never evidence that anything enforces it.** The two are routinely conflated, because a well-written caveat *reads* like a control. Ask of every *"MUST"*, *"callers are required to"*, *"remember to"*: **what fails if someone doesn't?** If the answer is *"nothing, until an incident"*, the obligation is undefended.

⇒ **Do:** make the guard **non-optional** for any input not *proven* safe, or make the unproven path **unrepresentable** — the two structural fixes this project already reaches for ([L87](#87)'s nominal brand, [L103](#103)'s make-it-unrepresentable). Where an optional seam must stay optional for legitimate reasons (existing fakes, [L11](#11)), **the obligation needs a mechanical backstop** — a pin, a boot-time assertion, or a `pattern:` grep — **and the in-code comment must say which one, so the next reader can check the enforcement rather than trusting the sentence.**

`pin: none — this is the finding, task 24.9 is the fix.` `pattern: grep -n 'egressGate' packages/knowledge/src/gbrain/local-embed.ts` — an `egressGate?:` (optional) on a safety seam is the candidate shape; **an optional guard on a rule-touching seam is a finding until something enforces it.** **Enforcement point: any review of a seam whose safety depends on a caller doing something the type does not require.**

---

<a id="124"></a>
## 124. A DEBT'S RECORDED SCOPE IS NOT A SPECIFICATION — paying it as written can be the defect

**Date:** 2026-08-11. **Origin:** Carry-forward item 11 (`c07cb147`) — an orchestrator hot-write acknowledged in one round and unwritten for a full round, caught only by an implementer's `/session-end` cross-doc audit. **This is [(a0)(viii)](#106) face 2 — *the tracker being wrong about WHAT* — arriving in a CARRY-FORWARD ITEM rather than in a task.**

**The instance.** Item 11 recorded the debt as two rows: an `ARCHITECTURE.md` Appendix-A row **and** a `packages/contracts/CLAUDE.md` cross-doc row for `UiSafeAuditDrillSummary`, framed as *"following the `UiSafeCopilotAnswer` projection-not-a-frozen-seam pattern."* Both absences were confirmed by measurement (`grep -c` = 0 in both files, working tree **and** history) — **so the item's evidence was sound and its prescription still wrong.**

⛔ **MEASURED BEFORE WRITING, WHICH IS THE ONLY REASON IT WAS CAUGHT.** That cross-doc table's own trailing note scopes it to **29 FROZEN SEAMS**: Zod-as-source → generated `schemas/<kebab>.schema.json` → frozen `.snap` → ajv-strict registry, *"a field add/remove/rename requires editing Appendix A + the schema + its `.snap` in the same round."* A **UI-safe projection has none of those.** And the cited precedent proves it: **`UiSafeCopilotAnswer` has an Appendix-A row and is ABSENT from that table** — its absence is the pattern, not an oversight. ⇒ **Writing the row as recorded would have asserted a freeze that does not exist and put the table's own "29 frozen" count in doubt** — a false safety claim in the very table that exists to prevent silent disagreement, i.e. [24.6](#123)'s own defect class minted while paying down 24.6-adjacent debt.

⭐ **WHY THE ERROR WAS INVITED, and it generalises past this instance: the item cited a PATTERN BY NAME (*"the `UiSafeCopilotAnswer` pattern"*) instead of by its OBSERVABLE CONTENT.** A named pattern compresses to whatever the reader already believes it means; the writer meant *"projection, not a frozen seam"* and the same phrase reads as *"do for X what was done for Y"* — and what was done for Y was **one row, not two.** ⇒ **Cite a precedent by what it DID (with the file it did it in), never by a name for what it did.**

⇒ **Do:** ⛔ **before paying a recorded debt, re-derive its target from the destination artifact, not from the debt's description.** The debt is reliable evidence that *something is missing*; it is **not** authority on *what belongs there* — those are different claims, and a debt written by the person who owes it carries their understanding at the time they deferred it, which is exactly the moment they were not looking closely. ⭐ **Corollary (the honest disposition here): the RESIDUAL gap was real but different** — `packages/contracts/CLAUDE.md` indexed **no** UI-safe projection at all, so the fix is a scoped companion note naming them as explicitly-not-frozen with their orchestrator-write obligation intact, which closes the discoverability gap for `UiSafeCopilotAnswer` too. **A wrong prescription over a real symptom is still a real symptom.**

`pin: none — a process lesson.` `pattern: grep -c 'UiSafeAuditDrillSummary' ARCHITECTURE.md packages/contracts/CLAUDE.md` — both must be non-zero; **but re-derive the ROW SHAPE from each destination's own scoping note before adding one.** `accepted: not mechanically enforceable` — no gate can distinguish a debt paid correctly from one paid as literally written.

---

<a id="125"></a>
## 125. A REMEDIATION LEDGER IS A CLAIM LIKE ANY OTHER — "amended" counted as "corrected," and the count made the file look audited

**Date:** 2026-08-11. **Origin:** 24.6 round 2, partition DOC-1 → task **24.10**. **Banked at the lead's instruction**, who called it *"the sharpest thing DOC-1 returned."*

**The instance.** `docs/design/ui-ux/material-direction.md:92`'s normative governance paragraph **opened** with *"⛔ AMENDED 2026-07-26 — … the egress pill violated both … and was removed"* and, **in the same sentence**, enumerated the signals that *"stay first-class and visible"* — **including the egress pill.** Lines 58 and 84 of the same file struck it correctly. ⇒ **the file contradicted itself three ways, and the stale copy sat in the NORMATIVE paragraph** — the one a generator or an implementer treats as the spec.

⛔ **THE PART THAT MAKES IT A LESSON RATHER THAN A TYPO: the fix ledger recorded this file as DONE.** `IMPLEMENTATION_PLAN.md`'s `#### Residuals (9)` claimed the sweep corrected *"material-direction.md ×3,"* counting as one of the three *"its normative governance-legibility guardrail amended."* ⭐ **It WAS amended — a preamble was added — and it was NOT corrected: the enumeration inside it never moved.** The ledger's own word was accurate and its implication was false.

⭐ **WHY THIS SURVIVES A RE-READ, AND WHY IT IS THE DANGEROUS FORM: the surrounding prose CHANGED.** A reader checking the sweep sees a paragraph that visibly received attention, with a dated ⛔ amendment marker on it. **Fresh edit-marks read as evidence of a completed fix.** An untouched paragraph would have looked suspicious; a half-edited one does not. ⇒ **partial remediation is harder to detect than no remediation.**

⛔ **AND THE LOCATION IS THE COMPOUNDING FACTOR: this is a completion record standing over an incomplete fix, INSIDE THE REMEDIATION LEDGER OF THE VERY DEFECT IT REMEDIATES.** The 9-site sweep existed to remove asserted safety claims; its own record asserted a claim it had not verified. **Same mechanism, one level up** — [L106](#106)'s *"an occurrence is not automatically a defect"* inverted into *"a remediation is not automatically a fix."*

⚠ **It also survived a GREP.** The prior sweep's evidence was phrase-shaped; the surviving instance is inside a paragraph whose other sentences carry the correction, so a phrase-grep over the file returns hits that look like the fix. **The check that found it was READING THE PARAGRAPH.** (Compare [L64](#64): a string-shaped audit returns a confident false all-clear.)

⇒ **Do:** ⛔ **when a sweep reports `<file> ×N`, the N is a count of SITES TOUCHED, never of sites CORRECTED — record which, and prefer naming the sites over the number** ([L100](#100): state the unit). ⭐ **And verify a doc fix by re-reading the enclosing PARAGRAPH, not by re-running the grep that found it** — the grep's hits now include your own correction, so it cannot distinguish fixed from half-fixed. **Corollary for reviewers: a dated amendment marker is evidence someone LOOKED, never evidence they FINISHED.**

`pin: none — a process lesson.` `pattern: grep -n 'egress pill' docs/design/ui-ux/material-direction.md` — every surviving hit must be inside a strike-through or an explicit do-not-re-add line. `accepted: not mechanically enforceable` in general — **enforcement point: any sweep close-out that reports a per-file count.**

---

<a id="126"></a>
## 126. A BANKED LESSON RECORDS THAT A DEFECT *WAS* FIXED, NEVER THAT IT *IS* FIXED — re-derive the negative from current source

**Date:** 2026-08-11. **Origin:** 24.6 round 2, partition `AC-2b`. **Banked at the lead's instruction**, who called it *"the single best methodological call of the round"* and noted that ⭐ **a negative that was at risk of being ASSUMED is worth more than another finding.**

**The instance.** `packages/knowledge/src/synthesis/*` — the living-vault area, and the surface the project is about to arm — carried five banked lessons recording heavy prior fixing of one defect class ([L32](#32)/[L37](#37)/[L38](#38)/[L60](#60)/[L65](#65)). `IMPLEMENTATION_PLAN.md` warned in its own words: ⛔ ***"prior lessons record heavy fixing of this exact defect class here, but current state was NOT independently re-verified — do not treat past fixes as present coverage."*** **AC-2b re-derived it from current code anyway** and reported the specific mechanisms live *in the code it read*: the prototype-pollution-defeating `Map` in `entity-resolver.ts`, and `admitGroundedPath` as the single admission chokepoint with all four historically-named path-fabrication routes closed **in the code, not merely in the comments.**

⛔ **THE MECHANISM, AND IT IS WHY THIS IS A LESSON RATHER THAN A COMPLIMENT: A CITATION IS EVIDENCE ABOUT THE PAST; COVERAGE IS A CLAIM ABOUT THE PRESENT.** Between the fix and now sit refactors, container swaps, new call sites, and re-forked helpers — this project has watched a single `.catchall()` container swap silently drop **three** guards that a passing test suite had covered for months. ⇒ **the lesson number proves someone once closed it; nothing in the citation observes that it is still closed.** This is [L118](#118)'s family — a **PROXY** (*a lesson exists*) standing in for the **PROPERTY** (*the code is sound*) — aimed at our own remediation history.

⭐ **AND THE PART THAT MAKES IT DANGEROUS RATHER THAN MERELY LOOSE: AN ASSUMED NEGATIVE AND A VERIFIED ONE PRODUCE BYTE-IDENTICAL REPORTS.** *"Sound — see L37"* and *"Sound — `admitGroundedPath` is the single chokepoint, all four routes closed, read at HEAD"* occupy the same line of a report and carry the same weight to a reader. **Only one of them would notice a regression.** ⇒ this is the audit's own *explicit-negatives-are-required* rule, one level up: without the derivation shown, **a thin check and a clean surface are indistinguishable.**

⚠ **The inverse error is real and must not be induced: this is NOT "distrust the ledger."** The lessons were correct when written and are the reason the surface is in good shape. **The claim being challenged is not *was this fixed* but *is it still* — and only the second one is what an audit, a phase-exit, or an arming gate actually needs.**

⇒ **Do:** ⛔ **when a lesson would be your evidence that something is sound, open the file instead and cite `file:line` at HEAD; cite the lesson beside it as PROVENANCE, never as proof.** ⭐ **Sharpest form: a lesson tells you WHERE to look and WHAT to look for — it is a search key, not a result.** Strongest when the surface is dormant-and-about-to-arm, since dormancy means nothing has been exercising the guard in the meantime.

`pin: none — a method lesson.` `accepted: not mechanically enforceable` — no gate distinguishes a cited negative from a derived one. **Enforcement point: any audit, `/phase-exit`, or arming gate whose "sound" verdict rests on a lesson citation rather than on a line of current source.**

---

<a id="127"></a>
## 127. A SCOPE CONSTRAINT AND A SCOPE EXPANSION IN ONE MESSAGE ARE INVISIBLE TO THEIR AUTHOR — because each half is individually correct

**Date:** 2026-08-11. **Origin:** the lead's own instruction on task 24.10, self-reported after the orchestrator declined to act on it. **Sibling of [L125](#125)** — same round, same shape one level over: **L125 is a partial fix that reads as complete; this is a partial constraint that reads as whole.**

**The instance.** One message carried both: ⛔ *"THE AUTHORIZATION IS THIS ONE EDIT. It is NOT a standing unlock… any further `docs/design/**` edit needs a fresh gate"* **and** *"take 9.42's sibling obligation on the same file in the same pass."* ⭐ **The second instruction authorises a second edit to the same locked file that the first instruction forbids.** The lead did not notice while writing it, and said so plainly: **the contradiction was invisible because each half was individually correct.**

⛔ **THE MECHANISM, AND IT IS WHY NO AMOUNT OF CARE CATCHES IT: AUTHORING REVIEWS EACH SENTENCE, EXECUTION REVIEWS THE PAIR.** An author asks *"is this true?"* of each clause and both pass. **Nothing in the act of writing forces the question *"do these two clauses describe the same scope?"*** — that question only arises for someone who has to satisfy both **at once**. ⇒ **this class of defect has no detection point on the authoring side by construction**, which is why it is not a carelessness lesson.

⛔ **AND THE COMPOUNDING FACTOR HERE, WHICH GENERALISES FURTHER THAN THE INSTANCE: THE MESSAGE WAS RELAYING SOMEONE ELSE'S AUTHORIZATION.** The owner had authorized **one** edit. The broad half would have spent an authorization **the relayer did not hold and did not intend to grant** — ⭐ *an authorization widens as it is relayed, and the relayer is the LEAST able to notice, because they know what they meant.* ([L116](#116)'s neighbour: authority attaches to the speaker — **so does scope.**)

⭐ **WHAT MADE IT SURVIVABLE, and it is the transferable part: the executor treated the contradiction as a FINDING rather than as an ambiguity to resolve.** ⛔ **Resolving it silently is the failure** — and the pull is always toward the **broader** reading, because the broader reading is the one that lets you proceed. **Had it been resolved that way, an owner authorization would have been exceeded through an intermediary who never intended it, and every party would have believed they had acted correctly.**
⚠ **The independent second ground matters too, and is worth separating: the narrow reading was ALSO right on the merits** — the two doc instances were different kinds of thing (a retired goal makes a doc **false**; a **live** goal re-tracked as a task does not, and deleting it would cancel a product commitment while wearing the word *"correction"*). ⇒ **two independent grounds, and only one of them was about permission.** A correctness argument and a permission argument reaching the same answer is not one argument.

⇒ **Do:** ⛔ **when an instruction contains both a constraint and an expansion, do NOT pick — send it back naming both halves.** ⭐ **Test for the author: after writing a constraint, re-read the message asking only *"does anything later in this message spend what I just withheld?"*** — the check must be a **second pass over the pair**, because the first pass is per-clause and will pass. **And for anyone relaying an authorization: state its exact extent and then add nothing to the same message that acts on it.**

`pin: none — a process lesson.` `accepted: not mechanically enforceable` — no gate reads intent across two clauses. **Enforcement point: the RECIPIENT, and only if they are licensed to flag rather than expected to interpret.**

---

<a id="128"></a>
## 128. ACCUMULATE IN A `Map`, PUBLISH AS A PLAIN OBJECT — the prototype-safe shape and the JSON-friendly shape are different, and the conversion is the seam

**Date:** 2026-08-11. **Origin:** 13.23 leg A, knowledge — surfaced by `security-reviewer` as a **low**, and **fixed in-slice rather than deferred.**

**The situation, which recurs whenever a signal is counted by code.** A public field is a plain object keyed by a closed string-literal union (`Partial<Record<WithheldReason, number>>`) — it must stay a plain object because it is serialized and read across a boundary. **But accumulating into it with `acc[key]++` indexes an object whose prototype chain is live**, so a key named `__proto__`, `constructor`, `toString` or `valueOf` does not create an own-property — it collides with `Object.prototype`.

⚠ **The subtlety that made it a LOW and not a nothing: no CURRENT member collides.** The reviewer's point was about the **future** member — this project's key domains grow (the union here is *composed* from another module's union precisely so new members propagate automatically), ⭐ **so the very property that makes the type good — it extends without edits here — is what makes the accumulator unsafe without edits here.** [L65](#65) already guards the identical shape two lines away (`ENTITY_NAMESPACES`), which is what let the reviewer recognise it.

⇒ **The fix, and the reason it is a pattern rather than a one-off:** accumulate in a **`Map`** (no prototype chain, arbitrary string keys safe), then convert **once, at the publication boundary**, with **`Object.fromEntries`** — which uses `[[DefineOwnProperty]]`, **not assignment**, so it creates a genuine own-property even for a hypothetical `"__proto__"` key. ⭐ **The public type and the assertions do not change at all**, which is what makes this cheap enough to be the default rather than a special case.

⚠ **DISTINCT FROM [L65](#65), and the distinction is the point of banking it separately.** L65's answer is *`ReadonlyMap` all the way through* — correct when the value never has to leave as a plain object. **Here it does** (serialized field), so *"use a Map"* alone under-specifies: **the conversion is the load-bearing half, and `Object.assign` / spread / a `for` loop with `obj[k] =` would all silently re-open the hole at the last step.** ⇒ **when the internal and external shapes differ on safety, name BOTH shapes and the converter.**

⇒ **Do:** counting or grouping by a key domain that is **closed today and extensible tomorrow** ⇒ **`Map` internally, `Object.fromEntries` at the boundary.** Reach for it by default; the cost is one call.

`pin: <the 13.23 leg-A synthesis-planner tests — the public shape is unchanged, so they pin the pattern's OUTPUT, not the pattern>` `pattern: grep -nE '\[[A-Za-z_.]+\] *(\+\+|\+=|=)' --include='*.ts' packages apps | grep -v test` — an accumulator indexed by a variable key is the **candidate** shape; it is a defect only when the key domain is not provably prototype-free. `accepted: partially enforceable` — the grep over-approximates.

---

<a id="129"></a>
## 129. TYPE NARROWING IS A PROPERTY OF POSITION, NOT OF THE EXPRESSION — and a green vitest run is not a typecheck

**Date:** 2026-08-11. **Origin:** 13.8i-B, worker — **self-caught during a code-quality fix**, which is what makes it worth banking: the defect was introduced by a *correct* refactor and found by the *right* gate.

**The instance.** A reviewer correctly flagged byte-identical duplication of a `reason`/`failureClass` derivation across two drivers. Extracting it into a shared exported helper was the right fix. ⛔ **But the inline version was relying on cross-statement narrowing supplied by the ORIGINAL call site's enclosing `if`/`else`** — once lifted into a standalone function, that narrowing no longer existed and the body no longer compiled (`Property 'error' does not exist on type Ok<…>`).

⭐ **THE MECHANISM: narrowing is a property of the POSITION an expression occupies, not of the expression itself.** A "pure move" of an expression is therefore **not** type-preserving in general — the expression is identical and its *type context* is not. ⇒ **this specific hazard attaches to extract-function, extract-helper, and de-duplication refactors, i.e. exactly the ones a code-quality review asks for.** ([L118](#118)'s family at the type level: the property you preserved is *the text*; the property you needed is *the inferred type*.)

⛔ **AND THE PART THAT GENERALISES FURTHEST: `vitest` DID NOT CATCH IT, BECAUSE VITEST DOES NOT TYPECHECK.** The suite stayed green over a build-broken tree. ⭐ **A green test run and a clean typecheck are different claims, and in this repo the gap is wider than usual: `lint` IS `tsc --noEmit`** ([L111](#111)), so *"tests green"* and *"lint clean"* are **not** two independent confirmations unless `tsc` was actually executed — and the test runner will never supply it.

⇒ **Do:** ⛔ **after ANY extract/de-duplicate refactor, run the repo-wide typecheck before declaring the fix done — not the test suite, the typecheck.** Step 8's full-graph typecheck is a **separate gate for this reason**, not a formality. ⭐ **And when a lifted body stops compiling, restore the narrowing INSIDE the new function** (an explicit `if`/`else` that narrows locally) rather than reaching for a cast or a non-null assertion — **the compile error is reporting a real loss of information, and silencing it keeps the loss while hiding the report.**

`pin: none — a method lesson.` `pattern: none — the trigger is a refactor shape, not a source pattern.` `accepted: not mechanically enforceable` beyond the existing gate. **Enforcement point: `/tdd` Step 8's repo-wide `tsc`, which already exists — the lesson is that a GREEN VITEST RUN MUST NOT BE READ AS COVERING IT.**

---

<a id="130"></a>
## 130. A VALUE PIN AND A WIRING PIN ARE DIFFERENT TESTS — one must use the literal, the other must use the symbol, and swapping them gives you a vacuous test or a brittle one

**Date:** 2026-08-11. **Origin:** 24.16, providers-integrations — surfaced by a pure rename, and **banked as a correction to the orchestrator's own first framing of it**, which was too flattering to one of the two shapes.

**The instance.** Renaming `WRITE_THROUGH_BLOCKED_HEALTH_CLASS` → `WRITE_THROUGH_FAILED_HEALTH_CLASS` (value unchanged) touched two tests **very differently**:
- `outbox.test.ts` asserts the emitted `failureClass` **equals the imported constant** ⇒ it survived the rename untouched.
- `health-signal.test.ts` asserts the constant **equals the string literal** ⇒ it required updating.

⛔ **THE TEMPTING AND WRONG CONCLUSION — which is what I first wrote — is that the symbol-comparing test is the better shape because it survived.** It is not. **They pin different properties and both were correct:**
- **Symbol comparison pins WIRING:** *does the production path actually use this constant?* ⭐ It **must** use the symbol — that is the whole assertion.
- **Literal comparison pins VALUE:** *is this constant still `"write_through_failed"`?* ⭐ It **must** use the literal — that is the whole assertion.

⭐ **SWAP THEM AND EACH FAILS IN ITS OWN CHARACTERISTIC WAY, which is the reusable part:**
- A **value pin written symbol-to-symbol is VACUOUS** — `expect(CONST).toBe(CONST)` is `X === X`. It passes under every possible value, including a wrong one. ([L80](#80)/[L62](#62)'s vacuity family, arriving through a rename rather than a constant-substitution.)
- A **wiring pin written against a literal is BRITTLE** — it goes red on a pure rename, **a false positive**, and the cost is worse than the noise: *"the rename broke a test"* teaches the next engineer that renames are dangerous, when what actually happened is that a test was asserting something it did not mean.

⇒ **The diagnostic question is not *"which is more robust?"* but *"WHAT DO I WANT TO BE TOLD ABOUT?"*** — a changed **value** (literal) or a broken **connection** (symbol). ⭐ **Robustness is the wrong axis entirely: a value pin SHOULD be fragile to value changes; that is its job.**

⚠ **And the corollary that makes this worth a lesson rather than a note: a rename is a free audit of this distinction.** Every test that broke was claiming to be a value pin; every test that survived was claiming to be a wiring pin. **If a test broke and you cannot say which property it was pinning, that is the finding — not the rename.**

`pin: none — a method lesson.` `pattern: grep -rnE 'expect\([A-Z_]+\)\.toBe\([A-Z_]+\)'` — a constant compared to a constant is the **vacuous value-pin** candidate shape. `accepted: partially enforceable` — the grep catches the vacuous direction only; the brittle direction is not mechanically distinguishable from a correct value pin.

---

<a id="131"></a>
## 131. A RELEASE CONDITION PHRASED AS AN ACTION IS DISCHARGED BY ACTIVITY — write gates as OUTCOMES

**Date:** 2026-08-11. **Origin:** the lead, self-reported. ⭐ **Banked with the provenance the lead asked be kept, because the provenance IS the lesson: he DIAGNOSED this failure mode and then COMMITTED IT TWO SENTENCES LATER, in the same message.**

**The instance.** A block-release condition was written as ***"`packages/knowledge/src/gcl/*` has actually been audited."*** The audit ran — and returned a **HIGH finding on the exact claim the condition existed to protect.** ⇒ **the condition was SATISFIED AS AN ACTION and worthless as a guarantee.** Rewritten outcome-based: *"the wired cross-workspace read path actually goes through the GCL gate and the ceiling is re-derived rather than frozen."*

⛔ **THE PROVENANCE, KEPT DELIBERATELY.** The same message that introduced this condition was **fixing a different condition that had already released by attrition** — an earlier gate whose trigger *"until 24.6 round 2 closes"* had been **met**, so leaving it written would have released the block silently. ⭐ **The author was actively reasoning about how conditions fail, and wrote an action-phrased one in the next breath.** ⇒ ***noticing a class does not immunise you against it.*** **That is the transferable claim, and it is why this is banked as a lesson rather than filed as a one-off correction.**

⭐ **THE SWEEP THAT FOLLOWED FOUND A LIVE NEAR-MISS IN THE ARMING LEDGER — evidence the class is systemic, not anecdotal.** `§ARM-RESEARCH` precondition (1) is a **task reference**: *"task 13.8i — route the withheld PROPOSE tier into §9.8 Approvals."* **`13.8i` was ticked DONE while the capability was ABSENT** (it built the mechanism and left the binding to `13.8i-B`) ⇒ **an operator checking that precondition against the tracker would have read a TICK as a CAPABILITY.** ⛔ **And the tracker had already grown a prose defense against it** — *"DO NOT READ THE TASK TITLE OR THE COMMIT SUBJECT AS 'PROPOSE PLANS REACH APPROVALS'"* — **which is the defect being patched at the wrong layer: a warning compensating for a mis-phrased gate.**
⭐ **The cheap-fix contrast, from the same ledger: precondition (3) reads *"`gateLivingVaultRewrite` has NO `bootWorker` call site and nothing constructs `IngestRewriteDeps`"* — a STATE, not an activity, so it CANNOT be discharged by doing something.** ⇒ **the repair is re-phrasing, not re-design.**

⛔⛔ **AMENDED 2026-08-11 (24.6 round 4 / `ACC-1`) — ACCEPTED BY THE LEAD AGAINST HIS OWN LESSON: ⭐ *OUTCOME-PHRASING BUYS **CHECKABILITY**, NOT **TRUTH**.*** The original implied outcome-phrasing was the fix. **It is only the PRECONDITION for one.** ⭐ **Proof: task `16.4`'s claim (*"mints a fail-VISIBLE coverage-degrade signal instead of being silently dropped"*) is OUTCOME-phrased AND FALSE — the signal is discarded one hop later by code shipped in the same task.** ⛔ **And the sharper half: THE MORE CHECKABLE A CLAIM LOOKS, THE MORE TRUST IT DRAWS — so an outcome-phrased falsehood OUTRANKS an action-phrased one in danger.** ⚠ **Carry the absent tell too: NO ⛔ warning-comment was attached to `16.4`, so `PRE-1`'s best search key does not fire on this variant** ⇒ ⭐ **that key finds the NOTICED-BUT-UNFIXED cases and is BLIND to the NEVER-NOTICED ones; a clean `PRE-1` must not be read as a swept surface.**

⇒ **Do:** ⛔ **write every gate, arming precondition and `Done-when` as a property of the SYSTEM, never as work performed.** **Test it with: *"could this be true while the thing it protects is broken?"*** — *"X has been audited/reviewed/attempted/tracked"* fails; *"X holds, and here is the observation that shows it"* passes. ⚠ **A task REFERENCE is action-phrased by construction** (a task can tick while its capability is absent — this project has a five-instance ledger of exactly that, `L106`); ⭐ **if a precondition must cite a task, state the CAPABILITY it must yield and cite the task beside it as provenance.** ⚠ **And a prose warning attached to a gate is a smell: it usually means the gate is phrased wrongly and someone compensated with a comment.**

`pin: none — a process lesson.` `pattern: grep -nE '(Done-when|condition|precondition).*(has been|have been|was (run|audited|reviewed)|is tracked|task [0-9])' IMPLEMENTATION_PLAN.md` — action-phrased **candidates** to classify, not defects. `accepted: partially enforceable` — the grep cannot judge whether a phrasing is load-bearing. ⛔ **Sweep scope, stated: the arming conditions and `§ARM-*` ledgers were classified 2026-08-11; the ~200 per-task `Done-when` lines were NOT.**

---

<a id="132"></a>
## 132. METADATA-IS-AUTHORITATIVE HANDLES A STALE *STATUS*; IT DOES NOTHING FOR A STALE *ARGUMENT*

**Date:** 2026-08-11. **Origin:** six message crossings in one round, two of which did real damage. **Banked at the lead's instruction, who supplied the cost rule and asked that his own instance be the headline because it is the more instructive.**

**The established mitigation and its exact limit.** This project already learned that crossings are frequent and that **task metadata is authoritative over prose** — which reliably resolves *"is this dispatched / approved / done?"* ⛔ **It does nothing when what crossed was a piece of REASONING.** A status has a canonical home; **an argument does not.**

⭐ **THE COST RULE, and it is the part that predicts damage: a crossing's damage scales with how much reasoning was built ON TOP OF the stale half.** A crossed status costs one read-back. **A crossed argument costs everything derived from it.**

**The two instances, both load-bearing:**
- ⭐ **The lead's (the instructive one): he REVERSED A CORRECT DECISION on a misread and issued a WRONG PRIORITY DOWNSTREAM in a spawn prompt.** He had held a session on the grounds that *"none of 24.12's candidate REMEDIES is providers territory"* — correct — then reversed himself on the claim that a **leg of the FINDING** was providers territory. ⛔ **He had silently substituted *leg* for *remedy*: the same finding-vs-remedy confusion the tracker keeps producing, arriving inside the correction of a decision.** **The reversal reached a third party before the retraction did.**
- **The orchestrator's:** answered a HOLD that had already been reversed, and separately re-answered a question already answered in flight. **Cheaper, because nothing was built on top.**

⇒ **Do:** ⛔ **before reversing your own decision on new information, re-read the ARGUMENT you are reversing, not just the conclusion** — the failure here was not a wrong fact, it was a **substituted noun** inside a sentence that still read true. ⭐ **And when a reversal has already been relayed onward, the retraction must reach the SAME CHANNEL that carried the error** ([L94](#94)): a correction sent only upstream leaves the downstream instruction authoritative. ⚠ **Practically: check your inbox before reporting something outstanding, and check whether you already ruled before re-ruling** — both crossings this round were resolvable by reading, not by asking.

⚠ **The honest limit of this lesson: crossings are STRUCTURAL in an async team and cannot be eliminated.** ⭐ **What is controllable is the BLAST RADIUS — so the discipline is not "avoid crossing," it is "notice when a crossed message is an ARGUMENT rather than a STATUS, and re-derive rather than build."**

`pin: none — a process lesson.` `accepted: not mechanically enforceable` — no gate reads whether a message carried reasoning or state. **Enforcement point: the moment you are about to reverse a decision, or act on one that reverses yours.**

---

<a id="133"></a>
## 133. VERIFY A COMMIT BY `git log`, NEVER BY THE COMMIT'S OWN OUTPUT — the `ok` trap reaches the receipt

**Date:** 2026-08-11. **Origin:** the lead, self-reported after `git commit -F … -- <path>` returned **`ok (nothing to commit)`** and **silently did not land.** `git log` caught it; **the receipt would have had him move on.**

**The known trap, and why this is strictly worse.** This project already records that **`git status` returns the literal string `ok` in this environment**, and that its porcelain form is worse because **`git status --porcelain=v1 | wc -l` reads as "1 modified file"** — a *plausible* wrong answer. ⛔ **What was NOT recorded is that the same environment mangles the COMMIT RECEIPT.**

⭐ **WHY THE COMMIT CASE IS THE DANGEROUS ONE: a status you misread costs you one wrong belief about the tree. A COMMIT THAT SILENTLY DID NOT LAND LOOKS IDENTICAL TO ONE THAT DID, AND EVERYTHING DOWNSTREAM ASSUMES IT EXISTS.** A hash gets quoted into a task's metadata, a tracker tick, a handoff, a session doc — ⛔ **and this project's close-out discipline is built on hashes.** ⇒ **the failure propagates into the durable record before anyone re-checks.**

⚠ **And it composes with the failure mode this project already has twice:** work lost to a session dying over an uncommitted diff ([L117](#117)). **A silent no-op commit produces exactly that state while reporting success.**

⇒ **Do:** ⛔ **after every commit, confirm with `git log --oneline -1` (or `git log -1 --format=%H <expected-subject>`) before quoting the hash anywhere.** ⭐ **The general rule, which is the transferable part: in this environment a command's own success output is not evidence — confirm state-changing operations by INDEPENDENTLY QUERYING THE STATE.** ⚠ Applies to `git add` (check `git diff --cached`) and to anything whose receipt you would otherwise paste into a durable record. ⭐ **A receipt is a claim by the actor; `git log` is an observation of the world** — the same distinction [L118](#118) draws between the proxy and the property, arriving in the tooling layer.

`pin: none — an operational lesson.` `pattern: none — the trigger is a workflow step, not a source pattern.` `accepted: not mechanically enforceable` — no gate reads whether a hash was confirmed. **Enforcement point: the moment before a hash enters task metadata, a tracker tick, a session doc, or a handoff.**

---

<a id="134"></a>
## 134. A `default:` BRANCH IN A MAPPER OVER A CLOSED UNION IS A SILENT ABSORBER — guard exhaustiveness, don't terminate it

**Date:** 2026-08-11. **Origin:** 24.12's reviewer chase, knowledge-implementer — **traced to root rather than observed**, from a single failing test.

**The instance.** 24.12 added a `workspace_path_violation` write-failure code. `packages/workflows/src/activities/commitKnowledge.ts`'s `mapWriteFailure` switches over the closed `KnowledgeCommitFailureCode` union, has **no case for it**, and falls to `default: return "commit_failed"` ⇒ **a workspace-scope rejection is reported as a generic commit failure.**

⭐ **THE MECHANISM: a `default:` over a CLOSED union converts a compile-time obligation into a silent runtime re-classification.** The union's whole value is that it is enumerable — ⛔ **and `default:` throws that value away at exactly the moment it would have paid: the day someone adds a member.** **Nothing fails. Nothing warns. The new case quietly means something else.**

⭐⭐ **THE EVIDENCE THAT MAKES THIS A LESSON AND NOT A STYLE NOTE: THIS REPO CONTAINS BOTH PATTERNS, OVER SIBLING UNIONS.** `defaultSeverityForFailureClass` over `FailureClass` is **`assertNever`-guarded**, so adding a member there is a **compile error**. `mapWriteFailure` over `KnowledgeCommitFailureCode` is `default:`-terminated, so adding a member there is **silence.** ⇒ **the correct pattern was already available, already used, twenty lines away in the same subsystem.**

⚠ **THIS IS THE THIRD INSTANCE IN ONE ROUND of the same super-shape — *the vocabulary grew and the consumer did not*:** [L?/24.16](#123)'s citation rot (a comment claiming enum members do not exist, after they shipped) · **24.21**'s `kind` conflation (a union collapsing *hold* and *errored attempt* after the members to distinguish them arrived) · **and this.** ⭐ **All three were INVISIBLE while the vocabulary was poorer — and became defects the moment it grew, WITHOUT ANYONE EDITING THE DEFECTIVE FILE.** ⇒ ***a change to a shared vocabulary silently re-grades every consumer that did not move with it.***

⇒ **Do:** ⛔ **over a closed union, never `default:` — terminate with an `assertNever(x)` exhaustiveness guard** so the next member is a compile error. ⭐ **And when you WIDEN a closed union, the change is not done at the declaration: enumerate its consumers and check each one is exhaustive rather than absorbing.** ⚠ **A `default:` is legitimate over an OPEN domain** (a parsed string, an external code) — **the defect is specifically `default:` over something the type system could have enumerated for you.**

`pin: none.` `pattern: grep -rnE 'default:' --include='*.ts' packages apps | grep -v test` — **candidates**, not defects: classify each by whether its subject is a closed union. `accepted: partially enforceable` — the grep cannot tell a closed union from an open domain.

---

<a id="135"></a>
## 135. AN EXEMPTION PREDICATE REUSED OUTSIDE ITS ORIGINAL CALLER'S VALIDATED CALL ORDER NEEDS ITS OWN PRECONDITION — it does not inherit one

**Date:** 2026-08-11. **Origin:** 24.12, knowledge-implementer — **offered as a convention candidate and it is the traversal bug AND its fix in one sentence.**

**The instance.** `isStructuralSurface` correctly exempts the KN-12 writer-owned surfaces (`index.md`/`log.md`/`Logs/**`). It was **sound in its original home**, because `admitGroundedPath` runs a **traversal check FIRST** and only then consults it. ⛔ **Reused inside a new workspace-path guard WITHOUT that ordering, `"Logs/../employer-work-secret.md"` string-starts-with `"logs/"` and satisfies the exemption — while `path.resolve()` lands it at the VAULT ROOT, unprefixed.** ⭐ **The predicate did not change and did not become wrong; its GUARANTEE was never its own — it was the caller's.**

⭐ **THE MECHANISM: a predicate's soundness can live in its CALL ORDER rather than in its body, and call order does not travel with the symbol.** Reuse (correctly preferred over re-derivation — [L39](#39)) moves the body and **silently drops the context that made it safe.** ⇒ **the safest-looking refactor in this project's playbook is exactly the one that can strip a precondition.**

⚠ **AND THE SECOND HALF, which is why the fix is not "add a traversal check to the exemption": the same shape defeated the plain workspace-prefix match too.** ⇒ **the precondition belonged to the WHOLE guard, not to one branch — so it gates the entire function BEFORE any exemption or match.** ⛔ **An exemption evaluated before a traversal check is a hole BY CONSTRUCTION, whichever branch it sits in.**

⇒ **Do:** ⛔ **when lifting a predicate into a new caller, ask what the ORIGINAL caller did BEFORE calling it — and either reproduce that, or state in the predicate's own doc what it assumes.** ⭐ **Best form, taken here: make the precondition the new guard's FIRST step so no branch can be reached without it.** ⚠ **A string-prefix comparison is NOT a path-containment check; the gap between them is exactly where traversal lives.**

`pin: <24.12's traversal-lookalike tests — 3 via `applyPlan`, one per match kind>` `accepted: partially enforceable` — no gate detects a lifted predicate losing its caller's ordering. **Enforcement point: any refactor that EXPORTS a previously-inline predicate.**
