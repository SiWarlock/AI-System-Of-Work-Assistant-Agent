import { MANAGED_DOC_SLOTS, type UiSafeManagedDoc } from "@sow/contracts/api/ui-safe";

// Window-free (no JSX/DOM) so the DOM-less node test tsconfig compiles it (apps/desktop
// LESSONS §3): the §4.5 doc-pack overlay logic, extracted out of Projects.tsx.

/** A managed-doc slot resolved for display: the canonical slot+title overlaid with the
 *  read-model's link/sync state (or the honest default when the read-model omits it). */
export interface ManagedDocView {
  readonly slot: UiSafeManagedDoc["slot"];
  readonly title: string;
  readonly linkState: UiSafeManagedDoc["linkState"];
  readonly syncState: UiSafeManagedDoc["syncState"];
}

/**
 * Overlay a project's read-model docPack onto the 5 canonical slots (§4.5), in canonical
 * DISPLAY order — so the page always shows the full pack even when the read-model carries a
 * partial or empty pack (a project pre-linking, a projector that only writes linked slots).
 * Each slot takes the matching read-model entry's link/sync state + title when present, else
 * the honest default (unlinked / unknown / the canonical label). Display order is the
 * canonical slot order, NEVER the read-model's array order.
 */
export function resolveDocPack(docPack: readonly UiSafeManagedDoc[]): readonly ManagedDocView[] {
  const bySlot = new Map(docPack.map((d) => [d.slot, d]));
  return MANAGED_DOC_SLOTS.map((canon) => {
    const found = bySlot.get(canon.slot);
    return {
      slot: canon.slot,
      title: found?.title ?? canon.title,
      linkState: found?.linkState ?? "unlinked",
      syncState: found?.syncState ?? "unknown",
    };
  });
}
