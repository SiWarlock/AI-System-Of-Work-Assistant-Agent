// Boot-time GBrain version-pin verify (§13/§16; task 11.3-b) — the PRODUCTION consumer of the
// 11.3-a probe/composition, closing its reachability waiver.
//
// Loads the typed `GbrainPin` (from `config/gbrain.pin` via the 4.20 `parseGbrainPinFile`),
// probes the running gbrain, delegates to the built pure `verifyGbrainStartup`, and on the
// degrade branch SURFACES the distinct version-pin `HealthItem` (the §16 observability the 11.3
// acceptance requires). DEGRADED-SAFE: a probe throw / pin-load failure / surface fault is
// caught + logged and boot CONTINUES — this step NEVER throws and NEVER blocks boot (mirrors the
// vault-watcher / reconciler best-effort boot wiring). LOCAL-ONLY.
//
// The serving branch is a NO-OP here: a matched, LIVE-validated pin surfaces no item and does
// NOT flip write-through or re-plumb the serving oracle — those stay HITL (out of scope). The
// deps deliberately carry NO write-through seam, so a flip is structurally impossible.
import { parseGbrainPinFile, verifyGbrainStartup, type GbrainVersionProbe } from "@sow/knowledge";
import type { GbrainPin, HealthItem, AuditId } from "@sow/contracts";

/** Minimal structured logger shape (a subset of the worker `Logger`; optional). */
interface StepLogger {
  readonly warn: (event: string, meta?: { readonly fields?: Record<string, unknown> }) => void;
  readonly info?: (event: string, meta?: { readonly fields?: Record<string, unknown> }) => void;
}

export interface GbrainStartupVerifyDeps {
  /** Reads the raw `config/gbrain.pin` text. Injected (fs in prod, a fake in tests). */
  readonly readPinText: () => Promise<string>;
  /** The running-gbrain probe (the real `createGbrainVersionProbe()` in prod; a fake in tests). */
  readonly probe: GbrainVersionProbe;
  /** Persist a surfaced HealthItem (prod: `backends.healthItems.put`; test: a spy). May reject. */
  readonly surfaceHealth: (item: HealthItem) => Promise<void>;
  /** ISO-8601 clock for the surfaced items. */
  readonly now: () => string;
  /** Audit ref threaded into the surfaced degradation items. */
  readonly auditRef: string;
  /** Optional structured logger. */
  readonly logger?: StepLogger;
}

/** A distinct health item for an absent/unparseable pin — the version-pin subsystem cannot verify. */
function pinLoadFailedHealthItem(now: string, auditRef: string): HealthItem {
  return {
    id: "gbrain-version-pin:pin_load_failed",
    failureClass: "write_through_failed",
    severity: "error",
    message:
      "config/gbrain.pin is absent or unparseable; the gbrain version pin cannot be verified, brain stays read-only/index-only",
    auditRef: auditRef as AuditId,
    openedAt: now,
    state: "open",
  };
}

/** Surface a HealthItem, swallowing a store fault — a health-sink error must NEVER crash boot (§16). */
async function surfaceSafely(deps: GbrainStartupVerifyDeps, item: HealthItem): Promise<void> {
  try {
    await deps.surfaceHealth(item);
  } catch {
    deps.logger?.warn("gbrain.version_pin.surface_failed", { fields: { code: "surface_failed" } });
  }
}

/**
 * Run the boot-time GBrain version-pin verify. Best-effort + DEGRADED-SAFE: NEVER throws, NEVER
 * blocks boot. On any degrade (gbrain-unavailable / sha-mismatch / index-schema-mismatch /
 * PENDING-sentinel / pin-load failure) it surfaces the distinct version-pin `HealthItem` and
 * returns; on serving it is a no-op (write-through stays HITL).
 */
export async function gbrainStartupVerify(deps: GbrainStartupVerifyDeps): Promise<void> {
  try {
    // 1 — load the pin (fs read + pure parse). A read/parse failure is degrade-worthy: surface + continue.
    let pin: GbrainPin | undefined;
    try {
      const text = await deps.readPinText();
      const parsed = parseGbrainPinFile(text);
      if (parsed.ok) {
        pin = parsed.value;
      } else {
        deps.logger?.warn("gbrain.version_pin.pin_parse_failed", { fields: { code: parsed.error.code } });
      }
    } catch {
      deps.logger?.warn("gbrain.version_pin.pin_read_failed", { fields: { code: "pin_read_failed" } });
    }
    if (pin === undefined) {
      await surfaceSafely(deps, pinLoadFailedHealthItem(deps.now(), deps.auditRef));
      return;
    }

    // 2 — verify the running gbrain against the pin (never throws; a thrown probe folds to a degrade).
    const result = await verifyGbrainStartup({
      pin,
      probe: deps.probe,
      ctx: { now: deps.now, auditRef: deps.auditRef },
    });

    // 3 — degrade ⇒ surface the distinct version-pin HealthItem; serving ⇒ NO-OP (write-through stays HITL).
    if (!result.ok) {
      deps.logger?.warn("gbrain.version_pin.degraded", { fields: { reason: result.error.reason } });
      await surfaceSafely(deps, result.error.healthItem);
    } else {
      deps.logger?.info?.("gbrain.version_pin.serving");
    }
  } catch {
    // A fault ANYWHERE in the verify path must never crash boot (§16, best-effort).
    deps.logger?.warn("gbrain.version_pin.verify_faulted", { fields: { code: "verify_faulted" } });
  }
}
