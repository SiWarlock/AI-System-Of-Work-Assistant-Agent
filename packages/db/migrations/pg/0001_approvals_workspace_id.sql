-- §9.8 approvals inbox workspace-scoping: add the WS-4 attribution column.
-- Additive + backward-safe: NOT NULL requires a DEFAULT to ALTER a populated table; the sentinel
-- backfills legacy rows to a non-workspace value the equality inbox filter never matches (fail-closed —
-- legacy rows surface in NO inbox, never leak into one). Every write site supplies a real workspace id.
-- NOTE: the stale 0000 meta snapshot caused drizzle-kit to bundle unrelated CREATE TABLEs into the
-- generated 0001 (0000_genesis.sql already creates them); stripped here so this applies cleanly atop
-- genesis. The regenerated 0001 snapshot is the correct full-schema baseline going forward.
ALTER TABLE "approvals" ADD COLUMN "workspaceId" text DEFAULT '__unassigned__' NOT NULL;
