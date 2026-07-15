# Session 080 — 13.12 connector round 8: OSB extractor Context7-verify + ING-7 admission pins (CLOSES the connector chain)

- **Date:** 2026-07-15
- **Phase:** Go-live build round 8 (runbook Phase-8 connector round — the OSB-extractor verify pass; CLOSES the connector chain). Team `session-734f946b`, orchestrator `orch21` + implementer `integrations-impl`, on `main`.
- **Predecessor:** [079-2026-07-15-integrations-impl-gmail-list-transport.md](079-2026-07-15-integrations-impl-gmail-list-transport.md)
- **Successor:** _(next session — the SPINE)_
- **Commits:** R8 verify `f21b2b8` · this session doc

## Why this session existed

Round 8 CLOSED the connector chain — a VERIFY + hardening pass (lead-ruled Option A, NOT a build) bringing the 4 dormant-complete OSB source extractors (web/podcast/youtube/file) to the same Context7-grounded bar as the 7 HTTP connectors, and — the load-bearing part — verifying + pinning that ING-7 read-only is genuinely enforced at JOB ADMISSION for untrusted source content. NO shape edits, NO count-pin bump, NO hard line (mappers stay emit-only; real parse/extract transports are deferred to the SPINE/arming).

## What was built

### Three-part verify pass (task 33, brief 084, `f21b2b8`)

**Files modified:**
- `packages/integrations/src/connectors/adapters/web-source.ts` · `podcast-source.ts` · `youtube-source.ts` · `file-source.ts` — **doc-only:** Context7 citation comments + arch_gap markers on each output interface + the youtube ING-7 header bullet + 2 defensive transport-mapping notes. Interfaces byte-unchanged.
- `packages/policy/test/admission.test.ts` — +8 ING-7 admission pins (an `it.each` over web/podcast/youtube/file).

## Decisions made

- **Part 1 — Context7 back-verify: 4/4 CONFORMANT, ZERO correctness bugs.** Field-by-field vs upstream; every dedupe-anchor/origin-id carried correctly (no Asana-`opt_fields`-class drop): `guid→episodeId` (podcast), `videoId` (youtube), `url` (web), `path` (file). All deltas cosmetic (naming) ⇒ citation comments only, NO shape edits. Sources: web → Context7 `/mozilla/readability`; podcast → RSS 2.0 spec (rssboard.org — no clean Context7 lib); youtube → Context7 `/jdepoix/youtube-transcript-api` + the yt-metadata wrapper; file → CONFORMANT-BY-DESIGN / arch_gap (config/osb.pin v0.11.1 `PENDING_NO_SUBTREE` — not Context7-verifiable, no vendored subtree to diff).
- **Part 2 — youtube ING-7 header fix (doc-only):** `youtube-source.ts` was the only one of the 4 missing the ING-7 read-only bullet (its 3 siblings carry it); added it, mirroring the file-source wording. The code was already emit-only (a doc-parity gap on Key Safety Rule 6, not a code-safety bug).
- **Part 3 (LOAD-BEARING) — ING-7 admission VERIFIED, NO GAP.** Traced the real enforcement (the brief's `untrustedJob`/`MUTATING_POLICY` are approximate — the actual symbols are `admitJob`/`admitsMutating`/`isTrusted` in `packages/policy/src/admission.ts` + `tool-policy.ts`): `admitJob` runs at JOB ADMISSION (broker step 1, before route/run/egress), is source-type-AGNOSTIC (gates on `job.trustLevel` — fail-closed, only explicit `"trusted"` bypasses — AND `admitsMutating`), so it covers every untrusted job (including one consuming any of the 4 source types' content) UNIFORMLY + non-bypassably. `!trusted && mutating ⇒ DENY UNTRUSTED_CONTENT_MUTATING_TOOL`; read-only ⇒ ADMIT. Pinned with +8 tests naming the 4 source types (untrusted+mutating REJECTED / read-only ADMITTED). Security adversarially confirmed no gap. **⇒ NO Finding to escalate.**
- **2 defensive transport-mapping notes** (for the future real transports at the SPINE/arming): web must map Readability `textContent` (NOT `content`/HTML) → `text`; youtube must join transcript segments in DOCUMENT ORDER — both protect the replay-stable `payloadHash` dedupe key.
- **Recon delegation:** the Part-1 field-by-field Context7 verification of the 4 shapes was run by a read-only general-purpose subagent (reported CONFORMANT verdicts + citations + the anchor-carried check); I owned the load-bearing Part-3 admission trace + the correctness calls + all edits.

## Decisions explicitly NOT made

- **No shape edits** — all 4 CONFORMANT; only citation comments + arch_gap markers (a shape edit would have required a TESTED correction; none was warranted).
- **No count-pin bump** — no new file; anti-corruption stays 19/19.
- **No template/gate widening** — the admission gate is already source-agnostic + fail-closed; nothing to change.
- **Real parse/extract transports** — deferred to the SPINE/arming (the mappers stay emit-only over faked transports; HARD LINE).
- **file-source re-verify** — deferred to whenever a real `vendor/osb/**` subtree is recorded (`subtree_sha` promoted from `PENDING_NO_SUBTREE`).

## TDD compliance

**CLEAN (verify-pass framing).** Part 3's +8 admission pins are regression-guards over already-correct enforcement (they pass immediately — the brief frames part 3 as VERIFY + PIN, not build). Part 1 found no drift ⇒ no RED-first corrections needed (unlike the Asana-verify pass, which had a real `opt_fields` correction). The doc edits are comment-only. Dual-reviewed at Step 8 (security = the load-bearing ING-7 verification). No behavior change beyond the (passing) pins.

## Reachability

- **No new production symbol** — a verify + doc pass. The extractors + admission predicates are already reachable (extractors via `registerSource`-governance tests + the source-ingestion path; `admitJob` via the brokered job-admission path). The +8 pins assert existing enforcement; the doc edits are comments.

## Open follow-ups

Step-9 categorized items (routed hot to orch21; it writes at the R8 seal / Carry-forward):
- **Architecture doc note (§8/§7):** the 4 OSB extractors Context7-verified (verdicts) + the ING-7 admission-layer enforcement locus (`admitJob`, source-agnostic, fail-closed) — the connector-chain close.
- **Convention candidate (providers LESSONS §6):** untrusted-source content is admitted READ-ONLY at JOB ADMISSION (`admitJob`, source-agnostic + fail-closed on trustLevel), NOT at the adapter — the adapter documents the posture; VERIFY the admission gate, don't trust the doc. orch21 is banking it as durable.
- **Future TODO (spine/arming):** the 2 defensive transport-mapping notes (web `textContent`-not-`content`; youtube document-order segment join); the real parse/extract extractor transports; file-source re-verify on a real OSB subtree.
- **Cross-doc invariant change:** NONE. Count-pin unchanged at 19.

## Connector chain — CLOSED

Rounds 2–8 delivered the full read-connector arc, all dormant behind the owner-gated arming line, every slice strict-TDD'd + dual-reviewed + Context7-grounded:
- **The SSRF predicate** (`isAllowedRemoteEndpoint`) + **the reusable template** (`createConnectorHttpTransport`) — spanning GET body-cursor, GET page-number (Link-header), and GraphQL-over-POST.
- **7 HTTP connectors:** Asana, Google Drive, Google Calendar, Granola, GitHub, Linear, Gmail (list-only).
- **4 OSB extractors** Context7-verified (web/podcast/youtube/file), ING-7 admission enforcement verified non-bypassable.

**NEXT = the SPINE** (connector → ingestion → content → gbrain) per the owner's breadth-first-then-spine decision; the real dormant extractor/connector transports fold into it. Real fetch/parse binding stays owner-gated arming (HARD LINE).
