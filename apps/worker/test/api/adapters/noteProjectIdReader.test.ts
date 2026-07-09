// §13.10a live-wiring step 1 — the concrete `NoteProjectIdReader` (gate 1's slug-collision read).
// The adapter turns a WS-8-scoped note read into the executor's port: read the note's content, extract
// its frontmatter `projectId` UNESCAPED (via @sow/knowledge `readFrontmatterField`, the inverse of the
// writer's `serializeScalar`), fold any read fault into a redaction-safe FailureVariant. Never throws.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { serializeScalar } from "@sow/knowledge";
import {
  createNoteProjectIdReader,
  createNoteExistsProbe,
  type WorkspaceNoteRead,
} from "../../../src/api/adapters/noteProjectIdReader";

const WS = "personal-business" as unknown as WorkspaceId;
const note = (fmLines: string): string => `---\n${fmLines}\n---\nbody\n`;

describe("createNoteProjectIdReader", () => {
  it("returns the frontmatter projectId for an existing note", async () => {
    const read = createNoteProjectIdReader(async () => note("projectId: acme-corp\ntitle: Acme"));
    const r = await read("projects/personal-business/acme-corp.md", WS);
    expect(isOk(r) && r.value).toBe("acme-corp");
  });

  it("UNESCAPES a quoted (coercible) projectId — the gate-1 raw-equality correctness case", async () => {
    const raw = "2024-migration"; // digit-leading ⇒ quoted on disk
    const read = createNoteProjectIdReader(async () => note(`projectId: ${serializeScalar(raw)}\ntitle: X`));
    const r = await read("projects/personal-business/2024-migration.md", WS);
    expect(isOk(r) && r.value).toBe(raw);
  });

  it("returns ok(undefined) when the note is absent (read ⇒ undefined) — a CREATE target is free", async () => {
    const read = createNoteProjectIdReader(async () => undefined);
    const r = await read("projects/personal-business/new.md", WS);
    expect(isOk(r)).toBe(true);
    expect(isOk(r) && r.value).toBeUndefined();
  });

  it("returns ok(undefined) when the note carries no projectId frontmatter key", async () => {
    const read = createNoteProjectIdReader(async () => note("title: Orphan\nlifecycleState: active"));
    const r = await read("projects/personal-business/orphan.md", WS);
    expect(isOk(r)).toBe(true);
    expect(isOk(r) && r.value).toBeUndefined();
  });

  it("folds a read fault into a redaction-safe FailureVariant (never throws, no raw cause leaks)", async () => {
    const secret = "ENOENT: /Users/someone/private/vault/secret-path.md";
    const read = createNoteProjectIdReader(async () => {
      throw new Error(secret);
    });
    let r: Awaited<ReturnType<typeof read>>;
    await expect(
      (async () => {
        r = await read("projects/personal-business/x.md", WS);
      })(),
    ).resolves.toBeUndefined(); // resolved, not rejected — never throws
    expect(isErr(r!)).toBe(true);
    if (isErr(r!)) {
      // Only a bounded cause code crosses — never the raw path / error message (safety rule 7).
      expect(JSON.stringify(r!.error)).not.toContain("secret-path");
      expect(JSON.stringify(r!.error)).not.toContain("/Users/");
      expect(r!.error.cause).toEqual({ code: "NOTE_PROJECT_ID_READ_FAULT" });
    }
  });

  it("passes the (path, workspaceId) through to the injected read verbatim (WS-8 scoping)", async () => {
    const seen: { path: string; ws: WorkspaceId }[] = [];
    const read = createNoteProjectIdReader(async (path: string, ws: WorkspaceId) => {
      seen.push({ path, ws });
      return note("projectId: acme");
    });
    await read("projects/personal-business/acme.md", WS);
    expect(seen).toEqual([{ path: "projects/personal-business/acme.md", ws: WS }]);
  });

  it("has the exact WorkspaceNoteRead call signature", () => {
    // type-level guard: a (path, ws) => Promise<string | undefined> is assignable.
    const fn: WorkspaceNoteRead = async (_p: string, _w: WorkspaceId) => undefined;
    expect(typeof createNoteProjectIdReader(fn)).toBe("function");
  });

  it("never throws / never leaks when the read hands back a non-string (untyped-JS boundary violation)", async () => {
    // A misbehaving read returning e.g. a Buffer must not throw past the boundary; treat as no id.
    const read = createNoteProjectIdReader((async () => Buffer.from("x")) as unknown as WorkspaceNoteRead);
    const r = await read("projects/personal-business/x.md", WS);
    expect(isOk(r)).toBe(true);
    expect(isOk(r) && r.value).toBeUndefined();
  });
});

describe("createNoteExistsProbe (gate-1 create-clobber guard — keys on REAL existence)", () => {
  it("reports true when the note exists — INCLUDING a note with no projectId (the data-loss case)", async () => {
    const withId = createNoteExistsProbe(async () => note("projectId: acme\ntitle: X"));
    const noId = createNoteExistsProbe(async () => note("title: Just a human note, no projectId"));
    const empty = createNoteExistsProbe(async () => ""); // an empty-but-present file still exists
    expect(isOk(await withId("p", WS)) && (await withId("p", WS) as { value: boolean }).value).toBe(true);
    const rNoId = await noId("p", WS);
    expect(isOk(rNoId) && rNoId.value).toBe(true); // a projectId-presence proxy would WRONGLY say "free" here
    const rEmpty = await empty("p", WS);
    expect(isOk(rEmpty) && rEmpty.value).toBe(true);
  });

  it("reports false when the note is absent (read ⇒ undefined) — the create target is free", async () => {
    const probe = createNoteExistsProbe(async () => undefined);
    const r = await probe("projects/personal-business/new.md", WS);
    expect(isOk(r) && r.value).toBe(false);
  });

  it("folds a read fault into a redaction-safe FailureVariant (never throws, no raw leak)", async () => {
    const probe = createNoteExistsProbe(async () => {
      throw new Error("ENOENT: /Users/someone/private/vault/x.md");
    });
    const r = await probe("p", WS);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(JSON.stringify(r.error)).not.toContain("/Users/");
      expect(r.error.cause).toEqual({ code: "NOTE_PROJECT_ID_READ_FAULT" });
    }
  });

  it("FAILS CLOSED (err, not 'free') on a non-string, non-undefined read — a create-clobber guard must not overwrite on ambiguity", async () => {
    const probe = createNoteExistsProbe((async () => Buffer.from("x")) as unknown as WorkspaceNoteRead);
    const r = await probe("p", WS);
    expect(isErr(r)).toBe(true); // NOT ok(false) — reporting "free" here would allow an overwrite
  });
});
