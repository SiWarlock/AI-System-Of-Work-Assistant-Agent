// spec(§5) — ToolPolicy evaluation: deny-wins effective allowlist + admitsMutating
// predicate (mode / flag / injected mutating-tool catalog); read_only forces
// effective non-mutating regardless of declared tools.
import { describe, it, expect } from "vitest";
import { toolId, effectiveAllowedTools } from "@sow/contracts";
import type { ToolId, ToolPolicy } from "@sow/contracts";
import { admitsMutating } from "../src/tool-policy";

const tp = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  mode: "read_only",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: false,
  ...over,
});

describe("effective allowlist — deny wins", () => {
  it("drops a tool present in both allowedTools and deniedTools", () => {
    const p = tp({
      mode: "scoped_write",
      allowedTools: [toolId("notion.write"), toolId("gbrain.search")],
      deniedTools: [toolId("notion.write")],
    });
    expect(effectiveAllowedTools(p)).toEqual([toolId("gbrain.search")]);
  });
});

describe("admitsMutating", () => {
  it("scoped_write mode admits mutation (mode-level)", () => {
    expect(admitsMutating(tp({ mode: "scoped_write" }))).toBe(true);
  });

  it("allowsMutating flag admits mutation", () => {
    expect(admitsMutating(tp({ mode: "scoped_write", allowsMutating: true }))).toBe(true);
  });

  it("read_only with no mutation is non-mutating", () => {
    expect(admitsMutating(tp({ mode: "read_only" }))).toBe(false);
  });

  it("read_only forces non-mutating regardless of declared tools + injected catalog", () => {
    const p = tp({ mode: "read_only", allowedTools: [toolId("notion.write")] });
    const isMut = (): boolean => true; // catalog flags everything mutating
    expect(admitsMutating(p, isMut)).toBe(false);
  });

  it("deny wins: a denied mutating tool is never in the effective allowlist", () => {
    const isMut = (t: ToolId): boolean => t === toolId("notion.write");
    const p = tp({
      mode: "scoped_write",
      allowedTools: [toolId("notion.write")],
      deniedTools: [toolId("notion.write")],
    });
    expect(effectiveAllowedTools(p).some(isMut)).toBe(false);
  });
});
