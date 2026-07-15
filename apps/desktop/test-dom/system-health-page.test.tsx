// @vitest-environment jsdom
//
// Task 14.3 (desktop leg) — the System Health panel. Pins: renders the retained UiSafeHealthItems
// (empty-until-data) using ONLY the UI-safe fields the worker projects; never renders/requests a
// raw field (message / auditRef / factIdentity are not even on UiSafeHealthItem).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SystemHealth } from "../renderer/surfaces/system-health";
import type { UiSafeHealthItem } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

const ITEM: UiSafeHealthItem = {
  id: "h1",
  failureClass: "worker_down",
  severity: "critical",
  state: "open",
  openedAt: "2026-07-15T00:00:00.000Z",
};

describe("System Health panel", () => {
  it("shows an all-clear empty state when there are no items (empty-until-data)", () => {
    render(<SystemHealth items={[]} />);
    expect(screen.getByText(/all clear/i)).toBeTruthy();
    expect(document.querySelectorAll("[data-health-id]")).toHaveLength(0);
  });

  it("renders the retained items' UI-safe fields (class / severity / state / timing)", () => {
    render(<SystemHealth items={[ITEM]} />);
    const row = document.querySelector('[data-health-id="h1"]');
    expect(row).not.toBeNull();
    expect(screen.getByText("worker_down")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
  });

  it("renders NOTHING beyond the UI-safe fields — a stray raw field on an item is never surfaced", () => {
    // Defense-in-depth: even if a malformed item smuggled a raw ref, the panel reads only the
    // 6 UI-safe fields (the worker already dropped message/auditRef/factIdentity).
    const tainted = { ...ITEM, message: "raw secret content", auditRef: "aud_leak" } as unknown as UiSafeHealthItem;
    render(<SystemHealth items={[tainted]} />);
    expect(screen.queryByText(/raw secret content/i)).toBeNull();
    expect(screen.queryByText(/aud_leak/i)).toBeNull();
  });
});
