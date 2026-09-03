// @vitest-environment jsdom
//
// One-way credential entry in the Connectors surface (owner-authorized 2026-09-03, after being shown
// that it costs a preload security guard and the first Keychain write capability in the repo).
//
// These pins are mostly about DIRECTIONALITY and ORDERING, because those are the two properties the
// whole design rests on and neither is visible in a screenshot:
//   • the pasted key goes to the Keychain and NOWHERE else, and is gone from the DOM afterwards;
//   • a FAILED store must not register the connector — otherwise the user is left with an instance
//     that looks configured and cannot authenticate, which is worse than a visible failure.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Connectors, type ConnectorsProps } from "../renderer/surfaces/connectors";

afterEach(cleanup);

const KEY = "lin_api_SUPERSECRET_0987654321";
const WS = "personal-business";

function setup(over: Partial<ConnectorsProps> = {}): ConnectorsProps {
  const props: ConnectorsProps = {
    workspaceId: WS,
    instances: [],
    onRegister: vi.fn().mockResolvedValue({ ok: true, instance: { instanceId: "x", connectorId: "drive", workspaceId: WS, state: "paused", cadence: "@daily" } }),
    onSetState: vi.fn().mockResolvedValue({ ok: true }),
    onSetCadence: vi.fn().mockResolvedValue({ ok: true }),
    onProvisionCredential: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  render(<Connectors {...props} />);
  return props;
}

const pasteKey = (v: string): void => {
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: v } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole("button", { name: /register connector/i }));
};

describe("credential entry — the key reaches the Keychain and nothing else", () => {
  it("provisions at the workspace-scoped ref, then registers the connector AGAINST THAT SAME REF", async () => {
    const props = setup();
    pasteKey(KEY);
    submit();
    await waitFor(() => expect(props.onProvisionCredential).toHaveBeenCalledTimes(1));
    // The default selected connector is the first in the catalog ("drive").
    expect(props.onProvisionCredential).toHaveBeenCalledWith(`keychain://connector-write.${WS}/drive`, KEY);
    await waitFor(() => expect(props.onRegister).toHaveBeenCalledTimes(1));
    // ⛔ The registered tokenRef must be the ref we just STORED AT. If these ever diverge the key is
    // written where nothing reads it and the UI still reports success.
    const registered = (props.onRegister as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { tokenRef: string };
    expect(registered.tokenRef).toBe(`keychain://connector-write.${WS}/drive`);
  });

  it("⛔ a FAILED store does NOT register — no instance that looks configured but cannot authenticate", async () => {
    // The ordering pin. Registering first (or regardless) would leave a connector pointing at a ref
    // holding nothing, and nothing in the UI would ever say so.
    const props = setup({ onProvisionCredential: vi.fn().mockResolvedValue({ ok: false }) });
    pasteKey(KEY);
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(props.onRegister).not.toHaveBeenCalled();
    // Positive control: the SAME flow with a succeeding store DOES register, so "not called" above
    // measures the abort and not a form that never submitted (`contracts L90`).
    cleanup();
    const good = setup();
    pasteKey(KEY);
    submit();
    await waitFor(() => expect(good.onRegister).toHaveBeenCalledTimes(1));
  });

  it("⛔ RULE 7 — the key is CLEARED after submit and appears nowhere in the DOM, on success OR failure", async () => {
    for (const storeResult of [{ ok: true }, { ok: false }]) {
      const props = setup({ onProvisionCredential: vi.fn().mockResolvedValue(storeResult) });
      pasteKey(KEY);
      submit();
      await waitFor(() =>
        expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""),
      );
      expect(document.body.innerHTML).not.toContain(KEY);
      expect(document.body.innerHTML).not.toContain("SUPERSECRET");
      // Positive control: the key WAS delivered to the provisioning seam, so the absences above are
      // the surface clearing it rather than the test never entering it.
      expect(JSON.stringify((props.onProvisionCredential as ReturnType<typeof vi.fn>).mock.calls)).toContain(KEY);
      cleanup();
    }
  });

  it("the key field is type=password and out of autofill — not shoulder-readable, not remembered", () => {
    setup();
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("shows the user WHERE the key will be stored — the destination is never a mystery", () => {
    setup();
    pasteKey(KEY);
    // Findable afterwards in Keychain Access, which matters precisely because the app will never
    // show it again.
    expect(document.body.textContent).toContain(`keychain://connector-write.${WS}/drive`);
  });

  it("without a pasted key the manual-reference path still works unchanged (no store call)", async () => {
    // The pre-existing flow must not regress: naming an already-provisioned ref registers directly
    // and must not invoke the Keychain write at all.
    const props = setup();
    fireEvent.change(screen.getByLabelText("Token reference"), {
      target: { value: "keychain://my-own/item" },
    });
    submit();
    await waitFor(() => expect(props.onRegister).toHaveBeenCalledTimes(1));
    expect(props.onProvisionCredential).not.toHaveBeenCalled();
  });
});
