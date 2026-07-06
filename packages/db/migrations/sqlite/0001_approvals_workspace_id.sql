-- §9.8 approvals inbox workspace-scoping: add the WS-4 attribution column.
-- Additive + backward-safe: NOT NULL requires a DEFAULT to ALTER a populated table; the sentinel
-- backfills legacy rows to a non-workspace value the equality inbox filter never matches (fail-closed —
-- legacy rows surface in NO inbox, never leak into one). Every write site supplies a real workspace id.
-- NOTE: the pre-existing 0000 meta snapshot is stale (it predates write_receipts/health_items/
-- schedule_bookkeeping/instance_leases, which 0000_genesis.sql DOES create) — drizzle-kit therefore
-- bundled those CREATE TABLEs into the generated 0001; they are stripped here so this migration applies
-- cleanly atop genesis (which already created them). The regenerated 0001 snapshot captures the full
-- schema as the correct baseline for future migrations. Fixing the stale 0000 snapshot is out of scope.
ALTER TABLE `approvals` ADD `workspaceId` text DEFAULT '__unassigned__' NOT NULL;
