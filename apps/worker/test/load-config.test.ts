// 10.7 — config loader: secrets-out-of-config guard (REQ-S-003, safety rule 7).
//
// Ungated Vitest: pure, no I/O. `loadConfig` runs the FROZEN @sow/contracts
// `secretShapeGuard` at load — it REJECTS any secret-shaped key/value that leaked
// into .env/config (secrets are Keychain-only) with a typed error, else parses via
// `appConfigSchema`, returning Result<AppConfig, ConfigLoadError>. Never throws
// across the boundary (§16).

import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { loadConfig } from "../src/config/load-config";

const CLEAN: Record<string, unknown> = {
  operationalDbPath: "/Users/me/Library/Application Support/sow/op.db",
  apiPort: 8721,
  temporalAddress: "127.0.0.1:7233",
};

describe("loadConfig — secrets-out-of-config guard (REQ-S-003)", () => {
  it("rejects a secret-BEARING KEY NAME with a typed secret_in_config error", () => {
    const r = loadConfig({ ...CLEAN, apiKey: "whatever" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("secret_in_config");
      expect(r.error.offendingKey).toBe("apiKey");
      expect(r.error.message).toMatch(/Keychain-only/i);
    }
  });

  it("rejects a credential-SHAPED VALUE (Keychain-only) even under a benign key", () => {
    const r = loadConfig({ ...CLEAN, note: "sk-ABCDEFGHIJKLMNOP" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("secret_in_config");
      expect(r.error.offendingKey).toBe("note");
    }
  });

  it("secret screen takes precedence over structural invalidity (fail-closed)", () => {
    // Missing required operationalDbPath AND carries a secret key: secret wins.
    const r = loadConfig({ password: "hunter2" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("secret_in_config");
  });

  it("rejects a structurally-invalid (but secret-free) config as invalid_config", () => {
    const r = loadConfig({ apiPort: 8721 }); // missing operationalDbPath
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_config");
  });

  it("accepts a clean config → ok(AppConfig)", () => {
    const r = loadConfig(CLEAN);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.operationalDbPath).toBe(CLEAN.operationalDbPath);
      expect(r.value.apiPort).toBe(8721);
    }
  });

  it("does not throw on a non-record / hostile input — returns a typed error", () => {
    // A caller may hand raw parsed JSON that isn't an object; loadConfig must fold
    // it to a typed invalid_config, never throw across the boundary (§16).
    const r = loadConfig(null as unknown as Record<string, unknown>);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_config");
  });
});
