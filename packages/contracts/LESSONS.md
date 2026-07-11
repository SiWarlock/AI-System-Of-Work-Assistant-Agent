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
