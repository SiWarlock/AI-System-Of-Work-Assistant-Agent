// Non-secret app-config contract test (plan task 10.7, contract portion; REQ-S-003).
// RED-first. Pins the config SHAPE (appConfigSchema/AppConfig) + the load-time
// secretShapeGuard that REJECTS secret-shaped values before any config crosses
// into the app: (i) secret-bearing KEY names, (ii) credential-shaped string
// VALUES, then (iii) structural validation. NOT an Appendix-A seam model — no
// schema snapshot / registry ceremony. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  appConfigSchema,
  secretShapeGuard,
} from "../../src/config/config-schema";
import type { AppConfig, ConfigLoadError } from "../../src/config/config-schema";
import { isOk, isErr } from "../../src/primitives/result";

// A clean, representative NON-secret config (every field populated).
const cleanConfig = {
  operationalDbPath: "/Users/x/.sow/operational.db",
  apiPort: 8787,
  temporalAddress: "127.0.0.1:7233",
  vaultRootPaths: {
    "employer-work": "/Users/x/Vaults/employer-work",
    "personal-business": "/Users/x/Vaults/personal-business",
  },
  supervision: {
    baseBackoffMs: 1000,
    maxBackoffMs: 60000,
    crashLoopThreshold: 5,
    crashLoopWindowMs: 300000,
  },
  backupCadenceMs: 3600000,
} as const;

// A minimal clean config (only the one required field).
const minimalConfig = { operationalDbPath: "/Users/x/.sow/operational.db" } as const;

describe("appConfigSchema — non-secret config shape (task 10.7)", () => {
  it("parses a clean full non-secret config", () => {
    expect(appConfigSchema.safeParse(cleanConfig).success).toBe(true);
  });

  it("parses a minimal config (only operationalDbPath)", () => {
    expect(appConfigSchema.safeParse(minimalConfig).success).toBe(true);
  });

  it("rejects a missing operationalDbPath (required)", () => {
    const { operationalDbPath: _omit, ...noPath } = cleanConfig;
    expect(appConfigSchema.safeParse(noPath).success).toBe(false);
  });

  it("rejects an unknown top-level key (.strict — no smuggled fields)", () => {
    expect(
      appConfigSchema.safeParse({ ...minimalConfig, extra: "nope" }).success,
    ).toBe(false);
  });

  it("rejects a partial supervision block (all four fields required together)", () => {
    expect(
      appConfigSchema.safeParse({
        ...minimalConfig,
        supervision: { baseBackoffMs: 1000 },
      }).success,
    ).toBe(false);
  });
});

describe("secretShapeGuard — clean config → ok(config)", () => {
  it("returns ok with the parsed AppConfig for a clean full config", () => {
    const r = secretShapeGuard(cleanConfig);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const cfg: AppConfig = r.value;
      expect(cfg.operationalDbPath).toBe(cleanConfig.operationalDbPath);
      expect(cfg.apiPort).toBe(8787);
      expect(cfg.supervision?.crashLoopThreshold).toBe(5);
    }
  });

  it("returns ok for a minimal clean config", () => {
    const r = secretShapeGuard(minimalConfig);
    expect(isOk(r)).toBe(true);
  });
});

describe("secretShapeGuard — secret-bearing KEY names → err secret_in_config", () => {
  it("rejects a key named 'apiToken' with offendingKey", () => {
    const r = secretShapeGuard({ ...minimalConfig, apiToken: "whatever" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const e: ConfigLoadError = r.error;
      expect(e.kind).toBe("secret_in_config");
      expect(e.offendingKey).toBe("apiToken");
    }
  });

  it("rejects a key named 'dbPassword' with offendingKey", () => {
    const r = secretShapeGuard({ ...minimalConfig, dbPassword: "hunter2" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("secret_in_config");
      expect(r.error.offendingKey).toBe("dbPassword");
    }
  });

  it("rejects assorted secret-bearing key shapes (api_key, bearer, credential, private-key, passphrase, secret)", () => {
    for (const key of [
      "api_key",
      "API_KEY",
      "bearerToken",
      "githubCredential",
      "private_key",
      "vaultPassphrase",
      "clientSecret",
      "passwd",
    ]) {
      const r = secretShapeGuard({ ...minimalConfig, [key]: "x" });
      expect(isErr(r), `key ${key} should be rejected`).toBe(true);
      if (isErr(r)) {
        expect(r.error.kind).toBe("secret_in_config");
        expect(r.error.offendingKey).toBe(key);
      }
    }
  });
});

describe("secretShapeGuard — credential-shaped string VALUES → err secret_in_config", () => {
  it("rejects a value shaped like an OpenAI live secret ('sk-live-abc123...')", () => {
    const r = secretShapeGuard({
      ...minimalConfig,
      temporalAddress: "sk-live-abc123DEFghi456jkl",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("secret_in_config");
      expect(r.error.offendingKey).toBe("temporalAddress");
    }
  });

  it("rejects assorted credential-shaped values (sk-, sk_live, xoxb-, ghp_, AKIA, PEM, JWT)", () => {
    const shaped: ReadonlyArray<readonly [string, string]> = [
      ["temporalAddress", "sk-ABCDEFGHIJKLMNOP"],
      ["temporalAddress", "sk_live_ABCDEFGHIJ"],
      ["temporalAddress", "xoxb-1234-5678-abcd"],
      ["temporalAddress", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
      ["temporalAddress", "AKIAABCDEFGHIJKLMNOP"],
      ["temporalAddress", "-----BEGIN PRIVATE KEY-----"],
      ["temporalAddress", "eyJhbGciOiJIUzI1NiIsInR5cCI6.payload"],
    ];
    for (const [key, value] of shaped) {
      const r = secretShapeGuard({ ...minimalConfig, [key]: value });
      expect(isErr(r), `value ${value} should be rejected`).toBe(true);
      if (isErr(r)) {
        expect(r.error.kind).toBe("secret_in_config");
      }
    }
  });

  it("finds a credential-shaped value nested inside vaultRootPaths", () => {
    const r = secretShapeGuard({
      ...minimalConfig,
      vaultRootPaths: { primary: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("secret_in_config");
  });

  it("does NOT flag a benign path value that merely contains 'sk' as a substring", () => {
    const r = secretShapeGuard({
      ...minimalConfig,
      temporalAddress: "desktop:7233",
    });
    expect(isOk(r)).toBe(true);
  });
});

describe("secretShapeGuard — structurally-invalid config → err invalid_config", () => {
  it("rejects a config missing operationalDbPath (structurally invalid)", () => {
    const r = secretShapeGuard({ apiPort: 8787 });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_config");
  });

  it("rejects a wrong-typed apiPort (structurally invalid, not secret)", () => {
    const r = secretShapeGuard({
      operationalDbPath: "/db",
      apiPort: "not-a-number",
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_config");
  });

  it("rejects an unknown top-level key as invalid_config (not secret-shaped)", () => {
    const r = secretShapeGuard({ operationalDbPath: "/db", unexpected: "x" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_config");
  });

  it("secret_in_config takes precedence over structural invalidity", () => {
    // Both a secret-bearing key AND a structural problem (missing required
    // operationalDbPath) — the secret check fires first (fail-closed on secrets).
    const r = secretShapeGuard({ apiToken: "x" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("secret_in_config");
      expect(r.error.offendingKey).toBe("apiToken");
    }
  });
});
