// spec(13.14) — researchNotePath: the WS-8 canonical path authority for the /research
// governed flow's single note-create target, mirroring meetingNotePath/projectNotePath
// (noteSlug.ts) EXACTLY: server-bound workspaceId segment (never a model value), a
// safeNoteSlug leaf (no separators, no "..", cannot escape the workspace folder after
// the vault's join(root, note.path)), and fail-closed (null) on an unsafe segment or an
// empty-after-slug topic.
import { describe, it, expect } from "vitest";
import { workspaceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { researchNotePath } from "../src/activities/projections/noteSlug";

describe("spec(13.14, WS-8) researchNotePath — canonical /research note path", () => {
  it("composes Research/Web/<workspaceId>/<safeLeaf>.md from a topic string", () => {
    const path = researchNotePath(workspaceId("ws-1"), "Rust async runtimes 2026");
    expect(path).toBe("Research/Web/ws-1/Rust-async-runtimes-2026.md");
  });

  it("fails closed (null) when the topic sanitizes to empty (no safe anchor)", () => {
    expect(researchNotePath(workspaceId("ws-1"), "***")).toBeNull();
  });

  it("fails closed (null) when the workspace segment carries a path separator (defense-in-depth)", () => {
    // The WorkspaceId brand (### 24.84) now rejects "/"/".." itself (a bounded lowercase
    // slug regex), so this branch is unreachable through the public constructor — a cast
    // simulates the historically-possible bypass (### 24.100) this authority still guards
    // against, mirroring meetingNotePath/projectNotePath's own defense-in-depth stance.
    const hostile = "ws/../evil" as unknown as WorkspaceId;
    expect(researchNotePath(hostile, "topic")).toBeNull();
  });
});
