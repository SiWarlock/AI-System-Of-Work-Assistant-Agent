// spec(§6 KN-10 / safety rules 1+7) — 13.8d: realpath containment on the living-vault rewrite adapter.
//
// `rewriteVaultForSource` derives note paths from synthesized entity content. Those paths are handed to
// KnowledgeWriter, whose commit gate does NOT itself verify that a note path lies inside the workspace
// tree — so the composition-root adapter is the enforcer, exactly as the projection layer is for the
// meeting/project paths. Containment is checked on the REAL paths (target AND root resolved), because a
// LEXICALLY-clean path can still traverse a symlinked directory out of the vault; that is the
// `copilotVaultRead.ts:104` pattern, and the desktop `guardVaultPath` analog.
//
// These run over a REAL tmpdir with a REAL symlink: the escape being closed is a filesystem property, and
// a mocked `realpath` would pin the mock rather than the behavior. This is also why the check lives here
// and not in `runSourceIngestion` — that driver is Temporal workflow-sandbox code, where an `fs` call is a
// determinism bug on top of a safety one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkspaceId } from "@sow/contracts";
import { createLivingVaultPort, createLivingVaultActivity } from "../src/composition/living-vault";
import type { ValidatedExtraction, SourceNoteIdentity } from "@sow/workflows/ports/sourceIngestion";

const WS = "ws-employer" as WorkspaceId;
const SOURCE: SourceNoteIdentity = { sourceId: "src-1" as never, contentHash: "hash-1" };
const VALIDATED = { fields: {} } as unknown as ValidatedExtraction;

let vaultRoot = "";
let outsideDir = "";

beforeAll(() => {
  vaultRoot = realpathSync(mkdtempSync(join(tmpdir(), "sow-vault-")));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "sow-outside-")));
  mkdirSync(join(vaultRoot, "notes"), { recursive: true });
  writeFileSync(join(outsideDir, "secret.md"), "# not in the vault\n");
  // The escape vector: a directory INSIDE the vault that really points outside it.
  symlinkSync(outsideDir, join(vaultRoot, "escape"));
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

/**
 * A plan carrying `path` in ONE of the four path-bearing mutation kinds. The default is `creates`, but
 * the real rewrite's structural-parity merge emits mostly PATCHES and FRONTMATTER updates (index regen +
 * op-log), so containment must police every kind — a `creates`-only fixture would leave the other three
 * loops uncovered.
 */
type PathKind = "creates" | "patches" | "linkMutations" | "frontmatterUpdates";
function planTouching(path: string, kind: PathKind = "creates"): KnowledgeMutationPlan {
  const empty = {
    planId: "lv-plan-1",
    workspaceId: WS,
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    sourceRefs: [],
    requiresApproval: false,
  };
  const mutation =
    kind === "creates"
      ? { creates: [{ path, body: "# note\n" }] }
      : kind === "patches"
        ? { patches: [{ path, regionId: "r", newBody: "x" }] }
        : kind === "linkMutations"
          ? { linkMutations: [{ srcPath: path, dstSlug: "other" }] }
          : { frontmatterUpdates: [{ path, key: "status", value: "open" }] };
  return { ...empty, ...mutation } as unknown as KnowledgeMutationPlan;
}

/** The adapter with an INJECTED rewrite, so these tests pin containment — not synthesis. */
function makePort(rewriteResult: () => Promise<{ plans: readonly KnowledgeMutationPlan[] }>) {
  return createLivingVaultPort({
    vaultRoot,
    rewrite: rewriteResult,
  });
}

describe("createLivingVaultPort — realpath containment (13.8d)", () => {
  it("contained_path_passes — a plan inside the vault root is returned unchanged", async () => {
    const plan = planTouching("notes/a.md");
    const port = makePort(() => Promise.resolve({ plans: [plan] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  it("containment_rejects_escaping_path — a SYMLINKED dir escaping the vault ⇒ fail-closed, NO plans", async () => {
    // Lexically this sits under the vault root; only the REAL path reveals it leaves.
    const port = makePort(() => Promise.resolve({ plans: [planTouching("escape/secret.md")] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("path_escape");
  });

  it("containment_polices_every_mutation_kind — patches / links / frontmatter escape too, not just creates", async () => {
    // The structural-parity half of a real rewrite lands as patches + frontmatter updates, so a
    // creates-only check would police the minority of production mutations.
    for (const kind of ["patches", "linkMutations", "frontmatterUpdates"] as const) {
      const port = makePort(() => Promise.resolve({ plans: [planTouching("escape/secret.md", kind)] }));
      const result = await port.rewrite(VALIDATED, WS, SOURCE);
      expect(isOk(result), `${kind} must be policed`).toBe(false);
    }
  });

  it("containment_rejects_escape_for_a_NOT_YET_EXISTING_note — the real CREATE case", async () => {
    // The escape a create must survive: the note does not exist, so containment cannot realpath the file
    // itself and must resolve the deepest EXISTING ancestor — which is the symlink. If the ancestor walk
    // were wrong, THIS is the case that would slip through while the existing-file test still passed.
    const port = makePort(() => Promise.resolve({ plans: [planTouching("escape/brand-new-note.md")] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("path_escape");
  });

  it("fail_closed_on_degenerate_paths — absolute, empty, and non-string paths are all rejected", async () => {
    for (const bad of ["/etc/passwd", "", null as unknown as string]) {
      const port = makePort(() => Promise.resolve({ plans: [planTouching(bad)] }));
      const result = await port.rewrite(VALIDATED, WS, SOURCE);
      expect(isOk(result), `path ${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  it("foreign_workspace_plan_rejected — a plan stamped for another workspace never reaches commit (WS-8)", async () => {
    const foreign = {
      ...(planTouching("notes/a.md") as unknown as Record<string, unknown>),
      workspaceId: "ws-someone-else",
    } as unknown as KnowledgeMutationPlan;
    const port = makePort(() => Promise.resolve({ plans: [foreign] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
  });

  it("containment_rejects_traversal — a `..` traversal is rejected lexically, before any fs touch", async () => {
    const port = makePort(() => Promise.resolve({ plans: [planTouching("../outside.md")] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("path_escape");
  });

  it("rejection_discloses_no_path — the surfaced fault leaks neither the vault root nor the offender", async () => {
    const port = makePort(() => Promise.resolve({ plans: [planTouching("escape/secret.md")] }));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      // Safety rule 7: a health/log sink must never receive raw paths or content.
      expect(result.error.message).not.toContain(vaultRoot);
      expect(result.error.message).not.toContain(outsideDir);
      expect(result.error.message).not.toContain("secret.md");
    }
  });

  it("all_or_nothing — ONE escaping plan rejects the whole set (no partial pass-through)", async () => {
    const port = makePort(() =>
      Promise.resolve({ plans: [planTouching("notes/ok.md"), planTouching("escape/secret.md")] }),
    );

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    // The contained sibling must NOT slip through — a partially-applied rewrite is exactly the
    // "no partial commit" failure mode the pipeline forbids.
    expect(isOk(result)).toBe(false);
  });

  it("unarmed_activity_is_inert — no bound port ⇒ an EMPTY plan set, so the dormant pipeline is unchanged", async () => {
    // The Temporal wrapper always binds this delegate (it is the only production entry into the driver),
    // so the ARMING gate has to live in the activity itself. Unarmed it must return an empty plan set —
    // not a failure — or the dormant path would surface a health degrade on every single ingest.
    const activity = createLivingVaultActivity(undefined);

    const result = await activity(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
  });

  it("armed_activity_delegates — a bound port is consulted and its plans pass through", async () => {
    const plan = planTouching("notes/a.md");
    const activity = createLivingVaultActivity(makePort(() => Promise.resolve({ plans: [plan] })));

    const result = await activity(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  it("rewrite_fault_is_typed_never_thrown — a THROWING rewrite folds to `rewrite_failed`", async () => {
    const port = makePort(() => Promise.reject(new Error("synthesis exploded")));

    const result = await port.rewrite(VALIDATED, WS, SOURCE);

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("rewrite_failed");
  });
});
