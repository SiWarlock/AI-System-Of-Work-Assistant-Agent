# `.scaffolding/` — generator-owned provenance (do not hand-edit)

This directory is **owned by the scaffolding generator and `/scaffold-upgrade`**. Do not hand-edit it.

- **`manifest.json`** records the scaffolding commit this project was generated from, the placeholder
  values that were substituted, and a ledger of every generated file + `EXAMPLE BLOCK` region. It is the
  recoverable common ancestor that lets `/scaffold-upgrade` perform clean **3-way merges** instead of
  hand-diffs.
- It is **machine-written and committed**. `/scaffold-upgrade` rewrites it on every upgrade (advancing
  `lastUpgradedFromSha`). Hand-editing it corrupts the merge base.

See **`SCAFFOLDING-GUIDE.md` §11** for the upgrade + retro-stamping workflow.
