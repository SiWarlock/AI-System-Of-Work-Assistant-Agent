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

An untested false assurance is a gap. A **tested** one is worse in kind, not degree. `egressCommands.test.ts:83` and `:178` both asserted `zeroEgressOnly === true` after an egress revoke — a claim that was false whenever the workspace still allowed a cloud processor. The consequence is not merely that the bug was uncaught: **the suite actively defended it.** Anyone attempting the correct fix saw a red test, and red tests confer confidence — so they would back out *believing they had been stopped by a working safety net*. That inverts the gate: the assertion stops being a check on the code and becomes a lock on the code, holding the defect in place with the authority of the test suite behind it. The reflex to make a red test green is strong and mostly correct, which is exactly why **stopping to ask whether the test was right** has to be trained rather than assumed.

Two structural corollaries, both observed in this one slice. **(a) After fixing a construction, re-sweep the TESTS** for assertions that encoded the old behaviour — that is where a correct fix goes to die. One report yielded four artifacts: worker reported one pinning assertion, the lead found a second (a full-object `toEqual`, the more brittle form, and the one that survived the first fix), and a repo-wide sweep found two stale FAKES returning a combination the corrected producer can no longer emit. A fake modelling an impossible state is not defending anything, but it later reads as documentation of intended behaviour. **(b) An audit that reads only production code cannot find this class at all** — it lives in the assertions and fixtures (recorded as scope constraint 5 of task 24.6).

**Rule:** treat a test that asserts a safety VALUE as a claim requiring the same derivation check as the code it guards — a tested false assurance actively defends the defect, because the correct fix presents as a regression and the fixer backs out with a failing test's confidence. When correcting a safety construction: flip AND strengthen every assertion that encoded the old behaviour (prefer an independence/invariant assertion over a value assertion), re-sweep tests and fakes repo-wide rather than trusting the reported instance, and flag a test-semantics change on a safety pin explicitly instead of letting it disappear into a green suite. `pin: worker egressCommands.test.ts (revoke_return_makes_no_unearned_local_claim + the before==after independence assertion)`.

## <a id="70"></a>70. Verify the PROPERTY, not the MECHANISM — a mechanism check passes while the property fails, and that is exactly what a reviewer misses too

**Date:** 2026-07-26. **Source:** the implementer's own generalization after a fix reintroduced the defect class it closed **twice** in one round (13.8j, 13.8k).

Both times the tell was identical: the implementer verified that the **mechanism** was in place — the namespace is applied; the guard is called — but not that the **property** held — no root path is reachable; nothing enters the grounded set unvalidated. A mechanism check passes while the property fails, and crucially **a reviewer asking "does it apply the namespace?" misses it for the same reason.** Concretely: 13.8j applied a namespace via an object-literal lookup, so `__proto__`/`toString` resolved through the prototype chain and landed back at the vault root — namespace applied, property violated. 13.8k's `admitInto` was called on every path — guard called, property violated, because it returned `true` for an already-grounded path and callers key stub-creation off that return. The same shape recurs one level up in the pins: a structural pin searched for **the construction the author had used** (`grounded.add`) rather than **the property wanted** (nothing enters unvalidated), so seeding the set via `new Set([...])` bypassed both the admission point and the pin.

The practical consequence the implementer committed to, and it is cheap: **for any pin whose job is to prove an invariant, mutation-test it inside the slice rather than trusting it reads correctly.** Both of that slice's unsound pins looked fine on inspection — one was vacuous, one compared source text — and only deliberately breaking the code exposed them. Two extra runs, versus shipping a test that proves nothing forever.

**Rule:** state and verify the PROPERTY, not the mechanism that is supposed to deliver it — "no path targeting a writer-owned surface is reachable from any producer" rather than "the guard is called"; then adversarially test the property (hostile inputs, not just absent ones). Write pins against the property too, never against the construction you happened to use, or a different construction bypasses both code and pin. And mutation-test any invariant pin in the slice that introduces it: an inspection-passing pin can be vacuous or text-comparing, and only breaking the code distinguishes them. `pin: knowledge grounded-path.test.ts + synthesis-entity-resolver.test.ts (hostile-key + mutation-verified invariant pins)`.

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

`pin: worker provision-preserves-egress-posture.test.ts` (`re_provision_preserves_a_revoked_ack` · `same_type_overwrite_carries_policy_verbatim` · `carried_policy_with_a_foreign_workspaceid_does_not_land`)
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

`accepted: not mechanically enforceable` — mitigation: state the simulation, **the import path it reached**, and the passing set in the Step-9 report.

---

<a id="76"></a>
## 76. An unchecked cast on a READ path that feeds a WRITE path is the only validation boundary you have left

**2026-07-27 · 9.23 · generalized at the lead's request beyond the slice that surfaced it**

`packages/db`'s workspace `get` returns `row as Workspace` — an **unchecked cast, no Zod on the read path**. That is invisible and harmless while a stored row is only *read*. It stops being harmless the moment a value read that way is carried into a **write**, which is exactly what 9.23's fix does when it carries `existing.value.egressPolicy` forward.

At that point the re-parse (`WorkspaceSchema.parse` on the reassembled aggregate) is not a formality or belt-and-braces — **it is the only validation the stored blob ever receives before re-crossing into a write.** It catches a foreign `egressPolicy.workspaceId` (the identity refine), a contradictory `acknowledgedAt`-without-ack, a non-array allowlist, and any unknown key. Narrowing it to a hand-written id comparison — which reads like a tidy simplification — would silently drop all of that.

**Fail closed, do not normalize.** A foreign `workspaceId` is rejected rather than rewritten to the expected one: normalizing would graft another workspace's allowlist and acknowledgment onto this workspace, **stamped as if it belonged there** — a WS-8-adjacent write that looks entirely legitimate to every later reader. Same posture as the store-fault branch: never proceed over a contradictory prior state.

> **Find the read→write paths.** Wherever a repository read is typed by cast rather than parse, and its result can reach an `upsert`, the parse at the write boundary is load-bearing and must be commented as such — otherwise a future reader deletes it as redundant with "the type."

This is the read-path dual of the project's candidate-data rule (safety rule 2): provider output is untrusted until parsed, and **so is your own store's output once a cast is the only thing asserting its shape**.

`pin: worker provision-preserves-egress-posture.test.ts (carried_policy_with_a_foreign_workspaceid_does_not_land)`
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

> **Step 3 is the one that matters.** In the third occurrence a commit had *already* silently carried another area's session doc; it was caught only by checking afterwards and corrected with `reset --soft` + unstage + re-commit. **Steps 1 and 2 reduce the odds; step 3 is what tells you they failed.** Without it, the mis-attribution is discovered by whoever audits the hash months later, if ever.

A recovery via `reset --soft` is safe and correct here — it is *not* history rewriting, since the commit has not been shared. That is a different thing from rebasing a pushed or teammate-visible commit, which stays forbidden.

`accepted: not mechanically enforceable` — mitigation: the three-check procedure above; pathspec-limited commits as the default; `git status` before believing a red in a package you did not touch.
