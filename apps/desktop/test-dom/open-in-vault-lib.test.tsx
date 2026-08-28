// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { requestVaultOpen, requestVaultReveal } from "../renderer/lib/open-in-vault";

// 9.12r — the renderer glue that calls the typed preload bridge (`window.sow.vault.open/reveal`) with a
// CLOSED target. Fail-closed like every renderer command-caller (desktop L6): fold any typed-err /
// transport-throw / absent-bridge to a silent no-op — the renderer surfaces nothing, opens nothing.

afterEach(() => {
  delete (window as unknown as { sow?: unknown }).sow;
  vi.restoreAllMocks();
});

describe("renderer vault bridge glue — open/reveal by target, fail-closed", () => {
  it("requestVaultOpen invokes window.sow.vault.open with the target", async () => {
    const open = vi.fn(async () => ({ ok: true }));
    (window as unknown as { sow: unknown }).sow = { vault: { open, reveal: vi.fn(async () => ({ ok: true })) } };
    await requestVaultOpen("workspace");
    expect(open).toHaveBeenCalledWith("workspace");
  });

  it("requestVaultReveal invokes window.sow.vault.reveal with the target", async () => {
    const reveal = vi.fn(async () => ({ ok: true }));
    (window as unknown as { sow: unknown }).sow = { vault: { open: vi.fn(async () => ({ ok: true })), reveal } };
    await requestVaultReveal("global");
    expect(reveal).toHaveBeenCalledWith("global");
  });

  it("swallows a thrown bridge error (fail-closed — surfaces nothing)", async () => {
    (window as unknown as { sow: unknown }).sow = {
      vault: {
        open: async () => {
          throw new Error("bridge boom");
        },
        reveal: vi.fn(async () => ({ ok: true })),
      },
    };
    await expect(requestVaultOpen("workspace")).resolves.toBeUndefined();
  });

  it("no-ops when the bridge is absent (worker-down / pre-inject boot)", async () => {
    delete (window as unknown as { sow?: unknown }).sow;
    await expect(requestVaultReveal("global")).resolves.toBeUndefined();
  });
});
