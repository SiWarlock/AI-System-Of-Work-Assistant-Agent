-- §13.10a approvals semantic subject: add the SUBJECT discriminator + the pending-KMP ref, and
-- make `actionRef` nullable (a semantic_mutation card carries `planRef`, not `actionRef`).
--
-- SQLite cannot ALTER a column's NOT NULL constraint, so drizzle-kit emits the standard 12-step
-- table-recreate. The generated INSERT…SELECT is HAND-FIXED here: drizzle-kit's diff listed the two
-- NEW columns (`planRef`, `subjectKind`) in the SELECT off the OLD table, which has neither yet
-- ("no such column"). They are dropped from BOTH the column list and the SELECT so they take their
-- schema DEFAULT on copy: `subjectKind` backfills to 'external_action' (a SEMANTICALLY CORRECT
-- backfill — every legacy approval predates the Copilot bridge and IS an external write) and
-- `planRef` stays NULL. `actionRef` is copied verbatim (every legacy row has it) into the now-NULLABLE
-- column. No data is lost; the recreate is a pure widening.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`actionRef` text,
	`planRef` text,
	`subjectKind` text DEFAULT 'external_action' NOT NULL,
	`workspaceId` text DEFAULT '__unassigned__' NOT NULL,
	`status` text NOT NULL,
	`actor` text NOT NULL,
	`channel` text NOT NULL,
	`payloadHash` text NOT NULL,
	`snoozeUntil` text,
	`expiresAt` text
);
--> statement-breakpoint
INSERT INTO `__new_approvals`("id", "actionRef", "workspaceId", "status", "actor", "channel", "payloadHash", "snoozeUntil", "expiresAt") SELECT "id", "actionRef", "workspaceId", "status", "actor", "channel", "payloadHash", "snoozeUntil", "expiresAt" FROM `approvals`;--> statement-breakpoint
DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `__new_approvals` RENAME TO `approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
