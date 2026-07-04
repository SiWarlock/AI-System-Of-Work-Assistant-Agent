import { describe, it, expect } from "vitest";
import { resolveDocPack } from "../../renderer/surfaces/projects/docpack";
import type { UiSafeManagedDoc } from "@sow/contracts/api/ui-safe";

const CANONICAL_SLOTS = ["00_brief", "01_decisions", "02_meetings", "03_research", "04_open_questions"];
const CANONICAL_TITLES = ["00 Brief", "01 Decisions", "02 Meeting Digest", "03 Research", "04 Open Questions"];

describe("resolveDocPack (§4.5 — overlay the read-model pack onto the 5 canonical slots)", () => {
  it("empty read-model pack → all 5 canonical slots in order, unlinked/unknown, canonical titles", () => {
    const view = resolveDocPack([]);
    expect(view.map((d) => d.slot)).toEqual(CANONICAL_SLOTS);
    expect(view.map((d) => d.title)).toEqual(CANONICAL_TITLES);
    expect(view.every((d) => d.linkState === "unlinked" && d.syncState === "unknown")).toBe(true);
  });

  it("a partial pack overlays only its slots; the rest stay unlinked/unknown (robust to a partial read-model)", () => {
    const linked: UiSafeManagedDoc = { slot: "01_decisions", title: "Decisions.gdoc", linkState: "linked", syncState: "synced" };
    const view = resolveDocPack([linked]);
    expect(view.map((d) => d.slot)).toEqual(CANONICAL_SLOTS); // always the full ordered pack
    const decisions = view.find((d) => d.slot === "01_decisions");
    expect(decisions).toMatchObject({ linkState: "linked", syncState: "synced", title: "Decisions.gdoc" });
    // every OTHER slot is the honest default
    expect(view.filter((d) => d.slot !== "01_decisions").every((d) => d.linkState === "unlinked" && d.syncState === "unknown")).toBe(true);
  });

  it("an OUT-OF-ORDER read-model pack is rendered in CANONICAL order (display order is not read-model order)", () => {
    const pack: UiSafeManagedDoc[] = [
      { slot: "04_open_questions", title: "04 Open Questions", linkState: "unlinked", syncState: "unknown" },
      { slot: "00_brief", title: "00 Brief", linkState: "linked", syncState: "stale" },
    ];
    const view = resolveDocPack(pack);
    expect(view.map((d) => d.slot)).toEqual(CANONICAL_SLOTS);
    expect(view[0]).toMatchObject({ slot: "00_brief", linkState: "linked", syncState: "stale" });
  });
});
