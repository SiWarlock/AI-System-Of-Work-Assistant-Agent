// @sow/evals — config/osb.pin reader/validator (Phase-13 §13.1 gate a).
//
// Mirrors the config/gbrain.pin pin pattern (typed pin; parseable `key = value`; `#`
// comments; blanks ignored). The OSB pin records the upstream obsidian-second-brain release
// the anti-corruption inheritance tracks + a content-SHA of any vendored subtree, so a
// version bump is a DELIBERATE act, never silent (the Hermes-pin re-validation precedent).
// Under direction C nothing is vendored under `vendor/osb/` yet, so `subtree_sha` is the
// honest `PENDING_NO_SUBTREE` sentinel; a future real vendoring MUST record a 40-hex
// content-SHA to pass `validateOsbPin` (the pin cannot silently drift).
//
// PURE + TOTAL (§16): no clock/network/fs — the caller supplies the text; every failure is a
// typed `Result`, never a throw.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** The sentinel `subtree_sha` value when no OSB subtree is vendored yet (direction C). */
export const OSB_SUBTREE_SENTINEL = "PENDING_NO_SUBTREE" as const;

/** The typed OSB version-pin (mirror of GbrainPin's shape for the osb_* fields). */
export interface OsbPin {
  readonly osbTag: string;
  readonly osbRepo: string;
  readonly subtreeSha: string;
  readonly status: string;
  readonly validationRef: string;
}

/** Closed pin-error set (§16 — enumerable). */
export interface OsbPinError {
  readonly code: "malformed_line" | "missing_key" | "invalid_value";
  readonly message: string;
}

/** The required `key = value` fields the pin must declare (no silent defaulting of a missing field). */
const REQUIRED_KEYS = ["osb_tag", "osb_repo", "subtree_sha", "status", "validation_ref"] as const;

/** A 40-hex git/content SHA. */
const SHA_40 = /^[0-9a-f]{40}$/;

/**
 * Parse the pin text into a typed `OsbPin`. Skips `#` comments + blank lines; a non-comment
 * line without a `=` is a `malformed_line` err; a missing required key is a `missing_key` err.
 * On a clean structural parse it runs `validateOsbPin` (value semantics), so `parseOsbPin`
 * returns a FULLY-valid pin or a typed err. Pure; never throws.
 */
export function parseOsbPin(text: string): Result<OsbPin, OsbPinError> {
  const values = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      return err({ code: "malformed_line", message: `osb.pin line ${i + 1}: expected 'key = value', got '${line}'` });
    }
    const key = line.slice(0, eq).trim();
    if (key === "") {
      return err({ code: "malformed_line", message: `osb.pin line ${i + 1}: empty key` });
    }
    values.set(key, line.slice(eq + 1).trim());
  }

  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      return err({ code: "missing_key", message: `osb.pin missing required key '${key}'` });
    }
  }

  // Non-null asserted: every REQUIRED_KEY is present (checked above).
  const pin: OsbPin = {
    osbTag: values.get("osb_tag")!,
    osbRepo: values.get("osb_repo")!,
    subtreeSha: values.get("subtree_sha")!,
    status: values.get("status")!,
    validationRef: values.get("validation_ref")!,
  };

  return validateOsbPin(pin);
}

/**
 * Validate the value semantics of an assembled pin: `osb_tag`/`osb_repo` non-empty, and
 * `subtree_sha` is EITHER the `PENDING_NO_SUBTREE` sentinel OR a 40-hex content-SHA — so a
 * future vendoring bump must record a REAL SHA (the pin can never silently drift). Pure;
 * never throws.
 */
export function validateOsbPin(pin: OsbPin): Result<OsbPin, OsbPinError> {
  // Every human-meaningful required field must carry a value — a blank one (e.g. `validation_ref =`)
  // silently defeats its purpose, so presence alone is not enough.
  for (const [key, value] of [
    ["osb_tag", pin.osbTag],
    ["osb_repo", pin.osbRepo],
    ["status", pin.status],
    ["validation_ref", pin.validationRef],
  ] as const) {
    if (value.trim() === "") {
      return err({ code: "invalid_value", message: `osb.pin: ${key} must be non-empty` });
    }
  }
  if (pin.subtreeSha !== OSB_SUBTREE_SENTINEL && !SHA_40.test(pin.subtreeSha)) {
    return err({
      code: "invalid_value",
      message: `osb.pin: subtree_sha must be '${OSB_SUBTREE_SENTINEL}' or a 40-hex content-SHA (a vendoring bump must record a real SHA); got '${pin.subtreeSha}'`,
    });
  }
  return ok(pin);
}
