// spec(§9 workflow-1 L297, §6 KN-11, §5 WS-8, REQ-F-017) — 13.8g-A attendee → person-entity refs:
// the missing PRODUCER of the person refs 13.8f-A already grounds and fans out. Turns a meeting's
// rendered-only free-text attendee strings into `kind:"person"` EntityRefs, taking a display name ONLY
// from evidence in the string, excluding rooms/resources/group aliases deterministically, and dropping
// evidence-free strings rather than inventing a person. PURE; TOTAL never-throws; DORMANT.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, LIST_VALUED_EXTRACTION_FIELDS } from "@sow/contracts";
import type { WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import type { EntityCandidate, EntityGbrainReadPort } from "../src/synthesis/entity-resolver";
import type { SynthesisCandidate, SynthesisSectionPort } from "../src/synthesis/planner";
import { rewriteVaultForMeeting, MAX_ENTITY_REFS, type MeetingRewriteDeps } from "../src/synthesis/meeting-rewrite";
import { normalizeAttendees } from "../src/synthesis/attendee-refs";
import { scanProductionImporters, ungatedImporters } from "./support/dormancy-pin";

const names = (raw: unknown): string[] => normalizeAttendees(raw).refs.map((r) => r.name);

// ── 1. a name comes from evidence, never from an identifier (REQ-F-017) ──────────────

describe("normalizeAttendees — a display name is evidence, never synthesis (REQ-F-017)", () => {
  it("display_name_from_evidence_only — the angle-bracket display part becomes the name; a local-part NEVER does", () => {
    expect(names(['"Jane Doe" <jane@acme.com>'])).toEqual(["Jane Doe"]); // quoted RFC-5322 form
    expect(names(["Jane Doe <jane@acme.com>"])).toEqual(["Jane Doe"]); // unquoted
    expect(names(["Jane Doe"])).toEqual(["Jane Doe"]); // plain name, no address

    // A bare address is evidence of a PERSON but not of a NAME. The local-part is an identifier —
    // "jane.doe" must never be title-cased into the claim "Jane Doe" (that is an invented identity).
    const bare = normalizeAttendees(["jane.doe@acme.com"]);
    expect(bare.identifierOnlyRefs.map((r) => r.name)).toEqual(["jane.doe@acme.com"]); // VERBATIM
    expect(bare.refs).toEqual([]); // an address is not a name ⇒ it is not a nameable (stub-able) ref
    expect(JSON.stringify(bare)).not.toContain("Jane Doe");
  });

  it("every emitted ref is kind:person — the module produces exactly one entity class", () => {
    const n = normalizeAttendees(["Jane Doe <jane@acme.com>", "bob@acme.com"]);
    const all = [...n.refs, ...n.identifierOnlyRefs];
    expect(all.length).toBe(2);
    expect(all.every((r) => r.kind === "person")).toBe(true);
  });
});

// ── 2. a room is not a person — deterministic exclusion, fail-safe toward EXCLUDING ──

describe("normalizeAttendees — non-person attendees are excluded deterministically", () => {
  it("non_person_attendees_excluded — rooms, resources and group aliases never become person refs", () => {
    const nonPersons = [
      "Conference Room A",
      "Boardroom <room-3@acme.com>",
      "conf-room-2@acme.com",
      "team@acme.com",
      "all@acme.com",
      "no-reply@acme.com",
      "Engineering Team <eng-team@acme.com>",
      "projector-b@resource.calendar.google.com",
    ];
    const result = normalizeAttendees(nonPersons);
    expect(result.refs).toEqual([]); // a conference-room person note is vault corruption a human cleans up
    expect(result.withheld.every((w) => w.reason === "non_person")).toBe(true);
    expect(result.withheld.length).toBe(nonPersons.length);
  });

  it("identifier_shaped_display_never_becomes_a_name — the worst failure: minting a machine-named note", () => {
    // Every one of these was confirmed by review to mint a garbage person note. An `@`/`<`/`>` in a
    // display part means it is an identifier or a JOINED attendee list — never a human's name.
    const shapes = [
      "jane.doe@acme.com <jane.doe@acme.com>", // ICS CN == the address (routine Outlook output)
      "a@x.com, b@y.com", // comma-joined list
      "Jane Doe <jane@acme.com>, Bob Smith <bob@acme.com>", // joined, would bind Bob's addr to Jane
      "Jane Doe <jane@acme.com> <bob@evil.com>", // spoof shape
      "jane@@acme.com", // near-miss address
    ];
    for (const s of shapes) {
      const n = normalizeAttendees([s]);
      expect(n.refs, `must not name-ify: ${s}`).toEqual([]);
      // and nothing that survives may carry the delimiters that make it non-name-shaped
      for (const r of n.identifierOnlyRefs) expect(r.name).not.toMatch(/[<>,]/);
    }
    // the specific forbidden artifact this module exists to prevent
    expect(JSON.stringify(normalizeAttendees(["jane.doe@acme.com <jane.doe@acme.com>"]).refs)).not.toContain("jane.doe");
  });

  it("meeting-bridge attendees are excluded — the display list covers what it exists to catch", () => {
    // "Zoom Meeting" slipped through the first word list and would have minted zoom-meeting.md
    for (const s of ["Zoom Meeting <meet@acme.com>", "Webex Bridge", "Daily Huddle", "Calendar Resource"]) {
      expect(normalizeAttendees([s]).refs, `must not be a person: ${s}`).toEqual([]);
    }
  });

  it("internal group address without a dotted TLD is still a group — not a named person", () => {
    // `all-hands@acme` fails the strict ADDRESS shape; the local part must still be inspected
    const n = normalizeAttendees(["all-hands@acme", "team@corp"]);
    expect(n.refs).toEqual([]);
    expect(n.identifierOnlyRefs).toEqual([]);
    expect(n.withheld.every((w) => w.reason === "non_person")).toBe(true);
  });

  it("org_suffixed_display_degrades_not_drops — a real person is kept as an identifier, not lost", () => {
    // "(Platform Team)" is the NORM in Teams/Zoom/Granola exports. Excluding the suspect NAME is
    // right; losing the attendee is not. Degrade ⇒ identifier-only, which can never mint a note.
    const n = normalizeAttendees(["Jane Doe (Platform Team) <jane@acme.com>", "Bob (Acme Group) <bob@acme.com>"]);
    expect(n.refs).toEqual([]); // the suspect display name is not trusted as a person name …
    expect(n.identifierOnlyRefs.map((r) => r.name)).toEqual(["jane@acme.com", "bob@acme.com"]); // … but she survives
    // with NO address to fall back on there is nothing to keep, so it is a clean exclusion
    expect(normalizeAttendees(["Platform Team"]).identifierOnlyRefs).toEqual([]);
  });

  it("a real person is not swept up by the exclusion rule", () => {
    // the exclusion must not be so broad that ordinary attendees vanish
    expect(names(["Jane Doe <jane@acme.com>", "Roomi Patel <roomi@acme.com>", "Sam O'Neill <sam@acme.com>"])).toEqual([
      "Jane Doe",
      "Roomi Patel",
      "Sam O'Neill",
    ]);
  });
});

// ── 3. convergence without invented identity (KN-11) ─────────────────────────────────

describe("normalizeAttendees — duplicates collapse on string evidence only (KN-11)", () => {
  it("duplicates_collapse — the same person twice, and name+bare-email of the SAME address, yield ONE ref", () => {
    expect(names(["Jane Doe <jane@acme.com>", "Jane Doe <jane@acme.com>"])).toEqual(["Jane Doe"]);
    // same address, one form carrying a display name ⇒ ONE ref, and the NAMED form wins (more evidence)
    expect(names(["jane@acme.com", "Jane Doe <jane@acme.com>"])).toEqual(["Jane Doe"]);
    expect(names(["Jane Doe <jane@acme.com>", "jane@acme.com"])).toEqual(["Jane Doe"]);
    // case-insensitive on the address, which is the identity axis here
    expect(names(["Jane Doe <Jane@Acme.com>", "jane@acme.com"])).toEqual(["Jane Doe"]);
  });

  it("two DIFFERENT addresses are never merged, even under an identical display name", () => {
    // same-name-different-address is exactly the identity call that belongs to the resolver, not here
    expect(names(["Jane Doe <jane@acme.com>", "Jane Doe <jane.doe@personal.com>"]).length).toBe(2);
  });
});

// ── 4. no-inference + totality + bounds ──────────────────────────────────────────────

describe("normalizeAttendees — no-inference, total, bounded (REQ-F-017 / L11 / L31)", () => {
  it("unparseable_dropped_never_tbd_person — an evidence-free string is withheld with a REASON, never named TBD", () => {
    const result = normalizeAttendees(["", "   ", "???", "--", "@", "<>"]);
    expect(result.refs).toEqual([]);
    expect(result.identifierOnlyRefs).toEqual([]);
    // pin the exact reason vector — a bare "refs is empty" would pass even if classification regressed
    expect(result.withheld.map((w) => w.reason)).toEqual([
      "empty",
      "empty",
      "no_evidence",
      "no_evidence",
      "no_evidence",
      "no_evidence",
    ]);
  });

  it("withheld is bounded and over_cap is emitted once — the audit surface can't be ballooned", () => {
    const flood = Array.from({ length: 5_000 }, (_, i) => `Person ${i} <p${i}@acme.com>`);
    const n = normalizeAttendees(flood);
    expect(n.refs.length).toBe(MAX_ENTITY_REFS);
    expect(n.withheld.length).toBeLessThanOrEqual(MAX_ENTITY_REFS);
    expect(n.withheld.filter((w) => w.reason === "over_cap").length).toBe(1); // once, not once-per-element
  });

  it("bounds the WORK, not just the output — a hostile list terminates promptly", () => {
    // the ref cap alone doesn't bound cost: withheld/deduped entries never advance it
    const hostile = Array.from({ length: 50_000 }, () => `${"a".repeat(400)}@${"b".repeat(100)}.com`);
    const started = process.hrtime.bigint();
    const n = normalizeAttendees(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(n.refs.length).toBeLessThanOrEqual(1); // they all dedupe to one address
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("withheld_reasons_are_code_only — a withheld record never echoes the raw attendee string (rule 7)", () => {
    // attendee strings are UNTRUSTED imported content and may carry PII / employer-work content;
    // a reason code is redaction-safe, the original string is not.
    const secret = "Confidential Person <secret.person@employer-internal.example>";
    const result = normalizeAttendees([secret, "team@acme.com", "???"]);
    const serialized = JSON.stringify(result.withheld);
    expect(serialized).not.toContain("secret.person");
    expect(serialized).not.toContain("employer-internal");
    expect(serialized).not.toContain("Confidential");
  });

  it("pure_never_throws — null / non-string elements / an absurdly long string ⇒ fail-safe, no throw", () => {
    expect(normalizeAttendees(null).refs).toEqual([]);
    expect(normalizeAttendees(undefined).refs).toEqual([]);
    expect(normalizeAttendees("not an array" as unknown).refs).toEqual([]);
    expect(normalizeAttendees({} as unknown).refs).toEqual([]);

    // a valid attendee SURVIVES alongside hostile neighbours (per-element fail-safe, not whole-run)
    const mixed = normalizeAttendees([null, 42, {}, [], "Jane Doe <jane@acme.com>", undefined]);
    expect(mixed.refs.map((r) => r.name)).toEqual(["Jane Doe"]);
    expect(mixed.withheld.some((w) => w.reason === "not_a_string")).toBe(true);

    expect(() => normalizeAttendees(["x".repeat(100_000)])).not.toThrow();
    expect(normalizeAttendees(["x".repeat(100_000)]).refs).toEqual([]); // absurd length ⇒ withheld

    // a HOSTILE ITERABLE must not escape the total-function contract either
    const throwingIterable = { length: 1, get 0(): string { throw new Error("boom"); } };
    expect(() => normalizeAttendees(Array.from({ length: 0 }).concat(throwingIterable as never))).not.toThrow();
    const throwingProxy = new Proxy([], { get: (t, p) => { if (p === "slice") throw new Error("boom"); return Reflect.get(t, p); } });
    expect(() => normalizeAttendees(throwingProxy)).not.toThrow();
    expect(normalizeAttendees(throwingProxy).refs).toEqual([]);
  });

  it("bounded — beyond-cap attendees are sliced, sharing MAX_ENTITY_REFS (no second cap to drift)", () => {
    const many = Array.from({ length: MAX_ENTITY_REFS + 50 }, (_, i) => `Person ${i} <p${i}@acme.com>`);
    expect(normalizeAttendees(many).refs.length).toBe(MAX_ENTITY_REFS);
  });
});

// ── 5. WS-8 + the producer contract with 13.8f-A ─────────────────────────────────────

describe("normalizeAttendees — WS-8 and the 13.8f-A producer contract", () => {
  it("identifier_only_refs_resolve_but_never_stub — an unmatched address produces NO note (Q1 = b′)", async () => {
    const WS_A = "ws-a" as WorkspaceId;
    // A person note that carries the address as an ALIAS — the case passing the address verbatim buys.
    const aliased: EntityCandidate = {
      path: "people/jane-doe.md",
      slug: "jane-doe",
      title: "Jane Doe",
      aliases: ["jane@acme.com"],
      workspaceId: WS_A,
    };
    const mkDeps = (candidates: readonly EntityCandidate[]): MeetingRewriteDeps => ({
      gbrain: { workspaceId: WS_A, findCandidates: async () => ok(candidates) },
      reason: { reason: async () => ({}) },
      sections: { describe: () => ({ generatedRegionIds: [] }) },
      newPlanId: () => "plan-1",
      newRunId: () => "run-1",
    });
    const base = {
      workspaceId: WS_A,
      provenanceOrigin: "meeting_close" as ProvenanceOrigin,
      meetingNotePath: "meetings/m.md",
      sourceRefs: [{ sourceId: "meeting-1" }],
    };
    const identifierOnlyRefs = normalizeAttendees(["jane@acme.com"]).identifierOnlyRefs;

    // (1) it RESOLVES against the alias — the match still happens
    const hit = await rewriteVaultForMeeting({ ...base, identifierOnlyRefs }, mkDeps([aliased]));
    expect(hit.groundedPaths).toEqual(["people/jane-doe.md"]);

    // (2) with NO matching note it grounds nothing and mints NOTHING — no `jane-acme-com.md`
    const miss = await rewriteVaultForMeeting({ ...base, identifierOnlyRefs }, mkDeps([]));
    expect(miss.groundedPaths).toEqual([]);
    expect(miss.plans.flatMap((p) => p.creates)).toEqual([]);

    // (3) the SAME ref in the nameable bucket WOULD have stubbed — proves suppression is the cause,
    //     not an incidental no-op (resolveEntity returns create_stub, not withheld, on a no-match)
    const asNamed = await rewriteVaultForMeeting({ ...base, entityRefs: identifierOnlyRefs }, mkDeps([]));
    expect(asNamed.plans.flatMap((p) => p.creates).map((c) => c.path)).toEqual(["people/jane-acme-com.md"]);
  });

  it("named_ref_behavior_is_unchanged — omitting identifierOnlyRefs is byte-identical to before", async () => {
    const WS_A = "ws-a" as WorkspaceId;
    const deps: MeetingRewriteDeps = {
      gbrain: { workspaceId: WS_A, findCandidates: async () => ok([]) },
      reason: { reason: async () => ({}) },
      sections: { describe: () => ({ generatedRegionIds: [] }) },
      newPlanId: () => "plan-1",
      newRunId: () => "run-1",
    };
    const base = {
      workspaceId: WS_A,
      provenanceOrigin: "meeting_close" as ProvenanceOrigin,
      meetingNotePath: "meetings/m.md",
      sourceRefs: [{ sourceId: "meeting-1" }],
      entityRefs: normalizeAttendees(["Jane Doe"]).refs,
    };
    const without = await rewriteVaultForMeeting(base, deps);
    const withEmpty = await rewriteVaultForMeeting({ ...base, identifierOnlyRefs: [] }, deps);
    // a named ref still resolve-OR-STUBS exactly as it did before the carve-out existed
    expect(without.groundedPaths).toEqual(["people/jane-doe.md"]);
    expect(without.plans.flatMap((p) => p.creates).map((c) => c.path)).toEqual(["people/jane-doe.md"]);
    expect(withEmpty).toEqual(without);
  });

  it("emits_refs_only_no_workspace_binding — an attendee can never smuggle a cross-workspace bind", () => {
    const n = normalizeAttendees(['"Jane Doe" <jane@acme.com>', "ws-b:Bob <bob@acme.com>"]);
    for (const r of [...n.refs, ...n.identifierOnlyRefs]) {
      expect(Object.keys(r).sort()).toEqual(["kind", "name"]); // structurally incapable of carrying a ws
      expect(JSON.stringify(r)).not.toContain("workspace");
    }
  });

  it("feeds_the_planner_unmassaged — the refs drive 13.8f-A grounding with no adaptation", async () => {
    const WS_A = "ws-a" as WorkspaceId;
    const janeNote: EntityCandidate = { path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_A };
    const gbrain: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async (ref) => ok(ref.name === "Jane Doe" ? [janeNote] : []),
    };
    const sections: SynthesisSectionPort = { describe: () => ({ generatedRegionIds: [] }) };
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "people/jane-doe.md", regionId: "meetings", body: "attended standup", effect: "new_region" }],
    };
    const deps: MeetingRewriteDeps = {
      gbrain,
      reason: { reason: async () => candidate },
      sections,
      newPlanId: () => "plan-1",
      newRunId: () => "run-1",
    };

    // the whole point: `.refs` goes straight in as `entityRefs`, no mapping/renaming step
    const receipt = await rewriteVaultForMeeting(
      {
        workspaceId: WS_A,
        provenanceOrigin: "meeting_close" as ProvenanceOrigin,
        meetingNotePath: "meetings/2026-07-26-standup.md",
        sourceRefs: [{ sourceId: "meeting-1" }],
        confidence: 0.9,
        entityRefs: normalizeAttendees(['"Jane Doe" <jane@acme.com>', "conf-room-2@acme.com"]).refs,
      },
      deps,
    );

    expect(receipt.groundedPaths).toEqual(["people/jane-doe.md"]); // the person grounded …
    expect(receipt.plans.flatMap((p) => p.patches).some((p) => p.path === "people/jane-doe.md")).toBe(true);
    expect(receipt.groundedPaths.some((p) => /room/i.test(p))).toBe(false); // … and the room never entered
  });

  it("no_production_caller — every apps/ or workflows/ importer is arming-gated (dormant, L24/L52)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(ungatedImporters(scanProductionImporters("normalizeAttendees", repoRoot), "normalizeAttendees")).toEqual([]);
  });
});

// ── 6. the declared shape stays IN SYNC with what this consumer assumes (13.8g-C leg C) ──
//
// `normalizeAttendees` has assumed array-of-strings input since 13.8g-A (Array.isArray at entry,
// per-element typeof-string withholding) — dormant, ahead of its own wiring, and correct once leg A
// (packages/contracts) declared `attendees` list-valued. But nothing pinned the CORRESPONDENCE
// between "declared list-valued" and "consumed as a list": a future edit that drops "attendees" from
// `LIST_VALUED_EXTRACTION_FIELDS` would silently orphan this module's array assumption, with no test
// anywhere failing to say so. This asserts the real, imported declaration directly — never a locally
// re-derived belief (the lead's ruling, IMPLEMENTATION_PLAN.md #### 13.8g-C) — so that failure surfaces
// HERE, in the consumer's own suite, not only in contracts' declaration-side test
// (packages/contracts/test/models/agent-extraction.test.ts:239-240, which pins the declared SET's
// shape but says nothing about who consumes it as a list).

describe("normalizeAttendees — the consumer's array assumption matches the declared shape (13.8g-C leg C)", () => {
  it("attendees_is_declared_list_valued_in_the_shared_schema — pins the correspondence, not a re-derived belief", () => {
    expect(LIST_VALUED_EXTRACTION_FIELDS.includes("attendees")).toBe(true);
  });
});
