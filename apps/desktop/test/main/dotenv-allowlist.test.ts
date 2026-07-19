import { describe, it, expect } from "vitest";
import { loadAllowlistedDotenv, RECOGNIZED_SOW_ENV_KEYS } from "../../main/dotenv-allowlist";

// 18.34 — native allowlisted .env loading (Electron main). Pure + electron-free (apps/desktop LESSONS §3):
// parses .env CONTENTS and returns only the recognized SOW_* vars to hydrate + a classified skip list.
// SAFETY: the gate is the ALLOWLIST — a shadowing/secret key is not SOW_* ⇒ structurally never hydrated,
// regardless of the parser. Warnings name the KEY only (rule 7). Existing process.env WINS.
describe("loadAllowlistedDotenv — allowlisted .env → hydrate plan", () => {
  it("loads ONLY allowlisted SOW_* keys (no blanket load)", () => {
    const r = loadAllowlistedDotenv("SOW_VAULT_ROOT=/x\nRANDOM_KEY=y", {});
    expect(r.hydrate).toStrictEqual({ SOW_VAULT_ROOT: "/x" });
    expect(r.skipped).toContainEqual({ key: "RANDOM_KEY", reason: "not_recognized" });
    expect("RANDOM_KEY" in r.hydrate).toBe(false);
  });

  it("⛔ NEVER hydrates a subscription-shadowing / egress-redirect key (the load-bearing safety pin)", () => {
    const r = loadAllowlistedDotenv(
      "ANTHROPIC_API_KEY=sk-x\nHTTP_PROXY=http://p\nall_proxy=socks://p\nANTHROPIC_BASE_URL=http://evil",
      {},
    );
    // none of them reach hydrate (not on the SOW_* allowlist).
    expect(r.hydrate).toStrictEqual({});
    // each surfaces the escalated "shadowing" reason.
    for (const key of ["ANTHROPIC_API_KEY", "HTTP_PROXY", "all_proxy", "ANTHROPIC_BASE_URL"]) {
      expect(r.skipped).toContainEqual({ key, reason: "shadowing" });
    }
  });

  it("does NOT hydrate secrets (VOYAGE/OPENROUTER stay Keychain-only)", () => {
    const r = loadAllowlistedDotenv("VOYAGE_API_KEY=vk\nOPENROUTER_API_KEY=or", {});
    expect(r.hydrate).toStrictEqual({});
    expect(r.skipped).toContainEqual({ key: "VOYAGE_API_KEY", reason: "not_recognized" });
    expect(r.skipped).toContainEqual({ key: "OPENROUTER_API_KEY", reason: "not_recognized" });
  });

  it("is a no-op when the .env is absent/unreadable (contents undefined)", () => {
    expect(loadAllowlistedDotenv(undefined, {})).toStrictEqual({ hydrate: {}, skipped: [] });
  });

  it("does NOT override an already-set process.env value (a real shell/CI export wins)", () => {
    const r = loadAllowlistedDotenv("SOW_VAULT_ROOT=/from-dotenv", { SOW_VAULT_ROOT: "/already-set" });
    expect("SOW_VAULT_ROOT" in r.hydrate).toBe(false);
    expect(r.skipped).toContainEqual({ key: "SOW_VAULT_ROOT", reason: "already_set" });
  });

  it("never carries a VALUE in a skip record (rule 7 — warn names the key only)", () => {
    const r = loadAllowlistedDotenv("ANTHROPIC_API_KEY=super-secret-value\nVOYAGE_API_KEY=vk-secret", {});
    expect(JSON.stringify(r.skipped)).not.toContain("super-secret-value");
    expect(JSON.stringify(r.skipped)).not.toContain("vk-secret");
    expect(r.skipped).toContainEqual({ key: "ANTHROPIC_API_KEY", reason: "shadowing" });
    expect(r.skipped).toContainEqual({ key: "VOYAGE_API_KEY", reason: "not_recognized" });
  });

  it("parses quotes / comments / first-`=` / `export` prefix / blank lines", () => {
    const contents = [
      "# a comment",
      "",
      'SOW_VAULT_ROOT="/path with spaces"', // surrounding double-quotes stripped
      "SOW_INGEST_WORKSPACE='personal-business'", // single-quotes stripped
      "SOW_SUBSCRIPTION_MODEL=a=b", // value split on the FIRST '=' only
      "export SOW_INGEST_WATCH=1", // leading `export ` stripped
      "   SOW_TEMPORAL_ADDRESS = 127.0.0.1:7233   ", // key/value trimmed
    ].join("\n");
    const r = loadAllowlistedDotenv(contents, {});
    expect(r.hydrate).toStrictEqual({
      SOW_VAULT_ROOT: "/path with spaces",
      SOW_INGEST_WORKSPACE: "personal-business",
      SOW_SUBSCRIPTION_MODEL: "a=b",
      SOW_INGEST_WATCH: "1",
      SOW_TEMPORAL_ADDRESS: "127.0.0.1:7233",
    });
  });

  it("treats an empty value as UNSET (KEY= / KEY=\"\" not hydrated — no clobbering a consumer's default)", () => {
    expect("SOW_VAULT_ROOT" in loadAllowlistedDotenv("SOW_VAULT_ROOT=", {}).hydrate).toBe(false);
    expect("SOW_VAULT_ROOT" in loadAllowlistedDotenv('SOW_VAULT_ROOT=""', {}).hydrate).toBe(false);
    expect("SOW_WORKER_NODE" in loadAllowlistedDotenv("SOW_WORKER_NODE=   ", {}).hydrate).toBe(false);
  });

  it("skips a line with no `=` and a whitespace-only key (neither hydrated nor recorded)", () => {
    const r = loadAllowlistedDotenv("NOEQUALSLINE\n   =orphan-value\nSOW_VAULT_ROOT=/x", {});
    expect(r.hydrate).toStrictEqual({ SOW_VAULT_ROOT: "/x" });
    expect(r.skipped).toStrictEqual([]); // dropped by the parser, never reach the gate
  });

  it("last value wins on a duplicate key", () => {
    expect(loadAllowlistedDotenv("SOW_VAULT_ROOT=/a\nSOW_VAULT_ROOT=/b", {}).hydrate).toStrictEqual({
      SOW_VAULT_ROOT: "/b",
    });
  });

  it("handles CRLF line endings (no trailing \\r in values)", () => {
    expect(
      loadAllowlistedDotenv("SOW_VAULT_ROOT=/x\r\nSOW_WORKER_NODE=/usr/bin/node", {}).hydrate,
    ).toStrictEqual({ SOW_VAULT_ROOT: "/x", SOW_WORKER_NODE: "/usr/bin/node" });
  });

  it("a `__proto__` line is an inert own key (surfaced as not_recognized), never a prototype mutation", () => {
    const r = loadAllowlistedDotenv("__proto__=polluted\nconstructor=x", {});
    expect(r.hydrate).toStrictEqual({});
    expect(r.skipped).toContainEqual({ key: "__proto__", reason: "not_recognized" });
    expect(r.skipped).toContainEqual({ key: "constructor", reason: "not_recognized" });
    // no global prototype pollution.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("exposes the recognized SOW_* allowlist (single source, in sync with main/worker-host reads)", () => {
    // The 9 keys the main + worker-host process.env reads recognize.
    expect(RECOGNIZED_SOW_ENV_KEYS).toStrictEqual([
      "SOW_MANAGE_TEMPORAL",
      "SOW_TEMPORAL_ADDRESS",
      "SOW_VAULT_ROOT",
      "SOW_INGEST_WATCH",
      "SOW_INGEST_WORKSPACE",
      "SOW_WORKER_NODE",
      "SOW_SUBSCRIPTION_ARM",
      "SOW_SUBSCRIPTION_MODEL",
      "SOW_EGRESS_ALLOWED_PROCESSORS",
    ]);
    // No shadowing/secret key is on the allowlist (structural exclusion).
    for (const k of ["ANTHROPIC_API_KEY", "HTTP_PROXY", "VOYAGE_API_KEY", "OPENROUTER_API_KEY"]) {
      expect(RECOGNIZED_SOW_ENV_KEYS).not.toContain(k);
    }
  });
});
