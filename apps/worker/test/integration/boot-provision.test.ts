// @sow/worker — bootWorker's DEV data-unlock (D1): when `devProvision` specs are supplied,
// boot turns local vault Markdown into REAL read-model rows so the wired-but-empty surfaces
// serve genuine content through the SAME @sow/db read path the live query router uses. This
// is the reachability proof for provisionDevWorkspace (its logic is unit-tested in
// test/provision-dev.test.ts). SOW_API-gated: bootWorker binds a real loopback port.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionToken } from "@sow/policy";
import { SOW_API } from "../support/apiGate";
import { bootWorker, type BootedWorker } from "../../src/boot";
import { createDbReadModelQueryPort } from "../../src/api/adapters/readModel";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";
import type { TriageDispatchFn } from "../../src/api/adapters/commands";
import type { DispatchApprovalFn } from "../../src/api/procedures/commands";

function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}
const TOKEN = mintSessionToken(fixedRng(0xd4));
const ALLOWLIST: WorkerOriginAllowlist = { origins: ["app://sow"], hosts: ["127.0.0.1:47100"] };
const noopTriage: TriageDispatchFn = (input) =>
  Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } });
const noopApprovalDispatch: DispatchApprovalFn = () => Promise.resolve({ ok: true, value: undefined });

// 2 completed / 5 total → computePercent(2,5) === 40.
const NOTE_40 = "# Alpha\n\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [ ] e\n";

describe.skipIf(!SOW_API)("bootWorker — DEV data-unlock (devProvision surfaces real read-model data)", () => {
  it("turns a vault note into a real card the live query port serves; an unprovisioned scope stays fail-closed", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "sow-provtest-"));
    writeFileSync(join(vaultRoot, "alpha.md"), NOTE_40, "utf8");
    let booted: BootedWorker | undefined;
    try {
      booted = await bootWorker({
        sessionToken: TOKEN,
        allowlist: ALLOWLIST,
        triageDispatch: noopTriage,
        dispatchApproval: noopApprovalDispatch,
        apiPort: 0,
        vaultRoot,
        devProvision: [{ workspaceId: "employer-work", notePath: "alpha.md", projectTitle: "Alpha" }],
      });

      const port = createDbReadModelQueryPort({
        readModels: booted.backends.repos.readModels,
        approvals: booted.backends.repos.approvals,
      });

      const cards = await port.workspaceCards("employer-work");
      expect(cards.ok).toBe(true);
      if (cards.ok) {
        expect(cards.value).toHaveLength(1);
        expect(cards.value[0]?.count).toBe(40); // deterministic percent from real checkboxes
        expect(cards.value[0]?.title).toBe("Alpha");
      }

      // The GLOBAL Today dashboard stays empty — D1 writes only workspace-scoped rows; the
      // cross-workspace surface is the gated GCL path (data-unlock D2), not this ungated row.
      const dash = await port.dashboardCards();
      expect(dash.ok).toBe(true);
      if (dash.ok) expect(dash.value).toHaveLength(0);

      // An unprovisioned workspace is absent from the registry → fail-closed (WS-8).
      const other = await port.workspaceCards("personal-life");
      expect(other.ok).toBe(false);
    } finally {
      await booted?.close();
    }
  });
});
