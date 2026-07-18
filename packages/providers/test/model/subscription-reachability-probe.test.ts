// spec(§19.5)/spec(§7) — 18.26: the real, SPEND-FREE reachability check that feeds 18.22's
// probeClaudeSubscriptionHealth({checkReachable}). A pure, total, fail-closed FOLD over two INJECTED
// spend-free primitives — detectLogin (local `claude` login credential PRESENT — existence only, never
// its bytes, rule 7) + resolveSdk (@anthropic-ai/claude-agent-sdk resolvable — NO query()/completion) —
// producing the exact `{loginPresent, sdkReachable}` shape 18.22 reads with strict `=== true`. Any
// fault/throw/truthy-coercion ⇒ that dimension FALSE (never a false-green, L52). The real primitives bind
// at the owner ARM (18.25) via config.subscriptionArm.checkReachable; DORMANT + reachability-waivered (L11).
import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import {
  probeSubscriptionReachability,
  detectClaudeLogin,
  resolveAgentSdk,
  DEFAULT_CLAUDE_LOGIN_PATH,
  type SubscriptionReachabilityProbeDeps,
} from "../../src/model/subscription-reachability-probe";

const bothTrue: SubscriptionReachabilityProbeDeps = {
  detectLogin: () => true,
  resolveSdk: () => true,
};

describe("probeSubscriptionReachability — spend-free fail-closed reachability probe (18.26)", () => {
  it("reachable_when_login_present_and_sdk_usable", () => {
    // spec(§7) — both injected spend-free primitives true ⇒ the reachable signal.
    const r = probeSubscriptionReachability(bothTrue);
    expect(r).toEqual({ loginPresent: true, sdkReachable: true });
  });

  it("not_reachable_when_login_absent", () => {
    // spec(§7)/L52 — login absent ⇒ loginPresent:false (no false-green), sdkReachable unaffected.
    const r = probeSubscriptionReachability({ detectLogin: () => false, resolveSdk: () => true });
    expect(r).toEqual({ loginPresent: false, sdkReachable: true });
  });

  it("not_reachable_when_sdk_unresolvable", () => {
    // spec(§7)/L52 — SDK unresolvable ⇒ sdkReachable:false.
    const r = probeSubscriptionReachability({ detectLogin: () => true, resolveSdk: () => false });
    expect(r).toEqual({ loginPresent: true, sdkReachable: false });
  });

  it("throw_folds_to_not_reachable", () => {
    // spec(§16)/L52 — a throwing primitive folds to FALSE for that dimension; no throw escapes; the
    // thrown Error (which may carry a path/credential detail, rule 7) never reaches the boolean result.
    const r = probeSubscriptionReachability({
      detectLogin: () => {
        throw new Error("/Users/dreddy/.claude/.credentials.json boom");
      },
      resolveSdk: () => true,
    });
    expect(r).toEqual({ loginPresent: false, sdkReachable: true });
  });

  it("truthy_non_boolean_folds_false", () => {
    // spec(§7)/L52 — the fold is STRICT `=== true`, NOT truthiness: a truthy-non-boolean (`"yes"`) must
    // NOT green (a regression to a truthy check reopens the false-green surface).
    const r = probeSubscriptionReachability({
      detectLogin: (() => "yes") as unknown as () => boolean,
      resolveSdk: (() => 1) as unknown as () => boolean,
    });
    expect(r).toEqual({ loginPresent: false, sdkReachable: false });
  });

  it("spend_free_delegates_only_to_injected_primitives", () => {
    // spec(§19.5) — the probe delegates ALL reachability work to the injected spend-free primitives (each
    // called once) and returns synchronously with a boolean-only shape. (Structural spend-free — the module
    // imports NO SDK — is verified separately by review/typecheck; here we pin the delegation + rule-7 shape.)
    const detectLogin = vi.fn(() => true);
    const resolveSdk = vi.fn(() => true);
    const r = probeSubscriptionReachability({ detectLogin, resolveSdk });
    expect(detectLogin).toHaveBeenCalledTimes(1);
    expect(resolveSdk).toHaveBeenCalledTimes(1);
    // rule 7: EXACTLY the two boolean keys — no token/credential bytes could ride the result.
    expect(Object.keys(r).sort()).toEqual(["loginPresent", "sdkReachable"]);
    expect(typeof r.loginPresent).toBe("boolean");
    expect(typeof r.sdkReachable).toBe("boolean");
  });

  it("defaults_resolveSdk_to_the_concrete_primitive_when_omitted", () => {
    // spec(§19.5) — deps default to the concrete spend-free primitives, so the arm can inject it
    // ready-to-use. Omitting resolveSdk uses the real `resolveAgentSdk` (the SDK is a package dep ⇒ true);
    // detectLogin injected to keep the login dimension deterministic here.
    const r = probeSubscriptionReachability({ detectLogin: () => true });
    expect(r).toEqual({ loginPresent: true, sdkReachable: true });
  });
});

describe("resolveAgentSdk — spend-free SDK module resolvability (18.26)", () => {
  it("resolves_true_when_resolver_returns_a_path", () => {
    // spec(§7) — module RESOLUTION only (returns a path); it does NOT import/execute the SDK (no query()).
    expect(resolveAgentSdk((id) => `/node_modules/${id}/index.js`)).toBe(true);
  });

  it("false_when_resolver_throws", () => {
    // spec(§16)/L52 — an unresolvable module (resolver throws MODULE_NOT_FOUND) ⇒ false, never a false-green.
    expect(
      resolveAgentSdk(() => {
        throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
      }),
    ).toBe(false);
  });

  it("false_when_resolver_returns_empty_or_nonstring", () => {
    // spec(§7)/L52 — strict parity with detectClaudeLogin: "did not throw" is NOT enough. A resolver that
    // returns ""/undefined (a falsy resolution) folds to false, never a fail-open sdkReachable:true.
    expect(resolveAgentSdk(() => "")).toBe(false);
    expect(resolveAgentSdk(() => undefined as unknown as string)).toBe(false);
  });

  it("real_default_resolves_the_installed_sdk", () => {
    // spec(§19.5) — the real leg: `@anthropic-ai/claude-agent-sdk` is a package dependency, so the default
    // createRequire resolver finds it. Proves the concrete primitive works — spend-free (resolve ≠ import).
    expect(resolveAgentSdk()).toBe(true);
  });
});

describe("detectClaudeLogin — spend-free, rule-7 login-credential presence (18.26)", () => {
  it("true_when_the_path_exists", () => {
    // spec(§7) — login credential present (fs existence) ⇒ true.
    expect(detectClaudeLogin("/x/.credentials.json", () => true)).toBe(true);
  });

  it("false_when_the_path_is_absent", () => {
    // spec(§7)/L52 — absent ⇒ false (fail-closed).
    expect(detectClaudeLogin("/x/.credentials.json", () => false)).toBe(false);
  });

  it("false_when_the_exists_check_throws", () => {
    // spec(§16) — a throwing fs check folds to false; no throw escapes.
    expect(
      detectClaudeLogin("/x/.credentials.json", () => {
        throw new Error("EACCES /x boom");
      }),
    ).toBe(false);
  });

  it("checks_existence_only_never_reads_contents", () => {
    // spec rule 7 — the injected existence check is the ONLY fs op invoked (with the path); the function
    // NEVER reads the file contents, so no token/credential bytes are ever loaded. Returns a boolean only.
    const exists = vi.fn((_p: string) => true);
    const out = detectClaudeLogin("/x/.credentials.json", exists);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith("/x/.credentials.json");
    expect(typeof out).toBe("boolean");
  });

  it("default_login_path_is_a_documented_candidate_under_home", () => {
    // spec(§19.5)/L55 — the default path is a DATED candidate placeholder (verify at the arm; fail-closed
    // if wrong). It lives under the user home `.claude` dir; the arm overrides it with the live location.
    expect(DEFAULT_CLAUDE_LOGIN_PATH.startsWith(homedir())).toBe(true);
    expect(DEFAULT_CLAUDE_LOGIN_PATH).toContain(".claude");
  });
});
