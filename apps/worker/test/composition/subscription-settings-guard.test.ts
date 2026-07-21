// 18.36 — the settings-level key-injection guard: extend the armed-subscription no-surprise-spend defense to
// the ONE shadow the 18.28 process.env guard structurally cannot see — a Claude-Code settings.json key
// injection (apiKeyHelper / settings-`env` / Bedrock cred scripts). The Agent SDK `query()` honors the
// settings hierarchy, so an injected raw key there makes a "subscription" run silently metered-spend.
//
// The guard is PURE — the settings-hierarchy reader is INJECTED as a fake here (NO real fs / os.homedir).
// PRESENCE only (rule 7 — never the value / command string); armed-path-only (byte-equivalent default);
// fail-safe DEGRADE on an unreadable source; over-inclusion is fail-safe (an EXPLICIT EXTENSIBLE set).
import { describe, it, expect, vi } from "vitest";
import {
  assertNoSettingsKeyInjection,
  guardSettingsOnArmedPath,
  SETTINGS_INJECTION_FIELDS,
  type SettingsSourceRead,
  type SettingsHierarchyReader,
} from "../../src/composition/subscription-settings-guard";
import { SUBSCRIPTION_SHADOWING_ENV_KEYS } from "../../src/composition/subscription-auth-guard";

/** Build an injected reader that returns exactly the given sources (order = precedence, highest first). */
function reader(...sources: readonly SettingsSourceRead[]): SettingsHierarchyReader {
  return () => sources;
}
/** A parsed settings source at the `user` tier carrying `settings`. */
function parsed(settings: Record<string, unknown>, marker: SettingsSourceRead["marker"] = "user"): SettingsSourceRead {
  return { marker, outcome: { kind: "parsed", settings } };
}

describe("assertNoSettingsKeyInjection — the settings-level key-injection guard (18.36)", () => {
  it("apikeyhelper_present_faults: a settings apiKeyHelper ⇒ typed fault; the command is never executed/surfaced", () => {
    // spec(§19.5) ⛔ LOAD-BEARING — a settings apiKeyHelper injects a raw key ⇒ subscription run spends; the env guard can't see it.
    const fault = assertNoSettingsKeyInjection(reader(parsed({ apiKeyHelper: "/usr/local/bin/mint-key.sh" })));
    expect(fault).toBeDefined();
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
    expect(JSON.stringify(fault)).not.toContain("mint-key"); // rule 7 — the command string is never in the fault
  });

  it("settings_env_anthropic_key_faults: a settings env.ANTHROPIC_API_KEY / env.ANTHROPIC_AUTH_TOKEN ⇒ fault; value never read", () => {
    // spec(§19.5/§7) — a settings-injected env shadows the subscription (first-match-wins) invisibly to a process.env scan.
    const k = assertNoSettingsKeyInjection(reader(parsed({ env: { ANTHROPIC_API_KEY: "sk-canary-stale" } })));
    expect(k?.code).toBe("settings_key_injection_on_armed_path");
    expect(JSON.stringify(k)).not.toContain("sk-canary");
    const t = assertNoSettingsKeyInjection(reader(parsed({ env: { ANTHROPIC_AUTH_TOKEN: "tok-canary" } })));
    expect(t?.code).toBe("settings_key_injection_on_armed_path");
    expect(JSON.stringify(t)).not.toContain("tok-canary");
  });

  it("clean_settings_pass: a benign settings object (incl. a pinned model) with no injecting field ⇒ no fault", () => {
    // Non-vacuity — the guard discriminates, doesn't deny-all; a common `model`/`permissions` config is NOT flagged.
    const fault = assertNoSettingsKeyInjection(
      reader(parsed({ model: "claude-sonnet-5", permissions: { allow: ["Read"] }, env: { EDITOR: "vim" } })),
    );
    expect(fault).toBeUndefined();
  });

  it("absent_settings_is_clean: every source absent ⇒ clean (the common default machine)", () => {
    // absent ≠ injected — don't degrade a normal machine.
    const fault = assertNoSettingsKeyInjection(
      reader({ marker: "managed", outcome: { kind: "absent" } }, { marker: "user", outcome: { kind: "absent" } }),
    );
    expect(fault).toBeUndefined();
  });

  it("unreadable_settings_degrades_failsafe: a source that exists but is unreadable/malformed ⇒ DEGRADE, never throws", () => {
    // L65 fail-safe — can't confirm clean ⇒ deny on the owner-gated armed path.
    const fault = assertNoSettingsKeyInjection(reader({ marker: "project", outcome: { kind: "unreadable" } }));
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
    expect(fault?.marker).toBe("project");
  });

  it("reader_throw_degrades_failsafe: the injected reader itself throwing ⇒ DEGRADE (fault), never propagates", () => {
    // §16/L65 — total: a reader fault folds to a degrade, never an unhandled throw at boot.
    const throwingReader: SettingsHierarchyReader = () => {
      throw new Error("homedir blew up");
    };
    expect(() => assertNoSettingsKeyInjection(throwingReader)).not.toThrow();
    const fault = assertNoSettingsKeyInjection(throwingReader);
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
    expect(fault?.marker).toBe("hierarchy"); // the reader-fault marker member is pinned (else a catch regression is silent)
  });

  it("non_string_top_level_value_is_failsafe_injecting: a present non-string cred-minting field ⇒ fault (fail-safe)", () => {
    // isInjectingTopLevel — a non-string present value can't be empty-guarded, so it degrades (over-inclusion fail-safe, L65).
    expect(assertNoSettingsKeyInjection(reader(parsed({ apiKeyHelper: 123 as unknown as string })))?.code).toBe(
      "settings_key_injection_on_armed_path",
    );
    expect(assertNoSettingsKeyInjection(reader(parsed({ apiKeyHelper: { cmd: "x" } as unknown as string })))?.code).toBe(
      "settings_key_injection_on_armed_path",
    );
  });

  it("first_fault_wins_highest_precedence_tier: a clean high tier + an injecting low tier ⇒ fault at the injecting tier", () => {
    // Pins the loop's documented precedence order (highest tier first) — a clean managed tier doesn't mask a lower injection.
    const fault = assertNoSettingsKeyInjection(
      reader(
        { marker: "managed", outcome: { kind: "parsed", settings: { model: "claude-x" } } },
        parsed({ apiKeyHelper: "/bin/mint" }, "user"),
      ),
    );
    expect(fault?.marker).toBe("user");
    // A faulting managed tier wins over a lower injecting tier (managed is highest precedence).
    const managedFirst = assertNoSettingsKeyInjection(
      reader({ marker: "managed", outcome: { kind: "unreadable" } }, parsed({ apiKeyHelper: "/bin/mint" }, "user")),
    );
    expect(managedFirst?.marker).toBe("managed");
  });

  it("fault_is_value_free: the fault carries only a fixed code + a file-tier marker — never a key value / command", () => {
    // §16 rule 7 — never surface the credential; the marker is a closed tier name, not content.
    const fault = assertNoSettingsKeyInjection(
      reader(parsed({ apiKeyHelper: "echo SECRET-TOKEN-123", env: { ANTHROPIC_API_KEY: "sk-SECRET-456" } }, "project-local")),
    );
    const json = JSON.stringify(fault);
    expect(json).not.toContain("SECRET-TOKEN-123");
    expect(json).not.toContain("sk-SECRET-456");
    expect(fault?.marker).toBe("project-local"); // a file tier, never content
    expect(Object.keys(fault ?? {}).sort()).toStrictEqual(["code", "marker"]);
  });

  it("each_injecting_field_individually_faults: every top-level field AND every settings-env shadow key alone ⇒ fault", () => {
    // L61/L65 — explicit-extensible sets, no silent miss; per-key truthy-not-absent (L28).
    for (const field of SETTINGS_INJECTION_FIELDS) {
      const fault = assertNoSettingsKeyInjection(reader(parsed({ [field]: "some-injecting-value" })));
      expect(fault?.code, `top-level field ${field} must fault`).toBe("settings_key_injection_on_armed_path");
    }
    for (const key of SUBSCRIPTION_SHADOWING_ENV_KEYS) {
      const fault = assertNoSettingsKeyInjection(reader(parsed({ env: { [key]: "shadow-value" } })));
      expect(fault?.code, `settings env.${key} must fault`).toBe("settings_key_injection_on_armed_path");
    }
  });

  it("settings_gcp_auth_refresh_faults: a settings gcpAuthRefresh cred-script ⇒ fault (the Vertex analog of awsAuthRefresh/awsCredentialExport)", () => {
    // 18.37 — completes the settings cred-script surface: `gcpAuthRefresh` (Vertex) sits beside `awsAuthRefresh` /
    //   `awsCredentialExport` (Bedrock) already in SETTINGS_INJECTION_FIELDS; a settings gcpAuthRefresh script
    //   refreshes GCP creds for the Vertex path — a settings-level credential injection the guard must catch.
    expect(SETTINGS_INJECTION_FIELDS as readonly string[]).toContain("gcpAuthRefresh");
    expect(assertNoSettingsKeyInjection(reader(parsed({ gcpAuthRefresh: "/bin/gcp-refresh.sh" })))?.code).toBe(
      "settings_key_injection_on_armed_path",
    );
  });

  it("empty_field_is_not_injecting: an empty/whitespace apiKeyHelper ⇒ clean (effectively unset, no key minted)", () => {
    // A blank command mints no key — treat as absent (never a false-degrade on a vestigial empty field).
    expect(assertNoSettingsKeyInjection(reader(parsed({ apiKeyHelper: "" })))).toBeUndefined();
    expect(assertNoSettingsKeyInjection(reader(parsed({ apiKeyHelper: "   " })))).toBeUndefined();
  });

  it("settings_env_empty_value_still_faults: a settings env.<shadow-key> present with an EMPTY value STILL degrades (presence-not-value)", () => {
    // Parity with 18.28's assertSubscriptionAuthEnv (presence `!== undefined`): an empty ANTHROPIC_API_KEY still
    // wins its precedence slot and shadows the subscription — DISTINCT from the top-level cred-minting fields
    // (an empty apiKeyHelper mints nothing, above). The env leg checks presence-of-KEY, never truthy-value, so
    // it cannot fail-OPEN on a blank settings-`env` key.
    expect(assertNoSettingsKeyInjection(reader(parsed({ env: { ANTHROPIC_API_KEY: "" } })))?.code).toBe(
      "settings_key_injection_on_armed_path",
    );
    expect(assertNoSettingsKeyInjection(reader(parsed({ env: { ANTHROPIC_AUTH_TOKEN: "   " } })))?.code).toBe(
      "settings_key_injection_on_armed_path",
    );
  });

  it("settings_env_new_18_37_var_degrades_via_single_source: an 18.37-added shadow var in a settings env block ⇒ fault", () => {
    // Single-source (L5/L37) — the 18.37 extension of SUBSCRIPTION_SHADOWING_ENV_KEYS hardens THIS settings-`env`
    // leg too (it reuses the same constant), not just the process.env guard. Proven with load-bearing new vars.
    expect(SUBSCRIPTION_SHADOWING_ENV_KEYS as readonly string[]).toContain("CLAUDE_CODE_USE_MANTLE");
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_FOUNDRY_API_KEY"]) {
      expect(assertNoSettingsKeyInjection(reader(parsed({ env: { [key]: "shadow" } })))?.code, `settings env.${key}`).toBe(
        "settings_key_injection_on_armed_path",
      );
    }
  });

  it("settings_env_new_18_38_var_degrades_via_single_source: an 18.38-added shadow var in a settings env block ⇒ fault", () => {
    // Single-source (L5/L37/L71) — the 18.38 re-ground extension (the GATEWAY/CCR switches, the GCP first-party
    // switch, ANTHROPIC_IDENTITY_TOKEN, and the *_FILE_DESCRIPTOR credential-indirection channels) hardens THIS
    // settings-`env` leg too, not just the process.env guard — proving the constant is the load-bearing single source.
    for (const key of [
      "CLAUDE_CODE_USE_GATEWAY",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "ANTHROPIC_IDENTITY_TOKEN",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    ]) {
      expect(SUBSCRIPTION_SHADOWING_ENV_KEYS as readonly string[], `${key} must be watched`).toContain(key);
      expect(assertNoSettingsKeyInjection(reader(parsed({ env: { [key]: "shadow" } })))?.code, `settings env.${key}`).toBe(
        "settings_key_injection_on_armed_path",
      );
    }
  });

  it("SETTINGS_INJECTION_FIELDS excludes model/availableModels/forceLogin* (common/ambiguous → permanent false-degrade)", () => {
    // Mirrors 18.28's NO_PROXY exclusion: a field that is common in a legit subscription config would permanently
    // false-degrade the armed path (a model pin is not a credential injection). Grounded vs live Claude-Code docs.
    for (const excluded of ["model", "availableModels", "forceLoginMethod", "forceLoginGatewayUrl", "forceLoginOrgUUID"]) {
      expect([...SETTINGS_INJECTION_FIELDS] as string[], `${excluded} must be excluded`).not.toContain(excluded);
    }
  });
});

describe("guardSettingsOnArmedPath — the armed-path gate (byte-equivalent OFF; L23/L44)", () => {
  it("off_path_reads_no_settings: arm disabled ⇒ the injected reader is invoked 0× (byte-equivalent, no fs touch)", () => {
    // L23/L44 — the safety gate runs ONLY on the armed path; the shipped default never touches the settings files.
    const spy = vi.fn(() => [parsed({ apiKeyHelper: "x" })]);
    expect(guardSettingsOnArmedPath(false, spy)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("armed_truthy_not_true_reads_no_settings: STRICT ===true; a truthy-not-true armed value ⇒ no read (L28)", () => {
    const spy = vi.fn(() => [parsed({ apiKeyHelper: "x" })]);
    expect(guardSettingsOnArmedPath("true" as unknown as boolean, spy)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("armed_path_reads_and_faults_on_injection: armed ⇒ reads once; an injection ⇒ fault surfaced", () => {
    const spy = vi.fn(() => [parsed({ apiKeyHelper: "/bin/mint" })]);
    const fault = guardSettingsOnArmedPath(true, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
  });

  it("armed_path_clean_passes: armed + clean settings ⇒ reads once, no fault", () => {
    const spy = vi.fn(() => [parsed({ model: "claude-sonnet-5" })]);
    expect(guardSettingsOnArmedPath(true, spy)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
