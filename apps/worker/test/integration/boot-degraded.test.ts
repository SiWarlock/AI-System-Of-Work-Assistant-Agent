// @sow/worker — bootWorker WITHOUT proofSpineParams boots the control-plane API in
// Temporal-DEGRADED mode: the desktop FIRST-RENDER path (9.4b). The proof-spine
// params are the job identity the Temporal register hook binds the activities under
// — required ONLY to register workflows on a successful connect. A first render has
// no pipeline yet, so it boots the API + backends and lets connectTemporal degrade
// cleanly (never a real Temporal contact, never a throw). SOW_API-gated: bootWorker
// binds a real loopback port via startApiServer.
import { describe, it, expect } from "vitest";
import { mintSessionToken } from "@sow/policy";
import { SOW_API } from "../support/apiGate";
import { bootWorker, reportInitialConnect, type BootedWorker } from "../../src/boot";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";
import type { TriageDispatchFn } from "../../src/api/adapters/commands";
import type { DispatchApprovalFn } from "../../src/api/procedures/commands";

function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}
const TOKEN = mintSessionToken(fixedRng(0xc3));
const ALLOWLIST: WorkerOriginAllowlist = { origins: ["app://sow"], hosts: ["127.0.0.1:47100"] };

/** No-op dispatch stubs — a first render triggers neither path (no jobs/approvals yet). */
const noopTriage: TriageDispatchFn = (input) =>
  Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } });
const noopApprovalDispatch: DispatchApprovalFn = () => Promise.resolve({ ok: true, value: undefined });

describe.skipIf(!SOW_API)("bootWorker — desktop first-render (no proofSpineParams → Temporal-degraded)", () => {
  it("boots the API + backends WITHOUT proofSpineParams and degrades connectTemporal cleanly", async () => {
    let booted: BootedWorker | undefined;
    try {
      booted = await bootWorker({
        sessionToken: TOKEN,
        allowlist: ALLOWLIST,
        triageDispatch: noopTriage,
        dispatchApproval: noopApprovalDispatch,
        apiPort: 0, // ephemeral — this test never routes through the allowlist
        // dbPath omitted → :memory:; vaultRoot omitted → tmpdir; NO proofSpineParams.
      });

      // The control-plane API is live on a real loopback port.
      expect(booted.api.port).toBeGreaterThan(0);
      expect(booted.logger).toBeDefined();

      // connectTemporal degrades (no proof-spine identity to register) WITHOUT a real
      // Temporal contact and WITHOUT throwing (§16) — a typed degraded Result.
      const r = await booted.connectTemporal();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("temporal_unavailable");
        expect(r.error.dispatchEnabled).toBe(false);
        expect(r.error.degraded).toBe(true);
        expect(r.error.message).toContain("proof-spine params not configured");
      }
    } finally {
      await booted?.close();
    }
  });

  it("reportInitialConnect records a worker_down item that surfaces in the systemHealth read path", async () => {
    let booted: BootedWorker | undefined;
    try {
      booted = await bootWorker({
        sessionToken: TOKEN,
        allowlist: ALLOWLIST,
        triageDispatch: noopTriage,
        dispatchApproval: noopApprovalDispatch,
        apiPort: 0,
        // dbPath omitted → :memory:; vaultRoot omitted → tmpdir; NO proofSpineParams.
      });

      // The desktop worker-host drives this after boot, before announcing readiness.
      const out = await reportInitialConnect(booted, {
        now: booted.backends.now(),
        logger: booted.backends.logger,
      });
      expect(out.degraded).toBe(true);

      // The systemHealth query reads backends.healthItems.list() — the SAME store the
      // degraded controller's surface now persists to. A worker_down open item is THERE
      // (not process-memory), so the renderer's "System health" shows "Worker down".
      const items = await booted.backends.healthItems.list();
      const workerDown = items.filter((h) => h.failureClass === "worker_down");
      expect(workerDown).toHaveLength(1);
      expect(workerDown[0]?.state).toBe("open");
    } finally {
      await booted?.close();
    }
  });
});
