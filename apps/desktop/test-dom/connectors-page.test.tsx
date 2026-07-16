// @vitest-environment jsdom
//
// Task 14.2 (desktop leg) — the connectors surface deterministic flow (visual = /design-review).
// Pins: register → connectorConfig.register with the tokenRef REFERENCE (never echoed/retained,
// rule 7); enable/pause → setState; cadence → setCadence; a NON-onboarded scope (null workspaceId)
// disables the form (WS-8); a failure → a safe error state.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Connectors, type ConnectorsProps } from "../renderer/surfaces/connectors";
import type { UiSafeConnectorInstanceView } from "../renderer/lib/connector-config";

afterEach(cleanup);

const OK = (over: Partial<UiSafeConnectorInstanceView> = {}): { ok: true; instance: UiSafeConnectorInstanceView } => ({
  ok: true,
  instance: { instanceId: "drive@ws_a", connectorId: "drive", workspaceId: "ws_a", state: "paused", cadence: "@daily", ...over },
});

function renderConnectors(over: Partial<ConnectorsProps> = {}): ConnectorsProps {
  const props: ConnectorsProps = {
    workspaceId: "ws_a",
    instances: [],
    onRegister: vi.fn().mockResolvedValue(OK()),
    onSetState: vi.fn().mockResolvedValue(OK({ state: "enabled" })),
    onSetCadence: vi.fn().mockResolvedValue(OK({ cadence: "@hourly" })),
    ...over,
  };
  render(<Connectors {...props} />);
  return props;
}

describe("Connectors surface", () => {
  it("registering submits the tokenRef REFERENCE + config to onRegister, then CLEARS the input (rule 7)", async () => {
    const props = renderConnectors();
    const tokenInput = screen.getByRole("textbox", { name: /token reference/i }) as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: "keychain://my-drive-token" } });
    fireEvent.click(screen.getByRole("button", { name: /register connector/i }));
    await waitFor(() => expect(props.onRegister).toHaveBeenCalledTimes(1));
    expect(props.onRegister).toHaveBeenCalledWith({
      instanceId: "drive@ws_a",
      connectorId: "drive",
      workspaceId: "ws_a",
      tokenRef: "keychain://my-drive-token",
      cadence: "@daily",
    });
    // The entered reference is cleared after submit — never retained / echoed back.
    await waitFor(() => expect(tokenInput.value).toBe(""));
    expect(screen.queryByText(/keychain:\/\/my-drive-token/)).toBeNull();
  });

  it("enable/pause calls onSetState with the OPPOSITE state; set-cadence uses the ROW's own cadence value", async () => {
    const props = renderConnectors({ instances: [OK().instance] }); // one PAUSED instance, cadence @daily
    fireEvent.click(screen.getByRole("button", { name: /enable drive/i }));
    await waitFor(() => expect(props.onSetState).toHaveBeenCalledWith("drive@ws_a", "enabled"));
    // The per-row cadence input is seeded from the instance's OWN cadence, not the register form.
    const rowInput = screen.getByRole("textbox", { name: /cadence for drive/i }) as HTMLInputElement;
    expect(rowInput.value).toBe("@daily");
    fireEvent.change(rowInput, { target: { value: "@hourly" } });
    fireEvent.click(screen.getByRole("button", { name: /set cadence for drive/i }));
    await waitFor(() => expect(props.onSetCadence).toHaveBeenCalledWith("drive@ws_a", "@hourly"));
  });

  it("a NON-onboarded scope (null workspaceId) disables the surface — no register form (WS-8)", () => {
    renderConnectors({ workspaceId: null });
    expect(screen.getByText(/select an onboarded workspace/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /register connector/i })).toBeNull();
  });

  it("a register failure surfaces a SAFE error state (role=alert), never a raw cause", async () => {
    renderConnectors({ onRegister: vi.fn().mockResolvedValue({ ok: false }) });
    fireEvent.change(screen.getByRole("textbox", { name: /token reference/i }), { target: { value: "keychain://x" } });
    fireEvent.click(screen.getByRole("button", { name: /register connector/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't register the connector/i);
  });

  it("renders a registered instance's config-visible fields only — never a tokenRef", () => {
    renderConnectors({ instances: [OK({ state: "enabled", cadence: "@hourly" }).instance] });
    expect(screen.getByText("@hourly")).toBeTruthy();
    // Nothing token-shaped is rendered (the view carries no tokenRef).
    expect(screen.queryByText(/keychain:/i)).toBeNull();
  });

  it("styling structure: page-chrome main + primary register button (aria-busy) + a variant row action", () => {
    renderConnectors({ instances: [OK().instance] }); // one PAUSED instance
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const reg = screen.getByRole("button", { name: /register connector/i });
    expect(reg.className).toMatch(/sow-btn--primary/);
    expect(reg.getAttribute("aria-busy")).toBe("false"); // the loading affordance hook (not busy at rest)
    expect(screen.getByRole("button", { name: /enable drive/i }).className).toMatch(/sow-btn--/); // styled row action
  });
});
