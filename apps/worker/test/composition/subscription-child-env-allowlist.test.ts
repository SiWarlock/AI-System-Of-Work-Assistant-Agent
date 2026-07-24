// 18.40 — the subscription spawn-env minimal-allowlist builder (rule-5 completeness-by-construction).
//
// The Agent SDK `query()` `env` option REPLACES the child env ENTIRELY (sdk.d.ts:1391-1409). On the armed path
// the worker spawns claude with a MINIMAL ALLOWLIST (PATH/HOME + OS operational vars, NO credential/shadow var)
// so no shadow var — known, unknown, or `CLAUDE_ENV_FILE`-injected — can reach the child. This SUPERSEDES the
// 18.38 denylist's completeness role (which stays as a defense-in-depth pre-run degrade). Pure + total.
import { describe, it, expect } from "vitest";
import {
  buildSubscriptionChildEnvAllowlist,
  resolveSubscriptionSpawnChildEnv,
  SUBSCRIPTION_CHILD_ENV_ALLOWLIST,
} from "../../src/composition/subscription-child-env-allowlist";

describe("buildSubscriptionChildEnvAllowlist — the minimal spawn-env allowlist (18.40, rule-5 completeness)", () => {
  it("allowlist_contains_only_operational_keys — result ⊆ allowlist; every shadow var ABSENT [spec(§19.5)]", () => {
    // spec(§19.5/§5) — completeness-by-construction: a shadow the PARENT has can never reach the child.
    const source = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/op",
      ANTHROPIC_API_KEY: "sk-should-never-cross",
      ANTHROPIC_BASE_URL: "https://evil.example",
      CLAUDE_ENV_FILE: "/tmp/inject.env",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok-x",
    };
    const out = buildSubscriptionChildEnvAllowlist(source);
    // Every output key is in the allowlist (nothing else leaked in).
    for (const k of Object.keys(out)) {
      expect(SUBSCRIPTION_CHILD_ENV_ALLOWLIST as readonly string[], `${k} must be allowlisted`).toContain(k);
    }
    // Every shadow var is absent — the child cannot see it even though the parent set it.
    for (const shadow of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_ENV_FILE",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(out, `${shadow} must NOT reach the child`).not.toHaveProperty(shadow);
      expect(Object.values(out)).not.toContain("sk-should-never-cross");
    }
  });

  it("allowlist_preserves_load_bearing_values — PATH/HOME present ⇒ present with IDENTICAL values [spec(§19.5)]", () => {
    // Under-allowlisting breaks the spawn (PATH) / the ambient ~/.claude login discovery (HOME) — these are load-bearing.
    const out = buildSubscriptionChildEnvAllowlist({ PATH: "/p:/q", HOME: "/Users/op", TMPDIR: "/tmp/x" });
    expect(out.PATH).toBe("/p:/q");
    expect(out.HOME).toBe("/Users/op");
    expect(out.TMPDIR).toBe("/tmp/x");
  });

  it("allowlist_excludes_unknown_future_shadow — a made-up future ANTHROPIC_/CLAUDE_ var ⇒ ABSENT [spec(§19.5)]", () => {
    // Drift-immunity — the whole point vs the denylist: an unknown var never reaches the child (positive allowlist).
    const out = buildSubscriptionChildEnvAllowlist({
      PATH: "/usr/bin",
      ANTHROPIC_FUTURE_V99_KEY: "nope",
      CLAUDE_SOMETHING_NEW: "nope",
      AWS_BEARER_TOKEN_XYZ: "nope",
    });
    expect(out).not.toHaveProperty("ANTHROPIC_FUTURE_V99_KEY");
    expect(out).not.toHaveProperty("CLAUDE_SOMETHING_NEW");
    expect(out).not.toHaveProperty("AWS_BEARER_TOKEN_XYZ");
    expect(Object.keys(out)).toEqual(["PATH"]);
  });

  it("absent_allowlisted_key_is_omitted_not_empty — a missing allowlisted key ⇒ absent from result (never undefined/empty) [spec(§16)]", () => {
    // Total + clean: an undefined source value is DROPPED (not carried as undefined) so options.env stays well-formed.
    const out = buildSubscriptionChildEnvAllowlist({ PATH: "/usr/bin", HOME: undefined });
    expect(out).toHaveProperty("PATH");
    expect(out).not.toHaveProperty("HOME");
    // A totally empty source ⇒ empty object (never throws).
    expect(buildSubscriptionChildEnvAllowlist({})).toEqual({});
  });
});

describe("resolveSubscriptionSpawnChildEnv — the single armed-spawn chokepoint (18.40, both spawn sites)", () => {
  const src = { PATH: "/usr/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "sk-x", CLAUDE_ENV_FILE: "/tmp/x.env" };

  it("neither_enabled_returns_undefined — byte-equivalent default (the spawn omits env ⇒ inherits) [spec(L23)]", () => {
    expect(resolveSubscriptionSpawnChildEnv({}, src)).toBeUndefined();
    expect(
      resolveSubscriptionSpawnChildEnv({ subscriptionArmEnabled: false, copilotRealModel: false }, src),
    ).toBeUndefined();
  });

  it("extraction_arm_enabled_scrubs — subscriptionArmEnabled ⇒ minimal allowlist, shadows ABSENT [spec(§19.5)]", () => {
    const out = resolveSubscriptionSpawnChildEnv({ subscriptionArmEnabled: true }, src);
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/Users/op" });
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(out).not.toHaveProperty("CLAUDE_ENV_FILE");
  });

  it("copilot_real_model_scrubs — the 2nd (Copilot §13.10) spawn site is covered by the SAME chokepoint (no split-brain, L52/L71) [spec(§19.5)]", () => {
    const out = resolveSubscriptionSpawnChildEnv({ copilotRealModel: true }, src);
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/Users/op" });
  });

  it("truthy_not_true_never_scrubs — STRICT ===true on BOTH gates; a truthy-not-true value ⇒ undefined [spec(L28)]", () => {
    expect(
      resolveSubscriptionSpawnChildEnv({ subscriptionArmEnabled: "true" as unknown as boolean }, src),
    ).toBeUndefined();
    expect(resolveSubscriptionSpawnChildEnv({ copilotRealModel: 1 as unknown as boolean }, src)).toBeUndefined();
  });
});
