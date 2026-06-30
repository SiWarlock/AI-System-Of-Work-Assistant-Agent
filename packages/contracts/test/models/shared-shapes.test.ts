import { describe, it, expect } from "vitest";
import {
  ContextRefSchema,
  SourceRefSchema,
  NoteCreateSchema,
  NotePatchSchema,
  LinkMutationSchema,
  FrontmatterPatchSchema,
  CanonicalSourceRefSchema,
} from "../../src/models/shared-shapes";

describe("shared nested sub-shapes (.strict())", () => {
  it("ContextRefSchema parses valid + rejects an extra key", () => {
    expect(ContextRefSchema.parse({ refKind: "page", ref: "projects/acme" })).toEqual({
      refKind: "page",
      ref: "projects/acme",
    });
    expect(ContextRefSchema.safeParse({ refKind: "page", ref: "x", extra: 1 })).toMatchObject({
      success: false,
    });
    expect(ContextRefSchema.safeParse({ refKind: "", ref: "x" })).toMatchObject({
      success: false,
    });
  });

  it("SourceRefSchema parses with/without span + rejects an extra key", () => {
    expect(SourceRefSchema.parse({ sourceId: "src-1" })).toEqual({ sourceId: "src-1" });
    expect(SourceRefSchema.parse({ sourceId: "src-1", span: "L1-L4" })).toEqual({
      sourceId: "src-1",
      span: "L1-L4",
    });
    expect(SourceRefSchema.safeParse({ sourceId: "", span: "x" })).toMatchObject({
      success: false,
    });
    expect(SourceRefSchema.safeParse({ sourceId: "src-1", nope: true })).toMatchObject({
      success: false,
    });
  });

  it("NoteCreateSchema parses valid (+ optional title/frontmatter) + rejects an extra key", () => {
    expect(NoteCreateSchema.parse({ path: "p.md", body: "hi" })).toEqual({
      path: "p.md",
      body: "hi",
    });
    expect(
      NoteCreateSchema.parse({
        path: "p.md",
        title: "T",
        body: "hi",
        frontmatter: { a: 1, b: "x" },
      }),
    ).toMatchObject({ path: "p.md", title: "T" });
    expect(NoteCreateSchema.safeParse({ path: "p.md", body: "hi", x: 1 })).toMatchObject({
      success: false,
    });
  });

  it("NotePatchSchema (KN-8 region-bounded) parses valid + rejects an extra key", () => {
    expect(
      NotePatchSchema.parse({ path: "p.md", regionId: "r1", newBody: "new" }),
    ).toEqual({ path: "p.md", regionId: "r1", newBody: "new" });
    expect(
      NotePatchSchema.safeParse({ path: "p.md", regionId: "r1", newBody: "new", x: 1 }),
    ).toMatchObject({ success: false });
  });

  it("LinkMutationSchema parses add/remove + rejects bad op + extra key", () => {
    expect(LinkMutationSchema.parse({ op: "add", srcPath: "a.md", dstSlug: "b" })).toEqual({
      op: "add",
      srcPath: "a.md",
      dstSlug: "b",
    });
    expect(
      LinkMutationSchema.parse({ op: "remove", srcPath: "a.md", dstSlug: "b", field: "rel" }),
    ).toMatchObject({ op: "remove", field: "rel" });
    expect(
      LinkMutationSchema.safeParse({ op: "nuke", srcPath: "a.md", dstSlug: "b" }),
    ).toMatchObject({ success: false });
    expect(
      LinkMutationSchema.safeParse({ op: "add", srcPath: "a.md", dstSlug: "b", x: 1 }),
    ).toMatchObject({ success: false });
  });

  it("FrontmatterPatchSchema parses valid (value: unknown) + rejects an extra key", () => {
    expect(
      FrontmatterPatchSchema.parse({ path: "p.md", key: "status", value: "done" }),
    ).toMatchObject({ path: "p.md", key: "status", value: "done" });
    expect(
      FrontmatterPatchSchema.parse({ path: "p.md", key: "n", value: 42 }),
    ).toMatchObject({ value: 42 });
    expect(
      FrontmatterPatchSchema.safeParse({ path: "p.md", key: "k", value: 1, x: 2 }),
    ).toMatchObject({ success: false });
  });

  it("CanonicalSourceRefSchema parses both kinds + rejects bad kind + extra key", () => {
    expect(CanonicalSourceRefSchema.parse({ kind: "markdown", ref: "p.md" })).toEqual({
      kind: "markdown",
      ref: "p.md",
    });
    expect(
      CanonicalSourceRefSchema.parse({ kind: "source_envelope", ref: "src-1", span: "L1" }),
    ).toEqual({ kind: "source_envelope", ref: "src-1", span: "L1" });
    expect(
      CanonicalSourceRefSchema.safeParse({ kind: "scratch", ref: "x" }),
    ).toMatchObject({ success: false });
    expect(
      CanonicalSourceRefSchema.safeParse({ kind: "markdown", ref: "x", y: 1 }),
    ).toMatchObject({ success: false });
  });
});
