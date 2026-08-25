// spec(§6 KN-10, §5 WS-8) — 13.8a EntityResolver, the ⭐ start of the ARC-4 living-vault
// synthesis keystone. Grounds a referenced entity (person/project/concept) to an EXISTING
// canonical vault note path via a WS-8-scoped GBrain read — resolving to a real path,
// deciding a create-stub, or WITHHOLDING (ambiguous/lossy) — and NEVER fabricating a path
// (osb's ground-before-write rule, governed). Pure over an injected read port; TOTAL
// never-throws; fail-closed to withheld. Safety rule 4: never resolves across workspaces.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { ok, err, EntityRefSchema, workspaceId } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import {
  resolveEntity,
  stubNotePathFor,
  mintEntityStub,
  NAMESPACED_ENTITY_KINDS,
  type EntityCandidate,
  type EntityGbrainReadPort,
  type EntityReadFault,
  type EntityResolution,
  type EntityKind,
  type EntityRef,
} from "../src/synthesis/entity-resolver";
import { renderGeneratedRegion } from "../src/markdown-vault/sections";
import { rewriteVaultForMeeting, type MeetingRewriteDeps } from "../src/synthesis/meeting-rewrite";
import { planSynthesis, type SynthesisDeps, type SynthesisInput } from "../src/synthesis/planner";
import { unsafeWorkspaceIdForTest } from "./support/workspace-id";

// 24.92: real branded constructors, not anonymous casts — `makeId` now runs the brand's own
// schema (L-series), so these two also double as a (weak) proof the fixture ids are well-formed.
const WS_A = workspaceId("ws-a");
const WS_B = workspaceId("ws-b");

const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({
  workspaceId: WS_A,
  ...o,
});

function fakePort(
  workspaceId: WorkspaceId,
  impl: () => Result<readonly EntityCandidate[], EntityReadFault>,
): EntityGbrainReadPort {
  return { workspaceId, findCandidates: async () => impl() };
}

// ── 1. resolves an EXISTING note (faithful slug / title / alias) ──────────────────

describe("resolveEntity — grounds a referenced entity to an EXISTING note (KN-10)", () => {
  it("resolves_exact_slug_alias_hit_to_real_path — a faithful title match ⇒ the existing note path", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" })]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "people/jane-doe.md" });
  });

  it("resolves on an alias match too", async () => {
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API", aliases: ["acme"] })]),
    );
    const r = await resolveEntity({ name: "acme", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "projects/acme-api.md" });
  });

  it("a slug-form ref matches the candidate slug even when the title differs", async () => {
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "projects/acme-api.md", slug: "acme-api", title: "The Acme API Project" })]),
    );
    const r = await resolveEntity({ name: "acme-api", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "projects/acme-api.md" });
  });

  it("duplicate candidate ROWS for the same note resolve (not a false ambiguous)", async () => {
    // a read adapter that unions slug + title/alias hits can return the same note twice
    const port = fakePort(WS_A, () =>
      ok([
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe.md", slug: "jane-doe", aliases: ["Jane Doe"] }),
      ]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "people/jane-doe.md" });
  });
});

// ── 2. no existing note ⇒ create-stub (distinct from unresolved) ──────────────────

describe("resolveEntity — no existing note ⇒ create-stub decision", () => {
  it("no_note_yields_create_stub_decision — carries the proposed slug for the planner", async () => {
    const port = fakePort(WS_A, () => ok([]));
    const r = await resolveEntity({ name: "New Project X", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "create_stub", proposedSlug: "new-project-x" });
  });
});

// ── 3. ambiguous / lossy ⇒ WITHHELD (never fabricates, never arbitrary-picks) ─────

describe("resolveEntity — withholds, never fabricates or arbitrary-picks (ground-before-write)", () => {
  it("ambiguous_or_lossy_withholds_never_fabricates — 2+ faithful candidates ⇒ withheld(ambiguous)", async () => {
    const port = fakePort(WS_A, () =>
      ok([
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe-2.md", slug: "jane-doe-2", title: "Jane Doe" }),
      ]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "ambiguous" });
  });

  it("a lossy collision (C++ vs an existing 'c' note) withholds — never resolved, never stubbed-into-collision", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "concepts/c.md", slug: "c", title: "C" })]));
    const r = await resolveEntity({ name: "C++", kind: "concept" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "lossy_match" });
  });

  it("a space↔hyphen-only diff against a slug-only candidate withholds (Q1 safe ruling)", async () => {
    // 'Acme API' would slugify to the existing 'acme-api' but faithfully matches no title/alias
    const port = fakePort(WS_A, () => ok([cand({ path: "projects/acme-api.md", slug: "acme-api" })]));
    const r = await resolveEntity({ name: "Acme API", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "lossy_match" });
  });

  it("a name with no usable slug anchor ⇒ withheld(malformed_entity), no read issued", async () => {
    let called = false;
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => {
        called = true;
        return ok([]);
      },
    };
    const r = await resolveEntity({ name: "   ", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "malformed_entity" });
    expect(called).toBe(false);
  });
});

// ── 4. WS-8 isolation (safety rule 4) — never resolves across workspaces ──────────

describe("resolveEntity — WS-8 isolation: never resolves across workspaces (rule 4)", () => {
  it("ws8_never_resolves_across_workspaces — a port bound to a different ws ⇒ withheld, NO read", async () => {
    let called = false;
    const port: EntityGbrainReadPort = {
      workspaceId: WS_B,
      findCandidates: async () => {
        called = true;
        return ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_B })]);
      },
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "ws_scope_mismatch" });
    expect(called).toBe(false);
  });

  it("a foreign-workspace candidate is DROPPED, never returned as resolved", async () => {
    // ws-a-scoped port but a hit carries ws-b (a leaked foreign row) → dropped → not resolved
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_B })]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r.kind).not.toBe("resolved"); // the foreign path is NEVER resolved
    expect(r).toEqual({ kind: "create_stub", proposedSlug: "jane-doe" }); // dropped ⇒ treated as no note
  });
});

// ── 5. fail-closed to unresolved on any GBrain fault (Lesson 11 TOTAL) ────────────

describe("resolveEntity — fail-closed to withheld on any read fault (Lesson 11 TOTAL)", () => {
  it("gbrain_fault_fails_closed_to_unresolved — a read err ⇒ withheld(gbrain_unavailable)", async () => {
    const port = fakePort(WS_A, () => err({ code: "read_fault" }));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("a throwing read port never escapes — folds to withheld", async () => {
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => {
        throw new Error("socket hang up");
      },
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("a malformed (non-array) read payload fails closed", async () => {
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => ok("nope" as unknown as readonly EntityCandidate[]),
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("an element whose property access throws folds to withheld (Lesson 11 element-level TOTAL)", async () => {
    // a hostile candidate row whose `slug` getter throws must not escape the resolver
    const hostile = new Proxy({ path: "x.md", slug: "x", workspaceId: WS_A } as EntityCandidate, {
      get(target, prop, recv) {
        if (prop === "slug") throw new Error("boom");
        return Reflect.get(target, prop, recv);
      },
    });
    const port = fakePort(WS_A, () => ok([hostile]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });
});

// ── 13.8j — entity stub paths are NAMESPACED, derived ONCE (§6 KN-12, safety rule 1) ──
//
// An entity name is untrusted (13.8g-A feeds it from meeting attendee strings). Minting a stub at
// the vault ROOT let a name like `Index`/`Log` collide with the KnowledgeWriter-owned KN-12
// structural surfaces — `MeetingRewriteDeps` omits the `structural` port precisely so a meeting
// cannot touch those, and root-level minting reached them by another door. The fix is a NAMESPACE
// (complete-by-construction for every present AND future structural filename), not a reserved-name
// denylist (enumeration is unwinnable — worker L72, §ARM-18 18.39-B).

describe("stubNotePathFor — entity stubs are namespaced, never root (13.8j)", () => {
  const stub = (proposedSlug: string): EntityResolution => ({ kind: "create_stub", proposedSlug });

  it("kind_namespacing — every EntityKind gets a self-describing prefix; none may sit at the root", () => {
    expect(stubNotePathFor(stub("jane-doe"), "person")).toBe("people/jane-doe.md");
    expect(stubNotePathFor(stub("acme-api"), "project")).toBe("projects/acme-api.md");
    expect(stubNotePathFor(stub("rate-limiting"), "concept")).toBe("concepts/rate-limiting.md");
    // no kind may resolve to a bare root path — the property the namespace exists to guarantee
    for (const kind of NAMESPACED_ENTITY_KINDS) {
      expect(stubNotePathFor(stub("x"), kind)).toMatch(/^[a-z]+\/x\.md$/);
    }
  });

  it("structural_surface_names_cannot_be_minted — a REAL resolve of `Index`/`Log` never reaches a root file", async () => {
    // Drive the whole path (resolveEntity ⇒ entitySlug ⇒ stubNotePathFor) rather than hand-feeding a
    // pre-lowercased slug — otherwise the test never exercises the slugification it depends on.
    const port = fakePort(WS_A, () => ok([]));
    for (const name of ["Index", "Log", "README", "Home", "Logs", "index", "LOG"]) {
      for (const kind of NAMESPACED_ENTITY_KINDS) {
        const resolution = await resolveEntity({ name, kind }, WS_A, { gbrain: port });
        expect(resolution.kind).toBe("create_stub"); // non-vacuous: a stub really is proposed
        const path = stubNotePathFor(resolution, kind)!;
        expect(["index.md", "log.md", "readme.md", "home.md", "logs.md"], `${name}/${kind}`).not.toContain(path);
        expect(path.startsWith("Logs/"), `${name}/${kind} reached the op-log subtree`).toBe(false);
        expect(path.includes("/")).toBe(true);
      }
    }
    expect(stubNotePathFor(await resolveEntity({ name: "Index", kind: "person" }, WS_A, { gbrain: port }), "person")).toBe(
      "people/index.md",
    );
  });

  it("unknown_kind_falls_back_to_a_namespace_not_the_root — incl. PROTOTYPE keys (kind rides candidate data)", () => {
    // `kind` reaches the planner from a model candidate, so a malformed value must degrade to a
    // namespace, never the root (that would silently reopen the hole this slice closes).
    //
    // The prototype keys are the sharp ones: with an object-literal lookup, `__proto__`/`toString`/
    // `constructor` return a non-undefined value from Object.prototype, so `?? FALLBACK` never fires
    // and the path lands back at the ROOT ("[object Object]index.md"). A Map has no such keys.
    // Model-supplied means ADVERSARIAL-SHAPED by default, not merely optional — so the vectors are
    // hostile values, not just an absent field.
    const hostile = [
      // prototype-chain keys: a bare `NAMESPACES[kind]` read resolves these to inherited Object
      // members, yielding "a namespace that isn't a namespace" (contracts L41, same fail-open as the
      // TargetSystem write-adapter registry). Explicit membership only — never a bare index.
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "prototype",
      // path-shaped: closes the loop between entitySlug's traversal collapsing and the namespace
      // layer — a separator-bearing kind must not escape the vault or double-prefix.
      "../",
      "people/../..",
      "a/b",
      "/etc",
      // wrong-case / padded: the lookup is EXACT-MATCH by decision (no normalization), so these fall
      // back. Pinned so the choice is deliberate rather than incidental.
      "Person",
      "person ",
      " person",
      "PERSON",
      // plain garbage
      "not-a-kind",
      "",
    ];
    for (const kind of hostile) {
      const path = stubNotePathFor(stub("whatever"), kind as unknown as EntityKind)!;
      expect(path, `kind=${JSON.stringify(kind)} escaped the namespace`).toBe("entities/whatever.md");
      // the result is a single-segment namespaced path — no escape, no double prefix
      expect(path.startsWith("/"), `kind=${JSON.stringify(kind)} produced an absolute path`).toBe(false);
      expect(path).not.toContain("..");
      expect(path.split("/").length).toBe(2);
    }
    expect(stubNotePathFor(stub("whatever"), undefined)).toBe("entities/whatever.md");
  });

  it("only_create_stub_mints — a resolved or withheld resolution yields no path at all", () => {
    expect(stubNotePathFor({ kind: "resolved", path: "people/jane-doe.md" }, "person")).toBeNull();
    expect(stubNotePathFor({ kind: "withheld", reason: "ambiguous" }, "person")).toBeNull();
    expect(stubNotePathFor(stub(""), "person")).toBeNull(); // an empty slug is not a path
  });

  it("traversal_collapse_still_holds — the namespace ADDS to entitySlug's guarantee, never replaces it", async () => {
    const port = fakePort(WS_A, () => ok([]));
    const r = await resolveEntity({ name: "../../etc/passwd", kind: "person" }, WS_A, { gbrain: port });
    expect(r.kind).toBe("create_stub");
    const path = stubNotePathFor(r, "person")!;
    expect(path).toBe("people/etc-passwd.md"); // collapsed by entitySlug, then namespaced
    expect(path).not.toContain("..");
    expect(path.startsWith("/")).toBe(false);
  });

  it("path_derivation_lives_once_repo_wide — no inline stub-path template-literal construction remains ANYWHERE in the repo, not just packages/knowledge/src", () => {
    // The duplication IS what enabled the defect: two call sites derived the same path, so the fix
    // had to be applied twice by hand. This pins the single-derivation property (forbidden-pattern
    // #6 / L39) so a third consumer inherits the namespace instead of re-deriving the bug.
    //
    // 13-residual-2: `stubNotePathFor` is PUBLIC via the `@sow/knowledge` barrel (a cross-file import
    // already exists at meeting-rewrite.ts:47), so a consumer OUTSIDE `packages/knowledge/src` — a
    // different package entirely — could re-derive a stub path inline with this pin, scoped to
    // `packages/knowledge/src` only, never seeing it. Widened to the REPO ROOT, excluding only
    // build/dependency artifacts (never a source directory — the whole point is to stop excluding
    // source).
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const EXCLUDE_DIRS = new Set(["node_modules", "dist", "out", "graphify-out"]);
    const INLINE_MINT = /\$\{[^}]*proposedSlug[^}]*\}\s*\.md|\$\{[^}]*proposedSlug[^}]*\}`?\s*\+?\s*"\.md"/;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) return EXCLUDE_DIRS.has(e.name) ? [] : walk(join(dir, e.name));
        return e.name.endsWith(".ts") ? [join(dir, e.name)] : [];
      });
    const allFiles = walk(repoRoot);
    const offenders = allFiles.filter((f) => INLINE_MINT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    // non-vacuity #1 (inherited from the narrower pin this widens): the pattern DOES catch the
    // construction it is meant to forbid. Built via `.replace`, not a literal template string —
    // spelling the violation out literally here would make THIS FILE's own source match the pattern
    // once the walk includes `packages/knowledge/test/` (as the repo-wide walk now does), which would
    // be this pin failing on itself rather than proving anything about production code.
    const syntheticViolation = "const stubPath = `${resolution.PLACEHOLDER}.md`;".replace(
      "PLACEHOLDER",
      "proposedSlug",
    );
    expect(INLINE_MINT.test(syntheticViolation)).toBe(true);
    // non-vacuity #2 (13-residual-2's OWN point, not inherited): the widened walk genuinely reaches
    // OUTSIDE packages/knowledge/src. An over-narrow EXCLUDE that silently visited nothing outside it
    // would make `offenders` pass VACUOUSLY, indistinguishable from the old, narrower scope this test
    // replaces — so assert the walk actually left it, not merely that its result "looks the same".
    const knowledgeSrcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const outsideKnowledgeSrc = allFiles.filter((f) => !f.startsWith(knowledgeSrcRoot));
    expect(outsideKnowledgeSrc.length).toBeGreaterThan(0);
    expect(outsideKnowledgeSrc.some((f) => f.includes(join("packages", "contracts", "src")))).toBe(true);
  });

  it("stub_body_derivation_lives_once — renderGeneratedRegion(\"stub\" is rendered in EXACTLY ONE file", () => {
    // 13-residual-1's companion to `path_derivation_lives_once_repo_wide` above: `stubNotePathFor`
    // derived the PATH once already (13.8j); the BODY (`renderGeneratedRegion("stub", "")`) was still
    // built independently at both call sites until `mintEntityStub` (above) unified it. Scoped to
    // `packages/knowledge/src` (not repo-wide, unlike the path pin): the body-render call is not
    // exported through the barrel the way `stubNotePathFor` is, so there is no cross-package exposure
    // to widen against.
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      );
    const STUB_BODY = 'renderGeneratedRegion("stub"';
    const withStubBody = walk(srcRoot).filter((f) => readFileSync(f, "utf8").includes(STUB_BODY));
    expect(withStubBody).toEqual([resolve(srcRoot, "synthesis", "entity-resolver.ts")]);
    // non-vacuity: the substring check DOES catch the exact shape a hand-copied duplicate call takes
    // (the shape planner.ts and meeting-rewrite.ts each carried independently before this slice).
    expect(`autoM.creates.push({ path: stubPath, body: ${STUB_BODY}, "") });`.includes(STUB_BODY)).toBe(true);
  });

  it("mintEntityStub returns null in EXACTLY the cases stubNotePathFor does, else the NoteCreate", () => {
    const resolved: EntityResolution = { kind: "resolved", path: "people/jane-doe.md" };
    const withheld: EntityResolution = { kind: "withheld", reason: "ambiguous" };
    const stub: EntityResolution = { kind: "create_stub", proposedSlug: "new-person" };
    expect(mintEntityStub(resolved, "person")).toBeNull();
    expect(mintEntityStub(withheld, "person")).toBeNull();
    expect(mintEntityStub(stub, "person")).toEqual({
      path: "people/new-person.md",
      body: renderGeneratedRegion("stub", ""),
    });
  });

  it("meeting_and_planner_paths_mint_byte_identical_stub_creates_for_the_same_resolution", async () => {
    // Drives BOTH real production entry points end-to-end (not just `mintEntityStub` called twice,
    // which would only prove the function agrees with itself, never that either call site actually
    // uses it) with the SAME entity ref, and compares the resulting `NoteCreate`.
    const ref: EntityRef = { name: "New Person", kind: "person" };
    const emptyPort: EntityGbrainReadPort = { workspaceId: WS_A, findCandidates: async () => ok([]) };

    const meetingReceipt = await rewriteVaultForMeeting(
      {
        workspaceId: WS_A,
        provenanceOrigin: "meeting_close" as ProvenanceOrigin,
        meetingNotePath: "meetings/standup.md",
        sourceRefs: [{ sourceId: "meeting-1" }],
        entityRefs: [ref],
      },
      {
        gbrain: emptyPort,
        reason: { reason: async () => ({}) },
        sections: { describe: () => ({ generatedRegionIds: [] }) },
        newPlanId: () => "plan-meeting",
        newRunId: () => "run-meeting",
      } satisfies MeetingRewriteDeps,
    );
    const meetingStub = meetingReceipt.plans.flatMap((p) => p.creates).find((c) => c.path === "people/new-person.md");

    const plannerOutcome = await planSynthesis(
      {
        workspaceId: WS_A,
        provenanceOrigin: "meeting_close" as ProvenanceOrigin,
        sourceRefs: [{ sourceId: "src-1" }],
      } satisfies SynthesisInput,
      {
        gbrain: emptyPort,
        reason: { reason: async () => ({ entityRefs: [ref] }) },
        sections: { describe: () => ({ generatedRegionIds: [] }) },
        newPlanId: () => "plan-planner",
      } satisfies SynthesisDeps,
    );
    const plannerStub =
      plannerOutcome.ok &&
      plannerOutcome.value.plans.flatMap((p) => p.creates).find((c) => c.path === "people/new-person.md");

    // non-vacuity FIRST — `undefined === undefined` would satisfy a bare `toEqual` below.
    expect(meetingStub, "the meeting path minted no stub").toBeDefined();
    expect(plannerStub, "the planner path minted no stub").toBeDefined();
    expect(meetingStub).toEqual(plannerStub); // byte-identical NoteCreate from two independent call sites
    expect(meetingStub).toEqual({ path: "people/new-person.md", body: renderGeneratedRegion("stub", "") });
  });
});

// ── 13.8k — a poisoned candidate ROW cannot resolve to a writer-owned surface ─────
//
// `candidate.path` arrives VERBATIM from the GBrain read, shape-guarded only as a non-empty
// string. A row carrying `path: "index.md"` plus a faithfully-matching title used to resolve
// there — reaching the KN-12 navigation catalog through the RESOLVED door (13.8j closed the
// stub-minting one). A refusal WITHHOLDS; it never sanitizes into a different path.

describe("resolveEntity — a poisoned candidate path is withheld, never resolved (13.8k)", () => {
  it("structural_surface_path_cannot_be_grounded — a faithful title over index.md/log.md withholds", async () => {
    for (const poisoned of ["index.md", "log.md", "Logs/2026-07-26.md"]) {
      const port = fakePort(WS_A, () => ok([cand({ path: poisoned, slug: "jane-doe", title: "Jane Doe" })]));
      const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
      expect(r.kind, `${poisoned} resolved`).not.toBe("resolved");
      // Q4: the structural-surface hit is the SECURITY-relevant refusal and gets its own greppable
      // reason, distinct from a generic malformed path.
      expect(r).toEqual({ kind: "withheld", reason: "structural_surface" });
    }
  });

  it("shape_invalid_candidate_path_withholds — absolute / traversal / non-.md rows never resolve", async () => {
    for (const bad of ["/etc/passwd.md", "../../secrets.md", "people/jane", "people\\jane.md"]) {
      const port = fakePort(WS_A, () => ok([cand({ path: bad, slug: "jane-doe", title: "Jane Doe" })]));
      const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
      expect(r.kind, `${bad} resolved`).not.toBe("resolved");
    }
  });

  it("refusal_withholds_never_sanitizes — no repaired path is emitted, and the reason is code-only", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "/employer-secret/jane.md", slug: "jane-doe", title: "Jane Doe" })]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "unsafe_shape" }); // shape failure; no `path` key at all
    expect(JSON.stringify(r)).not.toContain("employer-secret");
  });

  it("a poisoned row can never WIN a resolution — it is either ambiguous or refused", async () => {
    // Two shapes, and neither lets `index.md` become the resolved path:
    //  (a) the poisoned row faithfully matches ⇒ 2 distinct paths ⇒ withheld(ambiguous). The guard is
    //      not even reached, and that is fine: the poisoned path still never wins.
    //  (b) the poisoned row is the ONLY match ⇒ the guard fires ⇒ withheld(structural_surface).
    // (A poisoned row that does NOT faithfully match is dropped by the match filter before the guard,
    // so there is no arrangement in which a poisoned sibling coexists with a resolved legitimate one.)
    const both = fakePort(WS_A, () =>
      ok([
        cand({ path: "index.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
      ]),
    );
    const a = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: both });
    expect(a).toEqual({ kind: "withheld", reason: "ambiguous" });

    const onlyPoisoned = fakePort(WS_A, () => ok([cand({ path: "index.md", slug: "jane-doe", title: "Jane Doe" })]));
    const b = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: onlyPoisoned });
    expect(b).toEqual({ kind: "withheld", reason: "structural_surface" });
  });
});

// ── §DEC-CANDGATE leg 2 (13.19) — a DETERMINISTIC caller is unaffected by the new boundary gate ──
//
// The new `EntityRefSchema` check lives in planner.ts's `collectEntities` — the MODEL-supplied
// `candidate.entityRefs` path — not inside `resolveEntity` itself. `attendee-refs.ts:242`'s
// deterministic producer (`{ name, kind: "person" }`, consumed directly by meeting-rewrite.ts via
// `resolveEntity`, never through `collectEntities`) is therefore UNAFFECTED: this pins that a direct
// `resolveEntity` call behaves exactly as before leg 2, so the gate closes the class without also
// gating a caller it was never meant to touch (the brief's "once at the boundary, not per consumer").

describe("resolveEntity — a deterministic caller-supplied ref is unaffected by the §DEC-CANDGATE boundary gate (leg 2)", () => {
  it("a_deterministic_caller_supplied_ref_is_unaffected — the attendee-refs.ts producer shape resolves exactly as before", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" })]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "people/jane-doe.md" });
  });
});

// ── 13.21 — EntityRef is ELEMENT-IMMUTABLE through knowledge's own import path (owner ruling C) ──
//
// 13.19 deleted knowledge's own EntityRef (which carried `readonly name`/`readonly kind`) and
// re-exported contracts' (mutable) — every consumption site's `readonly EntityRef[]` stayed in
// place, but that only protects the ARRAY (rejecting element REPLACEMENT), never a FIELD on an
// element (`arr[0].name = "x"`). This restores the ELEMENT-level guarantee as a DERIVED narrowing
// over contracts' EntityRef (never a second declaration, so it cannot drift — 13.21 brief), reached
// by every existing consumer of `./entity-resolver` (or the `@sow/knowledge` barrel) by NAME, with
// zero call-site churn.

describe("EntityRef — element-immutable through knowledge's own import path (13.21)", () => {
  it("ref_fields_cannot_be_mutated_via_knowledges_import — a field write does not type-check", () => {
    // ⚠ TYPECHECK-VERIFIED, NOT RUNTIME-VERIFIED: `neverInvoked` never executes (a mutation would
    // succeed at runtime on a plain JS object regardless of its TS type) — the guarantee this pins
    // lives entirely in `tsc --noEmit` (this repo's `lint` gate, run at /preflight), NOT in
    // `vitest run` (vitest's transform strips types and never evaluates `@ts-expect-error`). A green
    // `vitest run` alone does not mean this guard is intact — only a clean typecheck does; a reverted
    // narrowing would leave this test passing under `vitest run` regardless.
    function neverInvoked(ref: EntityRef): void {
      // @ts-expect-error — `name` must be readonly through knowledge's own EntityRef (13.21); an
      // UNUSED directive here (TS2578) means the field is still mutable, i.e. this pin is failing.
      ref.name = "mutated";
    }
    void neverInvoked;
    expect(true).toBe(true);
  });

  it("a_valid_ref_is_still_constructible_and_readable — non-vacuity: the narrowed type isn't unusable", () => {
    const ref: EntityRef = { name: "Jane Doe", kind: "person" };
    expect(ref.name).toBe("Jane Doe");
    expect(ref.kind).toBe("person");
  });

  it("schema_output_assigns_to_the_narrowed_type — EntityRefSchema's success value needs no cast", () => {
    const parsed = EntityRefSchema.safeParse({ name: "Jane Doe", kind: "person" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // contracts' (mutable) parse output assigning to knowledge's (immutable) narrowed type is a safe
    // widening-to-readonly — if this needed a cast, the narrowing would be fighting the candidate-
    // data gate 13.19 exists to call.
    const ref: EntityRef = parsed.data;
    expect(ref.name).toBe("Jane Doe");
  });

  it("array_element_immutability_is_what_changed — readonly EntityRef[] now blocks field mutation too", () => {
    // ⚠ TYPECHECK-VERIFIED, NOT RUNTIME-VERIFIED — same caveat as the first test in this block:
    // `neverInvoked` never executes; the guarantee lives in `tsc --noEmit`, not in this test's own
    // runtime pass/fail.
    function neverInvoked(refs: readonly EntityRef[]): void {
      // @ts-expect-error — element REPLACEMENT was already rejected pre-13.21 (array-level readonly,
      // unchanged by this slice) — this directive is USED both before and after.
      refs[0] = { name: "New", kind: "person" };
      // @ts-expect-error — element FIELD mutation is the NEW guarantee this slice restores: UNUSED
      // (TS2578) before 13.21, USED after — this is the actual delta the slice makes.
      refs[0].name = "mutated";
    }
    void neverInvoked;
    expect(true).toBe(true);
  });
});

// ── 24.92 — no anonymous `as WorkspaceId` cast remains in the OWNED test files ────────────────────
//
// An EXPLICIT population, never a directory walk: `packages/knowledge/test/` also holds
// `gcl-projection.test.ts` (wave 1) and `decide-enablement.test.ts`/`provenance-stamp.test.ts`
// (owned by KNOW-2) — all three OUT OF SCOPE for this task, and a directory walk would flag files
// this package must not touch (or silently mask a real one of ITS OWN as "covered"). Every anonymous
// cast found here was converted to the REAL `workspaceId()` constructor (`@sow/contracts`) — every
// site was a benign fixture id, never a value the brand would reject, so the NEW
// `unsafeWorkspaceIdForTest` (`./support/workspace-id.ts`) has zero callers among these files.

describe("24.92 — no anonymous WorkspaceId cast remains in the owned test files", () => {
  it("no_anonymous_workspace_id_cast_remains_in_the_owned_test_files", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    // The EXACT population this task owns (brief's `ownedDirs`, minus the three explicit exclusions
    // above). Listing it explicitly — rather than walking `readdirSync(testDir)` — is what keeps this
    // pin from either flagging an out-of-scope file or silently widening its own coverage unnoticed.
    const OWNED_FILES = [
      "synthesis-entity-resolver.test.ts",
      "synthesis-planner.test.ts",
      "synthesis-link-healer.test.ts",
      "meeting-rewrite.test.ts",
      "validation-refusal-audit.test.ts",
      "gcl-visibility-gate.test.ts",
      "writer.test.ts",
      "remediation-router.test.ts",
      "generative-proposal-intake.test.ts",
      "attendee-refs.test.ts",
      "gbrain-crash-recovery-reconciler.test.ts",
      "gbrain-mcp-read-adapter.test.ts",
      "gbrain-parity.test.ts",
      "gbrain-rebuild.test.ts",
      "gbrain-write-through-flag.test.ts",
      "grounded-path.test.ts",
      "ingest-rewrite.test.ts",
      "quarantine-ledger.test.ts",
      "rehydration-serving-gate.test.ts",
      "vault-rehydrate.test.ts",
    ];
    // A prose reference to the OLD pattern (e.g. this very describe block's own header comment, or a
    // file's own "24.92" migration note) must not read as a live offender — only a CODE line counts.
    const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
    const ANONYMOUS_CAST = /\bas\s+WorkspaceId\b/;
    const offenders: string[] = [];
    for (const file of OWNED_FILES) {
      const src = readFileSync(resolve(testDir, file), "utf8");
      src.split("\n").forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
        if (ANONYMOUS_CAST.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
    // non-vacuity: the pattern DOES catch a synthetic bare cast on a CODE line, and correctly
    // IGNORES the identical text sitting in a comment (the shape this file's own 24.92 migration
    // notes now take, which must never self-trigger this pin). Built via `.replace`, not a literal
    // template — spelling the violation out unbroken here would make THIS FILE's own source an
    // offender the moment the scan reaches this line, which is this pin failing on itself rather
    // than proving anything about the owned population.
    const syntheticCast = 'const bad = "x" PLACEHOLDER WorkspaceId;'.replace("PLACEHOLDER", "as");
    expect(ANONYMOUS_CAST.test(syntheticCast)).toBe(true);
    const syntheticCommentedCast = "// " + syntheticCast;
    expect(COMMENT_LINE.test(syntheticCommentedCast)).toBe(true);
  });
});

describe("24.92 — the shared unsafeWorkspaceIdForTest (./support/workspace-id.ts) behaves as documented", () => {
  // Not exercised by any OTHER test in the files this package owns — zero genuine bypasses were
  // found among them (every anonymous cast was a benign fixture id, converted to `workspaceId()`
  // instead — see the pin above). Verified here directly so the shared helper itself is proven, not
  // merely asserted, for whichever future OWNED test genuinely needs it.
  it("refuses a benign value — the SAME guard gcl-projection.test.ts's own copy enforces", () => {
    expect(() => unsafeWorkspaceIdForTest("ws-acme")).toThrow(/refusing a benign value/u);
    expect(() => unsafeWorkspaceIdForTest("ws.acme")).not.toThrow(); // a `.` is outside [a-z0-9-] ⇒ admitted
  });

  it("passes a value the brand would reject straight through, byte-identical", () => {
    const hostile = "https://u:hunter2@evil.example";
    expect(unsafeWorkspaceIdForTest(hostile)).toBe(hostile);
  });
});
