// spec(§6) — assistant-region marker model + stable IDs + malformed-marker
// rejection (KN-8 / task 4.2): parseSections, renderRegion round-trip, upsert
// keeps a region's stable id across rewrites.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  parseSections,
  renderRegion,
  regionOpenMarker,
  regionCloseMarker,
  listRegionIds,
  getRegion,
  humanOwnedText,
  upsertRegionBody,
  type AssistantSection,
} from "../src/markdown-vault/sections";

const doc = (id: string, body: string, pre = "intro\n", post = "\noutro") =>
  `${pre}${regionOpenMarker(id)}\n${body}\n${regionCloseMarker(id)}${post}`;

describe("parseSections — well-formed", () => {
  it("splits human text and a marker-bounded assistant region with its id + body", () => {
    const content = doc("summary", "line one\nline two");
    const r = parseSections(content);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const secs = r.value;
    expect(secs.map((s) => s.kind)).toEqual(["human", "assistant", "human"]);

    const region = secs[1] as AssistantSection;
    expect(region.kind).toBe("assistant");
    expect(region.regionId).toBe("summary");
    expect(region.body).toBe("line one\nline two");
    // raw span is the exact marker-to-marker byte slice (used for byte-stability).
    expect(content.slice(region.start, region.end)).toBe(region.raw);
    expect(region.raw.startsWith(regionOpenMarker("summary"))).toBe(true);
    expect(region.raw.endsWith(regionCloseMarker("summary"))).toBe(true);
  });

  it("renderRegion round-trips: parsing a rendered region recovers the body verbatim", () => {
    const rendered = renderRegion("r1", "body\nwith\nnewlines");
    const r = parseSections(rendered);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toHaveLength(1);
    expect((r.value[0] as AssistantSection).body).toBe("body\nwith\nnewlines");
  });

  it("listRegionIds returns region ids in document order; getRegion fetches one", () => {
    const content = `${renderRegion("a", "x")}\n\n${renderRegion("b", "y")}`;
    const ids = listRegionIds(content);
    expect(isOk(ids)).toBe(true);
    if (!isOk(ids)) return;
    expect(ids.value).toEqual(["a", "b"]);
    expect(getRegion(content, "b")?.body).toBe("y");
    expect(getRegion(content, "missing")).toBeUndefined();
  });

  it("humanOwnedText concatenates only the human segments (region bodies excluded)", () => {
    const content = doc("s", "ASSISTANT-BODY", "human head ", " human tail");
    const r = parseSections(content);
    if (!isOk(r)) throw new Error("parse failed");
    const human = humanOwnedText(r.value);
    expect(human).toContain("human head");
    expect(human).toContain("human tail");
    expect(human).not.toContain("ASSISTANT-BODY");
  });
});

describe("parseSections — malformed markers are rejected (never silently accepted)", () => {
  it("rejects an unclosed region", () => {
    const r = parseSections(`intro\n${regionOpenMarker("x")}\nbody\nno close`);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("unclosed_region");
    expect(r.error.regionId).toBe("x");
  });

  it("rejects a close with no matching open", () => {
    const r = parseSections(`intro\n${regionCloseMarker("x")}\n`);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("unexpected_close");
  });

  it("rejects nested regions", () => {
    const r = parseSections(
      `${regionOpenMarker("a")}\n${regionOpenMarker("b")}\nx\n${regionCloseMarker("b")}\n${regionCloseMarker("a")}`,
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("nested_region");
  });

  it("rejects a mismatched close id", () => {
    const r = parseSections(
      `${regionOpenMarker("a")}\nx\n${regionCloseMarker("b")}`,
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("mismatched_close");
  });

  it("rejects a duplicate region id (stable ids must be unique per document)", () => {
    const r = parseSections(`${renderRegion("dup", "one")}\n${renderRegion("dup", "two")}`);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("duplicate_region_id");
    expect(r.error.regionId).toBe("dup");
  });
});

describe("upsertRegionBody — stable IDs across successive rewrites", () => {
  it("replaces an existing region body in place, preserving its id and position", () => {
    const v1 = `head\n${renderRegion("keep", "v1")}\ntail`;
    const r = upsertRegionBody(v1, "keep", "v2");
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const v2 = r.value;
    // same logical region keeps its id across the rewrite (KN-8).
    expect(listRegionIds(v2)).toEqual({ ok: true, value: ["keep"] });
    expect(getRegion(v2, "keep")?.body).toBe("v2");
    // human text is byte-stable.
    expect(v2.startsWith("head\n")).toBe(true);
    expect(v2.endsWith("\ntail")).toBe(true);
  });

  it("appends a new region when the id is absent, leaving prior content intact", () => {
    const base = "only human text";
    const r = upsertRegionBody(base, "new", "generated");
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.startsWith(base)).toBe(true);
    expect(getRegion(r.value, "new")?.body).toBe("generated");
  });

  it("refuses to upsert into a malformed document", () => {
    const r = upsertRegionBody(`${regionOpenMarker("x")}\nunclosed`, "x", "b");
    expect(isErr(r)).toBe(true);
  });
});
