// @vitest-environment jsdom
//
// Owner report 2026-09-21: "what do I put for cadence? It defaults to @daily but it's an open form,
// not a selection." A free-text box with a magic token and no guidance invites a guess. It is now a
// short list of named choices, defaulting to daily, with a note on what it is for.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Connectors, type ConnectorsProps } from "../renderer/surfaces/connectors";

afterEach(cleanup);

function setup(): ConnectorsProps {
  const props: ConnectorsProps = {
    workspaceId: "employer-work",
    instances: [],
    onRegister: vi.fn().mockResolvedValue({ ok: true, instance: { instanceId: "x", connectorId: "drive", workspaceId: "employer-work", state: "paused", cadence: "@daily" } }),
    onSetState: vi.fn().mockResolvedValue({ ok: true }),
    onSetCadence: vi.fn().mockResolvedValue({ ok: true }),
    onProvisionCredential: vi.fn().mockResolvedValue({ ok: true }),
  };
  render(<Connectors {...props} />);
  return props;
}

describe("Connectors — cadence is a choice, not a blank box", () => {
  it("is a select with named options, defaulting to daily", () => {
    setup();
    const cadence = screen.getByLabelText("Cadence") as HTMLSelectElement;
    expect(cadence.tagName).toBe("SELECT");
    expect(cadence.value).toBe("@daily");
    expect([...cadence.options].map((o) => o.value)).toEqual(["@hourly", "@daily", "@weekly"]);
  });

  it("registers with the chosen cadence", async () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "@weekly" } });
    fireEvent.change(screen.getByLabelText("Token reference"), { target: { value: "keychain://my/item" } });
    fireEvent.click(screen.getByRole("button", { name: /register connector/i }));
    await waitFor(() => expect(props.onRegister).toHaveBeenCalledTimes(1));
    const input = (props.onRegister as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { cadence: string };
    expect(input.cadence).toBe("@weekly");
  });

  it("says what cadence is for, so nobody has to guess", () => {
    setup();
    expect(document.body.textContent).toMatch(/how often .* pull/i);
  });
});
