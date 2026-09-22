import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import { WorkspaceType } from "@sow/contracts/primitives/enums";
import type { Store, UiSafeStoreState } from "../store";
import { WORKSPACE_TYPE_TO_SCOPE, type OnboardedWorkspace } from "../store/onboarding";
import { recordOnboardedWorkspace } from "../store/projections";

// Rebuild the renderer's onboarded-workspace set from the worker on every launch (§19.1 / WS-8).
//
// ⛔ WHY THIS EXISTS — owner report 2026-09-21: with Employer-Work selected, Connectors still said
// "Select an onboarded workspace". The store's `onboarded` slice had exactly ONE writer, the onboarding
// wizard's completion callback in `App.tsx`, and nothing rebuilt it at launch. The durable first-run
// marker (9.17) correctly hid the wizard, so after the first restart every scope resolved to "not
// onboarded" and every scoped surface — Connectors, Copilot, egress, projects — failed closed on an
// install with two real workspaces.
//
// ⭐ The worker answers from `workspace_config`, the same table its egress-posture resolver reads, so a
// scope this makes selectable is exactly a scope the posture checks accept (see
// `onboarding.listWorkspaces`). The renderer adds nothing: it only re-validates what arrives.

const KNOWN_TYPES: ReadonlySet<string> = new Set(WorkspaceType);

/**
 * Re-validate `onboarding.listWorkspaces`'s wire result into store records. Candidate data off the wire
 * (desktop L6): each item is checked field by field and ONLY the named fields are copied, so an extra
 * key (a future server-projector regression carrying `markdownRepoPath`, say) never reaches the store.
 * A malformed item is DROPPED; the rest of the list survives.
 *
 * ⛔ Returns `null` — "cannot say" — for a typed err, a non-array value, or anything unrecognizable.
 * Never `[]`: an empty list is a CLAIM that nothing is onboarded, and a fault is not evidence of that.
 */
export function parseOnboardedList(raw: unknown): readonly OnboardedWorkspace[] | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as { ok?: unknown; value?: unknown };
  if (r.ok !== true || !Array.isArray(r.value)) return null;
  const out: OnboardedWorkspace[] = [];
  for (const item of r.value as readonly unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const i = item as { workspaceId?: unknown; name?: unknown; type?: unknown };
    if (typeof i.workspaceId !== "string" || i.workspaceId.length === 0) continue;
    if (typeof i.name !== "string") continue;
    if (typeof i.type !== "string" || !KNOWN_TYPES.has(i.type)) continue;
    const type = i.type as WorkspaceType;
    out.push({
      workspaceId: i.workspaceId,
      scope: WORKSPACE_TYPE_TO_SCOPE[type],
      name: i.name,
      type,
      // The preset is captured at onboarding but not persisted by the worker, so it cannot be
      // recovered here. It is display metadata only; nothing gates on it.
      preset: "",
    });
  }
  return out;
}

/**
 * Load the onboarded workspaces and record each into the store. TOTAL — never throws: a transport
 * fault or a typed err leaves the store exactly as it was, because this runs on connect and a throw
 * would abort the rest of the cold load.
 *
 * ⚠ MERGES rather than replaces: a workspace onboarded in this session a moment before the list
 * arrives must not be erased by a list read that started earlier.
 */
export async function hydrateOnboarded(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await client.onboarding.listWorkspaces.query();
  } catch {
    return;
  }
  const list = parseOnboardedList(raw);
  if (list === null || list.length === 0) return;
  store.dispatch((s) => list.reduce((acc, ow) => recordOnboardedWorkspace(acc, ow), s));
}
