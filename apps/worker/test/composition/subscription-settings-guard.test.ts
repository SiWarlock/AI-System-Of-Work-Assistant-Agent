// 18.36 — the settings-level key-injection guard: extend the armed-subscription no-surprise-spend defense to
// the ONE shadow the 18.28 process.env guard structurally cannot see — a Claude-Code settings.json key
// injection (apiKeyHelper / settings-`env` / Bedrock cred scripts). The Agent SDK `query()` honors the
// settings hierarchy, so an injected raw key there makes a "subscription" run silently metered-spend.
//
// The guard is PURE — the settings-hierarchy reader is INJECTED as a fake here (NO real fs / os.homedir).
// PRESENCE only (rule 7 — never the value / command string); armed-path-only (byte-equivalent default);
// fail-safe DEGRADE on an unreadable source; over-inclusion is fail-safe (an EXPLICIT EXTENSIBLE set).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertNoSettingsKeyInjection,
  guardSettingsOnArmedPath,
  readManagedFragments,
  readManagedPreferencesPlists,
  relocationDegradeSource,
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
      // 18.39-B: a PRESENT managed tier degrades on its own now, so use an ABSENT managed tier to test that a lower
      // (user) injection is still caught at its own tier.
      reader({ marker: "managed", outcome: { kind: "absent" } }, parsed({ apiKeyHelper: "/bin/mint" }, "user")),
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

// 18.39 — the managed-settings.d fragment dir + settings-path relocation + the managed-tier session-env `hooks`
// vector: the 3 settings-file injection surfaces the flat-tier reader (18.36) missed. Closes GATE-1's (b) leg.
describe("18.39 — managed-settings.d fragments + relocation + managed-tier hooks (settings-file surface completeness)", () => {
  /** A fake fs for readManagedFragments: readdir returns the file names; readFile returns the mapped content. */
  function fakeFragmentFs(
    files: Record<string, string>,
    opts?: { readonly dirAbsent?: boolean; readonly readdirThrows?: boolean },
  ): { existsSync: (p: string) => boolean; readdirSync: (p: string) => string[]; readFileSync: (p: string) => string } {
    return {
      existsSync: () => opts?.dirAbsent !== true,
      readdirSync: () => {
        if (opts?.readdirThrows === true) throw new Error("EACCES");
        return Object.keys(files);
      },
      readFileSync: (p: string) => {
        const name = p.slice(p.lastIndexOf("/") + 1);
        const content = files[name];
        if (content === undefined) throw new Error("ENOENT");
        return content;
      },
    };
  }
  const DIR = "/Library/Application Support/ClaudeCode/managed-settings.d";

  it("managed_fragment_apikeyhelper_degrades: a managed-settings.d fragment injecting apiKeyHelper ⇒ fault (marker managed)", () => {
    // spec(§19.5) — a fragment cred-mint is the invisible shadow the flat-tier reader misses (session-104 residual #40).
    const sources = readManagedFragments(DIR, fakeFragmentFs({ "10-x.json": JSON.stringify({ apiKeyHelper: "/bin/mint" }) }));
    const fault = assertNoSettingsKeyInjection(() => sources);
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
    expect(fault?.marker).toBe("managed");
  });

  it("managed_fragment_env_shadow_degrades: a fragment env.<18.38 shadow key> ⇒ fault (single-source env leg reaches fragments)", () => {
    // spec(L71) — the env-block leg (reusing SUBSCRIPTION_SHADOWING_ENV_KEYS, incl. 18.38 additions) covers fragments too.
    expect(SUBSCRIPTION_SHADOWING_ENV_KEYS as readonly string[]).toContain("CLAUDE_CODE_USE_GATEWAY");
    const sources = readManagedFragments(DIR, fakeFragmentFs({ "x.json": JSON.stringify({ env: { CLAUDE_CODE_USE_GATEWAY: "1" } }) }));
    expect(assertNoSettingsKeyInjection(() => sources)?.code).toBe("settings_key_injection_on_armed_path");
  });

  it("managed_fragment_unreadable_degrades: a malformed / non-object fragment ⇒ unreadable ⇒ degrade (§16/L65)", () => {
    const malformed = readManagedFragments(DIR, fakeFragmentFs({ "bad.json": "{ not json" }));
    expect(assertNoSettingsKeyInjection(() => malformed)?.marker).toBe("managed");
    const nonObject = readManagedFragments(DIR, fakeFragmentFs({ "arr.json": "[1,2,3]" }));
    expect(assertNoSettingsKeyInjection(() => nonObject)?.code).toBe("settings_key_injection_on_armed_path");
  });

  it("managed_fragment_dir_absent_or_empty_no_source; present-fragment degrades (B); non-.json ignored", () => {
    expect(readManagedFragments(DIR, fakeFragmentFs({}, { dirAbsent: true }))).toEqual([]);
    expect(readManagedFragments(DIR, fakeFragmentFs({}))).toEqual([]);
    // non-.json ignored: only ok.json enumerated.
    const frags = readManagedFragments(DIR, fakeFragmentFs({ "ok.json": JSON.stringify({ model: "x" }), "notes.txt": "ignored" }));
    expect(frags).toHaveLength(1);
    // 18.39-B: a PRESENT managed fragment (even a benign {model:x}) ⇒ DEGRADE (managed presence, drift-immune).
    expect(assertNoSettingsKeyInjection(() => frags)?.marker).toBe("managed");
    // absent/empty dir ⇒ [] ⇒ scan clean (no managed source).
    expect(assertNoSettingsKeyInjection(() => [])).toBeUndefined();
  });

  it("managed_fragments_read_deterministically: fragments read in sorted (stable) order", () => {
    const sources = readManagedFragments(
      DIR,
      fakeFragmentFs({
        "30-c.json": JSON.stringify({ model: "c" }),
        "10-a.json": JSON.stringify({ model: "a" }),
        "20-b.json": JSON.stringify({ model: "b" }),
      }),
    );
    const models = sources.map((s) => (s.outcome.kind === "parsed" ? s.outcome.settings["model"] : null));
    expect(models).toEqual(["a", "b", "c"]);
  });

  it("readdir_throw_emits_synthetic_unreadable: a fragment dir that exists but readdir throws (perms) ⇒ ONE synthetic degrade", () => {
    const sources = readManagedFragments(DIR, fakeFragmentFs({}, { readdirThrows: true }));
    expect(sources).toEqual([{ marker: "managed", outcome: { kind: "unreadable" } }]);
    expect(assertNoSettingsKeyInjection(() => sources)?.marker).toBe("managed");
  });

  it("relocation_var_present_degrades: a settings-path relocation var set ⇒ synthetic unreadable managed source (fail-safe)", () => {
    // spec(§19.5) — a relocation var means the default-path managed scan can't be trusted ⇒ degrade (Q5, homed in the guard).
    for (const key of ["CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH"]) {
      expect(relocationDegradeSource({ [key]: "/tmp/relocated" })).toEqual({ marker: "managed", outcome: { kind: "unreadable" } });
    }
    expect(relocationDegradeSource({})).toBeUndefined();
  });

  it("managed_tier_hooks_field_degrades: a MANAGED-tier `hooks` block ⇒ fault (the session-env *.sh vector, survives settingSources:[])", () => {
    // spec(§19.5) — a managed hook runs on session start + can mint creds/set env; presence-only (rule 7, never executed).
    const fault = assertNoSettingsKeyInjection(() => [
      { marker: "managed", outcome: { kind: "parsed", settings: { hooks: { SessionStart: [{ command: "/bin/x.sh" }] } } } },
    ]);
    expect(fault?.code).toBe("settings_key_injection_on_armed_path");
    expect(fault?.marker).toBe("managed");
  });

  it("user_and_project_hooks_are_clean: a user/project `hooks` block ⇒ NO fault (disabled by settingSources:[], managed-only sound)", () => {
    // ⛔ managed-ONLY: the extraction query() passes settingSources:[] (claude-subscription-completion.ts:145) which
    //   DISABLES user/project settings+hooks, so a user/project `hooks` block cannot inject ⇒ NOT watched (else a legit
    //   dev-hooks config permanently false-degrades the armed run — the L65 class). Soundness depends on that :145 coupling.
    expect(assertNoSettingsKeyInjection(reader(parsed({ hooks: { SessionStart: [{ command: "x" }] } }, "user")))).toBeUndefined();
    expect(assertNoSettingsKeyInjection(reader(parsed({ hooks: { PreToolUse: [] } }, "project")))).toBeUndefined();
    expect(assertNoSettingsKeyInjection(reader(parsed({ hooks: {} }, "project-local")))).toBeUndefined();
  });

  // ── 18.39 Step-8 review folds: the plist managed tier (HIGH) + statusLine sibling (MEDIUM) + coupling pin (MEDIUM) ──
  it("plist_present_degrades: an enterprise managed-preferences plist present ⇒ synthetic unreadable managed source (§19.5)", () => {
    // The macOS /Library/Managed Preferences/com.anthropic.claudecode.plist is a 3rd managed source (same schema,
    // survives settingSources:[]); we can't JSON-scan a plist ⇒ presence ⇒ fail-safe degrade.
    const present = readManagedPreferencesPlists(["/Library/Managed Preferences/com.anthropic.claudecode.plist"], { existsSync: () => true });
    expect(present).toEqual([{ marker: "managed", outcome: { kind: "unreadable" } }]);
    expect(assertNoSettingsKeyInjection(() => present)?.marker).toBe("managed");
    // fs throw ⇒ fail-safe assume present (degrade)
    expect(
      readManagedPreferencesPlists(["/x"], {
        existsSync: () => {
          throw new Error("EPERM");
        },
      }),
    ).toHaveLength(1);
  });

  it("plist_absent_is_clean: no managed-preferences plist (non-MDM machine) ⇒ no source (byte-equivalent)", () => {
    expect(
      readManagedPreferencesPlists(["/Library/Managed Preferences/com.anthropic.claudecode.plist"], { existsSync: () => false }),
    ).toEqual([]);
  });

  it("managed_statusline_command_degrades_user_is_clean: statusLine (a managed command vector) ⇒ degrade; user clean", () => {
    // spec(§19.5) — a MANAGED statusLine.command runs a shell command; under B it degrades via managed-presence
    // (subsumed, no field-enumeration needed).
    expect(
      assertNoSettingsKeyInjection(() => [
        { marker: "managed", outcome: { kind: "parsed", settings: { statusLine: { type: "command", command: "/bin/x.sh" } } } },
      ])?.marker,
    ).toBe("managed");
    // A user/project statusLine is disabled by settingSources:[] ⇒ NOT watched (no false-degrade of a legit dev config).
    expect(assertNoSettingsKeyInjection(reader(parsed({ statusLine: { type: "command", command: "x" } }, "user")))).toBeUndefined();
  });

  it("managed_present_nonempty_degrades_empty_is_clean: B — ANY present non-empty managed ⇒ degrade (drift-immune); empty ⇒ clean", () => {
    // ⭐ THE B PROPERTY (L73 analog): an UNKNOWN/FUTURE managed field, or even a benign model pin, ⇒ degrade — no
    //   field to enumerate/miss, so a future SDK managed field can't silently fail-open (subsumes headersHelper etc.).
    expect(
      assertNoSettingsKeyInjection(() => [{ marker: "managed", outcome: { kind: "parsed", settings: { some_future_field: "x" } } }])?.marker,
    ).toBe("managed");
    expect(
      assertNoSettingsKeyInjection(() => [{ marker: "managed", outcome: { kind: "parsed", settings: { model: "claude-x" } } }])?.marker,
    ).toBe("managed");
    // An EMPTY managed `{}` mints nothing ⇒ clean (no false-degrade on a vestigial empty managed file).
    expect(assertNoSettingsKeyInjection(() => [{ marker: "managed", outcome: { kind: "parsed", settings: {} } }])).toBeUndefined();
  });

  it("managed_only_soundness_pinned_to_settingSources_empty: the extraction query() STILL passes settingSources:[] (RED-on-weaken)", () => {
    // ⛔ CROSS-FILE COUPLING PIN (18.39 Step-8): managed-only hooks/statusLine is sound ONLY because the extraction
    //   query() disables user/project settings via `settingSources: []`. If that literal is ever removed/changed, this
    //   fails RED — forcing a re-evaluation (widen to all tiers). Upgrades the comment coupling to a mechanical pin.
    const providerSrc = readFileSync(
      new URL("../../../../packages/providers/src/model/claude-subscription-completion.ts", import.meta.url),
      "utf8",
    );
    // POSITIVE: an empty settingSources:[] is present. NEGATIVE (the load-bearing half, decoy-proof): NO non-empty
    // settingSources array anywhere — `settingSources: ["user"]` at the real :145 would trip this even if the :112
    // docstring's `[]` stays intact. Together they RED on any weakening of the isolation-mode option.
    expect(providerSrc).toMatch(/settingSources:\s*\[\s*\]/);
    expect(providerSrc).not.toMatch(/settingSources:\s*\[\s*[^\]\s]/); // tightened: also trips on `[ "user" ]` (inner space)
    // Programmatic managed-injection (the file-scan guard structurally can't see it) stays closed-by-construction:
    // the query() adapter passes NEITHER a `managedSettings` NOR a bare `settings` option (both are SDK injection
    // vectors: sdk.d.ts settings?: string | Settings). Pin both (defense-in-depth, RED-on-weaken).
    expect(providerSrc).not.toMatch(/\bmanagedSettings\s*:/);
    expect(providerSrc).not.toMatch(/\bsettings\s*:/);
  });
});
